'use strict';
// Facts staff know and the texting agent may state (owner 2026-11-25, texting AI fix step 2: "feed the facts staff know"; owner ruling
// 2026-09-30: price and fee questions are explained from the estimate and invoice on file): the open estimate's per-application price and
// applications a year, a customer's prepaid visits left, and the prep guide of the customer's booked visit. This module only READS the facts.
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

// The text parts of a published guide's blocks that read as prose: paragraphs, callouts and list items (never a heading, the service
// details rows, the button or the signature: the page itself drops the last two for the same reason). What the guide tells the customer
// to DO comes first and its background (why fleas are hard to beat, what the technician does on the day, the FAQ) after it, each in guide
// order: the drafter's budget is spent on the steps the customer asks about, not on the introduction.
const BACKGROUND_HEADING = /^(?:why|what we do|how (?:we|it)|about|meet|faq|frequently|questions?)\b/i;
function proseOfBlocks(blocks) {
  const steps = [];
  const background = [];
  let aside = false;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'heading') aside = BACKGROUND_HEADING.test(String(block.content || '').trim());
    const parts = [];
    if (['paragraph', 'callout'].includes(block.type) && typeof block.content === 'string') parts.push(block.content);
    if (block.type === 'list' && Array.isArray(block.items)) parts.push(...block.items.filter((item) => typeof item === 'string'));
    (aside ? background : steps).push(...parts);
  }
  return [...steps, ...background];
}

// One sentence of a guide the AI may repeat: a plain sentence about the service. Dropped: merge tags, links and addresses, em dashes, a
// price, wording that points at the email or page itself, and a product or brand name (the company facts bank's own rule). The drafter
// screens what is left for banned claims (prepGuideSection). A full stop after an abbreviation is not a sentence end (the bank's own
// splitter: "St. Augustine wants 3.5 to 4 inches.").
function guideSentences(blocks, productNames) {
  const { productTokens, mentionsProduct, splitSentences } = require('./company-facts-bank');
  const parts = proseOfBlocks(blocks);
  // What the guide itself links is a product or brand it names (a pet medication, a collar): the catalog does not know those, so the link
  // labels count as brand names too, in a sentence of the guide that names the product without the link.
  const linked = parts.flatMap((part) => [...String(part).matchAll(/\[([^\]]{2,60})\]\(/g)].map((m) => m[1].trim()))
    .flatMap((label) => [label, /^[A-Z][A-Za-z]{5,}/.exec(label)?.[0]]).filter(Boolean);
  const tokens = productTokens([...productNames, ...linked]);
  const sentences = [];
  for (const part of parts) {
    for (const raw of splitSentences(String(part).replace(/\s+/g, ' ').trim())) {
      const sentence = raw.trim();
      if (sentence.length < 12 || sentence.length > 260) continue;
      if (/\{\{|\]\(|https?:|www\.|@|\u2014|\$/.test(sentence)) continue;
      if (/\b(?:e-?mail|inbox|button|below|above|this (?:guide|page))\b/i.test(sentence)) continue;
      if (mentionsProduct(sentence, tokens)) continue;
      sentences.push(sentence);
    }
  }
  return sentences;
}

/**
 * The prep guide the customer may be asking about: { source, key, label, sentences } with the published words of that guide. Which guide:
 * the one prep-guide-sender gives the customer's BOOKED visit (bookedPrepGuide: the soonest upcoming guide visit and its stored guide,
 * else its family's); with no booked visit, the family the LAST completed service belongs to (prepFamilyForServiceType: the sender's own
 * match rule). Only that one service's guide, never another's. The words are the template's ACTIVE version, the same row the customer's
 * prep page renders (EmailTemplateLibrary.loadTemplateByKey).
 * { sentences: [] } when no guide covers the visit or the guide is not published (a successful read of nothing); null when the read failed.
 * Never throws: the drafter writes without a section, and a send-time check reads null as an outage (never as "nothing changed").
 */
async function loadPrepGuideFacts(customerId, lastRecord, { db } = {}) {
  const none = { sentences: [] };
  if (!customerId || !db) return null;
  try {
    const sender = require('./prep-guide-sender');
    const booked = await sender.bookedPrepGuide([customerId]);
    const family = booked ? (booked.config ? [booked.pestType, booked.config] : null) : sender.prepFamilyForServiceType(lastRecord?.service_type);
    if (!family) return none;
    const config = family[1];
    const loaded = await require('./email-template-library').loadTemplateByKey(config.emailTemplateKey, db);
    if (!loaded?.activeVersion) return none;
    const raw = loaded.activeVersion.blocks;
    const blocks = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const sentences = guideSentences(blocks, await require('./company-facts-bank').readProductNames(db));
    return sentences.length ? { source: booked ? 'booked' : 'last', key: config.emailTemplateKey, label: config.label, sentences } : none;
  } catch (err) {
    logger.warn(`[sms-staff-facts] prep guide unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = { loadEstimateFacts, loadPrepaidPlanFacts, loadPrepGuideFacts };
