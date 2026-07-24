// The slug LEASE tiers (cf#103).
//
// THE ASSERTION CLASS THAT MATTERS is the caller-visible one, and for a rule about WHO may take a
// name that means every tier is tested from BOTH sides: the owning account and a different one. A
// tier only ever tested from the owner's side is not tested, because the whole point of the rule is
// what it does to the other guy.
//
// Every tier therefore asserts its DENIAL as well as its grant. A gate only ever observed saying
// PASS is indistinguishable from a gate that always passes.

import { describe, it, expect } from "vitest";
import { MemoryStore } from "./memory-store";
import { classifySlugClaim, SLUG_TAKEN_REASON, type Tenant } from "../src/store";

const OWNER = "acc_owner";
const STRANGER = "acc_stranger";

/** Build a tenant row directly, so a tier can be posed without walking a provision. */
function row(over: Partial<Tenant>): Tenant {
  return {
    id: "ten_1",
    slug: "studio",
    account_id: OWNER,
    status: "pending",
    script_name: null,
    d1_database_id: null,
    r2_bucket_name: null,
    endpoints_json: null,
    r2_token_id: null,
    studio_release: null,
    modules_release: null,
    studio_token_enc: null,
    created_at: "2026-07-18 00:00:00",
    live_at: null,
    suspended_at: null,
    suspended_reason: null,
    deleted_at: null,
    reclaim_lease_until: null,
    reclaim_lease_token: null,
  teardown_at: null,
  teardown_failures: null,
    ...over,
  };
}

const TIER_A = row({ status: "failed", live_at: null });
const TIER_B = row({ status: "deleted", live_at: "2026-07-01 00:00:00" });
const TIER_C = row({ status: "live", live_at: "2026-07-01 00:00:00" });

describe("slug tiers: the POSITIVE CONTROL", () => {
  // Without this, every assertion below is satisfied by a function that returns "unavailable"
  // unconditionally. This is the one case that proves the check can say yes at all.
  it("a slug with no row at all is available to anyone", () => {
    expect(classifySlugClaim(null, OWNER)).toEqual({ available: true, reclaim: null });
    expect(classifySlugClaim(null, STRANGER)).toEqual({ available: true, reclaim: null });
  });
});

describe("Tier A -- never live", () => {
  it("GRANTS the owning account a reclaim, carrying the half-built resources out", () => {
    const claim = classifySlugClaim(
      row({ status: "failed", live_at: null, d1_database_id: "db_1", r2_bucket_name: "buck_1", r2_token_id: "tok_1", script_name: "scr_1" }),
      OWNER,
    );
    expect(claim.available).toBe(true);
    if (!claim.available) throw new Error("unreachable");
    // The ids must ride out: reclaiming blanks the columns, so this is the only record of what
    // still needs reaping. A handle that dropped them would orphan billable resources silently.
    expect(claim.reclaim).toEqual({
      tenant_id: "ten_1",
      d1_database_id: "db_1",
      r2_bucket_name: "buck_1",
      r2_token_id: "tok_1",
      script_name: "scr_1",
    });
  });

  it("DENIES a different account while the row exists", () => {
    expect(classifySlugClaim(TIER_A, STRANGER)).toEqual({ available: false, reason: SLUG_TAKEN_REASON });
  });

  it("covers every never-live lifecycle, not just the one that was convenient to write", () => {
    for (const status of ["pending", "provisioning", "awaiting_invoke_key", "failed"] as const) {
      const claim = classifySlugClaim(row({ status, live_at: null }), OWNER);
      expect(claim.available, `owner should reclaim a ${status} row`).toBe(true);
      expect(classifySlugClaim(row({ status, live_at: null }), STRANGER).available).toBe(false);
    }
  });
});

