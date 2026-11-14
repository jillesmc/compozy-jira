# Jira issues check-in source (`jira/issues`)

Status: draft for review · 2026-11-14 (revised for CompozyOS 0.7.0) · Target repo:
`github.com/jillesmc/compozy-jira` (new) · Host product: CompozyOS ≥ 0.7.0

Revision 2026-11-14: CompozyOS 0.7.0 shipped. The source contract surfaces this spec depends on
(`heartbeat/source_poll`, the TS SDK, the scaffold templates, the source limits/defaults, the build
toolchain, and the forge-github reference) did not change between the analyzed commit `9f36865b2`
and `v0.7.0`. The only heartbeat changes are in the wake service (dry-run snapshot reuse, per-cycle
wake quota) and do not affect sources. The SDK is pinned to 0.7.0 (user decision).

# Part I — Product

## Overview

- **Motivating Problem**: CompozyOS always-on agents can watch GitHub for new issues through the
  bundled `forge-github/issues` check-in source, but nothing does the same for Jira. Today an
  operator who lives in Jira has to poll it by hand, write a one-off approved script, or let the
  agent spend model turns asking Jira on every check-in. The simplest end-to-end outcome: install one
  extension, bind a Jira Cloud token, add a source with any JQL to `HEARTBEAT.md`, and the agent's
  next check-in receives exactly the issues that newly match that JQL. A quiet check costs no model turn.
- **Who it is for**: CompozyOS operators whose work is tracked in Jira Cloud (first user: the author), and the always-on agents they run.
- **Why it is valuable**: it gives Jira the same cheap, pre-model change detection GitHub already has.
  The JQL stays free-form, so one source covers "new in my project", "newly assigned to me", "newly
  ready for dev", saved filters, and more.

## Goals

- An operator can declare any JQL as a check-in source and receive each issue when it starts
  matching that JQL, including old issues that move into it.
