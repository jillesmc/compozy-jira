# Test Specification: Jira issues check-in source

Canonical test contract for the `jira/issues` source. Companion to `_spec.md`. Derived from
`_user_stories.md`, `_spec.md` Part II, and `_dx.md`.

## Strategy

- **Framework**: `bun test` with TypeScript. Fakes sit only at the network boundary: a `JiraClient`
  fake for poll unit tests and an in-process `node:http` server returning `search/jql` JSON for client
  integration tests. The clock is injected.
- **Fixtures**: `test/fixtures/` holds recorded-shape JSON for a keys page, a details page,
  `nextPageToken` chains, and 400/401/403/404/429/503 bodies. The fixtures carry no real data.
- **Execution**: `bun test` locally and in CI (S2). E2E-001 and E2E-002 run against a local CompozyOS
  daemon. E2E-003 is operator-run against real Jira Cloud with real secrets. E2E-004 runs after
  publish.
- **Conventions**: table-driven cases; one behavior per case; names `poll: <behavior>`.

## Coverage Matrix

| Source | Behavior | Unit | Integration | E2E |
| --- | --- | --- | --- | --- |
| US-001.AC-1 | New issue matching JQL is returned | UT-020 | IT-001 | E2E-002 |
| US-001.AC-2 | Old issue moving into JQL is returned | UT-021 | — | E2E-003 |
| US-001.AC-3 | Still-matching edited issue not repeated | UT-022 | — | — |
| US-001.AC-4 | Leave and re-enter reported again | UT-023 | — | — |
| US-001.EC-1 | Trailing ORDER BY ignored | UT-002 | — | — |
| US-001.EC-2 | Invalid JQL → params_invalid with Jira text | — | IT-004 | — |
| US-001.EC-3 | Over capacity → params_invalid, no state | UT-031, UT-032 | — | — |
| US-001.EC-4 | Time-relative JQL handled as match entry | UT-021 (same mechanism) | — | — |
| US-001.EC-5 | Moved issue returned under new key | UT-024 | — | — |
| US-001.EC-6 | Deleted or hidden issue silently drops | UT-025 | — | — |
| US-001.EC-7 | Malformed site rejected | UT-004 | — | E2E-002 |
| US-002.AC-1/2 | Quiet baseline, then only new | UT-026 | — | E2E-002 |
| US-002.EC-1 | Failed first check records nothing | Safety invariant 3; UT-033 | — | — |
| US-002.EC-2 | Empty baseline | UT-027 | — | — |
| US-003.AC-1 | Backfill returns recent matches | UT-028 | IT-002 | E2E-003 |
| US-003.AC-2 | Backfill ignored after baseline | UT-029 | — | — |
| US-003.EC-1 | Bad backfill rejected | UT-005 | — | — |
| US-003.EC-2 | More than max_items → paging with `more` | UT-030 | — | — |
| US-004.AC-1, EC-1 | Default JQL when absent or blank | UT-003 | — | — |
| US-004.AC-2 | README JQL gallery | — | — | Review in S2; each gallery JQL is checked against real Jira in E2E-003 |
| US-005.AC-1/2 | Item key, title, URL, summary, attributes | UT-040 | — | E2E-002 |
| US-005.AC-3 | Oldest-created first | — | IT-003 | — |
| US-005.EC-1 | Long title shortened | UT-041 | — | — |
| US-005.EC-2 | Unassigned or no priority | UT-042 | — | — |
| US-005.EC-3 | Hostile text passed as data | Daemon-owned fencing (`../compozy` heartbeat docs §401-405); UT-040 asserts raw passthrough | — | — |
| US-006.AC-1 | Basic auth; token never in output | UT-050 | IT-005 | — |
| US-006.AC-2, EC-5 | Missing secrets → credential_absent naming the variable | UT-051 | — | E2E-002 |
| US-006.EC-1 | 401 → credential_expired | — | IT-006 | — |
| US-006.EC-2 | 403 → params_invalid | — | IT-007 | — |
| US-006.EC-3 | 429 → rate_limited | — | IT-008 | — |
| US-006.EC-4 | 5xx or timeout → extension_failed | — | IT-009, IT-010 | — |
| US-007.AC-1, EC-1 | Dry run repeatable and non-committing | UT-034 (pure function of inputs) | — | E2E-002 |
| US-008.AC-1, EC-1, EC-2 | JQL/site change → baseline; cosmetic change is not | UT-006, UT-035 | — | — |
| US-009.AC-1 | Install from GitHub lists the source | — | — | E2E-004 |
| US-009.AC-2 | Linux and macOS | — | — | E2E-004 (Linux automated, macOS operator-run) |
| US-009.EC-1 | Node missing → start error | Manual check in S3 | — | — |
| US-009.EC-2 | Daemon too old → install refused | CompozyOS-owned install check; build stamps floor 0.7.0 (UT-060) | — | — |
| Site 404 | Not a Jira site | — | IT-011 | — |
| Poll budget | Whole-poll 25 s abort | UT-036 | — | — |

