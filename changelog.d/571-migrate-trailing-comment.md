### fix(migrate): strip SQL comments before sending a tenant migration to D1 (#571)

The D1 query endpoint refuses one statement followed by any comment, with 400 and code 7500, and applies nothing. `0003_cast_voice.sql` has that shape, so a fresh tenant provision failed at `d1_migrate`. The runner now strips comments from the text it sends, keeps quoted text unchanged, and records a comment-only file without a query. Shipped migration files do not change.
