/**
 * Phone-matched promise and alert rules (owner 2026-11-04, "FOR ALL COMUNNICATION LINES"; AI choice 2026-11-05):
 * the two gates, the phone-keyed witness (call-promise-phone-evidence.js), the unknown-sender text bell rule
 * (admin-alert-relevance.js `unknown_sms`) and the quiet-call filter on the pagers' promise list. Pure: no
 * database. The SQL these lean on is covered in promise-phone-match-db.test.js and
 * call-promise-ai-close-no-customer-db.test.js (CI's DATABASE_URL step). Fixtures fictitious.
 */
const fs = require('fs');
const path = require('path');

const GATES = ['GATE_CALL_PROMISE_AI_CLOSE', 'GATE_CALL_PROMISE_AI_NO_CUSTOMER', 'GATE_PROMISE_PHONE_MATCH_CLOSE', 'GATE_ALERT_CONTACT_CLOSE'];
const saved = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
afterEach(() => { for (const g of GATES) { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; } });
beforeEach(() => { for (const g of GATES) delete process.env[g]; });

describe('the gates', () => {
  const gates = () => require('../config/feature-gates');
  test('GATE_CALL_PROMISE_AI_NO_CUSTOMER is strict true, unset = off, and needs the AI close live', () => {
    expect(gates().callPromiseAiNoCustomerLive()).toBe(false);
    process.env.GATE_CALL_PROMISE_AI_NO_CUSTOMER = 'true';
    expect(gates().callPromiseAiNoCustomerLive()).toBe(false); // the AI close is off
    process.env.GATE_CALL_PROMISE_AI_CLOSE = 'true';
    expect(gates().callPromiseAiNoCustomerLive()).toBe(true);
    for (const value of ['TRUE', '1', 'shadow', ' true', '']) {
      process.env.GATE_CALL_PROMISE_AI_NO_CUSTOMER = value;
      expect([value, gates().callPromiseAiNoCustomerLive()]).toEqual([value, false]);
    }
  });
  test('GATE_PROMISE_PHONE_MATCH_CLOSE is shadow, true or off', () => {
    expect(gates().promisePhoneMatchCloseMode()).toBe('off');
    for (const [value, mode] of [['shadow', 'shadow'], [' TRUE ', 'true'], ['1', 'off'], ['on', 'off'], ['', 'off']]) {
      process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = value;
      expect([value, gates().promisePhoneMatchCloseMode()]).toEqual([value, mode]);
    }
  });
});

describe('no-customer candidates (call-promise-ai-close.js)', () => {
  const close = () => require('../services/call-promise-ai-close');
  test('with the gate off no-customer calls are never listed, and the database is not even asked', async () => {
    const conn = jest.fn(() => { throw new Error('the database must not be read'); });
    process.env.GATE_CALL_PROMISE_AI_CLOSE = 'true';
    await expect(close().listCandidates(conn, { noCustomer: true })).resolves.toEqual([]);
    expect(conn).not.toHaveBeenCalled();
  });
  test('the daily cap is one exported constant, 10', () => {
    expect(close().NO_CUSTOMER_DAILY_MODEL_CALLS).toBe(10);
    expect(require('../services/call-promise-phone-evidence').NO_CUSTOMER_DAILY_MODEL_CALLS).toBe(10);
  });
  test('the customer path is untouched: it still requires a customer, oldest first', () => {
    const calls = [];
    const chain = new Proxy(() => {}, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'modify') return (fn) => { fn(chain); return chain; };
        return (...args) => { calls.push([prop, ...args]); return chain; };
      },
    });
    const conn = () => chain;
    conn.raw = (sql) => sql;
    close().listCandidates(conn, { callIds: ['x'] });
    expect(calls).toContainEqual(['whereNotNull', 'cl.customer_id']);
    expect(calls.find(([m]) => m === 'orderBy')[1]).toEqual([{ column: 'cl.created_at', order: 'asc' }, { column: 'cc.id', order: 'asc' }]);
  });
});