- Turning the source on, or changing its JQL, never floods the agent with the existing backlog.
- A check with no new matching issue triggers no model turn (the daemon's existing skip).
- Credential, permission, JQL, and rate-limit failures are visible as deterministic source error
  codes in CLI, native tools, and the Heartbeat page, and leave the source's state untouched.
- Anyone on Linux or macOS with Node.js 22+ can install a published release with one command.

## User Stories

- US-001–US-005: watching (any JQL, quiet start, backfill, example JQL, item shape).
- US-006–US-008: operating (credentials and errors, dry run, changing the JQL).
- US-009: distribution (install a release on Linux or macOS).

[Full user stories](_user_stories.md)

## Core Features

1. **`jira/issues` source kind.** It is registered by the `jira` extension. Parameters: `site`
   (required), `jql` (optional, has a default), and `backfill` (optional). Each check returns the
   issues that match the JQL now and were not part of the previous committed match set.
2. **Quiet baseline.** The first check, and the first check after `site` or `jql` changes, records
   the current match set and returns nothing. If `backfill` is set, it returns matches created within
   that window.
3. **Sourced items.** Each item has a stable key, a title, a browse URL, a one-line triage summary,
   and structured attributes (see `_dx.md` Native Tools).
4. **Credential binding.** The extension declares `JIRA_EMAIL` and `JIRA_API_TOKEN`. The operator
   binds them with `compozy extension secrets set jira --env ...`. No other credential path exists.
5. **Distribution.** The extension is TypeScript bundled into one JavaScript file that runs on Node.js
   22+. It is published as a GitHub Release on `jillesmc/compozy-jira`.

The features combine as follows. Feature 4 gates every Jira call. Features 1 and 2 share one
matching algorithm (ADR-001). Feature 3 shapes what features 1 and 2 return.

## Business Rules

1. **New means newly matching.** An issue is returned when it is in the JQL's current result set
   and not in the committed set from the previous successful check (ADR-001). Edits to an issue that
   keeps matching never return it again. An issue that stops matching and matches again is returned
   again.
2. **Baseline.** When there is no committed state, or the committed fingerprint differs from the
   current `site` + normalized `jql`, the check is a baseline. It commits the current match set and
   returns only backfill matches. The fingerprint is the first 16 hex characters of SHA-256 of
   `site + "\n" + normalizedJql`.
3. **JQL normalization.** Normalization trims surrounding whitespace, collapses internal whitespace
   runs to one space outside quoted strings, and removes a trailing `ORDER BY ...` clause found
   outside quoted strings. A blank or absent `jql` becomes
   `assignee = currentUser() AND resolution = Unresolved`.
4. **Backfill.** `backfill` is a Go-style duration with units `m` or `h` (regex
   `^[0-9]+(m|h)$`), from 1 minute to 720 hours. It only applies to a baseline check. During that
   check, matches whose `created` falls within the window are left out of the committed set, so they
   come back as new.
5. **Per-check volume.** At most `limits.max_items` items per check (daemon default 20), oldest
   `created` first. Unreturned new issues stay out of the committed set, so the next check returns
   them, and the result sets `more: true`.
6. **Tracking capacity.** The committed set must encode within `limits.max_state_bytes` (daemon
   default 16,384 bytes, configurable 1 KiB–256 KiB through `agents.heartbeat.sources.max_state_bytes`).
   At the default this is roughly 2,500 issue keys. If the current match set does not fit, the check
   fails with `source_params_invalid` and reports the count and the limit. It never truncates
   silently.
7. **Item identity.** The item key is the Jira issue key (`PLAT-1201`). The title is
   `<key> <summary>`, shortened to 200 Unicode characters with a trailing `…` when longer. The URL is
   `https://<site>/browse/<key>`. The summary stays within 1 KiB.
8. **Read-only.** The extension only calls Jira's read endpoints (search and current user). It never
   creates, edits, transitions, or comments.
9. **Secrets.** `JIRA_API_TOKEN` never appears in items, errors, logs, or state. `JIRA_EMAIL` may
   appear in a 401 message only.
10. **State commit is daemon-owned.** The extension returns the next state on every successful
    poll. The daemon commits it only after a successful check and never commits on a dry run or a
    failure (existing CompozyOS rule).

## User Experience

- **Personas**: operator, agent, installer (`_user_stories.md`).
- **First use**:
  1. Install the release.
  2. Bind the two secrets.
  3. Add a source on the agent's Heartbeat page (or in `HEARTBEAT.md`), using **Try it now** to see a
     0-item baseline.
  4. Optionally set `backfill: 24h` to see real items, then turn checks on.
- **Regular use**: the agent checks in on its cadence. Quiet checks show "All quiet", and new matching
  issues reach the agent as items it can act on.
- **Discoverability**: the source appears as *New Jira issues* in **Add a source → From extensions**
  and in `compozy agent heartbeat sources`. The README carries the setup transcript and a JQL example
  gallery.
- **Accessibility**: no new UI. The CompozyOS Heartbeat page renders the source generically from its
  title and params schema.

## High-Level Technical Constraints

- Jira Cloud REST API v3 only, authenticated with email + API token (HTTP Basic). The legacy
  `/rest/api/3/search` is removed; use `/rest/api/3/search/jql` with `nextPageToken` pagination.
- Each poll must finish well inside the daemon's source deadline (`agents.heartbeat.sources.timeout`,
  default 30 s).
- Runs as a CompozyOS extension subprocess under the marketplace permission tier. It needs no host API
  grants (`permissions.requires: []`).
- Agent/operator manageability: everything is operable through existing CLI verbs and native tools
  (`_dx.md`). There is no UI-only control.
- Extension ecosystem: this is itself a third-party extension built on the public
  `@compozy/extension-sdk`. It needs no CompozyOS core change.

## Non-Goals (Out of Scope)

- **Jira Data Center/Server and PAT authentication.** The user chose Cloud only (Q2). This becomes a
  follow-up spec if needed.
- **Writing to Jira** (comments, transitions, assignment). Agents can pair this source with the
  existing curated `atlassian` marketplace package, Atlassian's hosted MCP server, to act on items.
- **Watching updates or comments on issues that already matched.** This source reports entry into
  the JQL, not change activity.
- **A Go implementation and per-platform binaries.** The user chose TypeScript for portability (Q3).
- **Bundling into CompozyOS** or enabling by default. Distribution is a personal GitHub release.
  Listing in the curated catalog is requested later through an issue (slice S4).

