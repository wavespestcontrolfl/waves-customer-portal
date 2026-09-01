import { describe, expect, test } from "vitest";
import {
  SERVICE_COMPLETION_PRESETS,
  reconcileExclusiveProtocolSelections,
  replaceFindingGroupSelection,
  specialtyCompletionFor,
} from "./service-completion-presets";

describe("specialty pest completion configuration", () => {
  test.each([
    ["fire_ant", "Fire Ant Treatment"],
    ["tick_control", "Tick Control Service"],
    ["bee_wasp_removal", "Yellowjacket Removal"],
    ["mud_dauber_removal", "Mud Dauber Removal"],
    ["bed_bug_treatment", "Bed Bug Hybrid Treatment"],
  ])("resolves %s by stable profile key", (serviceKey, serviceType) => {
    expect(specialtyCompletionFor({
      serviceType,
      completionProfile: { serviceKey },
    })).toBe(SERVICE_COMPLETION_PRESETS[serviceKey]);
  });

  test.each(["mosquito_monthly", "mosquito_seasonal", "mosquito_one_time"])(
    "maps %s to the shared mosquito report inputs",
    (serviceKey) => {
      expect(specialtyCompletionFor({
        serviceType: "Admin-editable display name",
        completionProfile: { serviceKey },
      })).toBe(SERVICE_COMPLETION_PRESETS.mosquito);
    },
  );

  test.each(["dethatching", "plugging"])(
    "resolves the mechanical lawn service %s without pesticide actions",
    (serviceKey) => {
      const config = specialtyCompletionFor({
        serviceType: "Admin-editable display name",
        completionProfile: { serviceKey },
      });
      expect(config).toBe(SERVICE_COMPLETION_PRESETS[serviceKey]);
      expect(config.protocols.every((action) => action.treatmentApplied === false)).toBe(true);
    },
  );

  test("falls back to service-name matching for legacy schedule rows", () => {
    expect(specialtyCompletionFor({ serviceType: "Bee Removal" }))
      .toBe(SERVICE_COMPLETION_PRESETS.bee_wasp_removal);
    expect(specialtyCompletionFor({ serviceType: "Bed Bug Heat Treatment" }))
      .toBe(SERVICE_COMPLETION_PRESETS.bed_bug_treatment);
  });

  test("replaces only the prior choice from the same finding group", () => {
    const group = SERVICE_COMPLETION_PRESETS.fire_ant.findingGroups[0];
    expect(replaceFindingGroupSelection(
      ["Active mounds observed", "Widespread activity"],
      group,
      "No active fire ants observed",
    )).toEqual(["Widespread activity", "No active fire ants observed"]);
  });

  test("each protocol action has explicit treatment and scope metadata", () => {
    Object.values(SERVICE_COMPLETION_PRESETS).forEach((config) => {
      expect(config.areas.length).toBeGreaterThan(0);
      expect(config.findingGroups.length).toBeGreaterThan(0);
      config.protocols.forEach((action) => {
        expect(["interior", "exterior"]).toContain(action.scope);
        expect(typeof action.treatmentApplied).toBe("boolean");
      });
    });
  });

  test("inspection and deferred choices are explicitly exclusive from performed work", () => {
    Object.values(SERVICE_COMPLETION_PRESETS).forEach((config) => {
      const exclusive = config.protocols.filter((action) => action.exclusive);
      expect(exclusive.length).toBeGreaterThan(0);
      exclusive.forEach((action) => expect(action.treatmentApplied).toBe(false));
    });
  });

  test("performed actions can stack while inspection or deferred choices replace performed work", () => {
    const protocols = SERVICE_COMPLETION_PRESETS.bee_wasp_removal.protocols;
    expect(reconcileExclusiveProtocolSelections(
      ["Exposed nest treated"],
      protocols,
      "Nest physically removed",
    )).toEqual(["Exposed nest treated", "Nest physically removed"]);

    expect(reconcileExclusiveProtocolSelections(
      ["Exposed nest treated", "Nest physically removed"],
      protocols,
      "Inspection and identification only",
    )).toEqual(["Inspection and identification only"]);

    expect(reconcileExclusiveProtocolSelections(
      ["Inspection and identification only"],
      protocols,
      "Ground nest treated",
    )).toEqual(["Ground nest treated"]);
  });

  test("bed bug includes heat and hybrid while bee removal includes yellowjacket-compatible work", () => {
    const bedBugLabels = SERVICE_COMPLETION_PRESETS.bed_bug_treatment.protocols.map((item) => item.label);
    expect(bedBugLabels).toContain("Heat treatment");
    expect(bedBugLabels).toContain("Hybrid heat and chemical treatment");

    const beeLabels = SERVICE_COMPLETION_PRESETS.bee_wasp_removal.protocols.map((item) => item.label);
    expect(beeLabels).toContain("Exposed nest treated");
    expect(beeLabels).toContain("Ground nest treated");
    expect(SERVICE_COMPLETION_PRESETS.bee_wasp_removal.findingGroups[0].options)
      .toContainEqual({ value: "Yellowjacket", label: "Yellowjacket" });
  });

  test("nonchemical bed bug work does not claim a pesticide application scope", () => {
    const methods = new Map(
      SERVICE_COMPLETION_PRESETS.bed_bug_treatment.protocols
        .map((item) => [item.label, item]),
    );
    expect(methods.get("Steam treatment performed").treatmentApplied).toBe(false);
    expect(methods.get("Heat treatment").treatmentApplied).toBe(false);
    expect(methods.get("Hybrid heat and chemical treatment").treatmentApplied).toBe(true);
  });
});
