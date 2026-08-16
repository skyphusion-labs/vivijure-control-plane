### fix(provision): a refused finishJob must not roll back a succeeded studio (cp#461)

`finishJob` reports whether it actually closed a row, and a caller pairing it with a tenant-status
write MUST branch on the result (cp#443). Both reap sites already do. `runProvisionJob` and
`continueProvisionJob` did not.

The reachable corner is a zombie driver: it loses its lease, a successor finishes the provision,
then the zombie fails. `finishJob` correctly refuses. The catch still wrote `setTenantStatus(failed)`
and `rollbackFailedProvision`, which deletes the D1, R2 bucket, and token of a studio that
succeeded.

Both catch paths now treat a refused close as "this driver does not own the outcome": no tenant
write, no teardown.

Test: successor closes as succeeded inside the step that then throws; the zombie catch is reached
and the successor's studio is untouched. Watched red with the conditional removed.
