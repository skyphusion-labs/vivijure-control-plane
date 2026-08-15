### fix(api): /api/me reports WHICH AUP version was accepted, so a re-gated owner is not shown a first-run screen (cp#433)

`GET /api/me` reported the AUP as `{ required_version, accepted }`, and `accepted` is an exact-version
match against an append-only table. That is correct and deliberate: bumping `AUP_VERSION` re-gates
every account by construction, with no migration and no grandfathering. Nothing here changes it.

What it could not do is tell two people apart. Somebody who has NEVER accepted anything and somebody
who accepted 1.0.0 while the plane moved to 1.1.0 both read `accepted: false`, and the payloads were
byte-identical, so the front door rendered the same screen at both: *One thing before you start. You
need to accept the acceptable-use policy before you can set up a studio.* For the second person that
is wrong on both halves. They are not starting, and they are not setting up a studio; they may have a
running one. This is live: the plane serves 1.1.0 and four accounts accepted 1.0.0 (see
`changelog.d/396-aup-1.1.0-and-pin-gate.md`, which counted them).

`aup.last_accepted` is added, additively, and is populated unconditionally rather than only when
refused, so no client has to know which branch it is in before it can read it:

    aup: { required_version, accepted, last_accepted: { version, accepted_at } | null }

`null` means never accepted anything. Present alongside `accepted: false` means the policy moved under
them, which is a returning owner rather than a new signup, and the panel can finally say the true
thing. The UI copy is cp#431 and is not in this change.

**This closes an asymmetry the tree already held itself to.** `acceptAup` refuses a stale submission
precisely so nobody is recorded agreeing to wording they were never shown, and the client says
outright that *the policy changed while this page was open*. That honesty existed for the rare
mid-session case and was missing for the common between-sessions one.

Two design points worth stating, because both are places a plausible implementation goes wrong.

Ordering is `ORDER BY id DESC`, never by the version label. `AUP_VERSION` is a free-form string:
production has served `1.0.0` and `1.1.0`, test configuration uses date-shaped labels like
`2026-07-17`, and even inside semver `1.10.0` sorts before `1.9.0` lexicographically. `accepted_at` is second-granularity and ties. The row id
is the only column recording the order the rows arrived in, and the test uses a label pair where
every wrong ordering disagrees with the right one.

`accepted_at` is NORMALIZED to ISO-8601 UTC at the store boundary. The column is written only by the
SQLite `datetime(now)` default, which emits `2026-08-15 18:25:24`: space-separated, no zone. That was
measured against the real engine, not read off the schema, and the raw value is a trap rather than
merely ugly. Kotlin and Swift reject it outright, which is recoverable, but JavaScript `new Date()`
ACCEPTS it and reads it as LOCAL time, so a browser west of UTC would render a consent record hours
before it happened. An unrecognized value is returned raw rather than thrown on, because `/api/me` is
the route a re-gated account uses to discover why it is blocked and a display field must not be able
to 500 it.

Only `version` and `accepted_at` are projected. The row also carries `ip_hash`, `user_agent` and
`aup_sha256`; the caller being entitled to see their own row is not the same claim as needing every
column in it, and a test asserts the serialized payload carries none of them.
