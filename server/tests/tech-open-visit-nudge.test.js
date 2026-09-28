// tech-open-visit-nudge.js — the 7 PM "you still have open visits from
// today" text (owner ask 2026-09-28). Covers the gate short-circuit, the
// query's status/date scoping, per-technician grouping and message shape,
// eligibility/phone skips, the durable per-tech/per-day dedupe claim, and
// the internal-alert recipient override.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));

const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { runTechOpenVisitNudge, _test } = require('../services/tech-open-visit-nudge');

const GATE = 'GATE_TECH_OPEN_VISIT_NUDGE';

function chain(overrides = {}) {
  const c = {
    join: jest.fn(() => c),
    leftJoin: jest.fn(() => c),
    where: jest.fn(() => c),
    whereIn: jest.fn(() => c),
    whereNotNull: jest.fn(() => c),
    orderBy: jest.fn(() => c),
    select: jest.fn().mockResolvedValue([]),
    insert: jest.fn(() => c),
    onConflict: jest.fn(() => c),
    ignore: jest.fn(() => c),
    returning: jest.fn().mockResolvedValue(['new-id']),
  };
  Object.assign(c, overrides);
  return c;
}

// One open visit row shaped exactly like the service's own select().
function visitRow({
  id, techId, techName = 'Tech', employmentStatus = 'active', fieldDispatchable = true,
  techPhone = '941-555-0101', windowStart = '09:00:00', serviceType = 'Pest Control',
  custFirst = 'Ana', custLast = 'Ruiz',
}) {
  return {
    visit_id: id,
    window_start: windowStart,
    service_type: serviceType,
    technician_id: techId,
    tech_name: techName,
    employment_status: employmentStatus,
    field_dispatchable: fieldDispatchable,
    tech_phone: techPhone,
    cust_first_name: custFirst,
    cust_last_name: custLast,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[GATE];
  TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'SM123' });
});

describe('gate', () => {
  test('off (unset) → gate_off, no db call at all', async () => {
    const r = await runTechOpenVisitNudge();
    expect(r).toEqual({ status: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('a loose truthy value ("1") does NOT enable it — strict "true" only', async () => {
    process.env[GATE] = '1';
    const r = await runTechOpenVisitNudge();
    expect(r).toEqual({ status: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('exactly "true" enables it', async () => {
    process.env[GATE] = 'true';
    db.mockImplementation(() => chain());
    const r = await runTechOpenVisitNudge();
    expect(r.status).toBe('ok');
  });
});

describe('query scoping', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('scopes to today\'s ET calendar date and the open-status allowlist', async () => {
    let visitChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') { visitChain = chain(); return visitChain; }
      return chain();
    });
    // 11:30 PM UTC on 2026-09-28 is 7:30 PM ET the same day — not a UTC
    // date-boundary edge case yet.
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:30:00Z') });
    expect(visitChain.where).toHaveBeenCalledWith('s.scheduled_date', '2026-09-28');
    expect(visitChain.whereIn).toHaveBeenCalledWith('s.status', ['pending', 'confirmed', 'en_route', 'on_site']);
    expect(visitChain.whereNotNull).toHaveBeenCalledWith('s.technician_id');
  });

  test('ET date boundary: 2:30 AM UTC is still 10:30 PM ET the PREVIOUS day', async () => {
    let visitChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') { visitChain = chain(); return visitChain; }
      return chain();
    });
    // 2026-09-29T02:30:00Z = 2026-09-28 22:30 America/New_York (EDT, UTC-4).
    await runTechOpenVisitNudge({ now: new Date('2026-09-29T02:30:00Z') });
    expect(visitChain.where).toHaveBeenCalledWith('s.scheduled_date', '2026-09-28');
  });
});

describe('runTechOpenVisitNudge — grouping, eligibility, sends', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('groups multiple visits for one technician into ONE text; unassignable and no-phone techs are skipped without sending', async () => {
    const rows = [
      visitRow({ id: 'v1', techId: 'tech-a', techName: 'Maria Lopez', custFirst: 'Ana', custLast: 'Ruiz', windowStart: '09:00:00' }),
      visitRow({ id: 'v2', techId: 'tech-a', techName: 'Maria Lopez', custFirst: 'Ben', custLast: 'Cole', windowStart: '13:00:00' }),
      // Prospective / not field-dispatchable — never texted.
      visitRow({ id: 'v3', techId: 'tech-b', techName: 'Ex Tech', employmentStatus: 'inactive', custFirst: 'Cy', custLast: 'Dole' }),
      // Active + field-dispatchable but no usable phone on file.
      visitRow({ id: 'v4', techId: 'tech-c', techName: 'No Phone Tech', techPhone: null, custFirst: 'Dee', custLast: 'Earl' }),
    ];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') return chain();
      return chain();
    });

    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });

    expect(r).toEqual({ status: 'ok', techs: 3, sent: 1, skipped: 2, visits: 4 });
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe('+19415550101');
    expect(body).toContain('Waves: 2 visits from today are still open');
    expect(body).toContain('Ana R.');
    expect(body).toContain('Ben C.');
  });

  test('recipient guard: messageType internal_alert + allowUnknownInternalAlertRecipient ONLY for the verified, assignable tech phone', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(TwilioService.sendSMS).toHaveBeenCalledWith(
      '+19415550101',
      expect.any(String),
      // allowOwnerSms: the owner is the only tech, so without it twilio.js
      // turns the text into an admin-bell notice instead of an SMS.
      expect.objectContaining({ messageType: 'internal_alert', allowUnknownInternalAlertRecipient: true, allowOwnerSms: true }),
    );
  });

  test('a tech with no open visits today never appears — no row, no send', async () => {
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue([]) });
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toEqual({ status: 'ok', techs: 0, sent: 0, skipped: 0, visits: 0 });
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('completed/cancelled/other-day visits are excluded by the query itself, not filtered client-side', async () => {
    // The service trusts the DB query's own status/date scoping — assert it
    // asked for exactly the open allowlist (covered above) and does no
    // additional client-side status filtering that could mask a query bug:
    // every row the mock returns is treated as open.
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r.visits).toBe(1);
  });

  test('more than 5 open visits: only 5 listed, then "+N more"', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => visitRow({
      id: `v${i}`, techId: 'tech-a', custFirst: `Cust${i}`, custLast: 'Zz', windowStart: `0${(i % 9) + 1}:00:00`,
    }));
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    const body = TwilioService.sendSMS.mock.calls[0][1];
    const lines = body.split('\n');
    // header + 5 listed + "+2 more"
    expect(lines).toHaveLength(7);
    expect(lines[lines.length - 1]).toBe('+2 more');
    expect(body).toContain('Waves: 7 visits from today are still open');
  });

  test('message never contains a full last name — first name + last initial only', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a', custFirst: 'Alexandra', custLast: 'Winterbottom' })];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    const body = TwilioService.sendSMS.mock.calls[0][1];
    expect(body).toContain('Alexandra W.');
    expect(body).not.toContain('Winterbottom');
  });

  test('a Twilio send failure is logged and counted as skipped, not thrown', async () => {
    TwilioService.sendSMS.mockResolvedValue({ success: false, error: 'blocked' });
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toEqual({ status: 'ok', techs: 1, sent: 0, skipped: 1, visits: 1 });
  });
});

