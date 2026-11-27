'use strict';
// Facts staff know and the texting agent may state (owner 2026-11-25, texting AI fix step 2: "feed the facts staff know"; owner ruling
// 2026-09-30: price and fee questions are explained from the estimate and invoice on file): the open estimate's per-application price and
// applications a year, its setup fee and pay-for-the-year total (owner 2026-11-26: "let the AI answer everything"), a customer's prepaid
// visits left, the prep guide of the customer's booked visit and whether the latest visits' service reports went out by email (never the
// address). This module only READS the facts.
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

// callSideBlockForEstimateData answers with one of these when it could not READ the call or the move: a failed read, not a verdict.
const VERDICT_UNREAD = new Set(['call_verdict_unavailable', 'move_verdict_unavailable']);

/**
 * True only when the customer's own estimate page would show this estimate: not expired, not held off the customer surface (a quarantine
 * marker, an invalidated linkage, a pending reprice or an unverified address: estimateOffCustomerSurface), and passing the call-side verdict
 * every public estimate route runs (callSideBlockForEstimateData): a call-drafted estimate's call and lead, a new-home estimate's move.
 * Those rows can change with the estimate row untouched, so the send fingerprint hashes them too (billing-fingerprint.js). It finds them
 * by the ids in estimate_data, read by JSON path, and a path reads nothing from data stored as a JSON string: a linked estimate stored
 * that way states nothing here (its call or its move could change unseen at send). An estimate with neither link costs no read here.
 * False = not on the page; null = the verdict could not be read (the caller fails the read).
 */
async function estimateOnCustomerSurface(estimate, db) {
  if (estimate.expires_at && new Date(estimate.expires_at).getTime() < Date.now()) return false;
  const claims = require('../utils/estimate-claim-sql');
  if (claims.estimateOffCustomerSurface(estimate)) return false;
  const data = parsedData(estimate);
  // (the two links the verdict reads: callSideBlockForEstimateData)
  if (typeof estimate.estimate_data === 'string' && (data.move?.moveId || data.estimatorEngine?.callLogId)) return false;
  const block = await claims.callSideBlockForEstimateData(db, data, { estimateStatus: estimate.status });
  if (!block) return true;
  return VERDICT_UNREAD.has(block) ? null : false;
}

const toCents = (value) => {
  const n = Math.round(Number(value) * 100);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The estimate page's own answer for the open estimate: its live pricing bundle, resolved strictly (estimate-proposal-billing
 * resolveLivePricing in rethrow mode: the member snapshot is reconciled first, and an unverified one is a failed read), and the page's "What
 * you pay and when" box over that bundle, through the page's one assembly (estimate-public whatYouPayForEstimate) and its two live lookups
 * (the billing lane, the deposit ledger). The page shows no box when it cannot read one of them; here that is a failed read, so it throws.
 * The reconcile rewrites a lapsed member's estimate_data in place, so it works on a copy: { row, bundle, box }. box null = the page shows
 * no box; bundle null = a price-locked estimate (no live pricing, so no box either).
 */
async function estimatePageFor(estimate) {
  const row = structuredClone(estimate);
  const live = await require('./estimate-proposal-billing').resolveLivePricing(row, { rethrow: true });
  if (!live?.bundle) return { row, bundle: null, box: null };
  const page = require('../routes/estimate-public');
  const lookups = await page.whatYouPayAcceptLookups(row);
  if (lookups.monthlyBilled == null || lookups.pendingDeposit == null) throw new Error('the billing lane or the deposit ledger could not be read');
  return { row, bundle: live.bundle, box: page.whatYouPayForEstimate(row, parsedData(row), live.bundle, lookups) };
}

/**
 * The setup fee as the estimate page states it, or null when its two readers disagree (a person answers):
 *   { cents, prepayWaives, label }  the fee the first bill carries (the box: whatYouPayForData, the converter's own fee rule and frozen
 *                                   amount), equal to the cent to the page's own fee row; prepayWaives only when the box AND that row both
 *                                   say prepay waives it
 *   { cents: 0, waived, label }     no fee on the first bill and no fee row; waived = the estimate's own record holds a waiver (a staff
 *                                   waiver, or the returning-customer rule's STORED answer in either shape). The rule itself is never run here.
 * label = the one service the estimate is for (one box line, one per-application line), else null: the sentence then names no service.
 */
