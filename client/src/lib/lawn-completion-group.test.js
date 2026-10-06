// The bermuda removal mix's three completion options share one group id (server
// `group`), carried through to the option the completion drawer adds and removes together.
import { describe, expect, it } from "vitest";
import { lawnPlanActionOptions } from "./lawn-completion";

describe("lawnPlanActionOptions group", () => {
  const options = lawnPlanActionOptions([
    { product: { id: "p1", name: "Plain" }, applicationMethod: "broadcast_spray" },
    { product: { id: "rec", name: "Recognition" }, applicationMethod: "spot_treatment", group: "bermuda_removal" },
    { product: { id: "fus", name: "Fusilade II" }, applicationMethod: "spot_treatment", group: "bermuda_removal" },
    { product: { id: "nis", name: "Surfactant" }, applicationMethod: "spot_treatment", group: "bermuda_removal" },
  ]);

  it("carries the group on the three mix options only", () => {
    expect(options.filter((o) => o.group === "bermuda_removal").map((o) => o.product.id)).toEqual(["rec", "fus", "nis"]);
    expect(options[0]).not.toHaveProperty("group");
  });
});
