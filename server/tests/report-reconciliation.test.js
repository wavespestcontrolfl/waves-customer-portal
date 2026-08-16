/**
 * Pre-submit report reconciliation (GATE_REPORT_RECONCILE_PROMPT, dark —
 * owner ruling 2026-08-04 on the #3159 architecture escalation): the AI
 * body is generated from the typed fields, the tech can keep editing them
 * afterwards, and nothing re-runs. Instead of the render-time guards
 * silently degrading the copy (or a missed pattern publishing a stale
 * number), the completion route surfaces the contradiction to the tech —
 * regenerate or confirm — BEFORE anything freezes. Uses the same matcher
 * functions as the report pipeline: one source, no drift.
 */
const { reportReconciliationIssues } = require('../services/service-report/report-reconciliation');
const { reportReconcileBlockPayload } = require('../routes/admin-dispatch')._test;

const notes = (did, foundLine) => ['WHAT WE DID', did, 'WHAT WE FOUND', foundLine].join('\n');

const STALE_COUNT_NOTES = notes(
  'We checked 8 traps and refreshed the bait at each one.',
  'Rodent droppings were present along the north runway.',
);
const CAPTURE_NOTES = notes(
  'We checked the traps in the crawlspace.',
  'We removed 2 rats from the traps.',
);
const SETUP_NOTES = notes(
  'We set eight traps along the attic runways and baited each one.',
  'Rodent droppings were present, and we will return for the scheduled trap check.',
);

function trapping(values) {
  return { type: 'rodent_trapping', values };
}

describe('reportReconciliationIssues', () => {
  test('a stale trap count in the body surfaces with both numbers', () => {
    const issues = reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: null,
      companionFindings: [trapping({ trap_visit_type: 'Follow-up check', traps_checked: 6 })],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('trap_count_mismatch');
    expect(issues[0].message).toContain('8');
    expect(issues[0].message).toContain('6');
  });

  test('a stale capture count surfaces, and the primary section is read too', () => {
    const issues = reportReconciliationIssues({
      technicianNotes: CAPTURE_NOTES,
      structuredFindings: trapping({ trap_visit_type: 'Follow-up check', captures: 1 }),
      primaryFindingsType: 'rodent_trapping',
      companionFindings: null,
    });
    expect(issues.some((issue) => issue.kind === 'capture_count_mismatch')).toBe(true);
  });

  test('wildlife trapping never prompts — its report keeps deterministic copy', () => {
    expect(reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: { type: 'wildlife_trapping', values: { trap_visit_type: 'Follow-up check', traps_checked: 6 } },
      primaryFindingsType: 'wildlife_trapping',
      companionFindings: null,
    })).toEqual([]);
    expect(reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: null,
      companionFindings: [{ type: 'wildlife_trapping', values: { trap_visit_type: 'Follow-up check', traps_checked: 6 } }],
    })).toEqual([]);
  });

  test('a check claim on a declared setup surfaces as a setup contradiction', () => {
    const issues = reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: null,
      companionFindings: [trapping({ trap_visit_type: 'Initial setup', traps_checked: 8 })],
    });
    expect(issues.some((issue) => issue.kind === 'setup_claim')).toBe(true);
  });

  test('agreeing values, setup-appropriate copy, blank counts, and non-trapping visits are clean', () => {
    expect(reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: null,
      companionFindings: [trapping({ trap_visit_type: 'Follow-up check', traps_checked: 8 })],
    })).toEqual([]);
    expect(reportReconciliationIssues({
      technicianNotes: SETUP_NOTES,
      structuredFindings: null,
      companionFindings: [trapping({ trap_visit_type: 'Initial setup', traps_checked: 8 })],
    })).toEqual([]);
    expect(reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: null,
      companionFindings: [trapping({ trap_visit_type: 'Follow-up check', traps_checked: '' })],
    })).toEqual([]);
    expect(reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: { type: 'one_time_pest', values: { target_pest: 'Ants' } },
      companionFindings: null,
    })).toEqual([]);
  });

  test('free-text notes that are not a parsed report screen nothing', () => {
    expect(reportReconciliationIssues({
      technicianNotes: 'Checked 8 traps, all good.',
      structuredFindings: null,
      companionFindings: [trapping({ trap_visit_type: 'Follow-up check', traps_checked: 6 })],
    })).toEqual([]);
  });
});

