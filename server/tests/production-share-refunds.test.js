// Production share refunds, the pure parts (production-share-refunds.js, production-share-refund-alerts.js, payroll-production-share.js):
// the ledger arithmetic of take-backs, the alert copy and dedupe key, and what a check's view says. The reads and routes are in
// production-share-refunds-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { applyTakeBacks, flagKeyOf } = require('../services/production-share-refunds');
const { flagsOf, raiseRefundFlagAlerts, KINDS } = require('../services/production-share-refund-alerts');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const payShare = require('../services/payroll-production-share');

const stops = (...credits) => credits.map((creditCents, n) => ({ visitId: `v${n}`, creditCents }));
const owed = (paidWeekStart, visitId, cents) => ({ visitId, sourceCheckId: `c-${visitId}`, paidWeekStart, workDate: paidWeekStart, cents, dependsOnRuns: ['r2', 'r1'] });

describe('applyTakeBacks', () => {
  it('takes the oldest paid week first and never takes the week below $0; the rest is not taken', () => {
    const result = applyTakeBacks(stops(30000, 20000), [owed('2026-09-21', 'b', 40000), owed('2026-09-14', 'a', 30000)]);
    expect(result.takeBacks.map((one) => [one.visitId, one.cents])).toEqual([['a', 30000], ['b', 20000]]);
    expect(result).toMatchObject({ creditedCents: 0, refundTakeBackCents: 50000, outstandingCents: 20000 });
  });

  it('adds credit back first for a negative entry, so a give-back lets a take-back fit', () => {
    const result = applyTakeBacks(stops(10000), [owed('2026-09-14', 'a', 25000), owed('2026-09-21', 'b', -20000)]);
    expect(result.takeBacks.map((one) => [one.visitId, one.cents])).toEqual([['a', 25000], ['b', -20000]]);
    expect(result).toMatchObject({ creditedCents: 5000, refundTakeBackCents: 5000 });
  });

  it('keeps a 0-cent entry with its runs, sorted, when nothing moves or nothing fits', () => {
    const result = applyTakeBacks(stops(0), [owed('2026-09-14', 'a', 0), owed('2026-09-21', 'b', 500)]);
    expect(result.takeBacks).toEqual([
      expect.objectContaining({ visitId: 'a', cents: 0, dependsOnRuns: ['r1', 'r2'] }),
      expect.objectContaining({ visitId: 'b', cents: 0, dependsOnRuns: ['r1', 'r2'] }),
    ]);
    expect(result).toMatchObject({ creditedCents: 0, refundTakeBackCents: 0 });
  });

  it('does nothing with no entries', () => {
    expect(applyTakeBacks(stops(100, 200), [])).toEqual({ takeBacks: [], refundTakeBackCents: 0, creditedCents: 300, outstandingCents: 0 });
  });
});

