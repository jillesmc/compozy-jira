# Slices: Jira issues check-in source

| Slice | Layer | Depends on | Scope | Spec refs |
| ----- | ----- | ---------- | ----- | --------- |
| S1 | extension | none | `jira/issues` source end to end: params, credentials, Jira client, key-set diff poll, items, errors; builds and installs locally; dry run against fake and real Jira | US-001–US-008; `_spec.md` Implementation Design, Integration Points; ADR-001, ADR-002; UT-001–UT-060, IT-001–IT-011, E2E-001–E2E-003 |
| S2 | docs/ci | S1 | README (install, secrets, YAML, JQL gallery, limits, Atlassian MCP pairing, troubleshooting), LICENSE, GitHub Actions running typecheck + `bun test` on push/PR | US-004.AC-2, US-006, US-009.EC-1; `_dx.md` |
| S3 | release | S2 | Create public repo `jillesmc/compozy-jira`, push, `compozy extension publish` v0.1.0, verify install from GitHub on Linux (macOS by operator) | US-009; E2E-004 |
| S4 | outreach | S3 | Draft and (after user approval) open an issue on `compozy/compozy` requesting curated-catalog listing | `_spec.md` Non-Goals, MVP Boundary |

S1 is the earliest useful end-to-end outcome. When it finishes, the author's agent receives newly
matching Jira issues from a locally installed build.
