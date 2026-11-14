# Developer Experience: Jira issues check-in source

Public-surface contract for the `jira` extension and its `jira/issues` check-in source. Companion to
`_spec.md` (Part II serves this surface) and `_tests.md` (E2E journeys use these exact invocations).
Every CompozyOS command below already exists; this extension adds the source kind, its parameters,
its secrets, its item shape, and its errors. Output formats mirror the bundled `forge-github/issues`
source (`packages/site/content/docs/guides/watch-new-github-issues.mdx` in compozy/compozy).

## Golden Path

Watch Jira issues newly assigned to you, from install to the first item.

```bash
# 1. Install (Node.js 22+ required). GitHub installs are not catalog-verified, so CompozyOS
#    requires explicit consent; the release's .sha256 sidecar is still checked.
compozy extension install github:jillesmc/compozy-jira@v0.1.0 --allow-unverified --yes

# 2. Bind Jira Cloud credentials (hidden prompt; create the token at
#    https://id.atlassian.com/manage-profile/security/api-tokens)
compozy extension secrets set jira --env JIRA_EMAIL
compozy extension secrets set jira --env JIRA_API_TOKEN

# 3. See the source
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

Write `HEARTBEAT.md` (see YAML below), save it with `compozy agent heartbeat write`, then:

```bash
compozy agent instance check jira-watch --workspace my-project --dry-run
```

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

After that baseline check has completed, when an issue is later assigned to you, the next check (or a dry run) shows it:

```text
Would run: yes
Sources:
  my-jira  jira/issues  ok  1 item  (702 ms)
Digest:
  source:my-jira:PLAT-1201  PLAT-1201 Checkout fails on Pix
```

In the app: agent profile → **Setup → Heartbeat** → **Sources → Add a source** → **Reads**: *New Jira
issues* (from extensions) → **Values it gets**: `site`, `jql`, `backfill` → **Try it now**.

## YAML

`HEARTBEAT.md` of an always-on agent, saved through managed authoring (`compozy agent heartbeat write`
or the Heartbeat page). Loaded by the daemon at each check-in.

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

| Key        | Type     | Default                                               | Effect                                                                                        |
| ---------- | -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `site`     | string   | — (required)                                          | Jira Cloud host, e.g. `your-company.atlassian.net`. Changing it starts a fresh baseline.    |
| `jql`      | string   | `assignee = currentUser() AND resolution = Unresolved` | Issues to watch. A trailing `ORDER BY` is ignored. Changing it starts a fresh baseline.       |
| `backfill` | duration | none                                                  | First check also returns matches created within this window (`24h`, `90m`). Later checks ignore it. |

JQL examples shipped in the README:

| Watch                                         | `jql`                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Issues newly assigned to me (default)         | `assignee = currentUser() AND resolution = Unresolved`                |
| New issues in a project                       | `project = PLAT AND created >= -7d`                                   |
| Issues newly in a status                      | `project = PLAT AND status = "Ready for Dev"`                          |
| New bugs by priority                          | `project = PLAT AND issuetype = Bug AND priority in (High, Highest)`  |
| Unassigned work of a team                     | `project = PLAT AND assignee is EMPTY AND statusCategory = "To Do"`   |
| Anything carrying a label                     | `labels = compozy AND resolution = Unresolved`                        |
| A saved filter                                | `filter = 10432`                                                      |

## CLI

No new verbs. The extension participates in these existing commands:

| Command                                                                    | What changes                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `compozy extension install github:jillesmc/compozy-jira@v0.1.0 --allow-unverified --yes` | Installs `jira` 0.1.0 (consent flags are required for GitHub installs). |
| `compozy extension secrets set jira --env JIRA_EMAIL` / `--env JIRA_API_TOKEN` | Binds credentials (hidden input).                               |
| `compozy extension status jira -o json`                                    | Shows health and secret presence (`JIRA_EMAIL`, `JIRA_API_TOKEN`), never values. |
| `compozy agent heartbeat sources <agent>`                                  | Lists `jira/issues  New Jira issues  extension jira`.           |
| `compozy agent heartbeat validate <agent> --file HEARTBEAT.md`             | Validates the file structure (ids, kinds); `with` values are checked at poll time. |
| `compozy agent instance check <agent> --dry-run`                           | Polls without committing state; surfaces parameter errors.      |
| `compozy agent instance show <agent>`                                      | `Sources` block shows `my-jira  jira/issues  ok  0 items  polled 15:00` or the failing code. |
| `compozy extension update jira --allow-unverified --yes`                   | Picks up a newer tag (same consent as the GitHub install, D-7). |

The daemon validates `with` against the source's params schema before calling the extension, so an
unknown key or wrong type fails the poll (dry run included) with `source_params_invalid`:

```text
Would run: no
Sources:
  my-jira  jira/issues  failed  source_params_invalid  additionalProperties 'project' not allowed
```

## Native Tools

Agents operate the source through the existing native tools, unchanged: `compozy__agent_heartbeat_sources`
(lists `jira/issues`), `compozy__agent_instance_check` (`dry_run: true` returns the per-source result
and items), `compozy__agent_instance_get` (source status). Items reach the agent at check-in as
untrusted, fenced data:

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

The daemon shows it as `source:my-jira:PLAT-1201`.

## Errors

Shown in the dry-run `Sources` line, `compozy agent instance show`, and the Heartbeat page.

| Condition                                              | Code                        | Message                                                                                                   |
| ------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `JIRA_EMAIL` and/or `JIRA_API_TOKEN` not bound          | `source_credential_absent`  | `Jira sign-in missing JIRA_API_TOKEN; run compozy extension secrets set jira --env JIRA_API_TOKEN`        |
| Jira answers 401                                        | `source_credential_expired` | `Jira rejected the credentials for ana@example.com; create a new API token and bind JIRA_API_TOKEN again` |
| Jira answers 429                                        | `source_rate_limited`       | `Jira rate limit reached; retry later`                                                                    |
| `site` missing or malformed                             | `source_params_invalid`     | `set with.site to your Jira Cloud host, like your-company.atlassian.net`                                  |
| `backfill` not a duration                               | `source_params_invalid`     | `backfill must be a duration such as 24h`                                                                 |
| Jira rejects the JQL (400)                              | `source_params_invalid`     | `Jira rejected the JQL: Field 'sprnt' does not exist or you do not have permission to view it.`           |
| `site` answers 404 (not a Jira Cloud site)              | `source_params_invalid`     | `no Jira Cloud site at your-company.atlassian.com`                                                      |
| Jira answers 403                                        | `source_params_invalid`     | `this Jira account cannot search with this JQL; check project permissions`                                |
| JQL matches more issues than the source can track       | `source_params_invalid`     | `JQL matches 3120 issues, more than fit in max_state_bytes=16384; narrow it or raise agents.heartbeat.sources.max_state_bytes` |
| Jira unreachable or 5xx                                 | `source_extension_failed`   | `Jira request failed: 503 Service Unavailable` (state unchanged, daemon retries)                          |
| The whole poll exceeds the daemon's source deadline     | `source_timeout`            | daemon-owned message (state unchanged, daemon retries)                                                    |
| Node.js missing or < 22                                 | extension start failure     | `compozy extension status jira` shows the subprocess start error                                           |

The email in the 401 message is the bound `JIRA_EMAIL`, which the operator already knows; the token
never appears in any output.
