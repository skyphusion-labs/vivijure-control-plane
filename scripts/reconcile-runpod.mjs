#!/usr/bin/env node
// Gather a RunPod snapshot with YOUR key and ask the plane what has drifted (cp#137).
//
//   set -a; . ~/your-runpod.env; set +a
//   node scripts/reconcile-runpod.mjs --plane https://studio.vivijure.com --account-label prod
//   node scripts/reconcile-runpod.mjs --dry-run          # print the snapshot, post nothing
//
// WHY THE SNAPSHOT COMES FROM HERE. The plane deliberately holds no credential that can read a
// RunPod account (key A is used once at provision and never stored, key B is invoke-only), so it
// cannot poll RunPod and a background reconciler is not buildable without breaking that custody
// boundary on purpose. This tool carries the operator key, reads TWO lists, and hands the plane the
// half it cannot see. Both lists matter: deleting an endpoint does not delete the template under it,
// so an endpoint-only sweep removes half the debris while reading as complete (cp#117).
//
// IT CHANGES NOTHING. Two GETs against RunPod and one POST to a plane route that only reads. No
// deletes here, ever: remediation is separate, lead-approved work.
//
// Exit 0 = clean. Exit 1 = real drift. Exit 2 = the check could not be PERFORMED (network, auth,
// shape, or a census that could not be proven whole). 2 is never a pass: an unreadable check is not
// a clean one, exactly as in check-satellite-pins.mjs.

// RunPod REST v2 (fleet-chezmoi#2083; v1 retires 2026-11-15). RUNPOD_API_BASE exists for the
// script's own tests, which point it at a local fake; nothing else sets it.
const RUNPOD_API = (process.env.RUNPOD_API_BASE || "https://api.runpod.io/v2").replace(/\/$/, "");
/** The v2 path for each kind this tool inventories. */
const LIST_PATH = { endpoints: "/serverless", templates: "/templates" };
const TIMEOUT_MS = 20_000;

function fail(code, msg) {
  console.error(`reconcile-runpod: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const DRY_RUN = has("--dry-run");
const ACCOUNT_LABEL = flag("--account-label", "prod");
const PLANE = (flag("--plane", process.env.CONTROL_PLANE_URL) || "").replace(/\/$/, "");

// Presence checks only. A key is never printed, never echoed, never passed on a command line.
const KEY = process.env.RUNPOD_API_KEY;
if (!KEY) fail(2, "RUNPOD_API_KEY is not set; nothing to read RunPod with");
const ADMIN = process.env.CONTROL_PLANE_ADMIN_TOKEN;
if (!DRY_RUN && !ADMIN) fail(2, "CONTROL_PLANE_ADMIN_TOKEN is not set; run with --dry-run to only gather");
if (!DRY_RUN && !PLANE) fail(2, "no plane URL: pass --plane https://... or set CONTROL_PLANE_URL");

const withTimeout = async (url, init = {}) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
};

/**
 * Was this list WHOLE? Mirrors listWasWhole() in src/reconcile-runpod.ts; keep the two in step.
 * A truncated page that reports itself complete turns into a confident "that resource is gone",
 * which is the one wrong answer this tool must never give.
 */
function itemsOf(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload[key])) return payload[key];
    if (Array.isArray(payload.data)) return payload.data;
    // v2's OpenAPI names the list by kind; RunPod's own v2 tooling was read returning `items`.
    if (Array.isArray(payload.items)) return payload.items;
  }
  return [];
}

/**
 * Read one v2 list to its END. v2 paginates every list (`pagination.nextCursor` while
 * `pagination.hasNextPage`), so a single page is not an inventory. `whole` is true only when the walk
 * reached a page that says it is the last; anything else (a page claiming more with no cursor, a
 * page with no pagination block, the page cap) is reported as incomplete, never as complete.
 */
async function readList(kind) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 1000; page++) {
    const url = `${RUNPOD_API}${LIST_PATH[kind]}?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let res;
    try {
      res = await withTimeout(url, { headers: { authorization: `Bearer ${KEY}` } });
    } catch (e) {
      fail(2, `GET ${LIST_PATH[kind]} failed: ${String(e).slice(0, 160)}`);
    }
    if (!res.ok) fail(2, `GET ${LIST_PATH[kind]} returned HTTP ${res.status}`);
    let payload;
    try {
      payload = await res.json();
    } catch (e) {
      fail(2, `GET ${LIST_PATH[kind]} returned a body that is not JSON: ${String(e).slice(0, 120)}`);
    }
    const rows = itemsOf(payload, kind).map((r) => ({ id: String(r.id ?? ""), name: String(r.name ?? "") }));
    if (rows.some((r) => !r.id)) fail(2, `GET ${LIST_PATH[kind]} returned an entry with no id; refusing to report on it`);
    items.push(...rows);
    const pg = payload && typeof payload === "object" ? payload.pagination : undefined;
    if (!pg || typeof pg !== "object") return { items, whole: false };
    if (pg.hasNextPage !== true) return { items, whole: true };
    if (typeof pg.nextCursor !== "string" || !pg.nextCursor) return { items, whole: false };
    cursor = pg.nextCursor;
  }
  return { items, whole: false };
}

const endpoints = await readList("endpoints");
const templates = await readList("templates");

const inventory = {
  account_label: ACCOUNT_LABEL,
  read_at: new Date().toISOString(),
  complete: endpoints.whole && templates.whole,
  endpoints: endpoints.items,
  templates: templates.items,
};

if (DRY_RUN) {
  console.log(JSON.stringify(inventory, null, 2));
  process.exit(inventory.complete ? 0 : 2);
}

let res;
try {
  res = await withTimeout(`${PLANE}/api/admin/reconcile/runpod`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify(inventory),
  });
} catch (e) {
  fail(2, `POST to the plane failed: ${String(e).slice(0, 160)}`);
}
const text = await res.text();
if (!res.ok) fail(2, `the plane returned HTTP ${res.status}: ${text.slice(0, 300)}`);

let report;
try {
  report = JSON.parse(text).report;
} catch (e) {
  fail(2, `the plane returned a body that is not JSON: ${String(e).slice(0, 120)}`);
}
if (!report || typeof report.verdict !== "string") fail(2, "the plane returned no report");

console.log(JSON.stringify(report, null, 2));
console.error(
  `reconcile-runpod: verdict=${report.verdict} findings=${report.findings.length} ` +
    `tenants=${report.census.tenants} endpoints=${report.census.endpoints} templates=${report.census.templates}`,
);
if (report.verdict === "clean") process.exit(0);
if (report.verdict === "drift") process.exit(1);
process.exit(2);
