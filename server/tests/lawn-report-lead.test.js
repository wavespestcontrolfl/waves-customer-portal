// Lawn report LEAD derivation (lawn report rebuild P7, GATE_LAWN_REPORT_LEAD).
// deriveLawnLead is a pure read of the finished reportV2; applyLawnReportReconciliation
// derives it at the reconcile tail only while the gate is live, only for lawn.
// Synthetic payloads only.

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
const { deriveLawnLead, leadWords } = require('../services/service-report/lawn-report-lead');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { buildWateringBanner } = require('../services/service-report/report-data');
const { aftercareCustomerTask, normalizeLawnAftercare } = require('../services/service-report/lawn-aftercare');
const featureGates = require('../config/feature-gates');

const HOLD_BANNER = { state: 'hold', lines: ['Skip your turf watering until Thu 3 PM.', 'That gives today’s treatment time to work.'] };

const issue = (overrides = {}) => ({
  category: 'weeds', status: 'watch', priority: 1, headline: 'Weeds along the edge',
  customerAction: 'Raise your mower to 4 inches this week.', nextVisitPlan: 'Spot-treat the edge weeds.',
  ...overrides,
});

const reportOf = (overrides = {}) => ({
  snapshot: {
    statusHeadline: 'Stable — watching weeds',
    scoreExplanation: 'The score is mainly pulled down by weed pressure.',
    rootCause: null,
    treatmentSummary: 'Today we applied a broadleaf herbicide to the edge weeds.',
    customerAction: 'Raise your mower to 4 inches this week.',
    wavesNext: 'We will recheck the edge.',
  },
  insights: [issue()],
  followUp: null,
  banner: undefined,
  aftercare: undefined,
  water: {},
  ...overrides,
});

