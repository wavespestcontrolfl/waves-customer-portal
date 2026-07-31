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
// Canonical "not live coverage" status set (also excludes completed,
// no_show, skipped, and the phantom 'rescheduled' rows) — mirroring only
// 'cancelled' here would count dead rows as active recurring coverage.
const { TERMINAL_STATUSES } = require('../waveguard-existing-services');

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
// The HARD scope veto only trusts the current exchange — texts this recent.
// A power-washing mention from yesterday must not deterministically kill
// today's vague-but-valid "can I get that quote?"; stale context is the
// grounded classifier's judgment call, not the regex's.
const VETO_BURST_MINUTES = 90;

// Services Waves does NOT offer, phrased as service REQUESTS (noun +
// action/service context), not bare nouns — "Jane Painter" introducing
// herself or a "Roofers Rd" street name must never trip the veto.
// Deliberately conservative — anything ambiguous falls through to the
// grounded classifier instead.
const OUT_OF_SCOPE_RE = new RegExp(
  [
    'power\\s*wash\\w*', 'pressure\\s*wash\\w*', 'soft\\s*wash\\w*',
    // No bare 'roofing': org names ("Gulf Coast Roofing" asking for a pest
    // quote) must not trip the veto — roof terms need request context like
    // every other trade noun.
    'roof(?:ing)?\\s*(?:repair|replace\\w*|clean\\w*|leak|work|job|quote|estimate)',
    '(?:need|want|looking\\s+for|find|hire|get)\\s+(?:a\\s+)?(?:new\\s+)?roof\\b',
    'gutter\\s*(?:clean\\w*|repair\\w*|guard)', 'clean\\w*\\s+(?:my|the|our)\\s+gutters',
    'painting\\s+(?:quote|estimate|job|work|service)s?',
    '(?:need|want|looking\\s+for|get)\\s+(?:some\\s+)?painting\\b',
    'paint\\s+(?:job|work|quote|estimate|my|the|our|interior|exterior|house|home)',
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
  // Up to seven street words ("100 Dr Martin Luther King Jr Blvd") — the
  // full-street confirmation requires complete equality, so a truncated
  // capture would permanently miss long street names.
  // Numbered ROUTES ("123 US 41", "123 State Road 64", "6812 US Highway
  // 301") carry an all-numeric street token — accepted only right after a
  // route designator (lookbehind), so a neighboring address's house number
  // ("100 Palm Ave and 200 Oak St") or prose numbers are never swallowed
  // into the street run, and the bare-number-pair guard below ("4 30
  // tomorrow") keeps its job on the FIRST word.
  const re = /\b(\d{1,6})\s+([A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+(?:[A-Za-z][A-Za-z0-9'.-]*|(?<=\s(?:us|sr|cr|rte|rt|route|hwy|highway|road|rd)\s+)\d{1,4}\b)){0,6})/gi;
  let m;
  const UNIT_WORD_RE = /^(?:apt|apartment|unit|suite|ste|#)$/i;
  while (out.length < 3 && (m = re.exec(src)) !== null) {
    let words = m[2].split(/\s+/);
    // Skip obvious non-addresses: "24 hours", "30 minutes", "2 pm", and
    // bare number-pairs ("4 30") — numbered streets carry a suffix ("5th").
    if (/^(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|am|pm)$/i.test(words[0])) continue;
    if (/^\d+$/.test(words[0])) continue;
    // The street-word run may have swallowed a unit designator ("100 Palm
    // Ave Apt 6" → words [Palm, Ave, Apt]) — cut the street there and read
    // the unit id from the source after the designator.
    const designatorIdx = words.findIndex((w) => UNIT_WORD_RE.test(w));
    if (designatorIdx > 0) words = words.slice(0, designatorIdx);
    const afterStreet = src.slice(m.index + m[0].length, m.index + m[0].length + 60);
    // Unit forms: "Apt 6", "Unit B", "#6". The hash form is only trusted
    // right next to the street run — a "#" further into the prose (ticket
    // numbers, "order #12") is not this address's unit.
    const nearStreet = `${m[2]} ${afterStreet.slice(0, 15)}`;
    const unitM = nearStreet.match(/(?:\b(?:apt|apartment|unit|suite|ste)\.?\s*#?\s*|#\s*)([A-Za-z0-9-]{1,8})\b/i);
    // An explicitly-stated unit rides on EVERY variant: sameStreetAddress
    // treats a missing unit as conservatively equal, so a unit-less variant
    // of "Apt 6" would happily ground against the customer in Apt 1.
    const unitSuffix = unitM ? ` Apt ${unitM[1]}` : '';
    // Explicit locality after the street run — attached ONLY when anchored
    // AND validated: a comma-led city needs FL/Florida or a ZIP behind it
    // ("…, Bradenton FL" / "…, Venice 34285"), and a bare ZIP counts only
    // when it directly follows the street. Comma prose ("100 Palm Ave,
    // please") and unrelated numbers ("budget of 15000") must not become a
    // fake locality that rejects the real customer row. A unit expression
    // between street and locality ("Apt 6, Venice FL 34285") is stripped
    // first so the anchor still reaches the city/ZIP.
    let localitySrc = afterStreet;
    if (designatorIdx > 0) {
      // Designator was swallowed into the street words; afterStreet starts
      // with the bare unit VALUE.
      localitySrc = localitySrc.replace(/^\s*#?\s*[A-Za-z0-9-]{1,8}\b/, '');
    } else if (unitM) {
      localitySrc = localitySrc.replace(/^\s*,?\s*(?:(?:apt|apartment|unit|suite|ste)\.?|#)\s*#?\s*[A-Za-z0-9-]{1,8}\b/i, '');
    }
    const locM = localitySrc.match(/^\s*,\s*([A-Za-z][A-Za-z .'-]{2,28}?)\s*,?\s*(\bFL\b|\bFlorida\b)?\s*(\d{5})?\b/i);
    let locality = '';
    if (locM && (locM[2] || locM[3])) {
      locality = `, ${locM[1].trim()}${locM[3] ? ` ${locM[3]}` : ''}`;
    } else {
      // Bare-ZIP form requires the comma ("…, 34285") — with street runs up
      // to seven words, a zip-like number after uncomma'd prose ("with a
      // budget of 15000") must stay unbound; a missing locality still
      // compares conservatively equal downstream.
      const zipDirect = localitySrc.match(/^\s*,\s*(\d{5})\b/);
      if (zipDirect) locality = `, ${zipDirect[1]}`;
    }
    if (!locality) {
      // No-comma form ("100 Palm Ave Venice FL 34285"): the street run
      // swallows the city+FL, leaving the anchored matchers at a bare ZIP.
      // Bind the ZIP (locality-by-ZIP is enough to reject a same-street
      // row in another city) when the words carry an FL marker, or when
      // the last street word is a known suffix/directional — never after
      // swallowed prose ("with a budget of 15000" stays unbound).
      const zipNC = localitySrc.match(/^\s*(\d{5})\b/);
      if (zipNC) {
        const lastWord = String(words[words.length - 1] || '').toLowerCase();
        const hasFl = words.some((w) => /^(?:fl|florida)$/i.test(w));
        const suffixes = new Set([
          ...Object.keys(STREET_TOKEN_ALIASES), ...Object.values(STREET_TOKEN_ALIASES),
        ]);
        if (hasFl || suffixes.has(lastWord)) locality = `, ${zipNC[1]}`;
      }
    }
    out.push({
      num: m[1],
      firstWord: words[0],
      locality,
      variants: words.map((_, i) => `${m[1]} ${words.slice(0, i + 1).join(' ')}${unitSuffix}`),
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
  // address_line2 carries the row's unit — include it so an explicit
  // candidate unit ("Apt 6") is compared against the row's explicit unit
  // ("Apt 1") instead of matching conservatively on the bare street.
  const line1 = [row.address_line1, row.address_line2].filter(Boolean).join(' ');
  const rowFull = [line1, [row.city, row.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return candidate.variants.some((v) => {
    try {
      return sameStreetAddress(`${v}${candidate.locality || ''}`, rowFull);
    } catch (err) {
      return false;
    }
  });
}

async function loadTriageInner({ phone, triggerBody, deadline = Date.now() + TRIAGE_TIMEOUT_MS }) {
  const db = require('../../models/db');
  // Cooperative deadline: Promise.race in the wrapper bounds the RESPONSE,
  // this bounds the WORK — an expired budget stops issuing queries (and the
  // knex cancel-timeout aborts the in-flight one) instead of leaving an
  // abandoned query waterfall holding pool slots behind the webhook.
  const timeLeft = () => deadline - Date.now();
  const assertTime = () => {
    if (timeLeft() <= 50) {
      const err = new Error('triage_deadline');
      err.deadline = true;
      throw err;
    }
  };
  const bounded = (qb) => qb.timeout(Math.max(60, timeLeft()), { cancel: true });

  // COLLECT first, render after: an unscoped sender entry must not carry
  // visit evidence when the text also names a specific property — a booked
  // visit at property A listed on the sender line would still read as
  // existing-job evidence against a new quote at property B.
  const entries = [];
  const seenMatches = new Set();
  const addEntry = (customer, how, addressLine, scope = null) => {
    const matchKey = `${customer.id}|${scope ? scope.address : 'unscoped'}`;
    if (seenMatches.has(matchKey)) return;
    seenMatches.add(matchKey);
    entries.push({ customer, how, addressLine, scope });
  };

  if (phone) {
    assertTime();
    const { loadCustomerByPhone } = require('./context-builder');
    // Bounded like every other triage query, and matched against the
    // configured service-contact phone slots too — a spouse/tenant/manager
    // texting from an on-file contact number is an established identity.
    const senderMatch = await loadCustomerByPhone(phone, null, {
      timeoutMs: Math.max(60, timeLeft()),
      includeServiceContacts: true,
    });
    // Grounding requires a REAL customer: active === true (not merely "not
    // false" — the select may omit the column) AND an established customer
    // stage. The Twilio webhook creates an active pipeline_stage='new_lead'
    // customers row for first contacts right before this triage runs — a
    // prospect must never read as an existing customer here, or their own
    // quote request vetoes itself as an "existing job".
    if (senderMatch?.customer && !senderMatch.ambiguous
      && senderMatch.customer.active === true
      && CUSTOMER_STAGES.includes(senderMatch.customer.pipeline_stage)) {
      addEntry(senderMatch.customer, 'Sender phone matches');
    }
  }

  // Split-context threads: the address — or the service being asked about
  // ("Do you do power washing?" … "How much?") — may sit in an earlier text
  // of the same conversation, not the quote-flavored one that triggered
  // triage. The recent bodies feed address extraction here AND ride back to
  // the caller: recentTexts (full window) for the classifier prompt,
  // vetoTexts (current burst only) for the hard scope veto.
  let searchText = String(triggerBody || '');
  let recentTexts = [];
  let vetoTexts = [];
  const digits = last10(phone);
  if (digits) {
    try {
      assertTime();
      const priorTexts = await bounded(db('sms_log')
        .where({ direction: 'inbound' })
        .whereRaw("regexp_replace(coalesce(from_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
        .whereRaw(`created_at >= NOW() - INTERVAL '${THREAD_WINDOW_HOURS} hours'`)
        .orderBy('created_at', 'desc')
        .limit(THREAD_WINDOW_LIMIT))
        .select('message_body', 'created_at');
      recentTexts = priorTexts.map((t) => String(t.message_body || '')).filter(Boolean);
      const burstFloor = Date.now() - VETO_BURST_MINUTES * 60 * 1000;
      vetoTexts = priorTexts
        .filter((t) => t.created_at && new Date(t.created_at).getTime() >= burstFloor)
        .map((t) => String(t.message_body || ''))
        .filter(Boolean);
      searchText += `\n${recentTexts.join('\n')}`;
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage thread lookup failed: ${err.message}`);
    }
  }

  for (const cand of extractAddressCandidates(searchText)) {
    const label = `Message thread names address "${cand.num} ${cand.firstWord}…" which matches`;
    const prefixes = prefixVariants(cand.num, cand.firstWord);
    assertTime();
    const rows = await bounded(db('customers')
      .modify(whereLiveCustomer)
      .whereRaw('address_line1 ILIKE ANY(?)', [prefixes])
      // Wide sanity bound, NOT a display limit: confirmation
      // (candidateMatchesRow) still gates every row. A tight limit lets 5
      // same-street rows crowd out the named unit's row ("Apt 20" in a
      // complex) before confirmation ever sees it.
      .limit(25))
      .select('id', 'first_name', 'last_name', 'address_line1', 'address_line2', 'city', 'zip');
    for (const row of rows) {
      if (candidateMatchesRow(cand, row)) {
        const shown = [row.address_line1, row.city].filter(Boolean).join(', ');
        addEntry(row, label, shown, {
          address: row.address_line1, line2: row.address_line2, city: row.city, zip: row.zip, isPrimary: true,
        });
      }
    }
    // Secondary properties: customers.address_line1 mirrors only the
    // PRIMARY address — a coordinator texting about a customer's rental or
    // seasonal property matches customer_properties instead. try/catch its
    // own query: a schema surprise here must not sink the primary path.
    try {
      assertTime();
      const propRows = await bounded(db('customer_properties as cp')
        .join('customers as c', 'c.id', 'cp.customer_id')
        .where('c.active', true)
        .whereNull('c.deleted_at')
        .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
        // Sold/deactivated properties are somebody else's address now — a
        // new occupant's quote must not ground against the old owner.
        .where('cp.active', true)
        .whereRaw('cp.address_line1 ILIKE ANY(?)', [prefixes])
        // Same wide sanity bound as the customers query above — never a
        // display limit; confirmation gates.
        .limit(25))
        .select('c.id', 'c.first_name', 'c.last_name',
          'cp.address_line1 as address_line1', 'cp.address_line2 as address_line2', 'cp.city', 'cp.zip');
      for (const row of propRows) {
        if (candidateMatchesRow(cand, row)) {
          const shown = [row.address_line1, row.city].filter(Boolean).join(', ');
          addEntry(
            { id: row.id, first_name: row.first_name, last_name: row.last_name },
            label,
            `${shown} (secondary property)`,
            { address: row.address_line1, line2: row.address_line2, city: row.city, zip: row.zip, isPrimary: false },
          );
        }
      }
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage property lookup failed: ${err.message}`);
    }
  }

  // RENDER. Visits are scoped to the matched property using the FULL
  // booking stamp (line1+line2, city, zip) — Apt 1's visit is not evidence
  // about Apt 6, and the same street line in another city is a different
  // parcel. Unstamped legacy rows count only for primary-address matches.
  // An unscoped sender entry whose customer also has an address-scoped
  // entry carries NO visit list — the scoped line owns the booked-work
  // evidence for the property the text is actually about.
  const lines = [];
  const scopedIds = new Set(entries.filter((e) => e.scope).map((e) => e.customer.id));
  const stampFull = (line1, line2, city, zip) => [
    [line1, line2].filter(Boolean).join(' '),
    [city, zip].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  // Active recurring coverage — live rows only (TERMINAL_STATUSES is the
  // canonical exclusion from waveguard-existing-services; 'cancelled' alone
  // would count completed/skipped/phantom-rescheduled rows as coverage).
  // Coverage is PER ENTRY, not per customer: an address-scoped entry only
  // carries coverage stamped at THAT property (unstamped legacy rows count
  // only for the primary-address match, same rule as the visit path) — a
  // multi-property customer's plan at home must not read as coverage for
  // their rental. Unscoped (sender) entries keep customer-wide coverage, so
  // the cache keys by customerId + scope stamp.
  const coverageCache = new Map();
  const recurringCoverage = async (customerId, scope = null) => {
    const scopeFull = scope ? stampFull(scope.address, scope.line2, scope.city, scope.zip) : null;
    const cacheKey = `${customerId}|${scopeFull || 'unscoped'}`;
    if (coverageCache.has(cacheKey)) return coverageCache.get(cacheKey);
    let note = '';
    try {
      assertTime();
      const rows = await bounded(db('scheduled_services')
        .where({ customer_id: customerId, is_recurring: true })
        .whereNotIn('status', TERMINAL_STATUSES)
        .limit(20))
        .distinct('service_type',
          'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip');
      const scoped = !scope ? rows : rows.filter((r) => {
        if (r.service_address_line1) {
          try {
            return sameStreetAddress(
              stampFull(r.service_address_line1, r.service_address_line2, r.service_address_city, r.service_address_zip),
              scopeFull,
            );
          } catch (err) {
            return false;
          }
        }
        return scope.isPrimary;
      });
      const types = [...new Set(scoped.map((r) => r.service_type).filter(Boolean))];
      if (types.length) {
        note = `; recurring services on file: ${types.slice(0, 5).join(', ')}`;
      }
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage coverage lookup failed: ${err.message}`);
    }
    coverageCache.set(cacheKey, note);
    return note;
  };
  for (const e of entries) {
    const name = `${e.customer.first_name || ''} ${e.customer.last_name || ''}`.trim() || 'existing customer';
    const shownAddress = e.addressLine || e.customer.address_line1 || 'address on file';
    const coverage = await recurringCoverage(e.customer.id, e.scope);
    if (!e.scope && scopedIds.has(e.customer.id)) {
      lines.push(`${e.how}: existing active customer ${name}, ${shownAddress}${coverage} (booked work listed under the matched property below)`);
      continue;
    }
    let visitNote = '';
    try {
      assertTime();
      // "booked" means OPEN work only — completed/skipped/superseded rows
      // are history, not coordination context.
      const visits = await bounded(db('scheduled_services')
        .where({ customer_id: e.customer.id })
        .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
        .whereRaw("scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '30 days'")
        .orderBy('scheduled_date', 'asc')
        // Wide sanity bound, NOT a display limit: the address-scope filter
        // runs in JS below, and a tight SQL limit would let property A's
        // visits crowd the matched property's visit out of the fetch.
        .limit(25))
        .select('service_type', 'scheduled_date', 'status',
          'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip');
      const scopeFull = e.scope
        ? stampFull(e.scope.address, e.scope.line2, e.scope.city, e.scope.zip)
        : null;
      const scoped = !e.scope ? visits : visits.filter((v) => {
        if (v.service_address_line1) {
          try {
            return sameStreetAddress(
              stampFull(v.service_address_line1, v.service_address_line2, v.service_address_city, v.service_address_zip),
              scopeFull,
            );
          } catch (err) {
            return false;
          }
        }
        return e.scope.isPrimary;
      });
      if (scoped.length) {
        visitNote = ` — booked: ${scoped.slice(0, 3)
          .map((v) => `${v.service_type} ${String(v.scheduled_date).slice(0, 10)} (${v.status})`)
          .join('; ')}`;
      }
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage visit lookup failed: ${err.message}`);
    }
    lines.push(`${e.how}: existing active customer ${name}, ${shownAddress}${coverage}${visitNote}`);
  }

  return { lines, matchedExistingCustomer: entries.length > 0, recentTexts, vetoTexts };
}

// Compact "what Waves knows" block for the triage classifier. Fail-open on
// error AND on the time budget: null → the caller uses the ungrounded
// prompt, exactly today's behavior. The deadline is shared with the inner
// loader so expiry stops the WORK, not just the response.
async function loadThreadTriageContext({ phone, triggerBody }) {
  let timer = null;
  try {
    const deadline = Date.now() + TRIAGE_TIMEOUT_MS;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), TRIAGE_TIMEOUT_MS);
    });
    const result = await Promise.race([loadTriageInner({ phone, triggerBody, deadline }), timeout]);
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
