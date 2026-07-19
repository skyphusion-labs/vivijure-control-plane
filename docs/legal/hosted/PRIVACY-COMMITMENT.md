# The privacy commitment

> **This document is canonical at the constellation hub, and only there.**
> Read it at
> [`vivijure docs/legal/PRIVACY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PRIVACY-COMMITMENT.md).

> **Note the exception to this directory's status banner.** Everything else under
> `docs/legal/hosted/` is DRAFT and not in force. The privacy commitment is **in force now**: it is
> a standing commitment about how Skyphusion Labs builds, not a hosted-service term that takes
> effect at launch. It is what the drafts in this directory are written against.

The privacy commitment is **product-wide**, not a hosted-service artifact. It covers every product
Skyphusion Labs ships (the Vivijure constellation, Postern, Prism, Slate), so it lives at the hub in
one copy and every product repository points at it rather than carrying its own. A commitment that
exists in six places is a commitment that will eventually say six different things.

This file is a pointer so they can never drift. Do not paste the text here.

## What it says, in one line

Privacy, autonomy, and agency are the primary goal, ranked above feature completeness rather than
traded against it; when a feature cannot be built without violating that, **we drop the feature, not
the line**; public source is the audit mechanism that makes the promise checkable; and the CSAM and
NCII bright line is the one stated exception.

## Why the pointer sits here, and which part binds this repository

This is the only repository in the constellation that will ever operate a service holding other
people's work, which makes it the one place the commitment can actually be broken. Section 4.1 of
the canonical copy is the part written for this repo:

> **We monitor the machine. We never monitor the work.**

The rule it states is falsifiable on purpose: **a telemetry field set is acceptable only if every
field is machine-generated and none is user-derived.** Section 4.3 pre-authorises the fallback: if
proactive monitoring cannot be done without ingesting customer work, we do not do it at all, we say
so, and the missing feature is the cost of the guarantee. That is not a hard call left for launch
week; it is already decided.

## Two things this repository owes

1. **Section 4.2 states, in the present tense, that the hosted tier has not launched, has no
   tenants, and has no telemetry wired.** That sentence goes false the day hosted opens. It is a
   launch-gate item, tracked as #49.
2. **The per-field dispositions and the service-level monitoring disclosure do not exist yet.** The
   canonical document says so plainly rather than claiming a boundary we have not built. They are
   owed at launch.

## The tripwire

**If a telemetry field, log line, or exception path in this repository ever carries user-derived
content to us, the commitment stops being true, and whoever adds it owns updating the canonical
document in the same PR.** See the canonical copy for the full boundary and the rest of the drift
tripwires.
