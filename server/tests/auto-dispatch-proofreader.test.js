// Move proofreader (owner 2026-10-09, "proofreader yes"): the record the code
// builds, and the code's judgment of the model's answer. The model itself is
// measured by the replay script, not here.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
// The one mail linkage rule (email-customer-link.js) has its own suites; here
// it answers from the row: `links_to` names the customer a send belongs to.
jest.mock('../services/email/email-customer-link', () => ({
  extractEmailAddresses: jest.requireActual('../services/email/email-customer-link').extractEmailAddresses,
  resolveEmailCustomerLink: jest.fn(async (_conn, row) => row.links_to || null),
  personSentFilter: (alias) => `SENT_ONLY(${alias})`,
}));

const {
  proofreadMove, judge, buildCustomerRecord, moveFacts, PROMPT_VERSION,
} = require('../services/auto-dispatch/proofreader');
const { MAX_ENTRY_CHARS, MAX_RECORD_CHARS } = require('../services/auto-dispatch/proofreader/record');
const { VERDICT_SCHEMA, SYSTEM_PROMPT, buildText } = require('../services/auto-dispatch/proofreader/prompt');
const { HARD_CASES, recordOf, scoreOf } = require('../services/auto-dispatch/proofreader/hard-cases');

// A knex-shaped conn over fixed tables. Every builder call is recorded; a
// table listed in `fail` rejects when read.
function fakeConn(tables, { fail = [] } = {}) {
  const calls = [];
  const conn = (table) => {
    const name = String(table).split(' ')[0];
    // Two filters are honored, on columns a fixture row carries: where({..})
    // equality and whereNull(column). Every other call is only recorded.
    const filters = [];
    const rows = () => (tables[name] || []).filter((row) => filters.every((keep) => keep(row)));
    const chain = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') {
          return (resolve, reject) => (fail.includes(name)
            ? Promise.reject(new Error(`${name} down`))
            : Promise.resolve(rows())).then(resolve, reject);
        }
        if (prop === 'first') return async () => (fail.includes(name) ? Promise.reject(new Error(`${name} down`)) : rows()[0] || null);
        return (...args) => {
          calls.push([name, prop, ...args]);
          if (prop === 'where' && args[0] && typeof args[0] === 'object') {
            filters.push((row) => Object.entries(args[0]).every(([key, value]) => !(key in row) || row[key] === value));
          }
          if (prop === 'whereNull') filters.push((row) => row[args[0]] == null);
          // A where/orWhere callback builds a nested group: run it on the same chain.
          if (typeof args[0] === 'function') args[0].call(chain, chain);
          return chain;
        };
      },
    });
    return chain;
  };
  conn.calls = calls;
  conn.raw = (sql) => sql;
  return conn;
}

const AS_OF = new Date('2026-10-05T08:10:00.000Z');
const TABLES = {
  customers: [{ email: 'pat@example.test', crm_notes: null, internal_notes: 'Prefers a text before arrival.', follow_up_notes: null, access_notes: 'Side gate code 4821, latch sticks.' }],
  sms_log: [
    { direction: 'inbound', message_body: 'Please always come on  Wednesdays.', message_type: 'inbound', admin_user_id: null, created_at: '2026-03-02T15:10:00.000Z' },
    { direction: 'outbound', message_body: 'No problem, Wednesdays it is.', message_type: 'manual', operator_sent: true, created_at: '2026-03-02T15:22:00.000Z' },
    { direction: 'outbound', message_body: 'Your technician is on the way.', message_type: 'tech_en_route', admin_user_id: null, created_at: '2026-04-01T13:00:00.000Z' },
  ],
  emails: [
    { id: 'm1', gmail_thread_id: 'th1', customer_id: 'c1', from_address: 'Pat <pat@example.test>', subject: 'Schedule', body_text: `${'x'.repeat(MAX_ENTRY_CHARS)} never before noon`, snippet: null, received_at: '2026-05-01T10:00:00.000Z' },
    // Sent mail is stored with no customer. m2 is ours to this customer (HTML only); m3 belongs to another customer; m4 to nobody.
    { id: 'm2', gmail_thread_id: 'th1', customer_id: null, from_address: 'office@example.test', to_address: 'pat@example.test', cc_address: '', bcc_address: '', subject: 'Re: Schedule', body_text: '', body_html: '<p>We will keep you on Wednesdays.</p>', snippet: 'We will keep', received_at: '2026-05-01T11:00:00.000Z', links_to: 'c1' },
    { id: 'm3', gmail_thread_id: 'th9', customer_id: null, from_address: 'office@example.test', to_address: 'joann.pat@example.test', cc_address: '', bcc_address: '', subject: 'Other', body_text: 'Fridays only for you.', snippet: null, received_at: '2026-05-02T11:00:00.000Z', links_to: 'c2' },
    { id: 'm4', gmail_thread_id: 'th1', customer_id: null, from_address: 'office@example.test', to_address: 'tech@example.test', cc_address: '', bcc_address: '', subject: 'Fwd: Schedule', body_text: 'Internal forward.', snippet: null, received_at: '2026-05-03T11:00:00.000Z', links_to: null },
  ],
  call_log: [
    { direction: 'inbound', transcription: 'Customer: afternoons only please.', recording_sid: 'RE1', created_at: '2026-06-01T10:00:00.000Z' },
    { direction: 'inbound', transcription: null, recording_sid: 'RE2', created_at: '2026-09-30T10:00:00.000Z' },
    { direction: 'outbound', transcription: null, recording_sid: null, created_at: '2026-09-01T10:00:00.000Z' },
  ],
  customer_interactions: [{ interaction_type: 'note', subject: 'Call back', body: 'Wants a morning visit next time only.', created_at: '2026-07-01T10:00:00.000Z' }],
  admin_notes: [],
  service_records: [{ technician_notes: 'Dog in yard.', created_at: '2026-07-07T16:00:00.000Z' }],
  reschedule_log: [
    { initiated_by: 'system', customer_response_text: 'YES', sms_responded_at: '2026-08-01T11:00:00.000Z', notes: 'program text', created_at: '2026-08-01T10:00:00.000Z' },
    { initiated_by: 'admin', customer_response_text: null, notes: 'Moved at the customer request', created_at: '2026-08-02T10:00:00.000Z' },
  ],
  scheduled_services: [{ id: 's1', recurring_parent_id: 'p1', notes: 'Ring the bell twice', internal_notes: 'Ring the bell twice' }],
};

