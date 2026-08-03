// THE source of truth for the container images a tenant's RunPod endpoints run (cp#126).
//
// Every pin in this file MIRRORS what production actually renders on. Not the newest release, not
// what a CHANGELOG claims: the image the production endpoint is running right now, read off RunPod.
// A hosted tenant pays to render on the line the estate has proven end to end, and the newest tag is
// not that line -- it is a tag whose only evidence is that CI was green.
//
// The drift this replaces was silent for six weeks: the pins sat at backend 1.0.2 / upscale 0.2.7 /
// musetalk 0.1.0 / audio-upscale 0.1.0 while production moved to 1.0.11 / 1.0.4 / 1.0.5 / 1.0.7,
// because "pin BOTH panels on a backend release" never grew a third leg for the PLANE. Nothing was
// wrong with anyone's diligence; there was no place a wrong pin could be SEEN.
//
// So the pins live here, exactly once, and `scripts/check-satellite-pins.mjs` makes drift loud:
//
//   npm run check:pins        -- creds-free. Every pin below must resolve at GHCR by image name.
//                                Runs in CI on every PR, so a pin at a tag that does not exist
//                                (the class of defect that shipped 0.1.0) cannot merge.
//   npm run check:pins:prod   -- needs a prod RUNPOD_API_KEY. Compares every pin against the LIVE
//                                production endpoint image. This is the third leg: run it on any
//                                satellite release, and when it goes red, this file follows.
//
// Rules that are not negotiable here:
//   - Bare release tags only. NEVER `:latest` (an endpoint would silently change under a tenant on
//     someone else's push) and NEVER a git `:sha` (the RunPod pin rule).
//   - Moving a pin means the mirrored production endpoint moved first. If you are tempted to pin
//     ahead of production, the thing to change is production.

export type SatelliteKey = "backend" | "upscale" | "lipsync" | "audio-upscale";

/** The GHCR org every satellite image lives under. The ONE place this string appears. */
export const GHCR_ORG = "skyphusion-labs";

export interface SatellitePin {
  /** GHCR repository name under `ghcr.io/<GHCR_ORG>/`. */
  repo: string;
  /** Bare release tag, e.g. "1.0.11". Never `latest`, never a git sha. */
  tag: string;
  /**
   * Provenance: the PRODUCTION endpoint this pin was read off, and when. This is the pin's only
   * authority, and it is what `check:pins:prod` re-reads. A pin without a live production endpoint
   * behind it is a guess wearing a version number.
   */
  mirrors: { endpointId: string; readAt: string };
}

/**
 * Pins as MEASURED off the production endpoints on 2026-07-25 (cp#126).
 *
 * Deliberately NOT the newest published tags on that date (upscale 1.0.5, musetalk 1.0.6,
 * audio-upscale 1.0.8): production had not adopted them. musetalk 1.0.6 in particular adds a whole
 * HTTP serve path production has never run, and a tenant is not the place to find out how it
 * behaves. When production adopts them, `check:pins:prod` goes red and this file follows it.
 */
export const SATELLITE_PINS: Record<SatelliteKey, SatellitePin> = {
  backend: {
    repo: "vivijure-backend",
    tag: "1.0.13",
    mirrors: { endpointId: "t9wcvlxh8rc5la", readAt: "2026-08-03" },
  },
  upscale: {
    repo: "vivijure-upscale",
    tag: "1.0.4",
    mirrors: { endpointId: "4q8idwbk6tyqbq", readAt: "2026-07-25" },
  },
  lipsync: {
    repo: "vivijure-musetalk",
    tag: "1.0.5",
    mirrors: { endpointId: "zw6pt4lymf69pk", readAt: "2026-07-25" },
  },
  "audio-upscale": {
    repo: "vivijure-audio-upscale",
    tag: "1.0.7",
    mirrors: { endpointId: "sj0btgpjdtswa7", readAt: "2026-07-25" },
  },
};

/** The full image reference a tenant template is created with. */
export const imageRef = (key: SatelliteKey): string => {
  const pin = SATELLITE_PINS[key];
  return `ghcr.io/${GHCR_ORG}/${pin.repo}:${pin.tag}`;
};
