// The lead contact sync (services/lead-contact-sync.js, GATE_LEAD_STATUS_FOLLOWS_CONTACT):
// the judging rules that run in JavaScript over rows the witness queries return, and the
// gate. A scripted fake stands in for knex: every chain resolves to the rows scripted for
// its table. The SQL predicates themselves (automated texts, voicemail calls, deleted leads)
// are held by lead-contact-sync-postgres.test.js, which CI runs against PostgreSQL.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-estimate-link', () => ({
  markLeadContactedFromEvidence: jest.fn(async () => ({ contacted: true, responseMinutes: 5 })),
}));
jest.mock('../services/email/email-customer-link', () => ({
  ...jest.requireActual('../services/email/email-customer-link'),
  resolveEmailCustomerLink: jest.fn(async () => null),
}));

const { markLeadContactedFromEvidence } = require('../services/lead-estimate-link');
const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
const { runLeadContactSync, _test } = require('../services/lead-contact-sync');

const T = (minutes) => new Date(Date.UTC(2026, 10, 4, 14, minutes, 0));
const FIRST = T(0);

// Scripted knex: table name (before " as ") -> rows. `leads` answers the candidate read first,
// then the shared-identity read.
function fakeDb(script) {
  const leadReads = [...(script.leads || [[], []])];
  const handler = (table) => {
    const name = String(table).split(' as ')[0];
    const rows = name === 'leads' ? (leadReads.shift() || []) : (script[name] || []);
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
        return () => chain;
      },
    });
    return chain;
  };
  handler.raw = (sql) => sql;
  return handler;
}

const lead = (fields = {}) => ({
  id: 'lead-1', customer_id: null, phone: '(941) 555-0100', email: null, first_contact_at: FIRST, response_time_minutes: null, ...fields,
});
const text = (fields = {}) => ({ id: 'sms-1', customer_id: null, at: T(7), peer: '9415550100', ...fields });
const call = (fields = {}) => ({
  id: 'call-1', customer_id: null, created_at: T(10), at: T(12), peer: '9415550100', origin_lead_id: null, relay_lead_id: null, ...fields,
});
const sharing = (fields = {}) => ({ id: 'lead-2', customer_id: null, email: null, peer: '9415550100', ...fields });

const run = (script, mode = 'true') => runLeadContactSync({ dbi: fakeDb(script), mode, now: T(60) });

beforeEach(() => {
  jest.clearAllMocks();
  _test.resetResume();
});

describe('lead contact sync: gate', () => {
  test('off touches nothing', async () => {
    const dbi = jest.fn(() => { throw new Error('db must not be read'); });
    expect(await runLeadContactSync({ dbi, mode: 'off' })).toEqual({ skipped: 'gate_off' });
    expect(dbi).not.toHaveBeenCalled();
  });

  test('shadow judges, counts by evidence type and writes nothing', async () => {
    const result = await run({ leads: [[lead()], []], sms_log: [text()] }, 'shadow');
    expect(result.mode).toBe('shadow');
    expect(result.moved).toBe(1);
    expect(result.byEvidence).toEqual({ staff_text: 1 });
    expect(markLeadContactedFromEvidence).not.toHaveBeenCalled();
  });

  test('the gate reader maps unset and junk to off, shadow and true through', () => {
    const { leadStatusFollowsContactMode } = jest.requireActual('../config/feature-gates');
    const saved = process.env.GATE_LEAD_STATUS_FOLLOWS_CONTACT;
    try {
      const read = (value) => {
        if (value === undefined) delete process.env.GATE_LEAD_STATUS_FOLLOWS_CONTACT;
        else process.env.GATE_LEAD_STATUS_FOLLOWS_CONTACT = value;
        return leadStatusFollowsContactMode();
      };
      expect([read(undefined), read(''), read('yes'), read('SHADOW'), read(' true ')]).toEqual(['off', 'off', 'off', 'shadow', 'true']);
    } finally {
      if (saved === undefined) delete process.env.GATE_LEAD_STATUS_FOLLOWS_CONTACT;
      else process.env.GATE_LEAD_STATUS_FOLLOWS_CONTACT = saved;
    }
  });
});

