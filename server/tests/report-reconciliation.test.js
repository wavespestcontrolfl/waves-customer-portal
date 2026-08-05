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
