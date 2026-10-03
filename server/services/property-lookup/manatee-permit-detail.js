'use strict';

/**
 * Manatee permit detail collector (address-match round 2, PR R2-A).
 *
 * Why: a brand-new home is missing from the county roll for months, but its
 * building permit's public ACA record page already lists the plan's
 * Total Square Footage (Under Roof), Square Footage (Conditioned), Number of
 * Stories, Bedrooms and Bathrooms (conditioned sq ft tracked the roll's
 * living area within 0-3% on 11 of 12 spot checks). The weekly report sync
 * (manatee-permit-sync.js) tells us WHICH permits are new dwellings; this
 * step reads their record pages, slowly, into construction_permit_records.
 * COLLECTION ONLY: nothing reads the facts for a lookup or a price yet
 * (findPermitBuildingFacts is the read helper the lookup will call later).
 *
 * Fetch flow (live-probed 2026-10-02; ACA is ASP.NET WebForms, anonymous, no
 * captcha, ~6-14 s per permit):
 *   1. GET  Cap/CapHome.aspx?module=Building → session cookie + hidden inputs.
 *   2. POST the same URL with the permit number in the general-search field and
 *      __EVENTTARGET=btnNewSearch → a one-row hit redirects to the record page;
 *      otherwise a results list of CapDetail.aspx links. A permit that has had
 *      a plan revision lists the revision record (".RR01") first, and its page
 *      has no square footage, so the links are tried in order until one page
 *      carries the fields.
 *   3. Each record page keeps its fields as label/value span pairs
 *      (ACA_SmLabelBolder then ACA_SmLabel). A label is matched by prefix, so
 *      a trailing colon or the form's help text does not matter, and a label
 *      whose value is blank never borrows the NEXT label's value.
 * ONLY the five building fields are read; contractor contact, owner and
 * every other field on the page are never parsed or stored.
 *
 * Politeness: strictly sequential, at least MIN_GAP between ANY two requests
 * (floor 2 s), a per-run permit cap and a wall-clock budget. Runs from the
 * weekly cron only, never from a customer lookup. Fail open: a parse or HTTP
 * failure is recorded as the permit's detail_status and the run moves on;
 * STOP_AFTER consecutive no_fields (the page structure changed) or errors (ACA
 * is down) end the run with one warning.
 *
 * Gate: GATE_PERMIT_DETAIL_SYNC (permitDetailSyncLive), checked inside
 * syncPermitDetails. Logs are prefixed `[permit-detail-sync]`; permit numbers,
 * addresses and parcel ids never appear in logs (AGENTS.md PII rule), only
 * counts and elapsed time.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { permitDetailSyncLive } = require('../../config/feature-gates');
const {
  _private: { fetchWithSession, positiveIntEnv, TransientAcaError },
} = require('./manatee-permit-sync');

const CAP_BASE = 'https://aca-prod.accela.com/MANATEE/Cap/';
const CAP_HOME_URL = `${CAP_BASE}CapHome.aspx?module=Building&TabName=Building`;
const SEARCH_FIELD = process.env.MANATEE_PERMIT_DETAIL_SEARCH_FIELD
  || 'ctl00$PlaceHolderMain$generalSearchForm$txtGSPermitNumber';
const SEARCH_TARGET = process.env.MANATEE_PERMIT_DETAIL_SEARCH_TARGET
  || 'ctl00$PlaceHolderMain$btnNewSearch';

// type_of_work vocabulary of the "Permits Issued" report (trimmed, compared
// lower-case). The three the lane named; the report also carries New Villa
// and New Duplex (a few hundred) whose pages are unverified, so they stay out
// until a spot check shows the same fields.
const NEW_DWELLING_TYPES = ['new single family', 'new townhouse', 'new townhouse/duplex'];

const DEFAULT_CAP = 400;
const DEFAULT_BUDGET_MS = 60 * 60 * 1000;
const DEFAULT_MIN_GAP_MS = 2500;
const MIN_GAP_FLOOR_MS = 2000;
const DEFAULT_TIMEOUT_MS = 60000;
const EMPTY_SEARCH_RE = /your search returned no results/i;
const MAX_LINKS_PER_PERMIT = 12; // revisions can sort ahead of the base record; every hop is throttled and budgeted
const STOP_AFTER = 5;
// Retry windows for permits whose last attempt did not produce facts.
const RETRY_DAYS = { error: 1, not_found: 14, no_fields: 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

const cap = () => positiveIntEnv('PERMIT_DETAIL_SYNC_CAP', DEFAULT_CAP);
const budgetMs = () => positiveIntEnv('PERMIT_DETAIL_SYNC_BUDGET_MS', DEFAULT_BUDGET_MS);
const minGapMs = () => Math.max(MIN_GAP_FLOOR_MS, positiveIntEnv('PERMIT_DETAIL_SYNC_MIN_GAP_MS', DEFAULT_MIN_GAP_MS));
const timeoutMs = () => positiveIntEnv('PERMIT_DETAIL_SYNC_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

// ── HTML parsing (pure) ──

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const spanText = (inner) => decodeEntities(String(inner).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Every hidden input on an ASP.NET page as {name: value}. */
function hiddenInputs(html) {
  const out = {};
  for (const m of String(html || '').matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\btype\s*=\s*["']?hidden["']?/i.test(tag)) continue;
    const name = tag.match(/\bname\s*=\s*"([^"]*)"/i) || tag.match(/\bname\s*=\s*'([^']*)'/i);
    if (!name) continue;
    const value = tag.match(/\bvalue\s*=\s*"([^"]*)"/i) || tag.match(/\bvalue\s*=\s*'([^']*)'/i);
    out[decodeEntities(name[1])] = value ? decodeEntities(value[1]) : '';
  }
  return out;
}

