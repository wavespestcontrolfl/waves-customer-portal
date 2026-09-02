import specialtyCloseouts from "../../../shared/specialty-service-closeouts.json";
import specialtyServiceKeys from "../../../shared/specialty-service-keys.json";

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
    findingActionExclusions: spec.findingActionExclusions || [],
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

// Mirror of specialtyServiceKey in shared/specialty-service-closeouts.js,
// driven by the same specialty-service-keys.json: a completion profile key is
// authoritative (a non-specialty key such as the typed flea_tick profile never
// falls through to its "Flea & Tick" display name); the display-name patterns
// serve only legacy rows with no profile key.
export function resolveSpecialtyServiceKey({ serviceKey, serviceType } = {}) {
  const key = String(serviceKey || "").trim();
  if (key) {
    const canonical = specialtyServiceKeys.aliases[key] || key;
    return specialtyCloseouts[canonical] ? canonical : null;
  }
  const text = String(serviceType || "").toLowerCase();
  const match = specialtyServiceKeys.serviceTypePatterns.find(({ pattern }) => new RegExp(pattern).test(text));
  return match ? match.key : null;
}

export function specialtyCompletionFor(service) {
  const key = resolveSpecialtyServiceKey({
    serviceKey: service?.completionProfile?.serviceKey,
    serviceType: service?.serviceType || service?.service_type,
  });
  return key ? SERVICE_COMPLETION_PRESETS[key] : null;
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
// sit beside a performed action or a different no-work explanation, and an
// exclusive action cannot sit beside a completed-work finding.
export function specialtyFindingActionConflict(preset, observations, actionLabels) {
  if (!preset) return null;
  const byLabel = new Map((preset.protocols || []).map((action) => [action.label, action]));
  const actions = (Array.isArray(actionLabels) ? actionLabels : []).filter((label) => byLabel.has(label));
  const findings = Array.isArray(observations) ? observations : [];
  // Pest lanes: a no-evidence / inactive finding cannot sit beside a treatment
  // of active pests (codex P2 r11 #3701).
  for (const { value, excludesActions } of preset.findingActionExclusions || []) {
    const clash = findings.includes(value) && actions.find((label) => excludesActions.includes(label));
    if (clash) return `“${value}” cannot be paired with action “${clash}”.`;
  }
  const workState = preset.workState;
  if (!workState) return null;
  const noWorkFindings = findings.filter((value) => Object.prototype.hasOwnProperty.call(workState.noWork, value));
  const performed = actions.find((label) => byLabel.get(label).exclusive !== true);
  if (noWorkFindings.length && performed) {
    return `“${noWorkFindings[0]}” cannot be paired with completed action “${performed}”.`;
  }
  const exclusive = actions.find((label) => byLabel.get(label).exclusive === true);
  const completed = findings.find((value) => workState.completed.includes(value));
  if (exclusive && completed) return `“${exclusive}” cannot be paired with finding “${completed}”.`;
  const mismatched = exclusive && noWorkFindings.find((value) => !workState.noWork[value].includes(exclusive));
  if (mismatched) return `“${mismatched}” cannot be paired with action “${exclusive}”.`;
  return null;
}

// Mirror of specialtyCompletedWorkWithoutAction in shared/specialty-service-closeouts.js
// (the server rejects it at completion): a completed-work finding needs a
// performed protocol action behind it. Submit-time only — selection order
// stays free.
export function specialtyCompletedWorkWithoutAction(preset, observations, actionLabels) {
  const workState = preset?.workState;
  if (!workState) return null;
  const byLabel = new Map((preset.protocols || []).map((action) => [action.label, action]));
  const performed = (Array.isArray(actionLabels) ? actionLabels : [])
    .some((label) => byLabel.has(label) && byLabel.get(label).exclusive !== true);
  const completed = (Array.isArray(observations) ? observations : []).find((value) => workState.completed.includes(value));
  return completed && !performed
    ? `“${completed}” requires a completed protocol action — add the work performed before submitting.`
    : null;
}

// Mirror of noApplicationOutcomeConflict in shared/specialty-service-closeouts.js
// (the server rejects it at completion): an inspection-only / customer-declined
// outcome bills as not performed, so it cannot carry performed actions or
// applied products. Submit-time only.
const NO_APPLICATION_OUTCOMES = { inspection_only: "inspection only", customer_declined: "customer declined" };
export function noApplicationOutcomeConflict(preset, actionLabels, productCount, visitOutcome) {
  const outcomeLabel = NO_APPLICATION_OUTCOMES[String(visitOutcome || "")];
  if (!outcomeLabel || !preset) return null;
  const byLabel = new Map((preset.protocols || []).map((action) => [action.label, action]));
  // A label outside the preset is a legacy dynamic action a keyless row may
  // still carry — it is performed work for this check too, so a stale
  // client cannot pair it with a no-application outcome (local audit P1).
  const performed = (Array.isArray(actionLabels) ? actionLabels : [])
    .find((label) => !byLabel.has(label) || byLabel.get(label).exclusive !== true);
  if (performed) return `Visit outcome “${outcomeLabel}” cannot record the performed action “${performed}” — change the outcome or clear the action.`;
  if (Number(productCount) > 0) return `Visit outcome “${outcomeLabel}” cannot record applied products — change the outcome or remove the products.`;
  return null;
}
