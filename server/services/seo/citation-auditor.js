/**
 * Directory-listing (citation) auditor.
 *
 * For every seo_citations row with a `listing_url`, fetch that page (read-only
 * GET, nothing is submitted, no login, no claim, no edit) and compare the
 * name / phone / address it shows against the right NAP from
 * config/locations.js: the row's `location_id` office; an unassigned (brand)
 * listing may show ANY of the four offices — Waves has four — and
 * status_detail.office records which one matched.
 *
 * States (seo_citations.status, CHECK-constrained by migration
 * 20260929200000_seo_citations_audit_states):
 *   unverified     no listing URL recorded, or never checked
 *   verified       fetched; name and phone match, plus the address when the
 *                  page shows one
 *   mismatched     fetched; a field differs — status_detail.mismatches lists
 *                  each { field, expected, seen }
 *   fetch-blocked  the page could not be read: 403/429/5xx or any non-2xx,
 *                  captcha/bot challenge, timeout or network error, empty or
 *                  JS-only body, non-HTML body, or no NAP found in the text.
 *                  A blocked fetch NEVER means "missing" — Yelp, Angi and
 *                  Nextdoor routinely block bots and land here.
 *   missing        recorded by a human via updateCitation ("no listing
 *                  exists"). Only a human sets it; the audit never writes it
 *                  and never re-checks a row a human marked missing.
 *
 * Fetching reuses contact-finder's SSRF-hardened fetchPage (private/loopback
 * addresses refused and DNS-pinned to the real socket, every redirect hop
 * re-validated, timeout, 600 KB body cap) — no second fetcher. `directory_url`
 * is the directory's homepage, never our listing, so it is never audited.
 *
 * Scheduling: weekly cron in services/scheduler.js (Mon 4:20 AM ET), run
 * exclusively. Kill switch: GATE_CITATION_AUDIT=false (default on; the audit is
 * read-only GETs of public pages, sequential, one per row). Staff record each
 * listing's URL and office in the SEO admin Citations editor (updateCitation).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { WAVES_LOCATIONS } = require('../../config/locations');
const { _internals: contactFinder } = require('./contact-finder');
const { classifyPageBody } = require('./page-body-classifier');
const { visibleText } = require('../content/content-registry-live-status');

const STATES = ['unverified', 'verified', 'mismatched', 'fetch-blocked', 'missing'];
const BRAND_NAME = 'Waves Pest Control'; // locations.js carries office names only, not the brand name
const MIN_VISIBLE_CHARS = 200; // below this the body is a JS shell / empty page
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 12000;

const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_CITATION_UPDATE' });
const phoneKey = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const napOf = (loc) => ({ locationId: loc.id, name: BRAND_NAME, phone: loc.phone, phoneKey: phoneKey(loc.phone), address: loc.address });
// The office a row is assigned to, else the default office (WAVES_LOCATIONS[0]) — the dashboard's reference NAP.
function expectedNapFor(row) {
  return napOf(WAVES_LOCATIONS.find((l) => l.id === row.location_id) || WAVES_LOCATIONS[0]);
}
// What a listing may legitimately show: its assigned office, or any office when unassigned.
function candidatesFor(row) {
  const assigned = WAVES_LOCATIONS.find((l) => l.id === row.location_id);
  return (assigned ? [assigned] : WAVES_LOCATIONS).map(napOf);
}

// "13649 Luxe Ave #110, Bradenton" -> matches "13649 Luxe Ave", "13649 Luxe Avenue Ste 5",
// "1978 S Tamiami Trl" (leading directional skipped) — number + first street word.
function streetRegex(address) {
  const m = String(address || '').match(/^\s*(\d+)\s+(?:[nsew]\.?\s+)?([a-z0-9]+)/i);
  return m ? new RegExp(`\\b${m[1]}\\s+(?:[nsew]\\.?\\s+)?${m[2]}\\b`, 'i') : null;
}

const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4})/g;
const fmtPhone = (k) => `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}`;

// schema.org LocalBusiness-style nodes from JSON-LD (directories publish these).
function jsonLdBusinesses(html) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.telephone || node.address) out.push(node);
    if (node['@graph']) visit(node['@graph']);
    if (node.mainEntity) visit(node.mainEntity);
  };
  for (const m of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1])); } catch { /* malformed block: ignore */ }
  }
  return out;
}