/** Distinct CapDetail.aspx links of a search-results page, in page order. */
function detailLinks(html) {
  const seen = new Set();
  for (const m of String(html || '').matchAll(/CapDetail\.aspx[^"'<>\s]*/gi)) seen.add(decodeEntities(m[0]));
  return [...seen];
}

/**
 * Label/value pairs of a record page: a label span (class ACA_SmLabelBolder)
 * pairs with the value span (class ACA_SmLabel) that follows it before the
 * next label. A label with no value span of its own pairs with nothing.
 * Labels are lower-cased, whitespace-collapsed text.
 */
function labelValuePairs(html) {
  const pairs = [];
  let pending = null;
  const spanRe = /<span\b[^>]*?\bclass\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/span>/gi;
  for (const m of String(html || '').matchAll(spanRe)) {
    const classes = m[2];
    if (/\bACA_SmLabelBolder\b/.test(classes)) {
      pending = spanText(m[3]).toLowerCase();
    } else if (/\bACA_SmLabel\b/.test(classes) && pending !== null) {
      pairs.push([pending, spanText(m[3])]);
      pending = null;
    }
  }
  return pairs;
}

function parseCount(raw, { min, max, decimals = false }) {
  const s = String(raw ?? '').replace(/[,\s]/g, '');
  if (!(decimals ? /^\d+(\.\d+)?$/ : /^\d+$/).test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Label prefixes, lower-case. Prefix match: the trailing colon (or none) and
// the form's help text after the name are ignored.
const FIELD_LABELS = [
  ['under_roof_sqft', 'total square footage (under roof)', { min: 200, max: 60000, decimals: true }],
  ['conditioned_sqft', 'square footage (conditioned)', { min: 200, max: 60000, decimals: true }],
  ['stories', 'number of stories', { min: 1, max: 10, decimals: true }],
  ['bedrooms', 'number of bedrooms', { min: 0, max: 20 }],
  ['bathrooms', 'number of bathrooms', { min: 0.5, max: 20, decimals: true }],
];

/**
 * The five building facts of a record page. Always returns all five keys
 * (null when absent or implausible); the first occurrence of a label wins.
 */
function parseDetailFacts(html) {
  const pairs = labelValuePairs(html);
  const facts = {};
  for (const [key, prefix, rules] of FIELD_LABELS) {
    const hit = pairs.find(([label]) => label.startsWith(prefix));
    let n = hit ? parseCount(hit[1], rules) : null;
    if (n !== null && (key === 'under_roof_sqft' || key === 'conditioned_sqft')) n = Math.round(n);
    facts[key] = n;
  }
  return facts;
}

/** The record page names this permit (exact number, or its ".RR01" revision). */
function pageNamesPermit(html, permitNo) {
  const text = decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '));
  const escaped = String(permitNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(text);
}

// ── Politeness ──

/**
 * run(fn): waits until at least minGap has passed since the previous request
 * FINISHED, then runs fn. One throttle per run, shared by every request.
 */
// The run's wall-clock budget is enforced HERE, before every request (not
// only between permits): one permit can be a dozen hops, each with its own
// timeout, and the cron lease is held throughout. Past the deadline the hop
// is never sent (BudgetExhausted → a budget stop, not a permit error); a
// sent hop gets the remaining budget as its ceiling.
class BudgetExhausted extends Error {}
function createThrottle({ gapMs, sleep, now, deadline = Infinity }) {
  let last = null;
  return async function run(fn) {
    if (last !== null) {
      const wait = gapMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new BudgetExhausted('permit detail run budget spent');
    try {
      return await fn(remainingMs);
    } finally {
      last = now();
    }
  };
}

// ── One permit ──

/**
 * One permit number → { status, facts }. status is ok | no_fields |
 * not_found; a transport failure throws (the run records it as `error`).
 */
// Every HTTP hop goes through the throttle — redirects included: the
// one-hit search answers with a redirect to the record page, and following
// it inside fetch would send a second request with no gap. Session cookies
// carry across hops (fetchWithSession appends them).
const MAX_REDIRECTS = 5;
async function politeFetch(polite, url, opts) {
  let target = url;
  let request = opts;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const out = await polite((remainingMs) => fetchWithSession(target, {
      ...request, timeoutMs: Math.min(request.timeoutMs, remainingMs), redirect: 'manual',
    }));
    const location = out.res.status >= 300 && out.res.status < 400 ? out.res.headers.get('location') : null;
    if (!location) return out;
    // Release the redirect response before the next hop: an unread body can
    // hold its socket open past the throttle's "one request at a time".
    await out.res.body?.cancel?.().catch(() => {});
    target = new URL(location, target).toString();
    request = { ...opts, body: undefined, step: `${opts.step} redirect` };
  }
  throw new TransientAcaError(`${opts.step} redirected more than ${MAX_REDIRECTS} times`);
}

async function fetchPermitDetail(permitNo, { polite, timeout = timeoutMs() }) {
  const cookies = [];
  const referer = CAP_HOME_URL;
  const { text: home } = await politeFetch(polite, CAP_HOME_URL, { cookies, timeoutMs: timeout, referer, step: 'permit search form' });
  // A 200 that is not the search form (maintenance / login page, or a
  // rebuilt form) must not be posted and read as "no such permit": that
  // would stamp a whole batch not_found for 14 days. Missing the view state
  // or the permit-number input is a transport-level failure (error, counted
  // toward the outage stop).
  const hidden = hiddenInputs(home);
  if (!hidden.__VIEWSTATE || !String(home || '').includes(`name="${SEARCH_FIELD}"`)) {
    throw new TransientAcaError('permit search form missing its view state or permit-number field');
  }
  const form = new URLSearchParams({
    ...hidden,
    [SEARCH_FIELD]: permitNo,
    __EVENTTARGET: SEARCH_TARGET,
    __EVENTARGUMENT: '',
  });
  const { text: results } = await politeFetch(polite, CAP_HOME_URL, { cookies, body: form.toString(), timeoutMs: timeout, referer, step: 'permit search' });

  // A record page that names this permit but lacks the fields is no_fields;
  // a search that reaches no record page at all is not_found.
  let sawRecord = false;
  const judge = (html, isRecordPage) => {
    if (!pageNamesPermit(html, permitNo)) return null;
    if (isRecordPage) sawRecord = true;
    const facts = parseDetailFacts(html);
    // Any of the five facts makes a read (the columns and the read helper
    // take partial facts); only a page with none is no_fields.
    return Object.values(facts).some((v) => v !== null) ? facts : null;
  };

  // A page with the conditioned square footage is the record we want and
  // ends the read. A page with only some facts (a revision record can carry
  // a few) is kept as the best so far while the remaining links are tried.
  let best = null;
  const factCount = (facts) => Object.values(facts).filter((v) => v !== null).length;
  // `over` wins field by field; its nulls are filled from `under`.
  const fill = (over, under) => Object.fromEntries(Object.keys(over).map((k) => [k, over[k] ?? under?.[k] ?? null]));
  const settle = (facts) => {
    if (!facts) return false;
    if (facts.conditioned_sqft !== null) {
      // The record with the conditioned sq ft always wins, whatever a
      // partial page before it carried; that page only fills its gaps.
      best = fill(facts, best);
      return true;
    }
    best = !best || factCount(facts) > factCount(best) ? fill(facts, best) : fill(best, facts);
    return false;
  };

  // A single hit redirects straight to the record page (no results list).
  const links = detailLinks(results);
  if (settle(judge(results, links.length === 0 && labelValuePairs(results).length > 0))) return { status: 'ok', facts: best };

  for (const link of links.slice(0, MAX_LINKS_PER_PERMIT)) {
    const { text: page } = await politeFetch(polite, `${CAP_BASE}${link}`, { cookies, timeoutMs: timeout, referer: CAP_HOME_URL, step: 'permit record' });
    if (settle(judge(page, true))) return { status: 'ok', facts: best };
    // A linked page that is not a record page at all (maintenance / login
    // reply to the GET) is an outage, not evidence the permit is absent. A
    // real record page for ANOTHER permit (shared number prefix) is fine.
    if (labelValuePairs(page).length === 0) {
      throw new TransientAcaError('permit record link returned a page that is not a record');
    }
  }
  if (best) return { status: 'ok', facts: best };
  if (sawRecord) return { status: 'no_fields', facts: null };
  // not_found only on the county's own empty-search notice (live 10-03:
  // "Your search returned no results."). Any other link-less response — a
  // validation or login page from a changed form — is a transport error,
  // never 14 days of not_found.
  if (!links.length && !EMPTY_SEARCH_RE.test(results || '')) {
    throw new TransientAcaError('permit search returned an unrecognized page');
  }
  return { status: 'not_found', facts: null };
}

// ── Candidates + write ──

/**
 * Permits to read this run, capped. A candidate is a new dwelling (not
 * canceled / withdrawn) whose last attempt left it unread:
 *   - never tried (newest issued first: the newest homes are the ones the
 *     county roll lacks), or
 *   - a CO date the last fetch did not see (plan swaps ride revisions, so the
 *     page can change at CO) — first in line, they are few, or
 *   - a failed attempt past its retry window (error 1 d, not_found 14 d,
 *     no_fields 30 d).
 * An ok permit with no new CO is never re-read.
 */
async function selectCandidates(limit, nowMs) {
  const cutoff = (days) => new Date(nowMs - days * DAY_MS);
  return db('construction_permit_records')
    .whereRaw('LOWER(TRIM(type_of_work)) = ANY(?)', [NEW_DWELLING_TYPES])
    .whereRaw("LOWER(COALESCE(status, '')) NOT IN ('canceled', 'withdrawn')")
    .where((b) => {
      b.whereNull('detail_status')
        // CO re-read: once per new CO date; a re-read that failed (fetched
        // after the CO, facts kept) waits out the error backoff.
        .orWhere((c) => c.whereNotNull('co_date').whereRaw('detail_co_date IS DISTINCT FROM co_date')
          .where((d) => d.whereNull('detail_fetched_at')
            .orWhereRaw('detail_fetched_at::date <= co_date')
            .orWhere('detail_fetched_at', '<', cutoff(RETRY_DAYS.error))))
        .orWhere((c) => c.where('detail_status', 'error').where('detail_fetched_at', '<', cutoff(RETRY_DAYS.error)))
        .orWhere((c) => c.where('detail_status', 'not_found').where('detail_fetched_at', '<', cutoff(RETRY_DAYS.not_found)))
        .orWhere((c) => c.where('detail_status', 'no_fields').where('detail_fetched_at', '<', cutoff(RETRY_DAYS.no_fields)));
    })
    // First CO re-reads, then never-read permits, then everything that
    // already failed — including a CO re-read that failed before (fetched
    // after its CO), so a stubborn page can never starve new work or trip
    // the outage stop at the head of every run.
    .orderByRaw(`CASE
      WHEN detail_status = 'ok' AND (detail_fetched_at IS NULL OR detail_fetched_at::date <= co_date) THEN 0
      WHEN detail_status IS NULL THEN 1
      ELSE 2 END`)
    .orderByRaw('issued_date DESC NULLS LAST')
    .orderBy('permit_no')
    .limit(limit)
    .select('permit_no', 'co_date', 'detail_status');
}

const toDateOnly = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

async function recordResult(candidate, status, facts, fetchedAt) {
  // A refetch that fails must not hide the facts an earlier fetch stored —
  // but it is recorded (fetched_at only), so the row backs off and sorts
  // behind fresh work instead of heading every run.
  if (candidate.detail_status === 'ok' && status !== 'ok') {
    await db('construction_permit_records').where({ permit_no: candidate.permit_no }).update({ detail_fetched_at: fetchedAt });
    return;
  }
  await db('construction_permit_records')
    .where({ permit_no: candidate.permit_no })
    .update({
      detail_status: status,
      detail_fetched_at: fetchedAt,
      detail_co_date: toDateOnly(candidate.co_date),
      conditioned_sqft: facts?.conditioned_sqft ?? null,
      under_roof_sqft: facts?.under_roof_sqft ?? null,
      stories: facts?.stories ?? null,
      bedrooms: facts?.bedrooms ?? null,
      bathrooms: facts?.bathrooms ?? null,
    });
}

/** Fold one permit's status into the run counts and streaks; the stop reason, if any. */
function countResult(out, streaks, status) {
  if (status === 'ok') {
    out.ok += 1; streaks.noFields = 0; streaks.errors = 0;
  } else if (status === 'no_fields') {
    out.noFields += 1; streaks.noFields += 1; streaks.errors = 0;
  } else if (status === 'not_found') {
    out.notFound += 1; streaks.noFields = 0; streaks.errors = 0;
  } else {
    out.errors += 1; streaks.errors += 1; streaks.noFields = 0;
  }
  if (streaks.noFields >= STOP_AFTER) return 'structure';
  return streaks.errors >= STOP_AFTER ? 'outage' : null;
}

const STOP_LOG = {
  structure: '[permit-detail-sync] stopped: consecutive pages without the building fields (page structure changed?)',
  outage: '[permit-detail-sync] stopped: consecutive request failures',
};

/**
 * Weekly cron step (scheduler), run after the report sync. Gated inside
 * (single source of truth): a disabled gate returns {skipped:'gated'} before
 * any network or DB read. Sequential; fail-open per permit.
 */
async function syncPermitDetails({ sleep, now } = {}) {
  if (!permitDetailSyncLive()) return { skipped: 'gated' };
  const clock = now || Date.now;
  const nap = sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const t0 = clock();
  const limit = cap();
  const budget = budgetMs();
  const polite = createThrottle({ gapMs: minGapMs(), sleep: nap, now: clock, deadline: t0 + budget });

  const candidates = await selectCandidates(limit, t0);
  const out = { candidates: candidates.length, attempted: 0, ok: 0, noFields: 0, notFound: 0, errors: 0, writeFailures: 0, stopped: null };
  const streaks = { noFields: 0, errors: 0 };

  for (const candidate of candidates) {
    if (clock() - t0 >= budget) { out.stopped = 'budget'; break; }
    out.attempted += 1;
    let result;
    try {
      result = await fetchPermitDetail(candidate.permit_no, { polite });
    } catch (err) {
      // Budget spent mid-permit: nothing is recorded for it (it stays a
      // candidate) and the run stops as a budget stop.
      if (err instanceof BudgetExhausted) { out.attempted -= 1; out.stopped = 'budget'; break; }
      // Any transport or parse failure: the permit is recorded as `error` and the run moves on.
      result = { status: 'error', facts: null };
    }
    try {
      await recordResult(candidate, result.status, result.facts, new Date(clock()));
    } catch (err) {
      // The code only: a raw database error can echo row values.
      logger.warn('[permit-detail-sync] write failed', { code: err?.code || err?.name || 'db_error' });
      result = { status: 'error' };
      out.writeFailures += 1;
    }
    out.stopped = countResult(out, streaks, result.status);
    if (out.stopped) break;
  }
  if (!out.stopped && candidates.length >= limit) out.stopped = 'cap';

  out.elapsedMs = clock() - t0;
  const stopLog = STOP_LOG[out.stopped];
  if (stopLog) logger.warn(stopLog, out);
  else logger.info('[permit-detail-sync] run complete', out);
  // Results that could not be stored are a failed run for job health (the
  // scheduler's lease records the throw); counts only, never row values.
  if (out.writeFailures) throw new Error(`permit detail sync: ${out.writeFailures} result write(s) failed`);
  return out;
}

// ── Read helper (not called by the lookup yet) ──

const toIso = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Building facts of the newest permit with a successful detail read, or null.
 * Mirrors findSyncedPoolPermit / findConstructionActivity matching: STRICT
 * precedence parcel PIN then loose address key (never an OR — a neighbor's
 * newer permit sharing the loose key must not outrank the parcel's own), and
 * with a known parcel the loose-key tier ignores rows asserting a DIFFERENT
 * clean parcel (the loose key drops street suffixes). A canceled / withdrawn
 * permit is not a building. Must stay cheap and fail-open (callers swallow
 * throws).
 */
async function findPermitBuildingFacts({ parcelPin, looseKey } = {}) {
  const tiers = [
    parcelPin ? ['parcel_pin', String(parcelPin)] : null,
    looseKey ? ['address_loose_key', looseKey] : null,
  ].filter(Boolean);
  let row = null;
  for (const [col, val] of tiers) {
    const query = db('construction_permit_records')
      .where(col, val)
      .where('detail_status', 'ok')
      .whereRaw("LOWER(COALESCE(status, '')) NOT IN ('canceled', 'withdrawn')")
      .orderByRaw('issued_date DESC NULLS LAST')
      .orderBy('detail_fetched_at', 'desc')
      .first();
    if (col !== 'parcel_pin' && parcelPin) {
      query.where((b) => b.whereNull('parcel_pin')
        .orWhere('parcel_pin', String(parcelPin))
        .orWhereRaw("parcel_pin !~ '^[0-9]{10}$'"));
    }
    row = await query;
    if (row) break;
  }
  if (!row) return null;
  return {
    source: 'manatee_permit_detail',
    permitNo: row.permit_no,
    typeOfWork: row.type_of_work || null,
    issuedAt: toIso(row.issued_date),
    coIssuedAt: toIso(row.co_date),
    fetchedAt: toIso(row.detail_fetched_at),
    conditionedSqft: numOrNull(row.conditioned_sqft),
    underRoofSqft: numOrNull(row.under_roof_sqft),
    stories: numOrNull(row.stories),
    bedrooms: numOrNull(row.bedrooms),
    bathrooms: numOrNull(row.bathrooms),
  };
}

module.exports = {
  syncPermitDetails,
  findPermitBuildingFacts,
  _private: {
    parseDetailFacts,
    labelValuePairs,
    hiddenInputs,
    detailLinks,
    pageNamesPermit,
    createThrottle,
    fetchPermitDetail,
    selectCandidates,
    recordResult,
    NEW_DWELLING_TYPES,
    STOP_AFTER,
    RETRY_DAYS,
  },
};
