import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { createJiraClient, REQUEST_TIMEOUT_MS } from "../src/jira-client.js";
import { resolveParams } from "../src/params.js";
import { pollJiraIssues } from "../src/poll.js";
import { type FakeJira, fixture, startFakeJira } from "./fake-jira-server.js";
import { jiraIssue, keys, noRedact, pollRequest, rejection } from "./helpers.js";

const credentials = { email: "ana@example.com", apiToken: "t0k" };
const signal = () => new AbortController().signal;

let jira: FakeJira;
beforeEach(async () => {
  jira = await startFakeJira({ pageSize: 2 });
});
afterEach(async () => {
  await jira.close();
});

const client = (options = {}) => createJiraClient(jira.site, credentials, options);
async function poll(state: unknown, params: Record<string, unknown> = {}) {
  const resolved = resolveParams({ site: jira.site, jql: "project = PLAT", ...params });
  return await pollJiraIssues(pollRequest(state, { params: { site: jira.site, ...params } }), {
    client: client(),
    params: resolved,
    redact: noRedact,
  });
}

describe("jira-client + poll against the fake HTTP server", () => {
  test("IT-001 client: key pages linked by nextPageToken are unioned and the new item is returned", async () => {
    jira.issues = keys("PLAT", 1, 3).map(k => jiraIssue(k));
    expect(await client().listKeys("project = PLAT", 100, signal())).toEqual(keys("PLAT", 1, 3));
    expect(jira.requests.map(r => r.body.nextPageToken)).toEqual([undefined, "2"]);

    const baseline = await poll(null);
    expect(baseline.items).toEqual([]);
    jira.issues.push(fixture("issue-plat-1201.json"));
    const result = await poll(baseline.state);
    expect(result.items.map(item => item.key)).toEqual(["PLAT-1201"]);
    expect(result.items[0]!.url).toBe(`http://${jira.site}/browse/PLAT-1201`);
  });

  test("IT-002 client: a backfill baseline makes the listing, window and details requests", async () => {
    const now = Date.now();
    const old = jiraIssue("PLAT-1");
    const recent = { ...jiraIssue("PLAT-2"), fields: { ...jiraIssue("PLAT-2").fields, created: new Date(now - 60_000).toISOString() } };
    jira.issues = [old, recent];
    const result = await poll(null, { backfill: "24h" });
    expect(result.items.map(item => item.key)).toEqual(["PLAT-2"]);
    expect(jira.requests.map(r => r.body.jql)).toEqual([
      "project = PLAT",
      "(project = PLAT) AND created >= -1440m",
      "key in (PLAT-2) ORDER BY created ASC",
    ]);
  });

  test("IT-003 client: the details request orders by created and the response order is kept", async () => {
    jira.respond = request =>
      request.body.jql.startsWith("key in")
        ? { status: 200, body: { issues: [jiraIssue("PLAT-9"), jiraIssue("PLAT-3")], isLast: true } }
        : undefined;
    const issues = await client().issuesByKey(["PLAT-3", "PLAT-9"], 20, signal());
    expect(jira.requests[0]!.body.jql).toBe("key in (PLAT-3,PLAT-9) ORDER BY created ASC");
    expect(jira.requests[0]!.body.maxResults).toBe(20);
    expect(issues.map(issue => issue.key)).toEqual(["PLAT-9", "PLAT-3"]);
  });

  test("IT-004 client: 400 surfaces Jira's JQL error as source_params_invalid", async () => {
    jira.respond = () => ({ status: 400, body: fixture("error-400.json") });
    const error = await rejection(client().listKeys("sprnt = 1", 100, signal()));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe(
      "Jira rejected the JQL: Field 'sprnt' does not exist or you do not have permission to view it."
    );
    jira.respond = () => ({ status: 400, body: { errorMessages: ["x".repeat(1000)] } });
    const long = await rejection(client().listKeys("sprnt = 1", 100, signal()));
    expect(long.message.length).toBe("Jira rejected the JQL: ".length + 300);
  });

  test("IT-005 client: every request is an authenticated JSON POST to /rest/api/3/search/jql", async () => {
    jira.issues = keys("PLAT", 1, 3).map(k => jiraIssue(k));
    await client().listKeys("project = PLAT", 100, signal());
    await client().issuesByKey(["PLAT-1"], 5, signal());
    expect(jira.requests.length).toBe(3);
    for (const request of jira.requests) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/rest/api/3/search/jql");
      expect(request.headers.authorization).toStartWith("Basic ");
      expect(request.headers.accept).toBe("application/json");
    }
    expect(jira.requests[0]!.body).toEqual({ jql: "project = PLAT", fields: ["key"], maxResults: 5000 });
  });

  test("IT-006 client: 401 is source_credential_expired naming the email, never the token", async () => {
    jira.respond = () => ({ status: 401, body: fixture("error-401.json") });
    const error = await rejection(client().listKeys("x", 100, signal()));
    expect(error.data).toEqual({ code: "source_credential_expired" });
    expect(error.message).toContain("ana@example.com");
    expect(error.message).not.toContain("t0k");
  });

  test("IT-007 client: 403 is source_params_invalid with the permission wording", async () => {
    jira.respond = () => ({ status: 403, body: fixture("error-403.json") });
    const error = await rejection(client().listKeys("x", 100, signal()));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe("this Jira account cannot search with this JQL; check project permissions");
  });

  test("IT-008 client: 429 is source_rate_limited", async () => {
    jira.respond = () => ({ status: 429, body: fixture("error-429.json") });
    const error = await rejection(client().listKeys("x", 100, signal()));
    expect(error.data).toEqual({ code: "source_rate_limited" });
    expect(error.message).toBe("Jira rate limit reached; retry later");
  });

  test("IT-009 client: 503 is source_extension_failed with the status line", async () => {
    jira.respond = () => ({ status: 503, body: fixture("error-503.html") });
    const error = await rejection(client().listKeys("x", 100, signal()));
    expect(error.data).toEqual({ code: "source_extension_failed" });
    expect(error.message).toBe("Jira request failed: 503 Service Unavailable");
  });

  test("IT-010 client: a request slower than the per-request timeout fails", async () => {
    // The default is 10 s; the invariant (server slower than the timeout) is kept at test scale.
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    jira.respond = () => ({ status: 200, body: { issues: [] }, delayMs: 1_100 });
    const error = await rejection(client({ requestTimeoutMs: 1_000 }).listKeys("x", 100, signal()));
    expect(error.data).toEqual({ code: "source_extension_failed" });
    expect(error.message).toBe("Jira request failed: no answer within 1s");
  });

  test("IT-010 client: a body that stalls after the headers times out, not a JQL error (R-6)", async () => {
    const sockets = new Set<Socket>();
    const stall = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(Number(req.headers["x-status"] ?? 400), { "Content-Type": "application/json" });
        res.write("{"); // then never finish the body
      });
    });
    stall.on("connection", socket => sockets.add(socket));
    await new Promise<void>(resolve => stall.listen(0, "127.0.0.1", resolve));
    const site = `127.0.0.1:${(stall.address() as AddressInfo).port}`;
    try {
      for (const status of ["400", "200"]) {
        const stallingFetch = ((input: string, init: RequestInit) =>
          fetch(input, {
            ...init,
            headers: { ...(init.headers as Record<string, string>), "x-status": status },
          })) as typeof fetch;
        const stalled = createJiraClient(site, credentials, { fetch: stallingFetch, requestTimeoutMs: 100 });
        const error = await rejection(stalled.listKeys("x", 100, signal()));
        expect(error.data).toEqual({ code: "source_extension_failed" });
        expect(error.message).toBe("Jira request failed: no answer within 0.1s");
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => stall.close(() => resolve()));
    }
  });

  test("IT-004 client: a complete but malformed 400 body still reads Bad Request (R-6)", async () => {
    jira.respond = () => ({ status: 400, body: "{not json" });
    const error = await rejection(client().listKeys("x", 100, signal()));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe("Jira rejected the JQL: Bad Request");
  });

  test("IT-011 client: a 404 HTML page means no Jira Cloud site", async () => {
    jira.respond = () => ({ status: 404, body: fixture("error-404.html") });
    const error = await rejection(client().listKeys("x", 100, signal()));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe(`no Jira Cloud site at ${jira.site}`);
  });

  test("UT-032 client: a listing over the key guard aborts before further pages", async () => {
    jira.issues = keys("PLAT", 1, 10).map(k => jiraIssue(k));
    const error = await rejection(client().listKeys("project = PLAT", 3, signal()));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(jira.requests).toHaveLength(2);
  });

  test("UT-032 poll: an over-guard listing fails with the capacity message and no state", async () => {
    jira.issues = keys("PLAT", 1, 10).map(k => jiraIssue(k));
    const params = resolveParams({ site: jira.site });
    const request = pollRequest(null, { limits: { max_items: 20, max_summary_bytes: 1024, max_state_bytes: 80 } });
    const error = await rejection(pollJiraIssues(request, { client: client(), params, redact: noRedact }));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe(
      "JQL matches more than 4 issues, more than fit in max_state_bytes=80; " +
        "narrow it or raise agents.heartbeat.sources.max_state_bytes"
    );
  });
});
