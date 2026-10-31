#!/usr/bin/env node
// READ-ONLY — which customer each live Google review belongs to, by the evidence rules of
// server/services/review-link-evidence.js (owner 2026-10-31: a customer who had already reviewed got a
// review ask; check when each person became a lead or a customer). Every query is a SELECT inside a
// read-only transaction on a read-only session (the pinned-root TLS + SCRAM-SHA-256-PLUS connection of
// ops/agents/second-tech-handover.js). Nothing links, marks or texts anyone: the report says what the
// evidence matcher WOULD do, so it can run in shadow before any sync path uses it.
//
//   PG_CA_FILE=~/ops-oneshots/certs/railway-pg-root.pem railway run --service Postgres -- \
//     node ops/agents/review-link-audit.js [--all] [--json]
//
// Sections:
//   1. Linked reviews the evidence disputes: the review is older than the linked customer's first
//      contact (a portal-era clash), or the evidence points at another customer.
//   2. Unlinked reviews with a result: link, link_confirm, pause or household (--all adds queue and
//      reject).
//   3. Customers a review belongs to (a linked review the evidence does not dispute, or a section 2
//      row) who got a review ask after the review posted, or who are not marked "Left Google review".
// Customers and reviewers print as initials and a short id. Review text and message bodies never
// print. --json prints the same rows as JSON.

const path = require('path');
const { readOnlyConn } = require('./second-tech-handover');
const {
  nameParts, scoreCandidate, decideReviewLink, SAID_REVIEWED_RE,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'review-link-evidence'));

const CONTACT_COLUMNS = ['secondary_contact_name', 'service_contact_name', 'service_contact2_name', 'service_contact3_name'];
const OWNED_RESULTS = new Set(['link', 'link_confirm', 'pause', 'household']);

const shortId = (id) => (id ? String(id).slice(0, 8) : '-');
const initials = (value) => {
  const { first, last } = nameParts(value);
  return `${(first[0] || '?').toUpperCase()}.${last ? `${last[0].toUpperCase()}.` : ''}`;
};
const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '-');

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row[key]) || [];
    list.push(row);
    out.set(row[key], list);
  }
  return out;
}

async function loadData(trx) {
  const customers = (await trx.raw(`
    SELECT cu.id, cu.first_name, cu.last_name, ${CONTACT_COLUMNS.map((c) => `cu.${c}`).join(', ')},
           cu.has_left_google_review, cu.created_at, cu.member_since, cu.customer_since, cu.lead_source,
           (SELECT min(coalesce(l.first_contact_at, l.created_at)) FROM leads l WHERE l.customer_id = cu.id) AS first_lead_at,
           (SELECT min(s.created_at) FROM sms_log s WHERE s.customer_id = cu.id) AS first_sms_at,
           (SELECT min(k.created_at) FROM call_log k WHERE k.customer_id = cu.id) AS first_call_at,
           (SELECT min(v.scheduled_date)::text FROM scheduled_services v WHERE v.customer_id = cu.id) AS first_visit_on,
           (SELECT min(e.created_at) FROM estimates e WHERE e.customer_id = cu.id) AS first_estimate_at
      FROM customers cu
     WHERE cu.deleted_at IS NULL`)).rows;
  const visits = (await trx.raw(`
    SELECT customer_id, scheduled_date::text AS on_day FROM scheduled_services
     WHERE status = 'completed' AND customer_id IS NOT NULL`)).rows;
  const asks = (await trx.raw(`
    SELECT customer_id, coalesce(sms_sent_at, sent_at) AS at FROM review_requests
     WHERE customer_id IS NOT NULL AND coalesce(sms_sent_at, sent_at) IS NOT NULL`)).rows;
  // Server-observed taps only (review-click-correlation.js: the legacy promoter stamps redirected_at
  // before the browser navigates). Each timestamp keeps the profile it was stamped for.
  const taps = (await trx.raw(`
    SELECT customer_id, redirected_at, google_location, last_redirected_at, last_google_location FROM review_requests
     WHERE customer_id IS NOT NULL AND google_review_clicked = true AND redirected_at IS NOT NULL`)).rows;
  const texts = (await trx.raw(`
    SELECT customer_id, created_at AS at, message_body AS body FROM sms_log
     WHERE direction = 'inbound' AND customer_id IS NOT NULL AND message_body ILIKE '%review%'`)).rows;
  const reviews = (await trx.raw(`
    SELECT id, location_id, reviewer_name, star_rating, review_created_at, customer_id, link_source
      FROM google_reviews
     WHERE reviewer_name <> '_stats' AND missing_since IS NULL
     ORDER BY review_created_at`)).rows;
  return { customers, visits, asks, taps, texts, reviews };
}