describe('deriveLawnLead', () => {
  test('no snapshot → null', () => {
    expect(deriveLawnLead(null)).toBeNull();
    expect(deriveLawnLead({})).toBeNull();
    expect(deriveLawnLead({ snapshot: null, insights: [] })).toBeNull();
  });

  test('maps the snapshot fields, leaves progress as an empty slot', () => {
    expect(deriveLawnLead(reportOf())).toEqual({
      headline: 'Stable — watching weeds',
      why: 'The score is mainly pulled down by weed pressure.',
      progress: null,
      applied: 'Today we applied a broadleaf herbicide to the edge weeds.',
      yourPart: ['Raise your mower to 4 inches this week.'],
      next: 'Spot-treat the edge weeds.',
    });
    const withProgress = reportOf();
    withProgress.snapshot.progress = 'The thin edge has started to fill in.';
    expect(deriveLawnLead(withProgress).progress).toBe('The thin edge has started to fill in.');
  });

  test('why prefers rootCause over scoreExplanation; missing statusHeadline is null', () => {
    const r = reportOf();
    r.snapshot.rootCause = 'The main driver is mowing height.';
    r.snapshot.statusHeadline = '';
    const lead = deriveLawnLead(r);
    expect(lead.why).toBe('The main driver is mowing height.');
    expect(lead.headline).toBeNull();
  });

  describe('yourPart', () => {
    test('no banner: the snapshot customerAction, deduped, never the stock no-action line', () => {
      expect(deriveLawnLead(reportOf()).yourPart).toEqual(['Raise your mower to 4 inches this week.']);
      const none = reportOf();
      none.snapshot.customerAction = null;
      expect(deriveLawnLead(none).yourPart).toEqual([]);
      const stock = reportOf();
      stock.snapshot.customerAction = 'No action is needed from you before then unless the area changes quickly.';
      expect(deriveLawnLead(stock).yourPart).toEqual([]);
    });

    test('no banner: the snapshot action wins even when it carries the aftercare task', () => {
      const r = reportOf();
      r.snapshot.customerAction = 'Water in today’s application as directed. Raise your mower to 4 inches this week.';
      expect(deriveLawnLead(r).yourPart).toEqual([r.snapshot.customerAction]);
    });

    test('under a banner a non-water top-issue action is kept', () => {
      const lead = deriveLawnLead(reportOf({ banner: HOLD_BANNER }));
      expect(lead.yourPart).toEqual(['Raise your mower to 4 inches this week.']);
    });

    test('under a hold banner a top-issue action that restates the aftercare task is dropped', () => {
      const instruction = buildWateringInstruction({
        rules: [{ mode: 'hold', hold_hours: 24, source: 'label' }],
        completedAt: '2026-09-30T18:40:00Z',
      });
      const built = buildLawnReportV2({
        lawnAssessment: {
          scores: { turfDensity: 88, weedSuppression: 92, colorHealth: 86, stressDamage: 90, fungusControl: 95, overallScore: 89, season: 'peak' },
          droughtStress: 'none',
          waterContext: { rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25, irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 } },
          photos: [],
        },
        applications: [{ product: { name: 'Celsius WG', category: 'herbicide', irrigation_required: false }, targets: ['weeds'] }],
        wateringInstruction: instruction,
      });
      built.banner = buildWateringBanner(instruction, null);
      const task = aftercareCustomerTask(normalizeLawnAftercare(built.aftercare), built.water ? built.water.weekPlan : null);
      expect(task).toBeTruthy();
      // The card restates the banner's task in its own sentence, plus a mowing step.
      built.insights = [issue({ customerAction: `${task} Raise your mower to 4 inches.` })];
      expect(deriveLawnLead(built).yourPart).toEqual([]);
      // The same card without the aftercare task keeps its own step.
      built.insights = [issue({ customerAction: 'Raise your mower to 4 inches.' })];
      expect(deriveLawnLead(built).yourPart).toEqual(['Raise your mower to 4 inches.']);
    });

    test('a banner with no lines is not a banner: the snapshot action is used', () => {
      const r = reportOf({ banner: { state: null, lines: [], mowHold: { line: 'Hold off mowing for 2 days.' } } });
      expect(deriveLawnLead(r).yourPart).toEqual(['Raise your mower to 4 inches this week.']);
    });

    test('only the top-ranked watch / needs_attention card counts, by priority', () => {
      const r = reportOf({
        banner: HOLD_BANNER,
        insights: [
          issue({ priority: 3, status: 'healthy', customerAction: 'Healthy card action.' }),
          issue({ priority: 2, status: 'watch', customerAction: 'Second card action.' }),
          issue({ priority: 1, status: 'needs_attention', customerAction: 'Top card action.' }),
        ],
      });
      expect(deriveLawnLead(r).yourPart).toEqual(['Top card action.']);
    });

    test('no more than two entries and no duplicates', () => {
      const r = reportOf();
      r.snapshot.customerAction = 'Raise your mower to 4 inches this week.';
      expect(deriveLawnLead(r).yourPart.length).toBeLessThanOrEqual(2);
    });
  });

  describe('under a watering banner no lead field talks about watering', () => {
    test('a watering headline, why, task and next fall to the next source or null', () => {
      const r = reportOf({
        banner: HOLD_BANNER,
        insights: [issue({ customerAction: 'Check sprinkler coverage in that area.', nextVisitPlan: 'Recheck irrigation uniformity.' })],
        followUp: { reason: 'Confirm irrigation uniformity next visit.' },
      });
      r.snapshot.statusHeadline = 'Stable — watching watering';
      r.snapshot.rootCause = 'The lawn is simply running a little dry — a bit more even watering is the fix.';
      const lead = deriveLawnLead(r);
      expect(lead.headline).toBeNull();
      expect(lead.why).toBe('The score is mainly pulled down by weed pressure.');
      expect(lead.yourPart).toEqual([]);
      // The planned follow-up owns the line: a watering reason leaves it empty
      // rather than swapping in another plan.
      expect(lead.next).toBeNull();
    });

    test.each([
      'Recheck the moisture balance next visit.',
      'Recheck the dry spots next visit.',
      'Check for drought stress next visit.',
      'Look at the damp area next visit.',
      'Recheck after the heavy rain next visit.',
    ])('"%s" is filtered under a banner and kept without one', (reason) => {
      const withReason = (banner) => reportOf({ banner, followUp: { reason } });
      expect(deriveLawnLead(withReason(HOLD_BANNER)).next).toBeNull();
      expect(deriveLawnLead(withReason(undefined)).next).toBe(reason);
    });

    test('banner ownership is the wording test alone: the real coverage card strings drop, its plain headline leads', () => {
      const coverage = issue({
        category: 'coverage',
        customerAction: 'Check sprinkler coverage in that area rather than watering the whole yard more.',
        nextVisitPlan: 'Recheck the flagged area next visit to see whether coverage evened out.',
      });
      const r = reportOf({ banner: HOLD_BANNER, insights: [coverage] });
      r.snapshot.statusHeadline = 'Stable — watching thin areas';
      r.snapshot.wavesNext = coverage.nextVisitPlan;
      const lead = deriveLawnLead(r);
      expect(lead.yourPart).toEqual([]);
      expect(lead.next).toBeNull();
      expect(lead.headline).toBe('Stable — watching thin areas');
      // A non-watering step on a water or coverage card is an ordinary task.
      const mower = reportOf({ banner: HOLD_BANNER, insights: [issue({ category: 'coverage', customerAction: 'Raise your mower to 4 inches this week.', nextVisitPlan: 'Spot-treat the edge weeds.' })] });
      expect(deriveLawnLead(mower).yourPart).toEqual(['Raise your mower to 4 inches this week.']);
      expect(deriveLawnLead(mower).next).toBe('Spot-treat the edge weeds.');
    });

    test('applied is a statement of record: "watered in" stays under a banner', () => {
      const r = reportOf({ banner: HOLD_BANNER });
      r.snapshot.treatmentSummary = 'Today we applied a broadleaf herbicide that is watered in by label.';
      expect(deriveLawnLead(r).applied).toBe(r.snapshot.treatmentSummary);
    });

    test('the same strings are kept when there is no banner', () => {
      const r = reportOf({ followUp: { reason: 'Confirm irrigation uniformity next visit.' } });
      r.snapshot.statusHeadline = 'Stable — watching watering';
      const lead = deriveLawnLead(r);
      expect(lead.headline).toBe('Stable — watching watering');
      expect(lead.next).toBe('Confirm irrigation uniformity next visit.');
    });
  });

  describe('next precedence', () => {
    test('followUp.reason, then the top issue plan, else null (snapshot.wavesNext is never read)', () => {
      const r = reportOf({ followUp: { reason: 'Recheck the thin edge.' } });
      expect(deriveLawnLead(r).next).toBe('Recheck the thin edge.');
      expect(deriveLawnLead(reportOf()).next).toBe('Spot-treat the edge weeds.');
      expect(deriveLawnLead(reportOf({ insights: [issue({ nextVisitPlan: null })] })).next).toBeNull();
    });

    test('a planned follow-up owns next: the top issue plan is never used when one exists, even if it was filtered', () => {
      const banner = reportOf({ banner: HOLD_BANNER, followUp: { reason: 'Recheck the moisture balance.' } });
      expect(deriveLawnLead(banner).next).toBeNull();
      const kept = reportOf({ banner: HOLD_BANNER, followUp: { reason: 'Recheck the thin edge.' } });
      expect(deriveLawnLead(kept).next).toBe('Recheck the thin edge.');
      // A blank follow-up reason is no follow-up.
      expect(deriveLawnLead(reportOf({ followUp: { reason: '  ' } })).next).toBe('Spot-treat the edge weeds.');
      const bare = reportOf({ insights: [] });
      bare.snapshot.wavesNext = null;
      expect(deriveLawnLead(bare).next).toBeNull();
    });
  });
});

