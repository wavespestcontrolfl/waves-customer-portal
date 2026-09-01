const option = (value) => ({ value, label: value });

export const SERVICE_COMPLETION_PRESETS = {
  dethatching: {
    areas: [
      "Front lawn", "Back lawn", "Side lawns", "Thin / stressed turf areas",
      "Heavy-thatch areas", "Along driveway / sidewalk", "Slope / drainage area",
    ],
    findingGroups: [
      {
        key: "dethatching_scope",
        label: "Dethatching scope completed",
        options: ["Full quoted area completed", "Partial quoted area completed", "Inspection only", "Work deferred"].map(option),
      },
      {
        key: "dethatching_debris",
        label: "Thatch and debris result",
        options: ["Light debris removed", "Moderate debris removed", "Heavy debris removed", "Debris consolidated onsite", "Debris removal not included", "Not applicable"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection only", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Single-pass dethatching completed", scope: "exterior", treatmentApplied: false },
      { label: "Double-pass dethatching completed", scope: "exterior", treatmentApplied: false },
      { label: "Loose thatch collected", scope: "exterior", treatmentApplied: false },
      { label: "Debris removed from property", scope: "exterior", treatmentApplied: false },
      { label: "Work deferred; office follow-up required", scope: "exterior", treatmentApplied: false, exclusive: true },
    ],
  },
  plugging: {
    areas: [
      "Front lawn", "Back lawn", "Side lawns", "Bare areas", "Thin turf areas",
      "Damaged turf areas", "Along driveway / sidewalk", "Slope / drainage area",
    ],
    findingGroups: [
      {
        key: "plug_spacing",
        label: "Installed plug spacing",
        options: ["6-inch spacing", "9-inch spacing", "12-inch spacing", "Mixed spacing per site conditions", "Not installed"].map(option),
      },
      {
        key: "plugging_scope",
        label: "Installation scope completed",
        options: ["Full quoted area completed", "Partial quoted area completed", "Inspection only", "Work deferred"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection only", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Sod plugs installed at quoted spacing", scope: "exterior", treatmentApplied: false },
      { label: "Installation adjusted for site conditions", scope: "exterior", treatmentApplied: false },
      { label: "Installed plugs watered in", scope: "exterior", treatmentApplied: false },
      { label: "Installation areas reviewed with customer", scope: "exterior", treatmentApplied: false },
      { label: "Work deferred; office follow-up required", scope: "exterior", treatmentApplied: false, exclusive: true },
    ],
  },
  mosquito: {
    areas: [
      "Yard vegetation", "Shrubs / landscape beds", "Fence line / yard edge",
      "Under deck / patio", "Lanai / pool cage", "Pool deck / seating area",
      "Property perimeter", "Gutters / drains", "Planters / bromeliads",
      "Standing-water source", "Mosquito station location",
    ],
    findingGroups: [
      {
        key: "mosquito_activity",
        label: "Mosquito activity",
        options: ["No mosquito activity observed", "Light mosquito activity", "Moderate mosquito activity", "Heavy mosquito activity", "Customer-reported activity only"].map(option),
      },
      {
        key: "mosquito_source",
        label: "Breeding-source findings",
        options: ["No standing-water source found", "Removable standing water found", "Breeding source could not be removed", "Drainage or irrigation issue observed", "Likely off-property pressure", "Source not determined"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection and source assessment only", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Directed barrier treatment", scope: "exterior", treatmentApplied: true },
      { label: "Standing water removed where practical", scope: "exterior", treatmentApplied: false },
      { label: "Larvicide applied to labeled water source", scope: "exterior", treatmentApplied: true },
      { label: "Mosquito stations installed or serviced", scope: "exterior", treatmentApplied: false },
      { label: "Event or heavy-pressure treatment", scope: "exterior", treatmentApplied: true },
      { label: "Treatment deferred because conditions were unsuitable", scope: "exterior", treatmentApplied: false, exclusive: true },
    ],
  },
  fire_ant: {
    areas: [
      "Front lawn", "Back lawn", "Side lawns", "Landscape beds",
      "Driveway / sidewalk edges", "Foundation perimeter", "Pool / lanai perimeter",
      "Fence line", "Drainage area", "Utility / irrigation boxes", "Playground / pet area",
    ],
    findingGroups: [
      {
        key: "fire_ant_evidence",
        label: "Fire ant activity",
        options: ["Active mounds observed", "Foraging activity observed", "Mounds and foraging activity observed", "Customer-reported activity only", "No active fire ants observed", "Identification uncertain"].map(option),
      },
      {
        key: "fire_ant_distribution",
        label: "Activity distribution",
        options: ["One isolated area", "Several localized areas", "Scattered throughout property", "Widespread activity", "Unable to fully determine"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection only", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Individual mound treatment", scope: "exterior", treatmentApplied: true },
      { label: "Broadcast bait application", scope: "exterior", treatmentApplied: true },
      { label: "Broadcast contact treatment", scope: "exterior", treatmentApplied: true },
      { label: "Two-step treatment: broadcast plus mound treatment", scope: "exterior", treatmentApplied: true },
      { label: "Targeted treatment around structures or equipment", scope: "exterior", treatmentApplied: true },
      { label: "Treatment deferred because conditions were unsuitable", scope: "exterior", treatmentApplied: false, exclusive: true },
    ],
  },
  tick_control: {
    areas: [
      "Pet resting area", "Kennel / dog run", "Front lawn", "Back lawn", "Side lawns",
      "Shaded turf", "Landscape beds / leaf litter", "Fence line / yard edge",
      "Dense vegetation", "Under deck / patio", "Lanai / screened enclosure",
      "Garage", "Interior pet areas", "Baseboards / wall edges", "Furniture near pet areas",
    ],
    findingGroups: [
      {
        key: "tick_evidence",
        label: "Tick evidence",
        options: ["Live tick observed", "Multiple live ticks observed", "Tick found on pet", "Customer-reported tick activity", "Evidence in monitoring device", "No tick activity observed", "Identification uncertain"].map(option),
      },
      {
        key: "tick_identification",
        label: "Tick identification",
        options: ["Brown dog tick", "American dog tick", "Gulf Coast tick", "Lone star tick", "Other identified tick", "Species not confirmed"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection only", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Monitoring devices placed or checked", scope: "interior", treatmentApplied: false },
      { label: "Targeted exterior habitat treatment", scope: "exterior", treatmentApplied: true },
      { label: "Yard-edge or perimeter treatment", scope: "exterior", treatmentApplied: true },
      { label: "Pet-resting or kennel-area treatment", scope: "exterior", treatmentApplied: true },
      { label: "Interior crack-and-crevice treatment", scope: "interior", treatmentApplied: true },
      { label: "Vacuuming or mechanical removal", scope: "interior", treatmentApplied: false },
      { label: "Treatment deferred or office review required", scope: "exterior", treatmentApplied: false, exclusive: true },
    ],
  },
  bee_wasp_removal: {
    areas: [
      "Eaves / soffit", "Roofline", "Exterior wall", "Wall void / structural opening",
      "Attic", "Lanai / pool cage", "Porch / entry", "Garage / carport",
      "Tree / shrub", "Ground cavity", "Utility / irrigation box", "Fence / detached structure",
    ],
    findingGroups: [
      {
        key: "stinging_insect_identification",
        label: "Pest identified",
        options: ["Paper wasp", "Yellowjacket", "Hornet", "Honey bee", "Carpenter bee", "Other solitary wasp", "Other wasp", "Identification uncertain"].map(option),
      },
      {
        key: "nest_type",
        label: "Nest or activity type",
        options: ["Exposed paper nest", "Enclosed structural void", "Ground nest", "Carpenter bee gallery", "Honey bee swarm", "Established honey bee colony", "Flying activity with no nest located", "Inactive or abandoned nest"].map(option),
      },
      {
        key: "nest_activity",
        label: "Nest activity",
        options: ["Active", "Light activity", "Heavy activity", "Inactive", "Unable to confirm"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection and identification only", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Exposed nest treated", scope: "exterior", treatmentApplied: true },
      { label: "Void nest treated", scope: "exterior", treatmentApplied: true },
      { label: "Ground nest treated", scope: "exterior", treatmentApplied: true },
      { label: "Nest physically removed", scope: "exterior", treatmentApplied: false },
      { label: "Treatment followed by nest removal", scope: "exterior", treatmentApplied: true },
      { label: "Carpenter bee gallery treatment", scope: "exterior", treatmentApplied: true },
      { label: "Honey bee removal performed", scope: "exterior", treatmentApplied: false },
      { label: "Honey bee colony eradication performed", scope: "exterior", treatmentApplied: true },
      { label: "No treatment recommended", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Area inaccessible; office follow-up required", scope: "exterior", treatmentApplied: false, exclusive: true },
    ],
  },
  mud_dauber_removal: {
    areas: [
      "Eaves / soffit", "Lanai / pool cage", "Porch / patio", "Entry doorway",
      "Garage / carport", "Exterior walls", "Windows / shutters",
      "Attic / structural interior", "Fence", "Shed / detached structure",
    ],
    findingGroups: [
      {
        key: "mud_dauber_evidence",
        label: "Nest condition",
        options: ["Active mud nests", "Sealed nests; activity uncertain", "Inactive or abandoned nests", "Empty nest remnants", "Mud dauber activity without completed nests", "No current evidence observed", "Identification uncertain"].map(option),
      },
      {
        key: "mud_dauber_count",
        label: "Approximate nest count",
        options: ["1–3 nests", "4–10 nests", "11–20 nests", "More than 20 nests", "Exact count not practical"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection only", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Inactive nests removed", scope: "exterior", treatmentApplied: false },
      { label: "Active nests treated", scope: "exterior", treatmentApplied: true },
      { label: "Active nests treated and removed", scope: "exterior", treatmentApplied: true },
      { label: "Nest remnants and accessible webbing removed", scope: "exterior", treatmentApplied: false },
      { label: "Localized labeled application", scope: "exterior", treatmentApplied: true },
      { label: "No treatment recommended", scope: "exterior", treatmentApplied: false, exclusive: true },
      { label: "Inaccessible nests documented", scope: "exterior", treatmentApplied: false, exclusive: true },
    ],
  },
  bed_bug_treatment: {
    areas: [
      "Primary bedroom", "Guest bedroom", "Child's bedroom", "Living room",
      "Family room", "Office", "Other sleeping area", "Adjacent room",
      "Shared wall / adjoining unit", "Mattress seams", "Box spring", "Bed frame",
      "Headboard", "Baseboards", "Cracks / crevices", "Furniture / upholstery",
      "Nightstands", "Closets", "Wall voids / outlets", "Luggage / storage area",
      "Monitors / interceptors",
    ],
    findingGroups: [
      {
        key: "bed_bug_visit_stage",
        label: "Visit stage",
        options: ["Initial inspection", "Initial treatment", "Scheduled follow-up treatment", "Post-treatment inspection", "Callback or renewed activity inspection"].map(option),
      },
      {
        key: "bed_bug_evidence",
        label: "Evidence observed",
        options: ["Live adults", "Live nymphs", "Eggs", "Cast skins", "Fecal spotting", "Bed bugs captured in monitor", "Customer-reported bites only", "Customer-reported sighting", "No confirmed evidence", "Evidence inconclusive"].map(option),
      },
      {
        key: "bed_bug_prep",
        label: "Preparation status",
        options: ["Preparation complete", "Preparation mostly complete", "Preparation partially complete", "Preparation not completed", "Preparation not required for this visit"].map(option),
      },
    ],
    protocols: [
      { label: "Inspection only", scope: "interior", treatmentApplied: false, exclusive: true },
      { label: "Monitoring devices installed or checked", scope: "interior", treatmentApplied: false },
      { label: "Vacuuming performed", scope: "interior", treatmentApplied: false },
      { label: "Steam treatment performed", scope: "interior", treatmentApplied: false },
      { label: "Crack-and-crevice treatment", scope: "interior", treatmentApplied: true },
      { label: "Residual application", scope: "interior", treatmentApplied: true },
      { label: "Dust applied to labeled voids", scope: "interior", treatmentApplied: true },
      { label: "Mattress or box-spring encasement installed", scope: "interior", treatmentApplied: false },
      { label: "Chemical / IPM treatment", scope: "interior", treatmentApplied: true },
      { label: "Heat treatment", scope: "interior", treatmentApplied: false },
      { label: "Hybrid heat and chemical treatment", scope: "interior", treatmentApplied: true },
      { label: "Targeted follow-up treatment", scope: "interior", treatmentApplied: true },
      { label: "Treatment limited because preparation was incomplete", scope: "interior", treatmentApplied: false },
    ],
  },
};

export function specialtyCompletionFor(service) {
  const profileKey = service?.completionProfile?.serviceKey;
  if (profileKey && SERVICE_COMPLETION_PRESETS[profileKey]) {
    return SERVICE_COMPLETION_PRESETS[profileKey];
  }
  if (["mosquito_monthly", "mosquito_seasonal", "mosquito_one_time"].includes(profileKey)) {
    return SERVICE_COMPLETION_PRESETS.mosquito;
  }
  const text = String(service?.serviceType || service?.service_type || "").toLowerCase();
  if (/mosquito/.test(text)) return SERVICE_COMPLETION_PRESETS.mosquito;
  if (/dethatch/.test(text)) return SERVICE_COMPLETION_PRESETS.dethatching;
  if (/lawn\s*plugg|sod\s*plugg/.test(text)) return SERVICE_COMPLETION_PRESETS.plugging;
  if (/bed\s*bug/.test(text)) return SERVICE_COMPLETION_PRESETS.bed_bug_treatment;
  if (/fire\s*ant/.test(text)) return SERVICE_COMPLETION_PRESETS.fire_ant;
  if (/\btick/.test(text)) return SERVICE_COMPLETION_PRESETS.tick_control;
  if (/mud\s*dauber/.test(text)) return SERVICE_COMPLETION_PRESETS.mud_dauber_removal;
  if (/\bbee\b|\bwasp\b|yellow\s*jacket|yellowjacket|hornet/.test(text)) return SERVICE_COMPLETION_PRESETS.bee_wasp_removal;
  return null;
}

export function replaceFindingGroupSelection(current, group, nextValue) {
  const groupValues = new Set((group?.options || []).map((item) => item.value));
  return [...(current || []).filter((value) => !groupValues.has(value)), ...(nextValue ? [nextValue] : [])];
}

export function reconcileDependentFindingSelections(preset, current, group, nextValue) {
  let next = replaceFindingGroupSelection(current, group, nextValue);
  const remove = (values) => {
    const blocked = new Set(values);
    next = next.filter((value) => !blocked.has(value));
  };

  if (preset === SERVICE_COMPLETION_PRESETS.fire_ant) {
    const noActivity = "No active fire ants observed";
    const distribution = preset.findingGroups.find(({ key }) => key === "fire_ant_distribution");
    const distributionValues = (distribution?.options || []).map(({ value }) => value);
    if (nextValue === noActivity) remove(distributionValues);
    if (distributionValues.includes(nextValue)) remove([noActivity]);
  }

  if (preset === SERVICE_COMPLETION_PRESETS.bee_wasp_removal) {
    const inactiveNest = "Inactive or abandoned nest";
    const activity = preset.findingGroups.find(({ key }) => key === "nest_activity");
    const activeValues = (activity?.options || [])
      .map(({ value }) => value)
      .filter((value) => value !== "Inactive");
    if (nextValue === inactiveNest) remove(activeValues);
    if (activeValues.includes(nextValue)) remove([inactiveNest]);
  }
  return next;
}

export function reconcileExclusiveProtocolSelections(current, protocols, nextLabel) {
  const selected = Array.isArray(current) ? current : [];
  const byLabel = new Map((protocols || []).map((action) => [action.label, action]));
  const nextAction = byLabel.get(nextLabel);
  if (!nextAction) return selected;

  const compatible = selected.filter((label) => {
    if (label === nextLabel) return false;
    const selectedAction = byLabel.get(label);
    if (!selectedAction) return true;
    return nextAction.exclusive !== true && selectedAction.exclusive !== true;
  });
  return [...compatible, nextLabel];
}
