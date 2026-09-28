// tech-open-visit-nudge.js — the 7 PM "you still have open visits from
// today" text (owner ask 2026-09-28). Covers the gate short-circuit, the
// query's status/date scoping, per-technician grouping and message shape,
// eligibility/phone skips, the durable per-tech/per-day dedupe claim, and
// the internal-alert recipient override.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(), isKnownOwnerPhone: jest.fn(() => false) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUser: jest.fn() }));

const db = require('../models/db');
const TwilioService = require('../services/twilio');
const PushService = require('../services/push-notifications');
const logger = require('../services/logger');
const { runTechOpenVisitNudge, _test } = require('../services/tech-open-visit-nudge');

const GATE = 'GATE_TECH_OPEN_VISIT_NUDGE';

function chain(overrides = {}) {
  const c = {
    join: jest.fn(() => c),
    leftJoin: jest.fn(() => c),
    where: jest.fn(() => c),
    whereIn: jest.fn(() => c),
    whereNotNull: jest.fn(() => c),
    whereNull: jest.fn(() => c),
    whereBetween: jest.fn(() => c),
    orderBy: jest.fn(() => c),
    select: jest.fn().mockResolvedValue([]),
    insert: jest.fn(() => c),
    onConflict: jest.fn(() => c),
    ignore: jest.fn(() => c),
    returning: jest.fn().mockResolvedValue(['new-id']),
    update: jest.fn().mockResolvedValue(1),
  };
  Object.assign(c, overrides);
  return c;
}

