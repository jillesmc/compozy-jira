import { describe, expect, test } from "bun:test";

import { decodeState, encodeState, seenFromKeys, stateKeys } from "../src/seen-state.js";
import { catchSync, keys } from "./helpers.js";

const FP = "0123456789abcdef";

describe("seen-state", () => {
  test("UT-031 seen-state: 2,000 keys fit 16 KiB; an oversized set fails with count and limit", () => {
    const fits = { v: 1 as const, fp: FP, seen: seenFromKeys(keys("PLAT", 1, 2000)) };
    expect(encodeState(fits, 16384)).toEqual(fits);

    const tooMany = { v: 1 as const, fp: FP, seen: seenFromKeys(keys("PLAT", 100000, 104000)) };
    const error = catchSync(() => encodeState(tooMany, 16384, 4001));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe(
      "JQL matches 4001 issues, more than fit in max_state_bytes=16384; " +
        "narrow it or raise agents.heartbeat.sources.max_state_bytes"
    );
    expect(catchSync(() => encodeState(tooMany, 16384)).message).toContain("JQL matches 4001 issues");
  });

  test("UT-037 seen-state: round trip keeps numbers sorted and unique", () => {
    const seen = seenFromKeys(["PLAT-1201", "PLAT-2", "OPS-7", "PLAT-1", "PLAT-2"]);
    expect(seen).toEqual({ OPS: [7], PLAT: [1, 2, 1201] });
    const state = { v: 1 as const, fp: FP, seen };
    const decoded = decodeState(JSON.parse(JSON.stringify(encodeState(state, 16384))));
    expect(decoded).toEqual(state);
    expect([...stateKeys(decoded!)].sort()).toEqual(["OPS-7", "PLAT-1", "PLAT-1201", "PLAT-2"]);
  });

  test("UT-037 seen-state: unparseable keys round-trip through the raw bucket", () => {
    const state = { v: 1 as const, fp: FP, seen: seenFromKeys(["weird key", "PLAT-1"]) };
    expect(state.seen).toEqual({ PLAT: [1], _: ["weird key"] } as never);
    expect(stateKeys(decodeState(state)!)).toEqual(new Set(["PLAT-1", "weird key"]));
  });

  test.each([
    ["null", null],
    ["empty object", {}],
    ["unknown version", { v: 2, fp: FP, seen: {} }],
    ["malformed JSON text", "{not json"],
    ["bad fingerprint", { v: 1, fp: "xyz", seen: {} }],
    ["non-numeric issue numbers", { v: 1, fp: FP, seen: { PLAT: ["a"] } }],
    ["seen not an object", { v: 1, fp: FP, seen: [] }],
  ])("UT-038 seen-state: %s decodes as a baseline", (_name, raw) => {
    expect(decodeState(raw)).toBeNull();
  });
});
