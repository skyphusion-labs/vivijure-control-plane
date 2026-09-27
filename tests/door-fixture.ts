// The own-iron door fixture, DERIVED from the plan.

import { doorBackedPlan, type ResolvedDoor } from "../src/runpod";

export const TEST_VPC_DOORS: Record<string, ResolvedDoor> = Object.fromEntries(
  doorBackedPlan().map((c) => [
    c.key,
    {
      doorsUrlVar: c.doorsUrlVar,
      // ONE door-backed capability since cp#519 (upscale). Derived from the key so a second door
      // added to the plan gets a distinct pair rather than silently sharing this one.
      doorsUrl: `https://${c.key}-fatmike.test,https://${c.key}-propagandhi.test`,
      tokens: c.tokens.map((tok) => ({
        bindingName: tok.bindingName,
        token: `door-token-${tok.bindingName.toLowerCase()}`,
      })),
    },
  ]),
);
