// New-sod mode (lawn report rebuild P35, GATE_LAWN_NEW_SOD_MODE): the pure helper,
// the date validator, the fixed customer copy, the report builder's neutral
// water story, the lead, and the watering text. Synthetic data only.

const {
  newSodMode, validateSodLaidOn, sodLaidLabel, weedControlMayHaveBeenApplied,
  buildNewSodBanner, buildNewSodWeekPlan, NEW_SOD_COPY, NEW_SOD_WINDOW_DAYS,
} = require('../services/service-report/lawn-new-sod');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { deriveLawnLead, WATERING_WORDS } = require('../services/service-report/lawn-report-lead');
const { lawnWateringSmsPlan } = require('../services/service-report/lawn-watering-sms');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');

const words = (text) => String(text).trim().split(/\s+/).length;

describe('newSodMode: the 21-day window on America/New_York calendar days', () => {
  const prefs = (sod_laid_on) => ({ sod_laid_on });

  test('active from the day the sod went down through day 21 inclusive', () => {
    expect(NEW_SOD_WINDOW_DAYS).toBe(21);
    expect(newSodMode(prefs('2026-10-01'), '2026-10-01')).toEqual({ active: true, laidOn: '2026-10-01', dayNumber: 0 });
    expect(newSodMode(prefs('2026-10-01'), '2026-10-12').active).toBe(true);
    expect(newSodMode(prefs('2026-10-01'), '2026-10-22')).toEqual({ active: true, laidOn: '2026-10-01', dayNumber: 21 });
  });

  test('not active the day before it went down, or on day 22', () => {
    expect(newSodMode(prefs('2026-10-01'), '2026-09-30').active).toBe(false);
    expect(newSodMode(prefs('2026-10-01'), '2026-10-23').active).toBe(false);
  });

  test('reads a pg date value (UTC midnight Date) as its own calendar day, not the day before in ET', () => {
    const laid = new Date('2026-10-01T00:00:00.000Z');
    expect(newSodMode({ sod_laid_on: laid }, '2026-10-01')).toMatchObject({ active: true, laidOn: '2026-10-01', dayNumber: 0 });
    expect(newSodMode({ sod_laid_on: laid }, '2026-09-30').active).toBe(false);
  });

  test('a visit timestamp is judged on its Eastern day', () => {
    // 2026-10-23 01:30 UTC is still 2026-10-22 in New York (day 21): active.
    expect(newSodMode(prefs('2026-10-01'), new Date('2026-10-23T01:30:00Z')).active).toBe(true);
    // 2026-10-23 05:00 UTC is 2026-10-23 01:00 in New York (day 22): over.
    expect(newSodMode(prefs('2026-10-01'), new Date('2026-10-23T05:00:00Z')).active).toBe(false);
  });

  test('fails closed: no row, no date, an unreadable date or visit is the normal report', () => {
    for (const p of [null, undefined, {}, { sod_laid_on: null }, { sod_laid_on: '' }, { sod_laid_on: 'not a date' }, { sod_laid_on: '2026-02-30' }, { sod_laid_on: new Date('x') }]) {
      expect(newSodMode(p, '2026-10-05').active).toBe(false);
    }
    expect(newSodMode(prefs('2026-10-01'), null).active).toBe(false);
    expect(newSodMode(prefs('2026-10-01'), 'garbage').active).toBe(false);
  });
});

