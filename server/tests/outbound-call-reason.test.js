/**
 * Outbound call reason resolver (services/outbound-call-reason.js).
 *
 * Pins the owner-scoped ladder: quote-request auto-bridge by source →
 * callback of a specific inbound call (relatedCallId) → the more recent of
 * {inbound call, inbound text} inside the 48h lookback → generic. Spam /
 * robocall / wrong-number / vendor inbound calls never count as "returning
 * your call"; a probe failure falls back to generic rather than blocking.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-intent', () => ({ isSmsReaction: jest.fn((b) => /^(👍|❤️|Liked|Loved) ?/.test(String(b))) }));
jest.mock('../services/voice-agent/relay-protocol', () => ({
  whereNotSandboxCall: jest.fn((qb) => { qb.whereRaw('SANDBOX_EXCLUDED'); return qb; }),
}));

const db = require('../models/db');
const { whereNotSandboxCall } = require('../services/voice-agent/relay-protocol');
const {
  REASONS,
  LOOKBACK_MS,
  VISIT_IN_PROGRESS_WINDOW_MS,
  TEXT_SCAN_LIMIT,
  NON_SERVICE_NATURES,
  SERVICE_CONTACT_NATURES,
  NON_SERVICE_DISPOSITIONS,
  resolveOutboundCallReason,
  visitInProgress,
  nonServiceCaller,
  isSubstantiveText,
  hasPriorContact,
  nanpStoredPhoneClause,
  _private,
} = require('../services/outbound-call-reason');

const T0 = new Date('2026-09-08T15:00:00Z');
const hoursAgo = (h) => new Date(T0.getTime() - h * 3600000);
const PHONE = '+19415550101';

// A REAL, connection-less knex instance for compile-only SQL checks — the
// mocked ../models/db above (used by every other test in this file) never
// actually compiles SQL, so it cannot catch a knex binding-count mismatch
// (codex pre-push r7 P1, second push: a literal `?` inside the stored-phone
// clause's quoted regex was counted as an extra positional placeholder by
// knex's raw-query parser, which is not quote-aware, and threw "Expected 1
// bindings, saw 2" on every real compile). `.toSQL()` never opens a
// connection, so this needs no database.
const realKnex = require('knex')({ client: 'pg' });

// state.byTable: table → array of rows for first()/select(); queries record
// their where() args so the lookback and contact predicate can be asserted.
let state;
function installDb(byTable = {}) {
  state = { byTable, queries: [] };
  db.mockImplementation((table) => {
    const q = { table, wheres: [], raws: [] };
    state.queries.push(q);
    const b = {};
    b.where = jest.fn((...a) => { q.wheres.push(a); if (typeof a[0] === 'function') a[0].call(b); return b; });
    b.orWhere = jest.fn((...a) => { q.wheres.push(['OR', ...a]); return b; });
    b.whereRaw = jest.fn((...a) => { q.raws.push(a); return b; });
    b.orderBy = jest.fn(() => b);
    q.limits = [];
    b.limit = jest.fn((n) => { q.limits.push(n); return b; });
    const rowsFor = () => {
      const isQuoteBridge = table === 'call_log' && q.wheres.some((w) => w[0] === 'direction' && w[1] === 'outbound');
      if (isQuoteBridge) return state.byTable.quote_bridges || [];
      // anyLeadRecord's leads query (no fromContact wrapper — that helper
      // always pushes a FUNCTION where, so this only matches the direct,
      // customerId-less phone query anyLeadRecord runs): apply the recorded
      // first_contact_channel allowlist for real, so channel-scoping tests
      // (codex pre-push r4 P1) prove genuine filtering, not just query
      // shape. latestQuoteFormLead's fromContact-wrapped queries elsewhere
      // in this file are untouched.
      if (table === 'leads' && !q.wheres.some((w) => typeof w[0] === 'function')) {
        const allowlistEntry = q.wheres.find((w) => w[0] === 'IN' && w[1] === 'first_contact_channel');
        // anyLeadRecord's status exclusion (codex pre-push r7 P1): applied
        // for real, same as the channel allowlist — a NULL status fails
        // closed too (SQL's three-valued logic), matching whereIn's own
        // NULL handling just above.
        const statusExclude = q.wheres.find((w) => w[0] === 'NOT IN' && w[1] === 'status');
        // codex r9 P2: only confirmed spam is excluded now (whereNot).
        const statusNot = q.wheres.find((w) => w[0] === 'NOT' && w[1] === 'status');
        let rows = state.byTable.leads || [];
        if (allowlistEntry) rows = rows.filter((r) => allowlistEntry[2].includes(r.first_contact_channel));
        if (statusExclude) rows = rows.filter((r) => r.status != null && !statusExclude[2].includes(r.status));
        if (statusNot) rows = rows.filter((r) => r.status != null && r.status !== statusNot[2]);
        return rows;
      }
      // existsQualifyingInboundCall's call_log query (identified by its own
      // whereRaw nature clause — latestInboundCall's JS-side filtering
      // elsewhere in this file never adds one): apply the recorded
      // v2_extraction_status gate plus the nature AND disposition
      // exclusions for real (codex pre-push r5 P1 + r6 P1 + r7 P1), reusing
      // _private.callNature so the mock's extraction matches the module's
      // own.
      if (table === 'call_log') {
        const natureClause = q.raws.find((r) => String(r[0]).includes('call_nature'));
        const dispositionClause = q.raws.find((r) => String(r[0]).includes('disposition'));
        if (natureClause || dispositionClause) {
          const v2Clause = q.wheres.find((w) => w[0] === 'v2_extraction_status');
          const rows = state.byTable.call_log || [];
          return rows.filter((r) => {
            if (v2Clause && r.v2_extraction_status !== v2Clause[1]) return false;
            // The nature clause is an ALLOWLIST (IN) since codex r8; a NOT IN
            // clause would be a denylist. Apply whichever the SQL says.
            if (natureClause) {
              const listed = natureClause[1].includes(_private.callNature(r));
              const allowlist = !/NOT IN/i.test(String(natureClause[0]));
              if (allowlist ? !listed : listed) return false;
            }
            // codex r9 P1: a voicemail needs a linked live lead (the EXISTS
            // clause). Tests mark that with linked_lead: true.
            const voicemailLink = q.raws.find((r2) => String(r2[0]).includes('EXISTS (SELECT 1 FROM leads'));
            if (voicemailLink && _private.callNature(r) === 'voicemail_message' && r.linked_lead !== true) return false;
            if (dispositionClause && dispositionClause[1].includes(String(r.disposition || ''))) return false;
            return true;
          });
        }
      }
      // existsQualifyingInboundText's sms_log query (identified by its own
      // whereRaw spam_verdict clause — latestInboundText's JS-side
      // filtering elsewhere in this file never adds one): apply the
      // enforced-solicitation exclusion for real (codex pre-push r7 P1).
      if (table === 'sms_log') {
        const spamClause = q.raws.find((r) => String(r[0]).includes('spam_verdict'));
        if (spamClause) {
          const rows = state.byTable.sms_log || [];
          return rows.filter((r) => {
            const meta = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
            return meta?.spam_verdict?.enforced !== true;
          });
        }
      }
      return state.byTable[table] || [];
    };
    b.whereIn = jest.fn((...a) => { q.wheres.push(['IN', ...a]); return b; });
    b.whereNotIn = jest.fn((...a) => { q.wheres.push(['NOT IN', ...a]); return b; });
    b.whereNot = jest.fn((...a) => { q.wheres.push(['NOT', ...a]); return b; });
    b.orWhereNotIn = jest.fn((...a) => { q.wheres.push(['OR NOT IN', ...a]); return b; });
    b.whereNull = jest.fn((...a) => { q.wheres.push(['NULL', ...a]); return b; });
    b.orWhereBetween = jest.fn((...a) => { q.wheres.push(['OR BETWEEN', ...a]); return b; });
    b.whereBetween = jest.fn((...a) => { q.wheres.push(['BETWEEN', ...a]); return b; });
    b.join = jest.fn((...a) => { q.wheres.push(['JOIN', ...a]); return b; });
    b.modify = jest.fn((fn) => { fn(b); return b; });
    b.select = jest.fn(async () => rowsFor());
    b.first = jest.fn(async () => rowsFor()[0]);
    return b;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  installDb();
});

const call = (over = {}) => ({ id: 'cl-1', source: 'admin-click', customer_id: 'cust-1', metadata: null, created_at: T0, ...over });

describe('helpers', () => {
  test('last10 / callNature / parseMetadata', () => {
    expect(_private.last10('(941) 555-0101')).toBe('9415550101');
    expect(_private.last10('+19415550101')).toBe('9415550101');
    expect(_private.last10('12345')).toBeNull();
    expect(_private.callNature({ ai_extraction_enriched: { call_nature: ' New_Lead ' } })).toBe('new_lead');
    expect(_private.callNature({ ai_extraction_enriched: JSON.stringify({ call_nature: 'robocall' }) })).toBe('robocall');
    expect(_private.callNature({ ai_extraction_enriched: 'not json' })).toBe('');
    expect(_private.parseMetadata('{"relatedCallId":"x"}')).toEqual({ relatedCallId: 'x' });
    expect(_private.parseMetadata({ a: 1 })).toEqual({ a: 1 });
    expect(_private.parseMetadata('garbage')).toEqual({});
  });
});

describe('resolveOutboundCallReason', () => {
  test('lead-webhook auto-bridge → quote_request without touching the DB', async () => {
    const r = await resolveOutboundCallReason({ call: call({ source: 'lead-webhook-auto-bridge' }), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.QUOTE_REQUEST, evidence: { source: 'lead-webhook-auto-bridge' } });
    expect(db).not.toHaveBeenCalled();
  });

  test('relatedCallId pointing at a real inbound call → returning_call, no further probes', async () => {
    installDb({ call_log: [{ id: 'in-9', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'existing_customer_scheduling' } }] });
    const r = await resolveOutboundCallReason({ call: call({ source: 'admin-callback', metadata: { relatedCallId: 'in-9' } }), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.RETURNING_CALL, evidence: { related_call_id: 'in-9', at: hoursAgo(1) } });
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].wheres[0]).toEqual([{ id: 'in-9', direction: 'inbound' }]);
  });

  test('relatedCallId to a spam-natured call is ignored and the lookback probes run', async () => {
    installDb({ call_log: [{ id: 'in-9', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'spam_solicitation' } }] });
    // The lookback probe returns the same spam row → filtered → no call; no text → generic.
    const r = await resolveOutboundCallReason({ call: call({ metadata: { relatedCallId: 'in-9' } }), phone: PHONE });
    expect(r.reason).toBe(REASONS.GENERIC);
    expect(state.queries.map((q) => q.table)).toEqual(['call_log', 'call_log', 'sms_log', 'leads', 'call_log']);
  });

  test('the literal "undefined" relatedCallId is not looked up', async () => {
    await resolveOutboundCallReason({ call: call({ metadata: { relatedCallId: 'undefined' } }), phone: PHONE });
    expect(state.queries.map((q) => q.table)).toEqual(['call_log', 'sms_log', 'leads', 'call_log']);
  });

  test('inbound call inside 48h, no text → returning_call', async () => {
    installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(5), ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.RETURNING_CALL, evidence: { inbound_call_id: 'in-1', at: hoursAgo(5) } });
  });

  test('inbound text inside 48h, no call → saw_text', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.SAW_TEXT, evidence: { inbound_sms_id: 'sms-1', at: hoursAgo(1) } });
  });

  test('both inside 48h → the MORE RECENT wins (text newer)', async () => {
    installDb({
      call_log: [{ id: 'in-1', created_at: hoursAgo(5), ai_extraction_enriched: { call_nature: 'new_lead' } }],
      sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.SAW_TEXT);
  });

  test('both inside 48h → the MORE RECENT wins (call newer, tie goes to the call)', async () => {
    installDb({
      call_log: [{ id: 'in-1', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'new_lead' } }],
      sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.RETURNING_CALL);
  });

  test('a spam/robocall/wrong-number/vendor inbound call is skipped in favour of the next real one', async () => {
    installDb({
      call_log: [
        { id: 'in-spam', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'robocall' } },
        { id: 'in-real', created_at: hoursAgo(3), ai_extraction_enriched: { call_nature: 'billing_question' } },
      ],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.evidence.inbound_call_id).toBe('in-real');
  });

  test('an unprocessed inbound call (no extraction yet) still counts', async () => {
    installDb({ call_log: [{ id: 'in-raw', created_at: hoursAgo(2), ai_extraction_enriched: null }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.RETURNING_CALL);
  });

  test('lookback is 48h ending at the outbound call time; contact predicate uses customer_id OR the dialed last-10', async () => {
    await resolveOutboundCallReason({ call: call(), phone: '(941) 555-0101' });
    const [callQ, smsQ] = state.queries;
    for (const q of [callQ, smsQ]) {
      expect(q.wheres).toEqual(expect.arrayContaining([
        ['direction', 'inbound'],
        ['created_at', '<', T0],
        ['created_at', '>=', new Date(T0.getTime() - LOOKBACK_MS)],
        ['customer_id', 'cust-1'],
      ]));
      const orRaw = q.wheres.find((w) => w[0] === 'OR');
      expect(orRaw[1].__raw).toContain('from_phone');
      expect(orRaw[1].bindings).toEqual(['9415550101']);
    }
    expect(LOOKBACK_MS).toBe(48 * 3600000);
  });

  test('no customer and no usable phone → contact predicate is false, generic', async () => {
    const r = await resolveOutboundCallReason({ call: call({ customer_id: null }), phone: '' });
    expect(r.reason).toBe(REASONS.GENERIC);
    for (const q of state.queries) expect(q.raws).toContainEqual(['false']);
    expect(state.queries).toHaveLength(4);
  });

  test('the inbound-text scan excludes recruiting (job_*) sms_log rows — an applicant reply on a shared phone is never the "saw your text" (PR #4623 Codex r31 P2)', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }] });
    await resolveOutboundCallReason(call({ customer_id: null, metadata: { to: PHONE } }));
    const sms = state.queries.find((q) => q.table === 'sms_log');
    expect(sms.wheres).toEqual(expect.arrayContaining([['NULL', 'message_type'], ['OR', 'message_type', 'not like', 'job\\_%']]));
  });

  test('phone-only contact (no customer) uses a plain where on the last-10', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }] });
    const r = await resolveOutboundCallReason({ call: call({ customer_id: null }), phone: PHONE });
    expect(r.reason).toBe(REASONS.SAW_TEXT);
    // no customer arm: the only OR in the query is the recruiting-row exclusion's (message_type)
    expect(state.queries[1].wheres.some((w) => w[0] === 'OR' && w[1] !== 'message_type')).toBe(false);
  });

  test('our own quote-form bridge to them inside 48h → quote_request (the follow-up call is about the quote)', async () => {
    installDb({ quote_bridges: [{ id: 'ab-1', created_at: hoursAgo(45) }] });
    const r = await resolveOutboundCallReason({ call: call({ source: 'admin-callback' }), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.QUOTE_REQUEST, evidence: { quote_bridge_call_id: 'ab-1', at: hoursAgo(45) } });
    const q = state.queries.find((x) => x.wheres.some((w) => w[0] === 'direction' && w[1] === 'outbound'));
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['IN', 'source', ['lead-webhook-auto-bridge']],
      ['created_at', '>=', new Date(T0.getTime() - LOOKBACK_MS)],
    ]));
    expect(q.wheres.find((w) => w[0] === 'OR')[1].__raw).toContain("metadata->>'leadPhone'");
  });

  test('a quote bridge loses to a MORE RECENT inbound call or text', async () => {
    installDb({
      quote_bridges: [{ id: 'ab-1', created_at: hoursAgo(40) }],
      call_log: [{ id: 'in-1', created_at: hoursAgo(7), ai_extraction_enriched: { call_nature: 'new_lead' } }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.RETURNING_CALL);
  });

  test('a web quote-form lead inside 48h → quote_request even when the after-hours bridge never fired', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(19) }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.QUOTE_REQUEST, evidence: { quote_lead_id: 'lead-1', at: hoursAgo(19) } });
    const q = state.queries.find((x) => x.table === 'leads');
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['NULL', 'deleted_at'],
      ['IN', 'first_contact_channel', ['form', 'website_quote']],
      ['created_at', '>=', new Date(T0.getTime() - LOOKBACK_MS)],
    ]));
    expect(q.wheres.find((w) => w[0] === 'OR')[1].__raw).toContain('phone');
  });

  test('one-word acknowledgements, reactions, empty MMS and reschedule replies do NOT count as "your text"', async () => {
    installDb({
      sms_log: [
        { id: 'ack', created_at: hoursAgo(1), message_body: 'Ok' },
        { id: 'menu', created_at: hoursAgo(2), message_body: '1', message_type: 'reschedule_reply' },
        { id: 'thanks', created_at: hoursAgo(3), message_body: 'Great! Thank you' },
        { id: 'react', created_at: hoursAgo(4), message_body: 'Liked "Adam is on the way"' },
        { id: 'empty', created_at: hoursAgo(5), message_body: '' },
        { id: 'real', created_at: hoursAgo(6), message_body: 'I thought you were coming Monday' },
      ],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.SAW_TEXT, evidence: { inbound_sms_id: 'real', at: hoursAgo(6) } });
  });

  test('isSubstantiveText', () => {
    for (const b of ['Ok', 'okay!', 'k', 'yes', 'Thanks', 'Great! Thank you', 'sounds good', '1', '', '   ', '👍', '5125']) {
      expect(isSubstantiveText({ message_body: b })).toBe(false);
    }
    expect(isSubstantiveText({ message_body: 'Can I call you later?' })).toBe(true);
    expect(isSubstantiveText({ message_body: 'Can I call you later?', message_type: 'reschedule_reply' })).toBe(false);
    expect(isSubstantiveText({ message_body: 'looking for a wdo on 12211 Violet Jasper Dr' })).toBe(true);
  });

  test('every call_log probe excludes voice-relay sandbox calls (dry-run scanner contract)', async () => {
    installDb({ call_log: [{ id: 'in-9', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await resolveOutboundCallReason({ call: call({ metadata: { relatedCallId: 'in-9' } }), phone: PHONE });
    installDb({});
    await resolveOutboundCallReason({ call: call(), phone: PHONE });
    await nonServiceCaller({ customerId: 'cust-1', phone: PHONE, relatedCallId: 'in-9', before: T0 });
    await nonServiceCaller({ customerId: 'cust-1', phone: PHONE, before: T0 });
    for (const q of state.queries.filter((x) => x.table === 'call_log')) {
      expect(q.raws).toContainEqual(['SANDBOX_EXCLUDED']);
    }
    expect(whereNotSandboxCall).toHaveBeenCalled();
  });

  test('the text probe scans deep enough that a run of acknowledgements cannot hide the real inquiry', async () => {
    expect(TEXT_SCAN_LIMIT).toBeGreaterThanOrEqual(25);
    await resolveOutboundCallReason({ call: call(), phone: PHONE });
    const smsQ = state.queries.find((x) => x.table === 'sms_log');
    expect(smsQ.limits).toEqual([TEXT_SCAN_LIMIT]);
  });

  test('nothing in the lookback → generic', async () => {
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.GENERIC, evidence: {} });
  });

  test('visitInProgress: TODAY\'s (ET) en_route/on_site visit, or an en_route/arrived stamp inside the last 3h; visit booked after the call never counts', async () => {
    installDb({ 'scheduled_services as ss': [{ id: 'v1' }] });
    await expect(visitInProgress({ customerId: 'cust-1', before: T0 })).resolves.toBe(true);
    const q = state.queries[0];
    expect(q.table).toBe('scheduled_services as ss');
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['ss.customer_id', 'cust-1'],
      ['ss.created_at', '<', T0],
      ['IN', 'ss.status', ['en_route', 'on_site']],
      ['OR BETWEEN', 'ss.en_route_at', [new Date(T0.getTime() - VISIT_IN_PROGRESS_WINDOW_MS), T0]],
      ['OR BETWEEN', 'ss.arrived_at', [new Date(T0.getTime() - VISIT_IN_PROGRESS_WINDOW_MS), T0]],
    ]));
    // The live-status branch is fenced to the call's ET calendar day — never an
    // adjacent day (codex r1 P1: yesterday's stale on_site row silenced today's text).
    expect(q.wheres).toContainEqual(['ss.scheduled_date', '2026-09-08']);
    expect(q.wheres.some((w) => w[0] === 'BETWEEN' && w[1] === 'ss.scheduled_date')).toBe(false);
    expect(q.wheres.some((w) => w[0] === 'JOIN')).toBe(false);
    expect(VISIT_IN_PROGRESS_WINDOW_MS).toBe(3 * 3600000);
    installDb({});
    await expect(visitInProgress({ customerId: 'cust-1', before: T0 })).resolves.toBe(false);
    await expect(visitInProgress({ customerId: null, phone: null, before: T0 })).resolves.toBe(false);
    expect(state.queries).toHaveLength(1);
  });

  test('visitInProgress: an en-route / arrived text WE sent that number inside 3h counts (no customer link, no visit stamp needed)', async () => {
    installDb({ sms_log: [{ id: 'sms-arrived' }] });
    await expect(visitInProgress({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    const q = state.queries.find((x) => x.table === 'sms_log');
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['direction', 'outbound'],
      ['IN', 'message_type', ['tech_en_route', 'tech_arrived']],
      ['created_at', '>=', new Date(T0.getTime() - VISIT_IN_PROGRESS_WINDOW_MS)],
      ['created_at', '<', T0],
    ]));
    expect(q.raws[0][0]).toContain('to_phone');
    expect(q.raws[0][1]).toEqual(['9415550101']);
  });

  test('visitInProgress with no linked customer matches the dialed number to a customer record', async () => {
    installDb({ 'scheduled_services as ss': [{ id: 'v1' }] });
    await expect(visitInProgress({ customerId: null, phone: '(941) 555-0101', before: T0 })).resolves.toBe(true);
    const q = state.queries[0];
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['JOIN', 'customers as c', 'c.id', 'ss.customer_id'],
      ['NULL', 'c.deleted_at'],
    ]));
    expect(q.raws[0][0]).toContain('c.phone');
    expect(q.raws[0][1]).toEqual(['9415550101']);
  });

  test('nonServiceCaller: the call being returned (relatedCallId) has a non-service nature → true', async () => {
    expect([...NON_SERVICE_NATURES].sort()).toEqual(['job_applicant', 'other', 'robocall', 'spam_solicitation', 'vendor_or_partner', 'wrong_number']);
    installDb({ call_log: [{ id: 'in-9', ai_extraction_enriched: { call_nature: 'other' } }] });
    await expect(nonServiceCaller({ customerId: 'cust-1', phone: PHONE, relatedCallId: 'in-9', before: T0 })).resolves.toBe(true);
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].wheres[0]).toEqual([{ id: 'in-9', direction: 'inbound' }]);
  });

  test('nonServiceCaller: no relatedCallId → the most recent inbound call inside 48h decides, whatever its nature', async () => {
    installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'job_applicant' } }] });
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    installDb({ call_log: [{ id: 'in-raw', created_at: hoursAgo(1), ai_extraction_enriched: null }] });
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    installDb({});
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    await expect(nonServiceCaller({ customerId: null, phone: null, before: T0 })).resolves.toBe(false);
  });

  test('a probe failure falls back to generic instead of throwing', async () => {
    db.mockImplementation(() => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.GENERIC, evidence: { error: 'ECONNREFUSED' } });
  });

  test('missing created_at resolves against now', async () => {
    const before = Date.now();
    await resolveOutboundCallReason({ call: call({ created_at: null }), phone: PHONE });
    const lt = state.queries[0].wheres.find((w) => w[1] === '<')[2];
    expect(lt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

// hasPriorContact backs the outbound return-message gate
// (GATE_CALL_OUTBOUND_RETURN_MESSAGES, owner ruling 2026-09-26): UNBOUNDED,
// unlike resolveOutboundCallReason's own 48h LOOKBACK_MS above — a lead from
// months ago still counts as "they contacted us first".
describe('hasPriorContact', () => {
  test('an existing customer is prior contact without touching the DB', async () => {
    await expect(hasPriorContact({ customerId: 'cust-1', phone: PHONE, before: T0 })).resolves.toBe(true);
    expect(db).not.toHaveBeenCalled();
  });

  test('no customer, no usable phone → false, no DB query', async () => {
    await expect(hasPriorContact({ customerId: null, phone: null, before: T0 })).resolves.toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('no customer, nothing on file for the phone → false (cold/sales call)', async () => {
    installDb({});
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  // codex r8 P1: the call probe is an allowlist of service natures.
  test.each(['new_lead', 'existing_customer_service', 'existing_customer_scheduling', 'billing_question'])(
    'a prior valid inbound call with service nature %s counts',
    async (nature) => {
      installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(5), v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: nature } }] });
      await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    },
  );

  test.each([['silent_or_noise'], ['voicemail_message'], ['other'], [null]])(
    'a prior valid inbound call with nature %p and no linked lead never counts (fails closed)',
    async (nature) => {
      installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(5), v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: nature } }] });
      await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    },
  );

  test('a service voicemail the pipeline tied to a live lead counts (codex r9 P1)', async () => {
    installDb({ call_log: [{ id: 'vm-1', created_at: hoursAgo(5), v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'voicemail_message' }, linked_lead: true }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  test('the voicemail linkage clause requires a live, non-spam lead by sid or stamped id', async () => {
    installDb({ call_log: [{ id: 'vm-1' }] });
    await hasPriorContact({ customerId: null, phone: PHONE, before: T0 });
    const callQuery = state.queries.find((q) => q.table === 'call_log');
    const link = callQuery.raws.find((r) => String(r[0]).includes('EXISTS (SELECT 1 FROM leads'));
    expect(link[0]).toContain("<> 'voicemail_message'");
    expect(link[0]).toContain('l.deleted_at IS NULL');
    expect(link[0]).toContain("l.status <> 'spam'");
    expect(link[0]).toContain('l.twilio_call_sid = call_log.twilio_call_sid');
    expect(link[0]).toContain("call_log.metadata->>'lead_id'");
    expect(link[0]).not.toContain('?');
  });

  test('the call probe is exactly the service allowlist', () => {
    expect([...SERVICE_CONTACT_NATURES].sort()).toEqual(['billing_question', 'existing_customer_scheduling', 'existing_customer_service', 'new_lead']);
  });

  test('a prior inbound call from that number, even a year ago, counts', async () => {
    installDb({ call_log: [{ id: 'in-old', created_at: new Date('2025-01-01'), v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  // Codex pre-push r7 P1: NANP-only phone identity. hasPriorContact uses
  // phoneIdentityKey (server/utils/phone.js), the same NANP-vs-
  // international rule as smsThreadKey and the blocked-numbers query — a
  // non-NANP destination never collapses to a bare last-10, so it can never
  // collide with an unrelated NANP number sharing the same suffix (codex
  // #4213). Waves is SWFL-only, so this fails closed rather than probe.
  test('a non-NANP (international) phone number → no prior contact, no DB query', async () => {
    installDb({ call_log: [{ id: 'in-old', v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(hasPriorContact({ customerId: null, phone: '+442079460958', before: T0 })).resolves.toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('every common NANP format (bare 10, 1+10, formatted, +1) still resolves to the same last-10 identity and counts', async () => {
    installDb({ call_log: [{ id: 'in-old', v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    for (const phone of ['9415550101', '19415550101', '(941) 555-0101', '+19415550101']) {
      await expect(hasPriorContact({ customerId: null, phone, before: T0 })).resolves.toBe(true);
    }
  });

  // The mock query builder can't evaluate SQL predicates itself — it always
  // "returns" whatever rows a test installs, regardless of WHERE clauses —
  // so a nature exclusion is proven by asserting the QUERY the code built,
  // not by the mock filtering rows for us. Real Postgres applies it.
  test('the call probe is a SERVICE_CONTACT_NATURES allowlist IN SQL, not via a row cap (codex pre-push r1 P2 + r5 P1 + r8 P1)', async () => {
    installDb({ call_log: [{ id: 'in-spam' }] });
    await hasPriorContact({ customerId: null, phone: PHONE, before: T0 });
    const callQuery = state.queries.find((q) => q.table === 'call_log');
    expect(callQuery.limits).toHaveLength(0); // no row cap
    const natureClause = callQuery.raws.find((r) => String(r[0]).includes('call_nature'));
    // An ALLOWLIST since codex r8: only positively service-classified
    // natures count. job_applicant, other, silent_or_noise, voicemail_message
    // and a null nature all fail closed.
    expect(natureClause[0]).toContain(' IN (');
    expect(natureClause[0]).not.toContain('NOT IN');
    // voicemail_message is listed but gated on a linked lead (codex r9 P1).
    expect(natureClause[1]).toEqual([...SERVICE_CONTACT_NATURES, 'voicemail_message']);
    for (const excluded of ['job_applicant', 'other', 'silent_or_noise']) {
      expect(natureClause[1]).not.toContain(excluded);
    }
    // Codex pre-push r7 P1: v2_extraction_status = 'valid' is a plain
    // equality where, applied ALONGSIDE the nature/disposition exclusions,
    // not a replacement for the legacy call_outcome / processing_status /
    // ai_extraction.call_type fields — those are never read at all.
    expect(callQuery.wheres).toContainEqual(['v2_extraction_status', 'valid']);
    for (const legacyField of ['call_outcome', 'processing_status']) {
      expect(callQuery.wheres.flat().join(' ')).not.toContain(legacyField);
      expect(callQuery.raws.flat().map(String).join(' ')).not.toContain(legacyField);
    }
  });

  // Codex pre-push r7 P1 (second finding, on push): the NANP check above
  // only validates the REQUESTED phone. Without ALSO requiring the STORED
  // column's full digit string to be NANP-shaped, an international number
  // whose full digits merely END in the same 10 digits as a NANP
  // identityKey would still pass the last-10 equality — the same
  // shared-suffix collision codex #4213 already fixed on the requested
  // side, reopened here on the stored side. The mock can't evaluate SQL
  // regexes itself, so this asserts the QUERY the code built, not a row
  // result — real Postgres applies `~ '^1?\d{10}$'`.
  test('every hasPriorContact probe requires the STORED phone column to be NANP-shaped too, not just suffix-equal (codex pre-push r7 P1)', async () => {
    installDb({
      call_log: [{ id: 'c1', v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'new_lead' } }],
      sms_log: [{ id: 's1', message_body: 'Can you come look at the ants?' }],
      leads: [{ id: 'l1', first_contact_channel: 'web', status: 'new' }],
    });
    await hasPriorContact({ customerId: null, phone: PHONE, before: T0 });
    const callQ = state.queries.find((q) => q.table === 'call_log');
    const smsQ = state.queries.find((q) => q.table === 'sms_log');
    const leadsQ = state.queries.find((q) => q.table === 'leads');
    for (const [q, column] of [[callQ, 'from_phone'], [smsQ, 'from_phone'], [leadsQ, 'phone']]) {
      const clause = q.raws.find((r) => String(r[0]).includes('regexp_replace'));
      expect(clause[0]).toBe(nanpStoredPhoneClause(column));
      expect(clause[0]).toContain("~ '^1{0,1}\\d{10}$'");
      expect(clause[1]).toEqual(['9415550101']);
    }
  });

  // Codex pre-push r7 P1 (on push, after the fix above landed): knex's raw
  // binding parser is not quote-aware — it counts EVERY `?` in the SQL
  // text, including one sitting inside a quoted regex literal. The mocked
  // db above can never catch this class of bug because it never compiles
  // SQL at all; a REAL, connection-less knex instance does.
  test('nanpStoredPhoneClause compiles under REAL knex with exactly the bindings supplied (mocked db cannot catch a binding-count mismatch)', () => {
    for (const column of ['phone', 'from_phone', 'c.phone']) {
      const clause = nanpStoredPhoneClause(column);
      // No bare `?` other than the one real placeholder — a second bare
      // `?` (e.g. an unescaped regex quantifier) is exactly what broke
      // knex's binding count on push.
      expect(clause.split('?').length - 1).toBe(1);
      const { sql, bindings } = realKnex('call_log').whereRaw(clause, ['9415550101']).toSQL();
      expect(bindings).toEqual(['9415550101']);
      expect(sql).toContain(column === 'c.phone' ? 'c.phone' : column);
    }
  });

  test('a job_applicant-only call history does NOT count as prior contact (codex pre-push r5 P1)', async () => {
    installDb({ call_log: [{ id: 'in-applicant', v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'job_applicant' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('an "other"-natured call history does NOT count as prior contact either (codex pre-push r5 P1)', async () => {
    installDb({ call_log: [{ id: 'in-other', v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'other' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('a genuine new_lead-natured call still counts as prior contact', async () => {
    installDb({ call_log: [{ id: 'in-lead', v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  // Codex pre-push r7 P1: v2_extraction_status = 'valid' is now REQUIRED,
  // not just a nature/disposition check — a row the V2 pipeline never
  // classified is not positively known to be a service contact, no matter
  // what nature it happens to carry.
  test('a new_lead-natured call with NO v2_extraction_status (never reached the V2 pipeline) does NOT count', async () => {
    installDb({ call_log: [{ id: 'in-unclassified', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('a call whose V2 extraction failed to parse (v2_extraction_status: parse_failed) does NOT count', async () => {
    installDb({ call_log: [{ id: 'in-failed', v2_extraction_status: 'parse_failed', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  // Codex pre-push r6 P1 (superseded by r7 P1 below): a disposition-only,
  // no-V2-nature row already failed the disposition exclusion on its own
  // for these four values; it now ALSO fails the v2_extraction_status gate
  // — either reason alone would fail it closed, and both apply together.
  test.each(['vendor_logged', 'wrong_number_closed', 'spam_discarded', 'no_action_needed'])(
    'a disposition-only (no V2 nature, no V2 extraction) %s history does NOT count as prior contact',
    async (disposition) => {
      installDb({ call_log: [{ id: 'in-old-disposition', disposition }] });
      await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    },
  );

  // Codex pre-push r7 P1 (required "legacy-only history" case): a
  // pre-V2 legacy row — no v2_extraction_status, no ai_extraction_enriched
  // nature — carrying only a SERVICE disposition (e.g. 'booked') from
  // call-disposition.js's decideDisposition is NOT positively classified by
  // the current pipeline and must NOT count, even though the r6 rule alone
  // would have let it through on disposition. This is the exact case r6's
  // now-removed test asserted the opposite of; the whole point of the r7
  // fix is that a legacy shape like this must fail closed.
  test('a legacy-only history (no v2_extraction_status, only a SERVICE disposition) does NOT count as prior contact', async () => {
    installDb({ call_log: [{ id: 'in-old-booked', disposition: 'booked' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('a valid V2 row with NO nature never counts, even with a booked disposition (codex r8: the nature allowlist fails closed)', async () => {
    // The schema says a null call_nature means "truly indeterminate". Only
    // a positively service-classified nature grants implied consent.
    installDb({ call_log: [{ id: 'in-modern-booked', v2_extraction_status: 'valid', disposition: 'booked' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('the call probe reuses only literals that are live members of call-disposition.js\'s TERMINAL_DISPOSITIONS enum (never a drifted copy)', () => {
    const { TERMINAL_DISPOSITIONS } = require('../services/call-disposition');
    expect(NON_SERVICE_DISPOSITIONS.length).toBeGreaterThan(0);
    for (const d of NON_SERVICE_DISPOSITIONS) {
      expect(TERMINAL_DISPOSITIONS).toContain(d);
    }
    // And NOT a service disposition — 'booked' proves the two sets are
    // genuinely disjoint, not one accidentally aliasing the other.
    expect(NON_SERVICE_DISPOSITIONS).not.toContain('booked');
  });

  test('a prior substantive inbound text counts, and the probe never caps rows at TEXT_SCAN_LIMIT (codex pre-push r1 P2)', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(2), message_body: 'Can you come look at the ants?', message_type: 'inbound' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    const smsQuery = state.queries.find((q) => q.table === 'sms_log');
    expect(smsQuery.limits).toHaveLength(0);
    // The ignored-type exclusion is grouped as NULL OR NOT IN (codex pre-push
    // r2 P1) — a bare whereNotIn would silently drop every null-typed row,
    // SQL's three-valued logic for `NULL NOT IN (...)`.
    expect(smsQuery.wheres.some((w) => w[0] === 'NULL' && w[1] === 'message_type')).toBe(true);
    expect(smsQuery.wheres.some((w) => w[0] === 'OR NOT IN' && w[1] === 'message_type')).toBe(true);
  });

  test('a substantive text with a NULL message_type still counts (codex pre-push r2 P1: NOT IN alone drops NULL rows)', async () => {
    installDb({ sms_log: [{ id: 'sms-null-type', created_at: hoursAgo(2), message_body: 'Can you come look at the ants?', message_type: null }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  // Codex pre-push r7 P1: exclude any inbound text the SMS spam screen
  // flagged (sms_log.metadata.spam_verdict.enforced) — the exact fragment
  // twilio-webhook.js's own unanswered-digest exclusion uses. An enforced
  // verdict means the text was silently screened out, not a real
  // conversation the sender had with Waves.
  test('an inbound text the spam screen enforced (metadata.spam_verdict.enforced) does NOT count, even with real words', async () => {
    installDb({
      sms_log: [{
        id: 'sms-spam', created_at: hoursAgo(2), message_body: 'Check out our amazing deal today',
        metadata: { spam_verdict: { solicitation: true, confidence: 0.91, mode: 'enforce', enforced: true } },
      }],
    });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('an inbound text the spam classifier scored but did NOT enforce still counts', async () => {
    installDb({
      sms_log: [{
        id: 'sms-scored-not-enforced', created_at: hoursAgo(2), message_body: 'Can you come look at the ants?',
        metadata: { spam_verdict: { solicitation: false, confidence: 0.2, mode: 'shadow', enforced: false } },
      }],
    });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  test('a text thread of only reschedule replies / bare acknowledgements does not count — isSubstantiveText still applies over the unbounded set', async () => {
    installDb({
      sms_log: [
        { id: 'ack-1', message_body: 'Ok thanks', message_type: null },
        { id: 'ack-2', message_body: 'Can you come look at the ants?', message_type: 'reschedule_reply' },
      ],
    });
    // Both rows fail isSubstantiveText (a bare closer, and an ignored type) —
    // even though the mock "returned" them (it can't apply the SQL filters),
    // the JS classifier still rejects them.
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  // Codex pre-push r4 P1: a lead row only counts as prior-contact evidence
  // when the CUSTOMER originated it — a staff-created row (admin manual
  // entry, tech field observation, tech-run lawn diagnostic) proves a
  // staffer typed a number, never that its owner contacted Waves. Reuses
  // the SAME allowlist server/services/collections/consent-provenance.js
  // already applies for the identical question in the collections
  // contact-policy, rather than a second list that could drift from it.
  test('a staff-created (manual) lead does NOT count as prior contact', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'manual' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('a customer-originated web-form lead counts as prior contact', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'web', status: 'new' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  test('a lead with a NULL first_contact_channel does NOT count (unknown fails closed)', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: null, status: 'new' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  // Codex r9 P2: status is lifecycle, not provenance. Only confirmed spam
  // disqualifies a customer-originated lead; a cancelled lead, or a
  // duplicate of another real lead, still proves the person contacted us.
  test('a customer-originated lead marked spam does NOT count as prior contact', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'web', status: 'spam' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test.each(['duplicate', 'cancelled'])(
    'a customer-originated lead later marked %s still counts as prior contact',
    async (status) => {
      installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'web', status }] });
      await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    },
  );

  test('a lead with a NULL status does NOT count (unknown fails closed, same as a NULL first_contact_channel)', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'web', status: null }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('a lead in an ENGAGED status (contacted, won, lost) still counts as prior contact', async () => {
    for (const status of ['contacted', 'won', 'lost']) {
      installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'web', status }] });
      await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    }
  });

  test('the lead probe excludes exactly one status, confirmed spam', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'web', status: 'new' }] });
    await hasPriorContact({ customerId: null, phone: PHONE, before: T0 });
    const leadsQuery = state.queries.find((q) => q.table === 'leads');
    expect(leadsQuery.wheres.find((w) => w[0] === 'NOT' && w[1] === 'status')).toEqual(['NOT', 'status', 'spam']);
    expect(leadsQuery.wheres.find((w) => w[0] === 'NOT IN' && w[1] === 'status')).toBeUndefined();
  });

  test('the lead probe reuses the consent-provenance allowlist, minus every call-derived channel', async () => {
    const { CUSTOMER_ORIGINATED_LEAD_CHANNELS } = require('../services/collections/consent-provenance');
    installDb({ leads: [{ id: 'lead-1' }] });
    await hasPriorContact({ customerId: null, phone: PHONE, before: T0 });
    const leadsQuery = state.queries.find((q) => q.table === 'leads');
    const allowlistClause = leadsQuery.wheres.find((w) => w[0] === 'IN' && w[1] === 'first_contact_channel');
    // Every channel used is one consent-provenance already vouches for as
    // customer-originated (never a second, drift-prone list)...
    expect(allowlistClause[2].every((c) => CUSTOMER_ORIGINATED_LEAD_CHANNELS.includes(c))).toBe(true);
    // ...but 'call' is deliberately excluded (codex pre-push r5 P1: see the
    // dedicated test below) even though consent-provenance's own list
    // includes it for its own, different purpose.
    expect(CUSTOMER_ORIGINATED_LEAD_CHANNELS).toContain('call');
    expect(allowlistClause[2]).not.toContain('call');
  });

  // Codex pre-push r5 P1: the call pipeline (call-recording-processor.js,
  // lead-attribution.js) writes first_contact_channel 'call' for EVERY
  // phone-call-minted lead regardless of the call's DIRECTION — a lead
  // minted from a COLD OUTBOUND call we placed gets the exact same 'call'
  // value as a genuine inbound one, so it must never count as customer-
  // originated evidence through the lead probe. Phone calls count as prior
  // contact ONLY through the direction-aware call probe above.
  test("a 'call'-channel lead minted from a COLD OUTBOUND call does NOT count as prior contact", async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'call' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
  });

  test('an actual prior INBOUND call still counts as prior contact (the direction-aware call probe, not the lead probe)', async () => {
    installDb({ call_log: [{ id: 'in-1', v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  test('a web-form lead still counts (customer-originated, never call-derived)', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(1), first_contact_channel: 'web', status: 'new' }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  // "an actual prior inbound call still counts regardless" — this is the
  // call probe, an independent code path from the lead probe above; a year-
  // old prior inbound call already proves it counts unconditionally.
  test('an actual prior inbound call still counts as prior contact regardless of the lead-channel scoping', async () => {
    installDb({ call_log: [{ id: 'in-old', created_at: new Date('2025-01-01'), v2_extraction_status: 'valid', ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
  });

  // codex #5018 pre-push P1: this used to catch a probe failure internally
  // and fail closed (return false, read by every caller as "no prior
  // contact"). Under the supported DB_POOL_MAX=2, a caller already holding
  // the pool's other slot (a cron lock, a phone-locked handoff transaction)
  // starved these probes into a connection-acquire timeout, which then read
  // as a genuine negative and PERMANENTLY skipped an eligible send — an
  // infra hiccup is not a "no" answer. It must now propagate, so each
  // caller's own retry/defer path (every current caller has one) decides.
  test('a probe failure now PROPAGATES (never silently fails closed to false)', async () => {
    db.mockImplementation(() => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0 })).rejects.toThrow('down');
  });

  // codex #5018 pre-push P1: every probe must run on a caller-supplied
  // connection (a transaction, or the same pool slot a handoff already
  // occupies) instead of always reaching for the shared pool — required so
  // a caller holding the pool's other slot under DB_POOL_MAX=2 doesn't
  // starve these probes into a timeout. The default `db` mock must never be
  // touched when a `conn` is supplied.
  test('every probe runs on a supplied conn, never the shared db pool', async () => {
    const heldConnection = jest.fn((table) => {
      const rowsFor = {
        call_log: [],
        sms_log: [],
        leads: [],
      };
      const chain = {};
      ['where', 'whereNull', 'whereNot', 'whereIn', 'whereRaw', 'orderBy', 'limit', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.first = jest.fn(async () => (rowsFor[table] || [])[0]);
      chain.select = jest.fn(async () => rowsFor[table] || []);
      return chain;
    });
    await expect(hasPriorContact({ customerId: null, phone: PHONE, before: T0, conn: heldConnection })).resolves.toBe(false);
    expect(heldConnection).toHaveBeenCalledWith('call_log');
    expect(heldConnection).toHaveBeenCalledWith('sms_log');
    expect(heldConnection).toHaveBeenCalledWith('leads');
    expect(db).not.toHaveBeenCalled();
  });
});