describe('lead contact sync: moving a lead', () => {
  test('a delivered staff text after first contact moves the lead, stamped at the text\'s own time', async () => {
    const result = await run({ leads: [[lead()], []], sms_log: [text({ at: T(7) })] });
    expect(result.moved).toBe(1);
    expect(markLeadContactedFromEvidence).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-1', customerId: null, evidenceType: 'staff_text', evidenceId: 'sms-1', respondedAt: T(7),
      identity: { phoneKey: '9415550100' },
    }));
  });

  test('the earliest contact wins and a live call is recorded as a live conversation at its end', async () => {
    await run({ leads: [[lead()], []], sms_log: [text({ at: T(20) })], call_log: [call({ at: T(12) })] });
    expect(markLeadContactedFromEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceType: 'live_conversation', evidenceId: 'call-1', respondedAt: T(12),
    }));
  });

  test('a staff email to the lead\'s address moves it', async () => {
    await run({
      leads: [[lead({ phone: null, email: 'Pat@Example.invalid' })], []],
      emails: [{ id: 'mail-1', gmail_thread_id: 't', to_address: 'Pat Sample <pat@example.invalid>', cc_address: '', bcc_address: '', at: T(30) }],
    });
    expect(markLeadContactedFromEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceType: 'staff_email', evidenceId: 'mail-1', identity: { email: 'pat@example.invalid' },
    }));
  });

  test('an email that also names another recipient only counts when the address is in the list', async () => {
    const result = await run({
      leads: [[lead({ phone: null, email: 'pat@example.invalid' })], []],
      emails: [{ id: 'mail-1', gmail_thread_id: 't', to_address: 'patrick@example.invalid', cc_address: '', bcc_address: '', at: T(30) }],
    });
    expect(result.moved).toBe(0);
    expect(result.skipped).toEqual({ no_contact_evidence: 1 });
  });

  test('a visit booked for the linked customer moves the lead to contacted with visit_booked evidence', async () => {
    await run({ leads: [[lead({ customer_id: 'cust-1', phone: null })], [sharing({ id: 'lead-1', customer_id: 'cust-1', peer: '' })]], scheduled_services: [{ id: 'visit-1', customer_id: 'cust-1', at: T(45) }] });
    expect(markLeadContactedFromEvidence).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', evidenceType: 'visit_booked', evidenceId: 'visit-1', respondedAt: T(45),
    }));
  });
});

