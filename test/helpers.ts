import type { HeartbeatSourceRequest, JSONValue } from "@compozy/extension-sdk";

import { SourceError } from "../src/errors.js";
import type { JiraClient, JiraIssue } from "../src/jira-client.js";

export const SITE = "acme.atlassian.net";

export function pollRequest(
  state: unknown = null,
  overrides: Partial<HeartbeatSourceRequest> = {}
): HeartbeatSourceRequest {
  return {
    version: 1,
    source_id: "my-jira",
    kind: "issues",
    params: { site: SITE },
    state: state as JSONValue,
    limits: { max_items: 20, max_summary_bytes: 1024, max_state_bytes: 16384 },
    workspace: { id: "ws_test", root_dir: "/tmp/ws" },
    now: "2026-11-14T12:00:00Z",
    dry_run: false,
    ...overrides,
  };
}

/** A minimal Jira issue; `n` orders `created` so lower numbers are older. */
export function jiraIssue(issueKey: string, n = Number(issueKey.split("-")[1] ?? 0)): JiraIssue {
  const created = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
  return {
    key: issueKey,
    fields: {
      summary: `Summary of ${issueKey}`,
      project: { key: issueKey.split("-")[0]! },
      issuetype: { name: "Task" },
      status: { name: "To Do", statusCategory: { name: "To Do" } },
      priority: { name: "Medium" },
      assignee: { displayName: "Ana Souza" },
      reporter: { displayName: "Bruno Lima" },
      labels: [],
      created,
      updated: created,
    },
  };
}

/** Fake JiraClient: `current` is the JQL match set, `window` the backfill match set. */
export function fakeClient(options: {
  current: string[];
  window?: string[];
  hidden?: string[];
}): JiraClient & { calls: Array<{ method: string; jql?: string; keys?: string[] }> } {
  const calls: Array<{ method: string; jql?: string; keys?: string[] }> = [];
  return {
    calls,
    async listKeys(jql) {
      calls.push({ method: "listKeys", jql });
      return / AND created >= -\d+m$/.test(jql) ? [...(options.window ?? [])] : [...options.current];
    },
    async issuesByKey(keys, limit) {
      calls.push({ method: "issuesByKey", keys });
      return keys
        .filter(issueKey => !(options.hidden ?? []).includes(issueKey))
        .map(issueKey => jiraIssue(issueKey))
        .sort((a, b) => a.fields.created.localeCompare(b.fields.created))
        .slice(0, limit);
    },
  };
}

export function keys(project: string, from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => `${project}-${from + i}`);
}

export async function rejection(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SourceError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

export function catchSync(fn: () => unknown): SourceError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SourceError) return error;
    throw error;
  }
  throw new Error("expected a throw");
}
