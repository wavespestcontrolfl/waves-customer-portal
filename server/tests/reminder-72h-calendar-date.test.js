const migration = require('../models/migrations/20260928010000_reminder_72h_calendar_date');
const { _BEFORE: before, _AFTER: after } = migration;
const { _SWAPS: priorSwaps } = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { countSegments } = require('../services/messaging/segment-counter');

// Long-side personalization, the same shape the sender passes.
const sample = {
  first_name: 'Longtestname', service_type: 'Quarterly Pest Control', day: 'Wednesday', date: 'September 30',
  window: 'between 10:00 AM and 12:00 PM',
  reschedule_line: 'Reschedule here: https://portal.wavespestcontrol.com/l/abcdefghjk\n\n',
  card_hold_policy_line: '\n\nYour card on file holds this visit - cancel free until September 29 at 10:00 AM. After that, a $50 fee applies only if you cancel or no one is home. Rescheduling is always free.',
};
const render = (body, vars = sample) => normalizeGsmPunctuation(stripSmsUrlScheme(
  body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? ''),
)).replace(/\n{3,}/g, '\n\n').trim();

test('starts from the body the 2026-09-26 copy audit left live', () => {
  expect(priorSwaps.find(([key]) => key === 'reminder_72h')[2]).toBe(before);
});

test('the reminder names the weekday AND the calendar date, then the window', () => {
  expect(render(after)).toMatch(/^Hello Longtestname! Waves Quarterly Pest Control: Wednesday, September 30, between 10:00 AM and 12:00 PM\./);
  expect([...after.matchAll(/\{\w+\}/g)].map((m) => m[0]).filter((p) => !before.includes(p))).toEqual(['{date}']);
});

test('stays GSM-7; a typical reminder stays one segment, and the card-hold version adds none', () => {
  const typical = { ...sample, first_name: 'Maria', service_type: 'Pest Control', card_hold_policy_line: '' };
  expect(countSegments(render(after, typical))).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
  expect(countSegments(render(after)).segmentCount).toBe(countSegments(render(before)).segmentCount);
  expect(after).not.toMatch(/[–—‘’“”]/);
});

function fakeKnex(rows) {
  const k = (table) => {
    const q = { table, filters: {} };
    q.where = (f) => { Object.assign(q.filters, f); return q; };
    q.select = async () => rows.filter((r) => r.table === table
      && Object.entries(q.filters).every(([c, v]) => r[c] === v));
    q.update = async (patch) => {
      const hit = rows.filter((r) => r.table === table && Object.entries(q.filters).every(([c, v]) => r[c] === v));
      hit.forEach((r) => Object.assign(r, patch));
      return hit.length;
    };
    return q;
  };
  k.schema = { hasTable: async (t) => t === 'sms_templates' || t === 'sms_template_variants' };
  k.fn = { now: () => 'now()' };
  return k;
}

test('swaps the exact live body in both tables and leaves an edited one alone', async () => {
  const rows = [
    { table: 'sms_templates', id: 1, template_key: 'reminder_72h', body: before },
    { table: 'sms_template_variants', id: 2, template_key: 'reminder_72h', body: before },
    { table: 'sms_template_variants', id: 3, template_key: 'reminder_72h', body: 'An office-edited reminder.' },
    { table: 'sms_templates', id: 4, template_key: 'reminder_24h', body: before },
  ];
  await migration.up(fakeKnex(rows));
  expect(rows.map((r) => r.body)).toEqual([after, after, 'An office-edited reminder.', before]);
});
