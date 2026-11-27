'use strict';
// Facts staff know and the texting agent may state (owner 2026-11-25, texting AI fix step 2: "feed the facts staff know"; owner ruling
// 2026-09-30: price and fee questions are explained from the estimate and invoice on file): the open estimate's per-application price and
// applications a year, a customer's prepaid visits left, the prep guide of the customer's booked visit and whether the latest visits' service
// reports went out by email (never the address). This module only READS the facts.
// The numbers never reach the AI raw: each becomes one finished sentence in payment-status-contract.js (the same copy-verbatim contract as the
// plan price and the balance, PR #5331), so a figure the AI writes in its own words is held. The guide's own published sentences reach it as the
// PREP GUIDE section (sms-shadow-drafter.js prepGuideSection). Never a technician note or a visit note. A read that fails is null, never a guess.

const logger = require('./logger');

// The service name a proposal line carries is "<name> — <n> applications/yr" (estimate-proposal.js): the cadence rides the sentence's own count.
const cleanLabel = (label) => String(label || '').replace(/\s+[\u2014\u2013-]\s+\d{1,2}\s+applications?\/yr\s*$/i, '').replace(/\s+/g, ' ').trim();

const parsedData = (estimate) => {
  const raw = estimate?.estimate_data;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
};

/**
 * True only when the customer's own estimate page would show this estimate, judged from the ESTIMATE ROW alone: not expired, not held off the
 * customer surface (a quarantine marker, an invalidated linkage, a pending reprice or an unverified address: estimateOffCustomerSurface), and
 * not an estimate whose visibility also depends on OTHER rows (a call-drafted estimate's call and lead, a new-home estimate's move: the public
 * routes' callSideBlockForEstimateData). Those can change with the estimate row untouched, so the send fingerprint (which hashes the estimate
 * row) could not see the change: they render no price here, and staff answer.
 */
function estimateOnCustomerSurface(estimate) {
  if (estimate.expires_at && new Date(estimate.expires_at).getTime() < Date.now()) return false;
  const data = parsedData(estimate);
  if (data?.estimatorEngine?.callLogId || data?.move?.moveId) return false;
  return !require('../utils/estimate-claim-sql').estimateOffCustomerSurface(estimate);
}

