// Bid Desk checklist (GATE_BID_CHECKLIST): the new reminder rules, their notification copy and the templates.
// Pure: no database, no clock. Synthetic bids only.
const { reminderDue, datesDue } = require('../services/bid-desk/rules');
const { reminderSpec, questionsReminderSpec, jobWalkReminderSpec } = require('../services/bid-desk/alerts');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { templateRows, TEMPLATE_TYPES } = require('../../shared/bid-checklist-templates.cjs');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-01T14:00:00Z'); // 10:00 ET
const at = (ms) => new Date(NOW.getTime() + ms);
const bid = (over = {}) => ({
  id: '11111111-2222-4333-8444-555555555555', status: 'new', historical: false, project_title: 'Sample Ridge Residences', gc_or_agency: 'Fixture Build Co',
  due_at: null, due_confirmed: false, needs_date_confirmation: false, source_active: null, job_walk_at: null, job_walk_mandatory: false, job_walk_confirmed: true,
  questions_due_at: null, reminder_7d_sent_at: null, reminder_2d_sent_at: null, reminder_14d_sent_at: null,
  questions_reminder_sent_at: null, job_walk_reminder_sent_at: null, ...over,
});
const due = (ms, over = {}) => bid({ due_at: at(ms), due_confirmed: true, ...over });

describe('the 14-day reminder', () => {
  const on = { checklist: true };

  test('fires once, only for a date more than 7 and at most 14 days away', () => {
    expect(reminderDue(due(15 * DAY), NOW, on)).toBeNull();
    expect(reminderDue(due(14 * DAY), NOW, on)).toBe('14d');
    expect(reminderDue(due(10 * DAY), NOW, on)).toBe('14d');
    expect(reminderDue(due(10 * DAY, { reminder_14d_sent_at: NOW }), NOW, on)).toBeNull();
    // Inside 7 days the 14-day reminder is moot: the 7-day one is owed instead, and a late 14-day one never fires.
    expect(reminderDue(due(7 * DAY), NOW, on)).toBe('7d');
    expect(reminderDue(due(7 * DAY, { reminder_7d_sent_at: NOW }), NOW, on)).toBeNull();
    expect(reminderDue(due(1 * DAY), NOW, on)).toBe('2d');
  });

  test('an unconfirmed, historical, flagged, closed-notice or decided bid never gets it', () => {
    expect(reminderDue(due(10 * DAY, { due_confirmed: false }), NOW, on)).toBeNull();
    expect(reminderDue(due(10 * DAY, { historical: true }), NOW, on)).toBeNull();
    expect(reminderDue(due(10 * DAY, { needs_date_confirmation: true }), NOW, on)).toBeNull();
    expect(reminderDue(due(10 * DAY, { source_active: false }), NOW, on)).toBeNull();
    for (const status of ['no_bid', 'submitted', 'won', 'lost']) expect(reminderDue(due(10 * DAY, { status }), NOW, on)).toBeNull();
    expect(reminderDue(due(10 * DAY, { status: 'bid' }), NOW, on)).toBe('14d');
  });

  test('with the gate off there is no 14-day reminder, and the 7-day and 2-day ones are unchanged', () => {
    expect(reminderDue(due(10 * DAY), NOW)).toBeNull();
    expect(reminderDue(due(10 * DAY), NOW, { checklist: false })).toBeNull();
    expect(reminderDue(due(7 * DAY), NOW)).toBe('7d');
    expect(reminderDue(due(2 * DAY), NOW)).toBe('2d');
  });
});

