// resolve-guard: every function a vanilla-JS asset calls must actually exist.
//
// WHY THIS EXISTS. In one night this repo shipped three identical defects into
// the hosted assets: an edit removed a helper (finishAndShowDone, then
// showAupError/hideAupError) while leaving its call sites behind. Each one was
// invisible to everything guarding the repo:
//   - `node --check` parses; a call to a missing function is valid syntax.
//   - `tsc` does not see these files; the frontend is deliberately build-free.
//   - the vitest suite tests the PURE helpers; it never loads the DOM path.
// Every one was caught only by driving the page in a browser and reading a
// ReferenceError. Three times is a pattern, not luck, so this is the check.
//
// WHAT IT IS, HONESTLY. A heuristic, not a type checker. It strips comments and
// strings, collects what each PAGE defines (see the scope model below), and
// flags calls to bare identifiers that nothing defines. It is tuned to have no
// false positives rather than to catch everything: it will miss a call to a
// function defined inside a different IIFE (not visible at runtime, but this
// tool cannot see scope), so a clean run does not prove the page works. It
// proves nobody deleted a function out from under its callers, which is the
// bug we actually keep writing.
//
// SCOPE MODEL. These are classic <script> tags sharing one global scope, so the
// unit of analysis is the PAGE, not the file: for each HTML, the union of the
// definitions in every script it loads. Per-file analysis would flag every
// cross-file call in the planner as undefined, and a guard that cries wolf is a
// guard that gets ignored -- which is worse than no guard, because it teaches
// people to skip the output.
//
// ESCAPE HATCH: annotate, never silence. There is deliberately no way to skip a
// file or disable the guard. The only override is per-identifier, in the file
// that needs it, WITH a reason:
//
//     // resolve-guard-allow: someGlobal -- injected by the foo.js CDN shim
//
// An annotation that suppresses nothing is itself an error, so they cannot rot
// quietly into a permanent blanket.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOTS = ["public"];
const MIN_REASON = 10;

// Bare identifiers that are legitimately callable without a local definition:
// language built-ins and the browser globals these assets actually use. Keep
// this list tight; a too-broad list quietly disarms the guard.
const GLOBALS = new Set([
  // syntax that regex-matches like a call
  "if", "for", "while", "switch", "catch", "return", "typeof", "new", "do", "else",
  "try", "function", "await", "delete", "in", "of", "void", "case",
  // language built-ins
  "String", "Number", "Boolean", "Array", "Object", "JSON", "Promise", "Error",
  "Date", "Math", "Set", "Map", "Symbol", "RegExp", "parseInt", "parseFloat",
  "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI",
  "decodeURI", "BigInt", "structuredClone", "queueMicrotask",
  // browser globals
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "alert",
  "confirm", "prompt", "requestAnimationFrame", "cancelAnimationFrame", "atob",
  "btoa", "URL", "URLSearchParams", "FormData", "Blob", "File", "FileReader",
  "Image", "Audio", "Headers", "Request", "Response", "AbortController",
  "IntersectionObserver", "MutationObserver", "ResizeObserver", "CustomEvent",
  "Event", "EventSource", "WebSocket", "TextEncoder", "TextDecoder", "DOMParser",
  "getComputedStyle", "matchMedia", "scrollTo", "open", "close", "print",
  "Notification", "async", "Worker", "SharedWorker", "Option", "XMLHttpRequest",
  // CommonJS interop used by the UMD wrappers
  "require", "factory",
]);

// Blank out comments, strings, and regex literals, preserving offsets so the
// reported line numbers stay true.
//
// This is a character scanner rather than a set of regexes, and the reason is a
// bug this tool had on its first run: `.replace(/\/\*[\s\S]*?\*\//g, "")` saw
// the `/*` inside the STRING "/api/*" (public/auth-token.js), treated it as a
// block-comment opener, and swallowed everything to the next `*/` -- including
// the `function syncCookie` definition it was supposed to find. It then
// reported syncCookie() as undefined. 68 false positives on a clean main, i.e.
// exactly the cry-wolf guard that teaches people to ignore the output. You
// cannot lex JavaScript with a regex, so this does not try to.
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // Track the last significant character so a `/` can be classified as a regex
  // literal (after an operator/keyword) or a division (after a value).
  let prev = "";

  const keep = (ch) => { out += ch; if (!/\s/.test(ch)) prev = ch; };
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out += src[k] === "\n" ? "\n" : " ";
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? n : nl;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? n : close + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === ch) break;
        j++;
      }
      const stop = Math.min(j + 1, n);
      blank(i, stop);
      i = stop;
      prev = "x"; // a string is a value, so a following `/` is division
      continue;
    }
    if (ch === "/" && prev && !/[\w$)\]]/.test(prev)) {
      // Regex literal: skip to the closing `/`, honouring escapes and classes.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        const stop = j + 1;
        blank(i, stop);
        i = stop;
        prev = "x";
        continue;
      }
    }
    keep(ch);
    i++;
  }
  return out;
}