## Open Questions

- Resolved 2026-11-14: license MIT (Q4); the spec is versioned in the public repository with neutral examples (Q5).
- Should S4 (the catalog listing request) also propose a small example `HEARTBEAT.md` for the docs
  site guide? This is decided at S4 time.

---

# Part II — Technical

## Executive Summary

The extension is a single TypeScript module built with `@compozy/extension-sdk` 0.7.0. It registers
the `jira/issues` check-in source through `extension.heartbeatSource()`. The CompozyOS build bundles
it with `bun build --target=node` into `dist/index.js`, and the subprocess runs on Node.js 22+. Each
poll does the following:

1. Resolves parameters and credentials.
2. Lists every issue key that matches the normalized JQL through `POST /rest/api/3/search/jql`, with
   only the `key` field, following `nextPageToken`.
3. Computes `new = current − committedSeen`.
4. Fetches details for the oldest `max_items` new issues with a second search.
5. Returns items plus the next state, `seen = (committedSeen ∩ current) ∪ returned`.

The state is a compact per-project map of issue numbers. Diffing full key sets (ADR-001) makes
"newly matching" exact for any JQL, including status moves and time-relative clauses. It avoids
timezone and minute-precision traps that come with timestamp watermarks, at the cost of listing the
match set each poll and a capacity bound. TypeScript (ADR-002) makes one artifact run on Linux and macOS.

## MVP Boundary

The MVP is S1 + S2 + S3. S1 is a working source installed locally from the built generation. It
solves the Motivating Problem on the author's machine against real Jira. S2 adds the README, the JQL
gallery, and CI. S3 publishes v0.1.0 and verifies `install github:jillesmc/compozy-jira@v0.1.0`. S4
(the curated catalog request) comes after the MVP. Data Center, write actions, and update watching
are out of scope.

## Developer Experience

- [Developer experience contract](_dx.md) covers the `HEARTBEAT.md` source block and parameters, the
  secrets, the existing CLI verbs and native tools as they apply, the item shape, the error codes and
  messages, and the README JQL gallery.
- No `_uiux.md`: the work has no UI of its own (the Heartbeat page renders it generically).

## System Architecture

```text
CompozyOS daemon ──heartbeat/source_poll (JSON-RPC stdio)──▶ jira extension (node dist/index.js)
   │  validates `with` against params_schema                     │
   │  owns state commit, dry run, limits, retries                │ HTTPS, Basic auth
   ◀──────────── {items, state, more} or RPC error {code} ───────┤
                                                                 ▼
                                                   https://<site>/rest/api/3/search/jql
```

| Component | Responsibility | Boundary |
| --- | --- | --- |
| `src/index.ts` | Extension definition, source registration, entry point | Only module that touches the SDK `Extension` |
| `src/params.ts` | Resolve and validate `site`, `jql`, `backfill`; JQL normalization; fingerprint | Pure |
| `src/jira-client.ts` | Basic auth, `search/jql` listing and detail queries, timeouts, HTTP → error-code mapping | Only module doing network I/O (injectable `fetch`) |
| `src/seen-state.ts` | Encode/decode/fit-check the compact state; set algebra | Pure |
| `src/poll.ts` | The poll algorithm (baseline, backfill, diff, paging, `more`) | Composes the above; no SDK or network imports beyond injected client |
| `src/items.ts` | Jira issue → `HeartbeatSourceItem` (title, summary, attributes, URL) | Pure |
| `src/errors.ts` | `sourceError(code, message)` → SDK `RPCError(-32000, message, {code})` | Pure |

## Architectural Boundaries

- Only `src/index.ts` imports `@compozy/extension-sdk`'s `Extension`. Other modules may import SDK
  *types* only.
- Only `src/jira-client.ts` performs network I/O. It receives `fetch` and a clock, so tests inject
  fakes.
- No module reads `process.env` except `src/index.ts`, which passes credentials down explicitly.
- No dependency besides `@compozy/extension-sdk` at runtime; Node built-ins only (`node:crypto`).

## Implementation Design

