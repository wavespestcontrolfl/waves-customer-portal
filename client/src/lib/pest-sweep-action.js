// client/src/lib/pest-sweep-action.js
//
// The one protocol action a regular pest visit still records (owner
// 2026-10-05): the "Swept eaves and webs" box. It is the pest protocol's own
// sweep step (server/config/protocols.json), so the customer report's spider
// section (buildSpiderExpectation) reads it as a recorded sweep: exterior,
// no treatment applied. The full Complete form (SchedulePage.jsx) and the
// Fast Complete sheet (FastCompleteSheet.jsx, owner 2026-10-05 "sweep on fast
// form") both import it, so the label lives in exactly one place.
export const PEST_SWEEP_ACTION = {
  label: 'Swept eaves, window frames, door frames, and lanai',
  scope: 'exterior',
  treatmentApplied: false,
};

// What a checked box adds to the /complete body: the action label and its
// structured scope entry (the server keeps a scope only for a label it was
// also sent). Unchecked adds nothing, so an unticked sheet's body is as it was.
export function pestSweepCompletionFields(checked) {
  return checked
    ? {
      protocolActionsCompleted: [PEST_SWEEP_ACTION.label],
      protocolActionScopesCompleted: [{
        label: PEST_SWEEP_ACTION.label,
        scope: PEST_SWEEP_ACTION.scope,
        treatmentApplied: PEST_SWEEP_ACTION.treatmentApplied,
      }],
    }
    : {};
}

// What a checked box adds to the AI report writer's payload: the same
// actionsCompleted field the full form sends, so the written report knows.
export function pestSweepWriterFields(checked) {
  return checked ? { actionsCompleted: [PEST_SWEEP_ACTION.label] } : {};
}
