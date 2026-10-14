// client/src/lib/pest-sweep-action.js
//
// The one protocol action a regular pest visit still records (owner
// 2026-10-05): "Swept eaves and webs". The full form ticks it with a box; the
// Fast Complete sheet has no box (owner 2026-10-08) and takes it from what the
// technician said in the note (visit-voice-facts.js). It is the pest protocol's own
// sweep step (server/config/protocols.json), so the customer report's spider
// section (buildSpiderExpectation) reads it as a recorded sweep: exterior,
// no treatment applied. The full Complete form (SchedulePage.jsx) and the
// Fast Complete sheet (FastCompleteSheet.jsx) both import it, so the label
// lives in exactly one place.
export const PEST_SWEEP_ACTION = {
  label: 'Swept eaves, window frames, door frames, and lanai',
  scope: 'exterior',
  treatmentApplied: false,
};

// The labels a checked box (or a sweep heard in the note) records: the full form's actionsCompleted shape
// for the AI report writer, and the /complete body's protocol actions.
export function pestSweepActions(checked) {
  return checked ? [PEST_SWEEP_ACTION.label] : [];
}

// What a checked box adds to the /complete body: the action label and its
// structured scope entry (the server keeps a scope only for a label it was
// also sent). Unchecked adds nothing, so an unticked sheet's body is as it was.
export function pestSweepCompletionFields(checked) {
  return checked
    ? {
      protocolActionsCompleted: pestSweepActions(true),
      protocolActionScopesCompleted: [{
        label: PEST_SWEEP_ACTION.label,
        scope: PEST_SWEEP_ACTION.scope,
        treatmentApplied: PEST_SWEEP_ACTION.treatmentApplied,
      }],
    }
    : {};
}