function buildCandidates({ customers, visits, asks, taps, texts }) {
  const visitsBy = groupBy(visits, 'customer_id');
  const asksBy = groupBy(asks, 'customer_id');
  const tapsBy = groupBy(taps, 'customer_id');
  const textsBy = groupBy(texts, 'customer_id');
  return customers.map((cu) => ({
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
      visitsOn: (visitsBy.get(cu.id) || []).map((v) => v.on_day),
      asksAt: (asksBy.get(cu.id) || []).map((a) => a.at),
      taps: (tapsBy.get(cu.id) || []).flatMap((t) => [
        { at: t.redirected_at, locationId: t.google_location },
        { at: t.last_redirected_at, locationId: t.last_google_location },
      ]).filter((t) => t.at),
      // Only texts the matcher would count, so no other body is held.
      inboundTexts: (textsBy.get(cu.id) || []).filter((m) => SAID_REVIEWED_RE.test(m.body || '')).map((m) => ({ at: m.at, body: m.body })),
    },
    linkedProfiles: [],
  }));
}

// One review against every customer. linkedProfiles = the customer's OTHER live linked reviews.
function auditReview(review, candidates, linkedBy, surnameHolderCount) {
  const subject = { reviewerName: review.reviewer_name, reviewedAt: review.review_created_at, locationId: review.location_id };
  const scored = candidates.map((c) => {
    const others = (linkedBy.get(c.customerId) || []).filter((r) => r.id !== review.id);
    return scoreCandidate(subject, { ...c, linkedProfiles: others.map((r) => r.location_id) });
  });
  return decideReviewLink(scored, { surnameHolderCount });
}

function classifyLinked(review, decision) {
  if ((decision.rejected || []).some((c) => c.customerId === review.customer_id)) return 'linked_date_clash';
  if (decision.top && decision.top.customerId !== review.customer_id && OWNED_RESULTS.has(decision.result)) return 'linked_elsewhere';
  return 'linked_ok';
}

function asksAfter(candidate, reviewAt) {
  const at = new Date(reviewAt).getTime();
  return (candidate?.activity.asksAt || []).filter((a) => new Date(a).getTime() > at).length;
}

function rowFor(review, decision, byId) {
  const linked = review.customer_id ? byId.get(review.customer_id) : null;
  let section = `unlinked_${decision.result}`;
  if (review.customer_id) section = linked ? classifyLinked(review, decision) : 'linked_archived';
  const ownerId = section === 'linked_ok' ? review.customer_id
    : (!review.customer_id && OWNED_RESULTS.has(decision.result) ? decision.top.customerId : null);
  const owner = ownerId ? byId.get(ownerId) : null;
  const pick = (c) => c && {
    customerId: c.customerId, nameKind: c.nameKind, role: c.role, dates: c.dates, activity: c.activity, score: c.score,
  };
  return {
    section,
    reviewId: review.id,
    reviewDay: day(review.review_created_at),
    locationId: review.location_id,
    stars: review.star_rating,
    reviewer: initials(review.reviewer_name),
    linkedCustomerId: review.customer_id || null,
    linkedCustomer: linked ? initials(`${linked.holder.first || ''} ${linked.holder.last || ''}`) : null,
    linkSource: review.customer_id ? (review.link_source || 'name') : null,
    result: decision.result,
    reason: decision.reason,
    top: pick(decision.top),
    topCustomer: decision.top ? initials(`${byId.get(decision.top.customerId).holder.first || ''} ${byId.get(decision.top.customerId).holder.last || ''}`) : null,
    runnerUp: pick(decision.runnerUp),
    rejectedIds: (decision.rejected || []).map((c) => c.customerId),
    ownerId,
    ownerMarked: owner ? owner.marked : null,
    ownerAsksAfter: owner ? asksAfter(owner, review.review_created_at) : null,
  };
}

