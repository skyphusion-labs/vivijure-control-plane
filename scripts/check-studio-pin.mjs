#!/usr/bin/env node
// Make STUDIO_RELEASE *freshness* drift LOUD (cf#372). Sibling of check-satellite-pins.mjs and
// deliberately the same shape: two modes, two different truths, exit 2 is never a pass.
//
//   node scripts/check-studio-pin.mjs             RELEASE mode, no credentials.
//     Is the pin the LATEST published vivijure-cf release, and is it a published release at all?
//     Credential-free (public GitHub API), which is why the same command runs on the deploy path.
//
//   node scripts/check-studio-pin.mjs --deployed  DEPLOYED mode, needs CLOUDFLARE_API_TOKEN +
//     CLOUDFLARE_ACCOUNT_ID. Reads the STUDIO_RELEASE binding off the LIVE Worker and compares it
//     to the repo variable and to the latest release.
//
// WHY A SECOND MODE EXISTS, and it is the whole point of this file (cf#372, measured 2026-08-03 and
// again 2026-08-14). The Actions variable is NOT the pin. render-wrangler.sh interpolates it into
// [vars] at DEPLOY time, so the variable is a PROPOSAL that a release either carries or does not,
// and the deployed binding is what a tenant provisioned right now actually receives. deploy.yml
// fires on a v* tag only -- never on a merge to main, deliberately -- so the window between setting
// the variable and deploying is unbounded. Measured 2026-08-14T17:00Z: variable v1.26.0, latest
// published release v1.26.0, deployed binding v1.20.0. A check reading only the variable would have
// been GREEN while hosted was six releases behind. That is the same class of defect this file
// exists to catch, one layer up, so RELEASE mode alone is NOT sufficient and is not claimed to be.
//
// WHAT THIS DOES NOT DO, on purpose: it does not re-verify the artifact's CONTENTS. That is
// scripts/check-release-modules.py, already wired into deploy.yml preflight and ci.yml, which opens
// the manifest and hashes the bytes it promises. This file answers "is the pin CURRENT"; that one
// answers "is the pin SATISFIABLE". Two questions, two checks, neither a substitute for the other,
// and the deploy path runs both.
//
// NO TOLERANCE KNOB, deliberately. cf#372 lists "decide that hosted lags self-host by N releases
// and encode N" as a legitimate answer, and it is -- but as a reviewed change to this file carrying
// its reason, not as an env var. An env-var tolerance is a control anyone can set to infinity in a
// green run, which is how a gate stops being one.
//
// Exit 0 = the pin is current. Exit 1 = a real drift. Exit 2 = the check could not be PERFORMED
// (network, auth, shape, missing input, truncated list). 2 is never treated as a pass: an
// unreadable check is an unverified pin, and a check that cannot run must not look like one that
// ran and found nothing.

const CF_REPO = "skyphusion-labs/vivijure-cf"; // the studio artifact's home; the pin points here.
const CP_WORKER = "vivijure-control-plane"; // the deployed Worker whose binding is the real pin.

// Endpoint bases are overridable ONLY so the test suite can drive every refusal path against a
// local server without network or credentials. An override is PRINTED on every run, beside the
// verdict, so a redirected run can never masquerade as a real measurement (name the object you
// measured). Nothing in .github/workflows sets these, and tests/workflow-guards.test.py asserts so.
const GH_API = process.env.CHECK_STUDIO_PIN_GH_API || "https://api.github.com";
const CF_API = process.env.CHECK_STUDIO_PIN_CF_API || "https://api.cloudflare.com/client/v4";
const REDIRECTED = Boolean(process.env.CHECK_STUDIO_PIN_GH_API || process.env.CHECK_STUDIO_PIN_CF_API);

const TIMEOUT_MS = 20_000;
const PER_PAGE = 100;
const MAX_PAGES = 20; // 2000 releases; hitting this is a refusal, never a silent truncation.
const TAG_RE = /^v\d+\.\d+\.\d+$/;

function fail(code, msg) {
  console.error(`check-studio-pin: ${msg}`);
  process.exit(code);
}

const withTimeout = async (url, init = {}) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
};

const ghHeaders = () => {
  const h = { Accept: "application/vnd.github+json", "User-Agent": "check-studio-pin" };
  // Optional: raises the anonymous rate limit. Absent is fine; the artifact repo is public.
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
};

