### fix(audit): record owner reclaim teardown and write teardown intent first (cp#456, cp#398)

Owner reclaim teardown (`deleteData: true`) wrote no audit row, while the identical operator
teardown did. A real reclaim tonight destroyed a D1, R2 bucket, R2 token, and studio worker and
left the newest audit entry as an earlier operator provision.

Both destructive paths now write `*.intent` BEFORE `provisioner.teardown` and a completion row
after. A failed intent write aborts before anything is deleted. The owner actor is
`account:<id>`, not an operator token. Partial failures land in the completion detail.

### fix(auth): do not spend a magic link on GET (cp#437)

`GET /auth/email/callback` rendered a session from an unauthenticated GET, so the first fetch
won: mail scanners, prefetch, and preview fetches burned the link. The GET now serves a confirm
page and changes nothing. `POST /auth/email/callback` with the form token is the spend.

A POST of the mailed URL with no form body does not consume the token. Remaining bearer
property: a client that submits the form still spends it. That is the product.

Test: GET (including `Purpose: prefetch`) leaves `consumed_at` null; POST after GET signs in;
an intent-audit throw leaves resources in place on both teardown paths.
