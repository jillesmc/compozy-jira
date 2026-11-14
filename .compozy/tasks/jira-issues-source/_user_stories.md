# User Stories: Jira issues check-in source

Canonical behavior catalog for the `jira/issues` check-in source. Companion to `_spec.md`; consumed by
`_spec.md` Part II (component mapping) and `_tests.md` (coverage matrix). No UI-bearing surface of its
own: the CompozyOS Heartbeat page renders it generically.

## Personas

- **Operator**: a CompozyOS user who runs an always-on agent and wants it to react when Jira work
  appears for them or their team, without polling Jira by hand or spending model tokens on quiet hours.
- **Agent**: the always-on agent that receives the source's items at check-in and decides what to do
  (propose, notify, open a session). It reads items only; it never writes to Jira through this source.
- **Installer**: anyone who installs the extension from `github:jillesmc/compozy-jira` on Linux or
  macOS, with no access to the author's machine.

## Story Index

| ID     | Feature Area | Persona   | Story                                                                  |
| ------ | ------------ | --------- | ---------------------------------------------------------------------- |
| US-001 | Watch        | Operator  | Declare a Jira source with any JQL and receive issues newly matching it |
| US-002 | Watch        | Operator  | Start watching without being flooded by issues that already match       |
| US-003 | Watch        | Operator  | Catch up on recent matches on the first check (backfill)                |
| US-004 | Watch        | Operator  | Use a sensible example JQL when none is given                           |
| US-005 | Watch        | Agent     | Receive each new issue as a compact, sourced item                       |
| US-006 | Operate      | Operator  | Bind Jira Cloud credentials once and see clear errors when they fail     |
| US-007 | Operate      | Operator  | Try the source without consuming anything (dry run)                     |
| US-008 | Operate      | Operator  | Change the JQL without being flooded                                    |
| US-009 | Distribute   | Installer | Install a published release on Linux or macOS                           |

## Watch

### US-001: Watch any JQL

**As an** operator, **I want** to point the source at any JQL I write, **so that** my agent reacts to
exactly the Jira work I care about (a project, a status, a label, an assignee, a filter).

Acceptance criteria:

- AC-1: Given `with.site: your-company.atlassian.net` and `with.jql: project = PLAT AND statusCategory = "To Do"`,
  when an issue is created in PLAT with status To Do after the first check, then the next check
  returns one item for it.
- AC-2: Given the same source, when an existing PLAT issue that did not match moves into To Do, then
  the next check returns one item for it, even though it was created long ago.
- AC-3: Given an issue that was already returned, when it is edited but still matches, then no later
  check returns it again.
- AC-4: Given an issue that was returned, then stopped matching (moved to In Progress), when it
  matches again (moved back to To Do), then the next check returns it again.

Edge cases:

- EC-1: JQL ends in `ORDER BY ...` → the clause is ignored; matching works the same.
- EC-2: JQL is syntactically invalid or names an unknown field/project → the check fails with
  `source_params_invalid` and Jira's own error text (shortened), and the source status shows it.
- EC-3: JQL matches more issues than the source can track (default limit: see `_spec.md` Business
  Rules) → the check fails with `source_params_invalid` telling the operator to narrow the JQL or
  raise `agents.heartbeat.sources.max_state_bytes`; no items are returned and no state changes.
- EC-4: JQL uses time-relative clauses (`created >= -1d`, `due <= now()`) → an issue entering or
  leaving the window counts as starting or stopping to match.
- EC-5: An issue is moved to another project and gets a new key → it is returned once under its new key.
- EC-6: An issue is deleted or the operator loses permission to see it → it silently stops matching.
- EC-7: `with.site` is missing, is not a host name, or includes a scheme/path → the check fails with
  `source_params_invalid` naming the expected form `your-company.atlassian.net`.

### US-002: Start quietly

**As an** operator, **I want** the first check to record what already matches without reporting it,
**so that** turning the source on does not dump the whole backlog on my agent.

Acceptance criteria:

- AC-1: Given a new source whose JQL already matches 40 issues, when the first check runs, then it
  returns 0 items and `Would run: no`.
- AC-2: Given that first check committed, when one new issue starts to match, then the next check
  returns exactly that one item.

Edge cases:

- EC-1: First check fails (credentials, JQL) → nothing is recorded; the next successful check is
  still the quiet baseline.
- EC-2: JQL matches zero issues on the first check → baseline is empty; the first issue that matches
  later is returned.

### US-003: Backfill

**As an** operator, **I want** an optional `backfill` window, **so that** the first check also
returns matching issues created recently, to test the setup or catch up.

Acceptance criteria:

- AC-1: Given `with.backfill: 24h` and three matching issues created in the last 24 hours plus 30
  older ones, when the first check runs, then it returns the three recent issues and records all 33
  as seen.
- AC-2: Given the baseline already committed, when `backfill` is added later, then it has no effect
  (it only shapes the first check).

