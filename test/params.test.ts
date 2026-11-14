import { describe, expect, test } from "bun:test";

import { DEFAULT_JQL, resolveParams, siteBaseUrl } from "../src/params.js";
import { catchSync } from "./helpers.js";

const SITE_MESSAGE = "set with.site to your Jira Cloud host, like your-company.atlassian.net";

describe("params", () => {
  test("UT-001 params: site and jql resolve with a 16-hex fingerprint", () => {
    const params = resolveParams({ site: "acme.atlassian.net", jql: "project = PLAT" });
    expect(params).toMatchObject({ site: "acme.atlassian.net", jql: "project = PLAT", backfillMinutes: 0 });
    expect(params.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test("UT-002 params: trailing ORDER BY is removed, quoted text is kept", () => {
    const site = "acme.atlassian.net";
    expect(resolveParams({ site, jql: "project = PLAT ORDER BY created DESC" }).jql).toBe("project = PLAT");
    expect(resolveParams({ site, jql: 'summary ~ "order by x"' }).jql).toBe('summary ~ "order by x"');
    expect(resolveParams({ site, jql: 'summary ~ "a  b"   AND  x = 1' }).jql).toBe('summary ~ "a  b" AND x = 1');
    expect(resolveParams({ site, jql: "(project = PLAT) order   by key" }).jql).toBe("(project = PLAT)");
    expect(resolveParams({ site, jql: "labels = border" }).jql).toBe("labels = border");
  });

  test.each([[undefined], [""], ["   "]])("UT-003 params: jql %p falls back to the default JQL", jql => {
    expect(resolveParams({ site: "acme.atlassian.net", jql }).jql).toBe(DEFAULT_JQL);
  });

  test.each([
    ["https://acme.atlassian.net"],
    ["acme"],
    ["acme.atlassian.net/jira"],
    [undefined],
    ["acme.atlassian.net:8080"],
    ["10.0.0.5:8080"],
  ])("UT-004 params: malformed site %p is rejected", site => {
    const error = catchSync(() => resolveParams({ site }));
    expect(error.data).toEqual({ code: "source_params_invalid" });
    expect(error.message).toBe(SITE_MESSAGE);
  });

  test.each([["127.0.0.1:8787"], ["localhost:9000"]])(
    "UT-004 params: loopback site %p with a port is accepted and uses plain http (D-1)",
    site => {
      expect(resolveParams({ site }).site).toBe(site);
      expect(siteBaseUrl(site)).toBe(`http://${site}`);
    }
  );

  test("UT-004 params: every non-loopback site uses https (D-1)", () => {
    expect(siteBaseUrl("acme.atlassian.net")).toBe("https://acme.atlassian.net");
    expect(siteBaseUrl("localhost.example.com")).toBe("https://localhost.example.com");
  });

  test.each([["yesterday"], ["-1h"], ["0m"], ["721h"], ["24"], [24]])(
    "UT-005 params: backfill %p is rejected",
    backfill => {
      const error = catchSync(() => resolveParams({ site: "acme.atlassian.net", backfill }));
      expect(error.data).toEqual({ code: "source_params_invalid" });
      expect(error.message).toBe("backfill must be a duration such as 24h");
    }
  );

  test.each([
    ["90m", 90],
    ["24h", 1440],
    ["720h", 43200],
    ["1m", 1],
  ])("UT-005 params: backfill %p is %p minutes", (backfill, minutes) => {
    expect(resolveParams({ site: "acme.atlassian.net", backfill }).backfillMinutes).toBe(minutes);
  });

  test("UT-006 params: cosmetic JQL changes keep the fingerprint, real changes do not", () => {
    const fp = (site: string, jql: string) => resolveParams({ site, jql }).fingerprint;
    const base = fp("acme.atlassian.net", "project = PLAT");
    expect(fp("acme.atlassian.net", "project  =  PLAT ORDER BY key")).toBe(base);
    expect(fp("acme.atlassian.net", "project = OPS")).not.toBe(base);
    expect(fp("other.atlassian.net", "project = PLAT")).not.toBe(base);
  });
});
