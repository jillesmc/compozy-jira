import { describe, expect, test } from "bun:test";

import { createPollHandler } from "../src/index.js";
import { type JiraIssue, redactor } from "../src/jira-client.js";
import { resolveParams } from "../src/params.js";
import { type FakeResponse, fixture, startFakeJira } from "./fake-jira-server.js";
import { pollRequest, rejection } from "./helpers.js";

// R-8: the token is base64(email), so it is a prefix of base64(email:token).
const email = "review@example.com";
const overlapToken = "cmV2aWV3QGV4YW1wbGUuY29t";
const basicOf = (token: string) => Buffer.from(`${email}:${token}`).toString("base64");
const bound = (token: string) => ({ email, apiToken: token });

/** One handler poll over the fake Jira, after a committed empty baseline. */
async function pollIssue(token: string, edit: (issue: JiraIssue) => void) {
  const issue = fixture<JiraIssue>("issue-plat-1201.json");
  edit(issue);
  const jira = await startFakeJira({ issues: [issue] });
  try {
    const handler = createPollHandler({
      env: { JIRA_EMAIL: email, JIRA_API_TOKEN: token },
      stderr: { write: () => true },
    });
    const fp = resolveParams({ site: jira.site }).fingerprint;
    const result = await handler(pollRequest({ v: 1, fp, seen: {} }, { params: { site: jira.site } }));
    // Keys and state are never redacted.
    expect(result.items.map(item => item.key)).toEqual(["PLAT-1201"]);
    expect(result.state).toEqual({ v: 1, fp, seen: { PLAT: [1201] } });
    return result.items[0]!;
  } finally {
    await jira.close();
  }
}

/** The handler's error message for one fake Jira response. */
async function failWith(token: string, response: FakeResponse): Promise<string> {
  const jira = await startFakeJira();
  jira.respond = () => response;
  try {
    const handler = createPollHandler({
      env: { JIRA_EMAIL: email, JIRA_API_TOKEN: token },
      stderr: { write: () => true },
    });
    return (await rejection(handler(pollRequest(null, { params: { site: jira.site } })))).message;
  } finally {
    await jira.close();
  }
}

describe("redaction (D-6, R-8, R-9)", () => {
  test("UT-050 credentials: an overlapping raw token and Basic credential become one marker in items", async () => {
    const item = await pollIssue(overlapToken, issue => {
      issue.fields.summary = `auth ${basicOf(overlapToken)}`;
      issue.fields.reporter = { displayName: `${overlapToken} and ${basicOf(overlapToken)}` };
    });
    expect(item.title).toBe("PLAT-1201 auth [redacted]");
    expect(item.attributes).toMatchObject({ reporter: "[redacted] and [redacted]" });
  });

  test("UT-050 credentials: an overlapping raw token and Basic credential become one marker in errors", async () => {
    const message = await failWith(overlapToken, {
      status: 400,
      body: { errorMessages: [`auth ${basicOf(overlapToken)}`] },
    });
    expect(message).toBe("Jira rejected the JQL: auth [redacted]");
  });

  test("UT-050 credentials: a short token never leaves a partly redacted Basic credential", async () => {
    const item = await pollIssue("a", issue => {
      issue.fields.summary = `auth ${basicOf("a")}`;
    });
    expect(item.title).toBe("PLAT-1201 [redacted]uth [redacted]");
    expect(item.attributes).toMatchObject({ reporter: "An[redacted] Souz[redacted]", project: "PLAT" });
  });

  test("UT-050 credentials: redaction is idempotent and never rewrites markers", () => {
    const redact = redactor(bound("a"));
    expect(redact("[redacted]")).toBe("[redacted]");
    expect(redact("aa [redacted] ba")).toBe("[redacted] [redacted] b[redacted]");
    for (const text of ["a[redacted]a", `x ${basicOf("a")} a`, "aaaa", "[redacted]r"]) {
      expect(redact(redact(text))).toBe(redact(text));
    }
    const overlap = redactor(bound(overlapToken));
    const text = `${basicOf(overlapToken)}${overlapToken} tail`;
    expect(overlap(text)).toBe("[redacted] tail");
    expect(overlap(overlap(text))).toBe("[redacted] tail");
  });

  test("UT-050 credentials: copied Jira error text stays within 300 characters after redaction (R-9)", async () => {
    expect(await failWith("a", { status: 400, body: { errorMessages: ["a".repeat(100)] } })).toBe(
      "Jira rejected the JQL: [redacted]"
    );
    const spread = await failWith("a", { status: 400, body: { errorMessages: ["ab".repeat(200)] } });
    expect(spread).toBe(`Jira rejected the JQL: ${"[redacted]b".repeat(28).slice(0, 300)}`);
    expect(await failWith("a", { status: 400, body: { errorMessages: [] } })).toBe(
      "Jira rejected the JQL: Bad Request"
    );
    expect(await failWith("a", { status: 502, statusText: "Bad Gateway a" })).toBe(
      "Jira request failed: 502 B[redacted]d G[redacted]tew[redacted]y [redacted]"
    );
    expect(await failWith(overlapToken, { status: 401, body: fixture("error-401.json") })).toBe(
      `Jira rejected the credentials for ${email}; create a new API token and bind JIRA_API_TOKEN again`
    );
  });
});
