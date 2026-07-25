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
const RUNPOD_API = "https://rest.runpod.io/v1";
const TIMEOUT_MS = 20_000;

/** Parse the pins out of the TS source: no build step, no runtime dep, one source of truth. */
function readPins() {
  const src = readFileSync(PINS_TS, "utf8");
  const org = /GHCR_ORG = "([^"]+)"/.exec(src)?.[1];
  if (!org) fail(2, "could not read GHCR_ORG from src/satellite-pins.ts");
  const body = src.slice(src.indexOf("export const SATELLITE_PINS"));
  const re = /"?([a-z-]+)"?:\s*\{\s*repo:\s*"([^"]+)",\s*tag:\s*"([^"]+)",\s*mirrors:\s*\{\s*endpointId:\s*"([^"]+)",\s*readAt:\s*"([^"]+)"/g;
  const pins = [...body.matchAll(re)].map((m) => ({
    key: m[1], repo: m[2], tag: m[3], endpointId: m[4], readAt: m[5],
  }));
  if (pins.length === 0) fail(2, "parsed ZERO pins from src/satellite-pins.ts -- refusing to report a pass");
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
  } finally {
    clearTimeout(t);
  }
};

/** Anonymous GHCR pull token for a public package. */
async function ghcrToken(org, repo) {
  const url = `https://ghcr.io/token?service=ghcr.io&scope=repository:${org}/${repo}:pull`;
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
      `https://ghcr.io/v2/${org}/${p.repo}/manifests/${encodeURIComponent(p.tag)}`,
      { method: "HEAD", headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } },
    );
    const digest = r.headers.get("docker-content-digest") || "";
    if (!r.ok || !digest) {
      bad++;
      console.log(`  FAIL  ${p.key.padEnd(14)} ghcr.io/${org}/${p.repo}:${p.tag} does not resolve (HTTP ${r.status})`);
      continue;
    }
    console.log(`  ok    ${p.key.padEnd(14)} ghcr.io/${org}/${p.repo}:${p.tag}  ${digest.slice(0, 19)}`);
  }
  return bad;
}

async function prodImages(key, wantedIds) {
  const auth = { Authorization: `Bearer ${key}` };
  const eps = await withTimeout(`${RUNPOD_API}/endpoints`, { headers: auth });
  if (!eps.ok) fail(2, `RunPod endpoint list failed: HTTP ${eps.status}`);
  const list = await eps.json();
  if (!Array.isArray(list)) fail(2, "RunPod endpoint list was not an array -- API shape changed");
  const byId = new Map();
  for (const ep of list) {
    // Only the endpoints a pin claims to mirror. Reading every template in the account would let an
    // UNRELATED endpoint (e.g. a hub template this key cannot read) make the check unrunnable.
    if (!wantedIds.has(ep.id) || !ep.templateId) continue;
    const t = await withTimeout(`${RUNPOD_API}/templates/${ep.templateId}`, { headers: auth });
    if (!t.ok) fail(2, `RunPod template ${ep.templateId} (endpoint ${ep.id}) read failed: HTTP ${t.status}`);
    const tpl = await t.json();
    byId.set(ep.id, { name: ep.name, image: tpl.imageName || "" });
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
    const want = `ghcr.io/${org}/${p.repo}:${p.tag}`;
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
