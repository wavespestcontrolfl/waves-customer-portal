'use strict';

/**
 * Reads the facts review-link-evidence.js scores (owner 2026-10-31): each customer's names, first
 * known contact, completed visits, delivered review asks, review-link taps and "I left a review"
 * texts. One reader for the Reviews match queue (a few customers, review-incentives.js
 * searchAttributionCandidates) and for the read-only audit (every customer,
 * ops/agents/review-link-audit.js), so both show the same facts. SELECTs only; `conn` is a knex
 * instance or transaction.
 */

const { ASK_TOUCH_SQL } = require('./review-outreach-templates');
const { saysReviewed } = require('./review-link-evidence');

const CONTACT_COLUMNS = ['secondary_contact_name', 'service_contact_name', 'service_contact2_name', 'service_contact3_name'];

// ` AND <column> IN (?, ...)` for a customer subset; nothing when every customer is read.
function onlyCustomers(column, customerIds) {
  if (!customerIds) return { sql: '', bindings: [] };
  if (!customerIds.length) return { sql: ' AND false', bindings: [] };
  return { sql: ` AND ${column} IN (${customerIds.map(() => '?').join(', ')})`, bindings: [...customerIds] };
}

// Raw rows for every live customer, or for `customerIds` only.
async function loadEvidenceRows(conn, { customerIds = null } = {}) {
  const cu = onlyCustomers('cu.id', customerIds);
  const customers = (await conn.raw(`
    SELECT cu.id, cu.first_name, cu.last_name, ${CONTACT_COLUMNS.map((c) => `cu.${c}`).join(', ')},
           cu.has_left_google_review, cu.created_at, cu.lead_source,
           -- date columns as 'YYYY-MM-DD': the evidence module reads a date-only value as Eastern midnight
           cu.member_since::text AS member_since, cu.customer_since::text AS customer_since,
           (SELECT min(coalesce(l.first_contact_at, l.created_at)) FROM leads l WHERE l.customer_id = cu.id) AS first_lead_at,
           (SELECT min(s.created_at) FROM sms_log s WHERE s.customer_id = cu.id) AS first_sms_at,
           (SELECT min(k.created_at) FROM call_log k WHERE k.customer_id = cu.id) AS first_call_at,
           (SELECT min(v.scheduled_date)::text FROM scheduled_services v WHERE v.customer_id = cu.id) AS first_visit_on,
           (SELECT min(e.created_at) FROM estimates e WHERE e.customer_id = cu.id) AS first_estimate_at
      FROM customers cu
     WHERE cu.deleted_at IS NULL${cu.sql}`, cu.bindings)).rows;
  const visitIds = onlyCustomers('customer_id', customerIds);
  const visits = (await conn.raw(`
    SELECT customer_id, scheduled_date::text AS on_day FROM scheduled_services
     WHERE status = 'completed' AND customer_id IS NOT NULL${visitIds.sql}`, visitIds.bindings)).rows;
  // Every delivery of a review ask, read the way review-ask-history.js deliveredAskRows reads one
  // customer: ASK_TOUCH_SQL drops the no-link check-in templates; the text, the email and a delivered
  // follow-up each count, the follow-up from its column or from messaging_audit_log for sends before
  // that column existed (followup_sent_at is not delivery: it also stamps a suppressed follow-up).
  // Texts the office typed by hand are not counted.
  const logIds = onlyCustomers('customer_id', customerIds);
  const askIds = onlyCustomers('rr.customer_id', customerIds);
  const asks = (await conn.raw(`
    SELECT rr.customer_id, rr.sms_sent_at, rr.sent_at, rr.followup_delivered_at, f.logged_at AS followup_logged_at
      FROM review_requests rr
      LEFT JOIN (
        SELECT metadata->>'review_request_id' AS review_request_id, MAX(sent_at) AS logged_at
          FROM messaging_audit_log
         WHERE entry_point = 'review_request_followup' AND sent_at IS NOT NULL${logIds.sql}
         GROUP BY metadata->>'review_request_id'
      ) f ON f.review_request_id = rr.id::text
     WHERE rr.customer_id IS NOT NULL${askIds.sql}
       AND ${ASK_TOUCH_SQL}
       AND (rr.sms_sent_at IS NOT NULL OR rr.sent_at IS NOT NULL OR rr.followup_delivered_at IS NOT NULL OR f.logged_at IS NOT NULL)`,
  [...logIds.bindings, ...askIds.bindings])).rows;
  // Server-observed taps only (review-click-correlation.js: the legacy promoter stamps redirected_at
  // before the browser navigates). Each timestamp keeps the profile it was stamped for.
  const tapIds = onlyCustomers('customer_id', customerIds);
  const taps = (await conn.raw(`
    SELECT customer_id, redirected_at, google_location, last_redirected_at, last_google_location FROM review_requests
     WHERE customer_id IS NOT NULL AND google_review_clicked = true AND redirected_at IS NOT NULL${tapIds.sql}`, tapIds.bindings)).rows;
  const textIds = onlyCustomers('customer_id', customerIds);
  const texts = (await conn.raw(`
    SELECT customer_id, created_at AS at, message_body AS body FROM sms_log
     WHERE direction = 'inbound' AND customer_id IS NOT NULL AND message_body ILIKE '%review%'${textIds.sql}`, textIds.bindings)).rows;
  return { customers, visits, asks, taps, texts };
}

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const list = out.get(String(row[key])) || [];
    list.push(row);
    out.set(String(row[key]), list);
  }
  return out;
}

