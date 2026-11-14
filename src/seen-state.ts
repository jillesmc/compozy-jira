import { capacityError } from "./errors.js";

export interface SeenStateV1 {
  v: 1;
  fp: string; // params fingerprint the set belongs to
  /** Project key -> sorted unique issue numbers; unparseable keys live under "_" as raw strings. */
  seen: Record<string, number[]>;
}

const KEY_RE = /^([A-Z][A-Z0-9_]*)-([0-9]+)$/;
const RAW_BUCKET = "_";

/** Parses committed state; anything unknown or malformed is null, which means a quiet baseline. */
export function decodeState(raw: unknown): SeenStateV1 | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { v, fp, seen } = raw as Record<string, unknown>;
  if (v !== 1 || typeof fp !== "string" || !/^[0-9a-f]{16}$/.test(fp)) return null;
  if (typeof seen !== "object" || seen === null || Array.isArray(seen)) return null;
  for (const [project, values] of Object.entries(seen)) {
    if (!Array.isArray(values)) return null;
    const ok =
      project === RAW_BUCKET
        ? values.every(value => typeof value === "string")
        : KEY_RE.test(`${project}-1`) &&
          values.every(value => Number.isSafeInteger(value) && value >= 0);
    if (!ok) return null;
  }
  return { v: 1, fp, seen: seen as Record<string, number[]> };
}

/** Throws source_params_invalid (capacity) when the JSON encoding exceeds maxBytes. */
export function encodeState(
  state: SeenStateV1,
  maxBytes: number,
  matchCount?: number
): SeenStateV1 {
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > maxBytes) {
    throw capacityError(matchCount ?? stateKeys(state).size, maxBytes);
  }
  return state;
}

export function stateKeys(state: SeenStateV1): Set<string> {
  const keys = new Set<string>();
  for (const [project, values] of Object.entries(state.seen)) {
    for (const value of values) {
      keys.add(project === RAW_BUCKET ? String(value) : `${project}-${value}`);
    }
  }
  return keys;
}

export function seenFromKeys(keys: Iterable<string>): Record<string, number[]> {
  const buckets = new Map<string, Set<number | string>>();
  for (const issueKey of keys) {
    const match = KEY_RE.exec(issueKey);
    const project = match ? match[1]! : RAW_BUCKET;
    const value = match ? Number(match[2]) : issueKey;
    if (!buckets.has(project)) buckets.set(project, new Set());
    buckets.get(project)!.add(value);
  }
  const seen: Record<string, number[]> = {};
  for (const project of [...buckets.keys()].sort()) {
    const values = [...buckets.get(project)!];
    seen[project] = (
      project === RAW_BUCKET
        ? (values as string[]).sort()
        : (values as number[]).sort((a, b) => a - b)
    ) as number[];
  }
  return seen;
}

/** Orders keys by project key, then issue number; unparseable keys last. */
export function compareKeys(a: string, b: string): number {
  const ma = KEY_RE.exec(a);
  const mb = KEY_RE.exec(b);
  if (!ma || !mb) return ma ? -1 : mb ? 1 : a.localeCompare(b);
  if (ma[1] !== mb[1]) return ma[1]! < mb[1]! ? -1 : 1;
  return Number(ma[2]) - Number(mb[2]);
}
