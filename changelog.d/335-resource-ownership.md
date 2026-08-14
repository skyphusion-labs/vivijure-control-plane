### feat(teardown): record resource ownership at provision (cp#106 option D)

Physical D1 / R2 bucket / R2 token / studio script ids are now claimed in `tenant_resource_ownership`
when the provisioner writes them. Teardown allows the **recorded owner** past tombstone-only
referrers without inventing silent last-referrer-wins. Live referrers still always refuse. Rows with
no ownership claim (legacy) keep the refuse-all-referrers default until re-provision or operator
`i_own` (cp#334).