// One open visit row shaped exactly like the service's own select().
function visitRow({
  id, techId, techName = 'Tech', employmentStatus = 'active', fieldDispatchable = true,
  techPhone = '941-555-0101', windowStart = '09:00:00', serviceType = 'Pest Control',
  custFirst = 'Ana', custLast = 'Ruiz', status = 'on_site',
}) {
  return {
    visit_id: id,
    status,
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
  TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'SM123', deliveryOutcome: 'accepted' });
  // Fixture techs are the owner (texted) unless a test says otherwise.
  TwilioService.isKnownOwnerPhone.mockReturnValue(true);
  PushService.sendToAdminUser.mockResolvedValue({ sent: 0 });
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
      // Active + field-dispatchable, no phone on file → not the owner, so it
      // gets the tech-home card (+ push) instead of a text.
      visitRow({ id: 'v4', techId: 'tech-c', techName: 'No Phone Tech', techPhone: null, custFirst: 'Dee', custLast: 'Earl' }),
    ];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') return chain();
      return chain();
    });

    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });

    expect(r).toEqual({ status: 'ok', techs: 3, sent: 2, skipped: 1, visits: 4 });
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe('+19415550101');
    expect(body).toContain('Waves: 2 visits from today are still open');
    expect(body).toContain('Ana R.');
    expect(body).toContain('Ben C.');
    expect(PushService.sendToAdminUser).toHaveBeenCalledWith('tech-c', expect.any(Object));
  });

  test('the owner text is internal_alert + allowOwnerSms, with no unknown-recipient override', async () => {
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
      expect.objectContaining({ messageType: 'internal_alert', allowOwnerSms: true }),
    );
    expect(TwilioService.sendSMS.mock.calls[0][2]).not.toHaveProperty('allowUnknownInternalAlertRecipient');
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

  test('a never-started visit is listed but marked "(not started)"; a started one is not', async () => {
    const rows = [
      visitRow({ id: 'v1', techId: 'tech-a', custFirst: 'Ana', custLast: 'Ruiz', status: 'on_site', windowStart: '09:00:00' }),
      visitRow({ id: 'v2', techId: 'tech-a', custFirst: 'Bo', custLast: 'Lee', status: 'confirmed', windowStart: '11:00:00' }),
    ];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    const lines = TwilioService.sendSMS.mock.calls[0][1].split('\n');
    expect(lines[0]).toContain('Tap to close out:');
    expect(lines[1]).toBe('9:00 AM - Ana R. - Pest Control');
    expect(lines[2]).toBe('11:00 AM - Bo L. - Pest Control (not started)');
  });

  test('a visit whose window starts after the send time (an evening stop) is left out; no window is kept', async () => {
    let visitsChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') { visitsChain = chain(); return visitsChain; }
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') }); // 7:00 PM EDT
    const windowFilter = visitsChain.where.mock.calls.map((c) => c[0]).find((a) => typeof a === 'function');
    expect(windowFilter).toBeDefined();
    const q = { whereNull: jest.fn(() => q), orWhere: jest.fn(() => q) };
    windowFilter(q);
    expect(q.whereNull).toHaveBeenCalledWith('s.window_start');
    expect(q.orWhere).toHaveBeenCalledWith('s.window_start', '<=', '19:00');
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

  test('a definite Twilio refusal is counted as skipped and gives the day\'s slot back', async () => {
    TwilioService.sendSMS.mockResolvedValue({ success: false, error: 'blocked' });
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    const notifChains = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toEqual({ status: 'ok', techs: 1, sent: 0, skipped: 1, visits: 1 });
    // Nothing went out, so the claim is released and a re-run can retry.
    const release = notifChains.find((c) => c.del.mock.calls.length);
    expect(release).toBeDefined();
    expect(release.where).toHaveBeenCalledWith({ dedupe_key: 'tech_open_visit_nudge:tech-a:2026-09-28', type: 'tech_open_visit_nudge' });
  });

  test('a thrown send keeps the claim — the text may be out, so no second copy', async () => {
    TwilioService.sendSMS.mockRejectedValue(new Error('socket hang up'));
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    const notifChains = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toEqual({ status: 'ok', techs: 1, sent: 0, skipped: 1, visits: 1 });
    expect(notifChains.every((c) => c.del.mock.calls.length === 0)).toBe(true);
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

describe('recipient, absence, and failure outcomes (Codex r1)', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });
  afterEach(() => { delete process.env.ADAM_PHONE; });

  test("the owner's office-line tech phone is swapped for the owner's own cell", async () => {
    // Waves-owned office line on the owner's technicians row (usableCell refuses it).
    const officeLine = '+19413187612';
    process.env.ADAM_PHONE = '941-555-0199';
    TwilioService.isKnownOwnerPhone.mockImplementation((p) => String(p).replace(/\D/g, '').endsWith('9413187612'));
    const rows = [visitRow({ id: 'v1', techId: 'tech-owner', techPhone: officeLine })];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r.sent).toBe(1);
    expect(TwilioService.sendSMS).toHaveBeenCalledWith('+19415550199', expect.any(String), expect.objectContaining({ allowOwnerSms: true }));
    expect(TwilioService.sendSMS.mock.calls[0][0]).not.toBe(officeLine);
  });

  test('any tech who is not the owner gets a tech-home card + push, never a text (keeps staff out of customer threads)', async () => {
    TwilioService.isKnownOwnerPhone.mockReturnValue(false);
    PushService.sendToAdminUser.mockResolvedValue({ sent: 1 });
    const rows = [visitRow({ id: 'v1', techId: 'tech-b', techPhone: '941-555-0144' })];
    const notifChains = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') { const c = chain(); notifChains.push(c); return c; }
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toMatchObject({ sent: 1, skipped: 0 });
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    // The marker row is published as a visible card with the live list.
    const card = notifChains.find((c) => c.update.mock.calls.length);
    expect(card.update).toHaveBeenCalledWith(expect.objectContaining({
      read: false, dismissed_at: null, message: expect.stringContaining('1 visit from today still open.'),
    }));
    expect(PushService.sendToAdminUser).toHaveBeenCalledWith('tech-b', expect.objectContaining({
      title: '1 visit from today still open', url: '/tech',
    }));
  });

  test('a push that reaches no device still leaves the card — counted as sent, slot kept', async () => {
    TwilioService.isKnownOwnerPhone.mockReturnValue(false);
    PushService.sendToAdminUser.mockResolvedValue({ sent: 0 });
    const rows = [visitRow({ id: 'v1', techId: 'tech-b', techPhone: '941-555-0144' })];
    const notifChains = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toMatchObject({ sent: 1, skipped: 0 });
    expect(notifChains.every((c) => c.del.mock.calls.length === 0)).toBe(true);
  });

  test('members of one visit group are ONE stop: one line, services joined, count by stop', async () => {
    const rows = [
      { ...visitRow({ id: 'v1', techId: 'tech-a', custFirst: 'Ana', custLast: 'Ruiz', serviceType: 'Pest Control', windowStart: '09:00:00', status: 'confirmed' }), stop_id: 'grp-1' },
      { ...visitRow({ id: 'v2', techId: 'tech-a', custFirst: 'Ana', custLast: 'Ruiz', serviceType: 'Lawn Care', windowStart: '09:00:00', status: 'on_site' }), stop_id: 'grp-1' },
      visitRow({ id: 'v3', techId: 'tech-a', custFirst: 'Bo', custLast: 'Lee', windowStart: '11:00:00' }),
    ];
    let notifChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') { notifChain = chain(); return notifChain; }
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    const lines = TwilioService.sendSMS.mock.calls[0][1].split('\n');
    expect(lines[0]).toContain('Waves: 2 visits from today are still open');
    // One member started → the stop is started (no "(not started)").
    expect(lines[1]).toBe('9:00 AM - Ana R. - Pest Control + Lawn Care');
    expect(lines).toHaveLength(3);
    const payload = JSON.parse(notifChain.insert.mock.calls[0][0].payload);
    expect(payload.visit_ids).toEqual(['v1', 'v2', 'v3']);
    expect(payload.count).toBe(2);
  });

  test('a failed claim insert logs an error tag, never err.message (it can carry customer names)', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a', custFirst: 'Alexandra', custLast: 'Winterbottom' })];
    const dbErr = Object.assign(new Error('insert into "tech_notifications" ... Alexandra W. - duplicate'), { code: '23502' });
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') return chain({ returning: jest.fn().mockRejectedValue(dbErr) });
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.info.mock.calls].map((c) => String(c[0])).join('\n');
    expect(logged).toContain('23502');
    expect(logged).not.toContain('Alexandra');
  });

  test('a tech marked out today (checked at the send boundary) gets nothing and the slot goes back', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    const notifChains = [];
    let absenceChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'technician_absences') {
        absenceChain = chain({ select: jest.fn().mockResolvedValue([{ technician_id: 'tech-a', absence_date: '2026-09-28' }]) });
        return absenceChain;
      }
      if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(PushService.sendToAdminUser).not.toHaveBeenCalled();
    expect(notifChains.some((c) => c.del.mock.calls.length > 0)).toBe(true);
    expect(absenceChain.whereIn).toHaveBeenCalledWith('technician_id', ['tech-a']);
  });

  test('a thrown send marked not_sent releases the claim; an uncertain result keeps it', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    const run = async () => {
      const chains = [];
      db.mockImplementation((table) => {
        if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
        if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); chains.push(c); return c; }
        return chain();
      });
      await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
      return chains.some((c) => c.del.mock.calls.length > 0);
    };

    const rejected = Object.assign(new Error('Failed to send SMS: 21211'), { providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } });
    TwilioService.sendSMS.mockRejectedValueOnce(rejected);
    expect(await run()).toBe(true);

    TwilioService.sendSMS.mockResolvedValueOnce({ success: false, deliveryOutcome: 'uncertain', error: 'timeout' });
    expect(await run()).toBe(false);
  });
});