function streetOf(address) {
  if (!address) return null;
  if (typeof address === 'string') return address;
  return [address.streetAddress, address.addressLocality, address.postalCode].filter(Boolean).join(', ') || null;
}

function extractNap(html) {
  const text = visibleText(html);
  const ld = jsonLdBusinesses(html);
  const phones = new Set();
  for (const m of text.matchAll(PHONE_RE)) if (phoneKey(m[0]).length === 10) phones.add(phoneKey(m[0]));
  for (const m of String(html).matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const k = phoneKey(decodeURIComponent(m[1])); if (k.length === 10) phones.add(k);
  }
  for (const n of ld) for (const p of [].concat(n.telephone || [])) { const k = phoneKey(p); if (k.length === 10) phones.add(k); }
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const ldName = (ld.find((n) => n.name) || {}).name || null;
  const ldAddress = streetOf((ld.find((n) => n.address) || {}).address);
  return { text, phones: [...phones], title: title.replace(/\s+/g, ' ').trim(), ldName, ldAddress };
}

// Address: judged only when the page shows one. A structured (JSON-LD) address that
// lacks our street is a mismatch; otherwise our street either appears in the text
// (checked) or the page shows no address we can read (not checked).
function judgeAddress(nap, expected) {
  const streetRe = streetRegex(expected.address);
  const inText = streetRe ? streetRe.test(nap.text) : false;
  if (inText || !nap.ldAddress || !streetRe) return { inText, checked: inText, mismatch: null };
  const mismatch = streetRe.test(nap.ldAddress) ? null : { field: 'address', expected: expected.address, seen: nap.ldAddress };
  return { inText: false, checked: true, mismatch };
}

/**
 * Pure classifier: a fetched page -> { status, nap_*, detail }. `page` is
 * contact-finder's fetchPage result; `candidates` are the NAPs it may match
 * (candidatesFor). Nothing here reaches the network.
 */
function classifyListing(page, candidates) {
  const blocked = (reason, extra = {}) => ({ status: 'fetch-blocked', nap: null, detail: { reason, http_status: page.status || null, ...extra } });
  if (page.blocked) return blocked('blocked_host');
  if (page.error) return blocked(page.error);
  if (page.status < 200 || page.status >= 300) return blocked(`http_${page.status}`);
  const html = page.html || '';
  const kind = classifyPageBody(html, page.contentType, { strictChallenge: true });
  if (kind === 'challenge') return blocked('challenge');
  if (kind === 'non_html') return blocked('non_html');
  const nap = extractNap(html);
  if (nap.text.length < MIN_VISIBLE_CHARS) return blocked('empty_or_js_only');

  // With several candidate offices, judge against the one whose phone the page shows
  // (else the first, the default office).
  const expected = candidates.find((c) => nap.phones.includes(c.phoneKey)) || candidates[0];
  const namePresent = alnum(`${nap.text} ${nap.title} ${nap.ldName || ''}`).includes(alnum(expected.name));
  if (!namePresent && !nap.phones.length) return blocked('no_nap_found');

  const mismatches = [];
  if (!namePresent) mismatches.push({ field: 'name', expected: expected.name, seen: nap.ldName || nap.title || null });
  const phoneOk = nap.phones.includes(expected.phoneKey);
  if (nap.phones.length && !phoneOk) mismatches.push({ field: 'phone', expected: candidates.map((c) => c.phone).join(' or '), seen: nap.phones.slice(0, 3).map(fmtPhone) });

  const address = judgeAddress(nap, expected);
  if (address.mismatch) mismatches.push(address.mismatch);

  const observed = {
    nap_name: namePresent ? expected.name : nap.ldName,
    nap_phone: phoneOk ? expected.phone : (nap.phones[0] ? fmtPhone(nap.phones[0]) : null),
    nap_address: address.inText ? expected.address : nap.ldAddress,
  };
  const base = { http_status: page.status, final_url: page.finalUrl, office: expected.locationId, address_checked: address.checked };

  if (mismatches.length) {
    // A cut-off body cannot prove a field differs — same rule as the backlink verifier.
    if (page.truncated) return blocked('truncated');
    return { status: 'mismatched', nap: observed, detail: { ...base, mismatches } };
  }
  if (!phoneOk) return blocked('phone_not_found', { final_url: page.finalUrl }); // name shown, phone not readable
  return { status: 'verified', nap: observed, detail: base };
}

