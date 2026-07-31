/**
 * Estimator Engine — scope guards (GATE_ESTIMATOR_SCOPE_GUARDS, default
 * OFF; engine-family env-gate pattern, same value semantics as
 * GATE_ESTIMATOR_SMS_DRAFTS).
 *
 * Two production incidents motivated this module (2026-07-30):
 *  - A third-party coordinator texted logistics for an existing quarterly
 *    customer's already-booked visit ("this is <coordinator> with
 *    <customer> at <street address>, can you spray before Saturday") from
 *    a phone not on file. Every identity check in the SMS quote lane is
 *    sender-phone keyed, so the thread read as a new prospect and the
 *    engine drafted a one-time treatment for a property whose recurring
 *    plan already covers the pest — with no customer linked.
 *  - "are you available for power washing service" rang the owed-quote
 *    bell: the classifier is never told what Waves actually offers, and
 *    the prefilter matches the bare token "service".
 *
 * The fix is grounding, not more regex: give the pre-bell triage step the
 * Waves context it was missing — sender→customer match, message-address→
 * customer match (primary and secondary properties, confirmed against the
 * full normalized street), booked visits, the recent inbound thread, and
 * the offered-service list — plus a deterministic out-of-scope backstop
 * that runs before any model call. Everything here is fail-open AND
 * time-bounded: a guard failure or a slow database must degrade to
 * today's behavior (an extra bell), never block a real quote and never
 * hold the Twilio webhook.
 */

const logger = require('../logger');
const { last10 } = require('../external-phone');
const { sameStreetAddress } = require('./address-compare');

function scopeGuardsEnabled() {
  const flag = process.env.GATE_ESTIMATOR_SCOPE_GUARDS;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// The Twilio webhook awaits triage before its TwiML response, alongside the
// classifier's own 3.5s cap — the whole grounding phase gets a hard budget
// so a saturated pool degrades to the ungrounded prompt, not a webhook
// timeout.
const TRIAGE_TIMEOUT_MS = 1200;

// Look back this far in sms_log when a coordinator splits context across
// texts (address in one message, the ask in the next).
const THREAD_WINDOW_HOURS = 48;
const THREAD_WINDOW_LIMIT = 5;

// Services Waves does NOT offer, phrased as service REQUESTS (noun +
// action/service context), not bare nouns — "Jane Painter" introducing
// herself or a "Roofers Rd" street name must never trip the veto.
// Deliberately conservative — anything ambiguous falls through to the
// grounded classifier instead.
const OUT_OF_SCOPE_RE = new RegExp(
  [
    'power\\s*wash\\w*', 'pressure\\s*wash\\w*', 'soft\\s*wash\\w*',
    '\\broofing\\b', 'roof\\s*(?:repair|replace\\w*|clean\\w*|leak|work)',
    'gutter\\s*(?:clean\\w*|repair\\w*|guard)', 'clean\\w*\\s+(?:my|the|our)\\s+gutters',
    '\\bpainting\\b', 'paint\\s+(?:job|work|quote|estimate|my|the|our|interior|exterior|house|home)',
    'pool\\s*(?:clean\\w*|service|maint\\w*)',
    'window\\s*(?:clean\\w*|wash\\w*)', 'carpet\\s*clean\\w*', 'duct\\s*clean\\w*',
    '\\bhvac\\b', 'air\\s*condition\\w*', 'plumb(?:ing|er)s?\\b',
    '\\belectricians?\\b', 'electrical\\s*(?:work|repair)',
    '\\bhandyman\\b', '\\bdrywall\\b', 'solar\\s*panel', 'seal\\s*coat\\w*',
    'christmas\\s*light', 'remodel\\w*',
  ].join('|'),
  'i',
);

// Nouns that positively indicate a pest/lawn request. When one of these is
// present alongside an out-of-scope phrase ("power wash the patio and spray
// for ants"), the message stays with the classifier — the veto only fires
// on texts that request an out-of-scope service and mention nothing Waves
// treats.
const IN_SCOPE_RE = new RegExp(
  '\\b(?:pest\\w*|bugs?|ants?|roach\\w*|termites?|mosquito\\w*|rodents?|rats?|mice'
  + '|fleas?|bed\\s*bugs?|wasps?|hornets?|bees?|spiders?|scorpions?|ticks?|snakes?'
  + '|lawn|grass|weeds?|fertiliz\\w*|shrubs?|trees?|palms?|wdo|exterminat\\w*)\\b',
  'i',
);

// Deterministic pre-LLM veto: the text asks for an out-of-scope home
// service and mentions nothing in Waves' domain. Cheap, zero-latency, and
// immune to the classifier's generosity.
function deterministicOutOfScope(text) {
  const t = String(text || '');
  return OUT_OF_SCOPE_RE.test(t) && !IN_SCOPE_RE.test(t);
}

// Street-address candidates from free text: a street number followed by up
// to four street-name words. The trailing words may overshoot into prose
// ("… 100 Sample Loop before Saturday"), so `variants` lists every prefix
// ("Sample", "Sample Loop", "Sample Loop before", …) — the DB prefix query
// uses the first word, and confirmation accepts a row when ANY variant
// matches the row's full normalized street (address-compare owns
// suffix/directional normalization).
function extractAddressCandidates(text) {
  const out = [];
  const re = /\b(\d{2,6})\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3})/g;
  let m;
  while (out.length < 3 && (m = re.exec(String(text || ''))) !== null) {
    const words = m[2].split(/\s+/);
    // Skip obvious non-addresses: "24 hours", "30 minutes", "2 pm".
    if (/^(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|am|pm)$/i.test(words[0])) continue;
    out.push({
      num: m[1],
      firstWord: words[0],
      variants: words.map((_, i) => `${m[1]} ${words.slice(0, i + 1).join(' ')}`),
    });
  }
  return out;
}

