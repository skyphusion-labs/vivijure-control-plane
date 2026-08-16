// cp#285: a plane that cannot mint proxy tokens must not OFFER the shared tier at all.
//
// WHY THIS EXISTS AS A GATE RATHER THAN A CHECK AT THE POINT OF USE. Conrad ruled 2026-08-03 that
// the hosted tier holds no RunPod key it could extract, in any fashion. A shared tenant reaches
// RunPod through the plane proxy or not at all -- so a plane with no CONTROL_PLANE_HOST or no
// RUNPOD_PROXY_SIGNING_KEY cannot serve one without handing it the direct key. Refusing the TIER
// makes that impossible by construction; the route answers runpod_key_required, which is a tenant
// who cannot provision (loud) rather than a tenant we would have to violate the ruling to serve.
//
// WHAT IT DOES NOT DO, AND WHY THE OTHER GUARD STAYS. This makes `shared` imply `proxied` at the
// moment `runpod_mode` is WRITTEN. It does not hold for a tenant's lifetime: the row stays `shared`
// for ever, so an operator who later removes the signing key leaves existing shared tenants whose
// next key install finds no proxy. installInvokeKey therefore keeps its own predicate
// (tenantModuleProxyBinding, #320). This narrows the window; that closes it. Asserted below so
// nobody deletes one believing the other covers it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { provisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import type { ControlPlaneStore } from "../src/store";

// NON-DEFAULT VALUES: on `studio.vivijure.com` a derived base and a hardcoded one are identical.
const HOST = "plane.nondefault-cp285.test";
const SIGNING_KEY = "cp285-signing-key-not-the-default";
// A pool whose shape parseSharedPool accepts. Ids and names are distinctive so a binding that
// silently carried something else would be visible rather than plausible.
//
// ONLY the ENDPOINT-BACKED keys (cp#396). upscale and audio-upscale run on hardware we operate and
// are reached over a Workers VPC binding, so parseSharedPool REFUSES a pool that names either --
// naming one here would make every case in this file fail on the pool rather than on the proxy,
// which is the fixture testing itself instead of the gate.
const POOL = JSON.stringify({
  backend: { id: "ep-cp285-backend", name: "pool-backend" },
  lipsync: { id: "ep-cp285-lipsync", name: "pool-lipsync" },
  "wan-train": { id: "ep-cp285-wan-train", name: "pool-wan-train" },
});

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    CF_PROVISIONER_TOKEN: "cf-token",
    CF_ACCOUNT_ID: "acct",
    DISPATCH_NAMESPACE: "vivijure-tenants",
    TENANT_MODULE_NAMESPACE: "vivijure-tenant-modules",
    STUDIO_RELEASE: "v1.0.0",
    STUDIO_RELEASES: {} as R2Bucket,
    STUDIO_TOKEN_KEK: btoa("0123456789abcdef0123456789abcdef"),
    TENANT_DISPATCH: {} as DispatchNamespace,
    CONTROL_PLANE_HOST: HOST,
    RUNPOD_PROXY_SIGNING_KEY: SIGNING_KEY,
    SHARED_RUNPOD_ENDPOINTS: POOL,
    SHARED_RUNPOD_INVOKE_KEY: "rpa_pool_invoke_NOT_A_DEFAULT",
    ...over,
  }) as ControlPlaneEnv;

const wiring = (e: ControlPlaneEnv) => provisionerWiring(e, {} as ControlPlaneStore)!;

let errors: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  errors = [];
});
const captureErrors = () => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
};

// ---- 0. THE POSITIVE CONTROL, FIRST --------------------------------------------------------
// Every refusal below is worthless if the fully-configured plane also refuses. Run the claim that
// must SUCCEED before any claim that must fail (control-first: a failed control arriving after the
// result is a line you narrate past, arriving before it is a gate that stops the work).

describe("CONTROL: a fully configured plane DOES offer the shared tier", () => {
  it("offersSharedTier() is true and the pool invoke key resolves", () => {
    const w = wiring(env());
    expect(w.offersSharedTier()).toBe(true);
    expect(w.sharedPoolInvokeKey()).not.toBeNull();
  });
});

// ---- 1. THE NEW THIRD HALF -----------------------------------------------------------------

