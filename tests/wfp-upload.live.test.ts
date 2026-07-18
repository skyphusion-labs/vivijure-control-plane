// LIVE verification of wfp_upload with the REAL studio release artifact (#53's last leg, #59).
//
//   node scripts/build-studio-release.ts --bundle <outdir>/index.js --assets public \
//     --config wrangler.toml --tag <tag> --out /tmp/studio-release
//   set -a; . ~/.cf-provisioner-full.env; set +a
//   CF_ACCOUNT_ID=<id> STUDIO_RELEASE_DIR=/tmp/studio-release \
//     npx vitest run tests/control-plane/wfp-upload.live.test.ts
//
// HONEST LABEL, and it is the point of this comment: this verifies the upload against the
// REPRODUCIBLE BUILD OF MAIN, not against a published tag. No v* tag exists yet (tagging deploys the
// live panel; not a side effect anyone should cause at 2am). The build script reads no secrets and no
// account state, so this artifact is byte-identical to what the workflow will publish -- but
// "fetching a published tag" is a DIFFERENT claim and is proven at first release, not here.
//
// SAFETY: prod account (only one with WfP), everything rollins-verify- prefixed, torn down after.

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CfApi } from "../src/cf-api";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.CF_PROVISIONER_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DIR = process.env.STUDIO_RELEASE_DIR;
const LIVE = Boolean(TOKEN && ACCOUNT && DIR);

interface Manifest {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  worker: { path: string; sha256: string; size: number };
  assets: { path: string; hash: string; size: number; content_type: string }[];
}

const stamp = `rollins-verify-${Date.now().toString(36)}`;
const SCRIPT = "tenant-real-studio";
const cf = LIVE ? new CfApi(ACCOUNT!, TOKEN!) : (null as unknown as CfApi);
const state: { ns?: string; dbId?: string; bucket?: string } = {};

const manifest: Manifest | null = LIVE
  ? (JSON.parse(readFileSync(join(DIR!, "manifest.json"), "utf8")) as Manifest)
  : null;

afterAll(async () => {
  if (!LIVE) return;
  const drop = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { console.warn(`LEFTOVER ${what}: ${String(e).slice(0, 120)}`); }
  };
  if (state.ns) {
    await drop("script", () => cf.deleteUserWorker(state.ns!, SCRIPT));
    await drop("namespace", async () => {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${state.ns}`,
        { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });
  }
  if (state.bucket) await drop("bucket", () => cf.deleteR2Bucket(state.bucket!));
  if (state.dbId) await drop("d1", () => cf.deleteD1(state.dbId!));
});

describe.skipIf(!LIVE)("wfp_upload with the REAL studio bundle", () => {
  it("the artifact's worker matches its own manifest sha256 (integrity BEFORE we ship it)", () => {
    // Refuse to upload a bundle we cannot identify: a truncated or wrong-tag artifact reaching a
    // paying tenant's studio is worse than a failed provision.
    const bytes = readFileSync(join(DIR!, manifest!.worker.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest!.worker.sha256);
    expect(bytes.length).toBe(manifest!.worker.size);
  });

  it("uploads the REAL bundle + 42 real assets into a dispatch namespace", async () => {
    const nsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: stamp }),
    });
    expect(nsRes.ok, `namespace create HTTP ${nsRes.status}`).toBe(true);
    state.ns = stamp;

    const db = await cf.createD1(stamp);
    state.dbId = db.uuid;
    await cf.createR2Bucket(stamp);
    state.bucket = stamp;

    // Assets: the 3-step session flow. This is the leg the spike never proved.
    const byHash = new Map(manifest!.assets.map((a) => [a.hash, a]));
    const manifestBody: Record<string, { hash: string; size: number }> = {};
    for (const a of manifest!.assets) manifestBody[a.path] = { hash: a.hash, size: a.size };

    const session = await cf.createAssetsUploadSession(state.ns, SCRIPT, manifestBody);
    let jwt = session.jwt;
    for (const bucket of session.buckets ?? []) {
      const files = bucket.map((h) => {
        const a = byHash.get(h)!;
        return {
          hash: h,
          base64: readFileSync(join(DIR!, "assets", h)).toString("base64"),
          contentType: a.content_type,
        };
      });
      if (!files.length) continue;
      const res = await cf.uploadAssetBucket(session.jwt ?? "", files);
      if (res.jwt) jwt = res.jwt;
    }

    await cf.uploadUserWorker({
      namespace: state.ns,
      scriptName: SCRIPT,
      mainModule: manifest!.main_module,
      moduleText: readFileSync(join(DIR!, manifest!.worker.path), "utf8"),
      compatibilityDate: manifest!.compatibility_date,
      compatibilityFlags: manifest!.compatibility_flags,
      assetsJwt: jwt,
      bindings: [
        { type: "d1", name: "DB", id: db.uuid },
        { type: "r2_bucket", name: "R2_RENDERS", bucket_name: state.bucket },
        { type: "r2_bucket", name: "R2", bucket_name: state.bucket },
        { type: "plain_text", name: "AUTH_MODE", text: "token" },
        { type: "secret_text", name: "STUDIO_API_TOKEN", text: "livetest-not-a-real-token" },
      ],
    });
  }, 180_000);

  it("the uploaded tenant worker carries the bindings the provisioner asked for", async () => {
    const names = new Set((await cf.getScriptBindings(state.ns!, SCRIPT)).map((b) => b.name));
    for (const want of ["DB", "R2_RENDERS", "R2", "AUTH_MODE"]) expect(names, want).toContain(want);
    expect(await cf.getScriptSecretNames(state.ns!, SCRIPT)).toContain("STUDIO_API_TOKEN");
  });
});
