// The OFFICIAL AWS SigV4 conformance vectors, run against our signer.
//
// PROVENANCE MATTERS HERE MORE THAN USUAL. An earlier attempt to obtain these from documentation
// produced values that were RECALLED rather than sourced, and they were wrong -- the secret key came
// back as `...NG/bPxRfiCYEXAMPLEKEY` where the real one is `...NG+bPxRfiCYEXAMPLEKEY`. One character.
// Every signature derived from it would have been wrong while this file claimed the authority of
// "the AWS published vectors". A fabricated proof reads as STRONGER than no proof, which is exactly
// backwards, so the vectors are vendored byte-for-byte from a pinned commit of AWS's own botocore
// repository (tests/vendor/aws4_testsuite/PROVENANCE.md) and the credentials below are read from
// that same commit's test_sigv4.py rather than from anybody's memory.
//
// The suite asserts all THREE stages -- canonical request, string to sign, Authorization -- because
// a final-signature-only assertion tells you it broke without telling you where.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { signSigV4 } from "../src/sigv4";

// From boto/botocore tests/unit/auth/test_sigv4.py at the pinned commit. Not from memory.
const ACCESS_KEY = "AKIDEXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const REGION = "us-east-1";
const SERVICE = "service";

const SUITE = join(import.meta.dirname, "vendor", "aws4_testsuite");

/** Parse the suite's raw-HTTP `.req` format into something signable. */
function parseReq(raw: string): { method: string; url: string; headers: Record<string, string | string[]>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  const headSection = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);
  const lines = headSection.split("\n").filter((l) => l.length > 0);

  const requestLine = lines[0];
  const m = /^(\S+)\s+(.*?)\s+HTTP\/1\.1$/.exec(requestLine);
  if (!m) throw new Error(`unparseable request line: ${requestLine}`);
  const [, method, target] = m;

  const headers: Record<string, string | string[]> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const name = line.slice(0, i);
    const value = line.slice(i + 1);
    const key = name.toLowerCase();
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[key] = [existing, value];
  }

  const hostHeader = headers["host"];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : (hostHeader ?? "example.amazonaws.com");
  // The suite's targets are origin-form; build an absolute URL without touching the raw path.
  const url = `https://${String(host).trim()}${target.startsWith("/") ? target : `/${target}`}`;
  return { method, url, headers, body };
}

function amzDateOf(headers: Record<string, string | string[]>): string {
  const v = headers["x-amz-date"];
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) throw new Error("vector has no X-Amz-Date");
  return raw.trim();
}

const cases = readdirSync(SUITE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => existsSync(join(SUITE, name, `${name}.req`)))
  .sort();

describe("AWS SigV4 official conformance vectors (vendored, pinned)", () => {
  it("the vendored suite is actually present", () => {
    // Without this, an empty directory would make every vector below vacuously pass -- a suite that
    // tests nothing while reporting green is the failure mode this whole file exists to avoid.
    expect(cases.length, "no vendored vectors found").toBeGreaterThanOrEqual(8);
    expect(existsSync(join(SUITE, "NOTICE")), "AWS NOTICE must ship with the vectors").toBe(true);
    expect(existsSync(join(SUITE, "LICENSE"))).toBe(true);
  });

  for (const name of cases) {
    it(`${name}`, async () => {
      const dir = join(SUITE, name);
      const req = parseReq(readFileSync(join(dir, `${name}.req`), "utf8"));
      const res = await signSigV4({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        region: REGION,
        service: SERVICE,
        amzDate: amzDateOf(req.headers),
      });

      const expectedCreq = readFileSync(join(dir, `${name}.creq`), "utf8").replace(/\r\n/g, "\n");
      const expectedSts = readFileSync(join(dir, `${name}.sts`), "utf8").replace(/\r\n/g, "\n");
      const expectedAuthz = readFileSync(join(dir, `${name}.authz`), "utf8").replace(/\r\n/g, "\n").trim();

      // Staged assertions: whichever fails first names the stage that diverged.
      expect(res.canonicalRequest, "canonical request").toBe(expectedCreq.trim());
      expect(res.stringToSign, "string to sign").toBe(expectedSts.trim());
      expect(res.authorization, "authorization header").toBe(expectedAuthz);
    });
  }
});
