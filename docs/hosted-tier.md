# The hosted studio: what it is, what it costs, and how to leave

**Status: control plane is shipped and tag-deployed (`v*` on this repo).** This page is the
tenant-facing story of the hosted tier as ruled.

Vivijure is free software you can install yourself, and always will be. The hosted studio exists
for one reason: installing takes work, and some people would rather skip that part. You sign up,
accept the AUP, we build a studio on our render capacity, you click go live.

You do not need a RunPod account. You do not paste a key. A consumer reaches RunPod through this
product or not at all.

Want to install it yourself instead? That path is first-class. Start at the studio host docs:
[vivijure-cf DEPLOYMENT](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/DEPLOYMENT.md)
and this plane's [deploy.md](./deploy.md).

---

## Our promise, in writing

> **Hosted and self-host ship the same studio. Features never gate on payment.**

We mean that literally, so here is what it rules out:

- No feature ever ships to hosted first and self-host "later." Same release, or it does not ship.
- No community edition. No paid-only capability. No feature held back to sell you an upgrade.
- The hosted control plane itself (signup, the provisioner, routing, quotas) is **AGPL source in
  this repo**. Anyone who wants to run a competing hosted vivijure can, with our blessing.

The hosted tier sells convenience: no install, no infrastructure. It never sells capability. What
differs between hosted and self-host is who runs the metal, and nothing else.

---

## What we run for you

We run the same public release images we publish on GHCR. You never create endpoints.

| Capability | What it does |
|---|---|
| **backend** | The main render: keyframes and video |
| **upscale** | Makes finished video sharper |
| **lipsync** | Matches mouth movement to dialogue |
| **audio-upscale** | Cleans up and sharpens audio |

Those workers scale to zero. Nothing running means nothing billed on our GPU bill. Idle is $0.

There is no setup key and no render key for you to mint. That two-key dance was a leftover of
a BYOK path we purged. Shared go-live is an empty POST. If you paste a RunPod token, we refuse
it: this studio does not use your account.

---

## What a render costs

GPU seconds land on our RunPod account, not yours. A daily ceiling on the tenant studio
(`TENANT_SPEND_DAILY_CEILING`) is a count of spend-route submits per UTC day, not
dollars (cp#419). A Wan train and a keyframe both count as 1.

The planner's AI is pennies per storyboard; in the hosted tier we cover it.

---

## Your data, and how to leave

**Your films and your storyboards are yours.** Leaving is a supported path, not a punishment.

Your studio is a real, complete vivijure studio: its own database, its own storage bucket, its own
worker. That is not a detail; it is what makes leaving possible at all.

- **Your storyboards, cast, and render history** live in your own database. You can export the
  whole thing to a SQL file.
- **Your films, keyframes, and audio** live in your own storage bucket, as ordinary files you
  can download.
- **The GPUs stay ours.** There is nothing on a RunPod account of yours to delete.

**If you delete your studio, we offer you the export first.** You take the SQL file and your
files, and then it is gone. We do not hold your work hostage.

Taking that export and running it yourself gives you the same studio, on your own Cloudflare
account. See [quickstart.md](quickstart.md).

---

## The rules

The acceptable-use policy for the hosted studio is written and is what the signup gate serves:
[the hosted AUP](legal/hosted/aup/1.0.0.md). It is versioned and self-contained, and setup asks
you to accept it before anything is created. What you accept is recorded with the exact version.

Three things about that gate:

- **You accept a version, not a vibe.** The gate pins one exact version.
- **If the policy changes, we ask you again.** We do not quietly carry your old tick forward.
- **If we cannot show you the policy, we will not ask you to accept it.**

One line is not a placeholder and is not up for discussion: **vivijure has an absolute ban on
child sexual abuse material, including AI-generated material.** It is enforced, it is reported,
and there is no version of this product where that is negotiable. On a studio we host, we are
not blind, and reporting is the law.

Legal text for the self-hosted studio is in [legal/](legal/).

---

## Where the details live

- [quickstart.md](quickstart.md) -- install your own studio instead. First-class, fully supported.
- [constellation.md](constellation.md) -- the one-page map of how the parts fit together.
- [DEPLOYMENT.md](DEPLOYMENT.md) -- the full self-host deployment reference.
- [opt-in-tiers.md](opt-in-tiers.md) -- the add-ons and what each one needs.
- [SECURITY.md](SECURITY.md) -- the security posture.
