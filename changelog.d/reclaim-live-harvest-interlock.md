### test(reclaim): the live failure case expects the harvest interlock

The live teardown case deletes the tenant D1 first, then checks that teardown reports the failure. Since the job-log harvest (#280) reads the D1 before the delete and the delete runs only after a successful harvest, the failure is reported as `job_index_harvest` and the d1 delete is never attempted. The case now asserts that, and that the worker and bucket are still reaped. No code changes.