function setupFeeFact({ box, bundle, row, perApplication }) {
  const feeRow = (Array.isArray(bundle?.firstVisitFees) ? bundle.firstVisitFees : []).find((fee) => fee?.service === 'waveguard_setup');
  const cents = toCents(box.setupFee) || 0;
  if ((toCents(feeRow?.amount) || 0) !== cents) return null;
  const label = box.lines.length === 1 && perApplication.length === 1 ? perApplication[0].label : null;
  if (cents > 0) return { cents, prepayWaives: box.setupWaivedWithPrepay === true && feeRow.waivedWithPrepay === true, label };
  const data = parsedData(row);
  const waived = require('./estimate-converter').estimateOperatorSetupFeeWaived(data) === true
    || require('./returning-setup-fee-waiver').holdsReturningSetupWaiver(data) === true;
  return { cents: 0, waived, label };
}

/**
 * The pay-for-the-year total of the plan the page shows by default, as { label, cents, applications }, or null. Stated only when it is
 * provably the WHOLE prepay bill: three derivations must agree to the cent.
 *   1. the accept lane's own figure for that plan: buildAnnualPrepayEstimateSuggestion priced on the page's bundle and default option (its
 *      eligibility, deposit, reprice, quote and cadence guards all apply; it prices one recurring service only),
 *   2. the bill the operator preview computes from the stored totals (annualPrepayInvoiceTotalForEstimate: one-time lines, commercial tax
 *      and a deposit credit included), and
 *   3. the invoice module's own dry run of that amount for this customer (InvoiceService.previewInvoiceTotals, the mirror of create()'s tax
 *      rule): an account classed commercial is taxed on a bill whatever the estimate's services are, and 2 taxes commercial services only.
 * The first is the coverage line alone, so equality proves the bill carries nothing else. A prepay bill never carries the setup fee, so an
 * estimate that lists one must also show prepay waiving it. The line is the per-application line of the same plan (one line, same applications
 * a year). Anything else (a bundle, a tier plan whose cadence this path cannot read, an existing customer) states no total. Nor does a
 * termite annual plan: it signs before it pays (isTermiteAnnualSignBeforePayAccept), and its bill carries a Station Setup line that 1 and 2
 * both leave out. Throws when a read failed: the accept lane marks a block that is no verdict (`unverified`: the customer's plan, a
 * deposit or the call behind the estimate could not be read), and the caller answers null.
 */
async function prepayTotalFact({ row, box, bundle, setupFee, perApplication, db }) {
  const [line] = perApplication;
  if (!setupFee || !row.customer_id || perApplication.length !== 1 || box.lines.length !== 1 || box.lines[0].applicationsPerYear !== line.applications) return null;
  if (setupFee.cents > 0 && !setupFee.prepayWaives) return null;
  if (require('./estimate-converter').isTermiteAnnualSignBeforePayAccept(row, parsedData(row), 'prepay_annual')) return null;
  const suggestion = await require('./annual-prepay-estimate-suggestion')
    .buildAnnualPrepayEstimateSuggestion([row], { db, pricedOption: { bundle, key: box.selection.frequency } });
  if (suggestion?.unverified) throw new Error(suggestion.blockReason);
  if (!suggestion || suggestion.blocked || suggestion.coverageVisitCount !== line.applications) return null;
  const cents = toCents(suggestion.amount);
  const billed = toCents(await require('./estimate-manual-acceptance').annualPrepayInvoiceTotalForEstimate(row));
  if (!cents || cents !== billed) return null;
  const invoiced = await require('./invoice').previewInvoiceTotals({ customerId: row.customer_id, amount: suggestion.amount, database: db });
  return toCents(invoiced.total) === cents ? { label: line.label, cents, applications: line.applications } : null;
}

/**
 * The open estimate's setup fee and pay-for-the-year total, as { setupFee, prepayTotal } (each null when it may not be stated), from the
 * page's own box. No box (the page shows none: a deposit, a credit, a one-time line, invoice mode, a monthly-billed or commercial plan,
 * a quote that needs review) states neither. null when the page or the accept lane could not be read. Never throws.
 */
async function loadEstimateTerms(estimate, { perApplication, db }) {
  try {
    const { row, box, bundle } = await estimatePageFor(estimate);
    if (!box) return { setupFee: null, prepayTotal: null };
    const setupFee = setupFeeFact({ box, bundle, row, perApplication });
    return { setupFee, prepayTotal: await prepayTotalFact({ row, box, bundle, setupFee, perApplication, db }) };
  } catch (err) {
    logger.warn(`[sms-staff-facts] setup fee and prepay total unavailable for estimate ${estimate.id}: ${err.message}`);
    return null;
  }
}

