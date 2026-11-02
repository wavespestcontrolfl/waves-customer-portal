/**
 * Lead staleness sweep (services/lead-staleness.js).
 *
 * Daily cron that flips `new` leads to `unresponsive` after
 * LEAD_STALENESS_DAYS (default 21) with no contact. The eligibility rules
 * live in one set-based UPDATE, so the WHERE semantics are pinned by
 * compiling the real builder with knex (no DB needed):
 *   - status = 'new' and created_at <= now - N days
 *   - no lead_activities row inside the window (recent activity skips)
 *   - next_follow_up_at NULL or past (future callback skips)
 *   - NOT EXISTS a non-terminal scheduled_services row for the linked
 *     customer created on/after the lead (booked-from-this-courtship
 *     customer skips — pending won-conversion, not unresponsive; a
 *     cancelled/rescheduled/skipped/no_show visit or the customer's
 *     historical pre-lead services do NOT exempt)
 *   - NOT EXISTS an open Portal ask of the linked customer: an open portal
 *     chat hand-off or customer service request (portal-inbox.js scopes), or
 *     an inbound non-STOP text from the last 90 days with no person contact
 *     after it (a person's text, a call a person placed or a human answered,
 *     a person's Gmail send). Unlinked leads (customer_id NULL) pass. The
 *     behavior matrix runs on live Postgres in lead-staleness-owed-reply-postgres.test.js.
 *   - deleted_at IS NULL, gated on the column existing (the leads
 *     soft-delete lane ships separately; either merge order must work)
 * Effects (activity rows, summary counts, env off switch) are covered with
 * the chain-mock style used by the other sweep tests.
 *
 * GATE_LEAD_NO_RESPONSE_REASON (dark): off = every assertion above is
 * unchanged; on = lost_reason 'no_response' on each flip, plus a second
 * UPDATE for estimate_sent / estimate_viewed leads whose estimate expired as
 * a loss (same exemptions, no converted_at, no newer live estimate, quiet for
 * the window). It never sets status 'lost'.
 */
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
// The bridge's own SQL is unit-tested in lead-funnel-bridge.test.js — here we
// only assert the sweep hands it the flipped ids on the same transaction.
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadsFunnelStage: jest.fn(async () => ({ updated: 1 })),
}));

const logger = require('../services/logger');
const { bridgeLeadsFunnelStage } = require('../services/lead-funnel-bridge');
const {
  runLeadStalenessSweep,
  getThresholdDays,
  buildStaleLeadUpdate,
  buildExpiredEstimateLeadUpdate,
} = require('../services/lead-staleness');
const { DISPOSITIONS } = require('../services/estimate-disposition');

