import { describe, expect, jest, test } from "bun:test";

import type { JiraClient } from "../src/jira-client.js";
import { resolveParams } from "../src/params.js";
import { POLL_BUDGET_MS, pollJiraIssues } from "../src/poll.js";
import { sourceError } from "../src/errors.js";
import { fakeClient, keys, pollRequest, rejection, SITE } from "./helpers.js";

const params = resolveParams({ site: SITE, jql: "project = PLAT" });
const state = (seen: Record<string, number[]>, fp = params.fingerprint) => ({ v: 1, fp, seen });
const itemKeys = (result: { items: Array<{ key: string }> }) => result.items.map(item => item.key);

async function poll(committed: unknown, client: JiraClient, overrides = {}, p = params) {
  return await pollJiraIssues(pollRequest(committed, overrides), { client, params: p });
}

describe("poll", () => {
  test("UT-020 poll: new issue matching JQL is returned", async () => {
    const result = await poll(state({ PLAT: [1, 2] }), fakeClient({ current: keys("PLAT", 1, 3) }));
    expect(itemKeys(result)).toEqual(["PLAT-3"]);
    expect(result.state).toEqual(state({ PLAT: [1, 2, 3] }));
    expect(result.more).toBe(false);
  });

  test("UT-021 poll: old issue moving into the JQL is returned", async () => {
    const result = await poll(state({ PLAT: [5] }), fakeClient({ current: ["PLAT-5", "PLAT-1"] }));
    expect(itemKeys(result)).toEqual(["PLAT-1"]);
    expect(result.state).toEqual(state({ PLAT: [1, 5] }));
  });

  test("UT-022 poll: still-matching issues are not repeated", async () => {
    const client = fakeClient({ current: keys("PLAT", 1, 3) });
    const result = await poll(state({ PLAT: [1, 2, 3] }), client);
    expect(result.items).toEqual([]);
    expect(result.state).toEqual(state({ PLAT: [1, 2, 3] }));
    expect(client.calls.map(call => call.method)).toEqual(["listKeys"]);
  });

  test("UT-023 poll: an issue that leaves and re-enters is reported again", async () => {
    const left = await poll(state({ PLAT: [1, 3] }), fakeClient({ current: ["PLAT-1"] }));
    expect(left.items).toEqual([]);
    expect(left.state).toEqual(state({ PLAT: [1] }));
    const back = await poll(left.state, fakeClient({ current: ["PLAT-1", "PLAT-3"] }));
    expect(itemKeys(back)).toEqual(["PLAT-3"]);
  });

  test("UT-024 poll: a moved issue is returned under its new key", async () => {
    const result = await poll(state({ PLAT: [9] }), fakeClient({ current: ["OPS-4"] }));
    expect(itemKeys(result)).toEqual(["OPS-4"]);
    expect(result.state).toEqual(state({ OPS: [4] }));
  });

  test("UT-025 poll: a deleted or hidden issue drops silently and stays out of the state", async () => {
    const client = fakeClient({ current: ["PLAT-1", "PLAT-7"], hidden: ["PLAT-7"] });
    const result = await poll(state({ PLAT: [1] }), client);
    expect(result.items).toEqual([]);
    expect(result.state).toEqual(state({ PLAT: [1] }));
  });

  test("UT-026 poll: the first check is a quiet baseline", async () => {
    const result = await poll(null, fakeClient({ current: keys("PLAT", 1, 40) }));
    expect(result.items).toEqual([]);
    expect(result.state).toEqual(state({ PLAT: Array.from({ length: 40 }, (_, i) => i + 1) }));
  });

  test("UT-027 poll: an empty baseline commits an empty set", async () => {
    const result = await poll(null, fakeClient({ current: [] }));
    expect(result.items).toEqual([]);
    expect(result.state).toEqual({ v: 1, fp: params.fingerprint, seen: {} });
  });

  test("UT-028 poll: backfill returns recent matches and commits all of them", async () => {
    const p = resolveParams({ site: SITE, jql: "project = PLAT", backfill: "24h" });
    const client = fakeClient({ current: keys("PLAT", 1, 33), window: ["PLAT-31", "PLAT-32", "PLAT-33"] });
    const result = await poll(null, client, {}, p);
    expect(itemKeys(result)).toEqual(["PLAT-31", "PLAT-32", "PLAT-33"]);
    expect(result.state).toEqual(state({ PLAT: keys("PLAT", 1, 33).map((_, i) => i + 1) }, p.fingerprint));
    expect(client.calls[1]).toEqual({ method: "listKeys", jql: "(project = PLAT) AND created >= -1440m" });
  });

  test("UT-029 poll: backfill is ignored once the baseline is committed", async () => {
    const p = resolveParams({ site: SITE, jql: "project = PLAT", backfill: "24h" });
    const client = fakeClient({ current: ["PLAT-1"], window: ["PLAT-1"] });
    const result = await poll(state({ PLAT: [1] }, p.fingerprint), client, {}, p);
    expect(result.items).toEqual([]);
    expect(client.calls).toEqual([{ method: "listKeys", jql: "project = PLAT" }]);
  });

  test("UT-030 poll: more than max_items pages with more:true", async () => {
    const client = fakeClient({ current: keys("PLAT", 1, 25) });
    const first = await poll(state({}), client);
    expect(itemKeys(first)).toEqual(keys("PLAT", 1, 20));
    expect(first.more).toBe(true);
    expect(first.state).toEqual(state({ PLAT: Array.from({ length: 20 }, (_, i) => i + 1) }));
    const second = await poll(first.state, client);
    expect(itemKeys(second)).toEqual(keys("PLAT", 21, 25));
    expect(second.more).toBe(false);
  });

  test("UT-030 poll: detail candidates are capped at 200 keys", async () => {
    const client = fakeClient({ current: keys("PLAT", 1, 250) });
    await poll(state({}), client);
    expect(client.calls[1]!.keys).toHaveLength(200);
  });

  test("UT-033 poll: a client failure rejects with the same code and no result", async () => {
    const client = fakeClient({ current: [] });
    client.listKeys = async () => {
      throw sourceError("source_credential_expired", "Jira rejected the credentials");
    };
    const error = await rejection(poll(null, client));
    expect(error.data).toEqual({ code: "source_credential_expired" });
  });

  test("UT-034 poll: dry run and real run return identical results", async () => {
    const committed = state({ PLAT: [1] });
    const client = fakeClient({ current: keys("PLAT", 1, 4) });
    const dry1 = await poll(committed, client, { dry_run: true });
    const dry2 = await poll(committed, client, { dry_run: true });
    const real = await poll(committed, client, { dry_run: false });
    expect(dry1).toEqual(dry2);
    expect(real).toEqual(dry1);
  });

  test("UT-035 poll: a changed JQL fingerprint re-baselines quietly", async () => {
    const result = await poll(state({ PLAT: [1] }, "ffffffffffffffff"), fakeClient({ current: keys("PLAT", 1, 40) }));
    expect(result.items).toEqual([]);
    expect(result.state).toEqual(state({ PLAT: Array.from({ length: 40 }, (_, i) => i + 1) }));
  });

  const capacityMessage = (count: number) =>
    `JQL matches ${count} issues, more than fit in max_state_bytes=16384; ` +
    "narrow it or raise agents.heartbeat.sources.max_state_bytes";

  test("UT-031 poll: a match set under the listing guard but over max_state_bytes fails on a diff poll (D-3)", async () => {
    const current = keys("PLAT", 100000, 102999); // 3,000 keys < 4,080 guard, ~21 KiB encoded
    const error = await rejection(poll(state({}), fakeClient({ current })));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe(capacityMessage(3000));
  });

  test("UT-031 poll: a match set over max_state_bytes fails on a backfill baseline (D-3)", async () => {
    const p = resolveParams({ site: SITE, jql: "project = PLAT", backfill: "24h" });
    const current = keys("PLAT", 100000, 102999);
    const client = fakeClient({ current, window: current.slice(-2900) });
    const error = await rejection(poll(null, client, {}, p));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe(capacityMessage(3000));
  });

  test("UT-032 poll: the listing guard is floor((max_state_bytes - 64) / 4) keys", async () => {
    const seen: number[] = [];
    const client = fakeClient({ current: [] });
    client.listKeys = async (_jql, maxKeys) => {
      seen.push(maxKeys);
      return [];
    };
    await poll(null, client);
    expect(seen).toEqual([Math.floor((16384 - 64) / 4)]);
  });

  test("UT-036 poll: the whole poll aborts after the 25 s budget", async () => {
    expect(POLL_BUDGET_MS).toBe(25_000);
    jest.useFakeTimers();
    try {
      const client = fakeClient({ current: [] });
      let aborted = false;
      client.listKeys = (_jql, _max, signal) =>
        new Promise(() => signal.addEventListener("abort", () => (aborted = true)));
      const pending = rejection(poll(null, client));
      jest.advanceTimersByTime(POLL_BUDGET_MS);
      const error = await pending;
      expect(error.data).toEqual({ code: "source_extension_failed" });
      expect(error.message).toBe("Jira listing took too long; narrow the JQL");
      expect(aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
