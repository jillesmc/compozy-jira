import { ListingLimitError, sourceError } from "./errors.js";
import { siteBaseUrl } from "./params.js";
import { networkFailureReason } from "./system-ca.js";

export interface JiraCredentials {
  email: string;
  apiToken: string;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    project: { key: string };
    issuetype?: { name: string };
    status?: { name: string; statusCategory?: { name: string } };
    priority?: { name: string } | null;
    assignee?: { displayName: string } | null;
    reporter?: { displayName: string } | null;
    labels?: string[];
    created: string;
    updated: string;
  };
}

export interface JiraClient {
  /** Every key matching `jql`; aborts with source_params_invalid once `maxKeys` is exceeded. */
  listKeys(jql: string, maxKeys: number, signal: AbortSignal): Promise<string[]>;
  /** Up to `limit` issues among `keys`, oldest created first. */
  issuesByKey(keys: string[], limit: number, signal: AbortSignal): Promise<JiraIssue[]>;
}

export const REQUEST_TIMEOUT_MS = 10_000;
export const LIST_PAGE_SIZE = 5000;
const SEARCH_PATH = "/rest/api/3/search/jql";
const DETAIL_FIELDS = [
  "summary",
  "project",
  "issuetype",
  "status",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "created",
  "updated",
];

/** Reads the two bound secrets from an explicitly passed environment; never from process.env. */
export function resolveCredentials(env: Record<string, string | undefined>): JiraCredentials {
  const email = env.JIRA_EMAIL?.trim() ?? "";
  const apiToken = env.JIRA_API_TOKEN?.trim() ?? "";
  const missing = [email ? "" : "JIRA_EMAIL", apiToken ? "" : "JIRA_API_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    throw sourceError(
      "source_credential_absent",
      `Jira sign-in missing ${missing.join(" and ")}; run ` +
        missing.map(name => `compozy extension secrets set jira --env ${name}`).join(" and ")
    );
  }
  return { email, apiToken };
}

function basicCredential(credentials: JiraCredentials): string {
  return Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64");
}

const MARKER = "[redacted]";

/**
 * Replaces the bound token, raw or as the base64 Basic credential, with `[redacted]`. Jira may echo
 * request input back, so every outward Jira-sourced string (errors and items) passes through this.
 * Every occurrence of either form is found in the original text and overlapping or adjacent spans
 * merge into one marker, so neither form can leave a decodable remnant of the other. Existing
 * markers are kept verbatim, which makes it idempotent.
 */
export function redactor(credentials: JiraCredentials): (text: string) => string {
  const secrets = [credentials.apiToken, basicCredential(credentials)].filter(Boolean);
  const redactSegment = (text: string): string => {
    const spans: Array<[number, number]> = [];
    for (const secret of secrets) {
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) {
        spans.push([at, at + secret.length]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of spans) {
      const last = merged.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    let out = "";
    let cursor = 0;
    for (const [start, end] of merged) {
      out += text.slice(cursor, start) + MARKER;
      cursor = end;
    }
    return out + text.slice(cursor);
  };
  return text => text.split(MARKER).map(redactSegment).join(MARKER);
}

export function createJiraClient(
  site: string,
  credentials: JiraCredentials,
  options: { fetch?: typeof fetch; requestTimeoutMs?: number } = {}
): JiraClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = `${siteBaseUrl(site)}${SEARCH_PATH}`;
  const authorization = `Basic ${basicCredential(credentials)}`;
  const redact = redactor(credentials);

  async function search(body: Record<string, unknown>, signal: AbortSignal): Promise<SearchPage> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
      });
      // The body read shares the request's abort and timeout handling.
      text = await response.text();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw sourceError(
        "source_extension_failed",
        `Jira request failed: ${timeout.aborted ? `no answer within ${timeoutMs / 1000}s` : networkFailureReason(error)}`
      );
    }
    if (!response.ok) throw httpError(response, parseJson(text), site, credentials.email, redact);
    const page = parseJson(text) as SearchPage | null;
    if (!page || !Array.isArray(page.issues)) {
      throw sourceError("source_extension_failed", "Jira request failed: unexpected response", response.status);
    }
    return page;
  }

  return {
    async listKeys(jql, maxKeys, signal) {
      const keys: string[] = [];
      let nextPageToken: string | undefined;
      do {
        const page = await search(
          { jql, fields: ["key"], maxResults: LIST_PAGE_SIZE, ...(nextPageToken ? { nextPageToken } : {}) },
          signal
        );
        for (const issue of page.issues) keys.push(issue.key);
        if (keys.length > maxKeys) throw new ListingLimitError(maxKeys);
        nextPageToken = typeof page.nextPageToken === "string" && page.nextPageToken ? page.nextPageToken : undefined;
      } while (nextPageToken);
      return keys;
    },
    async issuesByKey(keys, limit, signal) {
      if (keys.length === 0 || limit <= 0) return [];
      const page = await search(
        { jql: `key in (${keys.join(",")}) ORDER BY created ASC`, fields: DETAIL_FIELDS, maxResults: limit },
        signal
      );
      return (page.issues as JiraIssue[]).slice(0, limit);
    },
  };
}

interface SearchPage {
  issues: Array<{ key: string }>;
  nextPageToken?: unknown;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function httpError(
  response: Response,
  json: unknown,
  site: string,
  email: string,
  redact: (text: string) => string
) {
  const status = response.status;
  switch (status) {
    case 400: {
      const body = json as { errorMessages?: unknown; errors?: unknown } | null;
      const messages = [
        ...(Array.isArray(body?.errorMessages) ? body.errorMessages : []),
        ...(body?.errors && typeof body.errors === "object" ? Object.values(body.errors) : []),
      ].filter((m): m is string => typeof m === "string");
      // Redact once, before the 300-character bound; nothing re-touches the clipped text.
      const text = (messages.length > 0 ? redact(messages.join(" ")) : "Bad Request").slice(0, 300);
      return sourceError("source_params_invalid", `Jira rejected the JQL: ${text}`, status);
    }
    case 401:
      return sourceError(
        "source_credential_expired",
        `Jira rejected the credentials for ${email}; create a new API token and bind JIRA_API_TOKEN again`,
        status
      );
    case 403:
      return sourceError(
        "source_params_invalid",
        "this Jira account cannot search with this JQL; check project permissions",
        status
      );
    case 404:
      return sourceError("source_params_invalid", `no Jira Cloud site at ${redact(site)}`, status);
    case 429:
      return sourceError("source_rate_limited", "Jira rate limit reached; retry later", status);
    default:
      return sourceError(
        "source_extension_failed",
        `Jira request failed: ${status} ${redact(response.statusText)}`.trim(),
        status
      );
  }
}