/**
 * What the open estimate lists per application, as { perApplication: [{ label, cents, applications }], terms }: the lines and the applications
 * a year of the per-application average model, the SAME model the estimate page and the delivery email read (estimate-monthly-average: it
 * reconciles each line against the stored plan total, so a line that does not add up is withheld), and `terms`, its setup fee and
 * pay-for-the-year total (loadEstimateTerms: null when THAT read failed, so the price lines above stay usable). Never a first-visit total or a
 * one-time line: those stay with staff.
 * { perApplication: [], terms: nothing } when there is no estimate, it is not on the customer's own page, the customer has more than one open
 * estimate, or it lists none (a successful read of nothing); null when the read failed. Never throws.
 */
async function loadEstimateFacts(estimate, { db } = {}) {
  const none = { perApplication: [], terms: { setupFee: null, prepayTotal: null } };
  if (!estimate?.id) return none;
  if (!db) return null;
  try {
    const onPage = await estimateOnCustomerSurface(estimate, db);
    if (onPage == null) throw new Error('the call or move behind the estimate could not be read');
    if (!onPage) return none;
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
    return { perApplication, terms: await loadEstimateTerms(estimate, { perApplication, db }) };
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
// The guide the completed services agree on, else null. A named service (`family`): only a guide of that service, never another
// service's last guide.
function lastGuideConfig(completed, family) {
  const keys = new Set(completed.map((guide) => (family && guide.pestType !== family ? null : guide.config?.emailTemplateKey || null)));
  return keys.size === 1 && [...keys][0] ? completed[0].config : null;
}
async function loadPrepGuideFacts(customerId, lastRecords, { db, family } = {}) {
  const none = { sections: [] };
  if (!customerId || !db) return null;
  const completedRecords = [].concat(lastRecords || []);
  try {
    const sender = require('./prep-guide-sender');
    // `family` (texting AI gap 5): the service the customer named; a later upcoming visit that carries its guide comes back as source 'named'
    const booked = await sender.bookedPrepGuide([customerId], { family });
    // No booked visit: the services that completed on the latest service day (the history is ordered by that date alone, so several can tie).
    // Each resolves to the guide it carried; they must all agree, else no guide is named.
    // (`lastRecords` null: the latest service day may run past the history page, so no completed service can be named)
    const completed = booked || lastRecords === null ? [] : await Promise.all(completedRecords.map((record) => sender.completedPrepGuide({ scheduledServiceId: record?.scheduled_service_id, serviceRecordId: record?.id, serviceType: record?.service_type })));
    const config = booked ? booked.config : lastGuideConfig(completed, family);
    if (!config) return none;
    const loaded = await require('./email-template-library').loadTemplateByKey(config.emailTemplateKey, db);
    // the template must be one the customer's own page and the email sender would use: published (an active version) and not switched off
    if (!loaded?.activeVersion || String(loaded.template?.status || 'active').toLowerCase() !== 'active') return none;
    const raw = loaded.activeVersion.blocks;
    const blocks = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const sections = guideGroups(blocks, await require('./company-facts-bank').readProductNames(db));
    return sections.length ? { source: booked ? booked.source || 'booked' : 'last', key: config.emailTemplateKey, label: config.label, sections } : none;
  } catch (err) {
    logger.warn(`[sms-staff-facts] prep guide unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// ---- Service report delivery ------------------------------------------------------------------------------------------------------

// The email ledger statuses (email_messages.status) of the account holder's own report email: delivered, or did not go through. Any other
// status (a complaint, an unsubscribe, a row still queued) says nothing about the inbox, so the sentence names no address then.
// How many of the latest completed visits the texting AI may report on (the customer asks about "my report", the last visit or the one before).
const REPORT_DELIVERY_VISITS = 2;
const cleanAddress = (value) => String(value || '').trim().toLowerCase();
// The ACCOUNT HOLDER's own report email (email_messages.status of the key service_report_ready:<record>:primary) decides what the customer
// is told, never the queue row alone: the queue row is the whole send (several recipients), so a holder email that went out beside a
// service contact's that failed leaves the row queued or failed (Codex #8660 r1). Reached the holder ('delivered'), reached the provider
// and did not reach the inbox ('undelivered'), went out with a status that says nothing more ('unknown'), was never sent ('not_sent':
// suppressed or the provider call failed), or not attempted yet ('no_attempt'). Any other status: no sentence.
const HOLDER_EMAIL = {
  sent: 'delivered', delivered: 'delivered', opened: 'delivered', clicked: 'delivered',
  bounced: 'undelivered', bounce: 'undelivered', dropped: 'undelivered',
  complained: 'unknown', spam_report: 'unknown', unsubscribed: 'unknown',
  blocked: 'not_sent', failed: 'not_sent', queued: 'no_attempt',
};
const HOLDER_RECEIVED = new Set(['delivered', 'undelivered', 'unknown']);
// A report the holder never received, by the queue row's status and the holder's own email ('none' = no row for it): "not yet" while the
// queue still holds the send, "not emailed" once the queue gave up and the holder's row proves no send (or a skip, which sends to no one).
// Every other pair (a queue row marked sent with no holder email, ...) disagrees: no sentence, a person answers.
const NOT_RECEIVED = {
  'queued:none': 'pending', 'queued:no_attempt': 'pending', 'queued:not_sent': 'pending',
  'sending:none': 'pending', 'sending:no_attempt': 'pending', 'sending:not_sent': 'pending',
  'skipped:none': 'not_sent', 'skipped:not_sent': 'not_sent', 'failed:not_sent': 'not_sent', 'cancelled:not_sent': 'not_sent',
};

// One visit's delivery fact, or null when a person answers: no delivery row (or, never by the unique key, two), two holder emails, no
// service name or day, a received email with no send time, or a queue row and a holder email that disagree.
function visitDelivery(record, { rows, own, accountEmail }) {
  const { dateOnlyString } = require('../utils/date-only');
  const queue = rows.length === 1 ? String(rows[0].status || '').toLowerCase() : '';
  const holder = own.length ? (own.length === 1 && HOLDER_EMAIL[String(own[0].status || '').toLowerCase()]) : 'none';
  const visit = { recordId: record.id, serviceType: String(record.service_type || ''), serviceDate: dateOnlyString(record.service_date) };
  if (!queue || !holder || !visit.serviceType || !visit.serviceDate) return null;
  if (!HOLDER_RECEIVED.has(holder)) return NOT_RECEIVED[`${queue}:${holder}`] ? { ...visit, state: NOT_RECEIVED[`${queue}:${holder}`] } : null;
  // the day the holder's own email went out (its own sent_at, not the queue row's: the row may still be retrying another recipient)
  const sentAt = own[0].sent_at ? new Date(own[0].sent_at) : null;
  if (!(sentAt?.getTime() >= 0)) return null;
  const address = cleanAddress(own[0].recipient_email_snapshot);
  const recipient = holder === 'delivered' ? (accountEmail && address === accountEmail ? 'account' : 'other_address') : holder;
  return { ...visit, state: 'sent', sentOn: require('../utils/datetime-et').etDateString(sentAt), recipient };
}

/**
 * Whether the service report of each of the customer's latest completed visits went out by email (service_report_deliveries, the durable
 * queue the report email is sent from: one email row per visit, service_report_v1), as { visits: [{ recordId, serviceType, serviceDate,
 * state, sentOn, recipient }] } in visit order (newest first):
 *   state      'sent' (the holder's own email went out) | 'pending' (the queue still holds it and the holder's email has not gone out) |
 *              'not_sent' (the queue gave up and the holder's own email provably did not go out, or a skip): see visitDelivery
 *   sentOn     the ET calendar day of the holder's own email's sent_at (YYYY-MM-DD), for 'sent' only
 *   recipient  for 'sent': 'account' (the account holder's own report email was delivered, to the email address the account carries NOW),
 *              'other_address' (delivered, to an address the account no longer carries), 'undelivered' (that email did not go through),
 *              or 'unknown' (the holder's own email row carries a status that says nothing): the address is never returned.
 *              A sent report with NO ledger row for the holder's own email is left out (it may have gone only to a service contact).
 * A visit with no delivery row (a report sent before the queue, or none), a queue row and holder email that disagree (a row marked sent with
 * no holder email: it may have gone only to a service contact) or an email with no send time is left out: a person answers. Never an email
 * address, never a technician note. { visits: [] } when nothing qualifies; null when a read failed. Never throws.
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
      db('email_messages').whereIn('idempotency_key', ids.map(ownKey)).select('idempotency_key', 'status', 'recipient_email_snapshot', 'sent_at'),
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
