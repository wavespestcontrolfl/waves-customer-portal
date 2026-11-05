/**
 * services/tech-line.js — the one reader of registry line ↔ technicians.twilio_number.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUser: jest.fn(async () => ({ sent: 1 })) }));

const db = require('../models/db');
const PushService = require('../services/push-notifications');
const techLine = require('../services/tech-line');

const LINE = '+19413529161';
const HOLDER = { id: 'tech-1', name: 'Tech One', phone: '941-555-0101', employment_status: 'active', field_dispatchable: true };

function chain({ first = undefined, inserted = [] } = {}) {
  const c = {};
  for (const m of ['where', 'whereNot', 'whereNotIn', 'orderByRaw', 'select']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => first);
  c.insert = jest.fn(async (row) => { inserted.push(row); return [1]; });
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_TECH_LINES;
});

describe('technicianForLine / ringTargetForLine', () => {
  test('an assignable holder with a cell rings first, cell normalized to E.164', async () => {
    db.mockImplementation(() => chain({ first: HOLDER }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBe('+19415550101');
  });

  test('a prospective / office-only holder does not ring (office list rings as today)', async () => {
    db.mockImplementation(() => chain({ first: { ...HOLDER, employment_status: 'prospective' } }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBeNull();
    db.mockImplementation(() => chain({ first: { ...HOLDER, field_dispatchable: false } }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBeNull();
  });

  test('no holder, no cell, or a non-registry number → null', async () => {
    db.mockImplementation(() => chain({ first: undefined }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBeNull();
    db.mockImplementation(() => chain({ first: { ...HOLDER, phone: null } }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBeNull();
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(techLine.ringTargetForLine('+19413187612')).resolves.toBeNull();
  });

  test("a holder whose phone is one of OUR Twilio lines never rings (no second inbound into /voice)", async () => {
    db.mockImplementation(() => chain({ first: { ...HOLDER, phone: '+19413187612' } }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBeNull();
    db.mockImplementation(() => chain({ first: { ...HOLDER, phone: '(941) 352-9161' } }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBeNull();
  });

  test('a DB failure fails soft to null', async () => {
    db.mockImplementation(() => ({ where: () => ({ first: async () => { throw new Error('pg down'); } }) }));
    await expect(techLine.ringTargetForLine(LINE)).resolves.toBeNull();
  });
});

describe('lineForTechnician (customer card)', () => {
  test('gate off → null without touching the DB', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(techLine.lineForTechnician('tech-1')).resolves.toBeNull();
  });

  test('gate on → the registry entry for an assignable holder, null otherwise', async () => {
    process.env.GATE_TECH_LINES = 'true';
    db.mockImplementation(() => chain({ first: { ...HOLDER, twilio_number: LINE } }));
    await expect(techLine.lineForTechnician('tech-1')).resolves.toMatchObject({ number: LINE, formatted: '(941) 352-9161' });
    db.mockImplementation(() => chain({ first: { ...HOLDER, twilio_number: null } }));
    await expect(techLine.lineForTechnician('tech-1')).resolves.toBeNull();
    db.mockImplementation(() => chain({ first: { ...HOLDER, twilio_number: LINE, employment_status: 'inactive' } }));
    await expect(techLine.lineForTechnician('tech-1')).resolves.toBeNull();
  });

  test('a DB failure fails soft to null by default; strict (the tech portal) rethrows so an outage never reads as "no line"', async () => {
    process.env.GATE_TECH_LINES = 'true';
    db.mockImplementation(() => ({ where: () => ({ first: async () => { throw new Error('pg down'); } }) }));
    await expect(techLine.lineForTechnician('tech-1')).resolves.toBeNull();
    await expect(techLine.lineForTechnician('tech-1', { strict: true })).rejects.toThrow('pg down');
    await expect(techLine.techLineContext('tech-1', { strict: true })).rejects.toThrow('pg down');
  });
});

describe('notifyTechLineText', () => {
  test('writes one kept card for the holder and pushes a one-line summary', async () => {
    const inserted = [];
    db.mockImplementation((table) => (table === 'tech_notifications' ? chain({ inserted }) : chain({ first: HOLDER })));
    const ok = await techLine.notifyTechLineText({
      lineNumber: LINE, from: '+19415550199', body: 'Gate code is 4412, dog is friendly',
      customer: { id: 'c1', first_name: 'Maria', last_name: 'Ruiz' }, mediaCount: 0,
    });
    expect(ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ technician_id: 'tech-1', type: 'tech_line_sms' });
    expect(inserted[0].message).toBe('Text from Maria Ruiz: Gate code is 4412, dog is friendly');
    expect(JSON.parse(inserted[0].payload)).toMatchObject({
      headline: 'Text on your line', line: LINE, from: '+19415550199', customer_id: 'c1',
      customer_name: 'Maria Ruiz', body: 'Gate code is 4412, dog is friendly', media_count: 0,
    });
    expect(PushService.sendToAdminUser).toHaveBeenCalledWith('tech-1', expect.objectContaining({
      title: 'Text from Maria Ruiz', body: 'Gate code is 4412, dog is friendly', url: '/tech', tag: 'tech-line-19415550199',
    }));
  });

  test('unknown sender shows a formatted number; photos-only text names the media', async () => {
    const inserted = [];
    db.mockImplementation((table) => (table === 'tech_notifications' ? chain({ inserted }) : chain({ first: HOLDER })));
    await techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: '', customer: null, mediaCount: 2 });
    expect(inserted[0].message).toBe('Text from (941) 555-0199: 2 photos');
    expect(JSON.parse(inserted[0].payload).customer_name).toBe('(941) 555-0199');
  });

  describe('GATE_TECH_LOGIN_PRIVACY: a matched customer is named only when on the holder\'s route', () => {
    const scope = require('../services/technician-visit-scope');
    const OFF_ROUTE = { id: 'c-off', first_name: 'Test', last_name: 'Caller' };

    beforeEach(() => { jest.spyOn(scope, 'technicianServicesCustomer'); });
    afterEach(() => { jest.restoreAllMocks(); delete process.env.GATE_TECH_LOGIN_PRIVACY; });

    test('gate on, customer off the route: the card and the push show the formatted number, not the name', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      scope.technicianServicesCustomer.mockResolvedValue(false);
      const inserted = [];
      db.mockImplementation((table) => (table === 'tech_notifications' ? chain({ inserted }) : chain({ first: HOLDER })));
      await techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'Is anyone coming?', customer: OFF_ROUTE });
      expect(scope.technicianServicesCustomer).toHaveBeenCalledWith({ techRole: 'technician', technicianId: 'tech-1' }, 'c-off');
      expect(inserted[0].message).toBe('Text from (941) 555-0199: Is anyone coming?');
      expect(JSON.parse(inserted[0].payload)).toMatchObject({ customer_id: null, customer_name: '(941) 555-0199' });
      expect(PushService.sendToAdminUser).toHaveBeenCalledWith('tech-1', expect.objectContaining({ title: 'Text from (941) 555-0199' }));
    });

    test('gate on, customer on the route: the name stays', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      scope.technicianServicesCustomer.mockResolvedValue(true);
      const inserted = [];
      db.mockImplementation((table) => (table === 'tech_notifications' ? chain({ inserted }) : chain({ first: HOLDER })));
      await techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'On my way out', customer: OFF_ROUTE });
      expect(inserted[0].message).toBe('Text from Test Caller: On my way out');
    });

    test('gate on, route check fails: counts as off the route (fail closed)', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      scope.technicianServicesCustomer.mockRejectedValue(new Error('db down'));
      const inserted = [];
      db.mockImplementation((table) => (table === 'tech_notifications' ? chain({ inserted }) : chain({ first: HOLDER })));
      await techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'hello', customer: OFF_ROUTE });
      expect(inserted[0].message).toBe('Text from (941) 555-0199: hello');
    });

    test('gate off: the name shows with no route lookup, as before', async () => {
      const inserted = [];
      db.mockImplementation((table) => (table === 'tech_notifications' ? chain({ inserted }) : chain({ first: HOLDER })));
      await techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'hello', customer: OFF_ROUTE });
      expect(inserted[0].message).toBe('Text from Test Caller: hello');
      expect(scope.technicianServicesCustomer).not.toHaveBeenCalled();
    });
  });

  // The card's Reply (TechNoticeFeed) texts the visit's customer at the phone on file
  // (POST /api/tech/line/sms), so the card names a visit only when that phone texted.
  describe('reply_visit_id', () => {
    const ON_FILE = { id: 'c1', first_name: 'Pat', last_name: 'Example', phone: '941-555-0199' };
    function mockTables({ visit = { id: 'svc-1' }, visitError = null } = {}) {
      const inserted = [];
      const visitChain = chain({ first: visit });
      if (visitError) visitChain.first = jest.fn(async () => { throw visitError; });
      db.mockImplementation((table) => {
        if (table === 'tech_notifications') return chain({ inserted });
        if (table === 'scheduled_services') return visitChain;
        return chain({ first: HOLDER });
      });
      return { inserted, visitChain };
    }

    test('a text from the phone on file names the holder\'s own visit of that customer', async () => {
      const { inserted, visitChain } = mockTables();
      await techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'Running late?', customer: ON_FILE });
      expect(JSON.parse(inserted[0].payload).reply_visit_id).toBe('svc-1');
      expect(visitChain.where).toHaveBeenCalledWith({ customer_id: 'c1' });
      expect(visitChain.where).toHaveBeenCalledWith('scheduled_services.technician_id', 'tech-1');
    });

    test.each([
      ['another phone texted (a service contact or a shared number)', { ...ON_FILE, phone: '941-555-0123' }],
      ['no customer matched', null],
    ])('%s: no Reply, and no visit lookup', async (_label, customer) => {
      const { inserted } = mockTables();
      await techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'hello', customer });
      expect(JSON.parse(inserted[0].payload).reply_visit_id).toBeNull();
      expect(db).not.toHaveBeenCalledWith('scheduled_services');
    });

    test.each([
      ['no own visit of that customer in scope', { visit: null }],
      ['the visit lookup fails', { visitError: new Error('db down') }],
    ])('%s: no Reply; the card is still written', async (_label, opts) => {
      const { inserted } = mockTables(opts);
      await expect(techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'hello', customer: ON_FILE })).resolves.toBe(true);
      expect(JSON.parse(inserted[0].payload).reply_visit_id).toBeNull();
    });
  });

  test('no assignable holder → nothing written, nothing pushed', async () => {
    db.mockImplementation(() => chain({ first: undefined }));
    await expect(techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'hi' })).resolves.toBe(false);
    expect(PushService.sendToAdminUser).not.toHaveBeenCalled();
  });

  test('a failed push never undoes the card', async () => {
    const inserted = [];
    db.mockImplementation((table) => (table === 'tech_notifications' ? chain({ inserted }) : chain({ first: HOLDER })));
    PushService.sendToAdminUser.mockRejectedValueOnce(new Error('vapid'));
    await expect(techLine.notifyTechLineText({ lineNumber: LINE, from: '+19415550199', body: 'hi' })).resolves.toBe(true);
    expect(inserted).toHaveLength(1);
  });
});
