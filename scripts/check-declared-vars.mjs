#!/usr/bin/env node
// check-declared-vars.mjs -- cp#533. Refuse a deploy whose LIVE repo variables disagree with the
// values DECLARED in config/declared-vars.json.
//
// THE DEFECT THIS EXISTS FOR. SHARED_RUNPOD_ENDPOINTS was live infra state held only as a GitHub
// Actions variable. No file described its value, so a change to it could have a CR and no
// implementing diff, and it went stale unseen: it carried `lipsync -> zw6pt4lymf69pk` for six weeks
// after cp#517 deleted that endpoint, and it silently blocked the v1.29.4 rollback, which nobody knew
// because nobody re-ran a deploy at that tag. AUP_VERSION drifted the same way once (cp#396), and the
// answer there is this shape: a declared value in the repository plus a gate that refuses when live
// and declared disagree. Then a change is a PR, the CR has a diff, and drift is loud.
//
// WHAT IT ENFORCES. For every variable declared in the file:
//   the variable is unset or empty            -> REFUSE (a declared value with no live value is drift)
//   compare "json": both parse, and are equal as JSON values (key order does not matter)
//   compare "text": byte-equal after trimming surrounding whitespace
//   anything else                              -> REFUSE, naming the variable and what differs
// Exit 0 when every declared variable matches; 1 on any disagreement; 2 when the declaration file
// itself cannot be read or is malformed (an unreadable declaration verifies nothing).
//
// The values these variables carry are configuration, not credentials, and safe to print (see
// src/runpod-pool.ts on endpoint ids). Never declare a SECRET here: secrets are not variables.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = process.env.CHECK_DECLARED_VARS_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", "config", "declared-vars.json");

function fail(code, msg) {
  console.error(`check-declared-vars: ${msg}`);
  process.exit(code);
}

let decl;
try {
  decl = JSON.parse(readFileSync(FILE, "utf8"));
} catch (e) {
  fail(2, `cannot read the declaration ${FILE}: ${e.message} -- an unreadable declaration verifies nothing`);
}
if (!decl || typeof decl !== "object" || Array.isArray(decl)) fail(2, "the declaration is not a JSON object");
const names = Object.keys(decl).filter((k) => !k.startsWith("_"));
if (names.length === 0) fail(2, "the declaration names no variable -- refusing to report a pass on an empty list");

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

const problems = [];
for (const name of names) {
  const d = decl[name];
  if (!d || typeof d !== "object" || !("value" in d) || !["json", "text"].includes(d.compare)) {
    fail(2, `${name}: each entry needs "value" and "compare" ("json" or "text")`);
  }
  const live = process.env[name];
  if (live === undefined || live.trim() === "") {
    problems.push(`${name} is declared but the live variable is unset or empty`);
    continue;
  }
  if (d.compare === "json") {
    let parsed;
    try {
      parsed = JSON.parse(live);
    } catch {
      problems.push(`${name}: the live value is not valid JSON`);
      continue;
    }
    const a = JSON.stringify(canon(parsed));
    const b = JSON.stringify(canon(d.value));
    if (a !== b) problems.push(`${name}: live ${a} != declared ${b}`);
    else console.log(`  ok    ${name} matches the declared value (JSON, ${a.length} chars)`);
  } else {
    if (live.trim() !== String(d.value).trim()) problems.push(`${name}: live ${JSON.stringify(live.trim())} != declared ${JSON.stringify(String(d.value).trim())}`);
    else console.log(`  ok    ${name} matches the declared value (text)`);
  }
}
console.log(`check-declared-vars: ${names.length} declared variable(s) checked against ${FILE.replace(/.*\/config\//, "config/")}`);
if (problems.length) {
  for (const p of problems) console.log(`  DRIFT ${p}`);
  console.log("  Change the declaration and the variable TOGETHER: edit config/declared-vars.json in a PR, then set the variable to match.");
  process.exit(1);
}