## Unit Tests

### params (Spec: Core Interfaces → `resolveParams`)

- **UT-001** (happy): `resolveParams({site:"acme.atlassian.net", jql:"project = PLAT"})` → `{site:"acme.atlassian.net", jql:"project = PLAT", backfillMinutes:0}` and a 16-hex fingerprint.
- **UT-002** (happy): `jql:'project = PLAT ORDER BY created DESC'` → `jql:"project = PLAT"`. `jql:'summary ~ "order by x"'` keeps the quoted text intact.
- **UT-003** (boundary): `jql` absent, `""`, or `"   "` → `DEFAULT_JQL`.
- **UT-004** (error): `site` = `https://acme.atlassian.net`, `acme`, or `acme.atlassian.net/jira` → throws `source_params_invalid` with `set with.site to your Jira Cloud host, like your-company.atlassian.net`.
- **UT-005** (error): `backfill` = `yesterday`, `-1h`, `0m`, `721h` → `source_params_invalid` with `backfill must be a duration such as 24h`. `90m` → 90; `24h` → 1440.
- **UT-006** (state): `project = PLAT` and `project  =  PLAT ORDER BY key` give the same fingerprint. `project = OPS` gives a different one, and so does the same JQL with a different site.

### seen-state (Spec: Data Models)

- **UT-031** (boundary): encoding 2,000 keys in one project fits 16,384 bytes. A set that does not fit throws `source_params_invalid` whose message contains the key count and `max_state_bytes=16384`.
- **UT-032** (boundary): `listKeys` guard. With `maxKeys = floor((16384−64)/4)`, a listing over the guard aborts before further pages.
- **UT-037** (happy): round-trip `{PLAT:[1,2,1201], OPS:[7]}` through encode/decode. Numbers stay sorted and unique.
- **UT-038** (state): decode of `null`, `{}`, `{v:2,...}`, or malformed JSON → `null` (baseline).

### poll (Spec: Poll algorithm; fake `JiraClient`)

- **UT-020** (happy): committed `{PLAT:[1,2]}`, current `[PLAT-1,PLAT-2,PLAT-3]` → one item `PLAT-3`; state `{PLAT:[1,2,3]}`; `more:false`.
- **UT-021** (state): committed `{PLAT:[5]}`, current `[PLAT-5, PLAT-1]` (old issue newly matching) → item `PLAT-1`.
- **UT-022** (idempotency): committed `{PLAT:[1,2,3]}`, current the same → 0 items; state unchanged.
- **UT-023** (state): committed `{PLAT:[1,3]}`, current `[PLAT-1]` → state `{PLAT:[1]}`. On the next poll, current `[PLAT-1,PLAT-3]` → item `PLAT-3`.
- **UT-024** (state): committed `{PLAT:[9]}`, current `[OPS-4]` (moved) → item `OPS-4`; state `{OPS:[4]}`.
- **UT-025** (state): `fresh = [PLAT-7]` but the details query returns none → 0 items; PLAT-7 stays out of the state.
- **UT-026** (happy): no state, current has 40 keys, no backfill → 0 items; the state holds all 40 and the fingerprint.
- **UT-027** (boundary): no state, current empty → 0 items; state `{v:1, fp, seen:{}}`.
- **UT-028** (happy): no state, backfill 1440 m, current 33 keys, window list 3 keys → 3 items; the state holds all 33.
- **UT-029** (state): matching fingerprint and backfill set → no window query issued.
- **UT-030** (boundary): 25 fresh keys, `max_items` 20 → 20 items, `more:true`; the 5 left are not in the state. The next poll returns those 5 with `more:false`.
- **UT-033** (error): `listKeys` throws `source_credential_expired` → the poll rejects with the same code; no result object.
- **UT-034** (idempotency): the same request run twice with `dry_run:true` and once with `dry_run:false` → deep-equal results.
- **UT-035** (state): committed fingerprint differs (JQL changed) → baseline behavior as in UT-026.
- **UT-036** (error): a client that never resolves under the 25 s budget (fake timers) → `source_extension_failed` with `Jira listing took too long; narrow the JQL`.

