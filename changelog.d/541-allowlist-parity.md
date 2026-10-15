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
vivijure-cf@e3d998d NINE modules declare `const ENDPOINT_ID`, EIGHT of them a literal slug. Six of
the seven catalogued here are in that eight: alibaba-wan, alibaba-wan-lora, google-veo,
minimax-hailuo, seedance, vidu-q3. The other two literals are `infinitetalk` and `kling-o1-r2v`,
both deliberately uncatalogued. The ninth is `narration-gen/src/index.ts:66`,
`const ENDPOINT_ID = MODEL;`: catalogued and allow-listed, declaring the constant NON-literally, so
a literal-slug matcher returns eight and misses it. A gate equating the allow-list with cf's module
set would be red on a correct estate in both directions.

**Both census comments are retired rather than renumbered.** `MODULE_DENOMINATOR = 26` was stale.
`find modules -path 'modules/*/src/index.ts' | wc -l` is 33 at e3d998d, and was 34 at 7b927b9. The
number was not the defect: re-measured, TWO references to `api.runpod.ai` remain across all module
sources and BOTH ARE COMMENTS, so the direct call sites are ZERO where the comment claims 14. The
base now lives once, as `RUNPOD_DIRECT_BASE` in `@skyphusion-labs/vivijure-core@1.25.0`, reached
through `modules/_shared/runpod-route.ts`, a pure re-export (cp#321). That is the base-string swap
the route-match header itself describes. Renumbering would have re-pinned a sentence whose subject
had dissolved.

(cp#544 corrected the first draft of this paragraph against vivijure-cf@7b927b9: TEN declarations,
NINE literal, denominator 34, and both host hits are comments. Re-measured at e3d998d those three
numbers are NINE, EIGHT, and 33. The two `api.runpod.ai` hits are still comments.)

Two smaller things worth recording. The orphan slug's removal reverses a call made on cp#539 to keep
it, which rested on the blind check this fixes. And the new suite's comparator control was first
written over the live lists, so a genuine orphan made the control fail for the same reason as its
subject -- one defect reported as two, discriminating nothing; it is self-contained now.
