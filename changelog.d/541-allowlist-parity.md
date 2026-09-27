### fix(proxy): make the allow-list check able to fail, and drop the slug it was hiding (cp#541)

`tests/runpod-proxy-census.test.ts` was named for a census and could not observe one. Its own
docstring said *"This suite does not re-scan vivijure-cf"*, and it then asserted
`expect(PUBLIC_ENDPOINT_ALLOWLIST).toHaveLength(PUBLIC_SLUGS)` against `const PUBLIC_SLUGS = 8`, and
`PUBLIC_SLUGS + ENV_ENDPOINT_READERS === HOST_REFS`, which is `8 + 6 === 14`. A constant against a
constant, and a comment against itself.

**The consequence was a blind check, not a red one.** cp#538 dropped the `kling` catalog row because
its RunPod slug 404s, and `kling-v2-1-i2v-pro` stayed in `PUBLIC_ENDPOINT_ALLOWLIST` -- a slug the
meter would price for a door no tenant can be provisioned -- with this suite green throughout.

`tests/public-endpoint-allowlist-parity.test.ts` replaces it and asserts the relation that can
actually fail: the allow-list equals the set of `TENANT_MODULE_CATALOG` `publicEndpoint` values, in
both directions, **naming the offender instead of counting**. Watched RED both ways before landing:
re-adding the orphan fails with `['kling-v2-1-i2v-pro']`, and deleting a needed entry fails with
`['alibaba-wan -> wan-2-6-i2v']`.

**The authority is this repo's catalog, and that is measured rather than preferred.** At
vivijure-cf@7b927b9 TEN modules declare `const ENDPOINT_ID`, NINE of them a literal slug -- the
seven catalogued here plus `infinitetalk` and `kling-o1-r2v`, both deliberately uncatalogued. The
tenth is `narration-gen/src/index.ts:66`, `const ENDPOINT_ID = MODEL;`: catalogued and allow-listed,
declaring the constant NON-literally, so a literal-slug matcher returns nine and misses it. A gate
equating the allow-list with cf's module set would be red on a correct estate in both directions.

**Both census comments are retired rather than renumbered.** `MODULE_DENOMINATOR = 26` was stale
(34 today), but the number was not the defect: re-measured, TWO references to `api.runpod.ai` remain
across all module sources and BOTH ARE COMMENTS, so the direct call sites are ZERO where the comment
claims 14. The base now lives once, as `RUNPOD_DIRECT_BASE` in
`@skyphusion-labs/vivijure-core@1.25.0`, reached through `modules/_shared/runpod-route.ts`, a pure
re-export (cp#321) -- the base-string swap the route-match header itself describes. Renumbering
would have re-pinned a sentence whose subject had dissolved.

(Both figures in this paragraph were corrected in cp#543 before release: as first written they said
narration-gen declared no such constant, and counted ONE host reference from an `index.ts`-only
predicate that excluded a module keeping its logic in a sibling file.)

Two smaller things worth recording. The orphan slug's removal reverses a call made on cp#539 to keep
it, which rested on the blind check this fixes. And the new suite's comparator control was first
written over the live lists, so a genuine orphan made the control fail for the same reason as its
subject -- one defect reported as two, discriminating nothing; it is self-contained now.
