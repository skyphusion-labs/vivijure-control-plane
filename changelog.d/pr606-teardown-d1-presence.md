### fix(teardown): a tenant whose D1 is already gone can be reaped (cp#605)

Teardown harvests a tenant D1's job log before deleting it, and skips the delete when the harvest fails. A database removed out of band also fails the harvest, and no retry could ever succeed, so such a tenant could never be fully reaped. Teardown now asks whether the database exists when the harvest fails (`CfApi.d1Present`: `true` on 200, `false` only on 404, anything else throws). On a proven 404 the harvest and the d1 are recorded as absent, the lost job log is logged as `teardown.job_index_lost`, and `d1_database_id` is blanked, the way cp#110 treats a worker removed out of band, so a second pass is clean. A present database, or a probe that cannot tell, keeps the interlock shut as before. A d1 delete that meets a 404 is also recorded as absent rather than failed.

The live reclaim case now deletes the D1 first and expects that convergence, replacing the interim test-only expectation from #604.
