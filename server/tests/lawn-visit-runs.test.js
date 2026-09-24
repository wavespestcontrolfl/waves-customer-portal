const { billedUsage, runRowFor, replayContextForRun, responseForRun } = require('../services/lawn-visit-runs');

test('failed billed legs contribute tokens even when neither provider returns an answer', () => {
  expect(billedUsage({ failures: [{ usage: { input_tokens: 5, output_tokens: 1 } }, { reason: 'timeout' }], usage: null }))
    .toEqual({ input_tokens: 5, output_tokens: 1, reasoning_tokens: 0 });
  expect(billedUsage({ failures: [], usage: null })).toEqual({ input_tokens: null, output_tokens: null, reasoning_tokens: null });
});

test('unavailable runs discard score/raw/provider placeholders and missing context stays unknown', () => {
  const row = runRowFor({
    assessment: { id: 'a', customer_id: 'c' },
    analysis: { status: 'unavailable', reason: 'all_providers_failed', provider: 'gemini', model: 'placeholder', fallbackUsed: true,
      scores: { turf_density: null }, severities: {}, findings: [{ finding_id: 'F1' }], raw: { invalid: true } },
    adjustedScores: { turf_density: 95 },
  });
  expect(row).toMatchObject({ provider: null, requested_model: null, fallback_used: false, raw_response: null, scores_raw: null, scores_adjusted: null, severities: null, vision_context: null });
  expect(JSON.parse(row.findings)).toEqual([]);
  expect(replayContextForRun(row)).toMatchObject({ exactInputEligible: false, omitted: [{ field: 'visionContext', reason: 'analysis_time_context_unavailable' }] });
});

test('replay context never includes notes and omitted notes make an exact-input comparison ineligible', () => {
  expect(replayContextForRun({ vision_context: '{"month":9}', technician_notes_present: false }))
    .toEqual({ visionContext: { month: 9 }, omitted: [], exactInputEligible: true });
  for (const run of [
    { vision_context: { month: 9 }, technician_notes_present: true },
    { vision_context: { month: 9, technicianNotes: 'private phrase' }, technician_notes_present: false },
  ]) {
    expect(replayContextForRun(run)).toEqual({ visionContext: { month: 9 }, omitted: [{ field: 'technicianNotes', reason: 'intentionally_not_stored' }], exactInputEligible: false });
  }
  expect(replayContextForRun({ vision_context: {}, technician_notes_present: false })).toMatchObject({ exactInputEligible: true });
  expect(replayContextForRun({ vision_context: {} })).toMatchObject({ exactInputEligible: false, omitted: [{ field: 'technicianNotes', reason: 'presence_unknown' }] });
  expect(replayContextForRun({ vision_context: '[]', technician_notes_present: false })).toMatchObject({ visionContext: null, exactInputEligible: false });
});

// Codex P1 2026-09-24: the client must decide which metrics stay editable
// from the run's immutable read, never the mutable assessment row (which can
// already hold a technician's earlier fill of a genuinely blank metric).
test('responseForRun carries the immutable AI read alongside the review payload', () => {
  const complete = {
    status: 'complete',
    scores_adjusted: JSON.stringify({ turf_density: 80, weed_suppression: null, color_health: 76, fungus_control: null, thatch_level: 90, stress_damage: null }),
    reconciliation: JSON.stringify({ published_observations: null }),
  };
  expect(responseForRun(complete).aiScores).toEqual({
    turf_density: 80, weed_suppression: null, color_health: 76, fungus_control: null, thatch_level: 90, stress_damage: null,
  });
  // No snapshot (incomplete run, or a complete run that never got one): no
  // enforceable AI read, same as runAiScores on its own.
  expect(responseForRun({ status: 'pending' }).aiScores).toEqual({});
  expect(responseForRun({ status: 'complete', scores_adjusted: null }).aiScores).toEqual({});
  expect(responseForRun(null)).toBeNull();
});
