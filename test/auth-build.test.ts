import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExtension, createPollHandler } from "../src/index.js";
import { createJiraClient, resolveCredentials } from "../src/jira-client.js";
import { resolveParams } from "../src/params.js";
import { pollJiraIssues } from "../src/poll.js";
import { pollRequest, rejection, catchSync } from "./helpers.js";
import { type FakeResponse, fixture, startFakeJira } from "./fake-jira-server.js";

const ROOT = join(import.meta.dir, "..");

describe("credentials", () => {
  test("UT-050 credentials: Basic header and the token never appears in any error", async () => {
    const jira = await startFakeJira();
    const credentials = { email: "ana@example.com", apiToken: "t0k" };
    const bodies: Array<[number, unknown]> = [
      [400, fixture("error-400.json")],
      [401, fixture("error-401.json")],
      [403, fixture("error-403.json")],
      [404, fixture("error-404.html")],
      [429, fixture("error-429.json")],
      [503, fixture("error-503.html")],
      [200, "not json"],
    ];
    try {
      const client = createJiraClient(jira.site, credentials);
      for (const [status, body] of bodies) {
        jira.respond = () => ({ status, body });
        const error = await rejection(client.listKeys("project = PLAT", 100, new AbortController().signal));
        expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain("t0k");
      }
      jira.respond = undefined;
      await client.listKeys("project = PLAT", 100, new AbortController().signal);
      expect(jira.requests.at(-1)!.headers.authorization).toBe("Basic YW5hQGV4YW1wbGUuY29tOnQwaw==");
      const closed = createJiraClient("127.0.0.1:1", credentials);
      const network = await rejection(closed.listKeys("x", 1, new AbortController().signal));
      expect(network.message).toBe("Jira request failed: network error");
      expect(network.message).not.toContain("t0k");
    } finally {
      await jira.close();
    }
  });

  test("UT-050 credentials: the poll handler logs only code and status to stderr", async () => {
    const jira = await startFakeJira();
    jira.respond = () => ({ status: 401, body: fixture("error-401.json") });
    const lines: string[] = [];
    const handler = createPollHandler({
      env: { JIRA_EMAIL: "ana@example.com", JIRA_API_TOKEN: "t0k" },
      stderr: { write: line => lines.push(line) },
    });
    try {
      const error = await rejection(handler(pollRequest(null, { params: { site: jira.site } })));
      expect(error.message).toBe(
        "Jira rejected the credentials for ana@example.com; create a new API token and bind JIRA_API_TOKEN again"
      );
      expect(lines).toEqual(["jira/issues poll failed: code=source_credential_expired status=401\n"]);
    } finally {
      await jira.close();
    }
  });

  test("UT-050 credentials: a token reflected by Jira is redacted from every handler error (R-2)", async () => {
    const token = "review-dummy-token";
    const jira = await startFakeJira();
    const handler = createPollHandler({
      env: { JIRA_EMAIL: "ana@example.com", JIRA_API_TOKEN: token },
      stderr: { write: () => true },
    });
    const run = async (response: FakeResponse) => {
      jira.respond = () => response;
      return await rejection(handler(pollRequest(null, { params: { site: jira.site } })));
    };
    try {
      const jql = await run({ status: 400, body: { errorMessages: [`Invalid input ${token}`] } });
      expect(jql.data).toEqual({ code: "source_params_invalid" });
      expect(jql.message).toBe("Jira rejected the JQL: Invalid input [redacted]");

      const errors = await run({ status: 400, body: { errors: { jql: `Field '${token}' does not exist` } } });
      expect(errors.message).toBe("Jira rejected the JQL: Field '[redacted]' does not exist");

      // Redaction happens before the 300-character clip, so no token prefix survives the cut.
      const straddling = await run({ status: 400, body: { errorMessages: [`${"a".repeat(290)} ${token}`] } });
      expect(straddling.message).not.toContain(token.slice(0, 5));

      const status = await run({ status: 502, statusText: `Bad Gateway ${token}` });
      expect(status.data).toEqual({ code: "source_extension_failed" });
      expect(status.message).toBe("Jira request failed: 502 Bad Gateway [redacted]");

      const expired = await run({ status: 401, body: { errorMessages: [token] } });
      expect(expired.message).toBe(
        "Jira rejected the credentials for ana@example.com; create a new API token and bind JIRA_API_TOKEN again"
      );
    } finally {
      await jira.close();
    }
  });

  test("UT-050 credentials: the handler redacts the token on paths that echo other input (R-2)", async () => {
    const handler = createPollHandler({
      env: { JIRA_EMAIL: "ana@example.com", JIRA_API_TOKEN: "acme-secret" },
      fetch: (async () => new Response("<html>Not Found</html>", { status: 404 })) as unknown as typeof fetch,
      stderr: { write: () => true },
    });
    const error = await rejection(handler(pollRequest(null, { params: { site: "acme-secret.atlassian.net" } })));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe("no Jira Cloud site at [redacted].atlassian.net");
  });

  test("UT-051 credentials: a missing token names JIRA_API_TOKEN and the secrets command", () => {
    const error = catchSync(() => resolveCredentials({ JIRA_EMAIL: "ana@example.com" }));
    expect(error.data).toEqual({ code: "source_credential_absent" });
    expect(error.message).toBe(
      "Jira sign-in missing JIRA_API_TOKEN; run compozy extension secrets set jira --env JIRA_API_TOKEN"
    );
  });

  test("UT-051 credentials: neither variable set names both", async () => {
    const handler = createPollHandler({ env: {}, stderr: { write: () => true } });
    const error = await rejection(handler(pollRequest()));
    expect(error.data).toEqual({ code: "source_credential_absent" });
    expect(error.message).toBe(
      "Jira sign-in missing JIRA_EMAIL and JIRA_API_TOKEN; run compozy extension secrets set jira " +
        "--env JIRA_EMAIL and compozy extension secrets set jira --env JIRA_API_TOKEN"
    );
  });

  test("UT-051 credentials: a blank email is reported as missing", () => {
    const error = catchSync(() => resolveCredentials({ JIRA_EMAIL: " ", JIRA_API_TOKEN: "t0k" }));
    expect(error.message).toStartWith("Jira sign-in missing JIRA_EMAIL;");
  });
});

