// EMPTY-THEN-DELETE for a tenant R2 bucket (vivijure-cf#72).
//
// R2 refuses to delete a non-empty bucket, and R2's REST API has no object list or delete at all
// (the objects endpoint 404s). Emptying only goes through the S3 API, which needs a signed request
// and a bucket-scoped credential. So de-provision could not remove the bucket of any tenant that had
// ever rendered -- which is exactly the population that HAS rendered.
//
// THE INVARIANT, and it is the whole design: MINT -> WORK -> REVOKE -> YIELD.
//
//   Every invocation mints its OWN credential, does BOUNDED work inside its budget, and REVOKES that
//   credential before it returns -- success, failure or out-of-budget. No credential ever outlives
//   the invocation that made it, and none is ever persisted.
//
// The tempting alternative is to mint once and carry the credential across a resumable job. Do not.
// That stores (or strands) a live bucket-scoped grant, which is the orphaned-grant class this whole
// issue exists to close, rebuilt inside the fix for it. Paying the mint cost per cycle is the price
// of never holding one.
//
// A large bucket therefore empties across N invocations rather than failing terminally: each cycle
// makes real progress, and the caller resumes.
//
// MEASURED, not assumed: a freshly minted R2 credential is NOT usable immediately -- roughly 3s of
// propagation observed, and the repo's own r2-credential.live.test.ts already retried 20x1.5s for
// this. So a cycle spends its first seconds waiting. That is budgeted for explicitly below, and a
// cycle that cannot make net progress says so rather than spinning.

import { signSigV4 } from "./sigv4";

export interface R2S3Credential {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface EmptyBucketOptions {
  /** `https://<account>.r2.cloudflarestorage.com` */
  endpoint: string;
  bucket: string;
  credential: R2S3Credential;
  /** Wall-clock budget for the WORK phase, after propagation. */
  budgetMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Max propagation wait before giving up on this cycle's credential. */
  propagationMs?: number;
}

export interface EmptyBucketResult {
  /** The bucket is now empty as far as this cycle could tell. */
  emptied: boolean;
  deleted: number;
  /** Work remains; the caller should run another cycle. */
  more: boolean;
  /** Set when the cycle could not even start (credential never became usable). */
  stalled?: string;
}

const AMZ_DATE = (d: Date): string => d.toISOString().replace(/[:-]|\.\d{3}/g, "");

/** XML escaping for keys we send back in a DeleteObjects body. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** ...and unescaping for keys we read out of a ListObjectsV2 response. */
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // LAST: unescaping &amp; first would corrupt "&amp;lt;"
}

function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (const m of xml.matchAll(re)) out.push(xmlUnescape(m[1]));
  return out;
}

function extractOne(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlUnescape(m[1]) : null;
}

/**
 * `<Contents>` only. Reading every `<Key>` in the document would also pick up `<CommonPrefixes>`
 * entries when a delimiter is in play -- deleting a PREFIX as if it were an object. We send no
 * delimiter today, so this is defensive, and it stays defensive on purpose: the failure mode is
 * issuing deletes for things that are not objects.
 */
function contentsKeys(xml: string): string[] {
  const blocks = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => m[1]);
  return blocks.flatMap((b) => extractAll(b, "Key"));
}

async function signedFetch(
  opts: EmptyBucketOptions,
  args: { method: string; url: string; body?: string; headers?: Record<string, string> },
): Promise<Response> {
  const signed = await signSigV4({
    method: args.method,
    url: args.url,
    headers: args.headers ?? {},
    body: args.body,
    accessKeyId: opts.credential.accessKeyId,
    secretAccessKey: opts.credential.secretAccessKey,
    region: "auto",
    service: "s3",
    amzDate: AMZ_DATE(new Date(opts.now())),
  });
  return await opts.fetch(args.url, { method: args.method, headers: signed.headers, body: args.body });
}

/**
 * Empty a bucket, bounded by budget. Returns whether it finished and how much it removed.
 * Does NOT mint or revoke -- that is the caller's half of the invariant, so the credential's
 * lifetime is visible at the call site rather than buried in here.
 */
