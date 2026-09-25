// cp#399: the MemoryStore double implements the live-owner exception on
// claimResourceOwnership. The interface comment used to deny that exception
// (it said INSERT OR REPLACE), and the only existing test drove D1Store.
// Deleting the early return in tests/memory-store.ts then stayed green across
// every suite that uses the double. This file is the thing that must redden.

import { describe, it, expect } from "vitest";
import { MemoryStore } from "./memory-store";

const D1_ID = "db-shared-0001";

describe("MemoryStore claimResourceOwnership (cp#399 / cp#106 D)", () => {
  it("does not steal ownership from a LIVE tenant", async () => {
    const store = new MemoryStore();
    await store.createTenant("ten_live", "live-slug", "acct_1", "live");
    await store.setTenantD1("ten_live", D1_ID);
    expect(await store.getResourceOwner("d1", D1_ID)).toBe("ten_live");

    await store.createTenant("ten_new", "new-slug", "acct_1", "provisioning");
    await store.setTenantD1("ten_new", D1_ID);
    expect(await store.getResourceOwner("d1", D1_ID)).toBe("ten_live");
  });

  it("CONTROL: a tombstone prior owner DOES yield, so the live-owner test is not an always-refuse", async () => {
    const store = new MemoryStore();
    await store.createTenant("ten_old", "old-slug", "acct_1", "deleted");
    await store.setTenantD1("ten_old", D1_ID);
    expect(await store.getResourceOwner("d1", D1_ID)).toBe("ten_old");

    await store.createTenant("ten_new", "new-slug", "acct_1", "provisioning");
    await store.setTenantD1("ten_new", D1_ID);
    expect(await store.getResourceOwner("d1", D1_ID)).toBe("ten_new");
  });

  it("CONTROL: a failed prior owner also yields (same exception as deleted)", async () => {
    const store = new MemoryStore();
    await store.createTenant("ten_fail", "fail-slug", "acct_1", "failed");
    await store.setTenantD1("ten_fail", D1_ID);

    await store.createTenant("ten_new", "new-slug", "acct_1", "provisioning");
    await store.setTenantD1("ten_new", D1_ID);
    expect(await store.getResourceOwner("d1", D1_ID)).toBe("ten_new");
  });
});
