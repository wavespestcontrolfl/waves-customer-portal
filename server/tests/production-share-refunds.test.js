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
    expect(result).toMatchObject({ creditedCents: 0, refundTakeBackCents: 50000 });
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
    expect(applyTakeBacks(stops(100, 200), [])).toEqual({ takeBacks: [], refundTakeBackCents: 0, creditedCents: 300 });
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
      { kind: 'own', visitId: 'v1', signals: ['pay:x:100'] },
      { kind: 'paid', visitId: 'v3', signals: ['orphan:y', 'pay:x:100'] },
    ]);
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
    expect(payShare.takeBackNote('Sample Alpha', 1)).toMatch(/^Sample Alpha: 1 paid stop has a new refund\./);
    expect(payShare.takeBackNote('Sample Alpha', 2)).toMatch(/2 paid stops have a new refund\..*each/);
  });
});