describe("no proxy config -> the plane does NOT offer the shared tier (cp#285)", () => {
  it("refuses with the signing key absent, even though BOTH pool vars are set", () => {
    captureErrors();
    const w = wiring(env({ RUNPOD_PROXY_SIGNING_KEY: undefined }));
    expect(w.offersSharedTier()).toBe(false);
    // The key must not leak out on the refused path either: a null pool must not still hand back a
    // credential a caller could pass to performInvokeKeyInstall.
    expect(w.sharedPoolInvokeKey()).toBeNull();
    expect(errors.join("\n")).toMatch(/cannot mint proxy tokens/);
  });

  it("refuses with CONTROL_PLANE_HOST absent", () => {
    captureErrors();
    const w = wiring(env({ CONTROL_PLANE_HOST: undefined }));
    expect(w.offersSharedTier()).toBe(false);
    expect(w.sharedPoolInvokeKey()).toBeNull();
  });

  it("an EMPTY host is absent, not a base of empty string", () => {
    // ALLOW_EMPTY vars arrive as "" rather than undefined (the cp#218 shape), which is the form the
    // failure actually takes on a real deploy.
    captureErrors();
    expect(wiring(env({ CONTROL_PLANE_HOST: "" })).offersSharedTier()).toBe(false);
    expect(wiring(env({ RUNPOD_PROXY_SIGNING_KEY: "   " })).offersSharedTier()).toBe(false);
  });

  it("NAMES the proxy as the reason, distinguishably from the other two refusals", () => {
    // Three causes, three repairs. An operator who has set both pool vars and still has no shared
    // tier must not be handed a message about the vars they already set.
    captureErrors();
    wiring(env({ RUNPOD_PROXY_SIGNING_KEY: undefined }));
    const proxyRefusal = errors.join("\n");
    captureErrors();
    wiring(env({ SHARED_RUNPOD_INVOKE_KEY: undefined }));
    const keyRefusal = errors.join("\n");
    expect(proxyRefusal).toMatch(/cannot mint proxy tokens/);
    expect(keyRefusal).toMatch(/SHARED_RUNPOD_INVOKE_KEY is not/);
    // CONTROL: the two messages are genuinely different, so "distinguishable" is asserted rather
    // than assumed. Without this, one message covering both states would pass both lines above.
    expect(proxyRefusal).not.toEqual(keyRefusal);
  });
});

// ---- 2. NOTHING ELSE MOVED ------------------------------------------------------------------

describe("the pre-existing refusals are unchanged", () => {
  it("no pool vars at all -> no shared tier, and NO refusal logged (nobody asked)", () => {
    captureErrors();
    const w = wiring(env({ SHARED_RUNPOD_ENDPOINTS: undefined, SHARED_RUNPOD_INVOKE_KEY: undefined }));
    expect(w.offersSharedTier()).toBe(false);
    // Silence is correct here: a plane that never asked for a shared tier is not misconfigured, and
    // logging a refusal would train operators to ignore the line that matters.
    expect(errors.join("\n")).not.toMatch(/shared_pool.refused/);
  });

  it("malformed endpoints -> refused, with the parser's own detail", () => {
    captureErrors();
    expect(wiring(env({ SHARED_RUNPOD_ENDPOINTS: "{not json" })).offersSharedTier()).toBe(false);
    expect(errors.join("\n")).toMatch(/not JSON/);
  });
});

// ---- 3. THE TWO GUARDS ARE INDEPENDENT ------------------------------------------------------

describe("this gate does NOT make installInvokeKey's predicate redundant", () => {
  it("the residual it cannot cover: a row already marked shared on a plane that lost its proxy", () => {
    // offersSharedTier gates PROVISIONING. `runpod_mode` is written once and lives for ever, so a
    // plane whose signing key is removed later still has shared rows whose next key install finds
    // no proxy. This asserts the gate is false there -- i.e. that the window is real -- which is
    // the reason tenantModuleProxyBinding stays. If someone deletes that predicate believing this
    // gate covers it, the case below is what they have missed.
    const w = wiring(env({ RUNPOD_PROXY_SIGNING_KEY: undefined }));
    expect(w.offersSharedTier()).toBe(false);
    // And the plane still cannot hand out a pool key on that shape, which is the containment.
    expect(w.sharedPoolInvokeKey()).toBeNull();
  });
});
