/**
 * Paged account censuses for the live rehearsal sweeps (cp#614).
 *
 * The reclaim rehearsal swept its R2 buckets with ONE `GET /r2/buckets`. That answer is the
 * first page only: 20 buckets by default, sorted by name. On an account with 42 buckets
 * (measured 2026-11-11), every `vivijure-tenant-rollins-rehearsal-*` bucket sorts after the
 * last name on page 1, so the sweep never saw the one bucket it existed to remove, and it
 * reported nothing. Eight runs left eight buckets.
 *
 * So every census here walks every page, and fails LOUDLY rather than returning a short list:
 * a census that cannot read the whole account must not look like "nothing left".
 */

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

interface Opts {
  api: string;
  account: string;
  token: string;
  fetch?: FetchLike;
  /** Pages before the census gives up and throws. A runaway cursor must not loop forever. */
  maxPages?: number;
}

/** Every R2 bucket name on the account, all pages (cursor paging, per_page 1000). */
export async function listAllBucketNames(o: Opts): Promise<string[]> {
  const f = o.fetch ?? (fetch as unknown as FetchLike);
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (o.maxPages ?? 50); page++) {
    const q = new URLSearchParams({ per_page: "1000" });
    if (cursor) q.set("cursor", cursor);
    const res = await f(`${o.api}/accounts/${o.account}/r2/buckets?${q}`, { headers: { authorization: `Bearer ${o.token}` } });
    const body = (await res.json()) as {
      success?: boolean;
      result?: { buckets?: { name: string }[] };
      result_info?: { cursor?: string; total_count?: number };
    };
    if (!res.ok || body.success === false || !body.result) {
      throw new Error(`r2 bucket census: HTTP ${res.status} on page ${page + 1}`);
    }
    for (const b of body.result.buckets ?? []) names.push(b.name);
    cursor = body.result_info?.cursor || undefined;
    if (!cursor) {
      const total = body.result_info?.total_count;
      if (typeof total === "number" && total !== names.length) {
        throw new Error(`r2 bucket census: read ${names.length} of total_count ${total}`);
      }
      return names;
    }
  }
  throw new Error(`r2 bucket census: more than ${o.maxPages ?? 50} pages`);
}

/** Every D1 database on the account, all pages (page paging, per_page 100). */
export async function listAllD1(o: Opts): Promise<{ uuid: string; name: string }[]> {
  const f = o.fetch ?? (fetch as unknown as FetchLike);
  const out: { uuid: string; name: string }[] = [];
  const perPage = 100;
  for (let page = 1; page <= (o.maxPages ?? 50); page++) {
    const res = await f(`${o.api}/accounts/${o.account}/d1/database?page=${page}&per_page=${perPage}`, {
      headers: { authorization: `Bearer ${o.token}` },
    });
    const body = (await res.json()) as { success?: boolean; result?: { uuid: string; name: string }[] };
    if (!res.ok || body.success === false || !Array.isArray(body.result)) {
      throw new Error(`d1 census: HTTP ${res.status} on page ${page}`);
    }
    out.push(...body.result);
    if (body.result.length < perPage) return out;
  }
  throw new Error(`d1 census: more than ${o.maxPages ?? 50} pages`);
}
