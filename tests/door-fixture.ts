// The own-iron door fixture, DERIVED from the plan (cp#396).
//
// Hand-written door literals are the same defect the transport split already tripped over once: a
// fixture that hardcodes what it should derive cannot fail when the source of truth moves, and it
// silently stops covering a door the plan gains. So every suite that needs a fully-wired plane
// imports this, and adding a third box means editing the PLAN and nothing else.
//
// A FULLY CONFIGURED plane is the right default for these suites: they are about proxy, telemetry,
// R2, upgrade and provisioning behaviour, and a missing door would make them refuse at
// modules_upload for a reason none of them is testing. The zero-door and half-door cases are
// asserted deliberately, in the suites that own that claim.

import { vpcBackedPlan, type ResolvedDoor } from "../src/runpod";

/** Every door the plan declares, resolved with synthetic values. Legacy door first, as in the plan. */
export const TEST_VPC_DOORS: Record<string, ResolvedDoor[]> = Object.fromEntries(
  vpcBackedPlan().map((c) => [
    c.key,
    c.doors.map((d) => ({
      bindingName: d.bindingName,
      doorTokenBinding: d.doorTokenBinding,
      serviceId: `svc-${d.bindingName.toLowerCase()}`,
      token: `door-token-${d.bindingName.toLowerCase()}`,
    })),
  ]),
);
