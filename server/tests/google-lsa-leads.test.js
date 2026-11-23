// Tests services/ads/google-lsa-leads.js: the hourly Local Services lead match,
// step A (owner 2026-11-23). Behavior: the GAQL names only fields the v23 SDK
// has, Google's account-local times convert with the New York zone (DST-safe),
// an upsert updates Google's fields and never clears a match, a phone-call lead
// matches only when exactly one inbound call from that number sits in the time
// window (0 or 2+ never match; 2+ is marked ambiguous), and a message lead
// matches only a customer who is the only one with that phone. Nothing writes
// call_log, leads or customers.
// Regression guarded: LSA calls staying anonymous website calls, a wrong guess
// between two callers, a rerun wiping a match, and a time shifted by an hour
// around the clock change.

const mockWrites = [];
let mockRows = {};

function builder(table) {
  const b = {};
  const record = (op) => (...args) => { mockWrites.push({ table, op, args }); return b; };
  for (const op of ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereNot', 'whereIn', 'select', 'limit', 'orderBy']) b[op] = jest.fn(record(op));
  b.insert = jest.fn(record('insert'));
  b.onConflict = jest.fn(record('onConflict'));
  b.merge = jest.fn(record('merge'));
  b.update = jest.fn(record('update'));
  b.then = (res, rej) => {
    const rows = typeof mockRows[table] === 'function' ? mockRows[table]() : (mockRows[table] || []);
    return Promise.resolve(rows).then(res, rej);
  };
  return b;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.raw = jest.fn((sql) => ({ raw: sql }));
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('google-ads-api', () => ({
  GoogleAdsApi: jest.fn(() => ({ Customer: () => ({ query: (...a) => mockQuery(...a) }) })),
}));

const Leads = require('../services/ads/google-lsa-leads');
const {
  parseAccountTime, last10, mapLead, callsByLead, matchWindow, chooseCandidate,
  leadQuery, conversationQuery, upsertLeads, matchOpenLeads, decideMatch,
  resolveSharedCalls, refillFields, refillMatches, dbErrorText, samePhone, isCandidateCall, windowClosed,
} = Leads._private;

const ACCOUNT = '7636809139';
// An inbound call from the consumer to the Local Services profile line.
const CALL = { from_phone: '+19415550142', to_phone: '+19413187612' };
const writesTo = (table, op) => mockWrites.filter((w) => w.table === table && w.op === op);

beforeEach(() => {
  mockWrites.length = 0;
  mockRows = {};
  mockQuery.mockReset();
  mockDb.mockClear();
});

describe('Google field names and query shape', () => {
  test('the lead query selects the v23 lead fields, the whole contact_details message and both edges', () => {
    const gaql = leadQuery('2026-10-24', '2026-11-23');
    for (const f of ['resource_name', 'id', 'lead_type', 'lead_status', 'category_id', 'service_id', 'contact_details', 'creation_date_time', 'lead_charged', 'credit_details.credit_state']) {
      expect(gaql).toContain(`local_services_lead.${f}`);
    }
    expect(gaql).toContain("creation_date_time >= '2026-10-24 00:00:00'");
    expect(gaql).toContain("creation_date_time <= '2026-11-23 23:59:59'");
    expect(gaql).not.toContain('contact_details.');
  });

  test('the conversation query reads phone calls only, with the call length field', () => {
    const gaql = conversationQuery('2026-10-24', '2026-11-23');
    expect(gaql).toContain('local_services_lead_conversation.lead');
    expect(gaql).toContain('local_services_lead_conversation.event_date_time');
    expect(gaql).toContain('local_services_lead_conversation.phone_call_details.call_duration_millis');
    expect(gaql).toContain("conversation_channel = 'PHONE_CALL'");
  });
});

describe('Eastern time conversion', () => {
  test('summer (EDT) is UTC-4 and winter (EST) is UTC-5', () => {
    expect(parseAccountTime('2026-07-15 10:30:00').toISOString()).toBe('2026-07-15T14:30:00.000Z');
    expect(parseAccountTime('2026-11-23 10:30:00').toISOString()).toBe('2026-11-23T15:30:00.000Z');
  });

  test('the fall-back day: 00:30 is still EDT, 03:30 is EST (2026-11-01)', () => {
    expect(parseAccountTime('2026-11-01 00:30:00').toISOString()).toBe('2026-11-01T04:30:00.000Z');
    expect(parseAccountTime('2026-11-01 03:30:00').toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  test('the spring-forward day: 01:30 is EST, 03:30 is EDT (2026-03-08)', () => {
    expect(parseAccountTime('2026-03-08 01:30:00').toISOString()).toBe('2026-03-08T06:30:00.000Z');
    expect(parseAccountTime('2026-03-08 03:30:00').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  test('an unreadable value is null', () => {
    expect(parseAccountTime('')).toBeNull();
    expect(parseAccountTime(undefined)).toBeNull();
    expect(parseAccountTime('yesterday')).toBeNull();
  });
});

describe('mapping Google rows', () => {
  const leadRow = (over = {}) => ({
    local_services_lead: {
      resource_name: 'customers/7636809139/localServicesLeads/4455', id: 4455,
      lead_type: 3, lead_status: 4, category_id: 'xcat:service_area_business_pest_control', service_id: 'termite',
      contact_details: { phone_number: '(941) 555-0142', consumer_name: 'Test Caller' },
      creation_date_time: '2026-11-20 14:05:09', lead_charged: true,
      credit_details: { credit_state: 3 },
      ...over,
    },
  });

  test('maps a phone lead with its call: E.164 phone, status, credit, call time and seconds', () => {
    const calls = callsByLead([{
      local_services_lead_conversation: {
        lead: 'customers/7636809139/localServicesLeads/4455', conversation_channel: 4,
        event_date_time: '2026-11-20 14:04:30', phone_call_details: { call_duration_millis: 95000 },
      },
    }]);
    const row = mapLead(leadRow(), calls.get('customers/7636809139/localServicesLeads/4455'), ACCOUNT);
    expect(row).toMatchObject({
      google_lead_id: 'customers/7636809139/localServicesLeads/4455', account_id: ACCOUNT, lead_type: 'calls', lead_status: 'BOOKED',
      consumer_phone: '+19415550142', consumer_name: 'Test Caller', charged: true, credit_state: 'CREDITED',
      call_duration_seconds: 95,
    });
    expect(row.call_started_at.toISOString()).toBe('2026-11-20T19:04:30.000Z');
    expect(row.lead_created_at.toISOString()).toBe('2026-11-20T19:05:09.000Z');
  });

  test('keeps an unparseable phone as raw text and leaves the call fields out when no call was read', () => {
    const row = mapLead(leadRow({ contact_details: { phone_number: 'blocked' } }), undefined, ACCOUNT);
    expect(row.consumer_phone).toBe('blocked');
    expect(row).not.toHaveProperty('call_started_at');
    expect(row).not.toHaveProperty('call_duration_seconds');
  });

  test('never carries a match column, so an upsert of it cannot clear a match', () => {
    const row = mapLead(leadRow(), undefined, ACCOUNT);
    for (const k of ['call_log_id', 'lead_id', 'customer_id', 'match_basis', 'matched_at', 'first_seen_at']) {
      expect(row).not.toHaveProperty(k);
    }
  });

  test('only phone-call conversations count; the earliest event stands for the call', () => {
    const calls = callsByLead([
      { local_services_lead_conversation: { lead: 'customers/1/localServicesLeads/1', conversation_channel: 3, event_date_time: '2026-11-20 10:00:00' } },
      { local_services_lead_conversation: { lead: 'customers/1/localServicesLeads/2', conversation_channel: 'PHONE_CALL', event_date_time: '2026-11-20 10:10:00' } },
      { local_services_lead_conversation: { lead: 'customers/1/localServicesLeads/2', conversation_channel: 4, event_date_time: '2026-11-20 10:05:00' } },
    ]);
    expect(calls.has('customers/1/localServicesLeads/1')).toBe(false);
    expect(calls.get('customers/1/localServicesLeads/2').startedAt.toISOString()).toBe('2026-11-20T15:05:00.000Z');
  });
});

describe('conversation joins its lead', () => {
  test('the conversation\'s lead resource name is the lead\'s resource_name, so the call time lands on that lead', () => {
    const name = 'customers/7636809139/localServicesLeads/4455';
    const calls = callsByLead([{
      local_services_lead_conversation: { lead: name, conversation_channel: 4, event_date_time: '2026-11-20 14:04:30', phone_call_details: { call_duration_millis: 1000 } },
    }]);
    const leadRow = { local_services_lead: { resource_name: name, id: 4455, lead_type: 3, creation_date_time: '2026-11-20 14:05:09', contact_details: { phone_number: '9415550142' } } };
    const row = mapLead(leadRow, calls.get(leadRow.local_services_lead.resource_name), ACCOUNT);
    expect(row.google_lead_id).toBe(name);
    expect(row.call_duration_seconds).toBe(1);
  });

  test('a lead with no resource name is left out', () => {
    expect(mapLead({ local_services_lead: { id: 4455 } }, undefined, ACCOUNT)).toBeNull();
  });
});

describe('upsert', () => {
  test('inserts on google_lead_id and merges Google fields only: a stored match is never cleared', async () => {
    const row = mapLead({ local_services_lead: { resource_name: 'customers/1/localServicesLeads/9', lead_type: 3, creation_date_time: '2026-11-20 09:00:00', contact_details: { phone_number: '9415550142' } } }, undefined, ACCOUNT);
    await upsertLeads([row]);
    expect(writesTo('lsa_leads', 'onConflict')[0].args).toEqual(['google_lead_id']);
    const merged = writesTo('lsa_leads', 'merge')[0].args[0];
    expect(merged.consumer_phone).toBe('+19415550142');
    for (const k of ['call_log_id', 'lead_id', 'customer_id', 'match_basis', 'matched_at', 'first_seen_at']) {
      expect(merged).not.toHaveProperty(k);
    }
  });
});

describe('candidate choice', () => {
  test('one call matches; none and two or more never match', () => {
    const a = { id: 'c1' };
    expect(chooseCandidate([a])).toEqual({ status: 'matched', call: a });
    expect(chooseCandidate([])).toEqual({ status: 'none', call: null });
    expect(chooseCandidate(undefined)).toEqual({ status: 'none', call: null });
    expect(chooseCandidate([a, { id: 'c2' }])).toEqual({ status: 'ambiguous', call: null });
  });

  test('the window runs 10 minutes before to 30 minutes after the call, else the lead time', () => {
    const call = new Date('2026-11-20T19:04:30Z');
    const w = matchWindow({ call_started_at: call, lead_created_at: new Date('2026-11-20T20:00:00Z') });
    expect(w.start.toISOString()).toBe('2026-11-20T18:54:30.000Z');
    expect(w.end.toISOString()).toBe('2026-11-20T19:34:30.000Z');
    expect(matchWindow({ lead_created_at: call }).start.toISOString()).toBe('2026-11-20T18:54:30.000Z');
    expect(matchWindow({})).toBeNull();
  });

  test('last10 keys formats alike and refuses a short number', () => {
    expect(last10('+1 (941) 555-0142')).toBe('9415550142');
    expect(last10('15550142')).toBe('');
  });
});

describe('matching', () => {
  const phoneLead = { id: 'l1', lead_type: 'calls', consumer_phone: '+19415550142', lead_created_at: new Date('2026-11-20T19:05:09Z'), call_started_at: new Date('2026-11-20T19:04:30Z') };

  test('one inbound call: sets call, customer and the call\'s lead, basis phone_time', async () => {
    mockRows.call_log = [{ ...CALL, id: 'call-1', customer_id: 'cust-1', twilio_call_sid: 'CA1' }];
    mockRows.leads = [{ id: 'lead-1' }];
    const update = await decideMatch(phoneLead);
    expect(update).toMatchObject({ call_log_id: 'call-1', customer_id: 'cust-1', lead_id: 'lead-1', match_basis: 'phone_time' });
    expect(update.matched_at).toBeInstanceOf(Date);
    const lookup = writesTo('leads', 'where')[0].args[0];
    expect(lookup).toEqual({ twilio_call_sid: 'CA1' });
  });

  test('one call with no lead: lead_id is null', async () => {
    mockRows.call_log = [{ ...CALL, id: 'call-1', customer_id: null, twilio_call_sid: 'CA1' }];
    mockRows.leads = [];
    expect(await decideMatch(phoneLead)).toMatchObject({ call_log_id: 'call-1', customer_id: null, lead_id: null });
  });

  test('searches inbound calls by last ten digits inside the window', async () => {
    mockRows.call_log = [];
    await decideMatch(phoneLead);
    expect(writesTo('call_log', 'where')[0].args[0]).toEqual({ direction: 'inbound' });
    const raws = writesTo('call_log', 'whereRaw').map((w) => w.args[1]);
    expect(raws.slice(0, 2)).toEqual([['source', 'voice_relay_sandbox'], ['source', 'tech_voice']]); // sandbox calls excluded
    expect(raws[2]).toEqual(['9415550142']);
    const bounds = writesTo('call_log', 'where').slice(1).map((w) => w.args);
    expect(bounds[0][2].toISOString()).toBe('2026-11-20T18:54:30.000Z');
    expect(bounds[1][2].toISOString()).toBe('2026-11-20T19:34:30.000Z');
  });

  test('no call: nothing is written', async () => {
    mockRows.call_log = [];
    expect(await decideMatch(phoneLead)).toBeNull();
  });

  test('two calls: marked ambiguous with no ids', async () => {
    mockRows.call_log = [{ ...CALL, id: 'a' }, { ...CALL, id: 'b' }];
    expect(await decideMatch(phoneLead)).toEqual({ match_basis: 'ambiguous' });
  });

  test('a message lead matches the only customer with the phone', async () => {
    mockRows.customers = [{ id: 'cust-9' }];
    const update = await decideMatch({ id: 'm1', lead_type: 'messages', consumer_phone: '+19415550142' });
    expect(update).toMatchObject({ customer_id: 'cust-9', match_basis: 'phone_customer' });
    expect(update).not.toHaveProperty('call_log_id');
    expect(writesTo('customers', 'whereNull')[0].args).toEqual(['deleted_at']);
    expect(writesTo('customers', 'limit')[0].args).toEqual([2]);
  });

  test('a message lead with two customers on the phone, or none, stays unmatched', async () => {
    mockRows.customers = [{ id: 'a' }, { id: 'b' }];
    expect(await decideMatch({ id: 'm1', lead_type: 'messages', consumer_phone: '+19415550142' })).toBeNull();
    mockRows.customers = [];
    expect(await decideMatch({ id: 'm1', lead_type: 'messages', consumer_phone: '+19415550142' })).toBeNull();
  });

  test('matchOpenLeads writes lsa_leads only, counts each outcome, and does not rewrite a standing ambiguous mark', async () => {
    mockRows.lsa_leads = [
      { ...phoneLead, id: 'l1', match_basis: null },
      { ...phoneLead, id: 'l2', match_basis: 'ambiguous' },
    ];
    mockRows.call_log = [{ ...CALL, id: 'a' }, { ...CALL, id: 'b' }];
    const counts = await matchOpenLeads();
    expect(counts).toEqual({ matched: 0, ambiguous: 2, unmatched: 0, pending: 0 });
    const updates = writesTo('lsa_leads', 'update');
    expect(updates).toHaveLength(1); // l1 only: l2 was already marked
    const touched = new Set(mockWrites.filter((w) => ['insert', 'update'].includes(w.op)).map((w) => w.table));
    expect([...touched]).toEqual(['lsa_leads']);
  });

  test('matchOpenLeads skips a final match: only unmatched or ambiguous rows are read', async () => {
    mockRows.lsa_leads = [];
    await matchOpenLeads();
    expect(writesTo('lsa_leads', 'whereNotNull')[0].args).toEqual(['consumer_phone']);
  });
});

describe('the Local Services profile line', () => {
  test('call candidates are limited to the Bradenton line, matched on its last ten digits', async () => {
    expect(Leads.LSA_PROFILE_PHONE).toBe('+19413187612');
    mockRows.call_log = [];
    await decideMatch({ id: 'l1', lead_type: 'calls', consumer_phone: '+19415550142', lead_created_at: new Date('2026-11-20T19:05:09Z') });
    const toPhone = writesTo('call_log', 'whereRaw').find((w) => /to_phone/.test(w.args[0]));
    expect(toPhone.args[1]).toEqual(['9413187612']);
  });
});

describe('one call, one Google lead', () => {
  const open = (id) => ({ id, lead_type: 'calls', consumer_phone: '+19415550142', lead_created_at: new Date('2026-11-20T19:05:09Z'), match_basis: null });

  test('resolveSharedCalls: two leads on one call both become ambiguous; a lone choice stays', () => {
    const out = resolveSharedCalls([
      { lead: open('a'), update: { call_log_id: 'c1', match_basis: 'phone_time' } },
      { lead: open('b'), update: { call_log_id: 'c1', match_basis: 'phone_time' } },
      { lead: open('c'), update: { call_log_id: 'c2', match_basis: 'phone_time' } },
    ]);
    expect(out[0].update).toEqual({ match_basis: 'ambiguous' });
    expect(out[1].update).toEqual({ match_basis: 'ambiguous' });
    expect(out[2].update).toMatchObject({ call_log_id: 'c2', match_basis: 'phone_time' });
  });

  test('two open leads that pick the same call: neither is given it', async () => {
    mockRows.lsa_leads = [open('a'), open('b')];
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1' }];
    mockRows.leads = [];
    const counts = await matchOpenLeads();
    expect(counts).toEqual({ matched: 0, ambiguous: 2, unmatched: 0, pending: 0 });
    for (const w of writesTo('lsa_leads', 'update')) {
      expect(w.args[0]).not.toHaveProperty('call_log_id');
      expect(w.args[0].match_basis).toBe('ambiguous');
    }
  });

  test('a call another lsa_leads row already holds is not taken: the lead is marked ambiguous with no ids', async () => {
    let lsaReads = 0;
    // 1st read = the open leads; later reads = the "held by another lead" check.
    mockRows.lsa_leads = () => (lsaReads++ === 0 ? [open('a')] : [{ id: 'other' }]);
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1' }];
    mockRows.leads = [];
    const counts = await matchOpenLeads();
    expect(counts).toEqual({ matched: 0, ambiguous: 1, unmatched: 0, pending: 0 });
    const update = writesTo('lsa_leads', 'update')[0].args[0];
    expect(update).toMatchObject({ match_basis: 'ambiguous' });
    expect(update).not.toHaveProperty('call_log_id');
    expect(update).not.toHaveProperty('customer_id');
    expect(writesTo('lsa_leads', 'whereNot')[0].args).toEqual(['id', 'a']);
  });

  test('a free call is given to the lead that chose it alone', async () => {
    let lsaReads = 0;
    mockRows.lsa_leads = () => (lsaReads++ === 0 ? [open('a')] : []);
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1' }];
    mockRows.leads = [{ id: 'lead-1' }];
    expect(await matchOpenLeads()).toEqual({ matched: 1, ambiguous: 0, unmatched: 0, pending: 0 });
    expect(writesTo('lsa_leads', 'update')[0].args[0]).toMatchObject({ call_log_id: 'c1', lead_id: 'lead-1', match_basis: 'phone_time' });
  });
});

describe('refilling a phone_time match', () => {
  test('refillFields fills only an empty lead_id / customer_id that is now known, never the call or the basis', () => {
    expect(refillFields({ lead_id: null, customer_id: null }, { customer_id: 'cu' }, 'ld')).toEqual({ lead_id: 'ld', customer_id: 'cu' });
    expect(refillFields({ lead_id: 'old', customer_id: null }, { customer_id: 'cu' }, null)).toEqual({ customer_id: 'cu' });
    expect(refillFields({ lead_id: 'old', customer_id: 'oldc' }, { customer_id: 'new' }, 'new')).toBeNull();
    expect(refillFields({ lead_id: null, customer_id: null }, { customer_id: null }, null)).toBeNull();
  });

  test('a match made before the call processor ran gets its lead and customer later', async () => {
    mockRows.lsa_leads = [
      { id: 'a', call_log_id: 'c1', lead_id: null, customer_id: null },
      { id: 'b', call_log_id: 'c2', lead_id: null, customer_id: null },
    ];
    mockRows.call_log = [
      { id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1' },
      { id: 'c2', customer_id: null, twilio_call_sid: 'CA2' },
    ];
    mockRows.leads = [{ id: 'lead-1' }];
    expect(await refillMatches()).toBe(2);
    const updates = writesTo('lsa_leads', 'update').map((w) => w.args[0]);
    expect(updates[0]).toMatchObject({ lead_id: 'lead-1', customer_id: 'cust-1' });
    for (const u of updates) {
      expect(u).not.toHaveProperty('call_log_id');
      expect(u).not.toHaveProperty('match_basis');
    }
    const filters = writesTo('lsa_leads', 'where').map((w) => w.args[0]).filter((a) => a && a.match_basis);
    expect(filters).toEqual([{ match_basis: 'phone_time' }]);
  });

  test('nothing to revisit: no call_log read', async () => {
    mockRows.lsa_leads = [];
    expect(await refillMatches()).toBe(0);
    expect(mockDb).not.toHaveBeenCalledWith('call_log');
  });
});

describe('database errors are never logged raw', () => {
  const logger = require('../services/logger');
  const PG = Object.assign(new Error('duplicate key value violates unique constraint; Key (consumer_phone)=(+19415550142) Test Caller'), { code: '23505', constraint: 'lsa_leads_google_lead_id_unique', table: 'lsa_leads' });

  test('dbErrorText keeps the step, code, constraint and table only', () => {
    const text = dbErrorText('store', PG);
    expect(text).toBe('step store, code 23505, constraint lsa_leads_google_lead_id_unique, table lsa_leads');
    expect(text).not.toMatch(/9415550142|Test Caller/);
  });

  test('a failed insert throws and logs the safe text only', async () => {
    const ENV = { GOOGLE_ADS_CLIENT_ID: 'cid', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_DEVELOPER_TOKEN: 'd', GOOGLE_ADS_REFRESH_TOKEN: 'r', GOOGLE_ADS_CUSTOMER_ID: '1112223333' };
    const saved = { ...process.env };
    Object.assign(process.env, ENV); delete process.env.GOOGLE_LSA_CUSTOMER_ID;
    try {
      mockQuery
        .mockResolvedValueOnce([{ local_services_lead: { resource_name: 'customers/1/localServicesLeads/7', lead_type: 3, creation_date_time: '2026-11-20 14:05:09', contact_details: { phone_number: '9415550142', consumer_name: 'Test Caller' } } }])
        .mockResolvedValueOnce([]);
      mockDb.mockImplementationOnce((table) => {
        const b = builder(table);
        b.insert = jest.fn(() => ({ onConflict: () => ({ merge: () => Promise.reject(PG) }) }));
        return b;
      });
      let thrown;
      try { await Leads.runLeadSync(); } catch (err) { thrown = err; }
      expect(thrown.message).toBe('database step store, code 23505, constraint lsa_leads_google_lead_id_unique, table lsa_leads');
      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).not.toMatch(/9415550142|Test Caller/);
    } finally {
      process.env = saved;
    }
  });
});

describe('whole phone numbers, not just the last ten digits', () => {
  test('a +44 number never meets a US number that shares its last ten digits', () => {
    expect(samePhone('+449415550142', '+19415550142')).toBe(false);
    expect(samePhone('+19415550142', '(941) 555-0142')).toBe(true);
    expect(samePhone('+19415550142', '19415550142')).toBe(true);
    expect(samePhone('+449415550142', '+449415550142')).toBe(true);
    expect(samePhone('', '+19415550142')).toBe(false);
  });

  test('a call to another Waves number is not a candidate; a call from a +44 caller is not either', () => {
    expect(isCandidateCall({ from_phone: '+19415550142', to_phone: '+19413187612' }, '+19415550142')).toBe(true);
    expect(isCandidateCall({ from_phone: '+19415550142', to_phone: '+19412972606' }, '+19415550142')).toBe(false);
    expect(isCandidateCall({ from_phone: '+449415550142', to_phone: '+19413187612' }, '+19415550142')).toBe(false);
  });

  test('findCandidateCalls drops a +44 caller that the last-ten query returned', async () => {
    mockRows.call_log = [{ id: 'uk', from_phone: '+449415550142', to_phone: '+19413187612', customer_id: null, twilio_call_sid: 'CAUK' }];
    expect(await decideMatch({ id: 'l1', lead_type: 'calls', consumer_phone: '+19415550142', lead_created_at: new Date('2026-11-20T19:05:09Z') })).toBeNull();
  });
});

describe('the call processor\'s own lead link (SID first, as the processor)', () => {
  const lead = { id: 'l1', lead_type: 'calls', consumer_phone: '+19415550142', lead_created_at: new Date('2026-11-20T19:05:09Z') };

  test('the lead this call\'s SID created wins over a stamp', async () => {
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1', stamped_lead_id: 'stamped-lead' }];
    mockRows.leads = [{ id: 'sid-lead' }];
    expect((await decideMatch(lead)).lead_id).toBe('sid-lead');
    expect(writesTo('leads', 'where')[0].args[0]).toEqual({ twilio_call_sid: 'CA1' });
    expect(writesTo('leads', 'whereRaw')).toHaveLength(0); // the stamp was not needed
  });

  test('no SID lead: the stamp (call_log.metadata.lead_id) is used; a stamp naming no lead gives none', async () => {
    const answers = [[], [{ id: 'stamped-lead' }]]; // the SID finds nothing, then the stamp finds one
    mockRows.leads = () => answers.shift();
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1', stamped_lead_id: 'stamped-lead' }];
    expect((await decideMatch(lead)).lead_id).toBe('stamped-lead');
    expect(writesTo('leads', 'whereRaw')[0].args).toEqual(['id::text = ?', ['stamped-lead']]);

    mockWrites.length = 0;
    mockRows.leads = [];
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1', stamped_lead_id: 'gone' }];
    expect((await decideMatch(lead)).lead_id).toBeNull();
  });

  test('two SID leads: no guess, and the stamp is not consulted', async () => {
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1', stamped_lead_id: 'stamped-lead' }];
    mockRows.leads = [{ id: 'x' }, { id: 'y' }];
    expect((await decideMatch(lead)).lead_id).toBeNull();
    expect(writesTo('leads', 'whereRaw')).toHaveLength(0);
  });

  test('the refill uses the same order', async () => {
    mockRows.lsa_leads = [{ id: 'a', call_log_id: 'c1', lead_id: null, customer_id: 'cust-1' }];
    mockRows.call_log = [{ id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1', stamped_lead_id: 'stamped-lead' }];
    const answers = [[], [{ id: 'stamped-lead' }]];
    mockRows.leads = () => answers.shift();
    expect(await refillMatches()).toBe(1);
    expect(writesTo('lsa_leads', 'update')[0].args[0]).toMatchObject({ lead_id: 'stamped-lead' });
  });
});

describe('a match is final only after its window closes', () => {
  const lead = { id: 'a', lead_type: 'calls', consumer_phone: '+19415550142', lead_created_at: new Date('2026-11-20T19:05:09Z'), call_started_at: new Date('2026-11-20T19:04:30Z'), match_basis: null };

  test('windowClosed: open until 30 minutes after the call, closed from then on', () => {
    expect(windowClosed(lead, new Date('2026-11-20T19:34:29Z'))).toBe(false);
    expect(windowClosed(lead, new Date('2026-11-20T19:34:30Z'))).toBe(true);
    expect(windowClosed({}, new Date())).toBe(true); // no time, no window
  });

  test('a lead inside its window is left alone: no write, counted as waiting', async () => {
    mockRows.lsa_leads = [lead];
    mockRows.call_log = [{ ...CALL, id: 'c1' }];
    mockRows.leads = [];
    const counts = await matchOpenLeads(new Date('2026-11-20T19:10:00Z'));
    expect(counts).toEqual({ matched: 0, ambiguous: 0, unmatched: 0, pending: 1 });
    expect(writesTo('lsa_leads', 'update')).toHaveLength(0);
  });

  test('resolveSharedCalls: a closed lead sharing a call with a pending lead waits; two closed leads go ambiguous', () => {
    const p = (id, call, pending = false) => ({ lead: { id }, update: { call_log_id: call, match_basis: 'phone_time' }, pending });
    const out = resolveSharedCalls([p('closed', 'c1'), p('open', 'c1', true), p('x', 'c2'), p('y', 'c2'), p('solo', 'c3')]);
    expect(out.map((o) => [o.lead.id, o.pending === true, o.update.match_basis])).toEqual([
      ['closed', true, 'phone_time'], ['open', true, 'phone_time'],
      ['x', false, 'ambiguous'], ['y', false, 'ambiguous'], ['solo', false, 'phone_time'],
    ]);
  });

  test('once the window has closed the lead is matched', async () => {
    let reads = 0;
    mockRows.lsa_leads = () => (reads++ === 0 ? [lead] : []);
    mockRows.call_log = [{ ...CALL, id: 'c1', customer_id: 'cust-1', twilio_call_sid: 'CA1' }];
    mockRows.leads = [];
    const counts = await matchOpenLeads(new Date('2026-11-20T19:40:00Z'));
    expect(counts).toEqual({ matched: 1, ambiguous: 0, unmatched: 0, pending: 0 });
  });
});

describe('the repeated hour on the fall-back day', () => {
  test('01:30 on 2026-11-01 could be 05:30Z (EDT) or 06:30Z (EST): the window covers both', () => {
    const first = parseAccountTime('2026-11-01 01:30:00');
    expect(first.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    const w = matchWindow({ call_started_at: first });
    expect(w.start.toISOString()).toBe('2026-11-01T05:20:00.000Z'); // earlier instant - 10 min
    expect(w.end.toISOString()).toBe('2026-11-01T07:00:00.000Z'); // later instant + 30 min
  });

  test('a time outside the repeated hour keeps the plain window', () => {
    for (const t of ['2026-11-01 00:30:00', '2026-11-01 02:30:00']) {
      const at = parseAccountTime(t);
      const w = matchWindow({ call_started_at: at });
      expect(w.end.getTime() - w.start.getTime()).toBe(40 * 60 * 1000);
    }
  });

  test('the lead stays open until the later window end', () => {
    const lead = { lead_created_at: parseAccountTime('2026-11-01 01:30:00') };
    expect(windowClosed(lead, new Date('2026-11-01T06:59:59Z'))).toBe(false);
    expect(windowClosed(lead, new Date('2026-11-01T07:00:00Z'))).toBe(true);
  });
});

describe('runLeadSync', () => {
  const ENV = {
    GOOGLE_ADS_CLIENT_ID: 'cid', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
    GOOGLE_ADS_REFRESH_TOKEN: 'r', GOOGLE_ADS_CUSTOMER_ID: '1112223333',
  };
  let saved;
  beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, ENV); delete process.env.GOOGLE_LSA_CUSTOMER_ID; });
  afterEach(() => { process.env = saved; });

  test('not configured: no read, no write', async () => {
    delete process.env.GOOGLE_ADS_CLIENT_ID;
    expect(await Leads.runLeadSync()).toMatchObject({ configured: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('reads leads then conversations, stores the leads and matches them', async () => {
    mockQuery
      .mockResolvedValueOnce([{ local_services_lead: { resource_name: 'customers/1/localServicesLeads/7', lead_type: 3, creation_date_time: '2026-11-20 14:05:09', contact_details: { phone_number: '9415550142' } } }])
      .mockResolvedValueOnce([]);
    mockRows.lsa_leads = [];
    const out = await Leads.runLeadSync();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ configured: true, leads: 1 });
    expect(writesTo('lsa_leads', 'insert')).toHaveLength(1);
  });

  test('a failed lead read throws with Google\'s reason; a failed conversation read still stores the leads', async () => {
    mockQuery.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(Leads.runLeadSync()).rejects.toThrow(/read: .*invalid_grant/);
    expect(writesTo('lsa_leads', 'insert')).toHaveLength(0);

    mockQuery
      .mockResolvedValueOnce([{ local_services_lead: { resource_name: 'customers/1/localServicesLeads/8', lead_type: 2, creation_date_time: '2026-11-20 14:05:09', contact_details: { phone_number: '9415550143' } } }])
      .mockRejectedValueOnce(new Error('bad field'));
    mockRows.lsa_leads = [];
    const out = await Leads.runLeadSync();
    expect(out.leads).toBe(1);
  });
});