describe('validateSodLaidOn: what the office may enter', () => {
  const now = new Date('2026-10-03T15:00:00Z');
  test('a real day that is not in the future and not older than a year', () => {
    expect(validateSodLaidOn('2026-10-03', now)).toEqual({ ok: true, value: '2026-10-03' });
    expect(validateSodLaidOn('2026-09-12', now)).toEqual({ ok: true, value: '2026-09-12' });
    expect(validateSodLaidOn('2025-10-03', now)).toEqual({ ok: true, value: '2025-10-03' });
  });
  test('null and empty clear the date', () => {
    expect(validateSodLaidOn(null, now)).toEqual({ ok: true, value: null });
    expect(validateSodLaidOn('', now)).toEqual({ ok: true, value: null });
    expect(validateSodLaidOn('   ', now)).toEqual({ ok: true, value: null });
  });
  test('refuses a future day, a day over a year old and a non-date', () => {
    expect(validateSodLaidOn('2026-10-04', now)).toEqual({ ok: false, message: 'Sod date cannot be in the future.' });
    expect(validateSodLaidOn('2025-10-02', now)).toEqual({ ok: false, message: 'Sod date cannot be more than a year ago.' });
    expect(validateSodLaidOn('2026-13-01', now).ok).toBe(false);
    expect(validateSodLaidOn('2026-02-30', now).ok).toBe(false);
    expect(validateSodLaidOn('last Tuesday', now).ok).toBe(false);
  });
  test('"today" is the New York day: late evening Eastern is still that day', () => {
    // 2026-10-04 01:00 UTC is 2026-10-03 21:00 in New York.
    expect(validateSodLaidOn('2026-10-03', new Date('2026-10-04T01:00:00Z')).ok).toBe(true);
    expect(validateSodLaidOn('2026-10-04', new Date('2026-10-04T01:00:00Z')).ok).toBe(false);
  });
});

describe('the fixed customer sentences', () => {
  const all = Object.values(NEW_SOD_COPY);

  test('plain, under 25 words, no number the business has not stated', () => {
    for (const text of all) {
      expect(words(text)).toBeLessThan(25);
      // No digits at all: no minutes, inches or day counts. "21 days" never prints.
      expect(text).not.toMatch(/\d/);
      // "every day" / "each day" is the scope's own daily watering; no count of days, weeks, minutes, inches or hours.
      expect(text.replace(/\b(every|each) day\b/gi, '')).not.toMatch(/\b(days?|weeks?|minutes?|inch(es)?|hours?|one|two|three|four|five|ten|twenty|dozen)\b/i);
      expect(findBannedCustomerCopy(text)).toEqual([]);
    }
  });

  test('the expectation line carries no watering wording, so a banner never drops it from the lead', () => {
    expect(NEW_SOD_COPY.expect).not.toMatch(WATERING_WORDS);
  });

  test('the banner: water, mow, and weed control only when none was applied', () => {
    const without = buildNewSodBanner({ weedControlApplied: false });
    expect(without).toEqual({
      state: 'new_sod',
      lines: ['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.', 'We are holding weed control until the sod has rooted.'],
      holdUntil: null, waterInBy: null, expiresAt: null, ruleSource: 'new_sod',
    });
    const withWeed = buildNewSodBanner({ weedControlApplied: true });
    expect(withWeed.lines).toEqual(['Water your new sod lightly every day.', 'Please hold off on mowing until the sod has rooted.']);
    // Unknown is treated as applied: the default never prints the weed sentence.
    expect(buildNewSodBanner().lines).toHaveLength(2);
    expect(Object.keys(without)).not.toEqual(expect.arrayContaining(['forecastLine', 'observedRain', 'mowHold']));
  });

  test('the week plan card', () => {
    expect(buildNewSodWeekPlan()).toEqual({
      title: 'New sod: water lightly every day',
      detail: 'Keep the sod moist with a light watering each day until it has rooted.',
      action: 'new_sod', visitInPlanWeek: true, prescribesRun: false,
    });
  });

  test('the technician note', () => {
    expect(sodLaidLabel('2026-10-01')).toBe('New sod laid Oct 1');
    expect(sodLaidLabel(new Date('2026-10-01T00:00:00Z'))).toBe('New sod laid Oct 1');
    expect(sodLaidLabel(null)).toBeNull();
  });
});

