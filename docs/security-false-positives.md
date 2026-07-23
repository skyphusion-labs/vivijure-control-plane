# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Cloudflare-only edge

The control plane Worker is deployed behind Cloudflare. `cf-connecting-ip` for AUP consent is trusted because the Worker is not reachable off-Cloudflare in prod.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 verify ~18:04 | Email-start rate limit keyed only by recipient | **Fixed** per-IP throttle added in verify closeout |
| 2026-07-23 | K3 verify ~18:04 | Prior magic links stay valid on re-request | Accepted: short TTL + operator mail volume; not session fixation |
| 2026-07-23 | K3 verify ~18:04 | AUP IP from cf-connecting-ip | CF-only Worker edge; not reachable off-Cloudflare |