describe('the questions and job-walk reminders', () => {
  test('each fires once, 2 days before its own date', () => {
    expect(datesDue(bid({ questions_due_at: at(3 * DAY) }), NOW)).toEqual([]);
    expect(datesDue(bid({ questions_due_at: at(2 * DAY) }), NOW)).toEqual(['questions']);
    expect(datesDue(bid({ questions_due_at: at(1 * DAY), questions_reminder_sent_at: NOW }), NOW)).toEqual([]);
    expect(datesDue(bid({ job_walk_at: at(2 * DAY) }), NOW)).toEqual(['job_walk']);
    expect(datesDue(bid({ job_walk_at: at(1 * DAY), job_walk_reminder_sent_at: NOW }), NOW)).toEqual([]);
    expect(datesDue(bid({ job_walk_at: at(1 * DAY), questions_due_at: at(1 * DAY) }), NOW)).toEqual(['questions', 'job_walk']);
    // One date's stamp never blocks the other date.
    expect(datesDue(bid({ job_walk_at: at(1 * DAY), questions_due_at: at(1 * DAY), questions_reminder_sent_at: NOW }), NOW)).toEqual(['job_walk']);
  });

  test('a past date, a missing date and a date more than 2 days away never remind', () => {
    expect(datesDue(bid({ questions_due_at: at(-1 * DAY), job_walk_at: at(-1000) }), NOW)).toEqual([]);
    expect(datesDue(bid(), NOW)).toEqual([]);
    expect(datesDue(bid({ job_walk_at: at(2 * DAY + 1000) }), NOW)).toEqual([]);
  });

  test('a historical, flagged, closed-notice or decided bid never reminds', () => {
    const soon = { questions_due_at: at(1 * DAY), job_walk_at: at(1 * DAY) };
    expect(datesDue(bid({ ...soon, historical: true }), NOW)).toEqual([]);
    expect(datesDue(bid({ ...soon, needs_date_confirmation: true }), NOW)).toEqual([]);
    expect(datesDue(bid({ ...soon, source_active: false }), NOW)).toEqual([]);
    for (const status of ['no_bid', 'submitted', 'won', 'lost']) expect(datesDue(bid({ ...soon, status }), NOW)).toEqual([]);
    expect(datesDue(bid({ ...soon, status: 'bid' }), NOW)).toEqual(['questions', 'job_walk']);
  });

  test('an unconfirmed due date does not stop them (they follow their own dates)', () => {
    expect(datesDue(bid({ due_confirmed: false, job_walk_at: at(1 * DAY) }), NOW)).toEqual(['job_walk']);
  });

  test('a job-walk date read from an invite (not confirmed) never reminds; the questions date still does', () => {
    const read = { job_walk_at: at(1 * DAY), job_walk_confirmed: false, questions_due_at: at(1 * DAY) };
    expect(datesDue(bid(read), NOW)).toEqual(['questions']);
    expect(datesDue(bid({ ...read, job_walk_confirmed: null }), NOW)).toEqual(['questions']);
    expect(datesDue(bid({ ...read, job_walk_confirmed: true }), NOW)).toEqual(['questions', 'job_walk']);
  });
});