describe("build", () => {
  const expectManifest = (manifest: string) => {
    expect(manifest).toMatch(/min_compozy_version = "0\.7\.0"/);
    // The build sorts requires_env; the set is JIRA_EMAIL and JIRA_API_TOKEN.
    expect(manifest).toMatch(/requires_env = \["JIRA_API_TOKEN", "JIRA_EMAIL"\]/);
    expect(manifest).toMatch(/\[capabilities\]\s+provides = \["heartbeat\.source"\]/);
    expect(manifest).toMatch(/\[subprocess\]\s+args = \["index\.js"\]\s+command = "node"/);
  };

  test("UT-060 build: the describe payload carries the manifest fields and the 0.7.0 floor", () => {
    const payload = createExtension().describe();
    expect(payload.sdk.min_compozy_version).toBe("0.7.0");
    expect([...(payload.requires_env ?? [])].sort()).toEqual(["JIRA_API_TOKEN", "JIRA_EMAIL"]);
    expect(payload.provides).toEqual(["heartbeat.source"]);
    expect(payload.permissions).toEqual([]);
    expect(payload.subprocess).toMatchObject({ command: "node", args: ["index.js"] });
    expect(payload.heartbeat_source_kinds).toMatchObject([{ kind: "issues", title: "New Jira issues" }]);
  });

  const compozy = spawnSync("compozy", ["--version"], { encoding: "utf8" });
  test.skipIf(compozy.status !== 0)(
    "UT-060 build: compozy extension build writes the expected extension.toml",
    () => {
      const out = mkdtempSync(join(tmpdir(), "jira-gen-"));
      try {
        const build = spawnSync("compozy", ["extension", "build", ROOT, "--output-dir", out], {
          encoding: "utf8",
          timeout: 120_000,
        });
        expect(build.status, build.stderr).toBe(0);
        const generation = readdirSync(out).find(name => name.startsWith("gen-"))!;
        expectManifest(readFileSync(join(out, generation, "extension.toml"), "utf8"));
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    130_000
  );
});

describe("entry point", () => {
  test("UT-051 credentials: params are checked before credentials", async () => {
    const handler = createPollHandler({ env: {}, stderr: { write: () => true } });
    const error = await rejection(handler(pollRequest(null, { params: { site: "acme" } })));
    expect(error.data).toEqual({ code: "source_params_invalid" });
  });

  test("UT-033 poll: a failed poll returns no partial result", async () => {
    const jira = await startFakeJira();
    jira.respond = () => ({ status: 503, statusText: "Service Unavailable" });
    try {
      const params = resolveParams({ site: jira.site });
      const client = createJiraClient(jira.site, { email: "a@b.c", apiToken: "x" });
      const error = await rejection(pollJiraIssues(pollRequest(), { client, params }));
      expect(error.data).toEqual({ code: "source_extension_failed" });
    } finally {
      await jira.close();
    }
  });
});
