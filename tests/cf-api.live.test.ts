// LIVE verification of the provisioner's Cloudflare client (#53). Opt-in, exactly like
// tests/conformance.live.test.ts: it runs only when CF_PROVISIONER_TOKEN + CF_ACCOUNT_ID are set,
// so it stays out of CI and out of anyone's way.
//
//   set -a; . ~/.cf-provisioner.env; set +a
//   CF_ACCOUNT_ID=<id> npx vitest run tests/control-plane/cf-api.live.test.ts
//
// WHY IT EXISTS: provisioner.test.ts fakes Cloudflare, so it proves the step machine and NOTHING
// about whether these API calls are shaped right. A fake CF cheerfully agrees with my own
// assumptions about my own requests. This drives the SHIPPING CfApi class against real Cloudflare;
// it is the un-stubbable seam actually being exercised.
//
// SAFETY: this hits the PROD account (the only one with WfP enabled). Every resource is prefixed
// `rollins-verify-` and torn down in afterAll; it creates nothing outside that prefix and touches
// nothing pre-existing. Zero GPU spend.

import { describe, it, expect, afterAll } from "vitest";
import { CfApi, CfApiError } from "../src/cf-api";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.CF_PROVISIONER_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const LIVE = Boolean(TOKEN && ACCOUNT);

const stamp = `rollins-verify-${Date.now().toString(36)}`;
const cf = LIVE ? new CfApi(ACCOUNT!, TOKEN!) : (null as unknown as CfApi);
const SCRIPT = "tenant-verify-studio";

const state: { dbId?: string; bucket?: string; ns?: string } = {};

afterAll(async () => {
  if (!LIVE) return;
  const drop = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.warn(`LEFTOVER ${what}: ${String(e).slice(0, 120)}`);
    }
  };
  if (state.ns) {
    await drop("script", () => cf.deleteUserWorker(state.ns!, SCRIPT));
    await drop("namespace", async () => {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${state.ns}`,
        { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }
  if (state.bucket) await drop("bucket", () => cf.deleteR2Bucket(state.bucket!));
  if (state.dbId) await drop("d1", () => cf.deleteD1(state.dbId!));
});

describe.skipIf(!LIVE)("CfApi against real Cloudflare", () => {
  it("creates a D1 database", async () => {
    const db = await cf.createD1(stamp);
    state.dbId = db.uuid;
    expect(db.uuid).toMatch(/[0-9a-f-]{36}/);
  });

  it("applies a MULTI-STATEMENT migration in one call, and reads it back", async () => {
    // The spike's finding, now proven through the shipping client rather than by hand.
    await cf.queryD1(state.dbId!, "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT);\nINSERT INTO projects (id, name) VALUES ('p1','verify');");
    const res = (await cf.queryD1(state.dbId!, "SELECT name FROM projects WHERE id='p1'")) as {
      results?: { name?: string }[];
    }[];
    expect(res?.[0]?.results?.[0]?.name).toBe("verify");
  });

  it("ADOPTS an existing D1 on re-create (the whole resume story rests on this)", async () => {
    const again = await cf.createD1(stamp);
    expect(again.uuid).toBe(state.dbId);
  });

  it("creates an R2 bucket, and adopts it on re-create", async () => {
    await cf.createR2Bucket(stamp);
    state.bucket = stamp;
    expect(await cf.r2BucketExists(stamp)).toBe(true);
    await cf.createR2Bucket(stamp); // must not throw
  });

  it("CANNOT mint an R2 token: the known scope hole, asserted rather than assumed", async () => {
    // A negative control with a real job: it proves the TokenMinter seam is blocked on a
    // dashboard-created credential rather than on something I got wrong, and it will start failing
    // (loudly, correctly) the day the right token is staged. CF refuses API-created tokens any
    // token-management rights.
    await expect(cf.mintR2Token(`${stamp}-r2`, stamp, ["0".repeat(32)])).rejects.toThrow(CfApiError);
  });

  it("uploads a user Worker with d1 + r2 + plain_text + secret_text bindings", async () => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ name: stamp }),
      },
    );
    expect(res.ok, `namespace create HTTP ${res.status}`).toBe(true);
    state.ns = stamp;

    await cf.uploadUserWorker({
      namespace: state.ns,
      scriptName: SCRIPT,
      mainModule: "index.js",
      moduleText: 'export default { async fetch() { return new Response("ok"); } };',
      compatibilityDate: "2026-06-01",
      bindings: [
        { type: "d1", name: "DB", id: state.dbId! },
        { type: "r2_bucket", name: "R2_RENDERS", bucket_name: state.bucket! },
        { type: "plain_text", name: "AUTH_MODE", text: "token" },
        { type: "secret_text", name: "RUNPOD_API_KEY", text: "rpa_fake_for_verify_only" },
      ],
    });
  });

  it("reports the bindings it actually built (the post-provision verification primitive)", async () => {
    const names = new Set((await cf.getScriptBindings(state.ns!, SCRIPT)).map((b) => b.name));
    for (const want of ["DB", "R2_RENDERS", "AUTH_MODE"]) expect(names, want).toContain(want);
  });

  it("rotates a script secret in place, WITHOUT re-uploading the worker (the custody mechanism)", async () => {
    await cf.putScriptSecret(state.ns!, SCRIPT, "RUNPOD_API_KEY", "rpa_rotated_for_verify_only");
    const secrets = await cf.getScriptSecretNames(state.ns!, SCRIPT);
    expect(secrets).toContain("RUNPOD_API_KEY");
  });

  it("returns secret NAMES ONLY, never values (if this ever fails, it is a finding)", async () => {
    const raw = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${state.ns}/scripts/${SCRIPT}/secrets`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const body = JSON.stringify(await raw.json());
    expect(body).not.toContain("rpa_rotated_for_verify_only");
    expect(body).not.toContain("rpa_fake_for_verify_only");
  });
});
