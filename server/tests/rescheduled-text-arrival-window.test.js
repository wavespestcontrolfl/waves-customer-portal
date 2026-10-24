const migration = require('../models/migrations/20260928070000_rescheduled_text_arrival_window');
const { _BEFORE: before, _AFTER: after, _withWindow: withWindow } = migration;
const { _SWAPS: priorSwaps } = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const { spokenArrivalWindow } = require('../utils/sms-time-format');
const { countSegments } = require('../services/messaging/segment-counter');

const render = (body, vars) => body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
const vars = {
  first_name: 'Maria', service_type: 'Pest Control', day: 'Thursday', date: 'October 2',
  time: '9:00 AM', window: spokenArrivalWindow('09:00'),
};

test('starts from the body the 2026-09-26 copy audit left live', () => {
  expect(priorSwaps.find(([key]) => key === 'appointment_rescheduled')[2]).toBe(before);
});

test('quotes the 2-hour arrival window, like every reminder', () => {
  expect(render(after, vars)).toBe('Hello Maria! Your Pest Control with Waves is now Thursday, October 2, between 9:00 AM and 11:00 AM.\n\nNeed a different time? Reply here.');
  expect(after).not.toContain('{time}');
  expect(countSegments(render(after, vars))).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
});

test('both senders pass {window}', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  expect(read('routes/admin-schedule.js')).toMatch(/renderRequiredSmsTemplate\('appointment_rescheduled',[\s\S]{0,500}window: spokenArrivalWindow\(start\)/);
  // handleReschedule's {window} comes from the one helper its email version also uses (GATE_MOVE_NOTICE_EMAIL).
  expect(read('services/appointment-reminders.js')).toMatch(/renderRequiredTemplate\('appointment_rescheduled',[\s\S]{0,700}window: rescheduleWindowPhrase\(resolved, newApptTime\)/);
});

test('adds window to the variables list once', () => {
  expect(JSON.parse(withWindow(['first_name', 'time']))).toEqual(['first_name', 'time', 'window']);
  expect(withWindow(['window'])).toEqual(['window']);
  expect(JSON.parse(withWindow('["day"]'))).toEqual(['day', 'window']);
});

function fakeKnex(rows) {
  const k = (table) => {
    const q = { filters: {} };
    q.where = (f) => { Object.assign(q.filters, f); return q; };
    const hits = () => rows.filter((r) => r.table === table && Object.entries(q.filters).every(([c, v]) => r[c] === v));
    q.select = async () => hits();
    q.update = async (patch) => { const h = hits(); h.forEach((r) => Object.assign(r, patch)); return h.length; };
    return q;
  };
  k.schema = {
    hasTable: async (t) => t === 'sms_templates' || t === 'sms_template_variants',
    hasColumn: async (t) => t === 'sms_templates',
  };
  k.fn = { now: () => 'now()' };
  return k;
}

test('an office-edited base row keeps its wording but still gains window in its variables', async () => {
  const allowlist = require('../models/migrations/20260928131000_rescheduled_window_variable_allowlist');
  const rows = [
    { table: 'sms_templates', id: 1, template_key: 'appointment_rescheduled', body: 'Office wording {date}.', variables: ['first_name', 'date'] },
    { table: 'sms_template_variants', id: 2, template_key: 'appointment_rescheduled', body: 'Variant wording {date}.', variables: ['first_name', 'date'] },
  ];
  await migration.up(fakeKnex(rows));
  await allowlist.up(fakeKnex(rows));
  expect(rows[0].body).toBe('Office wording {date}.');
  expect(JSON.parse(rows[0].variables)).toEqual(['first_name', 'date', 'window']);
  expect(rows[1]).toMatchObject({ body: 'Variant wording {date}.', variables: ['first_name', 'date'] });
  // A seeded row the first migration already swapped is left as it is.
  const swapped = [{ table: 'sms_templates', id: 3, template_key: 'appointment_rescheduled', body: before, variables: ['first_name', 'time'] }];
  await migration.up(fakeKnex(swapped));
  const variablesAfterSwap = swapped[0].variables;
  await allowlist.up(fakeKnex(swapped));
  expect(swapped[0].variables).toBe(variablesAfterSwap);
});

test('a windowless reschedule says the reminders\' unknown-window phrase, not a made-up 8-10 AM', () => {
  const { UNKNOWN_ARRIVAL_WINDOW } = require('../utils/sms-time-format');
  const { rescheduleWindowPhrase } = require('../services/appointment-reminders')._test;
  // 13:00Z on Oct 2 2026 = 9:00 AM Eastern.
  expect(rescheduleWindowPhrase({ windowless: true }, new Date('2026-10-02T13:00:00.000Z'))).toBe(UNKNOWN_ARRIVAL_WINDOW);
  expect(rescheduleWindowPhrase({ windowless: false }, new Date('2026-10-02T13:00:00.000Z'))).toBe(spokenArrivalWindow('09:00'));
  expect(rescheduleWindowPhrase(null, new Date('2026-10-02T13:00:00.000Z'))).toBe(spokenArrivalWindow('09:00'));
  // The text and its email version both take the phrase from that helper; the email also learns the window is unknown.
  const { rescheduleEmailWindow } = require('../services/appointment-reminders')._test;
  expect(rescheduleEmailWindow({ windowless: true }, new Date('2026-10-02T13:00:00.000Z'))).toEqual({ arrivalWindow: UNKNOWN_ARRIVAL_WINDOW, windowUnknown: true });
  expect(rescheduleEmailWindow({ windowless: false }, new Date('2026-10-02T13:00:00.000Z'))).toEqual({ arrivalWindow: spokenArrivalWindow('09:00'), windowUnknown: false });
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'appointment-reminders.js'), 'utf8');
  expect(src).toMatch(/window: rescheduleWindowPhrase\(resolved, newApptTime\)/);
  expect(src).toMatch(/\.\.\.rescheduleEmailWindow\(resolved, newApptTime\)/);
  expect(render(after, { ...vars, window: require('../utils/sms-time-format').UNKNOWN_ARRIVAL_WINDOW }))
    .toContain("is now Thursday, October 2, at a time we'll confirm.");
});

test('swaps the exact live body and leaves an edited one alone', async () => {
  const rows = [
    { table: 'sms_templates', id: 1, template_key: 'appointment_rescheduled', body: before, variables: ['first_name', 'time'] },
    { table: 'sms_template_variants', id: 2, template_key: 'appointment_rescheduled', body: 'Office-edited copy.' },
  ];
  await migration.up(fakeKnex(rows));
  expect(rows[0].body).toBe(after);
  expect(JSON.parse(rows[0].variables)).toContain('window');
  expect(rows[1].body).toBe('Office-edited copy.');
});