const toCents = (value) => {
  const n = Math.round(Number(value) * 100);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * What the open estimate lists per application, as { perApplication: [{ label, cents, applications }] }: the lines and the applications a
 * year of the per-application average model, the SAME model the estimate page and the delivery email read (estimate-monthly-average: it
 * reconciles each line against the stored plan total, so a line that does not add up is withheld). Only a price LISTED on the estimate, never
 * a total: the prepay invoice total, the setup fee and the one-time lines each have their own authority and stay with staff.
 * { perApplication: [] } when there is no estimate, it is not on the customer's own page (or depends on a call or move: see above), the customer
 * has more than one open estimate, or it lists none (a successful read of nothing); null when the read failed. Never throws.
 */
async function loadEstimateFacts(estimate, { db } = {}) {
  const none = { perApplication: [] };
  if (!estimate?.id) return none;
  if (!db) return null;
  try {
    if (!estimateOnCustomerSurface(estimate)) return none;
    // Which estimate does the customer mean? The context names the newest open one; with two or more open (two properties, two quotes for one
    // service) a price could be the wrong quote's, so a person answers.
    const open = await db('estimates').where({ customer_id: estimate.customer_id }).whereIn('status', ['sent', 'viewed']).whereNull('archived_at').limit(2).select('id');
    if (open.length > 1) return none;
    const average = await require('./estimate-monthly-average').perApplicationAverageFor(estimate, { rethrow: true });
    const perApplication = [];
    for (const service of average?.model?.services || []) {
      const cents = toCents(service.perApplication);
      const applications = Math.round(Number(service.visits));
      if (cents && applications > 0 && cleanLabel(service.label)) perApplication.push({ label: cleanLabel(service.label), cents, applications });
    }
    return { perApplication };
  } catch (err) {
    logger.warn(`[sms-staff-facts] per-application price unavailable for estimate ${estimate.id}: ${err.message}`);
    return null;
  }
}

/**
 * The customer's prepaid recurring plans (prepaid-series.listCustomerPrepaidPlans, the same rollup the appointment screens show), as
 * { label, remaining, paid }. Left out, so a person answers: a series an ANNUAL prepay term covers or is linked to (its stamped visits are not
 * the term's funded entitlement: a replacement visit may not be stamped yet), a series carrying an independently prepaid BOOSTER (a visit with
 * no cadence that bills its own price: it is not a plan visit), and a series whose label another series shares (an exhausted series beside its
 * renewal, an annual-linked renewal included). null when the read failed; [] when there is none.
 */
async function loadPrepaidPlanFacts(customerId, { db } = {}) {
  if (!customerId || !db) return null;
  try {
    const series = require('./prepaid-series');
    const plans = await series.listCustomerPrepaidPlans(db, customerId);
    const rows = await db('scheduled_services')
      .where({ customer_id: customerId })
      .where((qb) => qb.whereNotNull('annual_prepay_term_id').orWhere('prepaid_method', series.ANNUAL_PREPAY_METHOD).orWhere('prepaid_amount', '>', 0))
      .select('id', 'recurring_parent_id', 'service_type', 'annual_prepay_term_id', 'prepaid_method', 'prepaid_amount', 'is_recurring', 'recurring_pattern');
    const annual = rows.filter((row) => series.hasAnnualCoverage(row));
    const boosters = rows.filter((row) => Number(row.prepaid_amount) > 0 && row.is_recurring === false && !row.recurring_pattern);
    const excluded = new Set([...annual, ...boosters].map((row) => String(series.resolveSeriesParentId(row))));
    const label = (value) => String(value || '').toLowerCase();
    const annualLabels = new Set(annual.map((row) => label(row.service_type)));
    const sameLabel = (plan) => plans.filter((other) => label(other.serviceType) === label(plan.serviceType)).length;
    return plans
      .filter((plan) => !excluded.has(String(plan.seriesParentId)) && !annualLabels.has(label(plan.serviceType)) && sameLabel(plan) === 1)
      .map((plan) => ({ label: String(plan.serviceType || ''), remaining: Number(plan.remainingVisits), paid: Number(plan.paidVisits) }))
      .filter((plan) => plan.label && Number.isInteger(plan.remaining) && Number.isInteger(plan.paid) && plan.paid > 0 && plan.remaining >= 0 && plan.remaining <= plan.paid);
  } catch (err) {
    logger.warn(`[sms-staff-facts] prepaid plans unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// ---- Prep guide ----------------------------------------------------------------------------------------------------------------------

// The sections of a published guide that read as prose: each paragraph, callout, list item and FAQ row WHOLE (a published item is never cut
// into sentences: a cut can strand a step from the sentence that names its subject, or split "St. Augustine"), under the heading it sits
// below. A guide's steps often hold only for one case ("Prep for a German roach cleanout", "Prep for palmetto bugs"), so every step stays tied
// to its heading. What the guide tells the customer to DO comes first and its background (why, what we do, the FAQ) after it, each in guide
// order: the drafter's budget is spent on the steps the customer asks about, not on the introduction.
const BACKGROUND_HEADING = /^(?:why|what we do|how (?:we|it)|about|meet|faq|frequently|questions?)\b/i;
const FAQ_HEADING = 'Frequently asked questions';
function guideSections(blocks) {
  const groups = [];
  const add = (heading, parts) => {
    if (!parts.length) return;
    if (!groups.length || heading !== null) groups.push({ heading: heading ?? '', parts: [] });
    groups[groups.length - 1].parts.push(...parts);
  };
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'heading') { groups.push({ heading: String(block.content || '').replace(/\s+/g, ' ').trim(), parts: [] }); continue; }
    if (['paragraph', 'callout'].includes(block.type) && typeof block.content === 'string') add(null, [block.content]);
    if (block.type === 'list' && Array.isArray(block.items)) add(null, block.items.filter((item) => typeof item === 'string'));
    // the FAQ rows of a guide (its question and the answer, in the guide's own words); the service details rows are not prose
    if (block.type === 'details' && block.variant === 'faq' && Array.isArray(block.rows)) {
      add(FAQ_HEADING, block.rows.filter((row) => typeof row?.label === 'string' && typeof row?.value === 'string').map((row) => `${row.label} ${row.value}`));
    }
  }
  const aside = (group) => BACKGROUND_HEADING.test(group.heading);
  return [...groups.filter((group) => !aside(group)), ...groups.filter(aside)];
}

// A street address the bank's phone and email rules do not see ("Meet us at 123 Example Lane"): a house number, one to three words, a street word.
const ADDRESS_RE = /\b\d{1,6}\s+(?:[A-Za-z.']+\s+){0,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|way|court|ct|circle|cir|terrace|ter|place|pl|parkway|pkwy|highway|hwy|trail|trl)\b/i;
// A published item is cut at the drafter's own limits, never mid-item: one longer than this is left out whole.
const MAX_ITEM_CHARS = 700;

// Whether a line of a guide may be repeated: the company facts bank's own text rules (checkFactText: no link, phone number, email, price,
// product or brand name, "safe" or other safety claim, banned copy or prompt-control shape), no street address, no merge tag, no em dash, and
// no wording that points at the email or page itself. The bank's amount rules (no number, at most three sentences, 400 characters) are
// waived: a guide says "12 to 18 inches" in as many sentences as it needs. The drafter screens the rest (prepGuideSection).
const WAIVED = new Set(['number_in_fact', 'too_many_sentences', 'too_long']);
function plainLine(text, bank, ctx) {
  if (ADDRESS_RE.test(text) || /\{\{|\]\(|\u2014/.test(text) || /\b(?:e-?mail|inbox|button|below|above|this (?:guide|page))\b/i.test(text)) return false;
  return bank.checkFactText(text, ctx).blocks.every((code) => WAIVED.has(code));
}

function guideGroups(blocks, productNames) {
  const bank = require('./company-facts-bank');
  const sections = guideSections(blocks);
  // What the guide itself links is a product or brand it names (a pet medication, a collar): the catalog does not know those, so the link
  // labels count as brand names too, in an item of the guide that names the product without the link.
  const linked = sections.flatMap((group) => group.parts).flatMap((part) => [...String(part).matchAll(/\[([^\]]{2,60})\]\(/g)].map((m) => m[1].trim()))
    .flatMap((label) => [label, /^[A-Z][A-Za-z]{5,}/.exec(label)?.[0]]).filter(Boolean);
  const ctx = { productNames: [...productNames, ...linked] };
  const out = [];
  for (const group of sections) {
    const items = group.parts.map((part) => String(part).replace(/\s+/g, ' ').trim())
      .filter((item) => item.length >= 12 && item.length <= MAX_ITEM_CHARS && plainLine(item, bank, ctx));
    // a group whose heading may not be repeated is dropped whole: its steps would sit under the wrong case
    if (items.length && (!group.heading || (group.heading.length <= 120 && plainLine(group.heading, bank, ctx)))) out.push({ heading: group.heading || null, sentences: items });
  }
  return out;
}

/**
 * The prep guide the customer may be asking about: { source, key, label, sections: [{ heading, sentences }] } with the published words of (`sentences` are whole published items: a paragraph, list item, callout or FAQ row)
 * that guide. Which guide: the one prep-guide-sender gives the customer's BOOKED visit (bookedPrepGuide: the soonest upcoming visit, its
 * stop and its stored guide, else its service types' family), else, with no booked visit, the guide the LAST completed service day's services carried (completedPrepGuide: a visit's assigned guide, else the
 * family its service type belongs to by the sender's own match rule; services that finished the same day and disagree name none). Only that one service's guide, never another's. The words are the template's
 * ACTIVE version, the same row the customer's prep page renders (EmailTemplateLibrary.loadTemplateByKey).
 * { sections: [] } when no guide covers the visit or the guide is not published (a successful read of nothing); null when the read failed.
 * Never throws: the drafter writes without a section, and a send-time check reads null as an outage (never as "nothing changed").
 */
async function loadPrepGuideFacts(customerId, lastRecords, { db } = {}) {
  const none = { sections: [] };
  if (!customerId || !db) return null;
  const completedRecords = [].concat(lastRecords || []);
  try {
    const sender = require('./prep-guide-sender');
    const booked = await sender.bookedPrepGuide([customerId]);
    // No booked visit: the services that completed on the latest service day (the history is ordered by that date alone, so several can tie).
    // Each resolves to the guide it carried; they must all agree, else no guide is named.
    // (`lastRecords` null: the latest service day may run past the history page, so no completed service can be named)
    const completed = booked || lastRecords === null ? [] : await Promise.all(completedRecords.map((record) => sender.completedPrepGuide({ scheduledServiceId: record?.scheduled_service_id, serviceRecordId: record?.id, serviceType: record?.service_type })));
    const configs = new Set(completed.map((guide) => guide.config?.emailTemplateKey || null));
    const config = booked ? booked.config : (configs.size === 1 ? completed[0].config : null);
    if (!config) return none;
    const loaded = await require('./email-template-library').loadTemplateByKey(config.emailTemplateKey, db);
    // the template must be one the customer's own page and the email sender would use: published (an active version) and not switched off
    if (!loaded?.activeVersion || String(loaded.template?.status || 'active').toLowerCase() !== 'active') return none;
    const raw = loaded.activeVersion.blocks;
    const blocks = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const sections = guideGroups(blocks, await require('./company-facts-bank').readProductNames(db));
    return sections.length ? { source: booked ? 'booked' : 'last', key: config.emailTemplateKey, label: config.label, sections } : none;
  } catch (err) {
    logger.warn(`[sms-staff-facts] prep guide unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// ---- Service report delivery ------------------------------------------------------------------------------------------------------

// The email ledger statuses (email_messages.status) of the account holder's own report email: delivered, or did not go through. Any other
// status (a complaint, an unsubscribe, a row still queued) says nothing about the inbox, so the sentence names no address then.
const REPORT_EMAIL_DELIVERED = new Set(['sent', 'delivered', 'opened', 'clicked']);
const REPORT_EMAIL_UNDELIVERED = new Set(['bounced', 'bounce', 'dropped', 'blocked', 'failed']);
// How many of the latest completed visits the texting AI may report on (the customer asks about "my report", the last visit or the one before).
const REPORT_DELIVERY_VISITS = 2;
const cleanAddress = (value) => String(value || '').trim().toLowerCase();
// A delivery queue status (service_report_deliveries.status) as what the customer may be told: not yet, not sent, or sent.
const DELIVERY_STATE = { queued: 'pending', sending: 'pending', skipped: 'not_sent', failed: 'not_sent', cancelled: 'not_sent', sent: 'sent' };

// Where a sent report went, judged from the account holder's own report email row (one row, or none): never the address itself.
function reportRecipient(messages, accountEmail) {
  if (messages.length !== 1) return 'unknown';
  const status = String(messages[0].status || '').toLowerCase();
  const address = cleanAddress(messages[0].recipient_email_snapshot);
  if (REPORT_EMAIL_UNDELIVERED.has(status)) return 'undelivered';
  if (!REPORT_EMAIL_DELIVERED.has(status) || !address) return 'unknown';
  return accountEmail && address === accountEmail ? 'account' : 'other_address';
}

// One visit's delivery fact, or null when a person answers: no delivery row (or, never by the unique key, two), an unknown status, no service
// name or day, or a sent row with no send time.
function visitDelivery(record, { rows, own, accountEmail }) {
  const { dateOnlyString } = require('../utils/date-only');
  const state = rows.length === 1 ? DELIVERY_STATE[String(rows[0].status || '').toLowerCase()] : undefined;
  const visit = { recordId: record.id, serviceType: String(record.service_type || ''), serviceDate: dateOnlyString(record.service_date), state };
  if (!state || !visit.serviceType || !visit.serviceDate) return null;
  if (state !== 'sent') return visit;
  const sentAt = rows[0].sent_at ? new Date(rows[0].sent_at) : null;
  if (!(sentAt?.getTime() >= 0)) return null;
  return { ...visit, sentOn: require('../utils/datetime-et').etDateString(sentAt), recipient: reportRecipient(own, accountEmail) };
}

/**
 * Whether the service report of each of the customer's latest completed visits went out by email (service_report_deliveries, the durable
 * queue the report email is sent from: one email row per visit, service_report_v1), as { visits: [{ recordId, serviceType, serviceDate,
 * state, sentOn, recipient }] } in visit order (newest first):
 *   state      'sent' | 'pending' (queued or sending: not yet) | 'not_sent' (skipped, failed or cancelled)
 *   sentOn     the ET calendar day of sent_at (YYYY-MM-DD), for 'sent' only
 *   recipient  for 'sent': 'account' (the account holder's own report email was delivered, to the email address the account carries NOW),
 *              'other_address' (delivered, to an address the account no longer carries), 'undelivered' (that email did not go through),
 *              or 'unknown' (no ledger row for the holder's own email, or a status that says nothing): the address is never returned.
 * A visit with no delivery row (a report sent before the queue, or none), an unknown status or a sent row with no send time is left out: a
 * person answers. Never an email address, never a technician note. { visits: [] } when nothing qualifies; null when a read failed. Never throws.
 */
async function loadReportDeliveryFacts(customerId, records, { db } = {}) {
  if (!customerId || !db) return null;
  const visits = [].concat(records || []).filter((record) => record?.id).slice(0, REPORT_DELIVERY_VISITS);
  if (!visits.length) return { visits: [] };
  try {
    const ids = visits.map((record) => record.id);
    const ownKey = (id) => `service_report_ready:${id}:primary`;
    const [customer, deliveries, ledger] = await Promise.all([
      db('customers').where({ id: customerId }).first('email'),
      db('service_report_deliveries').whereIn('service_record_id', ids).where({ channel: 'email', report_template_version: 'service_report_v1' })
        .select('service_record_id', 'status', 'sent_at'),
      // the account holder's own report email (email-delivery.js serviceReportEmailIdempotencyKey: one key per visit and recipient role)
      db('email_messages').whereIn('idempotency_key', ids.map(ownKey)).select('idempotency_key', 'status', 'recipient_email_snapshot'),
    ]);
    const accountEmail = cleanAddress(customer?.email);
    const out = visits.map((record) => visitDelivery(record, {
      rows: deliveries.filter((row) => String(row.service_record_id) === String(record.id)),
      own: ledger.filter((message) => message.idempotency_key === ownKey(record.id)),
      accountEmail,
    })).filter(Boolean);
    return { visits: out };
  } catch (err) {
    logger.warn(`[sms-staff-facts] report delivery unavailable for customer ${customerId}: ${err.code || err.name || 'error'}`);
    return null;
  }
}

module.exports = { loadEstimateFacts, loadPrepaidPlanFacts, loadPrepGuideFacts, loadReportDeliveryFacts, REPORT_DELIVERY_VISITS };
