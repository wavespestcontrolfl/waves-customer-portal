/**
 * reconcileLawnReport is service-line-aware (T&S audit 2026-07-18 P1).
 *
 * The reportV2 slot carries lawn AND tree & shrub payloads, and the route ran
 * the lawn reconciler on both: every treated T&S report viewed after its
 * re-entry window told the customer "Treated turf has dried", and prose like
 * "we'll re-check" fabricated a "follow-up already planned" todaysResult with
 * no supporting card (the T&S section never renders followUp). These tests
 * pin the split: lawn keeps the full pass, tree & shrub gets only the
 * re-entry rewrite in its own surface wording, unknown lines are a no-op.
 */

const { reconcileLawnReport } = require('../services/service-report/report-consistency');
const { structuredCustomerConcern, stripLiveOnlyScheduleFields } = require('../services/service-report/report-data');

function reportInput({ allReady = true, petAdvisory = 'Keep pets off treated beds and foliage until dry.' } = {}) {
  return {
    data: {
      summary: 'Treated the front beds. We’ll re-check the gardenias at the next visit.',
      dynamicContext: {
        reentry: {
          targets: [{ statusAtGeneratedAt: allReady ? 'ready' : 'pending' }],
          petAdvisory,
        },
      },
    },
    reportV2: {
      insights: [{ status: 'watch', title: 'Pest pressure' }],
    },
  };
}

describe('reconcileLawnReport — tree_shrub', () => {
  test('re-entry rewrite uses beds-and-foliage wording, never "turf"', () => {
    const fix = reconcileLawnReport({ ...reportInput({ allReady: true }), serviceLine: 'tree_shrub' });
    expect(fix.reentry).toBeTruthy();
    expect(fix.reentry.status).toBe('Ready now');
    expect(fix.reentry.petAdvisory).toBe('Treated beds and foliage have dried — pets and family are fine around them now.');
    expect(/turf/i.test(fix.reentry.petAdvisory)).toBe(false);
  });

  test('not-yet-dry keeps the T&S surface wording too', () => {
    const fix = reconcileLawnReport({ ...reportInput({ allReady: false }), serviceLine: 'tree_shrub' });
    expect(fix.reentry.status).toBe('Ready once dry');
    expect(fix.reentry.petAdvisory).toBe('Keep pets and family off treated beds and foliage until they dry.');
    expect(/turf/i.test(fix.reentry.petAdvisory)).toBe(false);
  });

  test('never fabricates todaysResult or a follow-up from prose', () => {
    // Watch insight + "we'll re-check" prose — the exact trigger that used to
    // produce "…a follow-up is already planned" with no card to back it.
    const fix = reconcileLawnReport({ ...reportInput({ allReady: true }), serviceLine: 'tree_shrub' });
    expect(fix.todaysResult).toBeNull();
    expect(fix.followUp).toBeNull();
  });

  test('advisory without an "until dry" cue is left alone', () => {
    const fix = reconcileLawnReport({
      ...reportInput({ petAdvisory: 'Water in within 24 hours.' }),
      serviceLine: 'tree_shrub',
    });
    expect(fix.reentry).toBeNull();
  });
});

describe('reconcileLawnReport — lawn (unchanged full pass)', () => {
  test('default serviceLine is lawn: turf wording + follow-up + todaysResult still produced', () => {
    const fix = reconcileLawnReport(reportInput({ allReady: true }));
    expect(fix.reentry.petAdvisory).toBe('Treated turf has dried — pets and family are fine on it now.');
    expect(fix.followUp).toBeTruthy();
    expect(fix.todaysResult).toMatch(/follow-up is already planned/);
  });

  test('explicit lawn matches the default', () => {
    const fix = reconcileLawnReport({ ...reportInput({ allReady: false }), serviceLine: 'lawn' });
    expect(fix.reentry.petAdvisory).toBe('Keep pets and family off treated turf until it dries.');
  });
});

describe('reconcileLawnReport — other lines', () => {
  test('unknown service line is a no-op rather than a wrong-surface rewrite', () => {
    expect(reconcileLawnReport({ ...reportInput(), serviceLine: 'pest' })).toBeNull();
    expect(reconcileLawnReport({ ...reportInput(), serviceLine: '' })).toBeNull();
  });
});

describe('structuredCustomerConcern (concern-card key mismatch)', () => {
  // Completion writes customerConcernText; the V2 builders read through this
  // helper so the "what you flagged" card can't silently die on a key drift.
  test('reads the completion-written key first', () => {
    expect(structuredCustomerConcern({ customerConcernText: 'Whiteflies on the hibiscus' }))
      .toBe('Whiteflies on the hibiscus');
  });

  test('precedence covers every historical spelling', () => {
    expect(structuredCustomerConcern({
      customerConcernText: 'newest',
      customer_concern_text: 'snake',
      customerConcern: 'camel',
      customer_concern: 'legacy',
    })).toBe('newest');
    expect(structuredCustomerConcern({ customer_concern_text: 'snake' })).toBe('snake');
    expect(structuredCustomerConcern({ customerConcern: 'camel' })).toBe('camel');
    expect(structuredCustomerConcern({ customer_concern: 'legacy' })).toBe('legacy');
  });

  test('empty and absent yield the empty string', () => {
    expect(structuredCustomerConcern({})).toBe('');
    expect(structuredCustomerConcern({ customerConcernText: '   ' })).toBe('');
    expect(structuredCustomerConcern()).toBe('');
  });
});

describe('stripLiveOnlyScheduleFields (shared by route + queued PDF renderer)', () => {
  // Cached PDFs are content-key-insensitive snapshots — schedule fields
  // rendered into them outlive any reschedule (codex P2 r2: the pdf-queue
  // path bypassed the route-level strip, so the strip is shared).
  test('removes nextAppointment and the V2 snapshot nextVisit, preserves the rest', () => {
    const data = {
      serviceLine: 'tree_shrub',
      nextAppointment: { date: '2026-07-24' },
      reportV2: { snapshot: { nextVisit: { label: 'Friday, July 24' }, status: 'healthy' } },
    };
    const out = stripLiveOnlyScheduleFields(data);
    expect(out).toBe(data);
    expect(data.nextAppointment).toBeUndefined();
    expect(data.reportV2.snapshot.nextVisit).toBeUndefined();
    expect(data.reportV2.snapshot.status).toBe('healthy');
  });

  test('null-safe on payloads without a V2 snapshot', () => {
    expect(stripLiveOnlyScheduleFields(null)).toBeNull();
    expect(() => stripLiveOnlyScheduleFields({ nextAppointment: null })).not.toThrow();
    expect(() => stripLiveOnlyScheduleFields({ reportV2: {} })).not.toThrow();
  });
});
