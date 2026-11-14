import type { HeartbeatSourceItem, JSONValue } from "@compozy/extension-sdk";

import type { JiraIssue } from "./jira-client.js";
import { siteBaseUrl } from "./params.js";

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_BYTES = 1024;
const MAX_ATTRIBUTES_BYTES = 2048;
const MAX_ATTRIBUTE_CHARS = 100;

export function toItem(issue: JiraIssue, site: string): HeartbeatSourceItem {
  const f = issue.fields;
  const created = isoUtc(f.created);
  const summaryParts = [
    f.issuetype?.name,
    f.status?.name,
    f.priority?.name,
    `assignee: ${f.assignee?.displayName ?? "Unassigned"}`,
    f.reporter?.displayName ? `reporter: ${f.reporter.displayName}` : undefined,
    `created ${created.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}).*Z$/, "$1 $2 UTC")}`,
  ].filter((part): part is string => Boolean(part));
  const labels = [...(f.labels ?? [])];
  // Trailing labels go first, then every string value is clipped harder until the encoded
  // attributes fit the daemon's 2 KiB (multibyte text and JSON escapes included).
  const buildAttributes = (maxChars: number): Record<string, JSONValue> => {
    const clip = (value: string | undefined | null) =>
      value === undefined || value === null ? null : truncateChars(value, maxChars);
    return {
      project: clip(f.project?.key ?? issue.key.split("-")[0]),
      issue_type: clip(f.issuetype?.name),
      status: clip(f.status?.name),
      status_category: clip(f.status?.statusCategory?.name),
      ...(f.priority?.name ? { priority: clip(f.priority.name) } : {}),
      assignee: clip(f.assignee?.displayName),
      reporter: clip(f.reporter?.displayName),
      labels,
      created: clip(created),
      updated: clip(isoUtc(f.updated)),
    };
  };
  const fits = (value: Record<string, JSONValue>) =>
    byteLength(JSON.stringify(value)) <= MAX_ATTRIBUTES_BYTES;
  let maxChars = MAX_ATTRIBUTE_CHARS;
  let attributes = buildAttributes(maxChars);
  while (labels.length > 0 && !fits(attributes)) labels.pop();
  while (maxChars > 1 && !fits(attributes)) {
    maxChars = Math.max(1, maxChars - 10);
    attributes = buildAttributes(maxChars);
  }
  const issueText = `${issue.key} ${f.summary ?? ""}`.trim();
  const title = truncateChars(issueText, MAX_TITLE_CHARS);
  const meta = summaryParts.join(" · ");
  // A shortened title keeps the full issue text in summary (D-5).
  const summary = title === issueText ? meta : `${meta}\n${f.summary}`;
  return {
    key: issue.key,
    title,
    summary: truncateBytes(summary, MAX_SUMMARY_BYTES),
    url: `${siteBaseUrl(site)}/browse/${issue.key}`,
    attributes,
  };
}

/** Jira timestamps look like 2026-11-14T06:12:44.000-0300; render them as UTC ISO strings. */
function isoUtc(value: string | undefined): string {
  if (!value) return "";
  const parsed = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function truncateBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (byteLength(`${out}${ch}…`) > max) break;
    out += ch;
  }
  return `${out}…`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
