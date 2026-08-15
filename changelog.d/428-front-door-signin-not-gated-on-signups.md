### fix(front-door): signing in and signing up are two different questions (cp#428)

With `signups_enabled: false` -- which is the LIVE setting today, and correct, because signups ship
last by ruling -- the hosted front door replaced its entire signed-out screen with a closed notice.
That notice carries no sign-in control. **An account that already existed had no way back into a
studio it already owned.**

Measured on https://studio.vivijure.com before the fix: the whole document had four interactive
elements (brand, self-host link, report-abuse, abuse mailto). No email field, no button.

**The plane was never the problem and is unchanged.** `POST /api/auth/email/start` mails the link to
an address that already has an account while the switch is off, and `src/index.ts` states the rule
in as many words: signups_enabled means can NEW accounts be created, full stop. Only the UI
conflated that with can a KNOWN person get back in.

**Signups stay CLOSED. `signups_enabled` is not touched.**

`shellRoute` no longer takes the platform config AT ALL. The route is a fact about the SESSION; the
switch is a fact about new accounts, answered separately by `signupsOpen(config)`. Keeping the
switch out of the routing function is what stops the two being conflated again, and the test asserts
the arity so a future edit cannot quietly re-admit it.

The signed-out screen is now ONE panel. The switch changes its COPY: a different title and lede, and
the closed-signups callout in place of the pricing one. **The closed copy keeps its voice**, self-host
link and all, down to the line about it not being a consolation prize. The copy was never the bug;
arriving INSTEAD of the way in was.

**Enumeration safety is preserved and asserted.** The 202 is still uninformative, the submit still
lands on the same link-sent screen for every outcome, and the closed-signups text is a fact about the
PLANE that reads identically for every visitor, so it reveals nothing about any address.

**`onboarding.js` carried the same defect one page over**, and worse: a closed switch disabled every
`[data-next]` on the page, freezing exactly the person the plane goes out of its way not to strand.
An operator-provisioned tenant reaches that page to hand over its render key, so a disabled Next is
the difference between a studio that finishes and one that cannot. The banner and the disable now
follow the SESSION, and a `/api/me` failure that is not 401/403 leaves the flow alone rather than
inventing a refusal the plane never made.

**Watched failing first.** Against `main`: 7 reds across the two suites, with every positive control
green (a renamed or empty asset cannot pass these by matching nothing). Then driven in a real
browser against the LIVE plane answer, not jsdom: sign-in reachable with the switch off, submitted,
and the same link-sent screen.