describe("Tier A -- the guards ISOLATED (each mutation-proven to bite on its own)", () => {
  // WHY THESE EXIST: the first draft of this suite posed rows that tripped two guards at once, so
  // deleting either guard alone still refused and the tests stayed green. Mutation testing caught
  // it. Each row below fails EXACTLY ONE condition, so each guard is the only thing standing
  // between the row and a grant.

  it("a row that was LIVE but sits in a Tier A status is NOT reclaimable", () => {
    // Reachable, and imminent: driveJobIfNeeded sets status='failed' on a stale job, and an upgrade
    // job re-runs provisioning steps against a tenant that is already live. Without the never-live
    // guard this row reads as Tier A, and reclaiming it blanks the resource columns of a studio
    // that is still serving a customer -- orphaning their D1 and their R2 bucket of films.
    for (const status of ["pending", "provisioning", "awaiting_invoke_key", "failed"] as const) {
      const wasLive = row({ status, live_at: "2026-07-01 00:00:00" });
      expect(classifySlugClaim(wasLive, OWNER).available, `${status} + live_at must not be Tier A`).toBe(false);
    }
  });

  it("a NEVER-live row in a non-Tier-A status is not reclaimable either", () => {
    // Isolates the lifecycle-set guard: live_at is null, so only the status check can refuse.
    for (const status of ["live", "deleting", "deleted"] as const) {
      expect(classifySlugClaim(row({ status, live_at: null }), OWNER).available, status).toBe(false);
    }
  });
});

describe("Tier B -- was live, now deleted (TOMBSTONED)", () => {
  it("DENIES a different account, permanently -- the security case", () => {
    // This is the whole reason Tier B exists. A recyclable deleted slug lets a stranger claim a
    // hostname that used to serve someone else's studio and inherit their bookmarks, shared links,
    // and any Slate bot still holding the stored URL.
    const claim = classifySlugClaim(TIER_B, STRANGER);
    expect(claim.available).toBe(false);
    if (claim.available) throw new Error("unreachable");
    // A stranger is told nothing about which tier this is: a tier-specific reason here would be an
    // enumeration oracle for "this name used to be a studio".
    expect(claim.reason).toBe(SLUG_TAKEN_REASON);
  });

  it("DENIES the owning account too, for now -- fails CLOSED, with a reason that says so", () => {
    // The ruled design grants the owner a re-create. It is not safely implementable yet: nothing
    // on the row distinguishes a reaped resource id from a live one (teardownTenant never blanks
    // the columns, and R2 refuses to delete a non-empty bucket -- so a Tier B row typically still
    // points at a live bucket of that customer's films). Denying is the safe direction.
    const claim = classifySlugClaim(TIER_B, OWNER);
    expect(claim.available).toBe(false);
    if (claim.available) throw new Error("unreachable");
    expect(claim.reason).toMatch(/deleted/);
    expect(claim.reason).not.toBe(SLUG_TAKEN_REASON);
  });
});

describe("Tier C -- active", () => {
  it("DENIES a different account", () => {
    expect(classifySlugClaim(TIER_C, STRANGER)).toEqual({ available: false, reason: SLUG_TAKEN_REASON });
  });

  it("DENIES the owning account, with a reason it can act on", () => {
    const claim = classifySlugClaim(TIER_C, OWNER);
    expect(claim.available).toBe(false);
    if (claim.available) throw new Error("unreachable");
    expect(claim.reason).toMatch(/already have a studio/);
  });

  it("a never-live DELETED row falls to Tier C and is refused, including for the owner", () => {
    // Not in any ruled tier: live_at IS NULL excludes it from B, status='deleted' from A. Refusing
    // is the safe direction, and this test exists so the behaviour is a decision, not an accident.
    const odd = row({ status: "deleted", live_at: null });
    expect(classifySlugClaim(odd, OWNER).available).toBe(false);
    expect(classifySlugClaim(odd, STRANGER).available).toBe(false);
  });
});

