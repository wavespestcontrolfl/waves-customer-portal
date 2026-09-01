import specialtyObservations from "../../../shared/specialty-service-observations.json";

const option = (value) => ({ value, label: value });

// Dropdown vocabulary and dependent-selection rules come from the shared
// customer-report egress source (shared/specialty-service-observations.json)
// so the admin UI can never offer a value the server allowlist rejects.
// Group labels stay here — they are display copy, not report vocabulary.
const specialtyFindings = (serviceKey, groupLabels) => ({
  findingGroups: specialtyObservations.groups[serviceKey].map((group) => ({
    key: group.key,
    label: groupLabels[group.key],
    options: group.options.map(option),
  })),
  observationExclusions: specialtyObservations.exclusions[serviceKey] || [],
});

export const SERVICE_COMPLETION_PRESETS = {
  dethatching: {
    areas: [
      "Front lawn", "Back lawn", "Side lawns", "Thin / stressed turf areas",
      "Heavy-thatch areas", "Along driveway / sidewalk", "Slope / drainage area",
    ],
    ...specialtyFindings("dethatching", { dethatching_scope: "Dethatching scope completed", dethatching_debris: "Thatch and debris result" }),
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
    ...specialtyFindings("plugging", { plug_spacing: "Installed plug spacing", plugging_scope: "Installation scope completed" }),
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
    ...specialtyFindings("mosquito", { mosquito_activity: "Mosquito activity", mosquito_source: "Breeding-source findings" }),
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
    ...specialtyFindings("fire_ant", { fire_ant_evidence: "Fire ant activity", fire_ant_distribution: "Activity distribution" }),
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
    ...specialtyFindings("tick_control", { tick_evidence: "Tick evidence", tick_identification: "Tick identification" }),
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
      "Interior wall void / structural opening",
      "Attic", "Lanai / pool cage", "Porch / entry", "Garage / carport",
      "Tree / shrub", "Ground cavity", "Utility / irrigation box", "Fence / detached structure",
    ],
    ...specialtyFindings("bee_wasp_removal", { stinging_insect_identification: "Pest identified", nest_type: "Nest or activity type", nest_activity: "Nest activity" }),
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
    ...specialtyFindings("mud_dauber_removal", { mud_dauber_evidence: "Nest condition", mud_dauber_count: "Approximate nest count" }),
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
    ...specialtyFindings("bed_bug_treatment", { bed_bug_visit_stage: "Visit stage", bed_bug_evidence: "Evidence observed", bed_bug_prep: "Preparation status" }),
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
  for (const { value, excludes } of preset?.observationExclusions || []) {
    if (nextValue === value) next = next.filter((item) => !excludes.includes(item));
    else if (excludes.includes(nextValue)) next = next.filter((item) => item !== value);
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

export function exclusiveProtocolProductConflict(selectedLabels, protocols, productCount) {
  if (!Number(productCount)) return null;
  const byLabel = new Map((protocols || []).map((action) => [action.label, action]));
  const exclusive = (selectedLabels || []).find((label) => byLabel.get(label)?.exclusive === true);
  return exclusive
    ? `Remove applied products or clear “${exclusive}” before completing this visit.`
    : null;
}

export function exclusiveProtocolSelectionConflict(selectedLabels, protocols) {
  const selected = Array.isArray(selectedLabels) ? selectedLabels : [];
  if (selected.length < 2) return null;
  const byLabel = new Map((protocols || []).map((action) => [action.label, action]));
  const exclusive = selected.find((label) => byLabel.get(label)?.exclusive === true);
  return exclusive
    ? `Clear “${exclusive}” or remove the other completed actions before submitting.`
    : null;
}