describe('weedControlMayHaveBeenApplied: never contradict the record', () => {
  test('a herbicide or a pre-emergent on the record', () => {
    expect(weedControlMayHaveBeenApplied({ kinds: ['herbicide'], products: [] })).toBe(true);
    expect(weedControlMayHaveBeenApplied({ kinds: ['pre_emergent'], products: [] })).toBe(true);
  });
  test('a product whose recorded targets name weeds', () => {
    expect(weedControlMayHaveBeenApplied({ kinds: ['other'], products: [{ name: 'X', targets: ['Dollarweed'] }] })).toBe(true);
  });
  test('products that could not be read count as possibly applied', () => {
    expect(weedControlMayHaveBeenApplied(null, { productsUnknown: true })).toBe(true);
  });
  test('only a readable visit with no weed control (or no products) is clear', () => {
    expect(weedControlMayHaveBeenApplied({ kinds: ['fertilizer'], products: [{ name: 'Y', targets: ['Color'] }] })).toBe(false);
    expect(weedControlMayHaveBeenApplied(null)).toBe(false);
  });
});

describe('buildLawnReportV2 with newSod', () => {
  const lawnAssessment = (extra = {}) => ({
    assessmentId: 'la-1',
    assessmentDate: '2026-10-05',
    scores: { overallScore: 70, turfDensity: 70, weedSuppression: 70, colorHealth: 70, stressDamage: 70, fungusControl: 40 },
    overwateringSignal: true,
    droughtStress: 'moderate',
    photos: [],
    waterContext: {
      rainfallInches7d: 3.2,
      irrigationInchesPerWeek: 1.5,
      effectiveInches7d: 4.7,
      targetInchesPerWeek: 1,
      irrigationAdvice: { status: 'surplus', rainKnown: true, profileMissing: false },
      weekPlan: buildNewSodWeekPlan(),
    },
    ...extra,
  });
  const mowingHeight = { currentHeightIn: 1.5, targetBand: { min: 3, max: 4 }, status: 'below' };

  test('without newSod the normal engine says ease back on watering (the control)', () => {
    const v2 = buildLawnReportV2({ lawnAssessment: lawnAssessment(), mowingHeight });
    expect(v2.insights.some((c) => c.category === 'water')).toBe(true);
    expect(v2.water.status).toBe('high');
  });

  test('with newSod no water card, no balance status or prose, no mowing gauge, fixed expectation note', () => {
    const v2 = buildLawnReportV2({ lawnAssessment: lawnAssessment(), mowingHeight, newSod: true });
    expect(v2.insights.filter((c) => c.category === 'water')).toEqual([]);
    expect(v2.insights.filter((c) => c.category === 'mowing')).toEqual([]);
    expect(v2.mowing).toBeNull();
    expect(v2.water.status).toBe('unknown');
    expect(v2.water.explanation).toBeNull();
    expect(v2.water.weekPlan.title).toBe('New sod: water lightly every day');
    expect(v2.snapshot.seasonalNote).toBe(NEW_SOD_COPY.expect);
    expect(v2.snapshot.seasonalNoteSource).toBeUndefined();
    // No root cause or action line talks about easing back or cutting height.
    const text = JSON.stringify({ s: v2.snapshot, i: v2.insights });
    expect(text).not.toMatch(/ease back|easing back|too much water|dry out between|lower the mower|mower/i);
  });
});

describe('the lead keeps the new-sod expectation line under the new-sod banner', () => {
  test('lead.whatToExpect is the fixed sentence', () => {
    const reportV2 = {
      snapshot: { statusHeadline: 'Looking healthy', nextVisit: null },
      banner: buildNewSodBanner({ weedControlApplied: true }),
      insights: [],
      aftercare: {},
      water: { weekPlan: buildNewSodWeekPlan() },
    };
    const copyV6 = { headline: null, whatWeDid: 'We applied a fertilizer.', whatToExpect: NEW_SOD_COPY.expect, watching: null };
    const lead = deriveLawnLead(reportV2, { copyV6 });
    expect(lead.whatToExpect).toBe(NEW_SOD_COPY.expect);
  });
});