Edge cases:

- EC-1: `backfill` is not a duration (`yesterday`, `-1h`) → `source_params_invalid` naming the form `24h`.
- EC-2: More recent matches than one check may return (`limits.max_items`, default 20) → the check
  returns the oldest 20 with `more: true`; the following check returns the rest.

### US-004: Example JQL

**As an** operator, **I want** a working default when I leave `with.jql` out, **so that** I can see
the source work before writing my own query.

Acceptance criteria:

- AC-1: Given a source with only `with.site`, when it runs, then it watches
  `assignee = currentUser() AND resolution = Unresolved` (Jira issues newly assigned to the
  credential's user and still open).
- AC-2: The README lists ready-to-copy JQL examples (new issues in a project, newly in a status, by
  label, unassigned in a team project, saved filter by id).

Edge cases:

- EC-1: `with.jql` is present but blank → treated as missing (default JQL applies).

### US-005: Sourced items

**As an** agent, **I want** each new issue as a compact item with key, title, link, and the fields
needed to triage it, **so that** I can decide without calling Jira first.

Acceptance criteria:

- AC-1: Given a new issue PLAT-1201 "Checkout fails on Pix", when it is returned, then the item key is
  `PLAT-1201`, the title is `PLAT-1201 Checkout fails on Pix`, the URL is
  `https://your-company.atlassian.net/browse/PLAT-1201`, and the summary names type, status,
  priority, assignee, and reporter.
- AC-2: The item attributes carry `project`, `issue_type`, `status`, `status_category`, `priority`,
  `assignee`, `reporter`, `labels`, `created`, and `updated`.
- AC-3: Items are ordered oldest-created first within one check.

Edge cases:

- EC-1: Summary longer than the 200-character title limit → title shortened at a character boundary
  with `…`; the full text stays in `summary` within its 1 KiB limit.
- EC-2: Unassigned issue or no priority field → `Unassigned` / omitted, never `null` text.
- EC-3: Issue text contains instructions ("ignore previous...") → passed as data; the daemon fences
  item text as untrusted input.

## Operate

### US-006: Credentials

**As an** operator, **I want** to bind my Jira Cloud email and API token to the extension once, **so
that** every agent using the source can read Jira as me, and I learn quickly when the token breaks.

Acceptance criteria:

- AC-1: Given `JIRA_EMAIL` and `JIRA_API_TOKEN` bound with `compozy extension secrets set jira --env ...`,
  when a check runs, then it authenticates to Jira Cloud and never prints the token anywhere.
- AC-2: Given neither variable is bound, when a check runs, then it fails with
  `source_credential_absent` and the message names both commands to fix it.

Edge cases:

- EC-1: Jira answers 401 (revoked/expired token, wrong email) → `source_credential_expired`, message
  points to regenerating the API token.
- EC-2: Jira answers 403 for the search → `source_params_invalid` saying the account cannot browse
  the JQL's projects.
- EC-3: Jira answers 429 → `source_rate_limited`; the daemon retries with backoff from the previous state.
- EC-4: Jira unreachable or slower than the request timeout → the check fails, state unchanged, the
  daemon retries.
- EC-5: Only one of the two variables bound → `source_credential_absent` naming the missing one.

### US-007: Dry run

**As an** operator, **I want** **Try it now** (or `compozy agent instance check --dry-run`) to show
what the source would return, **so that** I can tune the JQL safely.

Acceptance criteria:

- AC-1: Given a configured source, when a dry run runs any number of times, then it shows the same
  items each time and the next real check still returns them.

Edge cases:

- EC-1: Dry run on a never-run source → shows the baseline result (0 items, or backfill items).

### US-008: Change the JQL

**As an** operator, **I want** editing the JQL to start a fresh quiet baseline, **so that** widening
a query does not report every newly included old issue.

Acceptance criteria:

- AC-1: Given a running source, when `with.jql` changes, then the next check returns 0 items (except
  backfill, if set) and records the new matches as the baseline.

Edge cases:

- EC-1: Only whitespace or a trailing `ORDER BY` changes → not a JQL change; no new baseline.
- EC-2: `with.site` changes → treated like a JQL change (fresh baseline).

## Distribute

### US-009: Install a release

**As an** installer, **I want** to install the published extension with one command on Linux or
macOS, **so that** I can use the source without building it.

Acceptance criteria:

- AC-1: Given Node.js 22 or newer, when `compozy extension install github:jillesmc/compozy-jira@v0.1.0`
  runs, then `compozy agent heartbeat sources <agent>` lists `jira/issues  New Jira issues  extension jira`.
- AC-2: The same release artifact installs and polls on Linux x86-64 and macOS arm64.

Edge cases:

- EC-1: Node.js missing or older than 22 → the extension fails to start and `compozy extension status jira`
  shows the start error; the README states the requirement.
- EC-2: Daemon older than the extension's compatibility floor → install refuses with the daemon's
  version error.
