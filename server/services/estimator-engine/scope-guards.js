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
const { sameStreetAddress, STREET_TOKEN_ALIASES } = require('./address-compare');
const { CUSTOMER_STAGES, whereLiveCustomer } = require('../customer-stages');

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
    // Trade nouns need request context too — "Joe Plumber" the person and
    // "Handyman Hardware" the store are not service requests.
    'hvac\\s+(?:service|repair|work|quote|install\\w*|maint\\w*|system|unit|tech)',
    'service\\s+(?:my|the|our)\\s+hvac', 'air\\s*conditioning\\s+(?:service|repair|work)',
    'plumbing\\s+(?:work|issue|problem|repair|leak|service|quote)',
    '(?:need|want|looking\\s+for|find|hire|recommend\\w*|get)\\s+an?\\s+(?:plumber|electrician|handyman)',
    'electrical\\s*(?:work|repair)',
    'handyman\\s+(?:service|work|job)s?',
    'drywall\\s+(?:repair|work|patch\\w*|install\\w*|job|quote)',
    'solar\\s*panel', 'seal\\s*coat\\w*',
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
  + '|lawn|grass|weeds?|fertiliz\\w*|shrubs?|trees?|palms?|wdo|exterminat\\w*'
  // Generic treatment phrasing counts as in-scope: a mixed request ("spray
  // my yard and pressure wash the driveway") must reach the grounded
  // classifier, never die in the deterministic veto.
  + '|spray\\w*|treat\\w*|infest\\w*|yard)\\b',
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
  const src = String(text || '');
  // House numbers may be a single digit ("7 Palm Ave") and street names may
  // be numbered ("123 5th Ave") — the full-street confirmation downstream is
  // the precision gate, so the grammar here stays broad.
  const re = /\b(\d{1,6})\s+([A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+[A-Za-z][A-Za-z0-9'.-]*){0,3})/g;
  let m;
  while (out.length < 3 && (m = re.exec(src)) !== null) {
    const words = m[2].split(/\s+/);
    // Skip obvious non-addresses: "24 hours", "30 minutes", "2 pm", and
    // bare number-pairs ("4 30") — numbered streets carry a suffix ("5th").
    if (/^(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|am|pm)$/i.test(words[0])) continue;
    if (/^\d+$/.test(words[0])) continue;
    // Explicit locality after the street run ("…, Bradenton FL 34205"):
    // captured only behind a comma (a bare following word is prose, not a
    // city) so a same-street customer in a DIFFERENT named city can be
    // rejected. Localities the message doesn't state stay unknown and
    // compare conservatively equal downstream.
    const tailSrc = src.slice(m.index + m[0].length, m.index + m[0].length + 45);
    const cityM = tailSrc.match(/^\s*,\s*([A-Za-z][A-Za-z .'-]{2,28}?)\s*(?:,|\bFL\b|\bFlorida\b|\d{5}|$)/i);
    const zipM = tailSrc.match(/\b(\d{5})\b/);
    const locality = (cityM || zipM)
      ? `, ${cityM ? cityM[1].trim() : ''} ${zipM ? zipM[1] : ''}`.trimEnd()
      : '';
    out.push({
      num: m[1],
      firstWord: words[0],
      locality,
      variants: words.map((_, i) => `${m[1]} ${words.slice(0, i + 1).join(' ')}`),
    });
  }
  return out;
}

// ILIKE prefixes for a candidate's first street word, expanded through the
// suffix/directional alias table — "100 N Palm" must fetch a row stored as
// "100 North Palm Avenue" (sameStreetAddress normalizes both at confirm
// time, but a prefix that never fetches the row never gets confirmed).
function prefixVariants(num, firstWord) {
  const lower = String(firstWord || '').toLowerCase();
  const words = new Set([firstWord]);
  if (STREET_TOKEN_ALIASES[lower]) words.add(STREET_TOKEN_ALIASES[lower]);
  for (const [long, short] of Object.entries(STREET_TOKEN_ALIASES)) {
    if (short === lower) words.add(long);
  }
  return [...words].map((w) => `${num} ${w}%`);
}

// A prefix-fetched row only counts as "this customer's property" when the
// message's street run truly matches the row's full normalized street —
// "100 Palm Ave" must not ground against a customer at "100 Palm St" — and,
// when the message states a locality, in the row's city/ZIP too. Compare
// both sides WITH their known localities: sameStreetAddress treats a
// missing city/ZIP as conservatively equal and a stated disagreement as a
// mismatch, which is exactly the wanted asymmetry.
function candidateMatchesRow(candidate, row) {
  const rowFull = [row.address_line1, [row.city, row.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return candidate.variants.some((v) => {
    try {
      return sameStreetAddress(`${v}${candidate.locality || ''}`, rowFull);
    } catch (err) {
      return false;
    }
  });
}

async function loadTriageInner({ phone, triggerBody }) {
  const db = require('../../models/db');
  const lines = [];
  // Dedup key is customer + scope: a sender-phone match is UNSCOPED, and an
  // address-specific match for the same customer must still add its own
  // scoped line — otherwise a multi-property customer texting about
  // property B would only ever ground with primary-address/every-property
  // context (the sender entry) and property scoping would be dead code.
  const seenMatches = new Set();
  let matchedExistingCustomer = false;

  // scope: when the match came from a specific address in the message,
  // visits are scoped to THAT property — a multi-property customer's booked
  // visit at property A must not present as coordination context for a new
  // quote at property B. Visits stamp service_address_line1 at booking time
  // (nullable; legacy rows COALESCE to the primary address), so a stamped
  // visit must street-match the matched address, and an unstamped one only
  // counts when the matched address IS the primary.
  const describeCustomer = async (customer, how, addressLine, scope = null) => {
    const matchKey = `${customer.id}|${scope ? scope.address : 'unscoped'}`;
    if (seenMatches.has(matchKey)) return;
    seenMatches.add(matchKey);
    matchedExistingCustomer = true;
    const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'existing customer';
    let visitNote = '';
    try {
      // "booked" means OPEN work only — completed/skipped/superseded rows
      // are history, not coordination context, and must not crowd out (or
      // stand in for) an upcoming visit.
      const visits = await db('scheduled_services')
        .where({ customer_id: customer.id })
        .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
        .whereRaw("scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '30 days'")
        .orderBy('scheduled_date', 'asc')
        .limit(6)
        .select('service_type', 'scheduled_date', 'status', 'service_address_line1');
      const scoped = !scope ? visits : visits.filter((v) => {
        if (v.service_address_line1) {
          try {
            return sameStreetAddress(v.service_address_line1, scope.address);
          } catch (err) {
            return false;
          }
        }
        return scope.isPrimary;
      });
      if (scoped.length) {
        visitNote = ` — booked: ${scoped.slice(0, 3)
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
    // Grounding requires a REAL customer: active === true (not merely "not
    // false" — the select may omit the column) AND an established customer
    // stage. The Twilio webhook creates an active pipeline_stage='new_lead'
    // customers row for first contacts right before this triage runs — a
    // prospect must never read as an existing customer here, or their own
    // quote request vetoes itself as an "existing job".
    if (senderMatch?.customer && !senderMatch.ambiguous
      && senderMatch.customer.active === true
      && CUSTOMER_STAGES.includes(senderMatch.customer.pipeline_stage)) {
      await describeCustomer(senderMatch.customer, 'Sender phone matches');
    }
  }

  // Split-context threads: the address — or the service being asked about
  // ("Do you do power washing?" … "How much?") — may sit in an earlier text
  // of the same conversation, not the quote-flavored one that triggered
  // triage. The recent bodies feed address extraction here AND ride back to
  // the caller (recentTexts) for the combined-thread scope veto and the
  // classifier prompt.
  let searchText = String(triggerBody || '');
  let recentTexts = [];
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
      recentTexts = priorTexts.map((t) => String(t.message_body || '')).filter(Boolean);
      searchText += `\n${recentTexts.join('\n')}`;
    } catch (err) {
      logger.warn(`[estimator-scope] triage thread lookup failed: ${err.message}`);
    }
  }

  for (const cand of extractAddressCandidates(searchText)) {
    const label = `Message thread names address "${cand.num} ${cand.firstWord}…" which matches`;
    const prefixes = prefixVariants(cand.num, cand.firstWord);
    const rows = await db('customers')
      .modify(whereLiveCustomer)
      .whereRaw('address_line1 ILIKE ANY(?)', [prefixes])
      .limit(5)
      .select('id', 'first_name', 'last_name', 'address_line1', 'city', 'zip');
    for (const row of rows) {
      if (candidateMatchesRow(cand, row)) {
        const shown = [row.address_line1, row.city].filter(Boolean).join(', ');
        await describeCustomer(row, label, shown, { address: row.address_line1, isPrimary: true });
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
        .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
        // Sold/deactivated properties are somebody else's address now — a
        // new occupant's quote must not ground against the old owner.
        .where('cp.active', true)
        .whereRaw('cp.address_line1 ILIKE ANY(?)', [prefixes])
        .limit(5)
        .select('c.id', 'c.first_name', 'c.last_name',
          'cp.address_line1 as address_line1', 'cp.city', 'cp.zip');
      for (const row of propRows) {
        if (candidateMatchesRow(cand, row)) {
          const shown = [row.address_line1, row.city].filter(Boolean).join(', ');
          await describeCustomer(
            { id: row.id, first_name: row.first_name, last_name: row.last_name },
            label,
            `${shown} (secondary property)`,
            { address: row.address_line1, isPrimary: false },
          );
        }
      }
    } catch (err) {
      logger.warn(`[estimator-scope] triage property lookup failed: ${err.message}`);
    }
  }

  return { lines, matchedExistingCustomer, recentTexts };
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
    OUT_OF_SCOPE_RE, IN_SCOPE_RE, candidateMatchesRow, loadTriageInner, TRIAGE_TIMEOUT_MS, prefixVariants,
  },
};
