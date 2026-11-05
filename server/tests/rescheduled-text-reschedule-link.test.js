// The rescheduled text closes on the self-serve reschedule link (owner
// 2026-11-04): 20261105010000 swaps "Need a different time? Reply here." for
// {different_time_line}, which both senders fill from rescheduledTextLine.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const migration = require('../models/migrations/20261105010000_rescheduled_text_reschedule_link');
const { _BEFORE: before, _AFTER: after, _withVariable: withVariable } = migration;
const { _SWAPS: tightenSwaps } = require('../models/migrations/20261006220000_sms_template_tighten');
const { RESCHEDULED_REPLY_LINE } = require('../services/reschedule-link');
const { spokenArrivalWindow } = require('../utils/sms-time-format');
const { countSegments } = require('../services/messaging/segment-counter');

const render = (body, vars) => body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
const vars = {
  first_name: 'Maria', service_type: 'One-Time Pest Control Service', day: 'Saturday', date: 'November 7',
  time: '1:00 PM', window: spokenArrivalWindow('13:00'),
};
// getTemplate sends links without the scheme (stripSmsUrlScheme), as the 72h reminder shows.
const LINKED = 'Need a different time? Reschedule here: portal.wavespestcontrol.com/l/abcdefghij';

test('starts from the body the 2026-10-06 rewrite left live', () => {
  expect(tightenSwaps.find(([key]) => key === 'appointment_rescheduled')[2]).toBe(before);
});

test('with no link the customer gets today\'s text, word for word', () => {
  expect(render(after, { ...vars, different_time_line: RESCHEDULED_REPLY_LINE })).toBe(render(before, vars));
});

test('with a link: the same sentence, the link after it, GSM-7 in two segments', () => {
  const body = render(after, { ...vars, different_time_line: LINKED });
  expect(body).toBe('Hi Maria, your One-Time Pest Control Service with Waves is now Saturday, November 7, between 1:00 PM and 3:00 PM.\n\n'
    + 'Need a different time? Reschedule here: portal.wavespestcontrol.com/l/abcdefghij');
  expect(countSegments(body)).toMatchObject({ encoding: 'GSM_7', segmentCount: 2 });
  const long = render(after, {
    ...vars, first_name: 'Christopher', service_type: 'Every 6 Weeks Lawn Care Service', day: 'Wednesday',
    date: 'September 30', window: spokenArrivalWindow('10:00'), different_time_line: `${LINKED}x`,
  });
  expect(countSegments(long)).toMatchObject({ encoding: 'GSM_7', segmentCount: 2 });
});

test('both senders fill {different_time_line} from rescheduledTextLine', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  expect(read('routes/admin-schedule.js')).toMatch(/rescheduledTextLine\(serviceId, \{ customerId: customer\.id \}\)[\s\S]{0,700}renderRequiredSmsTemplate\('appointment_rescheduled',[\s\S]{0,500}different_time_line: differentTimeLine/);
  expect(read('services/appointment-reminders.js')).toMatch(/rescheduledTextLine\(scheduledServiceId, \{ customerId: record\.customer_id \}\)[\s\S]{0,400}renderRequiredTemplate\('appointment_rescheduled',[\s\S]{0,400}different_time_line: differentTimeLine/);
});

test('adds the variable to the list once', () => {
  expect(JSON.parse(withVariable(['first_name', 'window']))).toEqual(['first_name', 'window', 'different_time_line']);
  expect(withVariable(['different_time_line'])).toEqual(['different_time_line']);
  expect(JSON.parse(withVariable('["day"]'))).toEqual(['day', 'different_time_line']);
  expect(withVariable('not json')).toBe('not json');
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
    hasColumn: async (t, c) => t === 'sms_templates' && c === 'variables',
  };
  k.fn = { now: () => 'now()' };
  return k;
}

const VARS = ['first_name', 'service_type', 'day', 'date', 'time', 'window'];

test('a seeded row and variant take the link line; an office-edited row keeps its words but can now use it', async () => {
  const rows = [
    { table: 'sms_templates', id: 1, template_key: 'appointment_rescheduled', body: before, variables: VARS },
    { table: 'sms_template_variants', id: 2, template_key: 'appointment_rescheduled', body: before },
    { table: 'sms_template_variants', id: 3, template_key: 'appointment_rescheduled', body: 'Variant wording {date}.' },
    { table: 'sms_templates', id: 4, template_key: 'appointment_cancelled', body: before, variables: VARS },
  ];
  await migration.up(fakeKnex(rows));
  expect(rows[0]).toMatchObject({ body: after, updated_at: 'now()' });
  expect(JSON.parse(rows[0].variables)).toEqual([...VARS, 'different_time_line']);
  expect(rows[1].body).toBe(after);
  expect(rows[2].body).toBe('Variant wording {date}.');
  expect(rows[3]).toMatchObject({ body: before, variables: VARS });

  const edited = [{ table: 'sms_templates', id: 5, template_key: 'appointment_rescheduled', body: 'Office wording {date}.', variables: VARS }];
  await migration.up(fakeKnex(edited));
  expect(edited[0].body).toBe('Office wording {date}.');
  expect(JSON.parse(edited[0].variables)).toEqual([...VARS, 'different_time_line']);

  // A second run changes nothing.
  const snapshot = JSON.stringify(rows);
  await migration.up(fakeKnex(rows));
  expect(JSON.stringify(rows)).toBe(snapshot);
});

test('down puts the reply line back only where the body is still this copy', async () => {
  const rows = [
    { table: 'sms_templates', id: 1, template_key: 'appointment_rescheduled', body: after, variables: JSON.stringify([...VARS, 'different_time_line']) },
    { table: 'sms_template_variants', id: 2, template_key: 'appointment_rescheduled', body: after },
    { table: 'sms_template_variants', id: 3, template_key: 'appointment_rescheduled', body: 'Edited {different_time_line}' },
  ];
  await migration.down(fakeKnex(rows));
  expect(rows[0].body).toBe(before);
  expect(rows[1].body).toBe(before);
  expect(rows[2].body).toBe('Edited {different_time_line}');
  expect(JSON.parse(rows[0].variables)).toContain('different_time_line');
});