describe('dedupe — one text per technician per ET day', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('claims a dedupe_key row keyed on technician + ET date before sending', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    let notifChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') { notifChain = chain(); return notifChain; }
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(notifChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      technician_id: 'tech-a',
      type: 'tech_open_visit_nudge',
      dedupe_key: 'tech_open_visit_nudge:tech-a:2026-09-28',
      // Born read + dismissed: a send marker, never a tech-home card.
      read: true,
      dismissed_at: expect.any(Date),
    }));
    expect(notifChain.onConflict).toHaveBeenCalledWith('dedupe_key');
    expect(notifChain.ignore).toHaveBeenCalled();
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  });

  test('a second run the same ET day (claim already taken) sends nothing', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      // The unique index already holds this key — onConflict/ignore means
      // the insert returns no id on the second run.
      if (table === 'tech_notifications') return chain({ returning: jest.fn().mockResolvedValue([]) });
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toEqual({ status: 'ok', techs: 1, sent: 0, skipped: 1, visits: 1 });
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});

describe('pure helpers', () => {
  test('customerLabel: first name + last initial, or first-name-only, or "Customer" with neither', () => {
    expect(_test.customerLabel({ customerFirst: 'Ana', customerLast: 'Ruiz' })).toBe('Ana R.');
    expect(_test.customerLabel({ customerFirst: 'Ana', customerLast: '' })).toBe('Ana');
    expect(_test.customerLabel({ customerFirst: '', customerLast: '' })).toBe('Customer');
  });

  test('clock12 formats a TIME column as 12-hour ET clock text', () => {
    expect(_test.clock12('09:00:00')).toBe('9:00 AM');
    expect(_test.clock12('13:05:00')).toBe('1:05 PM');
    expect(_test.clock12('00:00:00')).toBe('12:00 AM');
    expect(_test.clock12(null)).toBeNull();
  });

  test('dedupeKeyFor is stable per technician + ET date', () => {
    expect(_test.dedupeKeyFor('tech-a', '2026-09-28')).toBe('tech_open_visit_nudge:tech-a:2026-09-28');
  });
});