const NOW = new Date('2026-07-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
// The owed-reply exemption's bindings, in clause order: the Portal chat and
// request scopes, the inbound-text window (90 days before the clock), then the
// person-contact witnesses (the sandbox call sources are excluded by the shared
// helper), and the window again for the Gmail sends.
const SINCE_90D = new Date(NOW.getTime() - 90 * DAY_MS);
const OWED_REPLY_BINDINGS = [
  'portal_chat', 'pending', 'resolved', 'closed', 'cancelled',
  'admin', 'portal-unfinished-'.length, 'portal-unfinished-',
  'inbound', SINCE_90D,
  'outbound',
  'voice_relay_sandbox', 'tech_voice', 'outbound', 'completed',
  'voice_relay_sandbox', 'tech_voice', 'inbound', 'completed', 'human',
  SINCE_90D,
];

function makeUpdateChain(result) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.whereIn = jest.fn(() => chain);
  chain.whereNull = jest.fn(() => chain);
  chain.modify = jest.fn((cb) => { cb(chain); return chain; });
  chain.whereNotExists = jest.fn(() => chain);
  chain.whereExists = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.whereRaw = jest.fn(() => chain);
  chain.update = jest.fn(() => chain);
  chain.returning = jest.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

// The sweep builds the `new` UPDATE first, then (gate on only) the
// expired-estimate UPDATE: the first trx('leads') call gets `flipped`, the
// second gets `estimateFlipped`.
function installDb({ flipped = [], estimateFlipped = [], hasDeletedAt = false } = {}) {
  const leadsChain = makeUpdateChain(flipped);
  const estimateChain = makeUpdateChain(estimateFlipped);
  const activityInsert = jest.fn(async () => {});
  let leadsCalls = 0;
  const trx = jest.fn((table) => {
    if (table === 'leads') return (leadsCalls++ === 0 ? leadsChain : estimateChain);
    if (table === 'estimates as le') return makeUpdateChain([]);
    if (table === 'lead_activities') return { insert: activityInsert };
    throw new Error(`unexpected table ${table}`);
  });
  trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  mockDb.transaction = jest.fn(async (cb) => cb(trx));
  mockDb.schema = { hasColumn: jest.fn(async () => hasDeletedAt) };
  return { leadsChain, estimateChain, activityInsert, trx };
}

// The owed-reply clause, from `ai_escalations` on. The pieces that other
// modules own (the Portal scopes' NOT-done text, the staff-contact predicates,
// the call-end expression, the reservation filter) come from those modules, so
// this pin follows them and fails only when the sweep's own wiring changes.
const { operatorReplySql, smsDeliveredSql, personCallBackSql } = require('../services/staff-contact');
const { callEndedAtSql } = require('../services/sms-pending-conversations');
const { personSentFilter } = require('../services/email/email-customer-link');
const { excludeUnresolvedSendReservations } = require('../services/messaging/review-ask-reservation');
const squash = (text) => text.replace(/\s+/g, ' ').trim();
const RESERVATION_FILTER = (() => {
  const knex = require('knex')({ client: 'pg' });
  const { sql } = excludeUnresolvedSendReservations(knex('sms_log as os'), 'os').toSQL();
  knex.destroy();
  return squash(sql.slice(sql.indexOf('where ') + 'where '.length));
})();
const CHAT_NOT_DONE = squash(`NOT (
  EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.recipient_type = 'admin' AND n.metadata->>'escalationId' = e.id::text
  ) AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.recipient_type = 'admin' AND n.metadata->>'escalationId' = e.id::text AND n.done_at IS NULL
  )
)`);
const AFTER_INBOUND_CALL = () => `cl.created_at > inb.created_at - interval '1 day' and ${squash(callEndedAtSql('cl'))} > inb.created_at`;
const OWED_REPLY_CLAUSE_TAIL = [
  // 1. an open Portal chat hand-off (portal-inbox.js openChatScope)
  'inner join "agent_sessions" as "s" on "s"."id" = "e"."conversation_id" '
  + `where "s"."channel" = ? and "e"."status" = ? and ${CHAT_NOT_DONE} and e.customer_id = leads.customer_id) `,
  // 2. an open customer service request (portal-inbox.js openRequestScope)
  'and not exists (select 1 from "service_requests" as "r" '
  + "where coalesce(r.status, 'new') not in (?, ?, ?) and coalesce(r.source, '') <> 'admin' and r.customer_id = leads.customer_id) ",
  // 3. an open "Booking not finished" bell (portal-inbox.js openBookingScope)
  'and not exists (select 1 from "notifications" as "n" '
  + 'where "n"."recipient_type" = ? and "n"."done_at" is null '
  + "and left(COALESCE(n.metadata->>'dedupeKey', ''), ?) = ? and n.metadata->>'customerId' = leads.customer_id::text) ",
  // 4. an inbound text, not a STOP, in the window...
  'and not exists (select 1 from "sms_log" as "inb" '
  + 'where inb.customer_id = leads.customer_id and "inb"."direction" = ? and "inb"."created_at" >= ? '
  + "and inb.message_type IS DISTINCT FROM 'opt_out' "
  + 'and not exists (select 1 from "inbound_sms_optout_receipts" as "oo" where oo.message_sid = inb.twilio_sid) ',
  // ...with no person contact after it
  'and not (exists (select 1 from "sms_log" as "os" '
  + `where ${RESERVATION_FILTER} and "os"."direction" = ? and os.customer_id = leads.customer_id `
  + `and ${squash(operatorReplySql('os'))} and ${squash(smsDeliveredSql('os'))} `
  + 'and not exists (select 1 from "message_drafts" as "mdx" where "mdx"."sms_log_id" is null '
  + "and (mdx.customer_id = os.customer_id OR (mdx.customer_id IS NULL AND os.customer_id IS NULL AND RIGHT(regexp_replace(COALESCE(mdx.flags->>'phone', mdx.flags->>'toPhone', ''), '[^0-9]', '', 'g'), 10) = RIGHT(regexp_replace(COALESCE(os.to_phone, ''), '[^0-9]', '', 'g'), 10))) "
  + "and mdx.sent_at BETWEEN os.created_at - interval '2 minutes' AND os.created_at + interval '2 minutes') "
  + 'and os.created_at > inb.created_at) ',
  // a call a person placed that reached the customer
  'or exists (select 1 from "call_log" as "cl" '
  + `where COALESCE("cl"."source", '') <> ? and COALESCE("cl"."source", '') <> ? and "cl"."direction" = ? and "cl"."status" = ? and cl.customer_id = leads.customer_id `
  + `and ${squash(personCallBackSql('cl'))} and ${AFTER_INBOUND_CALL()}) `,
  // a call in that a human answered
  'or exists (select 1 from "call_log" as "cl" '
  + `where COALESCE("cl"."source", '') <> ? and COALESCE("cl"."source", '') <> ? and "cl"."direction" = ? and "cl"."status" = ? and "cl"."answered_by" = ? and cl.customer_id = leads.customer_id `
  + `and ${AFTER_INBOUND_CALL()}) `,
  // a person's Gmail send naming the customer's address
  'or exists (select 1 from "emails" as "er" '
  + `where ${squash(personSentFilter('er'))} and "er"."received_at" >= ? and er.received_at > inb.created_at `
  + "and strpos(LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address)), (SELECT LOWER(NULLIF(BTRIM(cu.email), '')) FROM customers cu WHERE cu.id = leads.customer_id)) > 0 "
  // ...and the customer's address is one of the send's mailboxes (equality, not substring)
  + "and (SELECT LOWER(NULLIF(BTRIM(cu.email), '')) FROM customers cu WHERE cu.id = leads.customer_id) IN "
  + "(SELECT btrim(m[1]) FROM regexp_matches(LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address)), '<\\s*([^<>\\s]+@[^<>\\s]+)\\s*>', 'g') AS m "
  + "UNION SELECT btrim(m[1]) FROM regexp_matches(regexp_replace(regexp_replace(regexp_replace(LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address)), '\"([^\"\\\\]|\\\\.)*\"', ' ', 'g'), '\\([^)]*\\)', ' ', 'g'), '<[^>]*>', ' ', 'g'), '([^\\s,;:<>\"()]+@[^\\s,;:<>\"()]+)', 'g') AS m))))",
].join('');

describe('lead staleness sweep', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    delete process.env.LEAD_STALENESS_DAYS;
    delete process.env.GATE_LEAD_NO_RESPONSE_REASON;
    mockDb.mockReset();
    logger.info.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.LEAD_STALENESS_DAYS;
    delete process.env.GATE_LEAD_NO_RESPONSE_REASON;
    jest.clearAllMocks();
  });

  describe('threshold env parsing', () => {
    test('defaults to 21 when unset', () => {
      expect(getThresholdDays()).toBe(21);
    });

    test('reads a custom threshold', () => {
      process.env.LEAD_STALENESS_DAYS = '30';
      expect(getThresholdDays()).toBe(30);
    });

    test('falsy / zero / non-numeric values are the off switch', () => {
      for (const off of ['', '0', '-5', 'off', 'false']) {
        process.env.LEAD_STALENESS_DAYS = off;
        expect(getThresholdDays()).toBe(0);
      }
    });

    test('partially numeric values are the off switch too (parseInt prefix trap)', () => {
      // '21days' must NOT silently enable a 21-day sweep — an operator who
      // typed a malformed value expecting the documented fail-closed off
      // switch would otherwise have old leads auto-closed.
      for (const off of ['21days', '30 disabled', '7d']) {
        process.env.LEAD_STALENESS_DAYS = off;
        expect(getThresholdDays()).toBe(0);
      }
      // Surrounding whitespace alone is still a valid integer.
      process.env.LEAD_STALENESS_DAYS = ' 14 ';
      expect(getThresholdDays()).toBe(14);
    });
  });

  describe('WHERE semantics (compiled SQL)', () => {
    test('one UPDATE carries every eligibility rule', () => {
      // Real knex compilation — pins that a recent-activity lead, a
      // future-callback lead, and a booked-customer lead are all excluded
      // by the query itself, and that unlinked leads (customer_id NULL)
      // pass the scheduled_services NOT EXISTS.
      const knex = require('knex')({ client: 'pg' });
      const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
      const { sql, bindings } = buildStaleLeadUpdate(knex, { now: NOW, cutoff }).toSQL();

      // The recursive-chain clause is a multi-line raw fragment; compare
      // whitespace-normalized so the pin is on the SQL, not the indentation.
      expect(sql.replace(/\s+/g, ' ')).toBe(
        'update "leads" set "status" = ?, "updated_at" = ? '
        + 'where "leads"."status" = ? and "leads"."created_at" <= ? '
        + 'and ("leads"."next_follow_up_at" is null or "leads"."next_follow_up_at" <= ?) '
        + 'and not exists (select 1 from "lead_activities" '
        + 'where lead_activities.lead_id = leads.id '
        + "and lead_activities.activity_type IS DISTINCT FROM 'shared_phone_note' "
        + 'and "lead_activities"."created_at" >= ?) '
        // A quote-wizard repeat filed as a duplicate of this lead — or of any
        // row in its duplicate chain — inside the window is the customer
        // re-engaging (codex #3834 r10 P1, chain-aware per pre-push r12).
        + 'and leads.id::text NOT IN ( WITH RECURSIVE chain AS ( '
        + "SELECT r.extracted_data->>'duplicate_of_lead_id' AS parent_id, 1 AS depth FROM leads r "
        // ...recent by its LAST wizard submission (the wizard's own
        // extracted_data.wizard_submitted_at stamp, never updated_at — an
        // admin edit is not the customer re-engaging; codex r23 P1, #3861 r1 P2).
        + "WHERE r.lead_type = 'quote_wizard' AND r.status = 'duplicate' AND COALESCE((r.extracted_data->>'wizard_submitted_at')::timestamptz, r.created_at) >= ? "
        + "UNION ALL SELECT p.extracted_data->>'duplicate_of_lead_id', chain.depth + 1 "
        + 'FROM chain JOIN leads p ON p.id::text = chain.parent_id '
        + "WHERE p.lead_type = 'quote_wizard' AND p.status = 'duplicate' AND chain.depth < 8 ) "
        + 'SELECT parent_id FROM chain WHERE parent_id IS NOT NULL ) '
        + 'and not exists (select 1 from "scheduled_services" '
        + 'where scheduled_services.customer_id = leads.customer_id '
        + 'and "scheduled_services"."status" not in (?, ?, ?, ?) '
        + "and scheduled_services.created_at >= COALESCE(leads.first_contact_at, leads.created_at) - interval '1 day') "
        // A lead whose own funnel row is booked/completed — a wizard repeat's
        // win settled onto its still-open root — is pending merge, not
        // unresponsive; the lost bridge would demote that row (codex #3834 r37 P1).
        + 'and not exists (select 1 from "ad_service_attribution" '
        + 'where ad_service_attribution.lead_id = leads.id '
        + 'and "ad_service_attribution"."funnel_stage" in (?, ?)) '
        // The customer's own unanswered ask (the clause is pinned in full below).
        + 'and not exists (select 1 from "ai_escalations" as "e" '
        + OWED_REPLY_CLAUSE_TAIL
        + ' returning "id"'
      );
      expect(bindings).toEqual(['unresponsive', NOW, 'new', cutoff, NOW, cutoff, cutoff, 'cancelled', 'rescheduled', 'skipped', 'no_show', 'booked', 'completed', ...OWED_REPLY_BINDINGS]);

      return knex.destroy();
    });

    describe('owed-reply exemption: a customer ask still waiting on us', () => {
      const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
      const flips = {
        'new-lead flip': (knex) => buildStaleLeadUpdate(knex, { now: NOW, cutoff }).toSQL(),
        'expired-estimate flip': (knex) => buildExpiredEstimateLeadUpdate(knex, { now: NOW, cutoff }).toSQL(),
      };

      test.each(Object.keys(flips))('%s carries the whole clause', (name) => {
        const knex = require('knex')({ client: 'pg' });
        const { sql, bindings } = flips[name](knex);
        const text = squash(sql);
        expect(text).toContain(`and not exists (select 1 from "ai_escalations" as "e" ${OWED_REPLY_CLAUSE_TAIL}`);
        for (const b of OWED_REPLY_BINDINGS) expect(bindings).toContainEqual(b);
        return knex.destroy();
      });

      test('every arm is correlated on the lead\'s own customer_id, so an unlinked lead matches none', () => {
        const knex = require('knex')({ client: 'pg' });
        const text = squash(flips['new-lead flip'](knex).sql);
        const clause = text.slice(text.indexOf('from "ai_escalations"'));
        // chat, request, inbound text, then the person's text and the two calls; the
        // email arm correlates through the customers lookup checked below
        expect(clause.match(/customer_id = leads\.customer_id/g)).toHaveLength(6);
        expect(clause).toContain('strpos(');
        expect(clause).toContain('WHERE cu.id = leads.customer_id');
        return knex.destroy();
      });

      test('a STOP is not an ask: the message type and an opt-out receipt both exclude it', () => {
        const knex = require('knex')({ client: 'pg' });
        const text = squash(flips['new-lead flip'](knex).sql);
        expect(text).toContain("inb.message_type IS DISTINCT FROM 'opt_out'");
        expect(text).toContain('from "inbound_sms_optout_receipts" as "oo" where oo.message_sid = inb.twilio_sid');
        return knex.destroy();
      });

      test('the text window is 90 days before the clock; a closed bell and a staff-made request do not count', () => {
        const knex = require('knex')({ client: 'pg' });
        const { sql, bindings } = flips['new-lead flip'](knex);
        expect(bindings).toContainEqual(SINCE_90D);
        const text = squash(sql);
        expect(text).toContain(`${CHAT_NOT_DONE} and e.customer_id = leads.customer_id`);
        expect(text).toContain("coalesce(r.source, '') <> 'admin'");
        expect(bindings).toEqual(expect.arrayContaining(['resolved', 'closed', 'cancelled']));
        return knex.destroy();
      });

      test('the exemption has no gate: it compiles the same with GATE_LEAD_NO_RESPONSE_REASON on or off', () => {
        const knex = require('knex')({ client: 'pg' });
        const off = squash(buildStaleLeadUpdate(knex, { now: NOW, cutoff }).toSQL().sql);
        const on = squash(buildStaleLeadUpdate(knex, { now: NOW, cutoff, noResponseReason: true }).toSQL().sql);
        const tail = (t) => t.slice(t.indexOf('and not exists (select 1 from "ai_escalations"'));
        expect(tail(on)).toBe(tail(off));
        return knex.destroy();
      });
    });

    test('excludeSoftDeleted adds deleted_at IS NULL', () => {
      const knex = require('knex')({ client: 'pg' });
      const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
      const { sql } = buildStaleLeadUpdate(knex, { now: NOW, cutoff, excludeSoftDeleted: true }).toSQL();

      expect(sql).toContain('"leads"."deleted_at" is null');
      // A removed repeat or hop must not keep its original out of the sweep.
      expect(sql).toContain('r.deleted_at IS NULL');
      expect(sql).toContain('p.deleted_at IS NULL');

      return knex.destroy();
    });
  });

  describe('GATE_LEAD_NO_RESPONSE_REASON (compiled SQL)', () => {
    const knexFor = () => require('knex')({ client: 'pg' });
    const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
    const lostCodes = DISPOSITIONS.filter((d) => d.group === 'lost').map((d) => d.code);
    const norm = (sql) => sql.replace(/\s+/g, ' ');

    test('gate off: the new-lead UPDATE is unchanged (no lost_reason)', () => {
      const knex = knexFor();
      const { sql } = buildStaleLeadUpdate(knex, { now: NOW, cutoff }).toSQL();
      expect(sql).toContain('update "leads" set "status" = ?, "updated_at" = ? where');
      expect(sql).not.toContain('lost_reason');
      return knex.destroy();
    });

    test('gate on: the new-lead UPDATE fills a blank reason only', () => {
      const knex = knexFor();
      const { sql, bindings } = buildStaleLeadUpdate(knex, { now: NOW, cutoff, noResponseReason: true }).toSQL();
      expect(sql).toContain('set "status" = ?, "updated_at" = ?, "lost_reason" = COALESCE(leads.lost_reason, ?) where');
      expect(bindings.slice(0, 3)).toEqual(['unresponsive', NOW, 'no_response']);
      // The WHERE is the same one gate off uses.
      expect(bindings.slice(3)).toEqual(['new', cutoff, NOW, cutoff, cutoff, 'cancelled', 'rescheduled', 'skipped', 'no_show', 'booked', 'completed', ...OWED_REPLY_BINDINGS]);
      return knex.destroy();
    });

    test('expired-estimate UPDATE: status unresponsive (never lost), reason, appended note', () => {
      const knex = knexFor();
      const { sql, bindings } = buildExpiredEstimateLeadUpdate(knex, { now: NOW, cutoff }).toSQL();
      const text = norm(sql);
      expect(text).toContain('update "leads" set "status" = ?, "updated_at" = ?, "lost_reason" = COALESCE(leads.lost_reason, ?), "lost_notes" = ');
      expect(bindings.slice(0, 3)).toEqual(['unresponsive', NOW, 'no_response']);
      expect(bindings).not.toContain('lost');
      // Existing notes are kept: new text is appended after a newline.
      expect(text).toContain("COALESCE(NULLIF(leads.lost_notes, '') || chr(10), '') || COALESCE((select 'estimate ' || le.disposition from");
      expect(text).toContain("'estimate expired'");
      return knex.destroy();
    });

    test('expired-estimate UPDATE: only estimate_sent / estimate_viewed leads', () => {
      const knex = knexFor();
      const { sql, bindings } = buildExpiredEstimateLeadUpdate(knex, { now: NOW, cutoff }).toSQL();
      expect(norm(sql)).toContain('where "leads"."status" in (?, ?) and "leads"."created_at" <= ?');
      expect(bindings).toEqual(expect.arrayContaining(['estimate_sent', 'estimate_viewed']));
      expect(bindings).not.toContain('new');
      return knex.destroy();
    });

    test('expired-estimate UPDATE carries every exemption the new-lead sweep applies', () => {
      const knex = knexFor();
      const estimateSql = norm(buildExpiredEstimateLeadUpdate(knex, { now: NOW, cutoff, excludeSoftDeleted: true }).toSQL().sql);
      const newSql = norm(buildStaleLeadUpdate(knex, { now: NOW, cutoff, excludeSoftDeleted: true }).toSQL().sql);
      // Everything after the status filter in the new-lead WHERE (created_at,
      // soft delete, follow-up, activity, wizard repeats, booked service,
      // booked funnel row) appears verbatim in the estimate WHERE.
      const shared = newSql.slice(newSql.indexOf('and "leads"."created_at" <= ?'), newSql.indexOf(' returning "id"'));
      expect(shared).toContain('"leads"."deleted_at" is null');
      expect(shared).toContain('from "lead_activities"');
      expect(shared).toContain('from "scheduled_services"');
      expect(shared).toContain('from "ad_service_attribution"');
      expect(shared).toContain('from "ai_escalations"');
      expect(shared).toContain('from "service_requests"');
      expect(shared).toContain('from "sms_log" as "inb"');
      expect(estimateSql).toContain(shared);
      return knex.destroy();
    });

    test('expired-estimate UPDATE: converted_at blank, lost-group disposition, expired, link via FK or mirror', () => {
      const knex = knexFor();
      const { sql, bindings } = buildExpiredEstimateLeadUpdate(knex, { now: NOW, cutoff }).toSQL();
      const text = norm(sql);
      expect(text).toContain('"leads"."converted_at" is null');
      expect(text).toContain("(le.id = leads.estimate_id OR (leads.estimate_id IS NULL AND le.estimate_data->>'lead_id' = leads.id::text))");
      expect(text).toContain('"le"."status" = ?');
      // Disposition codes come from the module's own lost group: dead and
      // won_elsewhere codes never appear.
      expect(lostCodes.length).toBeGreaterThan(0);
      expect(bindings).toEqual(expect.arrayContaining(lostCodes));
      for (const d of DISPOSITIONS.filter((x) => x.group !== 'lost')) {
        expect(bindings).not.toContain(d.code);
      }
      expect(bindings).not.toContain('expired_unsent');
      expect(bindings).not.toContain('converted_other_path');
      expect(bindings).not.toContain('invalid_lead');
      return knex.destroy();
    });

    test('expired-estimate UPDATE: estimate quiet for the window, no newer live estimate', () => {
      const knex = knexFor();
      const { sql, bindings } = buildExpiredEstimateLeadUpdate(knex, { now: NOW, cutoff }).toSQL();
      const text = norm(sql);
      // Not sent or opened inside the window.
      expect(text).toContain('COALESCE(GREATEST(le.sent_at, le.viewed_at, le.last_viewed_at), le.created_at) <= ?');
      // Newer live estimate for the same lead or customer exempts.
      expect(text).toContain('not exists (select 1 from "estimates" as "ne" where ne.id <> le.id and ne.created_at > le.created_at');
      expect(text).toContain("ne.id = leads.estimate_id OR ne.estimate_data->>'lead_id' = leads.id::text OR ne.customer_id = leads.customer_id");
      expect(text).toContain("ne.status = 'accepted' OR (ne.status IN ('sent', 'viewed') AND ne.archived_at IS NULL AND (ne.expires_at IS NULL OR ne.expires_at > ?))");
      // The window cutoff and the clock both reach the estimate checks.
      expect(bindings.filter((b) => b === cutoff).length).toBeGreaterThanOrEqual(4);
      expect(bindings.filter((b) => b === NOW).length).toBeGreaterThanOrEqual(3);
      return knex.destroy();
    });

    test('expired-estimate UPDATE: excludeSoftDeleted adds deleted_at IS NULL', () => {
      const knex = knexFor();
      const { sql } = buildExpiredEstimateLeadUpdate(knex, { now: NOW, cutoff, excludeSoftDeleted: true }).toSQL();
      expect(sql).toContain('"leads"."deleted_at" is null');
      return knex.destroy();
    });
  });

  describe('runLeadStalenessSweep', () => {
    test('transitions eligible leads and writes one activity row per flip', async () => {
      const { leadsChain, activityInsert } = installDb({
        flipped: [{ id: 'lead-1' }, { id: 'lead-2' }],
      });

      const result = await runLeadStalenessSweep();

      expect(result).toEqual({ disabled: false, marked: 2 });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(leadsChain.update).toHaveBeenCalledWith({ status: 'unresponsive', updated_at: NOW });
      expect(leadsChain.returning).toHaveBeenCalledWith('id');

      // Default 21-day cutoff lands on the created_at bound.
      const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
      expect(leadsChain.where).toHaveBeenCalledWith('leads.status', 'new');
      expect(leadsChain.where).toHaveBeenCalledWith('leads.created_at', '<=', cutoff);

      expect(activityInsert).toHaveBeenCalledTimes(1);
      expect(activityInsert).toHaveBeenCalledWith([
        {
          lead_id: 'lead-1',
          activity_type: 'status_change',
          description: 'Auto-marked unresponsive after 21 days with no contact',
          performed_by: 'system',
          metadata: JSON.stringify({ auto: true, threshold_days: 21 }),
        },
        {
          lead_id: 'lead-2',
          activity_type: 'status_change',
          description: 'Auto-marked unresponsive after 21 days with no contact',
          performed_by: 'system',
          metadata: JSON.stringify({ auto: true, threshold_days: 21 }),
        },
      ]);

      // One summary line: count + threshold.
      expect(logger.info).toHaveBeenCalledWith('[lead-staleness] thresholdDays=21 marked=2');

      // Funnel rows collapse to the lost bucket for the flipped leads, on the
      // SAME transaction (unresponsive is a closed status).
      expect(bridgeLeadsFunnelStage).toHaveBeenCalledWith(['lead-1', 'lead-2'], 'unresponsive', expect.any(Function));
    });

    test('custom LEAD_STALENESS_DAYS drives the cutoff and the activity copy', async () => {
      process.env.LEAD_STALENESS_DAYS = '30';
      const { leadsChain, activityInsert } = installDb({ flipped: [{ id: 'lead-9' }] });

      const result = await runLeadStalenessSweep();

      expect(result).toEqual({ disabled: false, marked: 1 });
      const cutoff = new Date(NOW.getTime() - 30 * DAY_MS);
      expect(leadsChain.where).toHaveBeenCalledWith('leads.created_at', '<=', cutoff);
      expect(activityInsert).toHaveBeenCalledWith([
        expect.objectContaining({
          lead_id: 'lead-9',
          description: 'Auto-marked unresponsive after 30 days with no contact',
        }),
      ]);
    });

    test('deleted_at column absent (pre-soft-delete-migration): no whereNull', async () => {
      const { leadsChain } = installDb({ flipped: [] });

      await runLeadStalenessSweep();

      expect(mockDb.schema.hasColumn).toHaveBeenCalledWith('leads', 'deleted_at');
      expect(leadsChain.whereNull).not.toHaveBeenCalledWith('leads.deleted_at');
    });

    test('deleted_at column present: soft-deleted leads are excluded', async () => {
      const { leadsChain } = installDb({ flipped: [], hasDeletedAt: true });

      await runLeadStalenessSweep();

      expect(leadsChain.whereNull).toHaveBeenCalledWith('leads.deleted_at');
    });

    test('no eligible leads: no activity insert, no funnel bridge, marked 0', async () => {
      const { activityInsert } = installDb({ flipped: [] });

      const result = await runLeadStalenessSweep();

      expect(result).toEqual({ disabled: false, marked: 0 });
      expect(activityInsert).not.toHaveBeenCalled();
      expect(bridgeLeadsFunnelStage).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('[lead-staleness] thresholdDays=21 marked=0');
    });

    test('disabled via env: never touches the database', async () => {
      installDb({ flipped: [{ id: 'should-not-flip' }] });

      for (const off of ['', '0', 'off']) {
        process.env.LEAD_STALENESS_DAYS = off;
        const result = await runLeadStalenessSweep();
        expect(result).toEqual({ disabled: true, marked: 0 });
      }

      expect(mockDb).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    describe('GATE_LEAD_NO_RESPONSE_REASON on', () => {
      beforeEach(() => { process.env.GATE_LEAD_NO_RESPONSE_REASON = 'true'; });

      test('new-lead flips carry the reason; no second UPDATE when the gate is off', async () => {
        delete process.env.GATE_LEAD_NO_RESPONSE_REASON;
        const { trx } = installDb({ flipped: [{ id: 'lead-1' }] });
        const result = await runLeadStalenessSweep();
        expect(result).toEqual({ disabled: false, marked: 1 });
        // Only the lead UPDATE and the activity insert: no estimate flip.
        expect(trx.mock.calls.map(([t]) => t)).toEqual(['leads', 'lead_activities']);
        expect(trx.raw).not.toHaveBeenCalled();
      });

      test('writes lost_reason no_response on new-lead flips, status stays unresponsive', async () => {
        const { leadsChain, activityInsert } = installDb({ flipped: [{ id: 'lead-1' }] });
        const result = await runLeadStalenessSweep();

        expect(result).toEqual({ disabled: false, marked: 1, expiredEstimates: 0 });
        expect(leadsChain.update).toHaveBeenCalledWith({
          status: 'unresponsive',
          updated_at: NOW,
          lost_reason: { sql: 'COALESCE(leads.lost_reason, ?)', bindings: ['no_response'] },
        });
        expect(activityInsert).toHaveBeenCalledWith([{
          lead_id: 'lead-1',
          activity_type: 'status_change',
          description: 'Auto-marked unresponsive after 21 days with no contact',
          performed_by: 'system',
          metadata: JSON.stringify({ auto: true, threshold_days: 21, lost_reason: 'no_response' }),
        }]);
      });

      test('expired-estimate leads flip too: one activity path, one funnel bridge call', async () => {
        const { estimateChain, activityInsert } = installDb({
          flipped: [{ id: 'lead-1' }],
          estimateFlipped: [{ id: 'lead-7' }, { id: 'lead-8' }],
        });
        const result = await runLeadStalenessSweep();

        expect(result).toEqual({ disabled: false, marked: 3, expiredEstimates: 2 });
        expect(estimateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'unresponsive', updated_at: NOW }));
        expect(estimateChain.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'lost' }));
        expect(estimateChain.whereIn).toHaveBeenCalledWith('leads.status', ['estimate_sent', 'estimate_viewed']);
        expect(estimateChain.whereNull).toHaveBeenCalledWith('leads.converted_at');

        expect(activityInsert).toHaveBeenCalledTimes(1);
        const rows = activityInsert.mock.calls[0][0];
        expect(rows.map((r) => r.lead_id)).toEqual(['lead-1', 'lead-7', 'lead-8']);
        expect(rows.every((r) => r.activity_type === 'status_change' && r.performed_by === 'system')).toBe(true);
        expect(JSON.parse(rows[1].metadata)).toEqual({
          auto: true, threshold_days: 21, lost_reason: 'no_response', source: 'estimate_expired',
        });

        // Same funnel bridge as today's flips, once, on the same transaction.
        expect(bridgeLeadsFunnelStage).toHaveBeenCalledTimes(1);
        expect(bridgeLeadsFunnelStage).toHaveBeenCalledWith(['lead-1', 'lead-7', 'lead-8'], 'unresponsive', expect.any(Function));
        expect(logger.info).toHaveBeenCalledWith('[lead-staleness] thresholdDays=21 marked=3 expiredEstimates=2');
      });

      test('only expired-estimate leads flip: still writes activity and bridges', async () => {
        const { activityInsert } = installDb({ flipped: [], estimateFlipped: [{ id: 'lead-7' }] });
        const result = await runLeadStalenessSweep();
        expect(result).toEqual({ disabled: false, marked: 1, expiredEstimates: 1 });
        expect(activityInsert).toHaveBeenCalledTimes(1);
        expect(bridgeLeadsFunnelStage).toHaveBeenCalledWith(['lead-7'], 'unresponsive', expect.any(Function));
      });

      test('nothing eligible: no activity, no bridge', async () => {
        const { activityInsert } = installDb({ flipped: [], estimateFlipped: [] });
        const result = await runLeadStalenessSweep();
        expect(result).toEqual({ disabled: false, marked: 0, expiredEstimates: 0 });
        expect(activityInsert).not.toHaveBeenCalled();
        expect(bridgeLeadsFunnelStage).not.toHaveBeenCalled();
      });

      test('LEAD_STALENESS_DAYS off switch still wins over the gate', async () => {
        installDb({ flipped: [{ id: 'x' }] });
        process.env.LEAD_STALENESS_DAYS = '0';
        expect(await runLeadStalenessSweep()).toEqual({ disabled: true, marked: 0 });
        expect(mockDb.transaction).not.toHaveBeenCalled();
      });
    });
  });
});
