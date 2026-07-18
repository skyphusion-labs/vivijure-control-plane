# The parity commitment

> **This document is canonical at the constellation hub, and only there.**
> Read it at
> [`vivijure docs/legal/PARITY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PARITY-COMMITMENT.md).

The parity commitment is **constellation-wide**, not a hosted-service artifact. It binds the whole
of Vivijure, so it lives at the hub in one copy, and `vivijure-cf` and this repository point at it
rather than carrying their own. A commitment that exists in three places is a commitment that will
eventually say three different things.

This file is a pointer so the two can never drift. Do not paste the text here.

## What it says, in one line

Every feature ships to hosted and self-host at the same time, in the same release. There is no
community edition, no paid tier that unlocks capability, and no feature held back to make the
hosted version look better. What you pay for, if you ever pay anything, is convenience. Never
capability.

## Why it is safe to promise, and why that matters here

The architecture is what enforces it: tenant studios run the **published release, unmodified**, so
there is no hosted fork that could drift away from self-host. That is a property of this
repository's design, which is why the pointer sits in the hosted legal set at all.

**If that architecture ever changes, the commitment stops being true, and whoever changes it owns
updating the canonical document in the same PR.** See Section 5 of the canonical copy for the full
set of drift tripwires.
