// LIVE verification of the per-tenant R2 credential lifecycle (#53). Opt-in, like
// tests/conformance.live.test.ts:
//
//   set -a; . ~/.cf-provisioner-full.env; set +a
//   CF_ACCOUNT_ID=<id> CF_PROVISIONER_FULL=1 npx vitest run tests/control-plane/r2-credential.live.test.ts
//
// Needs the TOKEN-MANAGEMENT-capable provisioner token (the dashboard-minted one). The reduced
// token cannot mint and is fine for every other live leg.
//
// WHY THIS IS THE MOST IMPORTANT LIVE TEST IN #53: the entire key-custody design rests on a claim
// that has, until now, only been asserted -- that a bucket-scoped R2 credential reaches THAT bucket
// and nothing else. It matters because the finish satellites carry these creds on RunPod templates
// that live on the TENANT's account, where the tenant can read every env var. If bucket-scoping
// were not real, every tenant would hold a credential that reads everyone else's renders. So this
// does not assert the scope; it PROVES it, with a real S3 call against a bucket the credential must
// not be able to touch.
//
// It also proves the derivation itself (ACCESS_KEY = token id, SECRET = sha256(token value)) by
// using the credential through the studio's OWN SigV4 signer, not a re-implementation.
//
// SAFETY: prod account, everything prefixed rollins-verify-, torn down in afterAll, zero GPU spend.

import { describe, it, expect, afterAll } from "vitest";
import { CfApi } from "../src/cf-api";
import { presignR2WithConfig, type R2PresignConfig } from "./r2-presign-sigv4";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.CF_PROVISIONER_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const LIVE = Boolean(TOKEN && ACCOUNT && process.env.CF_PROVISIONER_FULL);

const stamp = `rollins-verify-${Date.now().toString(36)}`;
const OWN_BUCKET = stamp;
const OTHER_BUCKET = `${stamp}-other`; // stands in for "another tenant's bucket"
const cf = LIVE ? new CfApi(ACCOUNT!, TOKEN!) : (null as unknown as CfApi);

import { R2_BUCKET_ITEM_READ, R2_BUCKET_ITEM_WRITE } from "../src/token-minter";

const R2_GROUPS = [R2_BUCKET_ITEM_READ, R2_BUCKET_ITEM_WRITE];

const state: { tokenId?: string; cfg?: R2PresignConfig } = {};

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

afterAll(async () => {
  if (!LIVE) return;
  const drop = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.warn(`LEFTOVER ${what}: ${String(e).slice(0, 120)}`);
    }
  };
  // The bucket now has an object in it, and R2 will not delete a non-empty bucket (proven here,
  // the hard way, by leaving one behind). Empty it FIRST, with a fresh cred, then delete.
  await drop("objects", async () => {
    const t = await cf.mintR2Token(`${stamp}-cleanup`, OWN_BUCKET, [R2_BUCKET_ITEM_READ, R2_BUCKET_ITEM_WRITE]);
    try {
      const cfg = {
        accessKeyId: t.id,
        secretAccessKey: await sha256Hex(t.value),
        endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
        bucket: OWN_BUCKET,
      };
      for (let i = 0; i < 20; i++) {
        const res = await fetch(await presignR2WithConfig(cfg, "PUT", "verify.txt"), { method: "PUT", body: "x" });
        if (res.status < 300) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      const del = await fetch(`${cfg.endpoint}/${OWN_BUCKET}/verify.txt`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (del.status >= 400) throw new Error(`object delete HTTP ${del.status} (empty it manually)`);
    } finally {
      await cf.revokeToken(t.id);
    }
  });
  if (state.tokenId) await drop("token", () => cf.revokeToken(state.tokenId!));
  await drop("own bucket", () => cf.deleteR2Bucket(OWN_BUCKET));
  await drop("other bucket", () => cf.deleteR2Bucket(OTHER_BUCKET));
});

describe.skipIf(!LIVE)("per-tenant R2 credential lifecycle (real R2)", () => {
  it("mints a bucket-scoped credential (the leg that was blocked on a dashboard cred)", async () => {
    await cf.createR2Bucket(OWN_BUCKET);
    await cf.createR2Bucket(OTHER_BUCKET);

    const token = await cf.mintR2Token(`${stamp}-r2`, OWN_BUCKET, R2_GROUPS);
    state.tokenId = token.id;
    expect(token.id).toBeTruthy();
    expect(token.value).toBeTruthy();

    // The spike's derivation, proven rather than trusted: ACCESS_KEY = token id,
    // SECRET = sha256(token value).
    state.cfg = {
      accessKeyId: token.id,
      secretAccessKey: await sha256Hex(token.value),
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      bucket: OWN_BUCKET,
    };
  });

  it("WRITES and READS its own bucket with that credential (positive control)", async () => {
    // THE control that matters. Without it, "everything is denied" reads as "scoping works", which
    // is exactly how this test first lied to me: the scope and revocation checks passed green while
    // the credential could not touch its OWN bucket.
    // A freshly minted R2 credential is not usable instantly, so poll rather than flake -- but it
    // must genuinely succeed; a timeout here is a real failure, not a skip.
    let put: Response | null = null;
    for (let i = 0; i < 20; i++) {
      put = await fetch(await presignR2WithConfig(state.cfg!, "PUT", "verify.txt"), {
        method: "PUT",
        body: "hello from the tenant credential",
      });
      if (put.status < 300) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(put!.status, `PUT ${put!.status} -- credential never became usable on its own bucket`).toBeLessThan(300);

    const get = await fetch(await presignR2WithConfig(state.cfg!, "GET", "verify.txt"));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("hello from the tenant credential");
  });

  it("CANNOT touch another bucket: bucket-scoping is real, not a promise", async () => {
    // THE test. The whole reason we ship one bucket per tenant instead of prefixes in a shared one.
    const foreign: R2PresignConfig = { ...state.cfg!, bucket: OTHER_BUCKET };
    const get = await fetch(await presignR2WithConfig(foreign, "GET", "verify.txt"));
    expect(get.status, "a bucket-scoped credential reached a foreign bucket").toBeGreaterThanOrEqual(400);

    const put = await fetch(await presignR2WithConfig(foreign, "PUT", "intruder.txt"), {
      method: "PUT",
      body: "should never land",
    });
    expect(put.status, "a bucket-scoped credential WROTE to a foreign bucket").toBeGreaterThanOrEqual(400);
  });

  it("REVOKES cleanly, and the credential dies (teardown must not strand a live grant)", async () => {
    await cf.revokeToken(state.tokenId!);
    const revokedId = state.tokenId;
    state.tokenId = undefined; // afterAll must not double-revoke

    // R2 credential invalidation is not always instant; poll briefly rather than flake, but require
    // it to actually die. An un-revoked token outliving its bucket is an orphaned grant.
    let status = 200;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(await presignR2WithConfig(state.cfg!, "GET", "verify.txt"));
      status = res.status;
      if (status >= 400) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(status, `credential still worked after revoking ${revokedId}`).toBeGreaterThanOrEqual(400);
  });
});