function definitionsIn(src) {
  const out = new Set();
  for (const m of src.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // object-literal + class methods:  name(args) {   /   async name(args) {
  for (const m of src.matchAll(/(?:^|[{,;]\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) out.add(m[1]);
  // property style:  name: function ...   /   name: (a) => ...
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g)) out.add(m[1]);
  // function params + destructuring + catch bindings can shadow into calls
  for (const m of src.matchAll(/(?:function\s*\*?\s*[\w$]*\s*|catch\s*)\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const n = p.trim().replace(/[.]{3}/, "").split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
    }
  }
  // arrow params:  (a, b) => / a =>
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(",")) {
      const n = p.trim().split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
    }
  }
  for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
  return out;
}

function annotationsIn(raw, file) {
  // Parsed from the RAW source: annotations live in comments, which the strip
  // pass deletes.
  const allow = new Map();
  const bad = [];
  const lines = raw.split("\n");
  lines.forEach((line, i) => {
    const m = /resolve-guard-allow:\s*([A-Za-z_$][\w$]*)\s*(?:--\s*(.*))?$/.exec(line);
    if (!m) return;
    const reason = (m[2] || "").trim();
    if (reason.length < MIN_REASON) {
      bad.push({ file, line: i + 1, name: m[1],
        msg: `resolve-guard-allow for "${m[1]}" needs a reason after "--" (at least ${MIN_REASON} characters). An override without a reason is a silence, not an annotation.` });
      return;
    }
    allow.set(m[1], { line: i + 1, reason });
  });
  return { allow, bad };
}

function callsIn(src) {
  const out = [];
  // A bare identifier followed by "(" and NOT preceded by a dot/word: a call to
  // something that must resolve in scope.
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    out.push({ name: m[1], index: m.index });
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function scriptsFor(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const dir = dirname(htmlPath);
  const out = [];
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue; // external: not ours to resolve
    out.push(join(dir, m[1]));
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let problems = 0;
const pages = [];
for (const root of ROOTS) {
  for (const f of walk(root)) if (f.endsWith(".html")) pages.push(f);
}
if (pages.length === 0) {
  console.error("::error::resolve-guard found no HTML pages to check -- the guard is looking in the wrong place, which is a silent pass and worse than a failure.");
  process.exit(1);
}

for (const page of pages) {
  const files = scriptsFor(page);
  if (!files.length) continue;

  // Page scope: the union of every script the page loads (classic scripts share
  // one global).
  const pageDefs = new Set();
  const parsed = [];
  for (const f of files) {
    let raw;
    try { raw = readFileSync(f, "utf8"); } catch {
      console.error(`::error file=${page}::resolve-guard: ${page} loads ${f}, which does not exist.`);
      problems++;
      continue;
    }
    const src = stripCommentsAndStrings(raw);
    const defs = definitionsIn(src);
    for (const d of defs) pageDefs.add(d);
    parsed.push({ file: f, raw, src });
  }

  for (const { file, raw, src } of parsed) {
    const { allow, bad } = annotationsIn(raw, file);
    for (const b of bad) {
      console.error(`::error file=${b.file},line=${b.line}::${b.msg}`);
      problems++;
    }

    const used = new Set();
    for (const call of callsIn(src)) {
      if (pageDefs.has(call.name) || GLOBALS.has(call.name)) continue;
      if (allow.has(call.name)) { used.add(call.name); continue; }
      console.error(
        `::error file=${file},line=${lineOf(src, call.index)}::resolve-guard: "${call.name}()" is called but nothing on ${page} defines it. If it is a real global, annotate it: // resolve-guard-allow: ${call.name} -- why it resolves at runtime`,
      );
      problems++;
    }

    // A stale annotation is an error: overrides must not rot into blanket
    // permission for a name nobody calls any more.
    for (const [name, meta] of allow) {
      if (!used.has(name)) {
        console.error(`::error file=${file},line=${meta.line}::resolve-guard: the annotation for "${name}" suppresses nothing on ${page}. Remove it.`);
        problems++;
      }
    }
  }
}

if (problems) {
  console.error(`\nresolve-guard: ${problems} problem(s). These are the defects that node --check, tsc, and the unit suite all pass.`);
  process.exit(1);
}
console.log(`resolve-guard: clean (${pages.length} pages checked).`);