describe('phone identity and the witness (call-promise-phone-evidence.js)', () => {
  const evidence = () => require('../services/call-promise-phone-evidence');
  test('the caller\'s number is the inbound from_phone or the outbound to_phone; a carrier sentinel or blank is nobody', () => {
    const { phoneIdentityOf } = evidence();
    expect(phoneIdentityOf({ direction: 'inbound', from_phone: '+15555550142', to_phone: '+15555550100' })).toBe('5555550142');
    expect(phoneIdentityOf({ direction: 'outbound', from_phone: '+15555550100', to_phone: '(555) 555-0142' })).toBe('5555550142');
    expect(phoneIdentityOf({ direction: 'inbound', from_phone: 'anonymous' })).toBeNull();
    expect(phoneIdentityOf({ direction: 'inbound', from_phone: '' })).toBeNull();
  });

  const promise = { kind: 'schedule_visit', party: 'waves', sms_context: { basis: 'promise', phone_keyed: true, source_at: '2026-11-04T17:30:00.000Z' } };
  const at = (minutes) => new Date(Date.parse('2026-11-04T17:30:00.000Z') + minutes * 60000).toISOString();
  const text = (over = {}) => ({ type: 'sms', direction: 'outbound', status: 'delivered', message_type: 'manual', operator_sent: true, created_at: at(10), ...over });
  const call = (over = {}) => ({ type: 'call', direction: 'inbound', status: 'completed', duration_seconds: 210, answered_by: 'human', created_at: at(150), ...over });

  test('a person\'s delivered text counts; an automated send, an inbound text, an undelivered text and a text from before the promise do not', () => {
    const { phoneWitness } = evidence();
    expect(phoneWitness(text(), promise)).toBe(true);
    expect(phoneWitness(text({ message_type: 'confirmation', operator_sent: false }), promise)).toBe(false);
    expect(phoneWitness(text({ direction: 'inbound', status: 'received', operator_sent: false }), promise)).toBe(false);
    expect(phoneWitness(text({ status: 'failed' }), promise)).toBe(false);
    expect(phoneWitness(text({ created_at: at(-5) }), promise)).toBe(false);
  });
  test('a live call a person took (the 3.5 minute example) counts; a voicemail, a short call, an AI-answered call and a call from before do not', () => {
    const { phoneWitness } = evidence();
    expect(phoneWitness(call(), promise)).toBe(true);
    expect(phoneWitness(call({ answered_by: 'voicemail', duration_seconds: 45 }), promise)).toBe(false);
    expect(phoneWitness(call({ answered_by: 'missed', duration_seconds: 0, status: 'no-answer' }), promise)).toBe(false);
    expect(phoneWitness(call({ duration_seconds: 20 }), promise)).toBe(false);
    expect(phoneWitness(call({ answered_by: 'ai_agent' }), promise)).toBe(false);
    expect(phoneWitness(call({ created_at: at(-60) }), promise)).toBe(false);
  });
  test('a call a person placed counts only when the bridge reached the caller and the extraction heard a live conversation', () => {
    const { phoneWitness } = evidence();
    const out = (over = {}) => call({ direction: 'outbound', answered_by: null, source: 'admin-click', v2_extraction_status: 'valid', is_voicemail: 'false', ...over });
    expect(phoneWitness(out(), promise)).toBe(true);
    expect(phoneWitness(out({ is_voicemail: 'true' }), promise)).toBe(false);
    expect(phoneWitness(out({ source: 'collections_voice' }), promise)).toBe(false);
  });
  test('the checker\'s own witness rule delegates here for a phone-keyed promise, and a customer promise still needs a visit', () => {
    const { admissibleWitness } = require('../services/sms-commitment-fulfillment');
    expect(admissibleWitness({ ...call(), ref: 'call:1' }, promise, [])).toBe(true);
    const customerPromise = { ...promise, sms_context: { basis: 'promise', source_at: promise.sms_context.source_at } };
    expect(admissibleWitness({ ...call(), ref: 'call:1' }, customerPromise, [])).toBe(false);
  });
});