describe('reportReconcileBlockPayload (route gate)', () => {
  const prevGate = process.env.GATE_REPORT_RECONCILE_PROMPT;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_REPORT_RECONCILE_PROMPT;
    else process.env.GATE_REPORT_RECONCILE_PROMPT = prevGate;
  });

  const contradicting = {
    isIncompleteVisit: false,
    reportReconcileConfirmed: false,
    technicianNotes: STALE_COUNT_NOTES,
    structuredFindings: null,
    companionFindings: [trapping({ trap_visit_type: 'Follow-up check', traps_checked: 6 })],
  };

  test('dark by default — no block while the gate is off', () => {
    delete process.env.GATE_REPORT_RECONCILE_PROMPT;
    expect(reportReconcileBlockPayload(contradicting)).toBeNull();
  });

  test('gate on: contradictions 409 with the messages in the error string', () => {
    process.env.GATE_REPORT_RECONCILE_PROMPT = 'true';
    const block = reportReconcileBlockPayload(contradicting);
    expect(block).toMatchObject({
      status: 409,
      payload: { code: 'report_reconcile', confirmable: true },
    });
    expect(block.payload.error).toContain('8');
    expect(block.payload.error).toContain('6');
    expect(block.payload.contradictions).toHaveLength(1);
  });

  test('a confirmed resubmit and an incomplete visit both pass through', () => {
    process.env.GATE_REPORT_RECONCILE_PROMPT = 'true';
    expect(reportReconcileBlockPayload({ ...contradicting, reportReconcileConfirmed: true }))
      .toBeNull();
    expect(reportReconcileBlockPayload({ ...contradicting, isIncompleteVisit: true }))
      .toBeNull();
  });

  test('a checker error fails OPEN — the prompt must never strand a completion', () => {
    process.env.GATE_REPORT_RECONCILE_PROMPT = 'true';
    expect(reportReconcileBlockPayload({
      ...contradicting,
      companionFindings: [{ get values() { throw new Error('boom'); } }],
    })).toBeNull();
  });
});

// The three confirmation-honoring contracts (codex round on the feature):
// the frozen snapshot keeps a confirmed body, the render-time summary
// screen honors the frozen decision, and a confirmed retry hashes
// identically to its original attempt.
describe('a confirmed prompt is honored downstream', () => {
  const {
    buildTodaysResult, buildTypedReportSnapshot,
  } = require('../services/service-report/activity-indicators');
  const { hashCompletionRequest, hasCommittedCompletionAttempt } = require('../services/completion-attempts');

  const trappingArgs = {
    projectType: 'rodent_trapping',
    reportTypeLabel: 'Rodent Trapping Summary',
    values: { trap_visit_type: 'Follow-up check', traps_checked: 6 },
    activity: { score: 2, trend: null, trendWord: null },
    visitSequence: 2,
    technicianReportBody: 'We checked 8 traps and refreshed the bait at each one. Rodent droppings were present along the north runway.',
  };

  test('the snapshot screen discards a contradicting body — unless confirmed', () => {
    const screened = buildTodaysResult(trappingArgs);
    expect(screened.bodySource).toBeUndefined();
    const confirmed = buildTodaysResult({ ...trappingArgs, reconcileConfirmed: true });
    expect(confirmed.bodySource).toBe('technician_report');
    expect(confirmed.body).toContain('We checked 8 traps');
  });

  test('the snapshot stamps the confirmation — including on a body-less companion snapshot', () => {
    const primary = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      values: trappingArgs.values,
      visitSequence: 2,
      activity: trappingArgs.activity,
      technicianReportBody: trappingArgs.technicianReportBody,
      reconcileConfirmed: true,
    });
    expect(primary.todaysResult.reconcileConfirmed).toBe(true);
    // companion-only: no technicianReportBody, the flag must still freeze
    const companion = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      values: trappingArgs.values,
      visitSequence: 1,
      reconcileConfirmed: true,
    });
    expect(companion.todaysResult.reconcileConfirmed).toBe(true);
    const unconfirmed = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      values: trappingArgs.values,
      visitSequence: 1,
    });
    expect(unconfirmed.todaysResult.reconcileConfirmed).toBeUndefined();
  });

  test('the confirmation bit does not change the completion request hash', () => {
    const base = { idempotencyKey: 'k1', technicianNotes: 'x', visitOutcome: 'completed' };
    expect(hashCompletionRequest({ ...base, reportReconcileConfirmed: true }))
      .toBe(hashCompletionRequest(base));
  });

  test('committed evidence is detected so retries reach replay, not the prompt', async () => {
    const stub = (attemptRow, recordRow) => {
      const builder = (rows) => {
        const q = {
          where: () => q,
          whereIn: () => q,
          first: () => Promise.resolve(rows),
        };
        return q;
      };
      return (table) => builder(table === 'service_completion_attempts' ? attemptRow : recordRow);
    };
    await expect(hasCommittedCompletionAttempt('svc-1', stub({ id: 'a1' }, null))).resolves.toBe(true);
    await expect(hasCommittedCompletionAttempt('svc-1', stub(null, { id: 'r1' }))).resolves.toBe(true);
    await expect(hasCommittedCompletionAttempt('svc-1', stub(null, null))).resolves.toBe(false);
  });
});

