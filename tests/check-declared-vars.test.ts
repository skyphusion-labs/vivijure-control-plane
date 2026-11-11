// Drive scripts/check-declared-vars.mjs (cp#533) as a CHILD PROCESS against a temporary declaration,
// and assert the NAMED reason and the exit code for each arm. The declaration path is redirected
// with CHECK_DECLARED_VARS_FILE so the real config/declared-vars.json is never edited by a test.
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-declared-vars.mjs");
const dir = mkdtempSync(join(tmpdir(), "cp533-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

function decl(body: unknown): string {
  const p = join(dir, `decl-${++n}.json`);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}
function run(env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}
const POOL = { backend: { id: "abc123", name: "vivijure-backend-hosted" } };
const one = { SHARED_RUNPOD_ENDPOINTS: { compare: "json", value: POOL } };

describe("check-declared-vars (cp#533)", () => {
  it("passes when the live JSON equals the declaration, whatever the key order", async () => {
    const live = '{"backend":{"name":"vivijure-backend-hosted","id":"abc123"}}';
    const { code, out } = await run({ CHECK_DECLARED_VARS_FILE: decl(one), SHARED_RUNPOD_ENDPOINTS: live });
    expect(out).toContain("ok    SHARED_RUNPOD_ENDPOINTS matches the declared value");
    expect(code).toBe(0);
  });

  it("refuses a live value that differs from the declaration, and shows both", async () => {
    const live = JSON.stringify({ backend: POOL.backend, lipsync: { id: "zw6pt4lymf69pk", name: "x" } });
    const { code, out } = await run({ CHECK_DECLARED_VARS_FILE: decl(one), SHARED_RUNPOD_ENDPOINTS: live });
    expect(out).toContain("DRIFT SHARED_RUNPOD_ENDPOINTS: live");
    expect(out).toContain("zw6pt4lymf69pk");
    expect(code).toBe(1);
  });

  it("refuses a declared variable that is unset or empty", async () => {
    for (const v of [undefined, "", "   "]) {
      const { code, out } = await run({ CHECK_DECLARED_VARS_FILE: decl(one), SHARED_RUNPOD_ENDPOINTS: v });
      expect(out).toContain("declared but the live variable is unset or empty");
      expect(code).toBe(1);
    }
  });

  it("refuses a live value that is not valid JSON", async () => {
    const { code, out } = await run({ CHECK_DECLARED_VARS_FILE: decl(one), SHARED_RUNPOD_ENDPOINTS: "{not json" });
    expect(out).toContain("the live value is not valid JSON");
    expect(code).toBe(1);
  });

  it("compares a text variable after trimming", async () => {
    const d = decl({ AUP_VERSION: { compare: "text", value: "1.1.0" } });
    expect((await run({ CHECK_DECLARED_VARS_FILE: d, AUP_VERSION: " 1.1.0\n" })).code).toBe(0);
    const bad = await run({ CHECK_DECLARED_VARS_FILE: d, AUP_VERSION: "1.0.0" });
    expect(bad.out).toContain('AUP_VERSION: live "1.0.0" != declared "1.1.0"');
    expect(bad.code).toBe(1);
  });

  it("cannot measure (exit 2) on an unreadable, empty or malformed declaration", async () => {
    expect((await run({ CHECK_DECLARED_VARS_FILE: join(dir, "missing.json") })).code).toBe(2);
    expect((await run({ CHECK_DECLARED_VARS_FILE: decl("{not json") })).code).toBe(2);
    const empty = await run({ CHECK_DECLARED_VARS_FILE: decl({ _doc: "only a note" }) });
    expect(empty.out).toContain("names no variable");
    expect(empty.code).toBe(2);
    const shape = await run({ CHECK_DECLARED_VARS_FILE: decl({ X: { value: 1 } }), X: "1" });
    expect(shape.out).toContain('needs "value" and "compare"');
    expect(shape.code).toBe(2);
  });

  it("the shipped declaration parses and names SHARED_RUNPOD_ENDPOINTS as JSON", () => {
    const shipped = JSON.parse(readFileSync(join(ROOT, "config", "declared-vars.json"), "utf8"));
    expect(shipped.SHARED_RUNPOD_ENDPOINTS.compare).toBe("json");
    expect(typeof shipped.SHARED_RUNPOD_ENDPOINTS.value).toBe("object");
  });
});
