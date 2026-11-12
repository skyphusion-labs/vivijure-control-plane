#!/usr/bin/env node
// Make tenant image-pin drift LOUD (cp#126). Two modes, two different truths:
//
//   node scripts/check-satellite-pins.mjs          REGISTRY mode, no credentials.
//     Every pin in src/satellite-pins.ts must resolve at GHCR by image name. Catches the pin that
//     points at a tag nobody ever pushed -- which is exactly what "0.1.0" was.
//
//   node scripts/check-satellite-pins.mjs --prod   PRODUCTION mode, needs RUNPOD_API_KEY (prod).
//     Reads what the production endpoints are ACTUALLY running and compares it to the pins. This is
//     the third leg of a satellite release: red here means production moved and the plane has not
//     followed, i.e. new tenants would be provisioned onto an unverified line.
//
// Exit 0 = every pin verified. Exit 1 = a real mismatch. Exit 2 = the check could not be PERFORMED
// (network, auth, shape). 2 is never treated as a pass: an unreadable check is an unverified pin,
// and a check that cannot run must not look like a check that ran.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PINS_TS = join(HERE, "..", "src", "satellite-pins.ts");
// RunPod REST v2 (fleet-chezmoi#2083; v1 retires 2026-11-15). RUNPOD_API_BASE exists for the
// script's own tests, which point it at a local fake; nothing else sets it.
const RUNPOD_API = (process.env.RUNPOD_API_BASE || "https://api.runpod.io/v2").replace(/\/$/, "");
// GHCR's base and the timeout are overridable ONLY so the test suite can drive the transport-failure
// arms against a local server in milliseconds (cp#627). Any override is PRINTED on every run, so a
// redirected or shortened run cannot pass for a measurement of the registry, and
// tests/workflow-guards.test.py asserts no workflow sets one. The timeout override can only turn a
// slow read into a REFUSAL (exit 2), never a drift into a pass.
const GHCR = (process.env.CHECK_SATELLITE_PINS_GHCR || "https://ghcr.io").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.CHECK_SATELLITE_PINS_TIMEOUT_MS) || 20_000;
const OVERRIDES = ["CHECK_SATELLITE_PINS_GHCR", "CHECK_SATELLITE_PINS_TIMEOUT_MS", "RUNPOD_API_BASE"].filter(
  (k) => process.env[k],
);

/** Parse the pins out of the TS source: no build step, no runtime dep, one source of truth. */
function readPins() {
  const src = readFileSync(PINS_TS, "utf8");
  const org = /GHCR_ORG = "([^"]+)"/.exec(src)?.[1];
  if (!org) fail(2, "could not read GHCR_ORG from src/satellite-pins.ts");
  const body = src.slice(src.indexOf("export const SATELLITE_PINS"));
  const re = /"?([a-z-]+)"?:\s*\{\s*repo:\s*"([^"]+)",\s*tag:\s*"([^"]+)",\s*digest:\s*"([^"]+)",\s*mirrors:\s*\{\s*endpointId:\s*"([^"]+)",\s*readAt:\s*"([^"]+)"/g;
  const pins = [...body.matchAll(re)].map((m) => ({
    key: m[1], repo: m[2], tag: m[3], digest: m[4], endpointId: m[5], readAt: m[6],
  }));
  if (pins.length === 0) fail(2, "parsed ZERO pins from src/satellite-pins.ts -- refusing to report a pass");
  // cp#601: a pin the pattern does not match (say, one missing its digest) would otherwise be
  // silently left out of the check. Every `repo:` entry must have parsed.
  const entries = (body.slice(0, body.indexOf("};")).match(/\brepo:\s*"/g) || []).length;
  if (entries !== pins.length) fail(2, `parsed ${pins.length} of ${entries} pins -- a pin is missing its tag, digest or mirrors`);
  for (const p of pins) {
    if (!/^sha256:[0-9a-f]{64}$/.test(p.digest)) fail(2, `pin ${p.key} digest is not sha256:<64 hex>`);
  }
  return { org, pins };
}

function fail(code, msg) {
  console.error(`check-satellite-pins: ${msg}`);
  process.exit(code);
}

const withTimeout = async (url, init = {}) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    // cp#627, the same defect cp#393 fixed in check-studio-pin.mjs. Without this catch the
    // rejection reached the top level unhandled, and Node exited 1, which is the DRIFT band, with
    // a raw stack. Measured on PR #626, 2026-11-12: a 20s GHCR stall read as "a pin does not
    // resolve", and the remedy that message points at is moving a pin that was fine. A transport
    // failure says nothing about the pin, so it is could-not-perform. Only the ORIGIN is reported.
    let origin = "the endpoint";
    try {
      origin = new URL(url).origin;
    } catch {
      /* do not let reporting throw */
    }
    if (e && e.name === "AbortError") {
      fail(2, `request to ${origin} exceeded the ${TIMEOUT_MS}ms timeout -- the check could not be performed`);
    }
    const code = (e && (e.cause?.code || e.code || e.name)) || "unknown";
    fail(2, `request to ${origin} failed at the transport layer (${code}) -- the check could not be performed`);
  } finally {
    clearTimeout(t);
  }
};