// Round on 6c46f21bb (P2): a primary trapping report whose final activity
// score is 0 never admits the reviewed body — the zero-state template
// wins even when confirmed — so the prompt must not ask for an override
// that cannot appear. Explicit zero only: an absent score is not zero.
describe('zero-score primary trapping reports never prompt', () => {
  test('score 0 skips, score 2 and absent score do not', () => {
    const args = {
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: trapping({ trap_visit_type: 'Follow-up check', traps_checked: 6 }),
      primaryFindingsType: 'rodent_trapping',
      companionFindings: null,
    };
    expect(reportReconciliationIssues({ ...args, primaryActivityScore: 0 })).toEqual([]);
    expect(reportReconciliationIssues({ ...args, primaryActivityScore: 2 }).length)
      .toBeGreaterThan(0);
    expect(reportReconciliationIssues({ ...args }).length).toBeGreaterThan(0);
  });

  test('a companion trapping section still prompts regardless of the primary score', () => {
    expect(reportReconciliationIssues({
      technicianNotes: STALE_COUNT_NOTES,
      structuredFindings: { type: 'one_time_pest', values: { target_pest: 'Ants' } },
      primaryFindingsType: 'one_time_pest',
      primaryActivityScore: 0,
      companionFindings: [trapping({ trap_visit_type: 'Follow-up check', traps_checked: 6 })],
    }).length).toBeGreaterThan(0);
  });
});

// r21 (#3420): flea joins the technician-report consumers — the reviewed
// Generate AI report copy replaces the intro/what-we-did portion while the
// owner-mandated cooperation line carries in EVERY body; a cleared state
// keeps the template and a contradicting draft is refused.
describe('flea technician report body (codex r21 #3420)', () => {
  const { buildTodaysResult } = require('../services/service-report/activity-indicators');
  const base = {
    projectType: 'flea',
    values: { evidence_level: 'Light' },
    activity: { score: 2 },
    visitSequence: 1,
    whatWeDid: 'Treated interior.',
    nextStep: 'We will recheck at the next visit.',
  };

  test('a non-contradicting draft becomes the body, cooperation line intact', () => {
    const r = buildTodaysResult({
      ...base,
      technicianReportBody: 'We treated the carpeted rooms and pet resting areas today.',
    });
    expect(r.bodySource).toBe('technician_report');
    expect(r.body).toContain('carpeted rooms');
    expect(r.body).toContain('Flea control works best when treatment and home care happen together');
  });

  test('a cleared state keeps the template', () => {
    const r = buildTodaysResult({
      ...base,
      activity: { score: 0 },
      values: { evidence_level: 'None observed' },
      technicianReportBody: 'We treated the carpeted rooms today.',
    });
    expect(r.bodySource).toBeUndefined();
    // template body, not the draft
    expect(r.body).not.toContain('carpeted rooms');
    expect(r.body).toContain('Flea control works best');
  });
});

