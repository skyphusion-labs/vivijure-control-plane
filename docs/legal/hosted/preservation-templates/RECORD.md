# Incident record: inc_YYYYMMDD_xxxxxx

> **Identifiers and findings, NEVER payload.** No prompts, no images, no video, no excerpts, no
> descriptions of the depiction beyond what the report and the statute require. A record that
> reproduces the material reproduces the problem.
> (`ABUSE-RESPONSE-RUNBOOK.md` Section 10, `PRESERVATION-PATH.md` Section 5.)

| Field | Value |
|---|---|
| Incident id | `inc_YYYYMMDD_xxxxxx` |
| Opened (UTC) | |
| Opened by | (named authorized responder, cp#119) |
| Intake channel | abuse@ / legal@ / provider notice / law enforcement / incidental |
| Arrival timestamp (UTC) | **This is the actual-knowledge clock and it is evidence.** |
| Reporter | identity or "anonymous"; contact if given |
| Tenant id | `ten_...` |
| Tenant slug | |
| Triage | P0 / P1 / P2 |
| Category | CSAM (incl. synthetic) / NCII / imminent harm / other |

## Artifacts identified by the report

| # | Artifact identifier | Where | Notes |
|---|---|---|---|
| 1 | | tenant bucket key / render id / project id | |

## Actions

| Step | Done | UTC | By | Reference |
|---|---|---|---|---|
| Tenant suspended (reason recorded, audited) | | | | `recordAdminAction` row |
| Preservation hold opened | | | | `hold_...`, kind |
| Bounded look performed, stop rule applied | | | | custody.log line |
| Copy to segregated store (only per PRESERVATION-PATH Section 3.1) | | | | manifest.json |
| NCMEC CyberTipline submitted | | | | submission id |
| Law enforcement contact | | | | le/ |
| Termination (only after preservation is secured) | | | | |

## Findings

Plain statement of what was concluded and on what basis. Do not describe the depiction.

## Clocks

| Clock | Started | Floor (expires_at) | Hold id | Status |
|---|---|---|---|---|
| 2258A(h)(1), 1 year from submission | | | | open |
| 2703(f), 90 days from a governmental request (renewable) | | | | |

**An elapsed clock is not a release.** Release is an explicit, audited human act; destruction happens
only on a law enforcement request under 2258B(c).

## Limits of what we hold

State what this incident could NOT reach (`PRESERVATION-PATH.md` Section 2.1): the tenant own RunPod
account, copies already downloaded or published, anything deleted before the hold opened. A report
must not imply completeness it does not have.