/**
 * Every published release, newest first, PAGINATED TO EXHAUSTION.
 *
 * The membership test below ("is the pin a published release at all?") is a NEGATIVE conclusion,
 * and a negative drawn from a capped list is worthless -- a page that returns exactly its limit
 * cannot tell "this is everything" from "this is the first N". So this pages until a short page
 * proves the end, and REFUSES at MAX_PAGES rather than reporting a total it cannot stand behind.
 */
async function publishedReleases() {
  const tags = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await withTimeout(`${GH_API}/repos/${CF_REPO}/releases?per_page=${PER_PAGE}&page=${page}`, {
      headers: ghHeaders(),
    });
    if (!r.ok) fail(2, `release list page ${page} for ${CF_REPO} failed: HTTP ${r.status}`);
    const list = await r.json();
    if (!Array.isArray(list)) fail(2, `release list for ${CF_REPO} was not an array -- API shape changed`);
    seen += list.length;
    for (const x of list) {
      if (!x.draft && !x.prerelease && TAG_RE.test(x.tag_name || "")) tags.push(x.tag_name);
    }
    if (list.length < PER_PAGE) {
      console.log(`  control: ${seen} releases read over ${page} page(s), ${tags.length} published v* releases`);
      if (tags.length === 0) {
        fail(2, `parsed ZERO published v* releases from ${CF_REPO} -- refusing to report a pass on an empty derivation`);
      }
      return tags;
    }
  }
  fail(2, `release list for ${CF_REPO} did not terminate within ${MAX_PAGES} pages -- refusing to conclude from a truncated list`);
}

/**
 * The latest release, from the endpoint that DEFINES latest, cross-checked against the full list.
 * The list is the control: if `latest` is not a member of it the two reads disagree, and that is a
 * finding about the instrument rather than about the pin.
 */
async function latestRelease(tags) {
  const r = await withTimeout(`${GH_API}/repos/${CF_REPO}/releases/latest`, { headers: ghHeaders() });
  if (!r.ok) fail(2, `latest-release read for ${CF_REPO} failed: HTTP ${r.status}`);
  const j = await r.json();
  const tag = j.tag_name;
  if (typeof tag !== "string" || !TAG_RE.test(tag)) {
    fail(2, `latest release of ${CF_REPO} is ${JSON.stringify(tag)}, which is not a v*.*.* tag`);
  }
  if (!tags.includes(tag)) {
    fail(2, `latest release ${tag} is absent from the release LIST -- the two reads disagree, so neither is evidence`);
  }
  return tag;
}

/** How many published releases the pin sits behind the head. Tags are newest-first. */
function lag(tags, pin, latest) {
  return tags.indexOf(pin) - tags.indexOf(latest);
}

function readPin() {
  const pin = process.env.STUDIO_RELEASE;
  if (!pin || pin.trim() === "") {
    fail(2, "STUDIO_RELEASE is empty or unset -- an unset pin is an UNMEASURED check, never a pass");
  }
  if (!TAG_RE.test(pin)) {
    fail(2, `STUDIO_RELEASE is ${JSON.stringify(pin)}, which is not a v*.*.* tag -- refusing to compare`);
  }
  return pin;
}

/**
 * The deployed binding: the only surface describing what a tenant provisioned RIGHT NOW receives.
 *
 * Carries its own known-positive on the SAME credential and the SAME object class, in the same run,
 * because a scope-limited Cloudflare credential returns `success: true` with an empty result on an
 * object class it cannot see -- so an empty answer is that credential's opinion, not a measurement.
 */
