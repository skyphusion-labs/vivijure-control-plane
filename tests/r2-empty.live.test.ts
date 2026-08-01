// EMPTY-THEN-DELETE, live against real R2 (vivijure-cf#72).
//
// The unit suite proves the decision path against a scripted fetch. This proves the thing the unit
// suite structurally cannot: that R2 accepts these signatures, that DeleteObjects works WITHOUT a
// Content-MD5 header (WebCrypto has no MD5, so a hard requirement would have changed the design),
// and above all that `deleteR2Bucket` -- which fails on a non-empty bucket, the defect this issue
// exists for -- now SUCCEEDS.
//
// RUN:
//   CF_PROVISIONER_TOKEN=<token> CF_ACCOUNT_ID=<id> R2_EMPTY_LIVE=1 \
//     npx vitest run tests/r2-empty.live.test.ts
//
// This repo is PUBLIC, so the env contract is named here and the place the credential is kept is
// not. Operators know where their own credentials live; a public file naming the path tells
// everyone else.
//
// SPEND: $0. One bucket, a handful of tiny objects, one credential, all destroyed in the run.

import { describe, it, expect, afterAll } from "vitest";
import { CfApi } from "../src/cf-api";
import { CfTokenMinter } from "../src/token-minter";
import { emptyBucketBounded } from "../src/r2-empty";
import { signSigV4 } from "../src/sigv4";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.CF_PROVISIONER_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const LIVE = process.env.R2_EMPTY_LIVE === "1" && Boolean(TOKEN) && Boolean(ACCOUNT);

const RUN = Date.now().toString(36).slice(-6);
const BUCKET = `rollins-cf72-live-${RUN}`;
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

// Deliberately awkward: nested, and one carrying XML metacharacters. A key is escaped on the way out
// of a listing and must be escaped again on the way into a delete body; get that wrong and the
// delete silently targets a different key, which a tidy fixture would never reveal.
const KEYS = ["a.txt", "nested/b.txt", "deep/er/c.txt", "weird &<>'\" key.txt", "renders/film-1/out.mp4"];

const cf = LIVE ? new CfApi(ACCOUNT!, TOKEN!) : (null as unknown as CfApi);
const minter = LIVE ? new CfTokenMinter(cf) : (null as unknown as CfTokenMinter);
const created: { tokenId?: string; bucket?: string } = {};

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

afterAll(async () => {
  if (!LIVE) return;
  if (created.tokenId) {
    try {
      await minter.revoke(created.tokenId);
    } catch (e) {
      console.warn(`LEFTOVER token ${created.tokenId}: ${String(e).slice(0, 120)}`);
    }
  }
  if (created.bucket) {
    try {
      await cf.deleteR2Bucket(created.bucket);
    } catch (e) {
      console.warn(`LEFTOVER bucket ${created.bucket}: ${String(e).slice(0, 120)}`);
    }
  }
}, 180_000);

describe.skipIf(!LIVE)("empty-then-delete against real R2", () => {
  it("empties a bucket that has objects, then the bucket delete SUCCEEDS", async () => {
    await cf.createR2Bucket(BUCKET);
    created.bucket = BUCKET;

    const token = await minter.mintBucketToken(`rollins-cf72-live-${RUN}`, BUCKET);
    created.tokenId = token.id;
    const credential = { accessKeyId: token.id, secretAccessKey: await sha256Hex(token.value) };

    const amz = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const put = async (key: string) => {
      const url = `${ENDPOINT}/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
      const signed = await signSigV4({
        method: "PUT", url, headers: {}, body: "x",
        accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey,
        region: "auto", service: "s3", amzDate: amz(),
      });
      return await fetch(url, { method: "PUT", headers: signed.headers, body: "x" });
    };

    // Propagation is real (measured ~3s); wait it out on the first write.
    for (let i = 0; i < 25; i++) {
      const r = await put(KEYS[0]);
      if (r.status < 300) break;
      await new Promise((x) => setTimeout(x, 1500));
    }
    for (const k of KEYS.slice(1)) {
      const r = await put(k);
      expect(r.status, `PUT ${k}`).toBeLessThan(300);
    }

    // POSITIVE CONTROL, and it is the point: prove the bucket is NON-EMPTY and prove the old
    // behaviour still bites, so "the delete worked" cannot be true for the boring reason.
    await expect(cf.deleteR2Bucket(BUCKET)).rejects.toThrow(/not empty/i);

    const res = await emptyBucketBounded({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      credential,
      budgetMs: 60_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      fetch,
      log: (event, fields) => console.log(`  [${event}]`, JSON.stringify(fields)),
    });

    expect(res.stalled, `stalled: ${res.stalled}`).toBeUndefined();
    expect(res.emptied).toBe(true);
    expect(res.deleted).toBe(KEYS.length);

    // Independent witness: list with a RAW signed request rather than trusting the cycle's own view.
    const listUrl = `${ENDPOINT}/${BUCKET}?list-type=2`;
    const signed = await signSigV4({
      method: "GET", url: listUrl, headers: {},
      accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey,
      region: "auto", service: "s3", amzDate: amz(),
    });
    const listed = await (await fetch(listUrl, { headers: signed.headers })).text();
    expect(listed).not.toContain("<Contents>");

    // THE WHOLE ISSUE: this call is the one that used to be impossible.
    await cf.deleteR2Bucket(BUCKET);
    created.bucket = undefined;

    await minter.revoke(token.id);
    created.tokenId = undefined;
  }, 300_000);
});
