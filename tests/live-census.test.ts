import { describe, expect, it } from "vitest";
import { listAllBucketNames, listAllD1, type FetchLike } from "./live-census";

// cp#614: the rehearsal sweep read only page 1 of the bucket list, so a bucket that sorted past
// page 1 was never swept. These run offline against a fake API that pages like the real one.

const API = "https://api.example/client/v4";

function fakeBuckets(all: string[], pageSize: number): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const start = Number(u.searchParams.get("cursor") ?? "0");
    const slice = all.slice(start, start + pageSize);
    const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
    return new Response(
      JSON.stringify({ success: true, result: { buckets: slice.map((name) => ({ name })) }, result_info: { cursor: next, total_count: all.length } }),
      { status: 200 },
    );
  };
  return { fetch, calls };
}

describe("listAllBucketNames (cp#614)", () => {
  const all = [...Array.from({ length: 41 }, (_, i) => `a-bucket-${String(i).padStart(2, "0")}`), "vivijure-tenant-rollins-rehearsal-x-alias"];

  it("finds a bucket that sorts past the first page", async () => {
    const f = fakeBuckets(all, 20);
    const names = await listAllBucketNames({ api: API, account: "acc", token: "t", fetch: f.fetch });
    expect(names).toHaveLength(42);
    expect(names).toContain("vivijure-tenant-rollins-rehearsal-x-alias");
    expect(f.calls).toHaveLength(3);
  });

  it("CONTROL: a single-page read (the old sweep) misses it", async () => {
    const f = fakeBuckets(all, 20);
    const res = await f.fetch(`${API}/accounts/acc/r2/buckets`);
    const body = (await res.json()) as { result: { buckets: { name: string }[] } };
    expect(body.result.buckets.map((b) => b.name)).not.toContain("vivijure-tenant-rollins-rehearsal-x-alias");
  });

  it("throws on an error page instead of returning a short list", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ success: false, errors: [{}] }), { status: 403 });
    await expect(listAllBucketNames({ api: API, account: "acc", token: "t", fetch })).rejects.toThrow(/HTTP 403/);
  });

  it("throws when the pages do not add up to total_count", async () => {
    const fetch: FetchLike = async () =>
      new Response(JSON.stringify({ success: true, result: { buckets: [{ name: "a" }] }, result_info: { total_count: 5 } }), { status: 200 });
    await expect(listAllBucketNames({ api: API, account: "acc", token: "t", fetch })).rejects.toThrow(/1 of total_count 5/);
  });

  it("throws on a runaway cursor", async () => {
    const fetch: FetchLike = async () =>
      new Response(JSON.stringify({ success: true, result: { buckets: [] }, result_info: { cursor: "again" } }), { status: 200 });
    await expect(listAllBucketNames({ api: API, account: "acc", token: "t", fetch, maxPages: 3 })).rejects.toThrow(/more than 3 pages/);
  });
});

describe("listAllD1 (cp#614)", () => {
  it("walks pages until a short page", async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ uuid: `u${i}`, name: `db-${i}` }));
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return new Response(JSON.stringify({ success: true, result: all.slice((page - 1) * 100, page * 100) }), { status: 200 });
    };
    const dbs = await listAllD1({ api: API, account: "acc", token: "t", fetch });
    expect(dbs).toHaveLength(230);
    expect(calls).toHaveLength(3);
  });

  it("throws on an error page", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ success: false }), { status: 500 });
    await expect(listAllD1({ api: API, account: "acc", token: "t", fetch })).rejects.toThrow(/HTTP 500/);
  });
});