async function deployedBinding() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) fail(2, "--deployed needs CLOUDFLARE_API_TOKEN in the environment");
  if (!account) fail(2, "--deployed needs CLOUDFLARE_ACCOUNT_ID in the environment");
  const auth = { Authorization: `Bearer ${token}` };

  // CONTROL FIRST, then the claim. If this credential cannot enumerate Workers at all, every later
  // empty result is a statement about the credential rather than about the deploy.
  const ls = await withTimeout(`${CF_API}/accounts/${account}/workers/scripts`, { headers: auth });
  if (!ls.ok) fail(2, `worker script list failed: HTTP ${ls.status}`);
  const lj = await ls.json();
  const scripts = Array.isArray(lj.result) ? lj.result : [];
  console.log(`  control: success=${lj.success}, ${scripts.length} worker scripts visible to this credential`);
  if (lj.success !== true || scripts.length === 0) {
    fail(2, "worker script list came back empty or unsuccessful -- this credential cannot see the account's Workers");
  }
  if (!scripts.some((s) => s.id === CP_WORKER)) {
    fail(2, `${CP_WORKER} is not in the visible script list -- refusing to read a binding off an account we cannot confirm`);
  }

  const r = await withTimeout(`${CF_API}/accounts/${account}/workers/scripts/${CP_WORKER}/settings`, { headers: auth });
  if (!r.ok) fail(2, `settings read for ${CP_WORKER} failed: HTTP ${r.status}`);
  const j = await r.json();
  if (j.success !== true) fail(2, `settings read for ${CP_WORKER} was unsuccessful: ${JSON.stringify(j.errors || [])}`);
  const bindings = Array.isArray(j.result?.bindings) ? j.result.bindings : [];
  console.log(`  control: ${bindings.length} bindings on the deployed ${CP_WORKER}`);
  if (bindings.length === 0) fail(2, `${CP_WORKER} reported ZERO bindings -- refusing to conclude anything from that`);

  // A MISSING key must never be coerced into a value. An absent binding and a binding holding an
  // old tag are different findings, and only one of them is drift.
  const hit = bindings.find((b) => b.name === "STUDIO_RELEASE");
  if (!hit) fail(2, `the deployed ${CP_WORKER} carries NO STUDIO_RELEASE binding -- that is a deploy defect, not a pin lag`);
  if (typeof hit.text !== "string" || hit.text === "") {
    fail(2, "the deployed STUDIO_RELEASE binding has no text value -- UNMEASURED, not current");
  }
  return hit.text;
}

// ------------------------------------------------------------------------------------------

const deployed = process.argv.includes("--deployed");
console.log(`check-studio-pin: mode=${deployed ? "deployed" : "release"}, artifact repo=${CF_REPO}`);
if (REDIRECTED) {
  console.log(`  NOTE: endpoint bases are OVERRIDDEN (gh=${GH_API} cf=${CF_API}); this run is NOT a live measurement.`);
}

const pin = readPin();
const tags = await publishedReleases();
const latest = await latestRelease(tags);

let bad = 0;

if (!tags.includes(pin)) {
  bad++;
  console.log(`  FAIL  STUDIO_RELEASE ${pin} is not a published release of ${CF_REPO}`);
  console.log(`        a tenant provisioned on it would fetch an artifact that was never published.`);
} else if (pin !== latest) {
  bad++;
  console.log(`  DRIFT STUDIO_RELEASE ${pin}`);
  console.log(`        latest published ${latest} -- the pin is ${lag(tags, pin, latest)} release(s) behind`);
} else {
  console.log(`  ok    STUDIO_RELEASE ${pin} == latest published ${latest}`);
}

if (deployed) {
  const live = await deployedBinding();
  if (live !== pin) {
    bad++;
    console.log(`  DRIFT deployed binding ${live} != STUDIO_RELEASE variable ${pin}`);
    console.log(`        the variable advanced and no control-plane deploy has carried it;`);
    console.log(`        a tenant provisioned right now receives ${live}.`);
  } else if (live !== latest) {
    // Reachable only when the variable is ALSO stale, which the release check above already
    // counted. Stated separately anyway: they are different facts, and a reader who saw only the
    // variable row would otherwise infer the runtime row.
    console.log(`  note  deployed binding ${live} agrees with the variable, and both trail ${latest}`);
  } else {
    console.log(`  ok    deployed binding ${live} == variable == latest published ${latest}`);
  }
}

if (bad > 0) {
  console.error(
    `\n${bad} studio-pin finding(s). Hosted and self-host resolve the same nominal tag to DIFFERENT ` +
      "code, which the absolute hosted/self-host parity invariant forbids.\n" +
      "Advance STUDIO_RELEASE to the latest published release AND deploy the control plane (the " +
      "variable alone changes nothing), or record a deliberate lag as a reviewed change to " +
      "scripts/check-studio-pin.mjs. See cf#372.",
  );
  process.exit(1);
}
console.log(`\nstudio pin is current at ${latest}.`);