describe('notification copy follows the admin notification rule', () => {
  const row = bid({ due_at: at(10 * DAY), due_confirmed: true, questions_due_at: at(2 * DAY), job_walk_at: at(1 * DAY) });

  test('the 14-day reminder composes and says how far off the date is', () => {
    const { spec, detail } = reminderSpec(row, '14d', NOW);
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(spec.action).toMatch(/bid due in 10 days/);
    expect(detail).toMatch(/^Bid reminder \(14-day\): Sample Ridge Residences is due Oct 11/);
    expect(reminderSpec(row, '7d', NOW).detail).toMatch(/^Bid reminder \(7-day\)/);
    expect(reminderSpec(row, '2d', NOW).detail).toMatch(/^Bid reminder \(2-day\)/);
  });

  test('the questions reminder composes and links to the bid', () => {
    const { spec, detail } = questionsReminderSpec(row, NOW);
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(spec.action).toMatch(/questions due in 2 days/);
    expect(spec.link).toBe(`/admin/bid-desk?bid=${row.id}`);
    expect(detail).toMatch(/^Bid reminder \(questions\): Sample Ridge Residences questions are due Oct 3/);
  });

  test('the job-walk reminder is marked mandatory only when it is', () => {
    const plain = jobWalkReminderSpec(row, NOW);
    expect(() => composeAdminAlert(plain.spec)).not.toThrow();
    expect(plain.spec.action).toMatch(/^job walk tomorrow/);
    expect(plain.detail).toMatch(/^Bid reminder \(job walk\)/);
    const mandatory = jobWalkReminderSpec({ ...row, job_walk_mandatory: true }, NOW);
    expect(() => composeAdminAlert(mandatory.spec)).not.toThrow();
    expect(mandatory.spec.action).toMatch(/^mandatory job walk tomorrow/);
    expect(mandatory.spec.why).toMatch(/^Mandatory job walk Oct 2/);
    expect(mandatory.detail).toMatch(/^Bid reminder \(mandatory job walk\)/);
  });

  test('a very long project name still composes', () => {
    const long = { ...row, project_title: 'P'.repeat(300), job_walk_mandatory: true };
    for (const { spec } of [questionsReminderSpec(long, NOW), jobWalkReminderSpec(long, NOW), reminderSpec(long, '14d', NOW)]) {
      expect(() => composeAdminAlert(spec)).not.toThrow();
    }
  });
});

describe('templates', () => {
  const labels = (type) => templateRows(type).map((r) => r.label);

  test('the base list is the ten-line bid-form check, in order', () => {
    const base = templateRows(null);
    expect(base).toHaveLength(10);
    expect(base[0].label).toMatch(/^Bid form used exactly as issued/);
    expect(base[2].label).toMatch(/addendum acknowledged and signed/);
    expect(base[9].label).toMatch(/Submission method, format, file names and deadline confirmed/);
    expect(base.every((r) => r.section === 'base' && r.required)).toBe(true);
  });

  test('each type adds its own lines after the base; rfq and itn borrow the quote and rfp lines; other gets the base only', () => {
    expect(TEMPLATE_TYPES.sort()).toEqual(['federal', 'gc_subcontract', 'itb', 'itn', 'quote', 'rfp', 'rfq']);
    expect(labels('quote').slice(10)).toHaveLength(3);
    expect(labels('itb').slice(10).join('|')).toMatch(/business license.*operator certificate.*works full-time.*Employee ID.*EPA/i);
    expect(labels('itb')).toHaveLength(15);
    expect(labels('rfp')).toHaveLength(15);
    expect(labels('federal').slice(10).join('|')).toMatch(/SAM registration.*SF 1449.*Wage determination/);
    // RFQ is a request for quotes: the quote lines, with the same keys, so a type change adds nothing twice.
    expect(templateRows('rfq')).toEqual(templateRows('quote'));
    expect(templateRows('itn')).toEqual(templateRows('rfp'));
    const gc = templateRows('gc_subcontract');
    expect(gc).toHaveLength(16);
    expect(gc.slice(10).map((r) => r.section)).toEqual(Array(6).fill('gc_subcontract'));
    expect(gc.slice(10).map((r) => r.label).join('|')).toMatch(/bid form completed, every acknowledgment line initialed \(escalation, price hold period, sales tax, addenda listed\).*prequalification.*insurance exhibit.*additional insured.*Price hold period stated and met.*Alternates and deducts.*Warranty terms match the specification.*spec sections and drawings/i);
    for (const type of ['other', null, undefined]) expect(templateRows(type)).toHaveLength(10);
  });

  test('every key is unique, stable-looking and fits the column; every section fits too', () => {
    for (const type of [...TEMPLATE_TYPES, null]) {
      const rows = templateRows(type);
      expect(new Set(rows.map((r) => r.template_key)).size).toBe(rows.length);
      for (const r of rows) {
        expect(r.template_key.length).toBeLessThanOrEqual(48);
        expect(r.section.length).toBeLessThanOrEqual(24);
        expect(r.template_key).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/);
      }
    }
  });
});
