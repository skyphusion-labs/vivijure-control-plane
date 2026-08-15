### The cron can now say whether it is alive (cp#436)

The scheduled handler ran three halves and every one of them reported to the console only. Nothing
persisted the fact that a tick had happened, so the cron could not be observed from outside the
Worker at all: if it stopped firing, every symptom was an ABSENCE (no meter periods, no RunPod
sweep, no provision drives), and an absence is indistinguishable from a plane with nothing to do.

That was tolerable while a dead cron only meant late billing data. It stopped being tolerable when
the cron became the only engine that drives an operator-provisioned tenant to a studio: from that
point a dead cron means no customer ever gets a studio, the tenant reads provisioning forever, and
nothing anywhere reports a fault.

Every tick now stamps a durable heartbeat, and a new operator read, GET /api/admin/cron, serves it
with the staleness already worked out. Two properties it was built to have, because a heartbeat
that lacks them is decoration:

- **It can go RED.** A half that threw is recorded as having thrown, and so is a half that REFUSED
  (no credential, no reader). A run that did nothing because it COULD not must never read like a
  run that did nothing because there was nothing to do.
- **Never-ran and ran-and-found-nothing do not read alike.** A clean tick over an empty plane still
  stamps the row, so the row existing is the evidence the handler executed. A missing row is
  reported as never-ran, not as a healthy quiet plane.

The sharpest case is the provision half. It catches per tenant, deliberately, so that one bad
tenant cannot take the rest of the tick down; the consequence is that it returns NORMALLY when
every drive it attempted failed. Judging it on whether an error escaped would have left it green
through a total outage of the thing it measures, so it is judged on its error count instead.

The write is unconditional and its failure is swallowed. An instrument that can take down the
engine it measures is a worse defect than the blindness it was added to fix.