async function checkRow(row, seams = {}) {
  if (!row.listing_url) return { status: 'unverified', nap: null, detail: { reason: 'no_listing_url' } };
  const page = await contactFinder.fetchPage(row.listing_url, { ...seams, timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS });
  return classifyListing(page, candidatesFor(row));
}

function statusCounts(rows) {
  return Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.status === s).length]));
}

class CitationAuditor {
  // `seams` ({ fetchFn, resolveHostFn }) exist for tests; production uses fetchPage's defaults.
  async audit(seams = {}) {
    logger.info('Citation audit running...');
    const rows = await db('seo_citations').whereNot('status', 'missing');
    for (const row of rows) {
      let res;
      try {
        res = await checkRow(row, seams);
      } catch (err) {
        res = { status: 'fetch-blocked', nap: null, detail: { reason: `audit_error: ${err.message}` } };
      }
      await db('seo_citations').where('id', row.id).update({
        status: res.status,
        status_detail: JSON.stringify(res.detail),
        nap_name: res.nap ? res.nap.nap_name : null,
        nap_phone: res.nap ? res.nap.nap_phone : null,
        nap_address: res.nap ? res.nap.nap_address : null,
        nap_consistent: res.status === 'verified' ? true : res.status === 'mismatched' ? false : null,
        last_checked: etDateString(),
        updated_at: new Date(),
      });
      row.status = res.status;
    }
    const counts = statusCounts(rows);
    logger.info(`Citation audit: ${JSON.stringify(counts)} (${rows.length} checked)`);
    return { total: rows.length, ...counts };
  }

  async getDashboard() {
    const citations = await db('seo_citations').orderBy('priority', 'asc').orderBy('directory_name');
    return {
      total: citations.length,
      byStatus: statusCounts(citations),
      byPriority: {
        high: citations.filter(c => c.priority === 'high').length,
        medium: citations.filter(c => c.priority === 'medium').length,
        low: citations.filter(c => c.priority === 'low').length,
      },
      citations,
      canonicalNAP: expectedNapFor({}),
      locations: WAVES_LOCATIONS.map(({ id, name, phone, address }) => ({ id, name, phone, address })),
    };
  }

  // Human edits only. `status` may be set to 'missing' (no listing exists) or reset
  // to 'unverified'; verified / mismatched / fetch-blocked come from audit() alone.
  // Changing the listing URL or office resets the row so the next audit re-checks it.
  async updateCitation(citationId, updates = {}) {
    const patch = {};
    for (const k of ['listing_url', 'location_id', 'priority']) if (k in updates) patch[k] = String(updates[k] ?? '').trim() || null;
    if (patch.location_id && !WAVES_LOCATIONS.some((l) => l.id === patch.location_id)) throw invalid(`Unknown location_id: ${patch.location_id}`);
    if (patch.listing_url && !/^https?:\/\/\S+$/i.test(patch.listing_url)) throw invalid('listing_url must be an http(s) URL');
    if ('priority' in patch && !['high', 'medium', 'low'].includes(patch.priority)) throw invalid('priority must be high, medium or low');
    if (updates.status !== undefined) {
      if (!['missing', 'unverified'].includes(updates.status)) throw invalid("status can only be set to 'missing' or 'unverified'; the audit sets the rest");
      patch.status = updates.status;
    } else if ('listing_url' in patch || 'location_id' in patch) {
      patch.status = 'unverified';
    }
    if (patch.status) Object.assign(patch, { status_detail: null, nap_consistent: null });
    await db('seo_citations').where('id', citationId).update({ ...patch, updated_at: new Date() });
  }
}

module.exports = new CitationAuditor();
module.exports.statusCounts = statusCounts; // shared with backlink-monitor's dashboard
module.exports._internals = { classifyListing, candidatesFor, expectedNapFor, extractNap, STATES };
