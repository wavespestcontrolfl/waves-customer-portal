jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({}));

const db = require('../models/db');
const renewalReminder = require('../services/workflows/renewal-reminder');

// OWNER RULING (2026-07-13): "renewal" language is reserved for termite
// bonds — the only service with a real fixed term. This test pins the cron
// to that ruling so a WaveGuard/mosquito leg can't quietly come back.
describe('renewal reminders are termite-bond-only', () => {
  test('checkAndSend queries only termite_renewal_date', async () => {
    const columnsQueried = [];
    db.mockImplementation(() => {
      const q = {
        whereNotNull: jest.fn((col) => { columnsQueried.push(col); return q; }),
        whereRaw: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        where: jest.fn(() => q),
        select: jest.fn(async () => []),
        first: jest.fn(async () => undefined),
      };
      return q;
    });

    const out = await renewalReminder.checkAndSend();
    expect(out).toEqual({ sent: 0 });
    expect(columnsQueried.length).toBeGreaterThan(0);
    expect([...new Set(columnsQueried)]).toEqual(['termite_renewal_date']);
    expect(columnsQueried).not.toContain('waveguard_renewal_date');
    expect(columnsQueried).not.toContain('mosquito_season_start');
  });
});

// Codex #4971 r8 P2: the termite renewal leg logs whenever the sweep did ANY
// action — every non-scan counter the sweep returns, never a hand-picked
// subset — and the log line carries every counter.
describe('termite renewal leg activity keys', () => {
  const { TERMITE_RENEWAL_ACTIVITY_KEYS, runTermiteRenewalChargeLeg } = renewalReminder._private;
  const logger = require('../services/logger');
  const Charge = require('../services/termite-annual-renewal-charge');
  let sweepSpy;
  const savedGate = process.env.GATE_TERMITE_ANNUAL_PLAN;
  afterEach(() => {
    if (sweepSpy) sweepSpy.mockRestore();
    sweepSpy = null;
    if (savedGate === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    else process.env.GATE_TERMITE_ANNUAL_PLAN = savedGate;
  });

  async function sweepCounters() {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN; // gate off: the sweep returns its zeroed counts object untouched
    const counts = await Charge.runTermiteAnnualRenewalSweep();
    expect(counts.gate).toBe('off');
    return Object.keys(counts).filter((key) => typeof counts[key] === 'number');
  }

  test('every action counter the sweep returns (all but *Scanned) is an activity key, and nothing else is', async () => {
    const numeric = await sweepCounters();
    const actions = numeric.filter((key) => !key.endsWith('Scanned'));
    expect([...TERMITE_RENEWAL_ACTIVITY_KEYS].sort()).toEqual([...actions].sort());
  });

  test.each(['withdrawn', 'latePaidBelled', 'reconcilePendingOutcomeResolved', 'reconcileSkipped'])(
    'a run whose only work is %s logs every counter', async (key) => {
      const numeric = await sweepCounters();
      const zeroed = Object.fromEntries(numeric.map((k) => [k, 0]));
      sweepSpy = jest.spyOn(Charge, 'runTermiteAnnualRenewalSweep').mockResolvedValue({ ...zeroed, [key]: 1, gate: 'on' });
      logger.info.mockClear();
      await runTermiteRenewalChargeLeg();
      expect(logger.info).toHaveBeenCalledTimes(1);
      const [line] = logger.info.mock.calls[0];
      expect(line).toContain(`${key}=1`);
      for (const k of numeric) expect(line).toContain(`${k}=`);
    },
  );

  test('a quiet night (scans only) logs nothing', async () => {
    const numeric = await sweepCounters();
    const scansOnly = Object.fromEntries(numeric.map((k) => [k, k.endsWith('Scanned') ? 5 : 0]));
    sweepSpy = jest.spyOn(Charge, 'runTermiteAnnualRenewalSweep').mockResolvedValue({ ...scansOnly, gate: 'on' });
    logger.info.mockClear();
    await runTermiteRenewalChargeLeg();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
