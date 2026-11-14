import { createHash } from "node:crypto";

import { sourceError } from "./errors.js";

export interface JiraSourceParams {
  site: string; // host only, e.g. "your-company.atlassian.net", or 127.0.0.1:<port> / localhost:<port>
  jql: string; // normalized, never empty
  backfillMinutes: number; // 0 = none
  fingerprint: string; // 16 hex chars of sha256(site + "\n" + jql)
}

export const DEFAULT_JQL = "assignee = currentUser() AND resolution = Unresolved";
export const SITE_PATTERN =
  "^([A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+|(127\\.0\\.0\\.1|localhost):[0-9]{1,5})$";
const SITE_RE = new RegExp(SITE_PATTERN);
const LOOPBACK_RE = /^(127\.0\.0\.1|localhost):[0-9]{1,5}$/;
const BACKFILL_RE = /^([0-9]+)(m|h)$/;
const MAX_BACKFILL_MINUTES = 720 * 60;

export const PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["site"],
  properties: {
    site: { type: "string", pattern: SITE_PATTERN, maxLength: 253 },
    jql: { type: "string", maxLength: 4000 },
    backfill: { type: "string", pattern: "^[0-9]+(m|h)$" },
  },
};

/** Loopback sites (local testing aid, Deviation D-1) use plain http; every other site https. */
export function siteBaseUrl(site: string): string {
  return `${LOOPBACK_RE.test(site) ? "http" : "https"}://${site}`;
}

export function resolveParams(raw: unknown): JiraSourceParams {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const site = obj.site;
  if (typeof site !== "string" || site.length > 253 || !SITE_RE.test(site)) {
    throw sourceError(
      "source_params_invalid",
      "set with.site to your Jira Cloud host, like your-company.atlassian.net"
    );
  }
  const jql = normalizeJql(typeof obj.jql === "string" ? obj.jql : "");
  const backfillMinutes = parseBackfill(obj.backfill);
  const fingerprint = createHash("sha256").update(`${site}\n${jql}`).digest("hex").slice(0, 16);
  return { site, jql, backfillMinutes, fingerprint };
}

function parseBackfill(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const match = typeof raw === "string" ? BACKFILL_RE.exec(raw) : null;
  const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : 0;
  if (minutes < 1 || minutes > MAX_BACKFILL_MINUTES) {
    throw sourceError("source_params_invalid", "backfill must be a duration such as 24h");
  }
  return minutes;
}

/**
 * Trims, collapses whitespace runs outside quoted strings, and drops the ORDER BY clause found
 * outside quoted strings. Blank input becomes DEFAULT_JQL.
 */
export function normalizeJql(raw: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < raw.length) out += raw[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (/\s/.test(ch)) {
      if (!out.endsWith(" ")) out += " ";
    } else if (/^order\s+by\b/i.test(raw.slice(i)) && (out === "" || out.endsWith(" ") || out.endsWith(")"))) {
      break;
    } else {
      out += ch;
    }
  }
  const jql = out.trim();
  return jql === "" ? DEFAULT_JQL : jql;
}