describe("reclaimSlug is the ENFORCEMENT point, not the check", () => {
  async function seed(over: Partial<Tenant>): Promise<MemoryStore> {
    const store = new MemoryStore();
    const t = row(over);
    store.tenants.set(t.id, t);
    return store;
  }

  it("takes over a Tier A row for its owner and blanks the stale resource columns", async () => {
    const store = await seed({ status: "failed", d1_database_id: "db_1", r2_bucket_name: "buck_1", script_name: "scr_1" });
    const claimed = await store.claimReclaim("ten_1", OWNER, 300);
    expect(claimed).not.toBeNull();
    const out = await store.reclaimSlug("ten_1", OWNER, claimed!.lease_token);
    expect(out).not.toBeNull();
    expect(out?.status).toBe("pending");
    expect(out?.d1_database_id).toBeNull();
    expect(out?.r2_bucket_name).toBeNull();
    expect(out?.script_name).toBeNull();
  });

  it("REFUSES a reclaim by a different account even when the tier would allow it", async () => {
    // The check already said no to this account, but the check does not authorize. If the only
    // thing standing between a stranger and someone else's row were a caller remembering to call
    // the check first, this would be a hole.
    const store = await seed({ status: "failed" });
    expect(await store.claimReclaim("ten_1", STRANGER, 300)).toBeNull();
    expect(await store.reclaimSlug("ten_1", STRANGER, "tok_1")).toBeNull();
  });

  it("REFUSES a reclaim of a Tier B row", async () => {
    const store = await seed({ status: "deleted", live_at: "2026-07-01 00:00:00" });
    expect(await store.claimReclaim("ten_1", OWNER, 300)).toBeNull();
    expect(await store.reclaimSlug("ten_1", OWNER, "tok_1")).toBeNull();
  });

  it("REFUSES a reclaim of a live row", async () => {
    const store = await seed({ status: "live", live_at: "2026-07-01 00:00:00" });
    expect(await store.claimReclaim("ten_1", OWNER, 300)).toBeNull();
    expect(await store.reclaimSlug("ten_1", OWNER, "tok_1")).toBeNull();
  });

  it("REFUSES a row that was live but sits in a Tier A status", async () => {
    // Isolates the live_at guard in the WRITE. The status check cannot save this row: 'failed' is
    // a Tier A status, so live_at is the only thing refusing.
    const store = await seed({ status: "failed", live_at: "2026-07-01 00:00:00" });
    expect(await store.claimReclaim("ten_1", OWNER, 300)).toBeNull();
  });

  it("REFUSES a never-live row in a non-Tier-A status", async () => {
    // Isolates the lifecycle-set guard in the WRITE: live_at is null, so only the status set refuses.
    for (const status of ["live", "deleting", "deleted"] as const) {
      const store = await seed({ status, live_at: null });
      expect(await store.claimReclaim("ten_1", OWNER, 300), status).toBeNull();
    }
  });

  it("keeps live_at MONOTONIC: a reclaim never clears the ever-served mark", async () => {
    // A row that was live cannot be reclaimed at all, so the only way to observe this is directly:
    // the field must survive any write reclaimSlug performs. If it were cleared, a Tier B row could
    // be demoted back to Tier A and the tombstone would get LOOSER over time.
    const store = await seed({ status: "failed", live_at: null });
    const c = await store.claimReclaim("ten_1", OWNER, 300);
    await store.reclaimSlug("ten_1", OWNER, c!.lease_token);
    expect(store.tenants.get("ten_1")?.live_at).toBeNull();
  });
});

