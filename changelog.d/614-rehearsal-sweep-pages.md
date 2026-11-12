### test(live): the reclaim rehearsal sweep reads every page, and fails the run on a leftover (#614)

The reclaim rehearsal's `afterAll` sweep listed R2 buckets with one `GET /r2/buckets`. That returns the first 20 buckets by name. The account has 42, and every `vivijure-tenant-rollins-rehearsal-*` bucket sorts after the last name on page 1. So the sweep never saw the aliased-bucket case's bucket, and it printed nothing. Eight runs left eight buckets.

The bucket and D1 censuses now walk every page (`tests/live-census.ts`). They throw when a page errors or the pages do not add up to `total_count`, so a short read can never look like "nothing left". After the sweep, the account is listed again, and anything still under the rehearsal prefix is a leftover. Any leftover now fails the run: the `afterAll` throws, vitest exits 1, and `run-live-suite.sh` fails the gate step. Before, it only printed a line.
