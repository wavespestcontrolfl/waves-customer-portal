// server/services/reservice-fixed-recap.js
//
// The ONE fixed customer text for a pest re-service closed through Fast Complete
// (GATE_FAST_COMPLETE_RECAP; scope: ~/fast-complete-scope-20260926.md, decision 5,
// adopted). No AI, never signed, no customer wording on the client. Built from
// facts the visit recorded:
//
//   Your re-service at <street address> is done. We treated <where> for
//   <pests>. Keep kids and pets off treated areas until dry. Details: <link>
//
// - <where>  from areas_serviced (Inside / Outside / Garage).
// - <pests>  from the product rows' targets (the pests the tech picked).
// - The "keep kids and pets off" line only when a recorded product row went
//   down wet (a spray, drench, fog or the like; not bait, granular, a station
//   check or trunk injection).
// - A clause whose fact is missing is dropped whole; nothing is invented.
//
// Pure: no DB, no clock. complete-scheduled-service.js gathers the saved facts
// and sends the result through the existing customer send path (consent, STOP,
// opt-out, phone checks all still apply).
'use strict';

const ActivityIndicators = require('./service-report/activity-indicators');
const { isSprayApplicationMethod } = require('./service-report/service-line-configs');

const MODE = 'reservice_fixed';
// Registered as this text's template key (sms_log / notes); the message type
// stays the completion family's so channel routing is the completion text's.
const TEMPLATE_KEY = 'reservice_fixed_recap';
// The compliance idiom (AGENTS.md): conditional on dry, technician confirms
// the timing, never a fixed figure and never "safe".
const SAFETY_LINE = 'Keep kids and pets off treated areas until dry; your technician confirms the timing.';

// A product row went down wet when its method is spray-class by the report
// module's own classifier (everything but bait, station and trunk injection:
// sprays, soil drench, fog, pin stream, and any method added later) and is not
// a dry granular broadcast. An empty method says nothing, so it counts as dry.
const DRY_APPLICATION_METHODS = new Set(['granular_broadcast']);

function isWetMethod(method) {
  const key = String(method == null ? '' : method).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return isSprayApplicationMethod(key) && !DRY_APPLICATION_METHODS.has(key);
}

const MAX_PEST_CHARS = 40;
const MAX_PESTS = 6;

// Where phrases, in reading order. Anything else the areas column holds
// (legacy labels) has no phrase and is left out.
const AREA_PHRASES = [
  ['inside', 'inside'],
  ['outside', 'outside'],
  ['garage', 'the garage'],
];

