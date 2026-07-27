// cp#169: the operator-initiated, owner-completed invoke-key handoff.
//
// WHAT THIS SUITE IS FOR. Before this change a reprovision ended at a route only the account owner
// could call, so an operator repair stranded at 95% every time. The mechanism that closes it hands
// a credential-install authorization to whoever holds a link, which is exactly the kind of thing
// that deserves its refusals asserted rather than described.
//
// THE FOUR CLAIMS WORTH PROVING HERE, and each has a POSITIVE CONTROL so it cannot pass vacuously:
//   1. the token VALUE is never stored (only its hash), so a D1 dump yields no usable link;
//   2. a handoff is bound to a TENANT and to a SET OF ENDPOINT IDS, and goes stale when those ids
//      change -- otherwise the repair mechanism can install a key for endpoints that no longer
//      exist, which is the state it exists to repair;
//   3. single-use is enforced by the store's conditional UPDATE, so a replay consumes nothing;
//   4. every refusal the INSTALL would make is made at MINT time, so a link that could only ever
//      end in a 409 is never handed to a customer.

import { describe, expect, it, beforeEach } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  HANDOFF_TOKEN_PARAM,
  HANDOFF_TTL_HOURS,
  burnInvokeKeyHandoff,
  handoffEndpoints,
  handoffUrl,
  mintInvokeKeyHandoff,
  resolveInvokeKeyHandoff,
  type HandoffDeps,
} from "../src/invoke-key-handoff";
import type { Tenant } from "../src/store";
import { MemoryStore } from "./memory-store";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const ORIGIN = "https://studio.example.com";
const TOKEN = "t".repeat(64);
const FOUR = [
  { key: "backend", label: "Render", id: "ep1", name: "vivijure-hero-backend" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "vivijure-hero-upscale" },
  { key: "lipsync", label: "Lip sync", id: "ep3", name: "vivijure-hero-musetalk" },
  { key: "audio-upscale", label: "Audio upscale", id: "ep4", name: "vivijure-hero-audio" },
];

let store: MemoryStore;
let issued: string[];

function deps(over: Partial<HandoffDeps> = {}): HandoffDeps {
  return {
    store,
    now: () => NOW,
    // Sequenced rather than constant, so a test can mint two DIFFERENT handoffs and tell them apart.
    randomToken: () => issued.shift() ?? TOKEN,
    newHandoffId: () => "ikh_fixed",
    sha256Hex,
    ...over,
  };
}

async function seedTenant(over: Partial<Tenant> = {}): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_1", "hero", "acct_1", "awaiting_invoke_key");
  t.endpoints_json = JSON.stringify(FOUR);
  t.script_name = "tenant-hero-studio";
  Object.assign(t, over);
  return t;
}

beforeEach(() => {
  store = new MemoryStore();
  issued = [];
});

describe("minting", () => {
  it("stores the HASH and never the token", async () => {
    const t = await seedTenant();
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // CONTROL: a row was really written, so the absence asserted below is an omission and not an
    // empty store.
    expect(store.handoffs.size).toBe(1);
    const row = [...store.handoffs.values()][0];
    expect(row.token_hash).toBe(await sha256Hex(TOKEN));
    // The token value appears NOWHERE in the persisted row, under any field.
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    // ...and it IS in the operator's response, which is the one place it may exist.
    expect(out.minted.url).toContain(TOKEN);
    expect(out.minted.url).toBe(`${ORIGIN}/install-key?${HANDOFF_TOKEN_PARAM}=${TOKEN}`);
  });

  it("binds the handoff to the tenant and to the endpoint ids that exist NOW", async () => {
    const t = await seedTenant();
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    if (!out.ok) throw new Error("mint refused: " + out.refusal.code);
    const row = [...store.handoffs.values()][0];
    expect(row.tenant_id).toBe("ten_1");
    expect(handoffEndpoints(row)).toEqual(["ep1", "ep2", "ep3", "ep4"]);
    expect(out.minted.endpoints).toEqual(["ep1", "ep2", "ep3", "ep4"]);
    expect(row.issued_by).toBe("admin-token");
  });

  it("expires at the declared TTL, not at some other number", async () => {
    const t = await seedTenant();
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    if (!out.ok) throw new Error("mint refused");
    expect(out.minted.expires_at).toBe(new Date(NOW + HANDOFF_TTL_HOURS * 3600000).toISOString());
  });

  it("REFUSES a tenant with no endpoints: there would be nothing to scope a key to", async () => {
    // Made at MINT time on purpose. The operator learns this at the console instead of the customer
    // discovering it after being sent a link that could only ever 409.
    const t = await seedTenant({ endpoints_json: null });
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("no_endpoints");
    expect(store.handoffs.size).toBe(0);
  });

  it("REFUSES a tenant with no studio script: a key would have nowhere to land", async () => {
    const t = await seedTenant({ script_name: null });
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("not_provisioned");
    expect(store.handoffs.size).toBe(0);
  });

  it("REFUSES a deleted tenant", async () => {
    const t = await seedTenant({ deleted_at: "2026-07-01T00:00:00.000Z" });
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("tenant_deleted");
  });
});

