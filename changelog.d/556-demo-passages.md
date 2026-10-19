### docs(demo): the passages that described the deleted demo as live are corrected

The public vivijure demo is gone, not deprecated. Its Cloudflare resources were deleted on 2026-10-19, so the plane's references to `demo.vivijure.com` described a surface that no longer answers: a WAF watch item that can never fire again, a zone-security false-positive source to watch before an enforce flip, a gateway cited as a live cheap option, and a launch-gate census step told to resolve a URL through a studio page remap that no longer exists.

The eight `DEMO_*` var dispositions stay. The disposition table is checked on every provision and every upgrade against the vars the pinned studio release declares, and a declared var with no disposition refuses both. They may be deleted only after the studio pin moves to a release that no longer declares them, verified against that release's manifest. Their stated reason now says the door is retired and names that condition.

`demo` stays a reserved tenant slug. Un-reserving a retired platform label would hand a tenant a hostname our own published history points at, and the reservation costs nothing.
