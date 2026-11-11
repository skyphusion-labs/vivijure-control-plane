#!/usr/bin/env node
// check-flagship-version.mjs -- cp#564. Compare the version the FLAGSHIP studio Worker
// (vivijure-studio) is actually running, read out of its DEPLOYED BYTES, against vivijure-cf's newest
// release TAG and its latest PUBLISHED release.
//
// WHY THIS IS A DIFFERENT PAIR FROM check-studio-pin.mjs. That check compares the control plane's
// STUDIO_RELEASE binding, the repo variable and the latest published release. From 2026-10-14 to
// 2026-10-19 cf's post-deploy gate could never pass (cf#1023), so v1.36.0 and v1.37.0 deployed the
// flagship Worker and then aborted before studio-release published anything. The pin check's
// reference point is "latest published release", so it froze together with the pin it compared,
// and it reported ok while the flagship served 1.36.0 and then 1.37.0 bytes. A detector comparing A
// to B cannot see a defect that freezes A and B together.
//
// THE REFERENCE MUST NOT COME FROM THE STEP WHOSE FAILURE IT DETECTS. So the version under test is
// read from the deployed bytes (the `PACKAGE_VERSION = "x.y.z"` constant cf bakes from package.json,
// src/studio-release.ts), never from a binding or a published artifact, and it is compared to TWO
// independent references: the newest v*.*.* TAG (a tag exists the moment a release is cut, before
// any publish) and the latest PUBLISHED release.
//
// Verdicts, exit codes as check-studio-pin.mjs:
//   0  flagship == newest tag == latest published.
//   1  DRIFT: the flagship is AHEAD of the latest published release (the cf#1023 shape: deployed,
//      never published), AHEAD of the newest tag (running bytes no tag names), or BEHIND the newest
//      tag (a cut release did not deploy). A tag deploy takes minutes, so a red seconds after a cut
//      can be the deploy in flight: re-run it.
//   2  COULD NOT MEASURE: a read failed, the marker was not found exactly once, or a reference list
//      came back empty. An unperformed check is not a pass.

const CF_REPO = "skyphusion-labs/vivijure-cf";
const FLAGSHIP = "vivijure-studio";

// Overridable ONLY for the test suite, PRINTED on every overridden run, and asserted absent from
// every workflow by tests/workflow-guards.test.py (the same rule as check-studio-pin.mjs).
const GH_API = process.env.CHECK_FLAGSHIP_GH_API || "https://api.github.com";
const CF_API = process.env.CHECK_FLAGSHIP_CF_API || "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = Number(process.env.CHECK_FLAGSHIP_TIMEOUT_MS) || 20_000;
const REDIRECTED = Boolean(
  process.env.CHECK_FLAGSHIP_GH_API || process.env.CHECK_FLAGSHIP_CF_API || process.env.CHECK_FLAGSHIP_TIMEOUT_MS,
);
const PER_PAGE = 100;
const MAX_PAGES = 20;
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const MARKER_RE = /PACKAGE_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/g;

function fail(code, msg) {
  console.error(`check-flagship-version: ${msg}`);
  process.exit(code);
}

const withTimeout = async (url, init = {}) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    let origin = "the endpoint";
    try {
      origin = new URL(url).origin;
    } catch {
      /* reporting must not throw */
    }
    if (e && e.name === "AbortError") fail(2, `request to ${origin} exceeded the ${TIMEOUT_MS}ms timeout -- the check could not be performed`);
    const code = (e && (e.cause?.code || e.code || e.name)) || "unknown";
    fail(2, `request to ${origin} failed at the transport layer (${code}) -- the check could not be performed`);
  } finally {
    clearTimeout(t);
  }
};