const text = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function naturalJoin(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function whereOf(areas) {
  const have = new Set((Array.isArray(areas) ? areas : []).map((a) => text(a).toLowerCase()));
  return naturalJoin(AREA_PHRASES.filter(([key]) => have.has(key)).map(([, phrase]) => phrase));
}

// Pest names the tech typed or tapped, once each, lowercased. A name that is
// too long, carries symbols, or trips the banned customer-copy screen is
// dropped rather than cleaned up.
function pestsOf(products) {
  const seen = new Set();
  const pests = [];
  for (const product of Array.isArray(products) ? products : []) {
    const targets = Array.isArray(product?.targets) ? product.targets : [];
    for (const raw of targets) {
      const name = text(raw).toLowerCase();
      if (!name || name.length > MAX_PEST_CHARS || !/^[a-z0-9][a-z0-9 '&/-]*$/.test(name)) continue;
      if (ActivityIndicators.findBannedCustomerCopy(name).length) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      pests.push(name);
    }
  }
  return pests.slice(0, MAX_PESTS);
}

function hasLiquidApplication(products) {
  return (Array.isArray(products) ? products : [])
    .some((product) => isWetMethod(product?.application_method ?? product?.applicationMethod));
}

/**
 * @param {object} facts
 * @param {string} [facts.address]   street line of the visit's address
 * @param {string[]} [facts.areas]   areas_serviced labels
 * @param {Array<{targets?: string[], application_method?: string}>} [facts.products] saved service_products rows
 * @param {string} [facts.reportUrl] the visit's report link
 * @returns {string} the text, or '' when there is no link to send it with
 */
function buildReserviceFixedRecap({ address, areas, products, reportUrl } = {}) {
  const link = text(reportUrl);
  // The text is a pointer to the report: without a link there is nothing
  // honest to send.
  if (!link) return '';
  const street = text(address);
  const where = whereOf(areas);
  const pests = naturalJoin(pestsOf(products));
  const treated = [where, pests ? `for ${pests}` : ''].filter(Boolean).join(' ');
  return [
    street ? `Your re-service at ${street} is done.` : 'Your re-service is done.',
    treated ? `We treated ${treated}.` : '',
    hasLiquidApplication(products) ? SAFETY_LINE : '',
    `Details: ${link}`,
  ].filter(Boolean).join(' ');
}

// Whether a request's `customerRecapMode` is honored: the mode asked for, both
// dark gates on (server side), and the visit is still a pest re-service by the
// live completion profile. Anything else is NOT honored, and the caller then
// sends no completion text at all (never falls back to another text).
function reserviceFixedRecapHonored({ requestedMode, fastCompleteGate, recapGate, serviceKey }) {
  return requestedMode === MODE
    && fastCompleteGate === true
    && recapGate === true
    && serviceKey === 'pest_re_service';
}

// The body the provider is handed, and so the body audited and shown to the
// tech: sendCustomerMessage removes the https:// scheme and normalizes
// typographic punctuation for customer SMS (the same two helpers, here).
function providerBody(body) {
  const { stripSmsUrlScheme } = require('./messaging/sms-link-policy');
  const { normalizeGsmPunctuation } = require('./messaging/gsm-normalize');
  return normalizeGsmPunctuation(stripSmsUrlScheme(body));
}

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

// The saved facts the text is built from, read back after the completion
// committed: the visit's street (stamped visit address, else the customer's),
// the record's areas, and its product rows. `db` is a knex handle.
async function loadReserviceFixedRecapFacts(db, { svc, recordId, reportUrl }) {
  const { resolveVisitAddress, readReportIdentitySnapshot } = require('./service-report/report-identity-snapshot');
  const [customer, record, productRows] = await Promise.all([
    db('customers').where({ id: svc.customer_id }).first('address_line1', 'address_line2', 'city', 'state', 'zip'),
    db('service_records').where({ id: recordId }).first('areas_serviced', 'service_data'),
    db('service_products').where({ service_record_id: recordId }).select('*'),
  ]);
  // The street the linked report shows: the address frozen on the record at
  // completion (reportIdentitySnapshot), so the text and its report agree even
  // if the customer's address changes later. Only a record with no snapshot
  // falls back to the current visit / customer rows.
  const snapshotAddress = readReportIdentitySnapshot({ service_data: record?.service_data })?.address;
  const address = snapshotAddress && typeof snapshotAddress === 'object'
    ? snapshotAddress.line1
    : resolveVisitAddress({ visit: svc, customer: customer || {} }).line1;
  return {
    address,
    areas: asArray(record?.areas_serviced),
    products: (productRows || []).map((row) => ({
      application_method: row.application_method,
      targets: asArray(row.targets),
    })),
    reportUrl,
  };
}

// What the tech sees after Complete: the exact text that went, or why none did
// (`reason` is a lowercase fragment: the sheet writes "No text sent: <reason>").
// `status` is the record's completionSmsStatus.
function customerTextOutcome({ honored, status, body, error, channel, deliveryUnverified }) {
  const via = channel === 'push' ? { channel: 'push' } : { channel: 'sms' };
  // A stored sent / held text is the truth even when this request is no
  // longer honored (a gate flipped between a first attempt that sent and a
  // resumed retry): the tech must not be told nothing went out.
  if (status === 'sent') return { sent: true, ...via, body: body || null, reason: null };
  if (status === 'deferred') {
    return { sent: false, queued: true, ...via, body: body || null, reason: 'held until the morning send window, then it goes out' };
  }
  // A provider handoff with an unknown result (completionSmsDeliveryUnverifiedAt
  // kept beside 'failed'): the text may have arrived, so the tech must not
  // read it as not sent and text the customer again by hand.
  if (status === 'failed' && deliveryUnverified) {
    return {
      sent: false, unverified: true, ...via, body: body || null,
      reason: "it may have gone out, but delivery wasn't confirmed. The office will check, so don't send another",
    };
  }
  if (!honored) return { sent: false, body: null, reason: 'the customer text is turned off for this visit' };
  const reasons = {
    no_phone: 'no phone number on file',
    blocked: "the customer can't be texted (opted out or blocked)",
    failed: 'the text could not be sent',
    suppressed_delivery_mode: 'texts are off for this visit type',
    skipped_recap_sms_already_sent: 'a recap text already went out for this visit',
  };
  return { sent: false, body: null, reason: reasons[status] || 'nothing was sent', ...(error && status === 'failed' ? { error } : {}) };
}

module.exports = {
  MODE,
  TEMPLATE_KEY,
  SAFETY_LINE,
  isWetMethod,
  providerBody,
  buildReserviceFixedRecap,
  reserviceFixedRecapHonored,
  loadReserviceFixedRecapFacts,
  customerTextOutcome,
};