/** Anonymous GHCR pull token for a public package. */
async function ghcrToken(org, repo) {
  const url = `${GHCR}/token?service=ghcr.io&scope=repository:${org}/${repo}:pull`;
  const r = await withTimeout(url);
  if (!r.ok) fail(2, `GHCR token request for ${org}/${repo} failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.token) fail(2, `GHCR token response for ${org}/${repo} carried no token`);
  return j.token;
}

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function checkRegistry(org, pins) {
  let bad = 0;
  for (const p of pins) {
    const token = await ghcrToken(org, p.repo);
    const r = await withTimeout(
      `${GHCR}/v2/${org}/${p.repo}/manifests/${encodeURIComponent(p.tag)}`,
      { method: "HEAD", headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } },
    );
    const digest = r.headers.get("docker-content-digest") || "";
    if (!r.ok || !digest) {
      bad++;
      console.log(`  FAIL  ${p.key.padEnd(14)} ghcr.io/${org}/${p.repo}:${p.tag} does not resolve (HTTP ${r.status})`);
      continue;
    }
    // cp#601: the tag must still resolve to the PINNED digest. A re-pushed tag is drift even when
    // the tag itself resolves, because tenants pull by digest.
    if (digest !== p.digest) {
      bad++;
      console.log(`  FAIL  ${p.key.padEnd(14)} ghcr.io/${org}/${p.repo}:${p.tag} now resolves to ${digest}, pinned ${p.digest}`);
      continue;
    }
    console.log(`  ok    ${p.key.padEnd(14)} ghcr.io/${org}/${p.repo}:${p.tag}  ${digest.slice(0, 19)} == pinned`);
  }
  return bad;
}

async function prodImages(key, wantedIds) {
  const auth = { Authorization: `Bearer ${key}` };
  // v2: an endpoint carries its own image (`GET /v2/serverless/{id}` -> `image`), so each pinned
  // endpoint is one read and no template is involved. Only the endpoints a pin claims to mirror are
  // read, so an unrelated endpoint can never make the check unrunnable.
  const byId = new Map();
  for (const id of wantedIds) {
    const res = await withTimeout(`${RUNPOD_API}/serverless/${encodeURIComponent(id)}`, { headers: auth });
    // 404: this key cannot see that endpoint. checkProd reports it as a FAIL by name.
    if (res.status === 404) continue;
    if (!res.ok) fail(2, `RunPod endpoint ${id} read failed: HTTP ${res.status}`);
    let ep;
    try {
      ep = await res.json();
    } catch {
      fail(2, `RunPod endpoint ${id} returned a body that is not JSON`);
    }
    if (typeof ep?.image !== "string" || !ep.image) fail(2, `RunPod endpoint ${id} carries no image -- cannot measure`);
    byId.set(id, { name: String(ep.name ?? id), image: ep.image });
  }
  return byId;
}

async function checkProd(org, pins) {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) fail(2, "--prod needs RUNPOD_API_KEY (the PRODUCTION account key) in the environment");
  const live = await prodImages(key, new Set(pins.map((p) => p.endpointId)));
  let bad = 0;
  for (const p of pins) {
    const ep = live.get(p.endpointId);
    if (!ep) {
      // Not a pass and not a drift: this key cannot see the endpoint the pin claims to mirror.
      bad++;
      console.log(`  FAIL  ${p.key.padEnd(14)} production endpoint ${p.endpointId} not visible to this key`);
      continue;
    }
    const want = `ghcr.io/${org}/${p.repo}:${p.tag}@${p.digest}`;
    if (ep.image !== want) {
      bad++;
      console.log(`  DRIFT ${p.key.padEnd(14)} pinned ${want}`);
      console.log(`        ${" ".repeat(14)} production (${ep.name}) runs ${ep.image || "(no image)"}`);
      continue;
    }
    console.log(`  ok    ${p.key.padEnd(14)} ${want}  == production ${ep.name} (${p.endpointId})`);
  }
  return bad;
}

const prod = process.argv.includes("--prod");
const { org, pins } = readPins();
console.log(`check-satellite-pins: ${pins.length} pins, mode=${prod ? "production" : "registry"}`);
if (OVERRIDES.length) {
  console.log(`  REDIRECTED by ${OVERRIDES.join(", ")}: this run is NOT a measurement of the live registry`);
}
const bad = prod ? await checkProd(org, pins) : await checkRegistry(org, pins);
if (bad > 0) {
  console.error(
    prod
      ? `\n${bad} pin(s) do not match production. The plane provisions NEW tenants onto these images:\n` +
        "move src/satellite-pins.ts to what production runs (and re-read the mirrors dates), or fix production."
      : `\n${bad} pin(s) do not resolve at GHCR. A tenant provisioned on one of these gets an endpoint that cannot pull.`,
  );
  process.exit(1);
}
console.log(`\nall ${pins.length} pins verified.`);