### items (Spec: Business Rule 7)

- **UT-040** (happy): the PLAT-1201 fixture gives exactly the item JSON shown in `_dx.md` Native Tools. Text passes through unescaped.
- **UT-041** (boundary): a 250-character summary gives a title of 200 characters ending in `…`, with no split surrogate pair.
- **UT-042** (boundary): null assignee and absent priority → summary shows `assignee: Unassigned`, priority omitted; attributes `assignee:null`, no `priority` key.

### credentials and build

- **UT-050** (happy): with email `ana@example.com` and token `t0k`, the header is `Basic YW5hQGV4YW1wbGUuY29tOnQwaw==`. No error message ever contains `t0k`, checked across every error path.
- **UT-051** (error): env without `JIRA_API_TOKEN` → `source_credential_absent` naming `JIRA_API_TOKEN` and the secrets command. Neither variable set → the message names both.
- **UT-060** (happy): the generated `extension.toml` has `min_compozy_version = "0.7.0"`, `requires_env = ["JIRA_EMAIL","JIRA_API_TOKEN"]`, `capabilities.provides = ["heartbeat.source"]`, and `subprocess.command = "node"`.

## Integration Tests

### jira-client + poll against the fake HTTP server

- **IT-001**: the fake serves 2 key pages linked by `nextPageToken`, then a details page → `listKeys` returns the union, and the poll returns the new item with its URL built from the site.
- **IT-002**: a baseline with backfill makes 3 requests: the full listing, the window listing with `AND created >= -1440m` in the request body JQL, and the details query.
- **IT-003**: the details request body contains `key in (...) ORDER BY created ASC`. Response order is preserved in the items.
- **IT-004**: 400 with `{"errorMessages":["Field 'sprnt' does not exist..."]}` → `source_params_invalid`, message `Jira rejected the JQL: Field 'sprnt' does not exist...` (≤ 300 chars).
- **IT-005**: every request carries `Authorization: Basic …` and `Accept: application/json`, and uses POST to `/rest/api/3/search/jql`.
- **IT-006**: 401 → `source_credential_expired`, message contains the email and no token.
- **IT-007**: 403 → `source_params_invalid` with the permission wording.
- **IT-008**: 429 → `source_rate_limited`.
- **IT-009**: 503 → `source_extension_failed`, `Jira request failed: 503 Service Unavailable`.
- **IT-010**: the server delays 11 s → per-request timeout → `source_extension_failed`.
- **IT-011**: 404 HTML page → `source_params_invalid`, `no Jira Cloud site at <site>`.

## End-to-End Tests

### Local daemon (US-001, US-002, US-005, US-006, US-007)

- **E2E-001**: `bun run build` → `compozy extension build` → `compozy extension validate ./dist/gen-<hash> -o json` reports no `error` issues and `consent_areas` is empty.
- **E2E-002**:
  1. Install the generation locally, start the fake Jira, and set a test agent's `HEARTBEAT.md`.
  2. Run `compozy agent heartbeat sources` → it lists `jira/issues  New Jira issues  extension jira`.
  3. Dry run before secrets are bound → `source_credential_absent`.
  4. Bind the fake secrets, then dry run → `Would run: no`, `0 items`.
  5. Commit a real check, then add an issue to the fake → the dry run shows `source:my-jira:PLAT-1201  PLAT-1201 Checkout fails on Pix`.
  6. Run the dry run a second time → identical output.
  7. Set `site: acme` → `source_params_invalid`.

### Real Jira Cloud, operator-run (US-001.AC-2, US-003)

- **E2E-003**:
  1. Run the source with the author's own Jira Cloud sign-in, a scratch JQL such as `project = <sandbox> AND labels = compozy-e2e`, and `backfill: 24h` → recent labeled issues are listed.
  2. Add the label to an old issue → the next check returns it.
  3. Run each README gallery JQL once → no `source_params_invalid` (gallery validity).
  4. Record page sizes observed (Known Risk).

### Published release (US-009)

- **E2E-004**: on a clean CompozyOS 0.7.0 profile on Linux, `compozy extension install github:jillesmc/compozy-jira@v0.1.0` → `compozy agent heartbeat sources` lists the source, and a dry run against the fake behaves as in E2E-002. The operator repeats the install and dry run on macOS arm64.
