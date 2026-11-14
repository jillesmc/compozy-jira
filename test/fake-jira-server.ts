/**
 * Fake Jira Cloud for tests and local E2E runs. It serves `POST /rest/api/3/search/jql` only, over
 * plain http on loopback, so a source with `site: 127.0.0.1:<port>` talks to it (Deviation D-1).
 *
 * In-process (tests):
 *   const jira = await startFakeJira({ issues: [...] });   // jira.site === "127.0.0.1:<port>"
 *   jira.requests   // every search request: { body, headers }
 *   jira.respond = req => ({ status: 503 })               // override one or all answers
 *   await jira.close();
 *
 * Standalone (E2E against a live daemon):
 *   bun test/fake-jira-server.ts --port 8787 [--seed issues.json]
 *   # seeds PLAT-1199 and PLAT-1200 unless --seed is given (a JSON array of Jira issues)
 *   curl -X POST http://127.0.0.1:8787/_fake/issues              # adds PLAT-1201 "Checkout fails on Pix"
 *   curl -X POST http://127.0.0.1:8787/_fake/issues -d @issue.json   # adds any Jira issue JSON
 *   curl http://127.0.0.1:8787/_fake/issues                      # lists the current issue set
 *   curl -X DELETE http://127.0.0.1:8787/_fake/issues/PLAT-1201  # removes one issue
 *   # HEARTBEAT.md: with: { site: "127.0.0.1:8787" }; any non-empty JIRA_EMAIL/JIRA_API_TOKEN works.
 *
 * JQL support is deliberately tiny: `key in (...)` selects keys, `created >= -<N>m` keeps issues
 * created in the last N minutes, `ORDER BY created ASC` sorts; any other JQL matches every issue.
 * Requests without a Basic Authorization header get 401.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type { JiraIssue } from "../src/jira-client.js";

export interface FakeRequest {
  body: { jql: string; fields?: string[]; maxResults?: number; nextPageToken?: string };
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  statusText?: string;
  delayMs?: number;
}

export interface FakeJira {
  site: string;
  port: number;
  issues: JiraIssue[];
  requests: FakeRequest[];
  /** Return a response to override the default search behavior for this request. */
  respond?: (request: FakeRequest) => FakeResponse | undefined;
  close(): Promise<void>;
}

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
export function fixture<T = unknown>(name: string): T {
  const text = readFileSync(`${fixtureDir}${name}`, "utf8");
  return (name.endsWith(".json") ? JSON.parse(text) : text) as T;
}

export async function startFakeJira(
  options: { issues?: JiraIssue[]; port?: number; pageSize?: number; now?: () => number } = {}
): Promise<FakeJira> {
  const now = options.now ?? Date.now;
  const fake: FakeJira = {
    site: "",
    port: 0,
    issues: [...(options.issues ?? [])],
    requests: [],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = req.url ?? "/";
    const send = (status: number, body: unknown, statusText?: string) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const type = typeof body === "string" ? "text/html" : "application/json";
      res.writeHead(status, statusText, { "Content-Type": type });
      res.end(text);
    };
    if (path.startsWith("/_fake/issues")) return admin(fake, req.method ?? "GET", path, raw, now, send);
    let body: FakeRequest["body"];
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(400, { errorMessages: ["Invalid request payload."] });
    }
    const request: FakeRequest = { body, headers: req.headers, method: req.method ?? "", path };
    fake.requests.push(request);
    const override = fake.respond?.(request);
    if (override) {
      if (override.delayMs) await new Promise(resolve => setTimeout(resolve, override.delayMs));
      if (res.destroyed) return;
      return send(override.status, override.body ?? "", override.statusText);
    }
    if (req.method !== "POST" || path !== "/rest/api/3/search/jql") return send(404, "<html>Not Found</html>");
    if (!/^Basic \S+$/.test(String(req.headers.authorization ?? ""))) {
      return send(401, { errorMessages: ["You are not authenticated."] });
    }
    send(200, search(fake.issues, body, options.pageSize ?? 5000, now()));
  });
  await new Promise<void>(resolve => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.site = `127.0.0.1:${fake.port}`;
  return fake;
}

function search(issues: JiraIssue[], body: FakeRequest["body"], pageSize: number, nowMs: number) {
  const jql = body.jql ?? "";
  let matches = [...issues];
  const keyList = /key in \(([^)]*)\)/i.exec(jql);
  if (keyList) {
    const keys = new Set(keyList[1]!.split(",").map(k => k.trim()));
    matches = matches.filter(issue => keys.has(issue.key));
  }
  const window = /created >= -(\d+)m/.exec(jql);
  if (window) {
    const since = nowMs - Number(window[1]) * 60_000;
    matches = matches.filter(issue => createdMs(issue) >= since);
  }
  if (/ORDER BY created ASC/i.test(jql)) matches.sort((a, b) => createdMs(a) - createdMs(b));
  const start = Number(body.nextPageToken ?? 0);
  const size = Math.min(body.maxResults ?? 50, pageSize);
  const page = matches.slice(start, start + size);
  const keysOnly = body.fields?.length === 1 && body.fields[0] === "key";
  const isLast = start + size >= matches.length;
  return {
    issues: page.map(issue => (keysOnly ? { id: idOf(issue), key: issue.key } : { id: idOf(issue), ...issue })),
    ...(isLast ? {} : { nextPageToken: String(start + size) }),
    isLast,
  };
}

function createdMs(issue: JiraIssue): number {
  return Date.parse(issue.fields.created.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

function idOf(issue: JiraIssue): string {
  return String(10000 + Number(issue.key.split("-")[1] ?? 0));
}

function admin(
  fake: FakeJira,
  method: string,
  path: string,
  raw: string,
  now: () => number,
  send: (status: number, body: unknown) => void
) {
  if (method === "GET") return send(200, fake.issues);
  if (method === "DELETE") {
    const issueKey = decodeURIComponent(path.split("/").pop() ?? "");
    fake.issues = fake.issues.filter(issue => issue.key !== issueKey);
    return send(200, { removed: issueKey });
  }
  if (method === "POST") {
    const issue: JiraIssue = raw.trim() ? JSON.parse(raw) : presetIssue(now());
    fake.issues = [...fake.issues.filter(existing => existing.key !== issue.key), issue];
    return send(201, issue);
  }
  send(405, { errorMessages: ["method not allowed"] });
}

/** PLAT-1201 "Checkout fails on Pix" from the `_dx.md` item example, created at `nowMs`. */
export function presetIssue(nowMs: number): JiraIssue {
  const issue = fixture<JiraIssue>("issue-plat-1201.json");
  const at = new Date(nowMs).toISOString();
  return { ...issue, fields: { ...issue.fields, created: at, updated: at } };
}

function defaultSeed(nowMs: number): JiraIssue[] {
  const base = fixture<JiraIssue>("issue-plat-1201.json");
  return [1199, 1200].map(n => ({
    key: `PLAT-${n}`,
    fields: {
      ...base.fields,
      summary: `Seeded issue ${n}`,
      labels: [],
      created: new Date(nowMs - (1201 - n) * 86_400_000).toISOString(),
      updated: new Date(nowMs - (1201 - n) * 86_400_000).toISOString(),
    },
  }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const seed = arg("--seed");
  const issues = seed ? (JSON.parse(readFileSync(seed, "utf8")) as JiraIssue[]) : defaultSeed(Date.now());
  const fake = await startFakeJira({ issues, port: Number(arg("--port") ?? 8787) });
  console.log(`fake Jira listening on http://${fake.site} with ${fake.issues.length} issues`);
}