// The rows as review-link-evidence.js candidates (linkedProfiles left empty for the caller).
function buildCandidates({ customers, visits, asks, taps, texts }) {
  const visitsBy = groupBy(visits, 'customer_id');
  const asksBy = groupBy(asks, 'customer_id');
  const tapsBy = groupBy(taps, 'customer_id');
  const textsBy = groupBy(texts, 'customer_id');
  return customers.map((cu) => {
    const id = String(cu.id);
    return {
      customerId: cu.id,
      marked: cu.has_left_google_review === true,
      holder: { first: cu.first_name, last: cu.last_name },
      contacts: CONTACT_COLUMNS.map((c) => cu[c]).filter(Boolean),
      timeline: {
        memberSince: cu.member_since,
        customerSince: cu.customer_since,
        leadFirstContactAt: cu.first_lead_at,
        firstCallAt: cu.first_call_at,
        firstSmsAt: cu.first_sms_at,
        firstVisitOn: cu.first_visit_on,
        firstEstimateAt: cu.first_estimate_at,
        createdAt: cu.created_at,
        leadSource: cu.lead_source,
      },
      activity: {
        visitsOn: (visitsBy.get(id) || []).map((v) => v.on_day),
        // One request can deliver on both sides of a review: a text before it, the email or the
        // follow-up after it. Each delivery counts on its own; the column and the audit log are two
        // records of the same follow-up, so the log is only the fallback.
        asksAt: (asksBy.get(id) || [])
          .flatMap((a) => [a.sms_sent_at, a.sent_at, a.followup_delivered_at || a.followup_logged_at])
          .filter(Boolean),
        taps: (tapsBy.get(id) || []).flatMap((t) => [
          { at: t.redirected_at, locationId: t.google_location },
          { at: t.last_redirected_at, locationId: t.last_google_location },
        ]).filter((t) => t.at),
        // Only texts the matcher would count, so no other body is held.
        inboundTexts: (textsBy.get(id) || []).filter((m) => saysReviewed(m.body)).map((m) => ({ at: m.at, body: m.body })),
      },
      linkedProfiles: [],
    };
  });
}

async function loadEvidenceCandidates(conn, options = {}) {
  return buildCandidates(await loadEvidenceRows(conn, options));
}

module.exports = { loadEvidenceRows, buildCandidates, loadEvidenceCandidates };
