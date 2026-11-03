/**
 * Rain-unknown bells for the weekly watering sweep (2026-11-02: one of 45 customers got no
 * email because the rain at the home was unknown, and nothing told the office). The real
 * composer runs, so every bell is checked against docs/admin-notifications.md; the writes
 * (notifyAdmin, the episode close) are stand-ins.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1', deduped: false })) }));
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async (_conn, keys) => keys.length),
}));
jest.mock('../models/db', () => jest.fn());

const NotificationService = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const { settleRainUnknownAlerts, _test } = require('../services/irrigation-rain-unknown-alert');

// A knex stand-in for the two reads: the name (customers .where({ id }).first()) and the
// week's sent emails (email_messages .whereIn(trigger_event_id).whereIn(status).select()).
function connWithNames(names, emailed = []) {
  return jest.fn((table) => {
    let id = null;
    let triggers = [];
    const q = {
      where: ({ id: wanted }) => { id = wanted; return q; },
      first: async () => names[id] || null,
      whereIn: (col, values) => { if (col === 'trigger_event_id') triggers = values; return q; },
      select: async () => emailed.filter((t) => triggers.includes(t)).map((t) => ({ trigger_event_id: t })),
    };
    expect(['customers', 'email_messages']).toContain(table);
    return q;
  });
}

describe('settleRainUnknownAlerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps a mockResolvedValue: start each test with no open bells.
    episodes.openAdminAlertKeys.mockResolvedValue([]);
  });

  test('one needs-you bell per skipped customer: the name leads, the link opens the customer, one key per week', async () => {
    const conn = connWithNames({ 'cust-1': { first_name: 'Dana', last_name: 'Reyes' } });
    const out = await settleRainUnknownAlerts({ rainUnknownCustomerIds: ['cust-1', 'cust-1'], weekEnding: '2026-11-01', conn });
    expect(out).toEqual({ closed: 0, raised: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(headline).toBe("Comms — decide on Dana Reyes's missed watering email");
    expect(why).toBe(_test.WHY);
    expect(opts).toMatchObject({
      bell: true,
      link: '/admin/customers?customerId=cust-1',
      dedupeKey: 'irrigation-rain-unknown:cust-1:2026-11-01',
      metadata: {
        customerId: 'cust-1',
        weekEnding: '2026-11-01',
        severity: 'needs-you',
        who: 'person',
        doneWhen: 'irrigation_email_sent',
        subject: { type: 'customer', id: 'cust-1' },
      },
    });
  });

  test('a customer emailed this run closes only their own open bells', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue([
      'irrigation-rain-unknown:cust-1:2026-10-26',
      'irrigation-rain-unknown:cust-1:2026-11-01',
      'irrigation-rain-unknown:cust-2:2026-11-01',
    ]);
    const conn = connWithNames({});
    const out = await settleRainUnknownAlerts({ sentCustomerIds: new Set(['cust-1', 'cust-3']), weekEnding: '2026-11-08', conn });
    expect(out).toEqual({ closed: 2, raised: 0 });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(conn, 'irrigation-rain-unknown:');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, [
      'irrigation-rain-unknown:cust-1:2026-10-26',
      'irrigation-rain-unknown:cust-1:2026-11-01',
    ], 'irrigation_email_sent', expect.objectContaining({ resolution: expect.any(String) }));
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('nothing open and nothing skipped writes nothing', async () => {
    expect(await settleRainUnknownAlerts({ weekEnding: '2026-11-01', conn: connWithNames({}) })).toEqual({ closed: 0, raised: 0 });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a re-run inside the week: a customer whose email already went out gets no bell', async () => {
    // Emailed at the first run; the re-run found the rain unknown.
    const conn = connWithNames({ 'cust-1': { first_name: 'Dana', last_name: 'Reyes' }, 'cust-2': { first_name: 'Sam', last_name: 'Ortiz' } },
      ['irrigation.weekly:cust-1:2026-11-01']);
    const out = await settleRainUnknownAlerts({ rainUnknownCustomerIds: ['cust-1', 'cust-2'], weekEnding: '2026-11-01', conn });
    expect(out).toEqual({ closed: 0, raised: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toBe('irrigation-rain-unknown:cust-2:2026-11-01');
  });

  test('an open bell closes once its own week\'s email is found sent, even when this run sent nothing', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['irrigation-rain-unknown:cust-1:2026-11-01', 'irrigation-rain-unknown:cust-2:2026-11-01']);
    const conn = connWithNames({}, ['irrigation.weekly:cust-1:2026-11-01']);
    expect(await settleRainUnknownAlerts({ weekEnding: '2026-11-01', conn })).toEqual({ closed: 1, raised: 0 });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['irrigation-rain-unknown:cust-1:2026-11-01'], 'irrigation_email_sent', expect.any(Object));
  });

  test('a failed close or a failed bell never throws, and the other bells still go out', async () => {
    episodes.openAdminAlertKeys.mockRejectedValueOnce(new Error('db down'));
    NotificationService.notifyAdmin.mockRejectedValueOnce(new Error('insert failed'));
    const conn = connWithNames({ a: { first_name: 'Ann', last_name: 'Lee' }, b: { first_name: 'Bo', last_name: 'Diaz' } });
    const out = await settleRainUnknownAlerts({ sentCustomerIds: ['c'], rainUnknownCustomerIds: ['a', 'b'], weekEnding: '2026-11-01', conn });
    expect(out).toEqual({ closed: 0, raised: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2);
  });

  test('a name the alert rules refuse falls back to the first word, then to no name; a long name is cut to fit', () => {
    expect(_test.actionFor('Dana Reyes')).toBe("decide on Dana Reyes's missed watering email");
    expect(_test.actionFor('Ann [dup] Smith')).toBe("decide on Ann's missed watering email");
    expect(_test.actionFor('')).toBe('decide on a missed watering email');
    const long = _test.actionFor('Maximiliana Bartholomew-Featherstonehaugh');
    expect(`Comms — ${long}`.length).toBeLessThanOrEqual(60);
  });
});