describe('the watering text never goes to an active new-sod property', () => {
  const instruction = {
    state: 'hold', lines: ['Skip your turf watering until Thu 3 PM.', 'Then water as usual.'],
    completedAt: '2026-10-05T14:00:00Z', expiresAt: '2026-10-06T19:00:00Z',
  };
  const base = {
    instruction, deliveryMode: 'auto_send', phone: '+15555550100', gateOn: true, ruleGateOn: true,
    completedAt: '2026-10-05T14:00:00Z', completionTextRequested: true, nowMs: Date.parse('2026-10-05T15:00:00Z'),
  };
  test('sends for a normal property (the control)', () => {
    expect(lawnWateringSmsPlan(base).send).toBe(true);
  });
  test('sends nothing for a new-sod property', () => {
    expect(lawnWateringSmsPlan({ ...base, newSodActive: true })).toEqual({ send: false, reason: 'new_sod' });
  });
});

describe('sendLawnWateringSms with new-sod mode (mocked IO)', () => {
  const { sendLawnWateringSms } = require('../services/service-report/lawn-watering-sms');
  const KEYS = ['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_NEW_SOD_MODE'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.GATE_LAWN_WATERING_SMS = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
  });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  // A fake knex for the shared resolver: the preference row, then the visit identity.
  function fakeDb({ prefs, identity, throws = false }) {
    const db = jest.fn((table) => {
      const q = {};
      for (const m of ['where', 'leftJoin', 'join']) q[m] = () => q;
      q.first = async () => {
        if (throws) throw new Error('connection reset');
        return table === 'property_preferences' ? prefs : identity;
      };
      return q;
    });
    db.raw = (sql) => sql;
    return db;
  }
  const IDENTITY = (over = {}) => ({ service_date: '2026-10-05', scheduled_date: '2026-10-05', ss_id: 'svc-1', address_diverges: false, ...over });

  function harness(dbOpts) {
    const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
    const getTemplate = jest.fn(async (key, vars) => `Watering: ${vars.watering_lines}`);
    const mergeNotes = jest.fn(async () => {});
    const db = fakeDb(dbOpts);
    return {
      state: {
        record: { id: 'rec-1', structured_notes: {} },
        svc: { id: 'svc-1', customer_id: 'cust-1', cust_phone: '+19415550100' },
        notes: { lawnWateringFreeze: { wateringInstruction: { state: 'hold', lines: ['Skip watering until 8:00 PM tonight.'], completedAt: new Date().toISOString() } } },
        isBackfill: false, deliveryMode: 'auto_send', internalOnly: false, completionTextRequested: true,
      },
      deps: { db, sendCustomerMessage, getTemplate, mergeNotes, throwIfDeliveryUnverified: (r) => r },
      sendCustomerMessage, getTemplate, mergeNotes, db,
    };
  }
  const ACTIVE = { prefs: { sod_laid_on: '2026-10-01' }, identity: IDENTITY() };

  test('gate off: the property row is never read and the text goes out as before', async () => {
    const h = harness(ACTIVE);
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    expect(h.db).not.toHaveBeenCalled();
  });

  test('gate on, active new-sod property: no template read, no send, no marker', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const h = harness(ACTIVE);
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skip_new_sod' });
    expect(h.getTemplate).not.toHaveBeenCalled();
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    expect(h.mergeNotes).not.toHaveBeenCalled();
  });

  test('gate on, sod window over, no date, no row, a divergent address or an unknown visit: the text goes out as before', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    for (const opts of [
      { prefs: { sod_laid_on: '2025-12-01' }, identity: IDENTITY() },
      { prefs: { sod_laid_on: null }, identity: IDENTITY() },
      { prefs: null, identity: IDENTITY() },
      { prefs: { sod_laid_on: '2026-10-01' }, identity: IDENTITY({ address_diverges: true }) },
      { prefs: { sod_laid_on: '2026-10-01' }, identity: IDENTITY({ ss_id: null }) },
      { prefs: { sod_laid_on: '2026-10-01' }, identity: null },
    ]) {
      const h = harness(opts);
      expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    }
  });

  test('gate on, anything unreadable: fail closed, nothing sent and no marker written', async () => {
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
    const h = harness({ ...ACTIVE, throws: true });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skip_new_sod_unreadable' });
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    expect(h.mergeNotes).not.toHaveBeenCalled();
  });
});
