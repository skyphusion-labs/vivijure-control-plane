### One credential now uploads every script that attaches a VPC binding (cp#464)

Module worker uploads move onto the SCRIPT UPLOAD credential, the same one the studio upload has
used since cf#118. Before this, two different credentials uploaded worker scripts and only one of
them had ever been granted the Connectivity Directory access a vpc_service binding requires. The
door pool attaches those bindings to MODULE workers, so it was uploading with a credential that
could not attach them; nothing stated the two had to match, and nothing detected that they had
diverged. The first symptom was a provision dying on it.

The module upload also gains the cf#118 guard, which it never had: a refusal now arrives as a
sentence naming the plane credential rather than as raw Cloudflare prose about the caller.

And the guard now reports its own obsolescence. A predicate keyed on a vendor error code has an
expiry date nobody wrote down: when the vendor renumbers, a boolean guard answers false forever and
nothing anywhere says it stopped working. When a VPC binding fails and the known code does NOT
match, the codes Cloudflare actually returned are logged, which turns the first silent miss into a
loud one. The code itself is now defined ONCE rather than in two independent copies feeding three
call sites.
