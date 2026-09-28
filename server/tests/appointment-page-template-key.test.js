// renderAppointmentPageTemplate picks the _v2 row or the base row; its
// optional `out` reports which one rendered so the send can record the exact
// template key (sms_log.metadata.template_key, PR #5284).
let mockV2Row;
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: jest.fn().mockReturnThis(), first: jest.fn(async () => mockV2Row) }));
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));

const smsTemplates = require('../routes/admin-sms-templates');
const { renderAppointmentPageTemplate } = require('../services/appointment-reminders');

describe('renderAppointmentPageTemplate reports the row that rendered', () => {
  const OLD = process.env.GATE_APPOINTMENT_PAGE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = OLD;
    smsTemplates.getTemplate.mockReset();
  });

  test('gate on + active v2 row: the _v2 key', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    mockV2Row = { id: 1, is_active: true };
    smsTemplates.getTemplate.mockResolvedValue('v2 body');
    const out = {};
    expect(await renderAppointmentPageTemplate('reminder_24h', async () => ({}), {}, {}, out)).toBe('v2 body');
    expect(out.templateKey).toBe('reminder_24h_v2');
  });

  test('gate on + v2 row absent: falls back to and reports the base key', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    mockV2Row = undefined;
    smsTemplates.getTemplate.mockResolvedValue('base body');
    const out = {};
    expect(await renderAppointmentPageTemplate('appointment_confirmation', async () => ({}), {}, {}, out)).toBe('base body');
    expect(out.templateKey).toBe('appointment_confirmation');
  });

  test('gate off: base key', async () => {
    delete process.env.GATE_APPOINTMENT_PAGE;
    smsTemplates.getTemplate.mockResolvedValue('base body');
    const out = {};
    await renderAppointmentPageTemplate('reminder_24h', async () => ({}), {}, {}, out);
    expect(out.templateKey).toBe('reminder_24h');
  });

  test('nothing rendered: no key, and callers without `out` are unaffected', async () => {
    delete process.env.GATE_APPOINTMENT_PAGE;
    smsTemplates.getTemplate.mockResolvedValue(null);
    const out = {};
    expect(await renderAppointmentPageTemplate('reminder_24h', async () => ({}), {}, {}, out)).toBeNull();
    expect(out.templateKey).toBeUndefined();
    smsTemplates.getTemplate.mockResolvedValue('base body');
    expect(await renderAppointmentPageTemplate('reminder_24h', async () => ({}), {})).toBe('base body');
  });
});