describe("resolving a link", () => {
  async function mint(): Promise<string> {
    const t = await seedTenant();
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    if (!out.ok) throw new Error("mint refused: " + out.refusal.code);
    return TOKEN;
  }

  it("POSITIVE CONTROL: a fresh link resolves, and reports the tenant's CURRENT endpoints", async () => {
    const token = await mint();
    const out = await resolveInvokeKeyHandoff(deps(), token);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.context.tenant.id).toBe("ten_1");
    expect(out.context.endpoints).toEqual(["ep1", "ep2", "ep3", "ep4"]);
    // Resolving must NOT consume: the page reads context before the owner has anything to submit.
    expect([...store.handoffs.values()][0].consumed_at).toBeNull();
  });

  it("refuses an unknown token WITHOUT saying anything about which tenants exist", async () => {
    await mint();
    const out = await resolveInvokeKeyHandoff(deps(), "z".repeat(64));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("handoff_unknown");
    expect(out.refusal.status).toBe(404);
  });

  it("refuses an EMPTY token rather than hashing the empty string and looking it up", async () => {
    const out = await resolveInvokeKeyHandoff(deps(), "");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("handoff_unknown");
  });

  it("distinguishes EXPIRED from unknown, because the reader's next action differs", async () => {
    const token = await mint();
    const later = deps({ now: () => NOW + (HANDOFF_TTL_HOURS + 1) * 3600000 });
    const out = await resolveInvokeKeyHandoff(later, token);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("handoff_expired");
    expect(out.refusal.status).toBe(410);
  });

  it("distinguishes CONSUMED, and tells the reader not to paste again", async () => {
    const token = await mint();
    const row = [...store.handoffs.values()][0];
    expect(await burnInvokeKeyHandoff(deps(), row)).toBe(true);
    const out = await resolveInvokeKeyHandoff(deps(), token);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("handoff_consumed");
    expect(out.refusal.message).toMatch(/rather than re-pasting/i);
  });

  it("REFUSES a link whose endpoints were replaced by a LATER reprovision", async () => {
    // The staleness case, and the one that matters most: without it, a link issued before a second
    // repair would install a key scoped to endpoints that no longer exist -- the exact state this
    // whole mechanism exists to fix, re-entered through the fix.
    const token = await mint();
    const t = store.tenants.get("ten_1") as Tenant;
    t.endpoints_json = JSON.stringify([{ id: "ep9" }, { id: "ep8" }, { id: "ep7" }, { id: "ep6" }]);
    const out = await resolveInvokeKeyHandoff(deps(), token);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("handoff_endpoints_changed");
  });

  it("does NOT refuse over endpoint ORDER, which is not a change", async () => {
    // The mirror of the test above, and the reason the comparison is a set: an order-sensitive
    // check would refuse a link that is genuinely fine, sending a customer back for no reason.
    const token = await mint();
    const t = store.tenants.get("ten_1") as Tenant;
    t.endpoints_json = JSON.stringify([...FOUR].reverse());
    const out = await resolveInvokeKeyHandoff(deps(), token);
    expect(out.ok).toBe(true);
  });

  it("refuses when the tenant is gone", async () => {
    const token = await mint();
    (store.tenants.get("ten_1") as Tenant).deleted_at = "2026-07-27T13:00:00.000Z";
    const out = await resolveInvokeKeyHandoff(deps(), token);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe("handoff_tenant_missing");
  });
});

describe("single use", () => {
  it("burns once, and a replay burns nothing", async () => {
    const t = await seedTenant();
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    if (!out.ok) throw new Error("mint refused");
    const row = [...store.handoffs.values()][0];

    // CONTROL: the first burn really consumes, so the false below is a second attempt failing and
    // not a burn that never worked.
    expect(await burnInvokeKeyHandoff(deps(), row)).toBe(true);
    expect(await burnInvokeKeyHandoff(deps(), row)).toBe(false);
    expect([...store.handoffs.values()][0].consumed_at).toBe(new Date(NOW).toISOString());
  });

  it("cannot be burned after expiry: the UPDATE carries the predicate, not the caller", async () => {
    const t = await seedTenant();
    const out = await mintInvokeKeyHandoff(deps(), t, "admin-token", ORIGIN);
    if (!out.ok) throw new Error("mint refused");
    const row = [...store.handoffs.values()][0];
    const later = deps({ now: () => NOW + (HANDOFF_TTL_HOURS + 1) * 3600000 });
    expect(await burnInvokeKeyHandoff(later, row)).toBe(false);
  });
});

describe("the link itself", () => {
  it("is assembled from the plane's own origin, so a differently-hosted plane links to itself", () => {
    expect(handoffUrl("https://studio.example.coop", "abc")).toBe(
      `https://studio.example.coop/install-key?${HANDOFF_TOKEN_PARAM}=abc`,
    );
  });
});