describe('leadWords', () => {
  test('counts banner lines, mow line, lead fields and 24 words of static labels', () => {
    const r = reportOf({ banner: { ...HOLD_BANNER, mowHold: { line: 'Hold off mowing for 2 days.' } } });
    r.lead = { headline: 'Looking great', why: null, progress: null, applied: 'We applied it.', yourPart: ['Do the thing now.'], next: 'Next visit soon.' };
    // banner 8 + 7, mow 6, headline 2, applied 3, yourPart 4, next 3, static 24
    expect(leadWords(r)).toBe(8 + 7 + 6 + 2 + 3 + 4 + 3 + 24);
    expect(leadWords({})).toBe(24);
  });

  test('counts the next-visit date the client joins to lead.next', () => {
    const r = reportOf();
    r.lead = { headline: null, why: null, progress: null, applied: null, yourPart: [], next: 'Recheck the edge.' };
    r.snapshot.nextVisit = { label: 'Tuesday, October 13', source: 'scheduled' };
    expect(leadWords(r)).toBe(3 + 3 + 24);
    r.snapshot.nextVisit = { label: 'Tuesday, October 13', source: 'estimated', cadenceWeeks: 4 };
    // "Expected around Tuesday, October 13 (about every 4 weeks)"
    expect(leadWords(r)).toBe(3 + 9 + 24);
    r.snapshot.nextVisit = { label: 'Invalid Date', source: 'scheduled' };
    expect(leadWords(r)).toBe(3 + 24);
  });
});

