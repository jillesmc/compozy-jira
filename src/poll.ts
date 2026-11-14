import type {
  HeartbeatSourceRequest,
  HeartbeatSourceResult,
  JSONValue,
} from "@compozy/extension-sdk";

import { capacityError, ListingLimitError, sourceError } from "./errors.js";
import { toItem } from "./items.js";
import type { JiraClient } from "./jira-client.js";
import type { JiraSourceParams } from "./params.js";
import { compareKeys, decodeState, encodeState, seenFromKeys, stateKeys } from "./seen-state.js";

export const POLL_BUDGET_MS = 25_000;
export const MAX_DETAIL_CANDIDATES = 200;

export async function pollJiraIssues(
  request: HeartbeatSourceRequest,
  deps: { client: JiraClient; params: JiraSourceParams; budgetMs?: number }
): Promise<HeartbeatSourceResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = sourceError("source_extension_failed", "Jira listing took too long; narrow the JQL");
      controller.abort(error);
      reject(error);
    }, deps.budgetMs ?? POLL_BUDGET_MS);
  });
  try {
    return await Promise.race([run(request, deps.client, deps.params, controller.signal), budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(
  request: HeartbeatSourceRequest,
  client: JiraClient,
  params: JiraSourceParams,
  signal: AbortSignal
): Promise<HeartbeatSourceResult> {
  const { max_items: maxItems, max_state_bytes: maxStateBytes } = request.limits;
  const maxKeys = Math.floor((maxStateBytes - 64) / 4);
  const list = async (jql: string): Promise<string[]> => {
    try {
      return [...new Set(await client.listKeys(jql, maxKeys, signal))];
    } catch (error) {
      if (error instanceof ListingLimitError) throw capacityError(`more than ${error.limit}`, maxStateBytes);
      throw error;
    }
  };

  const committed = decodeState(request.state);
  const baseline = committed === null || committed.fp !== params.fingerprint;
  const current = await list(params.jql);
  // The whole match set must be trackable, not just this page's next state (D-3).
  encodeState({ v: 1, fp: params.fingerprint, seen: seenFromKeys(current) }, maxStateBytes, current.length);
  let seen0: Set<string>;
  if (baseline) {
    const window = new Set(
      params.backfillMinutes > 0
        ? await list(`(${params.jql}) AND created >= -${params.backfillMinutes}m`)
        : []
    );
    seen0 = new Set(current.filter(issueKey => !window.has(issueKey)));
  } else {
    const previous = stateKeys(committed);
    seen0 = new Set(current.filter(issueKey => previous.has(issueKey)));
  }
  const nextState = (keys: Iterable<string>): JSONValue => {
    const state = { v: 1 as const, fp: params.fingerprint, seen: seenFromKeys(keys) };
    return encodeState(state, maxStateBytes, current.length) as unknown as JSONValue;
  };

  const fresh = current.filter(issueKey => !seen0.has(issueKey));
  if (fresh.length === 0) return { items: [], state: nextState(seen0), more: false };

  const candidates = [...fresh].sort(compareKeys).slice(0, MAX_DETAIL_CANDIDATES);
  const wanted = new Set(candidates);
  // A moved issue may answer under another key; never return (or commit) a key we did not ask for.
  const details = (await client.issuesByKey(candidates, maxItems, signal))
    .filter(issue => wanted.has(issue.key))
    .slice(0, maxItems);
  const returned = details.map(issue => issue.key);
  return {
    items: details.map(issue => toItem(issue, params.site)),
    state: nextState([...seen0, ...returned]),
    more: fresh.length > returned.length,
  };
}