### Core Interfaces

```ts
// src/params.ts
export interface JiraSourceParams {
  site: string; // host only, e.g. "your-company.atlassian.net"
  jql: string; // normalized, never empty
  backfillMinutes: number; // 0 = none
  fingerprint: string; // 16 hex chars of sha256(site + "\n" + jql)
}
export const DEFAULT_JQL = "assignee = currentUser() AND resolution = Unresolved";
export function resolveParams(raw: unknown): JiraSourceParams; // throws source_params_invalid

// src/jira-client.ts
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
export function createJiraClient(
  site: string,
  credentials: JiraCredentials,
  options?: { fetch?: typeof fetch; requestTimeoutMs?: number }
): JiraClient;

// src/seen-state.ts
export interface SeenStateV1 {
  v: 1;
  fp: string; // params fingerprint the set belongs to
  seen: Record<string, number[]>; // project key -> sorted unique issue numbers
}
export function decodeState(raw: unknown): SeenStateV1 | null; // null => baseline
export function encodeState(state: SeenStateV1, maxBytes: number): SeenStateV1; // throws capacity error

// src/poll.ts
export function pollJiraIssues(
  request: HeartbeatSourceRequest,
  deps: { client: JiraClient; params: JiraSourceParams }
): Promise<HeartbeatSourceResult>;
```

### Poll algorithm (`pollJiraIssues`)

1. `committed = decodeState(request.state)`. `baseline = committed === null || committed.fp !== params.fp`.
2. `maxKeys = floor((limits.max_state_bytes − 64) / 4)` is the listing guard. The exact check is
   step 7.
3. `current = client.listKeys(params.jql, maxKeys)`. The request is `POST /rest/api/3/search/jql`
   with body `{jql, fields:["key"], maxResults: 5000, nextPageToken}`, looping until there is no
   `nextPageToken`.
4. When `baseline`:
   - `window = backfillMinutes > 0 ? listKeys("(" + jql + ") AND created >= -" + backfillMinutes + "m", maxKeys) : []`.
   - `seen0 = current − window`.

   Otherwise, `seen0 = committed.seen ∩ current`.
5. `fresh = current − seen0`. When `fresh` is empty, return `{items: [], state: encode(seen0)}`.
6. `candidates = fresh` sorted by project key, then issue number, first 200. The detail query is
   `issuesByKey(candidates, limits.max_items)`, which runs
   `key in (<candidates>) ORDER BY created ASC` with the fields of `JiraIssue`.
7. `returned = details.map(key)`. The next state is `encode({v:1, fp, seen: seen0 ∪ returned}, max_state_bytes)`.
   It throws `source_params_invalid` (capacity) when the encoding exceeds the limit.
8. `more = fresh.length > returned.length`.
9. Return `{items: details.map(toItem), state, more}`.

Issues in `fresh` that are missing from `details` (deleted or permission lost between the two
queries) stay out of `seen`. If they still match later, they are retried.

### Data Models

State: opaque to the daemon, at most `max_state_bytes` UTF-8 bytes once JSON-encoded:

- `v NUMBER (1)`: state schema version. An unknown version decodes as `null`, which makes a quiet
  baseline.
- `fp STRING(16)`: the params fingerprint (Business Rule 2).
- `seen OBJECT<projectKey, NUMBER[]>`: sorted, unique issue numbers per project key. Jira keys parse
  as `^([A-Z][A-Z0-9_]*)-([0-9]+)$`. A key that does not parse is kept under the `"_"` bucket as a
  raw string (`seen["_"]` is `string[]`), which is defensive and not expected in Cloud.

