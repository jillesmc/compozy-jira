import { pathToFileURL } from "node:url";

import {
  Extension,
  type ExtensionOptions,
  type HeartbeatSourceRequest,
  type HeartbeatSourceResult,
} from "@compozy/extension-sdk";

import { SourceError, sourceError } from "./errors.js";
import { createJiraClient, resolveCredentials } from "./jira-client.js";
import { PARAMS_SCHEMA, resolveParams } from "./params.js";
import { pollJiraIssues } from "./poll.js";

export const EXTENSION_VERSION = "0.1.0";
/**
 * Supported CompozyOS floor (user decision: SDK pinned to 0.7.0, one supported baseline). The TS SDK
 * 0.7.0 describe payload still carries its stale built-in floor "0.3.0-beta.1", and
 * `compozy extension build` stamps extension.toml from that payload, so the floor is set here.
 */
export const MIN_COMPOZY_VERSION = "0.7.0";

class JiraExtension extends Extension {
  public override describe(): ReturnType<Extension["describe"]> {
    const payload = super.describe();
    return { ...payload, sdk: { ...payload.sdk, min_compozy_version: MIN_COMPOZY_VERSION } };
  }
}

export interface JiraExtensionDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stderr?: { write(line: string): unknown };
}

/** The `jira/issues` poll handler: params, credentials, client, then the key-set diff poll. */
export function createPollHandler(deps: JiraExtensionDeps = {}) {
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? process.stderr;
  return async (request: HeartbeatSourceRequest): Promise<HeartbeatSourceResult> => {
    try {
      const params = resolveParams(request.params);
      const credentials = resolveCredentials(env);
      const client = createJiraClient(params.site, credentials, { fetch: deps.fetch });
      return await pollJiraIssues(request, { client, params });
    } catch (error) {
      let failure =
        error instanceof SourceError
          ? error
          : sourceError("source_extension_failed", "Jira source failed unexpectedly");
      // Last line of defense: no outward message carries the bound token, whatever the path.
      const token = env.JIRA_API_TOKEN?.trim();
      if (token && failure.message.includes(token)) {
        failure = sourceError(
          failure.data!.code,
          failure.message.split(token).join("[redacted]"),
          failure.httpStatus
        );
      }
      // Code and HTTP status only: never the token, the JQL results, or issue text.
      stderr.write(
        `jira/issues poll failed: code=${failure.data?.code} status=${failure.httpStatus ?? "-"}\n`
      );
      throw failure;
    }
  };
}

export function createExtension(
  options: ExtensionOptions = {},
  deps: JiraExtensionDeps = {}
): Extension {
  const extension = new JiraExtension(
    {
      name: "jira",
      version: EXTENSION_VERSION,
      description: "Jira Cloud check-in source: issues newly matching any JQL",
      subprocess: { command: "node", args: ["index.js"] },
      capabilities: { provides: [] },
      permissions: { requires: [] },
      requires_env: ["JIRA_EMAIL", "JIRA_API_TOKEN"],
    },
    options
  );
  extension.heartbeatSource(
    "issues",
    {
      title: "New Jira issues",
      description: "Jira issues that newly match a JQL query since the last check.",
      params_schema: PARAMS_SCHEMA,
    },
    createPollHandler(deps)
  );
  return extension;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void createExtension().start();
}
