import { ListingLimitError, sourceError } from "./errors.js";
import { siteBaseUrl } from "./params.js";

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

export function createJiraClient(
  site: string,
  credentials: JiraCredentials,
  options: { fetch?: typeof fetch; requestTimeoutMs?: number } = {}
): JiraClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = `${siteBaseUrl(site)}${SEARCH_PATH}`;
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64")}`;

  async function search(body: Record<string, unknown>, signal: AbortSignal): Promise<SearchPage> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw sourceError(
        "source_extension_failed",
        `Jira request failed: ${timedOut ? `no answer within ${timeoutMs / 1000}s` : "network error"}`
      );
    }
    if (!response.ok) throw await httpError(response, site, credentials.email);
    const page = (await response.json().catch(() => null)) as SearchPage | null;
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

async function httpError(response: Response, site: string, email: string) {
  const status = response.status;
  switch (status) {
    case 400: {
      const body = (await response.json().catch(() => null)) as { errorMessages?: unknown; errors?: unknown } | null;
      const messages = [
        ...(Array.isArray(body?.errorMessages) ? body.errorMessages : []),
        ...(body?.errors && typeof body.errors === "object" ? Object.values(body.errors) : []),
      ].filter((m): m is string => typeof m === "string");
      const text = (messages.join(" ") || "Bad Request").slice(0, 300);
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
      return sourceError("source_params_invalid", `no Jira Cloud site at ${site}`, status);
    case 429:
      return sourceError("source_rate_limited", "Jira rate limit reached; retry later", status);
    default:
      return sourceError(
        "source_extension_failed",
        `Jira request failed: ${status} ${response.statusText}`.trim(),
        status
      );
  }
}
