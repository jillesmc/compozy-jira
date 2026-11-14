# compozy-jira

> **Experimental (0.x).** See [Compatibility](#compatibility).

A [CompozyOS](https://github.com/compozy/compozy) extension named `jira` that adds the
**New Jira issues** check-in source (`jira/issues`). An always-on agent declares any JQL in its
`HEARTBEAT.md`, and each check-in receives exactly the Jira Cloud issues that newly match that JQL
since the previous check. A quiet check costs no model turn. The source is read-only: it never
creates, edits, transitions, or comments on issues.

## Requirements

- CompozyOS 0.7.0 or newer. Older daemons refuse the install with a version error.
- Node.js 22 or newer on the daemon's `PATH`. The extension is one JavaScript file run by `node`.
- Linux or macOS.
- A Jira Cloud site (`*.atlassian.net`) and an account that can browse the issues you want to watch.
  Jira Data Center/Server is not supported.

## Install

```bash
compozy extension install github:jillesmc/compozy-jira@v0.1.0
```

Upgrade later with `compozy extension update jira`.

## Bind your Jira credentials

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>, then bind your
Atlassian account email and the token. Both commands prompt with hidden input:

```bash
compozy extension secrets set jira --env JIRA_EMAIL
compozy extension secrets set jira --env JIRA_API_TOKEN
```

These are the only credentials the extension reads. The token never appears in items, errors, logs,
or state. `compozy extension status jira -o json` shows whether each secret is bound, never its
value.

## Golden path

Check that the agent can see the source:

```bash
compozy agent heartbeat sources jira-watch --workspace my-project
```

```text
KIND	TITLE	FROM
forge-github/issues	New GitHub issues	extension forge-github
jira/issues	New Jira issues	extension jira
SCRIPT	EXECUTABLE	APPROVED
(none)
Scripts: enabled · Limits: 8 sources, 20 items per check
```

Write `HEARTBEAT.md` (below), check it, and save it through managed authoring:

```bash
compozy agent heartbeat validate jira-watch --workspace my-project --file HEARTBEAT.md
compozy agent heartbeat inspect jira-watch --workspace my-project   # copy the Digest: value, if any
compozy agent heartbeat write jira-watch --workspace my-project --file HEARTBEAT.md --if-match sha256:...
```

Leave `--if-match` out when the agent has no `HEARTBEAT.md` yet. Then try it without consuming
anything:

```bash
compozy agent instance check jira-watch --workspace my-project --dry-run
```

With the `HEARTBEAT.md` below (`backfill: "24h"`) and no matching issue created in the last 24 hours,
the preview shows 0 items:

```text
Would run: no
Sources:
  my-jira  jira/issues  ok  0 items  (684 ms)
Digest:
```

A dry run never commits state, so until a real check has run it keeps previewing the baseline:
0 items, or only the issues created within `backfill` when that is set. Turn checks on and let the
first real check finish; it records what already matches (reporting only backfill matches, if any):

```bash
compozy agent instance checks on jira-watch --workspace my-project
```

```text
Checks on for Jira Watch in my-project
```

The new issue appears only after that first real check has completed. From then on, when an issue
starts matching the `jql`, the next check (or a dry run) shows it:

```text
Would run: yes
Sources:
  my-jira  jira/issues  ok  1 item  (702 ms)
Digest:
  source:my-jira:PLAT-1201  PLAT-1201 Checkout fails on Pix
```

In the app: agent profile → **Setup → Heartbeat** → **Sources → Add a source** → **Reads**: *New Jira
issues* (from extensions) → **Values it gets**: `site`, `jql`, `backfill` → **Try it now**.

## HEARTBEAT.md

```markdown
---
version: 1
preferences:
  min_interval: "1h"
  active_hours:
    - timezone: "America/Sao_Paulo"
      start: "08:00"
      end: "20:00"
context:
  include: []
  sources:
    - id: my-jira
      kind: jira/issues
      with:
        site: your-company.atlassian.net # required: your Jira Cloud host, no https://
        # Any JQL. Omit it to watch: assignee = currentUser() AND resolution = Unresolved
        jql: project = PLAT AND statusCategory = "To Do" AND labels = compozy
        backfill: "24h" # optional: the first check also returns matches created in the last 24h
---

For each new Jira issue, read its summary and attributes. If it is a bug with priority High or
Highest, propose "Triage <key>" citing its item key. Otherwise stay quiet.
```

Parameters (`with`):

| Key        | Type     | Default                                                | Effect                                                                                                |
| ---------- | -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `site`     | string   | — (required)                                           | Jira Cloud host, e.g. `your-company.atlassian.net`. Changing it starts a fresh baseline.              |
| `jql`      | string   | `assignee = currentUser() AND resolution = Unresolved` | Issues to watch. A trailing `ORDER BY` is ignored. Changing it starts a fresh baseline.               |
| `backfill` | duration | none                                                   | First check also returns matches created within this window (`24h`, `90m`). Later checks ignore it. |

Any other key fails the check with `source_params_invalid`. `heartbeat validate` checks the file
structure (ids, kinds); `with` values are checked when the source polls, so use `--dry-run` to see
parameter errors.

## How "new" works

- **New means newly matching.** An issue is returned when it is in the JQL's current result set and
  was not in it at the previous successful check. Edits to an issue that keeps matching never return
  it again. An issue that stops matching and later matches again is returned again. Old issues that
  move into the JQL (reassigned, relabeled, moved to a status) count as new.
- **Quiet baseline.** The first check records the current match set and returns nothing, so turning
  the source on never floods the agent with the backlog.
- **Backfill.** With `backfill` set, the baseline check also returns matches created within that
  window. Units are `m` or `h`, from `1m` to `720h`. It only affects a baseline.
- **Changing the JQL or the site re-baselines.** The next check is quiet again (plus backfill).
  Cosmetic changes do not count: surrounding or repeated whitespace and a trailing `ORDER BY` clause
  are ignored, so reformatting the query keeps the current state.
- **Dry runs are safe.** `--dry-run` and **Try it now** never commit state. The next real check still
  returns the same items.
- **This source reports entry into the JQL**, not updates or comments on issues that already match.

## JQL examples

| Watch                                 | `jql`                                                                |
| ------------------------------------- | -------------------------------------------------------------------- |
| Issues newly assigned to me (default) | `assignee = currentUser() AND resolution = Unresolved`               |
| New issues in a project               | `project = PLAT AND created >= -7d`                                  |
| Issues newly in a status              | `project = PLAT AND status = "Ready for Dev"`                        |
| New bugs by priority                  | `project = PLAT AND issuetype = Bug AND priority in (High, Highest)` |
| Unassigned work of a team             | `project = PLAT AND assignee is EMPTY AND statusCategory = "To Do"`  |
| Anything carrying a label             | `labels = compozy AND resolution = Unresolved`                       |
| A saved filter                        | `filter = 10432`                                                     |

Prefer narrow JQL: the source tracks every issue the JQL currently matches (see limits below).

## Limits and configuration

No new config keys. The existing `[agents.heartbeat.sources]` keys in the daemon's `config.toml`
apply:

| Key                                       | Default        | Effect on this source                                                                                                                                                                                  |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents.heartbeat.sources.max_items`      | 20             | Items per check, oldest `created` first. Extra new issues are not lost: the result sets `more: true` and the next check returns them.                                                                 |
| `agents.heartbeat.sources.max_state_bytes`| 16384 (16 KiB) | Tracking capacity: the whole current match set must fit, roughly 2,500 issue keys at the default (range 1 KiB–256 KiB). A JQL that matches more fails with `source_params_invalid`; it never truncates. |
| `agents.heartbeat.sources.timeout`        | 30 s           | Deadline for one poll. The extension keeps each poll under 25 s and each Jira request under 10 s.                                                                                                      |

## Items

Each new issue reaches the agent at check-in as untrusted, fenced data, shown as
`source:my-jira:PLAT-1201`:

```json
{
  "key": "PLAT-1201",
  "title": "PLAT-1201 Checkout fails on Pix",
  "summary": "Bug · To Do · High · assignee: Unassigned · reporter: Ana Souza · created 2026-11-14 09:12 UTC",
  "url": "https://your-company.atlassian.net/browse/PLAT-1201",
  "attributes": {
    "project": "PLAT",
    "issue_type": "Bug",
    "status": "To Do",
    "status_category": "To Do",
    "priority": "High",
    "assignee": null,
    "reporter": "Ana Souza",
    "labels": ["checkout", "pix"],
    "created": "2026-11-14T09:12:44.000Z",
    "updated": "2026-11-14T09:15:02.000Z"
  }
}
```

Titles longer than 200 characters are shortened with `…`. Agents also reach the source through the
native tools `compozy__agent_heartbeat_sources`, `compozy__agent_instance_check` (`dry_run: true`),
and `compozy__agent_instance_get`.

## Errors and troubleshooting

Errors show in the dry-run `Sources` line, `compozy agent instance show <agent>`, and the Heartbeat
page. A failed check never changes state; the daemon retries from the previous state.

| Condition                                         | Code                        | Message                                                                                                                         |
| ------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `JIRA_EMAIL` and/or `JIRA_API_TOKEN` not bound    | `source_credential_absent`  | `Jira sign-in missing JIRA_API_TOKEN; run compozy extension secrets set jira --env JIRA_API_TOKEN`                              |
| Jira answers 401                                  | `source_credential_expired` | `Jira rejected the credentials for ana@example.com; create a new API token and bind JIRA_API_TOKEN again`                       |
| Jira answers 429                                  | `source_rate_limited`       | `Jira rate limit reached; retry later`                                                                                          |
| `site` missing or malformed                       | `source_params_invalid`     | `set with.site to your Jira Cloud host, like your-company.atlassian.net`                                                        |
| `backfill` not a duration                         | `source_params_invalid`     | `backfill must be a duration such as 24h`                                                                                       |
| Jira rejects the JQL (400)                        | `source_params_invalid`     | `Jira rejected the JQL: Field 'sprnt' does not exist or you do not have permission to view it.`                                 |
| `site` answers 404 (not a Jira Cloud site)        | `source_params_invalid`     | `no Jira Cloud site at your-company.atlassian.com`                                                                              |
| Jira answers 403                                  | `source_params_invalid`     | `this Jira account cannot search with this JQL; check project permissions`                                                      |
| JQL matches more issues than the source can track | `source_params_invalid`     | `JQL matches 3120 issues, more than fit in max_state_bytes=16384; narrow it or raise agents.heartbeat.sources.max_state_bytes` |
| Jira unreachable or 5xx                           | `source_extension_failed`   | `Jira request failed: 503 Service Unavailable`                                                                                  |
| The whole poll exceeds the daemon's deadline      | `source_timeout`            | daemon-owned message                                                                                                            |
| Node.js missing or older than 22                  | extension start failure     | `compozy extension status jira` shows the subprocess start error                                                                |

The email in the 401 message is your bound `JIRA_EMAIL`; the token never appears.

Troubleshooting:

- **Is the extension healthy and are both secrets bound?** `compozy extension status jira -o json`.
- **What did the last failed poll say?** `compozy extension logs jira`. The extension writes one line
  per failed poll with the error code and HTTP status, never tokens or issue text.
- **`jira/issues` missing from `heartbeat sources`, or the extension does not start?** Check
  `node --version` in the environment that starts the daemon. It must print v22 or newer.
- **401 after it used to work?** The API token was revoked or expired. Create a new one and run
  `compozy extension secrets set jira --env JIRA_API_TOKEN` again.

## Acting on issues

This source only reads. To let an agent comment, transition, or assign the issues it receives, pair
it with the curated `atlassian` package, which connects Atlassian's hosted MCP server:

```bash
compozy extension install compozy/atlassian
```

## Local development

Requires [Bun](https://bun.sh), Node.js 22+, and the `compozy` CLI for the last steps.

```bash
bun install
bun run typecheck
bun test             # in-process fake Jira; never calls real Jira
bun run build        # bundles src/index.ts into dist/index.js
compozy extension build                     # runs the build and writes dist/gen-<hash>
compozy extension validate ./dist/gen-<hash>
compozy extension dev                       # link this checkout to the current workspace
```

To try the source end to end without a Jira account, run the fake Jira server:

```bash
bun test/fake-jira-server.ts --port 8787
curl -X POST http://127.0.0.1:8787/_fake/issues   # adds PLAT-1201 "Checkout fails on Pix"
```

and point a source at it with `site: "127.0.0.1:8787"`. A loopback site with an explicit port
(`127.0.0.1:<port>` or `localhost:<port>`) uses plain `http`; it exists only as a local testing aid.
Any non-empty `JIRA_EMAIL` and `JIRA_API_TOKEN` work against the fake. See the header of
`test/fake-jira-server.ts` for its other endpoints.

## Releasing

1. Bump the version in `package.json` and `EXTENSION_VERSION` in `src/index.ts`.
2. `bun run typecheck && bun test`.
3. Build and publish the generation (needs `GITHUB_TOKEN` with repo scope):

   ```bash
   compozy extension build
   compozy extension validate ./dist/gen-<hash>
   compozy extension publish ./dist/gen-<hash> --repository jillesmc/compozy-jira --tag vX.Y.Z
   ```

## Compatibility

This extension is experimental and versioned 0.x. Within 0.x:

- Parameter names and meanings stay stable. A rename keeps the old key accepted for one minor release,
  with a deprecation note in the release notes.
- A change to the stored state shape makes the next check re-baseline quietly. You lose at most one
  check's worth of "new" signal and are never flooded.
- No CompozyOS user state is touched.

Supported: CompozyOS 0.7.0 or newer, Jira Cloud only.

## License

[MIT](LICENSE)