describe('the customer record', () => {
  test('every source, undated notes first then oldest to newest, with who wrote each entry', async () => {
    const record = await buildCustomerRecord(fakeConn(TABLES), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.map((e) => e.id)).toEqual(record.entries.map((_e, i) => `E${i + 1}`));
    const dated = record.entries.filter((e) => e.at);
    expect(record.entries.slice(0, record.entries.length - dated.length).every((e) => e.at === null)).toBe(true);
    expect(dated.map((e) => e.at)).toEqual([...dated.map((e) => e.at)].sort());
    const by = (channel) => record.entries.filter((e) => e.channel === channel);
    expect(by('text').map((e) => e.from)).toEqual(['customer', 'staff', 'system']);
    expect(by('text')[0].text).toBe('Please always come on Wednesdays.'); // white space folded
    expect(by('call')).toHaveLength(1);
    expect(by('call')[0].from).toBe('both');
    expect(by('technician_note')).toHaveLength(1);
    expect(by('reschedule_reply').map((e) => e.text)).toEqual(['YES']);
    // A program's reschedule note is not staff words; a person's is.
    expect(by('note').map((e) => e.text)).toEqual(['Call back: Wants a morning visit next time only.', 'Moved at the customer request']);
    // The visit note that repeats on two columns appears once.
    expect(by('visit_note')).toHaveLength(1);
  });

  test('a recording with no transcript makes the record incomplete; a call with no recording does not', async () => {
    const record = await buildCustomerRecord(fakeConn(TABLES), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.unread).toEqual([{ channel: 'call', at: '2026-09-30T06:00:00-04:00', reason: 'not_transcribed' }]);
  });

  test('access codes never reach the record; a long text is split into parts, never cut', async () => {
    const record = await buildCustomerRecord(fakeConn(TABLES), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(JSON.stringify(record.entries)).not.toContain('4821');
    const parts = record.entries.filter((e) => e.channel === 'email' && e.from === 'customer');
    expect(parts.map((e) => e.text.slice(0, 15))).toEqual(['[part 1 of 2] S', '[part 2 of 2] x']);
    // The last words of the long body are in the record.
    expect(parts[1].text.endsWith('never before noon')).toBe(true);
    expect(record.split).toBe(1);
    expect(parts[0].split).toBeUndefined(); // a count, not a field the model reads
    expect(parts[0].ms).toBeUndefined();
    expect(record.tooLong).toBe(false);
  });

  test('every time is Eastern with its offset, and the order is by the instant', async () => {
    const tables = { ...TABLES, sms_log: [
      // 9:30 PM Eastern on Oct 1: the UTC date is already Oct 2.
      { direction: 'inbound', message_body: 'Can you come this Friday?', message_type: 'inbound', admin_user_id: null, created_at: '2026-10-02T01:30:00.000Z' },
      { direction: 'inbound', message_body: 'Winter text.', message_type: 'inbound', admin_user_id: null, created_at: '2026-01-15T15:00:00.000Z' },
    ] };
    const record = await buildCustomerRecord(fakeConn(tables), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    const texts = record.entries.filter((e) => e.channel === 'text');
    expect(texts.map((e) => e.at)).toEqual(['2026-01-15T10:00:00-05:00', '2026-10-01T21:30:00-04:00']);
  });

  test('a portal request is in the record as the customer\'s words', async () => {
    const conn = fakeConn({ ...TABLES, service_requests: [{ category: 'schedule_change', subject: 'Day', description: 'Never move me off Tuesdays.', created_at: '2026-08-10T10:00:00.000Z' }] });
    const record = await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    const request = record.entries.find((e) => e.channel === 'portal_request');
    expect(request).toMatchObject({ from: 'customer', text: 'schedule_change: Day: Never move me off Tuesdays.' });
    expect(conn.calls.some(([t, method, col, op, value]) => t === 'service_requests' && method === 'where' && col === 'created_at' && op === '<' && value === AS_OF)).toBe(true);
  });

  test('a reschedule reply is read only when the customer sent it before the move', async () => {
    const tables = { ...TABLES, reschedule_log: [
      { initiated_by: 'system', customer_response_text: 'EARLY', sms_responded_at: '2026-08-01T12:00:00.000Z', notes: null, created_at: '2026-08-01T10:00:00.000Z' },
      { initiated_by: 'system', customer_response_text: 'LATE', sms_responded_at: '2026-10-06T12:00:00.000Z', notes: null, created_at: '2026-10-04T10:00:00.000Z' },
      { initiated_by: 'system', customer_response_text: 'NO TIME', sms_responded_at: null, notes: null, created_at: '2026-08-03T10:00:00.000Z' },
    ] };
    const record = await buildCustomerRecord(fakeConn(tables), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    const replies = record.entries.filter((e) => e.channel === 'reschedule_reply');
    expect(replies.map((e) => [e.text, e.at])).toEqual([['EARLY', '2026-08-01T08:00:00-04:00']]);
  });

  test('only words written before the move: every dated source is bounded by asOf', async () => {
    const conn = fakeConn(TABLES);
    await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    for (const [table, column] of [['service_requests', 'created_at'], ['sms_log', 'created_at'], ['emails', 'received_at'], ['emails', 'created_at'], ['call_log', 'created_at'], ['customer_interactions', 'created_at'], ['admin_notes', 'created_at'], ['service_records', 'created_at'], ['reschedule_log', 'created_at']]) {
      expect(conn.calls.filter(([t, method, col, op, value]) => t === table && method === 'where' && col === column && op === '<' && value === AS_OF).length).toBeGreaterThan(0);
    }
  });

  test('our own replies are read too, and only the ones the shared mail linkage rule gives to this customer', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    resolveEmailCustomerLink.mockClear();
    const conn = fakeConn(TABLES);
    const record = await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    const emailCalls = conn.calls.filter(([t]) => t === 'emails');
    expect(emailCalls.some(([, method, col, values]) => method === 'whereIn' && col === 'gmail_thread_id' && values[0] === 'th1')).toBe(true);
    // The address match looks at To, Cc and Bcc, and is only a pre-filter.
    expect(emailCalls.some(([, method, sql, binds]) => method === 'orWhereRaw' && /to_address, cc_address, bcc_address/.test(sql) && binds[0] === 'pat@example.test')).toBe(true);
    const staffMail = record.entries.filter((e) => e.channel === 'email' && e.from === 'staff').map((e) => e.text);
    // Ours to this customer is read; a send the rule gives to another
    // customer, or to nobody (a mixed thread, an internal forward), is not.
    // m2 is HTML only: the whole body is read, not Gmail's short snippet.
    expect(staffMail).toEqual(['We will keep you on Wednesdays.']);
    // Only sent mail is a candidate: never a draft.
    expect(emailCalls.some(([, method, sql]) => method === 'whereRaw' && sql === 'SENT_ONLY(emails)')).toBe(true);
    expect(record.unread.filter((u) => u.channel === 'email')).toEqual([]);
  });

  test('a sent mail with no Cc/Bcc on file is never guessed: in the customer\'s thread it makes the record incomplete', async () => {
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    resolveEmailCustomerLink.mockClear();
    const old = (id, thread) => ({ id, gmail_thread_id: thread, customer_id: null, to_address: 'pat@example.test', cc_address: null, bcc_address: null, subject: 'Re', body_text: 'Old reply.', received_at: '2026-04-01T11:00:00.000Z', links_to: 'c1' });
    const record = await buildCustomerRecord(fakeConn({ ...TABLES, emails: [TABLES.emails[0], old('o1', 'th1'), old('o2', 'th-other')] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(resolveEmailCustomerLink).not.toHaveBeenCalled();
    expect(record.entries.some((e) => e.text.includes('Old reply.'))).toBe(false);
    expect(record.unread.filter((u) => u.channel === 'email')).toEqual([{ channel: 'email', at: '2026-04-01T07:00:00-04:00', reason: 'recipients_not_captured' }]);
  });

  test('a portal request revised after the as-of time is unread, not read as it is now', async () => {
    const request = (description, updated_at) => ({ category: 'schedule_change', subject: 'Day', description, created_at: '2026-08-10T10:00:00.000Z', updated_at });
    const record = await buildCustomerRecord(fakeConn({ ...TABLES, service_requests: [request('Old words.', '2026-08-11T10:00:00.000Z'), request('Words added later.', '2026-10-06T10:00:00.000Z')] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.filter((e) => e.channel === 'portal_request').map((e) => e.text)).toEqual(['schedule_change: Day: Old words.']);
    expect(record.unread).toEqual(expect.arrayContaining([{ channel: 'portal_request', at: '2026-08-10T06:00:00-04:00', reason: 'revised_later' }]));
  });

  test('an email entry holds only the words that mail added: no quoted thread, no inherited subject', async () => {
    const reply = { id: 'r1', gmail_thread_id: 'th1', customer_id: 'c1', from_address: 'pat@example.test', subject: 'Re: Schedule', body_text: 'Any day works now.\n\nOn Fri, May 1, 2026 at 10:00 AM Office <office@example.test> wrote:\n> Tuesdays only, as you asked.', received_at: '2026-06-01T10:00:00.000Z' };
    const first = { id: 'a0', gmail_thread_id: 'th1', customer_id: 'c1', from_address: 'pat@example.test', subject: 'Schedule', body_text: 'Hello.', received_at: '2026-05-01T09:00:00.000Z' };
    const withFirst = await buildCustomerRecord(fakeConn({ ...TABLES, emails: [first, reply] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(withFirst.entries.filter((e) => e.channel === 'email').map((e) => e.text)).toEqual(['Schedule: Hello.', 'Any day works now.']);
    // The thread is read as it stood at the move: stored and received before it.
    const threadRead = fakeConn({ ...TABLES, emails: [first, reply] });
    await buildCustomerRecord(threadRead, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    const bounds = threadRead.calls.filter(([table, method, , op]) => table === 'emails' && method === 'where' && op === '<').map(([, , column]) => column);
    expect(bounds.filter((column) => column === 'created_at').length).toBeGreaterThanOrEqual(2);
  });

  test('a text is staff words only by the operator provenance rule, never by message_type manual alone', async () => {
    const text = (extra) => ({ direction: 'outbound', message_body: 'See you Tuesday.', created_at: '2026-04-02T13:00:00.000Z', ...extra });
    const record = await buildCustomerRecord(fakeConn({ ...TABLES, sms_log: [
      text({ message_type: 'manual', operator_sent: false }), text({ message_type: 'ai_approved', operator_sent: false }), text({ message_type: 'manual', operator_sent: true }),
    ] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.filter((e) => e.channel === 'text').map((e) => e.from)).toEqual(['system', 'staff', 'staff']);
  });

  test('an outbound text created in the minutes before the move may not have been sent yet: unread', async () => {
    const record = await buildCustomerRecord(fakeConn({ ...TABLES, sms_log: [
      { direction: 'outbound', message_body: 'We will come Friday.', message_type: 'manual', operator_sent: true, created_at: '2026-10-05T08:05:00.000Z' },
      { direction: 'inbound', message_body: 'Fridays never work.', message_type: 'inbound', created_at: '2026-10-05T08:06:00.000Z' },
    ] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.filter((e) => e.channel === 'text').map((e) => e.text)).toEqual(['Fridays never work.']);
    expect(record.unread).toEqual(expect.arrayContaining([{ channel: 'text', at: '2026-10-05T04:05:00-04:00', reason: 'delivery_not_settled' }]));
  });

  test('a portal request touched since it was made carries no date; our sent mail is linked as the thread stood then', async () => {
    const record = await buildCustomerRecord(fakeConn({ ...TABLES,
      service_requests: [{ category: 'schedule_change', subject: 'Day', description: 'Mondays now.', created_at: '2026-01-10T10:00:00.000Z', updated_at: '2026-10-01T10:00:00.000Z' }],
      emails: [{ id: 'e1', gmail_thread_id: 'th1', customer_id: 'c1', from_address: 'pat@example.test', subject: 'Hi', body_text: 'Hello.', received_at: '2026-06-01T10:00:00.000Z' },
        { id: 'e2', gmail_thread_id: 'th1', customer_id: null, to_address: 'a@example.test', cc_address: '', bcc_address: '', subject: 'Re: Hi', body_text: 'Tuesdays, as agreed.', received_at: '2026-06-02T10:00:00.000Z', links_to: 'c1' }],
    }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.find((e) => e.channel === 'portal_request').at).toBeNull();
    expect(record.unread.some((u) => u.reason === 'sender_not_verified')).toBe(false);
    const { resolveEmailCustomerLink } = require('../services/email/email-customer-link');
    expect(resolveEmailCustomerLink).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ id: 'e2' }), { asOf: AS_OF });
  });

  test('a linked mail not from the customer\'s own address is unread; an operator\'s request row and a tagged call copy are not read', async () => {
    const conn = fakeConn({ ...TABLES,
      emails: [{ id: 'n1', gmail_thread_id: 'th5', customer_id: 'c1', from_address: 'Pat <someone@elsewhere.test>', subject: 'Days', body_text: 'Tuesdays only.', received_at: '2026-06-01T10:00:00.000Z' }],
      property_preferences: [{ hoa_timing_restrictions: 'Vendors Tuesdays only.', created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-05-01T10:00:00.000Z' }],
      admin_notes: [{ note_text: null, created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-10-06T10:00:00.000Z' }] });
    const record = await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.filter((e) => e.channel === 'email')).toEqual([]);
    expect(record.unread).toEqual(expect.arrayContaining([
      { channel: 'email', at: '2026-06-01T06:00:00-04:00', reason: 'sender_not_verified' },
      { channel: 'note', at: '2026-05-01T06:00:00-04:00', reason: 'revised_later' }, // cleared after the move
    ]));
    expect(record.entries.filter((e) => e.channel === 'property_note').map((e) => e.text)).toEqual(['hoa timing restrictions: Vendors Tuesdays only.']);
    expect(conn.calls.some(([t, method, sql]) => t === 'service_requests' && method === 'whereRaw' && /source.*'admin', 'voice_agent'/.test(sql))).toBe(true);
    expect(conn.calls.some(([t, method, col, values]) => t === 'customer_interactions' && method === 'whereNotIn' && col === 'interaction_type' && values.includes('inbound_call'))).toBe(true);
  });

  test('a technician note names the service it was written on; a visit\'s history-only members are not part of the move', async () => {
    const conn = fakeConn({ ...TABLES, service_records: [{ technician_notes: 'Customer requests Tuesdays.', service_type: 'Lawn', created_at: '2026-07-07T16:00:00.000Z' }],
      scheduled_services: [{ id: 's1', recurring_parent_id: 'p1', visit_id: 'v1', service_type: 'Pest', notes: null, internal_notes: null }] });
    const record = await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.filter((e) => e.channel === 'technician_note').map((e) => e.text)).toEqual(['[Lawn visit] Customer requests Tuesdays.']);
    expect(conn.calls.some(([t, method, col, values]) => t === 'scheduled_services' && method === 'whereNotIn' && col === 'status' && ['cancelled', 'skipped', 'no_show', 'rescheduled'].every((status) => values.includes(status)))).toBe(true);
  });

  test('a property note cleared after the as-of time is unread, not absent', async () => {
    const record = await buildCustomerRecord(fakeConn({ ...TABLES, property_preferences: [{ special_instructions: null, access_notes: '', created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-10-06T10:00:00.000Z' }] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.unread).toEqual(expect.arrayContaining([{ channel: 'property_note', at: '2026-05-01T06:00:00-04:00', reason: 'revised_later' }]));
  });

  test('a staff or technician note edited after the as-of time is unread; the visit\'s notes are unread when the visit is gone', async () => {
    const tables = { ...TABLES,
      admin_notes: [{ note_text: 'Edited later.', created_at: '2026-07-01T10:00:00.000Z', updated_at: '2026-10-06T10:00:00.000Z' }],
      service_records: [{ technician_notes: 'Afternoons only (added later).', created_at: '2026-07-07T16:00:00.000Z', updated_at: '2026-10-06T10:00:00.000Z' }],
      scheduled_services: [] };
    const record = await buildCustomerRecord(fakeConn(tables), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(JSON.stringify(record.entries)).not.toMatch(/later/);
    expect(record.unread).toEqual(expect.arrayContaining([
      { channel: 'note', at: '2026-07-01T06:00:00-04:00', reason: 'revised_later' },
      { channel: 'technician_note', at: '2026-07-07T12:00:00-04:00', reason: 'revised_later' },
      { channel: 'visit_note', reason: 'visit_not_found' },
    ]));
    const noVisit = await buildCustomerRecord(fakeConn(TABLES), { customerId: 'c1', serviceId: null, asOf: AS_OF });
    expect(noVisit.unread).toEqual(expect.arrayContaining([{ channel: 'visit_note', reason: 'visit_not_found' }]));
  });

  test('a call that was not this customer, and a transcript written after the as-of time, are not evidence', async () => {
    const call = (extra) => ({ direction: 'inbound', recording_sid: 'RE9', created_at: '2026-06-01T10:00:00.000Z', updated_at: '2026-06-01T10:05:00.000Z', ...extra });
    const record = await buildCustomerRecord(fakeConn({ ...TABLES, call_log: [
      call({ transcription: 'Mine: afternoons only.' }),
      call({ transcription: 'Wrong number outcome.', call_outcome: 'wrong_number' }),
      call({ transcription: 'Spam status.', processing_status: 'spam' }),
      call({ transcription: 'Vendor by V2.', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner' }) }),
      call({ transcription: 'Misdial by extraction.', ai_extraction: JSON.stringify({ call_type: 'wrong_number' }) }),
      call({ transcription: 'Transcribed later.', updated_at: '2026-10-06T10:00:00.000Z' }),
    ] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.filter((e) => e.channel === 'call').map((e) => e.text)).toEqual(['Mine: afternoons only.']);
    expect(record.unread).toEqual([{ channel: 'call', at: '2026-06-01T06:00:00-04:00', reason: 'revised_later' }]);
  });

  test('a model-written call summary on the timeline is not read; the customer\'s portal property notes are', async () => {
    const conn = fakeConn({ ...TABLES,
      property_preferences: [{ special_instructions: 'Never Fridays, the gardener is here.', access_notes: null, updated_at: '2026-05-01T10:00:00.000Z' }] });
    const record = await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(conn.calls.some(([t, method, col, values]) => t === 'customer_interactions' && method === 'whereNotIn' && col === 'interaction_type' && values.includes('call'))).toBe(true);
    expect(record.entries.filter((e) => e.channel === 'property_note')).toEqual([expect.objectContaining({ from: 'customer', at: null, text: 'special instructions: Never Fridays, the gardener is here.' })]);
    const later = await buildCustomerRecord(fakeConn({ ...TABLES, property_preferences: [{ special_instructions: 'Edited later.', created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-10-06T10:00:00.000Z' }] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(later.entries.some((e) => e.channel === 'property_note')).toBe(false);
    expect(later.unread).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'property_note', reason: 'revised_later' })]));
  });

  test('a mail stored in the 15 minutes before the move has an unsettled subject: the record is incomplete', async () => {
    const fresh = { id: 'f1', gmail_thread_id: 'th7', customer_id: 'c1', from_address: 'pat@example.test', subject: 'Never schedule Fridays', body_text: '', received_at: '2026-10-05T08:00:00.000Z', created_at: new Date(new Date(AS_OF).getTime() - 5 * 60 * 1000).toISOString() };
    const record = await buildCustomerRecord(fakeConn({ ...TABLES, emails: [fresh] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.unread).toEqual(expect.arrayContaining([{ channel: 'email', at: '2026-10-05T04:00:00-04:00', reason: 'subject_not_settled' }]));
  });

  test('the move facts: the promised two-hour arrival window, and a technician-only change says so', () => {
    const slot = (date, windowStart, windowEnd, technician) => ({ date, windowStart, windowEnd, technician });
    // A three-hour job at 09:00 is still promised 09:00-11:00.
    const long = moveFacts({ serviceType: 'Lawn', from: slot('2026-10-07', '09:00', '12:00', 'Sam'), to: slot('2026-10-08', '13:00:00', '16:00:00', 'Sam') });
    expect([long.from.arrival_window, long.to.arrival_window, long.change]).toEqual(['09:00-11:00', '13:00-15:00', 'different day']);
    const sameDay = moveFacts({ from: slot('2026-10-07', '09:00', '11:00', 'Sam'), to: slot('2026-10-07', '13:00', '15:00', 'Sam') });
    expect(sameDay.change).toBe('same day, different time');
    const techOnly = moveFacts({ from: slot('2026-10-07', '09:00', '11:00', 'Sam'), to: slot('2026-10-07', '09:00', '12:00', 'Alex') });
    expect(techOnly.change).toBe('same day and same time, different technician');
    expect(moveFacts({ from: slot('2026-10-07', null, null, null), to: slot('2026-10-08', '09:00', '11:00', 'Sam') }).from.arrival_window).toBe('no time set');
  });

  test('a grouped stop: every member\'s service and series notes are in the record; a note can be its subject alone', async () => {
    const conn = fakeConn({ ...TABLES,
      scheduled_services: [{ id: 's1', recurring_parent_id: 'p1', visit_id: 'v1', service_type: 'Pest', notes: 'Pest note', internal_notes: null }, { id: 's2', recurring_parent_id: 'p2', visit_id: 'v1', service_type: 'Lawn', notes: 'Lawn: Tuesdays only', internal_notes: null }],
      customer_interactions: [{ interaction_type: 'note', subject: 'Afternoons only', body: null, created_at: '2026-07-01T10:00:00.000Z' }] });
    const record = await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.serviceTypes).toEqual(['Pest', 'Lawn']);
    expect(record.entries.filter((e) => e.channel === 'visit_note').map((e) => e.text)).toEqual(['Pest note', 'Lawn: Tuesdays only']);
    expect(conn.calls.some(([t, method, col, ids]) => t === 'scheduled_services' && method === 'whereIn' && col === 'id' && ids.join() === 'p1,p2,s1,s2')).toBe(true);
    // Another occurrence's note is about that visit: the series' other rows are never read.
    expect(conn.calls.some(([t, method, col]) => t === 'scheduled_services' && method === 'orWhereIn' && col === 'recurring_parent_id')).toBe(false);
    expect(record.entries.filter((e) => e.channel === 'note').map((e) => e.text)).toContain('Afternoons only');
  });

  test('what the customer told the portal assistant is in the record', async () => {
    const conn = fakeConn({ ...TABLES, agent_messages: [
      { role: 'user', content: 'Never schedule me on Tuesdays.', created_at: '2026-09-01T15:00:00.000Z' },
      { role: 'assistant', content: 'Noted.', created_at: '2026-09-01T15:00:05.000Z' },
    ] });
    const record = await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.entries.filter((e) => e.channel === 'portal_chat').map((e) => [e.from, e.text])).toEqual([['customer', 'Never schedule me on Tuesdays.'], ['system', 'Noted.']]);
    expect(conn.calls.some(([t, method, col, op, value]) => t === 'agent_messages' && method === 'where' && col === 'agent_messages.created_at' && op === '<' && value === AS_OF)).toBe(true);
    expect(conn.calls.some(([t, method, col, value]) => t === 'agent_messages' && method === 'where' && col === 'agent_sessions.customer_id' && value === 'c1')).toBe(true);
  });

  describe('a time or a day in the same sentence as an access code', () => {
    const { maskHidTime } = require('../services/auto-dispatch/proofreader/record')._internals;
    const { redactAccessCodes } = require('../services/context-aggregator');
    const hid = (text) => maskHidTime(text, redactAccessCodes(text));

    test.each([
      'Gate code 4821, not before 10am please',
      'CODE 4821 FRIDAYS ONLY',
      'Gate code 4821 and never before 9',
      'Lockbox code 5521, 9:30 works',
      'The access code 4821 works 7-7',
      'Gate code 4821, only between 9 and 11',
      'Gate code 4821, no earlier than 9',
      'Gate code 4821, come at 2 o\'clock',
      'Gate code 4821, 3 or later is best',
      'Gate code 4821, any time past 3',
      // A day-word credential AND a real statement: the statement still counts.
      'Gate code Friday, never before 10am',
      'Friday is the gate code, never before 10am',
      'CODE 4821 DO NOT COME BEFORE NINE',
      'No gate code after 9',
      'CODE 4821, AT NINE O\'CLOCK ONLY',
      // A passphrase of day or time words cannot be told from a time statement: the safe side is a person.
      'Gate password Friday morning',
      'Gate code 4821, AFTER LUNCH ONLY',
      'CODE 4821 BEFORE SUNSET',
      'Gate code 4821, TOMORROW ONLY',
      'CODE 4821 NOT ON HOLIDAYS',
      'CODE 4821 NEXT WEEK',
      'ACCESS CODE 4821 EXPIRES 10/20',
      'CODE 4821 UNTIL OCT 20',
      'Gate code 4821 expires October 20th',
      'Access code expires 10/20',
      'Gate code 4821, PM ONLY',
      'Friday is when the gate code works',
      'Gate code 4821 expires 2026-10-20',
      'Gate code 4821, 10 in the morning only',
      'CODE 4821, 9 SHARP',
      'Gate code 4821 expires the 20th',
      'Gate code 4821, need 7 days notice',
      'Gate code 4821 changes every 30 days',
      'Gate code WEEKDAYS ONLY',
      'GATE CODE 4821, AM ONLY',
      'Gate code 4821, BEFORE lunch only',
      'Gate code 4821, TEN THIRTY in the morning only',
      'Gate code 4821, NINE in the morning',
      'Gate code 4821 expires on 10/20',
      'Friday was the gate code, MONDAYS ONLY',
      'Gate code 4821, QUARTER TO TEN ONLY',
      'Gate code WEEKDAYS, ONLY',
      'Gate code WEEKDAYS (ONLY)',
      'Gate code 4821, need TWO DAYS NOTICE',
      'Gate code 4821, ONE WEEK NOTICE',
      'Gate code 4821 changes every TWO WEEKS',
      'Gate code 4821 expires in TWO DAYS',
      'Gate code 4821, do not arrive before 1400 hours',
      'CODE 4821, 0800 HRS ONLY',
      'GATE CODE 4821, ONLY ON THE 20TH',
      'Gate code 4821, only on 10/20',
      'Gate code 4821, NOT ON 2026-10-20',
      'Gate code 4821, except OCT 20',
      'Gate code 4821, requires 48-hour notice',
      'Gate code 4821, on 10/20 only',
      'GATE CODE 4821, EVERY OTHER WEEK ONLY',
      'Gate code 4821, BEFORE noon only',
      'Gate code 4821, BY Friday',
      'Gate code 4821, around 10ish',
      'Gate code 4821, 10-ish',
      'Gate code 4821, need 2 business days notice',
      'Gate code 4821, 10 A.M. ONLY',
      'Gate code 4821, 10 AM ONLY',
      'Gate code 4821, every OTHER Tuesday',
      'Gate code 4821, NINE A.M. ONLY',
      'Gate code 4821, TWO AND A HALF HOURS NOTICE',
      'Gate code 4821 expires 20 October',
      'Gate code 4821, AFTER HOURS ONLY',
      'Gate code 4821, NEVER Fridays',
      'Gate code 4821, TEN TO TWO ONLY',
      'Gate code 4821, NEVER WEEKENDS',
      'GATE CODE 4821, NINE EARLIEST',
      'Gate code 4821, FIFTEEN TO TWO ONLY',
      'Gate code 4821, 2 days minimum notice',
      'Gate code 4821 expires 20 May',
      'Gate code 4821, END OF DAY ONLY',
      'Gate code 4821, NIGHT ONLY',
      'Gate code 4821, appointment time 9 only',
      'Gate code 4821 expires 20 May only',
      'Gate code 4821, FIRST APPOINTMENT ONLY',
      'TUESDAY is available with gate code 4821',
      'Gate code 4821, need 30 minutes notice',
      'Gate code 4821, 9 works for us',
      'Gate code 4821, TEN ONLY',
      'Gate code 4821, MIDDAY ONLY',
      'Gate code 4821, 0800 ONLY',
      'Gate code 4821 VALID THROUGH OCTOBER',
      'Gate code 4821, 2:30ish only',
      'Gate code 4821, 10/31 works',
      'Gate code 4821, THIRTY MINUTES NOTICE',
      'Gate code 4821, 1st appointment only',
      'GATE CODE 4821 EXPIRES 20 OCTOBER',
      'Gate code 4821 is valid for 30 days',
      'Gate code 4821 expires after 30 days',
      'GATE CODE 4821 ACCESS ENDS OCTOBER 20',
      'Gate code 4821 changes on 11/1',
      'Gate code 4821, HALF HOUR NOTICE',
      'Gate code 4821 VALID THROUGH OCTOBER 2026',
      'Gate code 4821, GIVE US 30 MINUTES HEADS UP',
      'Gate code 4821, scheduled for 9',
      'Gate code 4821, AS EARLY AS 9',
      'Gate code 4821, AN HOUR AND A HALF NOTICE',
      'GATE CODE 4821, VALID TILL END OF OCTOBER',
      'Gate code 4821, SCHEDULE FOR TUESDAY',
      "Gate code 4821, CAN'T DO FRIDAY",
      'Gate code 4821 VALID THROUGH 2026',
      'Gate code 4821, need 30 minutes warning',
      'Gate code 4821, 2 days lead time',
      'Gate code 4821, LUNCH ONLY',
      "GATE CODE 4821, TUESDAY DOESN'T WORK",
      'Gate code 4821, VALID FOR ONE HOUR',
      'Gate code 4821, AFTER WORK ONLY',
      'Gate code 4821, ON MONDAY',
      'Gate code 4821, MONDAY WORKS',
      'CODE 4821 MON-FRI ONLY',
      'CODE 4821 SAT ONLY',
      'Gate code 4821, PM ONLY',
      'Gate code 4821, BUSINESS HOURS ONLY',
      'CODE 4821 OFFICE HOURS',
      'Gate code 4821, never before 9 please',
    ])('the mask hides it: %s', (text) => {
      expect(hid(text)).toBe(true);
      expect(redactAccessCodes(text)).not.toContain('4821');
    });

    test.each([
      'Side gate code 4821, latch sticks.',
      'The gate code is 1234. Never on Fridays.',
      'Please come Tuesday at 2pm',
      // Lowercase words outside the code slot are not masked: the model reads them.
      'Gate code 4821, come at nine o\'clock',
      'No codes here, any day is fine',
      // The mask also takes the day numbers of a note's date stamps: not a time statement.
      '[call Fri Aug 14] Gate code: 4821.',
      '[2026-10-09 from messages] Gate code 4821 is unconfirmed',
      'Community gate code 4821# given by the owner 10/1.',
      // The credential itself is a day or a time word: not a statement about when.
      'Gate code Friday',
      'Gate password is noon',
      'The garage code: sunday',
      'Friday is the gate code',
      // A quantity is not a time.
      'Gate code 4821, dog weighs about 50 lbs',
      'Gate code 4821, about 5 dogs roam the yard',
      'Gate code 4821, lot is about 5/8 acre',
      'Gate code 4821, the fence is 6 feet tall',
      'GATE CODE 4821 I AM THE OWNER',
      'Gate code 4821, good 10/10 service',
      'Gate code 4821, contact PM for access',
      'Gate code 4821, spoke with owner on 10/10',
      'Gate code 4821, about THREE acres',
      'Gate code 4821, got it from ONE of the owners',
      'Gate code 4821, house 1400 on the left',
      'GATE CODE 4821, DOG GETS DAILY MEDICATION',
      'Gate code 4821, only 2 dogs roam the yard',
      'Gate code 4821, PM approved access',
      'GATE CODE 4821, DOGS MAY BARK',
      'Gate code 4821, NIGHT LIGHT IS BROKEN',
      'Gate code 4821, mix ratio 1:10',
      '[CALL FRI AUG 14] Gate code: 4821.',
      'Gate code 4821, ONLY JANITOR HAS KEY',
      'Gate code 4821, FULL SUN IN BACK YARD',
      'Gate code 4821, OWNER CALLED MONDAY',
      'Gate code 4821, DOG EATS BREAKFAST INSIDE',
      'Gate code 4821, OWNER IS AT WORK',
      'Gate code 4821, KEY IS AT SCHOOL',
      'Gate code 4821, SPOKE TO PM',
      'Gate code 4821, ask MANAGER\nFriday works.',
      'Gate code 4821, ask MANAGER. Friday works.',
      'Gate code 4821, owner called YESTERDAY',
      'Gate code 4821, owner called TODAY about the bill',
      'Friday is the front door access code',
      'Gate code 4821, the latch opens after 5 seconds of pressing',
      'Noon is the gate password',
    ])('nothing about when is hidden: %s', (text) => {
      expect(hid(text)).toBe(false);
    });

    test('a long stored text is scanned in bounded time (no retry at every byte)', () => {
      const text = `Gate code 1234. ${'A'.repeat(64 * 1024)}`;
      // A long run of spaces: the record collapses white space before the mask
      // runs (record.js clean), so only this check sees it raw. Timed alone.
      const spaces = `Gate code${' '.repeat(32 * 1024)}!`;
      const spacesMasked = redactAccessCodes(spaces.replace(/\s+/g, ' '));
      const started = Date.now();
      hid(text);
      maskHidTime(spaces, spacesMasked);
      expect(Date.now() - started).toBeLessThan(500);
      // A text past the record's limit is not scanned: the record is too long anyway.
      const huge = `Gate code 1234. today ${'x '.repeat(200000)}`;
      expect(maskHidTime(huge, huge.replace('1234', '[redacted]'))).toBe(false);
      // ...unless the mask made it short: a long credential run hides a statement, unscanned.
      const longCode = `Gate code ${'A'.repeat(300000)}1 TOMORROW ONLY`;
      expect(maskHidTime(longCode, redactAccessCodes(longCode))).toBe(true);
    });

    test('one record shares one scan budget: a text past what is left is not scanned and counts as not fully read', async () => {
      const long = `Gate code 4821. ${'word '.repeat(70000)}`; // 350 KB raw, past the whole budget
      const record = await buildCustomerRecord(fakeConn({ ...TABLES, customers: [{ ...TABLES.customers[0], access_notes: long }] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
      expect(record.unread.some((u) => u.reason === 'time_masked')).toBe(true);
      // The flag never reaches the returned entries.
      expect(record.entries.every((row) => !('maskedTime' in row))).toBe(true);
    });

    test('a day the one-line mask hides on a second line is listed as not fully read', async () => {
      const note = 'Gate code 4821, ask MANAGER\nFRIDAY WORKS.';
      const record = await buildCustomerRecord(fakeConn({ ...TABLES, customers: [{ ...TABLES.customers[0], access_notes: note }] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
      expect(JSON.stringify(record.entries)).not.toContain('FRIDAY');
      expect(record.unread.some((u) => u.reason === 'time_masked')).toBe(true);
    });

    test('an entry both mask steps change is charged once against the scan budget', async () => {
      // The first step masks 4821; only the one-line step masks 5555 (split across lines).
      const note = `Gate code 4821\n${'word '.repeat(32000)}\n5555 is the\ngate code`;
      const record = await buildCustomerRecord(fakeConn({ ...TABLES, customers: [{ ...TABLES.customers[0], access_notes: note }] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
      expect(record.tooLong).toBe(false);
      expect(record.unread.some((u) => u.reason === 'time_masked')).toBe(false);
    });

    test('a code split across lines is still masked in the text the model reads', async () => {
      const note = 'Front door: 4821 is the\ngate code';
      const record = await buildCustomerRecord(fakeConn({ ...TABLES, customers: [{ ...TABLES.customers[0], access_notes: note }] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
      expect(JSON.stringify(record.entries)).not.toContain('4821');
    });

    test('the entry is read with the code masked and listed as not fully read, so the verdict is never allow', async () => {
      const tables = { ...TABLES, customers: [{ ...TABLES.customers[0], access_notes: 'Gate code 4821, not before 10am please' }] };
      const record = await buildCustomerRecord(fakeConn(tables), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
      expect(JSON.stringify(record.entries)).not.toContain('4821');
      expect(record.unread).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'time_masked' })]));
      expect(record.entries.every((row) => !('maskedTime' in row))).toBe(true);
      expect(judge({ verdict: 'allow', entry_id: '', quote: '', reason: 'fine' }, record)).toMatchObject({ verdict: 'unknown', why: 'record_incomplete' });
    });
  });

  test('a source that cannot be read is listed as unread and the rest is still built', async () => {
    const record = await buildCustomerRecord(fakeConn(TABLES, { fail: ['sms_log', 'call_log'] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.unread).toEqual(expect.arrayContaining([{ channel: 'text', reason: 'read_failed' }, { channel: 'call', reason: 'read_failed' }]));
    // The log names the source and the error's kind, never the error's message (it can carry query bindings).
    const logged = require('../services/logger').warn.mock.calls.map((call) => call[0]).join(' ');
    expect(logged).toContain('could not read text: Error');
    expect(logged).not.toContain('sms_log down');
    expect(record.entries.some((e) => e.channel === 'email')).toBe(true);
    const noFile = await buildCustomerRecord(fakeConn(TABLES, { fail: ['customers'] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(noFile.unread).toEqual(expect.arrayContaining([{ channel: 'customer_file_note', reason: 'read_failed' }]));
  });
});

describe('the code judges the answer', () => {
  const record = {
    entries: [
      { id: 'E1', channel: 'text', from: 'customer', at: null, text: 'Please always come on Wednesdays, it’s the only day I am home.' },
      { id: 'E2', channel: 'text', from: 'staff', at: null, text: 'Sure.' },
    ],
    unread: [],
  };
  const answer = (over) => ({ verdict: 'hold', entry_id: 'E1', quote: 'always come on Wednesdays', reason: 'The new day is Monday.', ...over });

  test('a hold stands only with a quote found word for word in the entry it names', () => {
    expect(judge(answer(), record)).toMatchObject({ verdict: 'hold', why: 'quoted_statement', entry_id: 'E1', quote: 'always come on Wednesdays' });
    // Case, white space and typographic quote marks do not matter.
    expect(judge(answer({ quote: "ALWAYS come on   wednesdays, it's the only day" }), record).verdict).toBe('hold');
    for (const bad of [{ quote: 'never on Mondays' }, { entry_id: 'E2' }, { entry_id: 'E9' }, { quote: '' }, { quote: '   ' }]) {
      expect(judge(answer(bad), record)).toMatchObject({ verdict: 'unknown', why: 'hold_without_quote', model_verdict: 'hold' });
    }
  });

  test('an allow on an incomplete record is unknown; a hold on one still holds', () => {
    const incomplete = { ...record, unread: [{ channel: 'call', reason: 'not_transcribed' }] };
    expect(judge(answer({ verdict: 'allow', entry_id: '', quote: '' }), incomplete)).toMatchObject({ verdict: 'unknown', why: 'record_incomplete', model_verdict: 'allow' });
    expect(judge(answer(), incomplete).verdict).toBe('hold');
    expect(judge(answer({ verdict: 'allow', entry_id: '', quote: '' }), record)).toMatchObject({ verdict: 'allow', why: 'nothing_breaks' });
  });

  test('the model\'s own unknown stays unknown, with its evidence when the quote is real', () => {
    expect(judge(answer({ verdict: 'unknown' }), record)).toMatchObject({ verdict: 'unknown', why: 'model_unsure', entry_id: 'E1' });
    expect(judge(answer({ verdict: 'unknown', quote: 'not in the record' }), record)).toMatchObject({ verdict: 'unknown', why: 'model_unsure', entry_id: null });
  });

  test('an allow that names an entry or a quote contradicts itself: unknown', () => {
    expect(judge({ verdict: 'allow', entry_id: 'E1', quote: 'Wednesdays', reason: 'fine' }, { entries: [{ id: 'E1', text: 'Wednesdays only' }], unread: [] })).toMatchObject({ verdict: 'unknown', why: 'bad_answer' });
    expect(judge({ verdict: 'allow', entry_id: ' ', quote: '', reason: 'fine' }, { entries: [], unread: [] })).toMatchObject({ verdict: 'allow' });
  });

  test('a malformed answer is unknown, never allow', () => {
    for (const bad of [null, {}, { verdict: 'yes' }, { verdict: 'allow' }, { verdict: 'allow', entry_id: 1, quote: '', reason: '' }]) {
      expect(judge(bad, record)).toMatchObject({ verdict: 'unknown', why: 'bad_answer' });
    }
  });
});

describe('one model call', () => {
  const record = recordOf(HARD_CASES[0]);
  const move = moveFacts(HARD_CASES[0].move);
  const route = { provider: 'anthropic', model: 'test-model' };
  const ok = (json) => ({ dispatch: jest.fn(async () => ({ ok: true, json, usage: { input_tokens: 10, output_tokens: 2 } })) });

  test('the call is one leg with the schema, the lane and the prompt version; the record goes as JSON data', async () => {
    const llm = ok({ verdict: 'allow', entry_id: '', quote: '', reason: 'Nothing about timing.' });
    const got = await proofreadMove({ move, record }, { route, llm });
    expect(got).toMatchObject({ verdict: 'allow', model: 'test-model', prompt_version: PROMPT_VERSION, usage: { input_tokens: 10 } });
    const [leg, payload] = llm.dispatch.mock.calls[0];
    expect(leg).toBe(route);
    expect(payload).toMatchObject({ system: SYSTEM_PROMPT, jsonMode: true, jsonSchema: VERDICT_SCHEMA, laneId: 'auto_dispatch_proofreader', promptVersion: PROMPT_VERSION });
    expect(JSON.parse(payload.text)).toEqual(JSON.parse(buildText({ move, record })));
    expect(JSON.parse(payload.text).move.from).toMatchObject({ weekday: 'Wednesday', arrival_window: '10:00-12:00' });
    // No instruction text rides in the user turn beside the data.
    expect(Object.keys(JSON.parse(payload.text))).toEqual(['move', 'record']);
  });

  test('a failed call, a thrown call and a refusal are unknown', async () => {
    const failed = { dispatch: jest.fn(async () => ({ ok: false, reason: 'anthropic_timeout' })) };
    expect(await proofreadMove({ move, record }, { route, llm: failed })).toMatchObject({ verdict: 'unknown', why: 'model_failed', reason: 'anthropic_timeout' });
    const thrown = { dispatch: jest.fn(async () => { throw new Error('boom'); }) };
    expect(await proofreadMove({ move, record }, { route, llm: thrown })).toMatchObject({ verdict: 'unknown', why: 'model_failed' });
  });

  test('a record past the size limit asks no model', async () => {
    const llm = ok({ verdict: 'allow', entry_id: '', quote: '', reason: '' });
    const got = await proofreadMove({ move, record: { ...record, tooLong: true } }, { route, llm });
    expect(got).toMatchObject({ verdict: 'unknown', why: 'record_too_long' });
    expect(llm.dispatch).not.toHaveBeenCalled();
    expect(MAX_RECORD_CHARS).toBeGreaterThan(MAX_ENTRY_CHARS);
  });

  test('with no route given it uses the registry route, never a model id of its own', async () => {
    const llm = ok({ verdict: 'allow', entry_id: '', quote: '', reason: '' });
    await proofreadMove({ move, record }, { llm });
    expect(llm.dispatch.mock.calls[0][0]).toBe(require('../config/models').ROUTES.autoDispatchProofreader);
  });
});

describe('the answer key', () => {
  test('every hard case is well formed and the key covers all three outcomes', () => {
    expect(new Set(HARD_CASES.map((c) => c.name)).size).toBe(HARD_CASES.length);
    for (const hardCase of HARD_CASES) {
      expect(['allow', 'hold', 'stop']).toContain(hardCase.expect);
      const facts = moveFacts(hardCase.move);
      expect(facts.from.weekday && facts.to.weekday).toBeTruthy();
      expect(recordOf(hardCase).entries.every((e) => e.id && e.channel && e.from && typeof e.text === 'string')).toBe(true);
    }
    expect(new Set(HARD_CASES.map((c) => c.expect))).toEqual(new Set(['allow', 'hold', 'stop']));
  });

  test('scoring: an allow where the key says hold or stop is the missed promise', () => {
    expect(scoreOf('hold', 'allow')).toBe('missed_promise');
    expect(scoreOf('stop', 'allow')).toBe('missed_promise');
    expect(scoreOf('hold', 'unknown')).toBe('stopped_without_quote');
    expect(scoreOf('stop', 'unknown')).toBe('right');
    expect(scoreOf('allow', 'hold')).toBe('wrong_stop');
    expect(scoreOf('allow', 'allow')).toBe('right');
  });
});
