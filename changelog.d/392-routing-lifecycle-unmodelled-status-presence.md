### fix(routing): `routing.lifecycle_unmodelled` gates the status key on PRESENCE, not on type (cp#392)

The cp#392 fix stopped an absent status rendering as the literal string `"undefined"` by including
the `status` key only when the field is a string. That dropped every non-string too, so a status
that is PRESENT and holds `7`, `null`, `true` or an object rendered exactly like a column that is
not there. The event could no longer tell "no status column" from "status held 7", which is the
same ambiguity cp#392 was opened about, inverted.

The key is now included whenever the field is PRESENT on the row. The value keeps its JSON type,
so `7` and `"7"` stay different in the log. Values JSON cannot carry faithfully or safely
(object, array, bigint, symbol, function, a present-but-undefined value, NaN, Infinity) render as
a bracketed type tag such as `[unloggable object]` rather than a plausible-looking string; the
bigint case also keeps `JSON.stringify` from throwing on the refusal path. An absent status still
omits the key entirely, unchanged.