// A prefix-fetched row only counts as "this customer's property" when the
// message's street run truly matches the row's full normalized street —
// "100 Palm Ave" must not ground against a customer at "100 Palm St".
function candidateMatchesRow(candidate, rowAddressLine1) {
  return candidate.variants.some((v) => {
    try {
      return sameStreetAddress(v, rowAddressLine1);
    } catch (err) {
      return false;
    }
  });
}

async function loadTriageInner({ phone, triggerBody }) {
  const db = require('../../models/db');
  const lines = [];
  const seenCustomerIds = new Set();
  let matchedExistingCustomer = false;

  const describeCustomer = async (customer, how, addressLine) => {
    if (seenCustomerIds.has(customer.id)) return;
    seenCustomerIds.add(customer.id);
    matchedExistingCustomer = true;
    const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'existing customer';
    let visitNote = '';
    try {
      const visits = await db('scheduled_services')
        .where({ customer_id: customer.id })
        .whereNotIn('status', ['cancelled'])
        .whereRaw("scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '30 days'")
        .orderBy('scheduled_date', 'asc')
        .limit(3)
        .select('service_type', 'scheduled_date', 'status');
      if (visits.length) {
        visitNote = ` — booked: ${visits
          .map((v) => `${v.service_type} ${String(v.scheduled_date).slice(0, 10)} (${v.status})`)
          .join('; ')}`;
      }
    } catch (err) {
      logger.warn(`[estimator-scope] triage visit lookup failed: ${err.message}`);
    }
    lines.push(`${how}: existing active customer ${name}, ${addressLine || customer.address_line1 || 'address on file'}${visitNote}`);
  };

  if (phone) {
    const { loadCustomerByPhone } = require('./context-builder');
    const senderMatch = await loadCustomerByPhone(phone, null);
    // active === true is required, not merely "not false": the select may
    // omit the column, and an inactive/former customer texting a NEW quote
    // request must stay a prospect (no existing-job grounding).
    if (senderMatch?.customer && !senderMatch.ambiguous && senderMatch.customer.active === true) {
      await describeCustomer(senderMatch.customer, 'Sender phone matches');
    }
  }

  // Split-context threads: the address may sit in an earlier text of the
  // same conversation, not the quote-flavored one that triggered triage.
  let searchText = String(triggerBody || '');
  const digits = last10(phone);
  if (digits) {
    try {
      const priorTexts = await db('sms_log')
        .where({ direction: 'inbound' })
        .whereRaw("regexp_replace(coalesce(from_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
        .whereRaw(`created_at >= NOW() - INTERVAL '${THREAD_WINDOW_HOURS} hours'`)
        .orderBy('created_at', 'desc')
        .limit(THREAD_WINDOW_LIMIT)
        .select('message_body');
      searchText += `\n${priorTexts.map((t) => t.message_body || '').join('\n')}`;
    } catch (err) {
      logger.warn(`[estimator-scope] triage thread lookup failed: ${err.message}`);
    }
  }

  for (const cand of extractAddressCandidates(searchText)) {
    const label = `Message thread names address "${cand.num} ${cand.firstWord}…" which matches`;
    const prefix = `${cand.num} ${cand.firstWord}%`;
    const rows = await db('customers')
      .where({ active: true })
      .whereNull('deleted_at')
      .where('address_line1', 'ilike', prefix)
      .limit(5)
      .select('id', 'first_name', 'last_name', 'address_line1');
    for (const row of rows) {
      if (candidateMatchesRow(cand, row.address_line1)) {
        await describeCustomer(row, label, row.address_line1);
      }
    }
    // Secondary properties: customers.address_line1 mirrors only the
    // PRIMARY address — a coordinator texting about a customer's rental or
    // seasonal property matches customer_properties instead. try/catch its
    // own query: a schema surprise here must not sink the primary path.
    try {
      const propRows = await db('customer_properties as cp')
        .join('customers as c', 'c.id', 'cp.customer_id')
        .where('c.active', true)
        .whereNull('c.deleted_at')
        .where('cp.address_line1', 'ilike', prefix)
        .limit(5)
        .select('c.id', 'c.first_name', 'c.last_name', 'cp.address_line1 as property_address');
      for (const row of propRows) {
        if (candidateMatchesRow(cand, row.property_address)) {
          await describeCustomer(
            { id: row.id, first_name: row.first_name, last_name: row.last_name },
            label,
            `${row.property_address} (secondary property)`,
          );
        }
      }
    } catch (err) {
      logger.warn(`[estimator-scope] triage property lookup failed: ${err.message}`);
    }
  }

  return { lines, matchedExistingCustomer };
}

// Compact "what Waves knows" block for the triage classifier. Fail-open on
// error AND on the time budget: null → the caller uses the ungrounded
// prompt, exactly today's behavior.
async function loadThreadTriageContext({ phone, triggerBody }) {
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), TRIAGE_TIMEOUT_MS);
    });
    const result = await Promise.race([loadTriageInner({ phone, triggerBody }), timeout]);
    if (!result) logger.warn('[estimator-scope] triage context timed out (falling back ungrounded)');
    return result;
  } catch (err) {
    logger.warn(`[estimator-scope] triage context failed (falling back ungrounded): ${err.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  scopeGuardsEnabled,
  deterministicOutOfScope,
  extractAddressCandidates,
  loadThreadTriageContext,
  _private: {
    OUT_OF_SCOPE_RE, IN_SCOPE_RE, candidateMatchesRow, loadTriageInner, TRIAGE_TIMEOUT_MS,
  },
};
