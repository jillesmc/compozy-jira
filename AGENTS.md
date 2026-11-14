# compozy-jira

CompozyOS extension `jira` providing the `jira/issues` check-in source (Jira Cloud, any JQL).
The design contract lives in `.compozy/tasks/jira-issues-source/` (`_spec.md`, `_dx.md`,
`_user_stories.md`, `_tests.md`, `_slices.md`, `adrs/`). Implement exactly that contract; record
any deviation in the spec before coding it.

## Stack

- TypeScript, ESM, Node.js >= 22 at runtime, `@compozy/extension-sdk` pinned to `0.7.0`.
- Build: `bun run build` (`tsc --noEmit` + `bun build src/index.ts --target=node --outfile=dist/index.js`),
  then `compozy extension build` produces the installable generation under `dist/gen-<hash>`.
- Tests: `bun test`. Fakes only at the network boundary (in-process `node:http` Jira fake);
  inject `fetch` and the clock. No real Jira calls in automated tests.
- Runtime dependencies: only `@compozy/extension-sdk`; Node built-ins otherwise.

## Rules

- Only `src/index.ts` imports the SDK `Extension` and reads environment variables; only
  `src/jira-client.ts` does network I/O.
- Never log, return, or persist `JIRA_API_TOKEN`. Never call Jira write endpoints.
- Keep source files cohesive and small (< 300 lines); extract before growing.
- Test IDs from `_tests.md` appear in test names (e.g. `UT-020 poll: new issue matching JQL is returned`).
- Before committing: `bun run typecheck && bun test` pass with zero errors.
- Commits: `<type>: <description>` with `feat|fix|refactor|perf|docs|test|build|ci`, no scopes.
- Docs, code, commits and specs in English.
