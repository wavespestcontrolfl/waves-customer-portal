// Move proofreader (owner 2026-10-09, "proofreader yes"): the record the code
// builds, and the code's judgment of the model's answer. The model itself is
// measured by the replay script, not here.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

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
    const chain = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') {
          return (resolve, reject) => (fail.includes(name)
            ? Promise.reject(new Error(`${name} down`))
            : Promise.resolve(tables[name] || [])).then(resolve, reject);
        }
        if (prop === 'first') return async () => (fail.includes(name) ? Promise.reject(new Error(`${name} down`)) : (tables[name] || [])[0] || null);
        return (...args) => {
          calls.push([name, prop, ...args]);
          // A where/orWhere callback builds a nested group: run it on the same chain.
          if (typeof args[0] === 'function') args[0].call(chain);
          return chain;
        };
      },
    });
    return chain;
  };
  conn.calls = calls;
  return conn;
}

const AS_OF = new Date('2026-10-05T08:10:00.000Z');
const TABLES = {
  customers: [{ email: 'pat@example.test', crm_notes: null, internal_notes: 'Prefers a text before arrival.', follow_up_notes: null, access_notes: 'Side gate code 4821, latch sticks.' }],
  sms_log: [
    { direction: 'inbound', message_body: 'Please always come on  Wednesdays.', message_type: 'inbound', admin_user_id: null, created_at: '2026-03-02T15:10:00.000Z' },
    { direction: 'outbound', message_body: 'No problem, Wednesdays it is.', message_type: 'manual', admin_user_id: 'u1', created_at: '2026-03-02T15:22:00.000Z' },
    { direction: 'outbound', message_body: 'Your technician is on the way.', message_type: 'tech_en_route', admin_user_id: null, created_at: '2026-04-01T13:00:00.000Z' },
  ],
  emails: [
    { id: 'm1', gmail_thread_id: 'th1', customer_id: 'c1', from_address: 'Pat <pat@example.test>', subject: 'Schedule', body_text: 'x'.repeat(MAX_ENTRY_CHARS + 50), snippet: null, received_at: '2026-05-01T10:00:00.000Z' },
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
    { initiated_by: 'system', customer_response_text: 'YES', notes: 'program text', created_at: '2026-08-01T10:00:00.000Z' },
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
    expect(record.unread).toEqual([{ channel: 'call', at: '2026-09-30T10:00:00.000Z', reason: 'not_transcribed' }]);
  });

  test('access codes never reach the record; a long email body is cut and counted', async () => {
    const record = await buildCustomerRecord(fakeConn(TABLES), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(JSON.stringify(record.entries)).not.toContain('4821');
    const email = record.entries.find((e) => e.channel === 'email');
    expect(email.text.endsWith(' [cut]')).toBe(true);
    expect(record.cut).toBe(1);
    expect(email.cut).toBeUndefined(); // the flag is a count, not a field the model reads
    expect(record.tooLong).toBe(false);
  });

  test('only words written before the move: every dated source is bounded by asOf', async () => {
    const conn = fakeConn(TABLES);
    await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    for (const [table, column] of [['sms_log', 'created_at'], ['emails', 'received_at'], ['call_log', 'created_at'], ['customer_interactions', 'created_at'], ['admin_notes', 'created_at'], ['service_records', 'created_at'], ['reschedule_log', 'created_at']]) {
      expect(conn.calls.filter(([t, method, col, op, value]) => t === table && method === 'where' && col === column && op === '<' && value === AS_OF).length).toBeGreaterThan(0);
    }
  });

  test('our own replies are read too: unlinked mail of the same thread or sent to the customer address', async () => {
    const conn = fakeConn(TABLES);
    await buildCustomerRecord(conn, { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    const emailCalls = conn.calls.filter(([t]) => t === 'emails');
    expect(emailCalls.some(([, method, col, values]) => method === 'whereIn' && col === 'gmail_thread_id' && values[0] === 'th1')).toBe(true);
    expect(emailCalls.some(([, method, sql, binds]) => method === 'orWhereRaw' && /to_address/.test(sql) && binds[0] === 'pat@example.test')).toBe(true);
  });

  test('a source that cannot be read is listed as unread and the rest is still built', async () => {
    const record = await buildCustomerRecord(fakeConn(TABLES, { fail: ['sms_log', 'call_log'] }), { customerId: 'c1', serviceId: 's1', asOf: AS_OF });
    expect(record.unread).toEqual(expect.arrayContaining([{ channel: 'text', reason: 'read_failed' }, { channel: 'call', reason: 'read_failed' }]));
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