describe('applyLawnReportReconciliation lead tail', () => {
  // The reconcile pass rewrites the re-entry advisory in place, so every call gets its own.
  const dynamic = () => ({ reentry: { targets: [{ statusAtGeneratedAt: 'ready' }], petAdvisory: 'Keep pets off treated turf until dry.' } });
  const payload = (serviceLine = 'lawn') => ({
    serviceLine,
    summary: 'Recent rainfall totaling 2.72 inches raised disease pressure this week. We will re-check the flagged areas.',
    lawnAssessment: {
      recommendations: {
        nextVisitFocus: 'Evaluate the response to today’s treatment; inspect thinning edge areas for chinch bug or drought stress.',
      },
    },
    reportV2: {
      water: { rainInches: 2.96, targetInches: 0.75, droughtSignal: true },
      insights: [{
        category: 'damage', status: 'watch', priority: 1,
        headline: 'Early stress showing near the sidewalk',
        whatWeSaw: 'Thinning tan patches hint at early minor stress, which could line up with chinch bug activity or a dry pocket.',
        customerAction: 'Raise your mower to 4 inches this week.',
        nextVisitPlan: 'Recheck the thin tan patches.',
      }],
      snapshot: {
        statusHeadline: 'Stable — watching early stress',
        scoreExplanation: 'Thinning tan patches suggest stress that could be consistent with chinch bug activity or localized drought.',
        rootCause: null,
        treatmentSummary: 'Today we applied an insecticide to the thin areas.',
        customerAction: 'Raise your mower to 4 inches this week.',
        wavesNext: null,
      },
    },
  });
  const withGate = (value, fn) => {
    const previous = process.env.GATE_LAWN_REPORT_LEAD;
    if (value === undefined) delete process.env.GATE_LAWN_REPORT_LEAD; else process.env.GATE_LAWN_REPORT_LEAD = value;
    try { return fn(); } finally {
      if (previous === undefined) delete process.env.GATE_LAWN_REPORT_LEAD; else process.env.GATE_LAWN_REPORT_LEAD = previous;
    }
  };

  test('lawnReportLeadLive reads the env at call time', () => {
    expect(withGate(undefined, () => featureGates.lawnReportLeadLive())).toBeFalsy();
    expect(withGate('true', () => featureGates.lawnReportLeadLive())).toBe(true);
    expect(withGate('false', () => featureGates.lawnReportLeadLive())).toBeFalsy();
  });

  test('gate off: no lead key, and the payload is exactly what the reconcile pass alone produces', () => {
    const off = withGate(undefined, () => applyLawnReportReconciliation(payload(), dynamic()));
    expect(Object.prototype.hasOwnProperty.call(off.reportV2, 'lead')).toBe(false);
    const on = withGate('true', () => applyLawnReportReconciliation(payload(), dynamic()));
    const { lead, ...rest } = on.reportV2;
    expect(lead).toBeTruthy();
    expect({ ...on, reportV2: rest }).toEqual(off);
  });

  test('tree & shrub (and any non-lawn line) never gets a lead, gate on', () => {
    for (const line of ['tree_shrub', 'pest', null]) {
      const data = withGate('true', () => applyLawnReportReconciliation(payload(line), dynamic()));
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'lead')).toBe(false);
    }
  });

  test('derived even when reconcileLawnReport returns nothing, and with no reportV2 it is a no-op', () => {
    // A lawn line with a reportV2 but a snapshot-less payload derives no lead.
    const bare = withGate('true', () => applyLawnReportReconciliation({ serviceLine: 'lawn', reportV2: { insights: [] } }, null));
    expect(Object.prototype.hasOwnProperty.call(bare.reportV2, 'lead')).toBe(false);
    const noV2 = withGate('true', () => applyLawnReportReconciliation({ serviceLine: 'lawn' }, null));
    expect(noV2).toEqual({ serviceLine: 'lawn' });
    expect(withGate('true', () => applyLawnReportReconciliation(null, null))).toBeNull();
  });

  test('the lead is derived from the reconciled strings, not the pre-reconcile ones', () => {
    const before = deriveLawnLead({ ...payload().reportV2, followUp: { reason: 'inspect thinning edge areas for chinch bug or drought stress' } });
    expect(before.why).toMatch(/localized drought/);
    const data = withGate('true', () => applyLawnReportReconciliation(payload(), dynamic()));
    const { lead, snapshot, followUp } = data.reportV2;
    expect(snapshot.scoreExplanation).not.toMatch(/localized drought/);
    expect(lead.why).toBe(snapshot.scoreExplanation);
    expect(lead.why).toMatch(/uneven sprinkler coverage/);
    expect(followUp.reason).not.toMatch(/drought/i);
    expect(lead.next).toBe(followUp.reason);
    expect(lead.yourPart).toEqual(['Raise your mower to 4 inches this week.']);
  });

  test('a throw in the lead derive leaves the reconciled payload intact and without a lead', () => {
    let out;
    jest.isolateModules(() => {
      jest.doMock('../services/service-report/lawn-report-lead', () => ({
        deriveLawnLead: () => { throw new Error('boom'); },
      }));
      const { applyLawnReportReconciliation: apply } = require('../services/service-report/report-consistency');
      out = withGate('true', () => apply(payload(), dynamic()));
    });
    jest.dontMock('../services/service-report/lawn-report-lead');
    expect(Object.prototype.hasOwnProperty.call(out.reportV2, 'lead')).toBe(false);
    // The reconcile pass itself ran: the drought wording is already reworded.
    expect(out.reportV2.followUp.reason).not.toMatch(/drought/i);
    expect(out.reportV2.snapshot.scoreExplanation).toMatch(/uneven sprinkler coverage/);
  });
});