describe('the refund bell', () => {
  const week = {
    technicianId: 't1',
    stops: [{ visitId: 'v1', kind: 'refund_flagged', refundSignals: ['pay:x:100'] }, { visitId: 'v2', kind: 'priced', refundSignals: [] }],
    takeBackToSet: [{ visitId: 'v3', newSignals: ['orphan:y', 'pay:x:100'] }],
  };

  it('lists the flagged stop of the own week and the paid stop to set, nothing else', () => {
    expect(flagsOf(week)).toEqual([
      { kind: 'own', visitId: 'v1', signals: ['pay:x:100', 'kind:refund_flagged'] },
      { kind: 'paid', visitId: 'v3', signals: ['orphan:y', 'pay:x:100', 'answer:none', 'signals:none'] },
    ]);
    // A refund the owner answered that changed rings as its own kind.
    expect(flagsOf({ takeBackToSet: [{ visitId: 'v4', newSignals: [], reason: 'changed', answerRevision: '7:t' }] }))
      .toEqual([{ kind: 'changed', visitId: 'v4', signals: ['answer:7:t', 'signals:none'] }]);
  });

  it('keys a flag by visit and sorted signals, so the same refund is one bell and a new signal is another', () => {
    expect(flagKeyOf('V1', ['b', 'a'])).toBe(flagKeyOf('v1', ['a', 'b']));
    expect(flagKeyOf('v1', ['a'])).not.toBe(flagKeyOf('v1', ['a', 'b']));
    expect(flagKeyOf('v1', ['a'])).not.toBe(flagKeyOf('v2', ['a']));
  });

  it('writes copy that passes the admin notification rule and names no customer, amount or id', () => {
    for (const def of Object.values(KINDS)) {
      const composed = composeAdminAlert({
        area: 'Billing', action: def.action, why: def.why, severity: 'needs-you', link: '/admin/timetracking?tab=payroll',
        subject: { type: 'visit', id: 'v1' }, doneWhen: def.doneWhen, who: 'person',
      });
      expect(`${composed.headline} ${composed.why}`).not.toMatch(/\$|[0-9a-f]{8}-/);
    }
  });

  it('raises nothing while the share gate is off, and one bell for each flag while it is on', async () => {
    const old = process.env.GATE_PAYROLL_PRODUCTION_SHARE;
    const raise = jest.fn().mockResolvedValue({ id: 'n1' });
    try {
      process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'false';
      expect(await raiseRefundFlagAlerts(week, { raise })).toBe(0);
      process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
      expect(await raiseRefundFlagAlerts(week, { raise })).toBe(2);
      expect(raise).toHaveBeenCalledTimes(2);
      expect(raise.mock.calls[0][2]).toMatchObject({ dedupeKey: expect.stringMatching(/^production-share-refund:own:[0-9a-f]{20}$/) });
      expect(raise.mock.calls[1][2]).toMatchObject({ dedupeKey: expect.stringMatching(/^production-share-refund:paid:[0-9a-f]{20}$/) });
    } finally {
      if (old === undefined) delete process.env.GATE_PAYROLL_PRODUCTION_SHARE; else process.env.GATE_PAYROLL_PRODUCTION_SHARE = old;
    }
  });

  it('never throws when the bell fails', async () => {
    const old = process.env.GATE_PAYROLL_PRODUCTION_SHARE;
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
    try {
      expect(await raiseRefundFlagAlerts(week, { raise: jest.fn().mockRejectedValue(new Error('down')) })).toBe(0);
    } finally {
      if (old === undefined) delete process.env.GATE_PAYROLL_PRODUCTION_SHARE; else process.env.GATE_PAYROLL_PRODUCTION_SHARE = old;
    }
  });
});

describe('what a check shows of its refunds', () => {
  const snapshot = {
    creditedCents: 100, barCents: 0, aboveBarCents: 100, rateBps: 1500, barType: 'per_shift', shifts: 1, stops: [],
    takeBacks: [{ sourceCheckId: 'c', visitId: 'v', cents: 0, dependsOnRuns: [] }, { sourceCheckId: 'c', visitId: 'w', cents: -300, dependsOnRuns: [] }],
    refundTakeBackCents: -300, takeBackToSet: [{ checkId: 'c', visitId: 'x', creditCents: 5, newSignals: ['a'] }],
  };

  it('counts take-backs that moved credit (a 0 entry only keeps a dependency), the net, and the stops to set', () => {
    const view = payShare.viewOf({ production_share_cents: 0, production_share: snapshot });
    expect(view.productionShare).toMatchObject({ refundTakeBackCents: -300, takeBackCount: 1, takeBackToSetCount: 1 });
  });

  it('says nothing extra for a check with no refunds', () => {
    const view = payShare.viewOf({ production_share_cents: 0, production_share: { ...snapshot, takeBacks: undefined, takeBackToSet: undefined } });
    expect(view.productionShare).not.toHaveProperty('refundTakeBackCents');
    expect(view.productionShare).not.toHaveProperty('takeBackToSetCount');
  });

  it('writes a plain draft note for paid stops with a new refund', () => {
    expect(payShare.takeBackNote('Sample Alpha', 0)).toBeNull();
    expect(payShare.takeBackNote('Sample Alpha', 1)).toMatch(/^Sample Alpha: 1 paid stop has a new or changed refund\./);
    expect(payShare.takeBackNote('Sample Alpha', 2)).toMatch(/2 paid stops have a new or changed refund\..*each/);
  });
});

