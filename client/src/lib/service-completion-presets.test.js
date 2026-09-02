import { describe, expect, test } from "vitest";
import {
  SERVICE_COMPLETION_PRESETS,
  exclusiveProtocolProductConflict,
  exclusiveProtocolSelectionConflict,
  reconcileDependentFindingSelections,
  reconcileExclusiveProtocolSelections,
  replaceFindingGroupSelection,
  resolveSpecialtyServiceKey,
  noApplicationOutcomeConflict,
  specialtyCompletedWorkWithoutAction,
  specialtyCompletionFor,
  specialtyFindingActionConflict,
} from "./service-completion-presets";
import specialtyCloseouts from "../../../shared/specialty-service-closeouts";

const {
  SPECIALTY_SERVICE_CLOSEOUTS,
  observationsForSpecialtyService,
  specialtyServiceKey,
  validateSpecialtyObservationCombination,
  validateSpecialtyClosureCombination,
} = specialtyCloseouts;

describe("specialty pest completion configuration", () => {
  test("presets mirror the shared closeout vocabulary the server validates", () => {
    expect(Object.keys(SERVICE_COMPLETION_PRESETS).sort()).toEqual(Object.keys(SPECIALTY_SERVICE_CLOSEOUTS).sort());
    for (const [key, preset] of Object.entries(SERVICE_COMPLETION_PRESETS)) {
      const spec = SPECIALTY_SERVICE_CLOSEOUTS[key];
      expect(preset.areas).toEqual(spec.areas);
      expect(preset.protocols).toEqual(spec.protocols);
      expect(preset.findingGroups.map((group) => ({
        key: group.key,
        options: group.options.map((item) => item.value),
      }))).toEqual(spec.findingGroups);
      preset.findingGroups.forEach((group) => expect(group.label).toBeTruthy());
      const values = preset.findingGroups.flatMap((group) => group.options.map((item) => item.value));
      expect(new Set(observationsForSpecialtyService(key)).size).toBe(values.length);
    }
  });

  test("exclusive action conflicts produce the same message on client and server", () => {
    const preset = SERVICE_COMPLETION_PRESETS.bee_wasp_removal;
    const actions = ["Inspection and identification only", "Void nest treated"];
    expect(validateSpecialtyClosureCombination("bee_wasp_removal", { observations: [], actions }))
      .toBe(exclusiveProtocolSelectionConflict(actions, preset.protocols));
    const single = ["Inspection and identification only"];
    expect(validateSpecialtyClosureCombination("bee_wasp_removal", { observations: [], actions: single, productCount: 1 }))
      .toBe(exclusiveProtocolProductConflict(single, preset.protocols, 1));
  });

  test("no-evidence findings reject active-pest treatments with the same message on both sides", () => {
    const mud = SERVICE_COMPLETION_PRESETS.mud_dauber_removal;
    const msg = specialtyFindingActionConflict(mud, ["No current evidence observed"], ["Active nests treated"]);
    expect(msg).toContain("cannot be paired with action");
    expect(validateSpecialtyClosureCombination("mud_dauber_removal", {
      observations: ["No current evidence observed"], actions: ["Active nests treated"],
    })).toBe(msg);
    expect(specialtyFindingActionConflict(mud, ["Active mud nests"], ["Active nests treated"])).toBeNull();
  });

  test("completed-work findings need a performed action, same message on both sides", () => {
    const dethatching = SERVICE_COMPLETION_PRESETS.dethatching;
    const msg = specialtyCompletedWorkWithoutAction(dethatching, ["Heavy debris removed"], []);
    expect(msg).toContain("requires a completed protocol action");
    expect(validateSpecialtyClosureCombination("dethatching", { observations: ["Heavy debris removed"], actions: [] })).toBe(msg);
    expect(specialtyCompletedWorkWithoutAction(dethatching, ["Heavy debris removed"], ["Loose thatch collected"])).toBeNull();
  });

  test("no-application outcomes reject performed work with the same message on both sides", () => {
    const fireAnt = SERVICE_COMPLETION_PRESETS.fire_ant;
    const msg = noApplicationOutcomeConflict(fireAnt, ["Individual mound treatment"], 0, "inspection_only");
    expect(msg).toContain("cannot record the performed action");
    expect(validateSpecialtyClosureCombination("fire_ant", {
      observations: [], actions: ["Individual mound treatment"], visitOutcome: "inspection_only",
    })).toBe(msg);
    expect(noApplicationOutcomeConflict(fireAnt, ["Inspection only"], 2, "customer_declined")).toContain("applied products");
    expect(noApplicationOutcomeConflict(fireAnt, ["Individual mound treatment"], 2, "completed")).toBeNull();
  });

  test("work-state findings reject contradictory protocol actions on both sides", () => {
    const dethatching = SERVICE_COMPLETION_PRESETS.dethatching;
    const plugging = SERVICE_COMPLETION_PRESETS.plugging;
    const cases = [
      ["dethatching", dethatching, ["Inspection only"], ["Double-pass dethatching completed"], "completed action"],
      ["plugging", plugging, ["Not installed"], ["Sod plugs installed at quoted spacing"], "completed action"],
      ["dethatching", dethatching, ["Full quoted area completed"], ["Inspection only"], "finding"],
      ["plugging", plugging, ["9-inch spacing"], ["Work deferred; office follow-up required"], "finding"],
    ];
    for (const [key, preset, observations, actions, kind] of cases) {
      const clientMessage = specialtyFindingActionConflict(preset, observations, actions);
      expect(clientMessage).toContain(`cannot be paired with ${kind}`);
      expect(validateSpecialtyClosureCombination(key, { observations, actions })).toBe(clientMessage);
    }
    expect(specialtyFindingActionConflict(dethatching, ["Inspection only"], ["Work deferred; office follow-up required"]))
      .toBe("“Inspection only” cannot be paired with action “Work deferred; office follow-up required”.");
    expect(validateSpecialtyClosureCombination("plugging", {
      observations: ["Work deferred"], actions: ["Inspection only"],
    })).toBe(specialtyFindingActionConflict(plugging, ["Work deferred"], ["Inspection only"]));
    expect(specialtyFindingActionConflict(plugging, ["Not installed"], ["Work deferred; office follow-up required"])).toBeNull();
    expect(specialtyFindingActionConflict(dethatching, ["Inspection only"], ["Inspection only"])).toBeNull();
    expect(specialtyFindingActionConflict(dethatching, ["Work deferred"], ["Work deferred; office follow-up required"])).toBeNull();
    expect(specialtyFindingActionConflict(dethatching, ["Heavy debris removed"], ["Double-pass dethatching completed"])).toBeNull();
    expect(specialtyFindingActionConflict(dethatching, ["Inspection only"], ["Free-text note action"])).toBeNull();
    expect(specialtyFindingActionConflict(
      SERVICE_COMPLETION_PRESETS.bee_wasp_removal, ["Active"], ["Inspection and identification only"],
    )).toBeNull();
  });

  test("dependent selection rules match the server combination validator", () => {
    const rules = Object.entries(SERVICE_COMPLETION_PRESETS)
      .flatMap(([key, preset]) => preset.observationExclusions.map((rule) => [key, preset, rule]));
    expect(rules.length).toBeGreaterThan(0);
    for (const [key, preset, { value, excludes }] of rules) {
      for (const other of excludes) {
        expect(validateSpecialtyObservationCombination(key, [value, other])).toContain("cannot be paired");
        const group = preset.findingGroups.find((item) => item.options.some((opt) => opt.value === other));
        expect(reconcileDependentFindingSelections(preset, [value], group, other)).toEqual([other]);
        const valueGroup = preset.findingGroups.find((item) => item.options.some((opt) => opt.value === value));
        expect(reconcileDependentFindingSelections(preset, [other], valueGroup, value)).toEqual([value]);
      }
    }
  });
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

  test("a non-specialty profile key never falls through to the display name", () => {
    const fleaTick = { serviceType: "Flea & Tick Control", completionProfile: { serviceKey: "flea_tick" } };
    expect(specialtyCompletionFor(fleaTick)).toBeNull();
    expect(specialtyServiceKey({ serviceKey: "flea_tick", serviceType: "Flea & Tick Control" })).toBeNull();
    expect(specialtyCompletionFor({ serviceType: "Bee Removal", completionProfile: { serviceKey: "pest_control" } })).toBeNull();
  });

  test("client and server resolve the same specialty lane for every profile key and display name", () => {
    const corpus = [
      { serviceKey: "flea_tick", serviceType: "Flea & Tick Control" },
      { serviceKey: "pest_control", serviceType: "Mosquito add-on" },
      { serviceKey: "mosquito_seasonal", serviceType: "Anything" },
      { serviceKey: "bed_bug", serviceType: "" },
      { serviceKey: "", serviceType: "Flea & Tick Yard Treatment" },
      { serviceKey: null, serviceType: "Yellowjacket Removal" },
      { serviceType: "Lawn Dethatching" },
      { serviceType: "Sod Plugging" },
      { serviceType: "Fire Ant Treatment" },
      { serviceType: "Mud Dauber Removal" },
      { serviceType: "Bed Bug Heat Treatment" },
      { serviceType: "Mosquito Monthly" },
      { serviceType: "General Pest Control" },
    ];
    for (const input of corpus) {
      expect(resolveSpecialtyServiceKey(input)).toBe(specialtyServiceKey(input));
    }
  });

  test("falls back to service-name matching for legacy schedule rows", () => {
    expect(specialtyCompletionFor({ serviceType: "Bee Removal" }))
      .toBe(SERVICE_COMPLETION_PRESETS.bee_wasp_removal);
    expect(specialtyCompletionFor({ serviceType: "Bed Bug Heat Treatment" }))
      .toBe(SERVICE_COMPLETION_PRESETS.bed_bug_treatment);
    expect(specialtyServiceKey({ serviceType: "Bed Bug Heat Treatment" }))
      .toBe("bed_bug_treatment");
    expect(specialtyServiceKey({ serviceType: "Yellowjacket Removal" }))
      .toBe("bee_wasp_removal");
  });

  test("replaces only the prior choice from the same finding group", () => {
    const group = SERVICE_COMPLETION_PRESETS.fire_ant.findingGroups[0];
    expect(replaceFindingGroupSelection(
      ["Active mounds observed", "Widespread activity"],
      group,
      "No active fire ants observed",
    )).toEqual(["Widespread activity", "No active fire ants observed"]);
  });

  test("dependent specialty findings cannot retain contradictory activity", () => {
    const fireAnt = SERVICE_COMPLETION_PRESETS.fire_ant;
    expect(reconcileDependentFindingSelections(
      fireAnt,
      ["Active mounds observed", "Widespread activity"],
      fireAnt.findingGroups[0],
      "No active fire ants observed",
    )).toEqual(["No active fire ants observed"]);

    const bee = SERVICE_COMPLETION_PRESETS.bee_wasp_removal;
    expect(reconcileDependentFindingSelections(
      bee,
      ["Inactive or abandoned nest"],
      bee.findingGroups[2],
      "Active",
    )).toEqual(["Active"]);
  });

  test("server vocabulary rejects restored contradictory specialty findings", () => {
    expect(validateSpecialtyObservationCombination(
      "bee_wasp_removal", ["Inactive or abandoned nest", "Active"],
    )).toContain("cannot be paired");
    expect(validateSpecialtyObservationCombination(
      "mud_dauber_removal", ["Active mud nests", "No current evidence observed"],
    )).toContain("only one value");
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

  test("exclusive no-treatment actions cannot retain applied products", () => {
    const protocols = SERVICE_COMPLETION_PRESETS.bee_wasp_removal.protocols;
    expect(exclusiveProtocolProductConflict(
      ["Inspection and identification only"], protocols, 1,
    )).toContain("Remove applied products");
    expect(exclusiveProtocolProductConflict(
      ["Void nest treated"], protocols, 1,
    )).toBeNull();
  });

  test("restored exclusive actions cannot coexist with performed work", () => {
    const protocols = SERVICE_COMPLETION_PRESETS.bee_wasp_removal.protocols;
    expect(exclusiveProtocolSelectionConflict(
      ["Inspection and identification only", "Void nest treated"], protocols,
    )).toContain("remove the other completed actions");
    expect(exclusiveProtocolSelectionConflict(
      ["Void nest treated", "Nest physically removed"], protocols,
    )).toBeNull();
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