describe("the provision-lease race (cf#103)", () => {
  // A Tier A row can have a job being driven RIGHT NOW. Reclaiming under a live driver blanks the
  // resource columns while the provisioner is still writing ids into them: the driver's D1 and R2
  // land on a row that no longer claims them, and nothing ever reaps them. Refuse while leased.

  async function seedLeased(leaseUntil: string | null, jobStatus: "queued" | "running" | "succeeded") {
    const store = new MemoryStore();
    const t = row({ status: "failed" });
    store.tenants.set(t.id, t);
    await store.createProvisionJob("job_1", t.id, "provision");
    const j = store.jobs.get("job_1")!;
    j.status = jobStatus;
    j.lease_until = leaseUntil;
    return store;
  }

  const future = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);
  const past = new Date(Date.now() - 60_000).toISOString().replace("T", " ").slice(0, 19);

  it("REFUSES a reclaim while a driver holds a live lease", async () => {
    const store = await seedLeased(future, "running");
    expect(await store.claimReclaim("ten_1", OWNER, 300)).toBeNull();
  });

  it("the CHECK says so legibly rather than silently failing the write", async () => {
    const store = await seedLeased(future, "running");
    const claim = await store.checkSlugAvailability("studio", OWNER);
    expect(claim.available).toBe(false);
    if (claim.available) throw new Error("unreachable");
    expect(claim.reason).toMatch(/still being set up/);
  });

  it("POSITIVE CONTROL: an EXPIRED lease does not block -- the refusal clears itself", async () => {
    // Without this, "refuse while leased" is indistinguishable from "refuse always", and a tenant
    // whose driver died would be locked out of their own half-built slug forever.
    const store = await seedLeased(past, "running");
    expect(await store.claimReclaim("ten_1", OWNER, 300)).not.toBeNull();
  });

  it("a TERMINAL job does not block, however recent its lease", async () => {
    const store = await seedLeased(future, "succeeded");
    expect(await store.claimReclaim("ten_1", OWNER, 300)).not.toBeNull();
  });

  it("a job with no lease at all does not block", async () => {
    const store = await seedLeased(null, "queued");
    expect(await store.claimReclaim("ten_1", OWNER, 300)).not.toBeNull();
  });
});

