// The bounded empty-then-delete cycle (vivijure-cf#72).
//
// These drive a scripted fetch, so what they prove is the DECISION PATH: which requests are issued,
// in what order, what is deleted, and -- the part that matters most -- what is NOT deleted and when
// the cycle refuses to claim progress it did not make. Correctness against the real service is a
// separate, live proof; neither substitutes for the other.

import { describe, it, expect } from "vitest";
import { emptyBucketBounded, type EmptyBucketOptions } from "../src/r2-empty";

const CRED = { accessKeyId: "ak", secretAccessKey: "sk" };

function listXml(keys: string[], opts: { truncated?: boolean; token?: string; prefixes?: string[] } = {}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
    `<IsTruncated>${opts.truncated ? "true" : "false"}</IsTruncated>` +
    keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join("") +
    (opts.prefixes ?? []).map((p) => `<CommonPrefixes><Prefix>${p}</Prefix><Key>${p}</Key></CommonPrefixes>`).join("") +
    (opts.token ? `<NextContinuationToken>${opts.token}</NextContinuationToken>` : "") +
    `</ListBucketResult>`
  );
}

interface Call { method: string; url: string; body?: string }

/** A scripted fetch that records every call. Responses are supplied in order per kind. */
function harness(script: {
  lists: { status: number; xml?: string }[];
  deletes?: { status: number; xml?: string }[];
  /** What listing does once the script runs out. Defaults to an empty bucket, which is what a real
   *  one does after its objects are deleted. A test about a credential that NEVER works sets it to
   *  keep refusing, otherwise the fallback would hand it the success it is asserting cannot happen. */
  afterExhausted?: { status: number; xml?: string };
}) {
  const calls: Call[] = [];
  let li = 0;
  let di = 0;
  let clock = 0;
  const opts: EmptyBucketOptions = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "b",
    credential: CRED,
    budgetMs: 10_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: (async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url: String(url), body: init.body });
      clock += 10;
      if (init.method === "GET") {
        // Past the scripted pages, model a REAL bucket: once its objects are gone, listing returns
        // nothing. The first version of this fake re-served the last non-empty page forever, which
        // made the cycle look like an infinite loop when it was actually doing the right thing --
        // it re-lists after deleting and only reports `emptied` once it OBSERVES an empty listing.
        const r = li < script.lists.length ? script.lists[li++] : (script.afterExhausted ?? { status: 200, xml: listXml([]) });
        return new Response(r.xml ?? "", { status: r.status });
      }
      const r = (script.deletes ?? [{ status: 200, xml: "<DeleteResult></DeleteResult>" }])[
        Math.min(di++, (script.deletes ?? [{ status: 200 }]).length - 1)
      ];
      return new Response(r.xml ?? "<DeleteResult></DeleteResult>", { status: r.status });
    }) as unknown as typeof fetch,
    log: () => {},
  };
  return { opts, calls, advance: (ms: number) => (clock += ms) };
}

describe("emptyBucketBounded", () => {
  it("waits out credential propagation instead of reporting a bucket it never read", async () => {
    // Measured behaviour: a fresh R2 credential 403s for a few seconds. A cycle that treated that as
    // "list failed" would report an unemptied bucket as a hard error every single time.
    const h = harness({ lists: [{ status: 403 }, { status: 403 }, { status: 200, xml: listXml([]) }] });
    const res = await emptyBucketBounded(h.opts);
    expect(res.emptied).toBe(true);
    expect(res.stalled).toBeUndefined();
    expect(h.calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("stalls HONESTLY when the credential never becomes usable", async () => {
    const h = harness({ lists: [{ status: 403 }], afterExhausted: { status: 403 } });
    const res = await emptyBucketBounded({ ...h.opts, propagationMs: 4_000 });
    expect(res.emptied).toBe(false);
    expect(res.more).toBe(true);
    expect(res.stalled).toMatch(/never became usable/);
    expect(h.calls.some((c) => c.method === "POST"), "must not attempt deletes it cannot authorise").toBe(false);
  });

  it("deletes a page, follows the continuation token, and reports emptied", async () => {
    const h = harness({
      lists: [
        { status: 200, xml: listXml(["a", "b"], { truncated: true, token: "T1" }) },
        { status: 200, xml: listXml(["c"]) },
      ],
    });
    const res = await emptyBucketBounded(h.opts);
    expect(res).toMatchObject({ emptied: true, deleted: 3, more: false });
    const posts = h.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toContain("<Key>a</Key>");
    expect(posts[0].body).toContain("<Key>b</Key>");
    expect(h.calls.some((c) => c.url.includes("continuation-token=T1"))).toBe(true);
  });

  it("NEVER issues a delete for a CommonPrefixes entry", async () => {
    // A prefix is not an object. Reading every <Key> in the document rather than only those inside
    // <Contents> would issue deletes for things that do not exist -- and the delete would succeed.
    const h = harness({ lists: [{ status: 200, xml: listXml(["real.txt"], { prefixes: ["folder/"] }) }] });
    const res = await emptyBucketBounded(h.opts);
    expect(res.deleted).toBe(1);
    const body = h.calls.find((c) => c.method === "POST")!.body!;
    expect(body).toContain("<Key>real.txt</Key>");
    expect(body, "a prefix must never appear in a delete body").not.toContain("folder/");
  });

  it("round-trips keys containing XML metacharacters", async () => {
    // A key like `a&b<c>.txt` arrives escaped and must be sent back escaped, not raw and not
    // double-escaped. Get this wrong and the delete silently targets a different key.
    const h = harness({ lists: [{ status: 200, xml: listXml(["a&amp;b&lt;c&gt;.txt"]) }] });
    const res = await emptyBucketBounded(h.opts);
    expect(res.deleted).toBe(1);
    expect(h.calls.find((c) => c.method === "POST")!.body).toContain("<Key>a&amp;b&lt;c&gt;.txt</Key>");
  });

  it("yields with `more` when the budget runs out mid-bucket, and counts real progress", async () => {
    const h = harness({
      lists: [
        { status: 200, xml: listXml(["a"], { truncated: true, token: "T1" }) },
        { status: 200, xml: listXml(["b"], { truncated: true, token: "T2" }) },
      ],
    });
    const res = await emptyBucketBounded({ ...h.opts, budgetMs: 1 });
    expect(res.emptied).toBe(false);
    expect(res.more).toBe(true);
    expect(res.deleted).toBeGreaterThan(0);
    expect(res.stalled, "progress was made, so this is a yield and not a stall").toBeUndefined();
  });

  it("reports a per-key DeleteObjects error rather than counting it as deleted", async () => {
    const h = harness({
      lists: [{ status: 200, xml: listXml(["a"]) }],
      deletes: [{ status: 200, xml: "<DeleteResult><Error><Key>a</Key><Code>AccessDenied</Code></Error></DeleteResult>" }],
    });
    const res = await emptyBucketBounded(h.opts);
    expect(res.emptied).toBe(false);
    expect(res.deleted).toBe(0);
    expect(res.stalled).toMatch(/key error/);
  });

  it("reports a failed DeleteObjects HTTP status honestly", async () => {
    const h = harness({ lists: [{ status: 200, xml: listXml(["a"]) }], deletes: [{ status: 500, xml: "boom" }] });
    const res = await emptyBucketBounded(h.opts);
    expect(res).toMatchObject({ emptied: false, more: true });
    expect(res.stalled).toMatch(/HTTP 500/);
  });
});