describe('send boundary and GSM-7 (Codex r1 comment)', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('the text is GSM-7 only — no middle dot or em dash forcing UCS-2', async () => {
    const rows = [visitRow({ id: 'v1', techId: 'tech-a', windowStart: null })];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    const body = TwilioService.sendSMS.mock.calls[0][1];
    expect(body).not.toMatch(/[·—–]/);
    expect(body).toContain('No time - Ana R. - Pest Control');
  });

  test.each([
    ['OWNER_SMS_DISABLED', { success: true, sid: 'owner-sms-disabled', suppressed: true }],
    ['the SMS gate off', { success: true, sid: 'gate-blocked', gateBlocked: true }],
    ['a disabled template', { success: true, sid: 'template-disabled', templateDisabled: true }],
  ])('a success:true sentinel from %s gives the slot back and is not counted as sent', async (_label, sentinel) => {
    TwilioService.sendSMS.mockResolvedValue(sentinel);
    const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
    const notifChains = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
      if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(notifChains.some((c) => c.del.mock.calls.length > 0)).toBe(true);
  });

  test('re-read at send time: a stop closed after the sweep is dropped from the text', async () => {
    const sweep = [
      visitRow({ id: 'v1', techId: 'tech-a', custFirst: 'Ana', custLast: 'Ruiz', windowStart: '09:00:00' }),
      visitRow({ id: 'v2', techId: 'tech-a', custFirst: 'Bo', custLast: 'Lee', windowStart: '11:00:00' }),
    ];
    const atSend = [sweep[1]]; // v1 completed between the sweep and the send
    let reads = 0;
    const visitChains = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') {
        reads += 1;
        const c = chain({ select: jest.fn().mockResolvedValue(reads === 1 ? sweep : atSend) });
        visitChains.push(c);
        return c;
      }
      return chain();
    });
    await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    const body = TwilioService.sendSMS.mock.calls[0][1];
    expect(body).toContain('Waves: 1 visit from today are still open');
    expect(body).toContain('Bo L.');
    expect(body).not.toContain('Ana R.');
    // The send-time read is scoped to this technician.
    expect(visitChains[1].where).toHaveBeenCalledWith('s.technician_id', 'tech-a');
  });

  test('re-read at send time: nothing left open → no text, slot given back', async () => {
    const sweep = [visitRow({ id: 'v1', techId: 'tech-a' })];
    let reads = 0;
    const notifChains = [];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') {
        reads += 1;
        return chain({ select: jest.fn().mockResolvedValue(reads === 1 ? sweep : []) });
      }
      if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
      return chain();
    });
    const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(notifChains.some((c) => c.del.mock.calls.length > 0)).toBe(true);
  });
});