function evidenceText(c) {
  if (!c) return '-';
  const acts = ['tap', 'recent', 'saidReviewed'].filter((k) => c.activity[k]).join('+') || 'no activity';
  return `${shortId(c.customerId)} ${c.nameKind || 'no name'}${c.role === 'contact' ? ' (contact)' : ''} dates=${c.dates} ${acts} score=${c.score}`;
}

function printReport(rows, { all }) {
  const count = (pred) => rows.filter(pred).length;
  const linked = rows.filter((r) => r.linkedCustomerId);
  console.log(`Live reviews: ${rows.length}. Linked: ${linked.length}. Unlinked: ${rows.length - linked.length}.`);
  console.log(`Linked: ${count((r) => r.section === 'linked_ok')} fit, ${count((r) => r.section === 'linked_date_clash')} older than the customer's first contact, ${count((r) => r.section === 'linked_elsewhere')} point at another customer, ${count((r) => r.section === 'linked_archived')} on an archived customer.`);
  const unlinked = rows.filter((r) => !r.linkedCustomerId);
  const byResult = {};
  for (const r of unlinked) byResult[r.result] = (byResult[r.result] || 0) + 1;
  console.log(`Unlinked by result: ${Object.entries(byResult).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);

  console.log('\n1. Linked reviews the evidence disputes');
  for (const r of rows.filter((x) => x.section === 'linked_date_clash' || x.section === 'linked_elsewhere')) {
    console.log(`  ${r.section} | ${r.reviewDay} ${r.locationId} ${r.stars}* ${r.reviewer} ${shortId(r.reviewId)} | linked ${r.linkedCustomer} ${shortId(r.linkedCustomerId)} by ${r.linkSource} | evidence: ${r.result} ${r.topCustomer || ''} ${evidenceText(r.top)}`);
  }

  console.log(`\n2. Unlinked reviews with a result${all ? ' (queue and reject included)' : ''}`);
  const shown = (r) => !r.linkedCustomerId && (OWNED_RESULTS.has(r.result) || (all && ['queue', 'reject'].includes(r.result)));
  for (const r of rows.filter(shown)) {
    const runner = r.runnerUp ? ` | runner-up ${evidenceText(r.runnerUp)}` : '';
    const who = r.top ? `${r.topCustomer} ${evidenceText(r.top)}` : `older than the first contact of ${r.rejectedIds.map(shortId).join(', ')}`;
    console.log(`  ${r.result} (${r.reason}) | ${r.reviewDay} ${r.locationId} ${r.stars}* ${r.reviewer} ${shortId(r.reviewId)} | ${who}${runner}`);
  }

  console.log('\n3. Customers a review belongs to who were asked after it, or are not marked');
  for (const r of rows.filter((x) => x.ownerId && (x.ownerAsksAfter > 0 || !x.ownerMarked))) {
    console.log(`  ${shortId(r.ownerId)} | review ${r.reviewDay} ${r.locationId} (${r.linkedCustomerId ? 'linked' : r.result}) | asks after it: ${r.ownerAsksAfter} | marked: ${r.ownerMarked ? 'yes' : 'no'}`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres -- node ops/agents/review-link-audit.js');
    process.exit(2);
  }
  let db;
  try {
    db = readOnlyConn(conn);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  try {
    const data = await db.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      return loadData(trx);
    });
    const candidates = buildCandidates(data);
    const byId = new Map(candidates.map((c) => [c.customerId, c]));
    const holderSurnames = new Map();
    for (const c of candidates) {
      const { last } = nameParts(`${c.holder.first || ''} ${c.holder.last || ''}`);
      if (last) holderSurnames.set(last, (holderSurnames.get(last) || 0) + 1);
    }
    const linkedBy = groupBy(data.reviews.filter((r) => r.customer_id), 'customer_id');
    const rows = data.reviews.map((review) => rowFor(
      review,
      auditReview(review, candidates, linkedBy, (surname) => holderSurnames.get(surname) || 0),
      byId,
    ));
    if (args.has('--json')) console.log(JSON.stringify(rows, null, 2));
    else printReport(rows, { all: args.has('--all') });
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