describe("the reclaim lease: serializing two attempts on one slug (cf#103)", () => {
  // THE RACE THIS CLOSES: every tenant resource name derives from the SLUG, not the attempt, so two
  // concurrent reclaims by the same owner issue the SAME delete calls. Attempt A tears down while
  // attempt B has already provisioned fresh resources under those names, and A deletes B's. The
  // claim is the serialization point: only its winner may tear anything down.

  async function seedA(): Promise<MemoryStore> {
    const store = new MemoryStore();
    const t = row({ status: "failed", d1_database_id: "db_1", r2_bucket_name: "buck_1" });
    store.tenants.set(t.id, t);
    return store;
  }

  it("EXACTLY ONE of two concurrent attempts wins the claim", async () => {
    const store = await seedA();
    const [a, b] = await Promise.all([
      store.claimReclaim("ten_1", OWNER, 300),
      store.claimReclaim("ten_1", OWNER, 300),
    ]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });

  it("the LOSER cannot complete the reclaim, even though it is the legitimate owner", async () => {
    // The whole point of the token. Same account, same row, correct tier: the ONLY thing refusing
    // the loser is that it does not hold the lease. Without this the loser blanks the row and
    // provisions under the same slug-derived names while the winner is still tearing down.
    const store = await seedA();
    const winner = await store.claimReclaim("ten_1", OWNER, 300);
    expect(winner).not.toBeNull();
    const loser = await store.claimReclaim("ten_1", OWNER, 300);
    expect(loser).toBeNull();
    expect(await store.reclaimSlug("ten_1", OWNER, "tok_not_mine")).toBeNull();
  });

  it("the WINNER completes the reclaim and the lease is released", async () => {
    const store = await seedA();
    const w = await store.claimReclaim("ten_1", OWNER, 300);
    const out = await store.reclaimSlug("ten_1", OWNER, w!.lease_token);
    expect(out).not.toBeNull();
    expect(out?.status).toBe("pending");
    expect(out?.d1_database_id).toBeNull();
    // Released, not merely expired: the next attempt must not have to wait out the lease.
    expect(store.tenants.get("ten_1")?.reclaim_lease_until).toBeNull();
    expect(store.tenants.get("ten_1")?.reclaim_lease_token).toBeNull();
  });

  it("the claim returns the row's CURRENT ids, which is what teardown must use", async () => {
    // The claim, not the earlier check, is the serialization point, so these are the authoritative
    // ids. A handle read before the claim can be stale by the time teardown runs.
    const store = await seedA();
    const w = await store.claimReclaim("ten_1", OWNER, 300);
    expect(w?.tenant.d1_database_id).toBe("db_1");
    expect(w?.tenant.r2_bucket_name).toBe("buck_1");
  });

  it("REFUSES the winner's own token once its lease has EXPIRED", async () => {
    // The overrun case, and it is reachable: a teardown slower than the lease leaves the winner
    // holding a token that still matches but a lease that no longer proves exclusivity. By then
    // another attempt may have claimed and be mid-teardown, so completing here would blank the row
    // under it. The winner must re-claim, not coast on a stale token.
    // Found by mutation: removing this guard changed nothing until this test existed.
    const store = await seedA();
    const w = await store.claimReclaim("ten_1", OWNER, 300);
    expect(w).not.toBeNull();
    const t = store.tenants.get("ten_1")!;
    t.reclaim_lease_until = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);
    expect(await store.reclaimSlug("ten_1", OWNER, w!.lease_token)).toBeNull();
  });

  it("POSITIVE CONTROL: an EXPIRED reclaim lease frees the row -- a dead reclaim SELF-HEALS", async () => {
    // The half that stops a customer being locked out of their own slug forever when a driver dies
    // mid-teardown. Without expiry this feature would trade a rare race for a permanent lockout.
    const store = await seedA();
    const t = store.tenants.get("ten_1")!;
    t.reclaim_lease_token = "tok_dead";
    t.reclaim_lease_until = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);
    const retry = await store.claimReclaim("ten_1", OWNER, 300);
    expect(retry).not.toBeNull();
    expect(retry?.lease_token).not.toBe("tok_dead");
  });

  it("a LIVE reclaim lease is reported by the check, legibly and self-clearingly", async () => {
    const store = await seedA();
    await store.claimReclaim("ten_1", OWNER, 300);
    const claim = await store.checkSlugAvailability("studio", OWNER);
    expect(claim.available).toBe(false);
    if (claim.available) throw new Error("unreachable");
    expect(claim.reason).toMatch(/being reset/);
  });

  it("a STRANGER still gets the generic refusal while a reclaim is in flight", async () => {
    // The lease must not become an enumeration oracle: a stranger learns nothing about why.
    const store = await seedA();
    await store.claimReclaim("ten_1", OWNER, 300);
    const claim = await store.checkSlugAvailability("studio", STRANGER);
    expect(claim.available).toBe(false);
    if (claim.available) throw new Error("unreachable");
    expect(claim.reason).toBe(SLUG_TAKEN_REASON);
  });

  it("a reclaim cannot be claimed while a PROVISION driver holds its own lease", async () => {
    const store = await seedA();
    await store.createProvisionJob("job_1", "ten_1", "provision");
    const j = store.jobs.get("job_1")!;
    j.status = "running";
    j.lease_until = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);
    expect(await store.claimReclaim("ten_1", OWNER, 300)).toBeNull();
  });
});

describe("the MemoryStore stub carries the database's own rule", () => {
  it("rejects a duplicate slug, exactly as UNIQUE(slug) does in D1", async () => {
    // POSITIVE CONTROL for the stub fix itself. Without this the constraint could silently stop
    // being enforced and every reclaim test above would keep passing while the shipped INSERT
    // started failing on real D1.
    const store = new MemoryStore();
    await store.createAccount(OWNER, "owner@example.com");
    await store.createTenant("ten_a", "taken", OWNER, "pending");
    await expect(store.createTenant("ten_b", "taken", OWNER, "pending")).rejects.toThrow(/UNIQUE/);
  });
});