describe('the review token takes the invoices a paid stop froze', () => {
  const settings = { id: 1, rateBps: 1500, barType: 'per_shift', barCents: 10000, callbackStopValueCents: 9500 };
  const stop = (patch) => ({ visitId: 'v1', workDate: '2026-09-14', kind: 'priced', creditCents: 50000, needsReview: false, refundSignals: [], ...patch });
  const inputsOf = (rows) => new Map([['t1', { settings, stops: rows, takeBackOwed: [], takeBackToSet: [], takeBackAnswers: [] }]]);

  it('changes the revision with the sorted refundInvoices of a positive-credit stop, whatever their order', () => {
    const a = payShare.revisionOf(inputsOf([stop({ refundInvoices: ['i-1', 'i-2'] })]));
    expect(payShare.revisionOf(inputsOf([stop({ refundInvoices: ['i-2', 'i-1'] })]))).toBe(a);
    expect(payShare.revisionOf(inputsOf([stop({ refundInvoices: ['i-1', 'i-3'] })]))).not.toBe(a);
    // A $0 stop never freezes them, so they do not move its revision.
    expect(payShare.revisionOf(inputsOf([stop({ creditCents: 0, refundInvoices: ['i-1'] })]))).toBe(payShare.revisionOf(inputsOf([stop({ creditCents: 0 })])));
  });

  it('changes the signature of a stored check with them too', () => {
    const snapshot = (refundInvoices) => ({ settingsId: 1, rateBps: 1500, barType: 'per_shift', barPerUnitCents: 10000, shifts: 1, creditedCents: 50000, barCents: 10000,
      aboveBarCents: 40000, shareCents: 6000, stops: [{ visitId: 'v1', workDate: '2026-09-14', kind: 'priced', creditCents: 50000, needsReview: false, refundInvoices }] });
    const sig = (refundInvoices) => payShare.signature({ production_share_cents: 6000, production_share: snapshot(refundInvoices) });
    expect(sig(['i-1', 'i-2'])).toEqual(sig(['i-2', 'i-1']));
    expect(sig(['i-1', 'i-2'])).not.toEqual(sig(['i-1', 'i-3']));
  });

  it('changes the revision and the signature with a changed answer state of a paid stop (reason, previous total)', () => {
    const toSet = (patch) => ({ checkId: 'c', visitId: 'v9', paidWeekStart: '2026-09-07', creditCents: 100, newSignals: ['a'], ...patch });
    const rev = (one) => payShare.revisionOf(new Map([['t1', { settings, stops: [], takeBackOwed: [], takeBackToSet: [one], takeBackAnswers: [] }]]));
    expect(rev(toSet({ reason: 'new', previousCents: null }))).not.toBe(rev(toSet({ reason: 'changed', previousCents: 300 })));
  });
});

describe('historical lookups bind one array, never a parameter for each id', () => {
  const fs = require('fs');
  const path = require('path');

  it('the refund reads use = ANY(?::uuid[]) for every list that grows with history', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/production-share-refunds.js'), 'utf8')
      .split('\n').filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line)).join('\n');
    // whereIn is allowed only for the fixed status lists.
    const lists = [...source.matchAll(/whereIn\('([^']+)'/g)].map((match) => match[1]);
    expect(lists.filter((column) => column !== 'status')).toEqual([]);
    expect(source).toMatch(/id = ANY\(\?::uuid\[\]\)/);
  });
});

describe('a paid-stop prompt is keyed by its signal revision', () => {
  const settings = { id: 1, rateBps: 1500, barType: 'per_shift', barCents: 10000, callbackStopValueCents: 9500 };
  const toSet = (signalRevision) => ({ checkId: 'c', visitId: 'v9', paidWeekStart: '2026-09-07', creditCents: 100, newSignals: [], reason: 'changed', previousCents: 300, signalRevision });
  const revision = (one) => payShare.revisionOf(new Map([['t1', { settings, stops: [], takeBackOwed: [], takeBackToSet: [one], takeBackAnswers: [] }]]));

  it('changes the revision and the stored signature when only the signal revision differs', () => {
    expect(revision(toSet('r1'))).not.toBe(revision(toSet('r2')));
    const snapshot = (one) => ({ settingsId: 1, rateBps: 1500, barType: 'per_shift', barPerUnitCents: 10000, shifts: 0, creditedCents: 0, barCents: 0, aboveBarCents: 0, shareCents: 0, stops: [], takeBackToSet: [one] });
    const sig = (one) => payShare.signature({ production_share_cents: 0, production_share: snapshot(one) });
    expect(sig(toSet('r1'))).not.toEqual(sig(toSet('r2')));
  });

  it('keys the paid-stop bell by it, so each new state rings once', () => {
    const key = (rev) => flagsOf({ takeBackToSet: [{ ...toSet(rev), answerRevision: '7:t' }] })[0].signals;
    expect(key('r1')).not.toEqual(key('r2'));
    expect(flagKeyOf('v9', key('r1'))).toBe(flagKeyOf('v9', key('r1')));
  });
});
