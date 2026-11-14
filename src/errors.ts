import { RPCError } from "@compozy/extension-sdk";

export type SourceErrorCode =
  | "source_params_invalid"
  | "source_credential_absent"
  | "source_credential_expired"
  | "source_rate_limited"
  | "source_extension_failed";

export interface SourceErrorData {
  code: SourceErrorCode;
}

/** A check-in source failure: JSON-RPC error -32000 whose data.code the daemon reports. */
export class SourceError extends RPCError<SourceErrorData> {
  /** HTTP status behind the failure, for the stderr line only; never sent to the daemon. */
  readonly httpStatus: number | undefined;
  public constructor(code: SourceErrorCode, message: string, httpStatus?: number) {
    super(-32000, message, { code });
    this.httpStatus = httpStatus;
  }
}

export function sourceError(code: SourceErrorCode, message: string, httpStatus?: number): SourceError {
  return new SourceError(code, message, httpStatus);
}

export function capacityError(count: number | string, maxStateBytes: number): SourceError {
  return sourceError(
    "source_params_invalid",
    `JQL matches ${count} issues, more than fit in max_state_bytes=${maxStateBytes}; ` +
      "narrow it or raise agents.heartbeat.sources.max_state_bytes"
  );
}

/** Thrown by the client when a listing exceeds its key guard; the poll rewords it with the byte limit. */
export class ListingLimitError extends SourceError {
  readonly limit: number;
  public constructor(limit: number) {
    super("source_params_invalid", `JQL matches more than ${limit} issues, more than this source can track`);
    this.limit = limit;
  }
}