describe('the unknown-sender text bell (admin-alert-relevance.js unknown_sms)', () => {
  const relevance = () => require('../services/admin-alert-relevance');
  const bellRow = () => ({ category: 'inbound_sms', created_at: new Date('2026-11-04T18:00:00Z'), link: '/admin/communications?message=SM1',
    metadata: { triggerKey: 'sms_reply', dedupeKey: 'sms-reply:SM1', payload: { twilioSid: 'SM1', threadId: null } } });
  const anchor = new Date('2026-11-04T18:00:00Z');
  const minutes = (m) => new Date(anchor.getTime() + m * 60000);
  const subject = (contact, contactMode = 'true') => ({ contactMode, contact: { anchor, unknownSender: true, ...contact } });

  test('the emitter\'s key prefix is the one this class matches', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/sms-reply-alert-delivery.js'), 'utf8');
    expect(source).toContain('`sms-reply:${MessageSid}`');
    expect(fs.readFileSync(path.join(__dirname, '../services/admin-alert-relevance.js'), 'utf8')).toContain("const UNKNOWN_SMS_PREFIX = 'sms-reply:';");
  });
  test('gate off: the row is the old inbound_sms class and nothing judges it; shadow or true: its own class', () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    expect(relevance().classify(bellRow()).key).toBe('inbound_sms');
    process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'shadow';
    expect(relevance().classify(bellRow()).key).toBe('unknown_sms');
    process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
    expect(relevance().classify(bellRow()).key).toBe('unknown_sms');
    // A known sender's thread bell is not this class.
    const known = bellRow();
    known.metadata.dedupeKey = 'sms-thread:11111111-1111-4111-8111-111111111111';
    expect(relevance().classify(known).key).toBe('inbound_sms');
  });
  test('a person\'s delivered reply after the text closes it; a person\'s call closes it', () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
    const cls = relevance().classify(bellRow());
    expect(relevance().judge(cls, subject({ textAt: minutes(5) }))).toEqual({ reason: 'Answered by text', would: null });
    expect(relevance().judge(cls, subject({ backAt: minutes(5) }))).toEqual({ reason: 'Answered by a call', would: null });
    expect(relevance().judge(cls, subject({ inAt: minutes(5) }))).toEqual({ reason: 'Answered by a call', would: null });
  });
  test('an automated reply (no person witness), a reply from before the text, and a reply before the sender\'s latest text leave it open', () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
    const cls = relevance().classify(bellRow());
    const open = { reason: null, would: null };
    expect(relevance().judge(cls, subject({ textAt: null, pending: false }))).toEqual(open); // the Messages reader's verdict is never used
    expect(relevance().judge(cls, subject({ textAt: minutes(-5) }))).toEqual(open);
    expect(relevance().judge(cls, subject({ textAt: minutes(10), lastInboundAt: minutes(30) }))).toEqual(open);
    expect(relevance().judge(cls, subject({ textAt: minutes(40), lastInboundAt: minutes(30) })).reason).toBe('Answered by text');
  });
  test('shadow records the verdict and closes nothing; a known customer item (no unknownSender flag) is not this rule\'s', () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'shadow';
    const cls = relevance().classify(bellRow());
    expect(relevance().judge(cls, subject({ textAt: minutes(5) }))).toEqual({ reason: null, would: 'Answered by text' });
    process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
    expect(relevance().judge(cls, { contactMode: 'true', contact: { anchor, textAt: minutes(5) } })).toEqual({ reason: null, would: null });
  });
  test('the contact gate off silences it whatever its own gate says', () => {
    process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
    expect(relevance().classify(bellRow())).toBeNull(); // contactOnly: not in the table at all
  });
});

describe('promises on vendor, spam and applicant calls raise no pager alert (call-commitments.js)', () => {
  const recorder = () => {
    const calls = [];
    const chain = new Proxy(() => {}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve) => resolve([]);
        if (prop === 'modify') return (fn) => { fn(chain); return chain; };
        return (...args) => { calls.push([prop, ...args]); return chain; };
      },
    });
    return { conn: () => chain, calls };
  };
  const quiet = (calls) => calls.filter(([m, sql]) => m === 'whereRaw' && String(sql).startsWith('NOT (COALESCE'));

  test('the predicate names the dispositions and the applicant nature', () => {
    const sql = require('../services/call-commitments').quietCallSql('cl');
    expect(sql).toContain("IN ('vendor_logged', 'spam_discarded')");
    expect(sql).toContain("call_nature' = 'job_applicant'");
    expect(sql).not.toMatch(/\?/);
  });
  test('the pagers (quietAlerts) drop them only under the gate; the Owed tab\'s read never does', async () => {
    const { listOpenCommitments } = require('../services/call-commitments');
    const run = async (options, mode) => {
      if (mode) process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = mode; else delete process.env.GATE_PROMISE_PHONE_MATCH_CLOSE;
      const { conn, calls } = recorder();
      await listOpenCommitments(conn, { party: 'waves', ...options });
      return quiet(calls).length;
    };
    expect(await run({ quietAlerts: true }, 'true')).toBe(1);
    expect(await run({ quietAlerts: true }, 'shadow')).toBe(0);
    expect(await run({ quietAlerts: true }, null)).toBe(0);
    expect(await run({}, 'true')).toBe(0);
  });
  test('the three pagers ask for it', () => {
    for (const file of ['promise-chaser-bell.js', 'followup-sla-watcher.js', 'call-commitments-watchdog.js']) {
      const source = fs.readFileSync(path.join(__dirname, '../services', file), 'utf8');
      expect([file, source.includes('quietAlerts: true')]).toEqual([file, true]);
    }
  });
});