const ghHeaders = () => {
  const h = { Accept: "application/vnd.github+json", "User-Agent": "check-flagship-version" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
};

const parse = (v) => {
  const m = TAG_RE.exec("v" + v.replace(/^v/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

/** The newest v*.*.* tag by SEMVER (not API order), paginated to exhaustion. */
async function newestTag() {
  const tags = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) fail(2, `more than ${MAX_PAGES * PER_PAGE} tags -- refusing to report a newest tag from a capped list`);
    const r = await withTimeout(`${GH_API}/repos/${CF_REPO}/tags?per_page=${PER_PAGE}&page=${page}`, { headers: ghHeaders() });
    if (!r.ok) fail(2, `tag list read for ${CF_REPO} failed: HTTP ${r.status}`);
    const batch = await r.json();
    if (!Array.isArray(batch)) fail(2, `tag list for ${CF_REPO} is not a list`);
    for (const t of batch) if (t && typeof t.name === "string" && TAG_RE.test(t.name)) tags.push(t.name);
    if (batch.length < PER_PAGE) break;
  }
  if (tags.length === 0) fail(2, `parsed ZERO v*.*.* tags from ${CF_REPO} -- refusing to report a pass on an empty derivation`);
  tags.sort((a, b) => cmp(b, a));
  console.log(`  control: ${tags.length} v*.*.* tags read from ${CF_REPO}; newest by semver ${tags[0]}`);
  return tags[0];
}

async function latestPublished() {
  const r = await withTimeout(`${GH_API}/repos/${CF_REPO}/releases/latest`, { headers: ghHeaders() });
  if (!r.ok) fail(2, `latest-release read for ${CF_REPO} failed: HTTP ${r.status}`);
  const j = await r.json();
  const tag = j && j.tag_name;
  if (typeof tag !== "string" || !TAG_RE.test(tag)) fail(2, `latest release of ${CF_REPO} is ${JSON.stringify(tag)}, which is not a v*.*.* tag`);
  return tag;
}

/** The version in the flagship's DEPLOYED bytes. The marker must match EXACTLY once. */
async function deployedVersion() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) fail(2, "needs CLOUDFLARE_API_TOKEN in the environment");
  if (!account) fail(2, "needs CLOUDFLARE_ACCOUNT_ID in the environment");
  const auth = { Authorization: `Bearer ${token}` };
  const ls = await withTimeout(`${CF_API}/accounts/${account}/workers/scripts`, { headers: auth });
  if (!ls.ok) fail(2, `worker script list failed: HTTP ${ls.status}`);
  const lj = await ls.json();
  const scripts = Array.isArray(lj.result) ? lj.result : [];
  console.log(`  control: success=${lj.success}, ${scripts.length} worker scripts visible to this credential`);
  if (lj.success !== true || scripts.length === 0) fail(2, "worker script list came back empty or unsuccessful -- this credential cannot see the account's Workers");
  if (!scripts.some((s) => s.id === FLAGSHIP)) fail(2, `${FLAGSHIP} is not in the visible script list -- refusing to read bytes off an account we cannot confirm`);
  const r = await withTimeout(`${CF_API}/accounts/${account}/workers/scripts/${FLAGSHIP}/content/v2`, { headers: auth });
  if (!r.ok) fail(2, `content read for ${FLAGSHIP} failed: HTTP ${r.status}`);
  const text = await r.text();
  const hits = [...text.matchAll(MARKER_RE)].map((m) => m[1]);
  const distinct = [...new Set(hits)];
  console.log(`  control: ${text.length} bytes of deployed ${FLAGSHIP} read; version marker matched ${hits.length} time(s)`);
  if (hits.length === 0) fail(2, `the PACKAGE_VERSION marker is not in the deployed ${FLAGSHIP} bytes -- the version is UNMEASURED, not current`);
  if (distinct.length !== 1) fail(2, `the deployed ${FLAGSHIP} bytes carry ${distinct.length} different PACKAGE_VERSION values (${distinct.join(", ")}) -- refusing to choose one`);
  return "v" + distinct[0];
}

console.log(`check-flagship-version: flagship=${FLAGSHIP}, artifact repo=${CF_REPO}`);
if (REDIRECTED) console.log(`  NOTE: endpoint bases are OVERRIDDEN (gh=${GH_API} cf=${CF_API}); this run is NOT a live measurement.`);

const flagship = await deployedVersion();
const tag = await newestTag();
const published = await latestPublished();
console.log(`  deployed ${FLAGSHIP} bytes: ${flagship}; newest tag: ${tag}; latest published: ${published}`);

const problems = [];
if (cmp(flagship, published) > 0) {
  problems.push(`the flagship runs ${flagship}, AHEAD of the latest published release ${published}: a release deployed and did not publish (the cf#1023 shape)`);
}
if (cmp(flagship, tag) > 0) problems.push(`the flagship runs ${flagship}, AHEAD of the newest tag ${tag}: it serves bytes no tag names`);
if (cmp(flagship, tag) < 0) problems.push(`the flagship runs ${flagship}, BEHIND the newest tag ${tag}: a cut release did not deploy (or its deploy is still in flight; re-run)`);
if (problems.length) {
  for (const p of problems) console.log(`  DRIFT ${p}`);
  process.exit(1);
}
console.log(`  ok    deployed ${FLAGSHIP} ${flagship} == newest tag ${tag} == latest published ${published}`);
