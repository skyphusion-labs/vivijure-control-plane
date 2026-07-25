// cp#112: the WIRE SHAPE of the settings PATCH, which a faked CfApi can never check.
//
// WHY THIS FILE EXISTS. Every other test in this repo swaps CfApi for a fake, so nothing exercised
// the request this method actually builds -- the same blind spot that shipped the v1.2.0 store-d1
// SQL defect. The first implementation sent `application/json`, which reads exactly like the API
// reference and which Cloudflare REFUSES with `10001 Content-Type must be one of:
// multipart/form-data`. A live probe against a throwaway script caught it; this test is that probe
// turned into something that runs on every commit.
//
// It asserts the shape, not Cloudflare's behaviour: the live probe (recorded on cp#112) is what
// established that `inherit` preserves a secret_text binding and that an omitted binding is dropped.

import { describe, expect, it, vi } from "vitest";
import { CfApi } from "../src/cf-api";

const ok = () =>
  new Response(JSON.stringify({ success: true, result: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Captures the outbound request so the BODY can be inspected, not just the URL. */
function capturing() {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return ok();
  }) as unknown as typeof fetch;
  return { seen, cf: new CfApi("acct-1", "token-1", fetchImpl) };
}

describe("CfApi.patchScriptSettings wire shape (cp#112)", () => {
  it("sends multipart with a settings part, NEVER a JSON body", async () => {
    const { seen, cf } = capturing();
    await cf.patchScriptSettings("vivijure-tenants", "tenant-hero-studio", [
      { type: "inherit", name: "STUDIO_API_TOKEN" },
      { type: "vpc_service", name: "VIDEO_FINISH_VPC", service_id: "svc-1" },
    ]);

    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/workers/dispatch/namespaces/vivijure-tenants/scripts/tenant-hero-studio/settings",
    );
    expect(seen[0].init.method).toBe("PATCH");
    // THE REGRESSION GUARD. A JSON body is what the endpoint refuses with 10001, and it is the
    // natural thing to write, so it is asserted against directly rather than implied.
    expect(typeof seen[0].init.body).not.toBe("string");
    expect(seen[0].init.body).toBeInstanceOf(FormData);
    const headers = new Headers(seen[0].init.headers as HeadersInit);
    expect(headers.get("content-type")).toBeNull();
  });

  it("puts the FULL desired binding set in the settings part, verbatim", async () => {
    // The set is sent whole because an omitted binding is DROPPED by this endpoint (measured in the
    // live probe). A test that only checked "a settings part exists" would pass over a truncated one.
    const { seen, cf } = capturing();
    const bindings = [
      { type: "inherit" as const, name: "R2_S3_SECRET_ACCESS_KEY" },
      { type: "inherit" as const, name: "RUNPOD_API_KEY" },
      { type: "vpc_service" as const, name: "VIDEO_FINISH_VPC", service_id: "svc-1" },
    ];
    await cf.patchScriptSettings("vivijure-tenants", "tenant-hero-studio", bindings);

    const form = seen[0].init.body as FormData;
    const part = form.get("settings");
    expect(part).toBeInstanceOf(Blob);
    const parsed = JSON.parse(await (part as Blob).text()) as { bindings: unknown[] };
    expect(parsed).toEqual({ bindings });
  });

  it("carries the bearer, and reports a CF refusal as CfApiError rather than swallowing it", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10001, message: "Content-Type must be one of: multipart/form-data" }] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const cf = new CfApi("acct-1", "token-1", fetchImpl);
    await expect(
      cf.patchScriptSettings("vivijure-tenants", "tenant-hero-studio", []),
    ).rejects.toThrow(/multipart\/form-data/);
  });
});
