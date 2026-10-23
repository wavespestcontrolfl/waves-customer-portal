// Bid Desk checklist (GATE_BID_CHECKLIST): the new reminder rules, their notification copy and the templates.
// Pure: no database, no clock. Synthetic bids only.
const { reminderDue, datesDue } = require('../services/bid-desk/rules');
const { reminderSpec, questionsReminderSpec, jobWalkReminderSpec } = require('../services/bid-desk/alerts');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { templateRows, TEMPLATE_TYPES, SECTION_STOP, SECTION_BASE } = require('../../shared/bid-checklist-templates.cjs');

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

  const sections = (type) => templateRows(type).map((r) => r.section);
  const BASE_TEN = Array(10).fill('base');

  test('the base list is the ten-line bid check, in order', () => {
    const base = templateRows(null);
    expect(base).toHaveLength(10);
    expect(base[0].label).toMatch(/^Bid form used exactly as issued/);
    expect(base[2].label).toMatch(/^Every addendum acknowledged/);
    expect(base[9].label).toMatch(/^Submission method, file format, file names and deadline confirmed/);
    expect(base.every((r) => r.section === 'base' && r.required)).toBe(true);
    expect(base.map((r) => r.template_key)).toEqual(['bid_form', 'prices', 'addenda', 'bid_security', 'signer', 'forms', 'licenses', 'subs', 'submittals', 'submission'].map((k) => `base.${k}`));
  });

  test('a typed list is the stop checks, then the ten base rows, then the type\'s own rows', () => {
    expect(TEMPLATE_TYPES.sort()).toEqual(['federal', 'gc_subcontract', 'itb', 'itn', 'quote', 'rfp', 'rfq']);
    const shape = { quote: [3, 5], rfq: [3, 5], itb: [4, 11], rfp: [2, 9], itn: [2, 9], gc_subcontract: [2, 6], federal: [2, 5] };
    const own = { quote: 'quote', rfq: 'quote', itb: 'itb', rfp: 'rfp', itn: 'rfp', gc_subcontract: 'gc_subcontract', federal: 'federal' };
    for (const [type, [stops, extra]] of Object.entries(shape)) {
      expect(sections(type)).toEqual([...Array(stops).fill(SECTION_STOP), ...BASE_TEN, ...Array(extra).fill(own[type])]);
      expect(templateRows(type)).toHaveLength(stops + 10 + extra);
    }
    expect([SECTION_STOP, SECTION_BASE]).toEqual(['stop', 'base']);
  });

  test('the stop keys differ per type and the base rows are the same ten everywhere', () => {
    const stopKeys = (type) => templateRows(type).filter((r) => r.section === 'stop').map((r) => r.template_key);
    expect(stopKeys('quote')).toEqual(['stop.license_type', 'stop.experience', 'stop.price_cap']);
    expect(stopKeys('itb')).toEqual(['stop.local_office', 'stop.license_staffing', 'stop.reference_rules', 'stop.prebid']);
    expect(stopKeys('rfp')).toEqual(['stop.criteria_matrix', 'stop.participation']);
    expect(stopKeys('gc_subcontract')).toEqual(['stop.gc_insurance', 'stop.scope_fit']);
    expect(stopKeys('federal')).toEqual(['stop.set_aside', 'stop.sam_active']);
    const baseOf = (type) => templateRows(type).filter((r) => r.section === 'base');
    for (const type of TEMPLATE_TYPES) expect(baseOf(type)).toEqual(templateRows(null));
    expect(templateRows('quote')[0].label).toMatch(/^Stop check: /);
  });

  test('the type\'s own rows carry their wording', () => {
    const own = (type) => templateRows(type).filter((r) => r.section !== 'stop' && r.section !== 'base').map((r) => r.label).join('|');
    expect(own('itb')).toMatch(/business license.*operator certificate.*works full-time.*Employee ID.*EPA/i);
    expect(own('federal')).toMatch(/SAM registration.*SF 1449.*Wage determination/);
    expect(own('gc_subcontract')).toMatch(/bid form completed, every acknowledgment line initialed \(escalation, price hold period, sales tax, addenda listed\).*prequalification.*insurance exhibit.*additional insured.*Price hold period stated and met.*Alternates and deducts.*Warranty terms match the specification.*spec sections and drawings/i);
    // RFQ is a request for quotes and ITN uses the RFP lines, with the same keys, so a type change adds nothing twice.
    expect(templateRows('rfq')).toEqual(templateRows('quote'));
    expect(templateRows('itn')).toEqual(templateRows('rfp'));
    for (const type of ['other', null, undefined]) expect(sections(type)).toEqual(BASE_TEN);
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