export async function emptyBucketBounded(opts: EmptyBucketOptions): Promise<EmptyBucketResult> {
  const started = opts.now();
  const listUrl = (token?: string) =>
    `${opts.endpoint}/${opts.bucket}?list-type=2&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;

  // --- propagation: wait for THIS cycle's credential to become usable, or stall honestly ---
  const propagationMs = opts.propagationMs ?? 30_000;
  const propDeadline = started + propagationMs;
  let firstList: Response | null = null;
  for (;;) {
    const res = await signedFetch(opts, { method: "GET", url: listUrl() });
    if (res.status === 200) {
      firstList = res;
      break;
    }
    if (res.status !== 401 && res.status !== 403) {
      return { emptied: false, deleted: 0, more: true, stalled: `list failed HTTP ${res.status}` };
    }
    if (opts.now() >= propDeadline) {
      return { emptied: false, deleted: 0, more: true, stalled: `credential never became usable within ${propagationMs}ms` };
    }
    await opts.sleep(1500);
  }
  opts.log("r2_empty.credential_ready", { bucket: opts.bucket, waitedMs: opts.now() - started });

  const workDeadline = opts.now() + opts.budgetMs;
  let deleted = 0;
  let response: Response = firstList;

  for (;;) {
    const xml = await response.text();
    const keys = contentsKeys(xml);
    const truncated = extractOne(xml, "IsTruncated") === "true";
    const nextToken = extractOne(xml, "NextContinuationToken");

    if (keys.length === 0) {
      // EMPTIED IS ONLY EVER CLAIMED FROM AN OBSERVED EMPTY LISTING, never inferred from "we deleted
      // everything we saw". After deleting a page the loop lists again, so the terminal state is a
      // read of the real bucket rather than our own bookkeeping. It costs one extra list per cycle
      // and it is the difference between reporting success and verifying it -- the same reason
      // teardown's own rehearsal proves absence by raw REST instead of trusting the delete call.
      // Truncated with no keys is possible in principle; treat "no keys and no continuation" as
      // empty, and keep going otherwise.
      if (!truncated || !nextToken) return { emptied: true, deleted, more: false };
    } else {
      const body =
        `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>` +
        keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join("") +
        `</Delete>`;
      // Content-MD5 is NOT required by R2 for DeleteObjects -- verified against real R2, and it
      // matters because WebCrypto has no MD5 at all. A hard requirement would have forced either a
      // hand-rolled MD5 or one request per object.
      const del = await signedFetch(opts, {
        method: "POST",
        url: `${opts.endpoint}/${opts.bucket}?delete=`,
        body,
        headers: { "content-type": "application/xml" },
      });
      if (del.status !== 200) {
        const detail = (await del.text()).slice(0, 200);
        return { emptied: false, deleted, more: true, stalled: `DeleteObjects HTTP ${del.status}: ${detail}` };
      }
      const errors = extractAll(await del.clone().text(), "Code");
      if (errors.length > 0) {
        // Quiet mode returns only errors, so any <Code> here is a real per-key failure.
        return { emptied: false, deleted, more: true, stalled: `DeleteObjects reported ${errors.length} key error(s)` };
      }
      deleted += keys.length;
      opts.log("r2_empty.batch", { bucket: opts.bucket, batch: keys.length, deleted });
    }

    if (opts.now() >= workDeadline) {
      // Out of budget with work left. NET PROGRESS is what makes the next cycle worth running; a
      // cycle that deleted nothing and is still not empty must say so rather than look like progress.
      return { emptied: false, deleted, more: true, ...(deleted === 0 ? { stalled: "budget exhausted with zero net progress" } : {}) };
    }

    const nextUrl = listUrl(nextToken ?? undefined);
    response = await signedFetch(opts, { method: "GET", url: nextUrl });
    if (response.status !== 200) {
      return { emptied: false, deleted, more: true, stalled: `list failed HTTP ${response.status}` };
    }
  }
}
