// The own-iron door fixture, DERIVED from the plan.

import { doorBackedPlan, type ResolvedDoor } from "../src/runpod";

export const TEST_VPC_DOORS: Record<string, ResolvedDoor> = Object.fromEntries(
  doorBackedPlan().map((c) => [
    c.key,
    {
      doorsUrlVar: c.doorsUrlVar,
      doorsUrl: c.key === "upscale"
        ? "https://finish-upscale-fatmike.test,https://finish-upscale-propagandhi.test"
        : "https://speech-upscale-fatmike.test,https://speech-upscale-propagandhi.test",
      tokens: c.tokens.map((tok) => ({
        bindingName: tok.bindingName,
        token: `door-token-${tok.bindingName.toLowerCase()}`,
      })),
    },
  ]),
);
