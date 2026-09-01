import specialtyCloseouts from "../../../shared/specialty-service-closeouts.json";

const option = (value) => ({ value, label: value });

// Areas, dropdown vocabulary, dependent-selection rules and protocol actions
// come from the shared closeout source (shared/specialty-service-closeouts.json)
// — the same data the server validates against — so the admin UI can never
// offer a value the customer-report allowlist rejects. Group labels stay
// here: they are display copy, not report vocabulary.
const specialtyPreset = (serviceKey, groupLabels) => {
  const spec = specialtyCloseouts[serviceKey];
  return {
    areas: spec.areas,
    findingGroups: spec.findingGroups.map((group) => ({
      key: group.key,
      label: groupLabels[group.key],
      options: group.options.map(option),
    })),
    observationExclusions: spec.exclusions || [],
    protocols: spec.protocols,
    workState: spec.workState || null,
  };
};

export const SERVICE_COMPLETION_PRESETS = {
  dethatching: specialtyPreset("dethatching", {
    dethatching_scope: "Dethatching scope completed",
    dethatching_debris: "Thatch and debris result",
  }),
  plugging: specialtyPreset("plugging", {
    plug_spacing: "Installed plug spacing",
    plugging_scope: "Installation scope completed",
  }),
  mosquito: specialtyPreset("mosquito", {
    mosquito_activity: "Mosquito activity",
    mosquito_source: "Breeding-source findings",
  }),
  fire_ant: specialtyPreset("fire_ant", {
    fire_ant_evidence: "Fire ant activity",
    fire_ant_distribution: "Activity distribution",
  }),
  tick_control: specialtyPreset("tick_control", {
    tick_evidence: "Tick evidence",
    tick_identification: "Tick identification",
  }),
  bee_wasp_removal: specialtyPreset("bee_wasp_removal", {
    stinging_insect_identification: "Pest identified",
    nest_type: "Nest or activity type",
    nest_activity: "Nest activity",
  }),
  mud_dauber_removal: specialtyPreset("mud_dauber_removal", {
    mud_dauber_evidence: "Nest condition",
    mud_dauber_count: "Approximate nest count",
  }),
  bed_bug_treatment: specialtyPreset("bed_bug_treatment", {
    bed_bug_visit_stage: "Visit stage",
    bed_bug_evidence: "Evidence observed",
    bed_bug_prep: "Preparation status",
  }),
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

// Mirror of specialtyFindingActionConflict in shared/specialty-service-closeouts.js
// (the server rejects the same pairs at completion): a no-work finding cannot
// sit beside a performed action, and an exclusive no-work action cannot sit
// beside a completed-work finding.
export function specialtyFindingActionConflict(preset, observations, actionLabels) {
  const workState = preset?.workState;
  if (!workState) return null;
  const byLabel = new Map((preset.protocols || []).map((action) => [action.label, action]));
  const actions = (Array.isArray(actionLabels) ? actionLabels : []).filter((label) => byLabel.has(label));
  const findings = Array.isArray(observations) ? observations : [];
  const noWork = findings.find((value) => workState.noWork.includes(value));
  const performed = actions.find((label) => byLabel.get(label).exclusive !== true);
  if (noWork && performed) return `“${noWork}” cannot be paired with completed action “${performed}”.`;
  const exclusive = actions.find((label) => byLabel.get(label).exclusive === true);
  const completed = findings.find((value) => workState.completed.includes(value));
  if (exclusive && completed) return `“${exclusive}” cannot be paired with finding “${completed}”.`;
  return null;
}