// r24 (#3420): tree_shrub, rodent_exclusion, and rodent_inspection join the
// technician-report consumers — mandated disclosure/recommendation lines
// carry in every body.
describe('typed branches consume the reviewed report body (codex r24 #3420)', () => {
  const { buildTodaysResult } = require('../services/service-report/activity-indicators');

  test('tree_shrub keeps the Ganoderma answer beside the draft', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Palms', ganoderma_conk_observed: 'No', palm_trunk_concern: 'No' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'We will recheck.',
      technicianReportBody: 'We treated the palms and ornamental beds today.',
    });
    expect(r.bodySource).toBe('technician_report');
    expect(r.body).toContain('ornamental beds');
    expect(r.body).toContain('No visible Ganoderma conks');
  });

  // r45 (#3420): explicit condition claims are extracted and compared by
  // family — a cross-family MIDDLE value must refuse, same-family accepts.
  test('tree_shrub refuses a "fair" claim beside a recorded Poor (cross-family middle value)', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Poor', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The overall landscape condition is fair after treatment.',
    });
    expect(r.bodySource).toBeUndefined();
    expect(r.body).not.toContain('fair after treatment');
  });

  test('tree_shrub accepts a "fair" claim beside a recorded Fair', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Fair', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'Overall condition is fair, with new growth on the hedges.',
    });
    expect(r.bodySource).toBe('technician_report');
  });

  test('tree_shrub refuses a recovering-family claim beside a recorded Good', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The turf is improving nicely after treatment.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r46 (#3420): past-tense copular claims extract like present-tense ones.
  test('tree_shrub refuses "The plants appeared healthy" beside a recorded Poor', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Poor', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The plants appeared healthy after today’s application.',
    });
    expect(r.bodySource).toBeUndefined();
    expect(r.body).not.toContain('appeared healthy');
  });

  test('tree_shrub refuses "seemed to be in good shape" beside a recorded Declining', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Declining', plant_groups: 'Palms' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The palms seemed healthy overall.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r47 (#3420): rated/assessed constructions extract too.
  test('tree_shrub refuses "condition was rated excellent" beside a recorded Poor', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Poor', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The overall landscape condition was rated excellent this visit.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  test('rodent_exclusion keeps the remaining-concerns disclosure', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_exclusion',
      values: { exclusion_work_completed: 'Yes', remaining_concerns: 'No remaining concerns observed' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'Next visit soon.',
      technicianReportBody: 'We sealed the garage corner gap today.',
    });
    expect(r.bodySource).toBe('technician_report');
    expect(r.body).toContain('garage corner gap');
    expect(r.body).toContain('No remaining concerns were observed today.');
  });

  // r55 (#3420): explicit negative adjectives and discovery verbs.
  test('tree_shrub refuses "The plants are unhealthy" beside a recorded Good', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The plants are unhealthy along the north bed.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  test('tree_shrub refuses "We detected a Ganoderma conk" beside a recorded No', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Palms', ganoderma_conk_observed: 'No', palm_trunk_concern: 'No' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We detected a Ganoderma conk near the base of one palm.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r51 (#3420): negated condition claims deny the named family.
  test('tree_shrub refuses "The plants are not healthy" beside a recorded Good', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The plants are not healthy in the rear beds.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  test('tree_shrub accepts "The plants are not healthy" beside a recorded Poor', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Poor', plant_groups: 'Shrubs' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The plants are not healthy in the rear beds; we adjusted the program.',
    });
    expect(r.bodySource).toBe('technician_report');
  });

  // r51 (#3420): presence-state Ganoderma phrasing claims presence.
  test('tree_shrub refuses "A Ganoderma conk was present" beside a recorded No', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Palms', ganoderma_conk_observed: 'No', palm_trunk_concern: 'No' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'A Ganoderma conk was present on one palm near the drive.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r51 (#3420): noun-first species evidence claims refuse on found=No.
  test('rodent_inspection refuses "Rat droppings were present" beside found=No', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'Rat droppings were present in the attic insulation.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r51 (#3420): absence claims refuse beside a clearly nonzero gauge.
  test('flea refuses "No flea activity was observed" beside a heavy score', () => {
    const r = buildTodaysResult({
      projectType: 'flea',
      values: { evidence_level: 'Heavy — adults observed' },
      activity: { score: 4 },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'No flea activity was observed today.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r54 (#3420): inspection-only exclusion visits recorded no repairs.
  test('rodent_exclusion inspection-only accepts truthful no-repairs copy, refuses repair claims', () => {
    const base = {
      projectType: 'rodent_exclusion',
      values: { exclusion_work_completed: 'Inspection only', remaining_concerns: 'No remaining concerns observed' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
    };
    const truthful = buildTodaysResult({
      ...base,
      technicianReportBody: 'No exclusion repairs were completed today; we inspected all accessible entry areas.',
    });
    expect(truthful.bodySource).toBe('technician_report');
    expect(truthful.headline).toBe('An exclusion inspection was completed to identify potential rodent access points.');
    const claiming = buildTodaysResult({
      ...base,
      technicianReportBody: 'We sealed two gaps at the soffit line today.',
    });
    expect(claiming.bodySource).toBeUndefined();
    expect(claiming.headline).toBe('An exclusion inspection was completed to identify potential rodent access points.');
  });

  // r53 (#3420): story-lane TREND visits consume the reviewed body.
  test('rodent_exclusion trend visit consumes a clean body and refuses a repair denial', () => {
    const base = {
      projectType: 'rodent_exclusion',
      values: { exclusion_work_completed: 'Yes', remaining_concerns: 'No remaining concerns observed' },
      visitSequence: 2,
      activity: { score: 2, trendWord: 'improving' },
      whatWeDid: 'x',
      nextStep: 'n.',
    };
    const clean = buildTodaysResult({
      ...base,
      technicianReportBody: 'We sealed two additional gaps at the soffit line today.',
    });
    expect(clean.bodySource).toBe('technician_report');
    // r61: the mandated remaining-concerns disclosure carries on trend
    // visits too.
    expect(clean.body).toContain('No remaining concerns were observed today.');
    const denial = buildTodaysResult({
      ...base,
      technicianReportBody: 'The exclusion repairs could not be completed today.',
    });
    expect(denial.bodySource).toBeUndefined();
  });

  // r65 (#3420): evidence-based absence claims + zero-score story trends.
  test('flea refuses "No evidence of activity was observed" beside a heavy score', () => {
    const r = buildTodaysResult({
      projectType: 'flea',
      values: { evidence_level: 'Heavy — adults observed' },
      activity: { score: 4 },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'No evidence of activity was observed today.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r67 (#3420): active-voice absence claims refuse on nonzero gauges.
  test('flea refuses "We found no activity today" beside a heavy score', () => {
    const r = buildTodaysResult({
      projectType: 'flea',
      values: { evidence_level: 'Heavy — adults observed' },
      activity: { score: 4 },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We found no activity today.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  test('rodent_exclusion zero-score trend visit still consumes screened copy', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_exclusion',
      values: { exclusion_work_completed: 'Yes', remaining_concerns: 'No remaining concerns observed' },
      visitSequence: 2,
      activity: { score: 0, trendWord: 'improving', trend: 'improving' },
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We rechecked the sealed openings; everything remains intact.',
    });
    expect(r.bodySource).toBe('technician_report');
  });

  // r52 (#3420): absence contradicts EVERY nonzero gauge, not just band 2+.
  test('flea refuses "No flea activity was observed" beside a low score too', () => {
    const r = buildTodaysResult({
      projectType: 'flea',
      values: { evidence_level: 'Light' },
      activity: { score: 2 },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'No flea activity was observed today.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r52 (#3420): existential Ganoderma presence claims.
  test('tree_shrub refuses "There was a Ganoderma conk" beside a recorded No', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Palms', ganoderma_conk_observed: 'No', palm_trunk_concern: 'No' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'There was a Ganoderma conk at the base of the palm.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r52 (#3420): the body screens against a section's recorded findings
  // regardless of which snapshot carries it.
  test('typedBodyContradictions flags a station-count mismatch and passes agreement', () => {
    const { typedBodyContradictions } = require('../services/service-report/activity-indicators');
    expect(typedBodyContradictions(
      'termite_bait_station',
      { stations_checked: 6 },
      2,
      'We checked 8 bait stations today.',
    ).length).toBeGreaterThan(0);
    expect(typedBodyContradictions(
      'termite_bait_station',
      { stations_checked: 6 },
      2,
      'We checked 6 bait stations today.',
    )).toEqual([]);
  });

  // r60 (#3420): a zero-score companion refuses positive level claims.
  test('typedBodyContradictions flags a positive claim beside a zero score, absence stays legal', () => {
    const { typedBodyContradictions } = require('../services/service-report/activity-indicators');
    expect(typedBodyContradictions(
      'termite_bait_station',
      {},
      0,
      'Heavy activity was observed at the stations today.',
    ).length).toBeGreaterThan(0);
    expect(typedBodyContradictions(
      'termite_bait_station',
      {},
      0,
      'No activity was observed at the stations today.',
    )).toEqual([]);
  });

  // r50 (#3420): the body must agree with the recorded Ganoderma answer.
  test('tree_shrub refuses "No Ganoderma conks were observed" beside a recorded Yes', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Fair', plant_groups: 'Palms', ganoderma_conk_observed: 'Yes' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'Overall condition is fair. No Ganoderma conks were observed on the palms.',
    });
    expect(r.bodySource).toBeUndefined();
    expect(r.body).toContain('possible Ganoderma conk was observed');
  });

  test('tree_shrub refuses a conk-observed claim beside a recorded No', () => {
    const r = buildTodaysResult({
      projectType: 'tree_shrub',
      values: { landscape_condition: 'Good', plant_groups: 'Palms', ganoderma_conk_observed: 'No', palm_trunk_concern: 'No' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We observed a possible Ganoderma conk at the base of one palm.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r46 (#3420): modal/inability denials of recorded exclusion work refuse.
  test('rodent_exclusion refuses "repairs could not be completed" beside recorded work', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_exclusion',
      values: { exclusion_work_completed: 'Yes', remaining_concerns: 'No remaining concerns observed' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The exclusion repairs could not be completed today.',
    });
    expect(r.bodySource).toBeUndefined();
    expect(r.body).not.toContain('could not be completed');
  });

  test('rodent_exclusion refuses "we were unable to complete the repairs"', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_exclusion',
      values: { exclusion_work_completed: 'Yes', remaining_concerns: 'No remaining concerns observed' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We were unable to complete the repairs due to access.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  test('rodent_inspection keeps the service recommendation', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'Yes', recommended_service: 'Rodent trapping program', urgency: 'High' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'Call with questions.',
      technicianReportBody: 'We inspected the attic and garage today.',
    });
    expect(r.bodySource).toBe('technician_report');
    expect(r.body).toContain('attic and garage');
    expect(r.body).toContain('we recommend rodent trapping program');
  });

  // r46 (#3420): noun-first evidence denials refuse on a found=Yes visit.
  test('rodent_inspection refuses "No visible rodent evidence was observed" beside found=Yes', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'Yes', recommended_service: 'Rodent trapping program', urgency: 'High' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'No visible rodent evidence was observed today.',
    });
    expect(r.bodySource).toBeUndefined();
    expect(r.body).not.toContain('No visible rodent evidence');
  });

  // r47 (#3420): active-voice findings refuse on a found=No visit.
  test('rodent_inspection refuses "The technician observed rodent activity" beside found=No', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The technician observed rodent activity in the attic today.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  // r50 (#3420): species nouns claim the finding too.
  test('rodent_inspection refuses "The technician saw a rat" beside found=No', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'The technician saw a rat in the attic during the inspection.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  test('rodent_inspection refuses "We spotted mice" beside found=No but accepts "no fresh rat droppings"', () => {
    const spotted = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We spotted mice near the water heater.',
    });
    expect(spotted.bodySource).toBeUndefined();
    const clean = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We checked the attic and found no fresh rat droppings.',
    });
    expect(clean.bodySource).toBe('technician_report');
  });

  // r61 (#3420): existential evidence claims refuse on found=No.
  test('rodent_inspection refuses "There were signs of rodents" beside found=No', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'There were signs of rodents in the attic insulation.',
    });
    expect(r.bodySource).toBeUndefined();
  });

  test('rodent_inspection accepts "we have not observed rodents" on a found=No visit', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We have not observed rodents anywhere on the property this visit.',
    });
    expect(r.bodySource).toBe('technician_report');
  });

  test('rodent_inspection accepts "no rodent signs" on a found=No visit', () => {
    const r = buildTodaysResult({
      projectType: 'rodent_inspection',
      values: { activity_found: 'No', recommended_service: 'No service needed at this time' },
      visitSequence: 1,
      whatWeDid: 'x',
      nextStep: 'n.',
      technicianReportBody: 'We inspected the attic and found no fresh rodent signs.',
    });
    expect(r.bodySource).toBe('technician_report');
  });
});
