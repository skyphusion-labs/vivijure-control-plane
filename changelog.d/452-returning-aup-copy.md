### fix(front-door): returning-owner AUP copy branches on last_accepted

A policy bump is not a first signup. When `aup.last_accepted` is
present the front door says the policy changed and the studio keeps
running. First-run copy is unchanged.