describe('lead contact sync: what does not count', () => {
  test('contact at or before first_contact_at does not move the lead', async () => {
    const result = await run({ leads: [[lead()], []], sms_log: [text({ at: FIRST }), text({ id: 'sms-2', at: T(-5) })] });
    expect(result.moved).toBe(0);
    expect(markLeadContactedFromEvidence).not.toHaveBeenCalled();
  });

  test('the call that created the lead is never its own evidence', async () => {
    const result = await run({ leads: [[lead()], []], call_log: [call({ origin_lead_id: 'lead-1' }), call({ id: 'call-2', relay_lead_id: 'lead-1' })] });
    expect(result.moved).toBe(0);
  });

  test('a call that started before first contact does not count even if it ended after', async () => {
    const result = await run({ leads: [[lead()], []], call_log: [call({ created_at: T(-2), at: T(3) })] });
    expect(result.moved).toBe(0);
  });

  test('two open leads on one phone: skipped and counted, never marked', async () => {
    const result = await run({ leads: [[lead()], [sharing({ id: 'lead-1' }), sharing({ id: 'lead-2' })]], sms_log: [text()] });
    expect(result.moved).toBe(0);
    expect(result.skipped).toEqual({ shared_phone: 1 });
    expect(markLeadContactedFromEvidence).not.toHaveBeenCalled();
  });

  test('a contact row on a different customer than the lead\'s: skipped', async () => {
    const result = await run({ leads: [[lead({ customer_id: 'cust-1' })], [sharing({ id: 'lead-1', customer_id: 'cust-1' })]], sms_log: [text({ customer_id: 'cust-2' })] });
    expect(result.skipped).toEqual({ customer_mismatch: 1 });
    expect(markLeadContactedFromEvidence).not.toHaveBeenCalled();
  });

  test('a text on the lead\'s own customer still counts', async () => {
    const result = await run({ leads: [[lead({ customer_id: 'cust-1' })], [sharing({ id: 'lead-1', customer_id: 'cust-1' })]], sms_log: [text({ customer_id: 'cust-1' })] });
    expect(result.moved).toBe(1);
  });

  test('an email linked to another customer: skipped', async () => {
    resolveEmailCustomerLink.mockResolvedValueOnce('cust-9');
    const result = await run({
      leads: [[lead({ phone: null, email: 'pat@example.invalid', customer_id: 'cust-1' })], []],
      emails: [{ id: 'mail-1', gmail_thread_id: 't', to_address: 'pat@example.invalid', cc_address: '', bcc_address: '', at: T(30) }],
    });
    expect(result.skipped).toEqual({ customer_mismatch: 1 });
  });

  test('a customer with two open leads cannot say which one a visit belongs to', async () => {
    const result = await run({
      leads: [[lead({ customer_id: 'cust-1', phone: null })], [sharing({ id: 'lead-1', customer_id: 'cust-1', peer: '' }), sharing({ id: 'lead-2', customer_id: 'cust-1', peer: '' })]],
      scheduled_services: [{ id: 'visit-1', customer_id: 'cust-1', at: T(45) }],
    });
    expect(result.skipped).toEqual({ multiple_open_leads_for_customer: 1 });
  });

  test('a lead a person returned to new by hand stays new', async () => {
    const result = await run({ leads: [[lead()], []], sms_log: [text()], lead_activities: [{ lead_id: 'lead-1' }] });
    expect(result.skipped).toEqual({ reopened_by_person: 1 });
  });

  test('a lead with no phone fragment match and no evidence stays new', async () => {
    const result = await run({ leads: [[lead({ phone: '555' })], []], sms_log: [text({ peer: '555' })] });
    expect(result.moved).toBe(0);
  });

  test('the write cap bounds one run', async () => {
    const leads = ['a', 'b', 'c'].map((id, i) => lead({ id, phone: `(941) 555-010${i}` }));
    const sms = leads.map((l, i) => text({ id: `sms-${i}`, peer: `941555010${i}` }));
    const result = await runLeadContactSync({ dbi: fakeDb({ leads: [leads, []], sms_log: sms }), mode: 'true', now: T(60), writeCap: 2 });
    expect(result.moved).toBe(2);
    expect(result.skipped.write_cap).toBe(1);
  });
});

describe('lead contact sync: walking a backlog across runs', () => {
  const two = { pageSize: 2, maxPages: 1 };
  const runPaged = (script) => runLeadContactSync({ dbi: fakeDb(script), mode: 'true', now: T(60), ...two });

  test('a run that stops at its page cap resumes after that page; the walk restarts at the newest once it ends', async () => {
    const newest = [lead({ id: 'n1', phone: '(941) 555-0111' }), lead({ id: 'n2', phone: '(941) 555-0112', first_contact_at: T(-1), cursor_at: 'cur-n2' })];
    const older = lead({ id: 'old', phone: '(941) 555-0100', first_contact_at: T(-5) });
    // Run 1: a full page of leads with no evidence (leads read, then the shared-identity read).
    const first = await runPaged({ leads: [newest, []] });
    expect(first.moved).toBe(0);
    expect(_test.resumeAfter()).toMatchObject({ id: 'n2', at: 'cur-n2' });
    // Run 2 resumes after n2: the older lead has a delivered staff text and moves.
    const second = await runPaged({ leads: [[older], []], sms_log: [text()] });
    expect(second.moved).toBe(1);
    expect(markLeadContactedFromEvidence).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'old' }));
    // The end of the walk (a short page) clears the place: the next run starts from the newest.
    expect(_test.resumeAfter()).toBe(null);
  });

  test('an empty page ends the walk and clears the place', async () => {
    await runPaged({ leads: [[lead({ id: 'a' }), lead({ id: 'b' })], []] });
    expect(_test.resumeAfter()).not.toBe(null);
    await runPaged({ leads: [[], []] });
    expect(_test.resumeAfter()).toBe(null);
  });
});

describe('lead contact sync: identity helpers', () => {
  test('usablePhoneKey keeps one line and drops fragments', () => {
    expect(_test.usablePhoneKey('(941) 555-0100')).toBe('9415550100');
    expect(_test.usablePhoneKey('+1 941 555 0100')).toBe('9415550100');
    expect(_test.usablePhoneKey('555-01')).toBe(null);
    expect(_test.usablePhoneKey(null)).toBe(null);
  });
});
