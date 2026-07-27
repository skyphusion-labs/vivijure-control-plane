// Types for public/credits-checks.js (cp#194). Hand-written, matching the
// sibling .d.ts files: these assets are vanilla JS by deliberate choice and are
// not compiled, so the declarations exist for the test suite's typecheck only.
export declare const MICRO_PER_USD: number;
export declare function formatUsd(micro: number): string | null;
export declare function isEmpty(micro: number): boolean;
export declare function panelState(payload: unknown): {
  show: boolean;
  reason: "not_applicable" | "unreadable" | "ok";
};
export declare function topUpState(payload: unknown): "hidden" | "available" | "not_open_yet";
export declare function lineLabel(kind: string): string;
export declare function projectLine(line: unknown): {
  id: string;
  label: string;
  kind: string;
  amount: string | null;
  job_ref: string | null;
  note: string | null;
  when: string | null;
} | null;
export declare function projectActivity(payload: unknown): ReturnType<typeof projectLine>[];
