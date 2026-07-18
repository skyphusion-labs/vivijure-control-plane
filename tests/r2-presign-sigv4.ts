// DUPLICATED, DELIBERATELY, WITH PROVENANCE (cf#85 extraction).
//
// SOURCE: vivijure-cf src/r2-presign.ts @ 59b3fb382521cab36cc0a746f77b174635133552
// (the `presignR2WithConfig` half only, plus the private helpers it closes over).
//
// WHY A COPY AND NOT AN IMPORT: the control plane consumes the studio ONLY as a published release
// artifact. A source-level import across the repo seam is forbidden by the extraction contract, so
// the live R2-credential test cannot reach into the studio tree for this.
//
// WHY A COPY IS HONEST HERE, unlike the studio D1 migrations: this is AWS SigV4 query presigning, a
// frozen public standard, NOT a vivijure contract. There is no studio-side value that can drift out
// from under it; if SigV4 itself changed, every S3 client on earth would break with us. Contrast the
// studio migration set, which IS a live studio-owned contract and is therefore NOT copied (it rides
// the release artifact instead).
//
// SCOPE: test-side only. This exists so the control plane can prove a credential IT MINTED actually
// works against R2. Nothing in src/ imports it, and it must never become a runtime dependency.
//
// The Env-bound wrappers (presignR2Get/presignR2Put, configFromEnv) are NOT copied: they are studio
// runtime surface and depend on the studio Env plus @skyphusion-labs/vivijure-core/secret-store.

const ENC = new TextEncoder();

// S3/R2 caps a presigned URL lifetime at 7 days; clamp into [1, 604800]s so a bad or hostile value
// can never sign a longer-lived (or malformed) URL.
const MAX_EXPIRES_SECONDS = 604800;
function clampExpires(seconds: number): number {
  const n = Math.floor(Number(seconds));
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_EXPIRES_SECONDS, Math.max(1, n));
}

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", ENC.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, ENC.encode(data));
}

/** Guard copied from vivijure-cf src/shared.ts `isPresignSafeKey` (same commit). */
function isPresignSafeKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("://")) return false;
  if (/[^ -~]/.test(key)) return false; // control chars, DEL, non-ASCII
  return !key.split("/").includes("..");
}

// RFC3986 percent-encoding. S3 canonical form encodes everything except the unreserved set; slashes
// in an object key are NOT encoded (encodeSlash=false), but slashes inside query values ARE.
export function uriEncode(str: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      for (const byte of ENC.encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

export type PresignMethod = "GET" | "PUT";

export interface R2PresignConfig {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string; // https://<accountid>.r2.cloudflarestorage.com
  bucket: string;
}

/** SigV4 query-string presign. `nowMs` is injectable for deterministic tests. */
export async function presignR2WithConfig(
  cfg: R2PresignConfig,
  method: PresignMethod,
  key: string,
  expiresSeconds = 300,
  nowMs?: number,
): Promise<string> {
  if (!isPresignSafeKey(key)) {
    throw new Error("R2 presign: refusing to sign an unsafe object key");
  }
  expiresSeconds = clampExpires(expiresSeconds);

  const url = new URL(cfg.endpoint);
  const host = url.host;
  const region = "auto";
  const service = "s3";

  const now = new Date(nowMs ?? Date.now());
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const canonicalUri = "/" + uriEncode(cfg.bucket, true) + "/" + uriEncode(key, false);

  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(q)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(q[k], true)}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(ENC.encode("AWS4" + cfg.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return `${cfg.endpoint.replace(/\/$/, "")}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
