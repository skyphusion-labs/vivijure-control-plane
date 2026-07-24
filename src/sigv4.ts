// AWS Signature Version 4, header-based ("Authorization: AWS4-HMAC-SHA256 ..."), for R2's S3 API.
//
// WHY THIS EXISTS: the control plane must EMPTY a tenant bucket before it can delete it (cf#72).
// R2's REST API has no object list/delete at all -- emptying only goes through the S3 API, which
// needs a signed request. The existing `r2-presign-sigv4.ts` is QUERY presigning, GET/PUT only, and
// test-side by contract; it cannot sign a ListObjectsV2 or a DeleteObjects POST body.
//
// S3 FLAVOUR, STATED OUT LOUD: the canonical URI is used AS GIVEN. SigV4 normally normalizes the
// path (collapsing `.` / `..` / double slashes), and S3 is the documented exception that must NOT --
// an object key legitimately contains those sequences, and normalizing would sign a different key
// than the one requested. That is why the suite's `normalize-path` cases are deliberately NOT
// vendored alongside the others: they encode the non-S3 behaviour, and passing them would mean this
// signer was WRONG for its only caller. Anyone reusing this for a non-S3 service must add
// normalization first.
//
// Verified three ways, deliberately, because a signer that is subtly wrong fails in a way that looks
// like an auth problem: (1) the official AWS SigV4 conformance vectors, vendored from a pinned
// botocore commit; (2) live R2, which validates the signature itself and answers 403
// SignatureDoesNotMatch when it is wrong; (3) a frozen regression fixture. See tests/.

const ENC = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", ENC.encode(data)));
}

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, ENC.encode(msg)));
}

/**
 * RFC3986 encoding. `encodeSlash` false for path segments (S3 keys keep their `/`), true everywhere
 * else. `encodeURIComponent` is not enough on its own: it leaves `!*'()` unescaped, and AWS requires
 * them percent-encoded.
 */
export function uriEncode(str: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else for (const b of ENC.encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Collapse internal runs of whitespace and trim, per the canonical-headers rule. */
function trimAll(v: string): string {
  return v.trim().replace(/\s+/g, " ");
}

export interface SigV4Request {
  method: string;
  /** Full URL including any query string. */
  url: string;
  /** Headers to sign. `host` is derived from the URL when absent. Duplicates: pass an array. */
  headers: Record<string, string | string[]>;
  body?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ`. Explicit so a signature is reproducible and testable against fixed vectors. */
  amzDate: string;
}

export interface SigV4Result {
  authorization: string;
  /** Every header that must be sent, including the ones signing added. */
  headers: Record<string, string>;
  /** Exposed so conformance vectors can assert the INTERMEDIATE stages, not just the final hex --
   *  a mismatch then says WHICH stage diverged instead of "the signature is wrong". */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export async function signSigV4(req: SigV4Request): Promise<SigV4Result> {
  const url = new URL(req.url);
  const date = req.amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(req.body ?? "");

  const collected = new Map<string, string[]>();
  const add = (name: string, value: string) => {
    const k = name.toLowerCase();
    collected.set(k, [...(collected.get(k) ?? []), trimAll(value)]);
  };
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) add(name, v);
    else add(name, value);
  }
  if (!collected.has("host")) add("host", url.host);
  if (!collected.has("x-amz-date")) add("x-amz-date", req.amzDate);
  if (req.sessionToken && !collected.has("x-amz-security-token")) add("x-amz-security-token", req.sessionToken);

  const signedHeaderNames = [...collected.keys()].sort();
  // Duplicate header values join with "," IN THE ORDER RECEIVED -- not sorted. Sorting them is a
  // classic silent divergence; the suite's get-header-value-order case exists to catch exactly it.
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${collected.get(n)!.join(",")}\n`).join("");

  // Query params sort by encoded NAME, then by encoded VALUE for repeated names.
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([uriEncode(k, true), uriEncode(v, true)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  // S3: path AS GIVEN, only percent-encoded. No normalization. See the header comment.
  const canonicalUri = url.pathname === "" ? "/" : uriEncode(decodeURIComponent(url.pathname), false);

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${date}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", req.amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key = ENC.encode(`AWS4${req.secretAccessKey}`);
  for (const part of [date, req.region, req.service, "aws4_request"]) key = await hmac(key, part);
  const signature = toHex(await hmac(key, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;

  const headers: Record<string, string> = { authorization, "x-amz-content-sha256": payloadHash };
  for (const n of signedHeaderNames) if (n !== "host") headers[n] = collected.get(n)!.join(",");
  return { authorization, headers, canonicalRequest, stringToSign, signature };
}
