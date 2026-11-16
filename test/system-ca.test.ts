import { describe, expect, test } from "bun:test";

import { networkFailureReason, trustSystemCertificates } from "../src/system-ca.js";

// Invariant: requests to hosts re-signed by a corporate TLS-inspection CA work without
// NODE_EXTRA_CA_CERTS, and a failed request names its cause instead of a bare "network error".
describe("system CA trust", () => {
  test("Should add the operating system CAs to the default roots once", () => {
    let installed: string[] = [];
    const ok = trustSystemCertificates({
      getCACertificates: type => (type === "system" ? ["corp-ca", "shared-root"] : ["shared-root", "bundled"]),
      setDefaultCACertificates: certs => {
        installed = certs;
      },
    });
    expect(ok).toBe(true);
    expect(installed.sort()).toEqual(["bundled", "corp-ca", "shared-root"]);
  });

  test("Should keep the default roots on runtimes without the CA API or without system CAs", () => {
    expect(trustSystemCertificates({})).toBe(false);
    let called = false;
    const ok = trustSystemCertificates({
      getCACertificates: () => [],
      setDefaultCACertificates: () => {
        called = true;
      },
    });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  test("Should name certificate and network causes of a failed request", () => {
    const failure = (code?: string) => Object.assign(new TypeError("fetch failed"), { cause: code ? { code } : undefined });
    expect(networkFailureReason(failure("SELF_SIGNED_CERT_IN_CHAIN"))).toContain("TLS certificate not trusted (SELF_SIGNED_CERT_IN_CHAIN)");
    expect(networkFailureReason(failure("ECONNREFUSED"))).toBe("network error (ECONNREFUSED)");
    expect(networkFailureReason(failure())).toBe("network error");
  });
});