test('a push-routed delivery (the routing layer delivered in-app) counts as sent and keeps the slot', async () => {
  process.env[GATE] = 'true';
  TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'push-1', pushRouted: true });
  const rows = [visitRow({ id: 'v1', techId: 'tech-a' })];
  const notifChains = [];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as s') return chain({ select: jest.fn().mockResolvedValue(rows) });
    if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
    return chain();
  });
  const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
  expect(r).toMatchObject({ sent: 1, skipped: 0 });
  expect(notifChains.every((c) => c.del.mock.calls.length === 0)).toBe(true);
});

test('an uncommitted slot hold (no customer + reservation stamp) is filtered out in SQL', async () => {
  process.env[GATE] = 'true';
  let visitsChain;
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as s') { visitsChain = chain(); return visitsChain; }
    return chain();
  });
  await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
  const fns = visitsChain.where.mock.calls.map((c) => c[0]).filter((a) => typeof a === 'function');
  const probes = fns.map((fn) => {
    const q = { whereNull: jest.fn(() => q), orWhere: jest.fn(() => q), whereNotNull: jest.fn(() => q), orWhereNull: jest.fn(() => q) };
    fn(q);
    return q;
  });
  const hold = probes.find((q) => q.whereNotNull.mock.calls.length);
  expect(hold.whereNotNull).toHaveBeenCalledWith('s.customer_id');
  expect(hold.orWhereNull).toHaveBeenCalledWith('s.reservation_expires_at');
});

test('a failed send-time re-read for one tech releases its claim and the run carries on for the next', async () => {
  process.env[GATE] = 'true';
  const sweep = [
    visitRow({ id: 'v1', techId: 'tech-a', custFirst: 'Ana', custLast: 'Ruiz' }),
    visitRow({ id: 'v2', techId: 'tech-b', custFirst: 'Bo', custLast: 'Lee', techPhone: '941-555-0102' }),
  ];
  let reads = 0;
  const notifChains = [];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as s') {
      reads += 1;
      if (reads === 2) return chain({ select: jest.fn().mockRejectedValue(Object.assign(new Error('pool timeout'), { code: 'ETIMEDOUT' })) });
      return chain({ select: jest.fn().mockResolvedValue(sweep) });
    }
    if (table === 'tech_notifications') { const c = chain({ del: jest.fn().mockResolvedValue(1) }); notifChains.push(c); return c; }
    return chain();
  });
  const r = await runTechOpenVisitNudge({ now: new Date('2026-09-28T23:00:00Z') });
  expect(r).toMatchObject({ sent: 1, skipped: 1 });
  expect(notifChains.some((c) => c.del.mock.calls.length > 0)).toBe(true);
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
});