Params schema (sent as `params_schema`; the daemon validates it before calling the extension):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["site"],
  "properties": {
    "site": { "type": "string", "pattern": "^([A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+|(127\\.0\\.0\\.1|localhost):[0-9]{1,5})$", "maxLength": 253 },
    "jql": { "type": "string", "maxLength": 4000 },
    "backfill": { "type": "string", "pattern": "^[0-9]+(m|h)$" }
  }
}
```

### API Endpoints

None exposed. Consumed Jira endpoints: see Integration Points.

## Integration Points

| Service | Purpose | Auth | Errors and retry |
| --- | --- | --- | --- |
| Jira Cloud `POST /rest/api/3/search/jql` | Key listing and detail query | `Authorization: Basic base64(email:apiToken)`, `Accept: application/json` | The mapping is below. No in-extension retries: the daemon retries the whole poll from the committed state with backoff. |

HTTP mapping (`src/jira-client.ts`):

| Response | Source error |
| --- | --- |
| 400 | `source_params_invalid`, `Jira rejected the JQL: <errorMessages joined, ≤ 300 chars>` |
| 401 | `source_credential_expired` |
| 403 | `source_params_invalid` (permission wording from `_dx.md`) |
| 404 for a site that does not host Jira | `source_params_invalid`, `no Jira Cloud site at <site>` |
| 429 | `source_rate_limited` |
| 5xx, network error, or per-request timeout (10 s) | `source_extension_failed`, `Jira request failed: …` |

The extension also keeps a whole-poll budget of 25 s, which is below the daemon's 30 s default. When
it is exceeded, the poll aborts with `source_extension_failed` and the message
`Jira listing took too long; narrow the JQL`.

## Impact Analysis

| Component | Impact Type | Description and Risk | Required Action |
| --- | --- | --- | --- |
| `jillesmc/compozy-jira` repository | new | New public repo with source, tests, CI, README. Low risk. | Create in S3 |
| `jira` extension / `jira/issues` kind | new public surface (experimental, 0.x) | Parameters, item shape, and state v1 are new. Low risk; no existing users. | Document in README; any future state change bumps `v` and re-baselines quietly |
| CompozyOS core | unaffected | Uses only existing extension, secrets, and Heartbeat surfaces | None |
| CompozyOS curated catalog | possibly modified later | Listing request via issue (S4); maintainers own the catalog | S4 issue only |

Compatibility policy for this extension (0.x, marked experimental in the README):

- Parameter names and meanings stay stable within 0.x. A rename keeps the old key accepted for one
  minor release with a deprecation note in the release notes.
- A state shape change bumps `v`. An older or unknown `v` re-baselines quietly. This loses at most
  one check's worth of "new" signal and never floods the agent.
- No CompozyOS user state is touched.

## Extensibility Integration Plan

- Adds one extension manifest (generated by `compozy extension build` from the SDK definition):
  `capabilities.provides = ["heartbeat.source"]`, `requires_env = ["JIRA_EMAIL","JIRA_API_TOKEN"]`,
  `permissions.requires = []`, `subprocess.command = "node"`, `args = ["index.js"]`.
- Checked and unaffected: hooks (none subscribed), tools/MCP (none), skills (none shipped), profiles
  (none), command palette (none).

## Agent Manageability Plan

The existing surfaces are sufficient (`_dx.md` CLI and Native Tools):

- `compozy extension install|status|update|secrets set`;
- `compozy agent heartbeat sources|validate|write|inspect`;
- `compozy agent instance check --dry-run|show|checks on`;
- the native tools `compozy__agent_heartbeat_sources`, `compozy__agent_instance_check`, and
  `compozy__agent_instance_get`.

Errors are deterministic codes (`_dx.md` Errors).

## Config Lifecycle

No CompozyOS config keys are added. The existing `[agents.heartbeat.sources]` keys apply: `max_items`
(items per check), `max_state_bytes` (tracking capacity), and `timeout` (poll deadline). The README
documents how each affects this source.

## Testing Approach

- The test framework is `bun test`, the same toolchain the CompozyOS TS template builds with. A fake
  Jira is an in-process `node:http` server returning recorded `search/jql` shapes, with fakes only at
  the network boundary. The clock is injected.
- Unit tests cover the pure modules (params, seen-state, items, poll with a fake `JiraClient`).
- Integration tests cover `jira-client` plus `poll` against the fake HTTP server (auth header,
  pagination, error mapping, timeouts).
- E2E runs through the public surface. The local daemon installs the built generation, and dry runs
  go against the fake Jira, through a `site` pointing to `127.0.0.1:<port>`, which uses plain http (Deviation D-1). One operator-run journey goes against real Jira Cloud.

## Development Sequencing

### Build Order

1. Params, seen-state, and items: pure, unit-tested.
2. Jira client: fake-server integration tests.
3. Poll and entry point: build with `compozy extension build`, validate, install locally, then dry-run
   E2E. S1 ends here.
4. README, examples, and CI. This is S2.
5. Public repository, release publish, and install-from-GitHub verification. This is S3.
6. The curated-catalog issue on `compozy/compozy`. This is S4 and needs user approval to post.

### Technical Dependencies

- Node.js ≥ 22 and Bun on the build machine. The `compozy` CLI is 0.7.0+.
- A Jira Cloud account and API token for the operator-run journey.
- `gh` authenticated as `jillesmc` for repository creation and `compozy extension publish`
  (`GITHUB_TOKEN` with repo scope).

## Monitoring and Observability

- The daemon already records per-source status, `last_error`, poll duration
  (`heartbeat_source_poll_duration_ms`), and counts (`heartbeat_source_polls_total`).
- The extension writes one stderr line per failed poll with the code and HTTP status. It never logs
  tokens, JQL results, or issue text, and `compozy extension logs jira` surfaces those lines.

## Technical Considerations

### Key Decisions

- **Full key-set diff over timestamp watermarks**: ADR-001.
- **TypeScript on Node.js over Go binaries**: ADR-002.
- **Two-query poll (keys, then details).** The keys-only listing keeps per-poll cost low for large
  match sets. Details are fetched only for at most 200 candidates and return at most `max_items`.
- **SDK pinned to 0.7.0, the compatibility floor.** The build stamps `min_compozy_version` from the
  SDK version, so the extension requires CompozyOS 0.7.0 or newer. Older daemons are deliberately
  unsupported (user decision, 2026-11-14): there is one supported baseline, matching the author's
  daemon, and no 0.6.x compatibility testing.

### Known Risks

- **`search/jql` page-size limits are not verified.** The poll requests `maxResults: 5000` for
  keys-only. If Jira caps lower, pagination still works but costs more requests. S1 measures this
  against real Jira and adjusts the listing guard if needed.
- **Large match sets and latency.** A broad JQL near the capacity limit may approach the 25 s
  budget. The poll fails clearly instead of hanging (EC in US-001), and the README recommends narrow
  JQL.
- **Detail-query JQL length.** `key in (...)` holds at most 200 keys. If Jira rejects long JQL, S1
  lowers the cap.
- **Ordering across checks.** When more than 200 issues are new at once, items within each check are
  oldest-created first, but the order across checks is only approximate.

## Safety Invariants

1. The extension keeps no state between polls. All continuity lives in the returned `state`, which
   the daemon commits.
2. The returned state never contains a key that has not been returned as an item, except keys
   committed at baseline.
3. A failed poll returns an error and no partial items or state.
4. A dry run and a real run with the same inputs return identical results. The extension ignores
   `dry_run`.
5. No Jira write endpoint is ever called.

## File References

### Repo Files (CompozyOS checkout at `../compozy`)

- `extensions/forge/github/issues.go:17-140`: the GitHub source this mirrors. Shows params schema,
  error codes, baseline/backfill handling, and `more`.
- `sdk/typescript/src/heartbeat-source.ts:1-70`: TS SDK request/item/result types and registration.
- `sdk/typescript/src/extension.ts:210-230`: `extension.heartbeatSource()` signature.
- `sdk/typescript/src/errors.ts:33-40`: `RPCError(code, message, data)` used for `{code}` errors.
- `internal/extension/heartbeat_source.go:112-177`: the daemon validates params against the schema,
  maps RPC `data.code` and `source_timeout`.
- `internal/config/config_heartbeat_sources.go:21-32`: defaults (timeout 30 s, max_items 20,
  max_state_bytes 16,384).
- `internal/extension/scaffold_templates/tool-provider-ts/`: the TS project skeleton (package.json
  build script, entry-point guard).
- `packages/site/content/docs/agents/heartbeat.mdx:401-409`: item constraints (key regex, title 200
  chars, summary 1 KiB, attributes 2 KiB) and state-commit rules.
- `packages/site/content/docs/extensions/publish.mdx`: build, validate, and publish to GitHub
  Releases, plus the marketplace permission ceiling.
- `packages/site/content/docs/guides/watch-new-github-issues.mdx`: the user-facing flow the README
  mirrors.
- `catalog/packages/atlassian/extension.toml`: the existing curated Atlassian MCP package, which the
  README recommends for write actions.

### External References

- Jira Cloud REST v3 issue search (`/rest/api/3/search/jql`, `nextPageToken`):
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/. This is cited
  by URL; nothing is vendored.

## Assumptions and Defaults

- Default JQL: `assignee = currentUser() AND resolution = Unresolved`.
- Defaults: per-request timeout 10 s; whole-poll budget 25 s; detail-candidate cap 200; listing page
  `maxResults` 5000.
- State capacity is about 2,500 keys at 16 KiB (bounded by step 7's exact encode check).
- Node.js ≥ 22 at runtime; `@compozy/extension-sdk` pinned to `0.7.0` (floor CompozyOS 0.7.0).
- ~~`JIRA_BASE_URL` (test-only, undocumented)~~: superseded by Deviation D-1. Undeclared env does not
  reach the extension subprocess, so a loopback `site` with an explicit port targets the fake Jira.
- Local install of a built generation uses `compozy extension install ./dist/gen-<hash>` (S1 confirms
  the exact verb; `compozy extension dev` is the fallback).
- License: MIT (user decision Q4). This spec is committed to the repository (Q5).
- Extension name `jira`, kind `issues`, repository `jillesmc/compozy-jira`, first tag `v0.1.0`.

## Architecture Decision Records

- [ADR-001: Detect "newly matching" by diffing full key sets](adrs/adr-001.md). Exact for any JQL,
  bounded by state capacity.
- [ADR-002: TypeScript on Node.js for portability](adrs/adr-002.md). One artifact for Linux and macOS.

## Deviations

- **D-1 (2026-11-14, conductor, recorded before S1 coding): a loopback `site` replaces `JIRA_BASE_URL`.**
  CompozyOS 0.7.0 builds the extension subprocess environment from a fixed allowlist (`PATH`, `HOME`,
  `USER`, `TMPDIR`, `LANG`, and similar; `internal/extension/manager.go` `safeSubprocessEnvKeys`),
  the manifest's subprocess env table, and bound `requires_env` secrets. Binding an undeclared
  variable is refused (`ErrExtensionEnvBindingUndeclared`). So an undeclared `JIRA_BASE_URL` never
  reaches the extension. A localhost TLS fake would need `NODE_EXTRA_CA_CERTS`, which is filtered
  the same way.
  Change: `site` also accepts `127.0.0.1:<port>` or `localhost:<port>` (loopback with an explicit
  port; see the params schema). Such a site uses `http://<site>` as the API base URL and in item
  URLs. Every other site uses `https://<site>`. The extension reads no `JIRA_BASE_URL`. The UT-004
  rejections (`https://acme.atlassian.net`, `acme`, `acme.atlassian.net/jira`) stay the same, and a
  non-loopback host with a port is still rejected. The README mentions the loopback form only as a
  local testing aid. This keeps E2E-002 and E2E-004 runnable against the published artifact without
  a daemon restart or config change.

- **D-2 (2026-11-14, found in S1): the build does not stamp the 0.7.0 floor from the SDK version.**
  TS SDK 0.7.0 hardcodes `SDK_MIN_COMPOZY_VERSION = "0.3.0-beta.1"`
  (`sdk/typescript/src/extension-contract.ts:24`), and `compozy extension build` copies the describe
  payload's floor into `extension.toml` (`internal/extension/build_describe.go:54`). To keep the
  user's 0.7.0 floor decision, `src/index.ts` overrides `describe()` and sets
  `min_compozy_version = "0.7.0"` explicitly (UT-060 asserts the generated manifest). The build also
  sorts `requires_env`, so the manifest lists `["JIRA_API_TOKEN", "JIRA_EMAIL"]`; UT-060 compares the
  set, not the order. UT-060's real-build case is skipped when the `compozy` CLI is absent (CI); the
  describe-payload case always runs.
