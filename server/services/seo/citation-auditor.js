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
 * 20260929230000_seo_citations_audit_states):
 *   unverified     no listing URL recorded, or never checked; also a page that
 *                  was fetched but whose shown address could not be confirmed
 *                  (status_detail.reason = 'address_unconfirmed' — directory
 *                  pages often show OTHER businesses' addresses, so this is
 *                  never "mismatched" unless JSON-LD states our own address)
 *   verified       fetched; name and phone match, plus the address when the
 *                  page shows one. Conservative: a false "unverified" is fine, a
 *                  false "verified" is not. Visible text confirms an address ONLY
 *                  when it contains the office's whole normalized address
 *                  ("<number> <street> <suffix> [directional] <city> fl <zip5>",
 *                  unit dropped, contiguous, on word boundaries); any other
 *                  address-like text is 'address_unconfirmed'. A page with no
 *                  address-like string is judged on name + phone.
 *                  Precedence: when the page's JSON-LD has a Waves entity (its
 *                  name, or one of our office phones; never another node), that
 *                  entity IS the listing's NAP — each field it states is judged
 *                  on its own (street must EQUAL the office street; a stated
 *                  locality, region and postal code must equal the office's) and
 *                  page text can never erase a mismatch there; only fields it
 *                  leaves unstated are read from the text.
 *                  Only a Waves entity's STATED phone can prove a phone mismatch:
 *                  a phone in visible text is not listing evidence, so ours
 *                  confirms it and its absence is unverified /
 *                  'phone_unconfirmed' (no phone anywhere is fetch-blocked /
 *                  'phone_not_found'). Several Waves entities: the one matching
 *                  the expected office (phone, then street, then city) is
 *                  judged. A short page with a Waves entity that states a phone
 *                  is judged on the entity, not called JS-only.
 *                  Stored nap_name / nap_phone / nap_address are always what the
 *                  page showed, never the office's canonical values.
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
 * Scheduling: weekly cron in services/scheduler.js (Mon 4:47 AM ET), run
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
const { decodeHTML } = require('entities');
const { visibleText, notFoundHeading } = require('../content/content-registry-live-status');

const STATES = ['unverified', 'verified', 'mismatched', 'fetch-blocked', 'missing'];
const BRAND_NAME = 'Waves Pest Control'; // locations.js carries office names only, not the brand name
const MIN_VISIBLE_CHARS = 200; // below this the body is a JS shell / empty page
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 12000;

// http(s) with a real host; a malformed URL (https://%) is rejected, not persisted.
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
  } catch { return false; }
}
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_CITATION_UPDATE' });
const phoneKey = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const STREET_WORDS = {
  st: 'street', ave: 'avenue', rd: 'road', blvd: 'boulevard', dr: 'drive', ln: 'lane', ct: 'court', cir: 'circle',
  pl: 'place', trl: 'trail', hwy: 'highway', pkwy: 'parkway', n: 'north', s: 'south', e: 'east', w: 'west',
  florida: 'fl',
};
// The ONE address normalizer (expected addresses, visible text and JSON-LD all go through it):
// lowercase, drop unit designators and their value, strip punctuation, expand suffixes and
// directionals, "florida" -> "fl", collapse spaces.
function normalizeStreet(str) {
  return String(str || '').toLowerCase()
    .replace(/\b(?:suite|ste|unit|apt|apartment|bldg|building)\b\.?\s*(?:#\s*)?[a-z0-9-]+/g, ' ') // "Suite #110" is ONE designator; one whitespace run, so no backtracking blowup
    .replace(/#\s*[a-z0-9-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(Boolean).map((w) => STREET_WORDS[w] || w).join(' ');
}

const SUFFIX_WORDS = new Set(['street', 'avenue', 'road', 'boulevard', 'drive', 'lane', 'court', 'circle', 'place', 'way', 'trail', 'highway', 'parkway']);
const DIRECTIONAL_WORDS = new Set(['north', 'south', 'east', 'west']);
const endsStreet = (tokens) => {
  const last = tokens[tokens.length - 1];
  return SUFFIX_WORDS.has(last) || (DIRECTIONAL_WORDS.has(last) && SUFFIX_WORDS.has(tokens[tokens.length - 2]));
};

// The ONE address parser ("13649 Luxe Ave #110, Bradenton, FL 34211" -> street / city / region /
// postal, each normalized). Used for the office addresses in locations.js and any string address.
// Commas and newlines are optional separators: when the text before the first comma ends at a
// street suffix (plus optional directional) it IS the street; otherwise ("13649 Luxe Ave #110
// Bradenton FL 34211") a trailing "<state> <zip5>[-4]" is peeled off and the street is cut from the
// city after the LAST street suffix (plus a directional when a city still follows it). A city
// whose name itself begins with a directional ("North Port") right after a suffix is read as
// part of the street: that errs to a mismatch/unverified, never a false verify.
function parseAddress(str) {
  const parts = String(str || '').split(/[,\n]/);
  const firstStreet = normalizeStreet(parts[0]).split(' ').filter(Boolean);
  const peel = (tokens) => {
    if (tokens.length > 1 && /^\d{4}$/.test(tokens[tokens.length - 1]) && /^\d{5}$/.test(tokens[tokens.length - 2])) tokens.pop(); // ZIP+4
    const postal = /^\d{5}$/.test(tokens[tokens.length - 1] || '') ? tokens.pop() : null;
    const region = /^[a-z]{2}$/.test(tokens[tokens.length - 1] || '') ? tokens.pop() : null;
    return { postal, region };
  };
  if (parts.length > 1 && endsStreet(firstStreet)) {
    const tail = normalizeStreet(parts.slice(1).join(' ')).split(' ').filter(Boolean);
    const { postal, region } = peel(tail);
    return { street: firstStreet.join(' '), city: tail.join(' ') || null, region, postal };
  }
  const tokens = normalizeStreet(str).split(' ').filter(Boolean);
  const { postal, region } = peel(tokens);
  let end = -1;
  for (let i = tokens.length - 1; i >= 1; i--) if (SUFFIX_WORDS.has(tokens[i])) { end = i; break; }
  if (end < 0) return { street: normalizeStreet(parts[0]), city: normalizeStreet(parts.slice(1).join(' ')) || null, region, postal };
  if (DIRECTIONAL_WORDS.has(tokens[end + 1]) && tokens.length > end + 2) end += 1;
  return { street: tokens.slice(0, end + 1).join(' '), city: tokens.slice(end + 1).join(' ') || null, region, postal };
}
const streetOfAddress = (address) => parseAddress(address).street;

// An office's accepted cities come from locations.js only: the postal city parsed from its
// address, plus its display name (the bradenton office is "Lakewood Ranch"; for the others the
// name equals the city, so it adds nothing).
const officeOf = (loc) => {
  const a = parseAddress(loc.address);
  const labels = [String(loc.address).split(',')[1]?.trim(), loc.name].filter(Boolean);
  const cities = [...new Set([a.city, normalizeStreet(loc.name)].filter(Boolean))];
  return {
    locationId: loc.id, name: BRAND_NAME, phone: loc.phone, phoneKey: phoneKey(loc.phone), address: loc.address, ...a,
    cities, cityLabel: labels.filter((l, i) => cities.includes(normalizeStreet(l)) && labels.findIndex((x) => normalizeStreet(x) === normalizeStreet(l)) === i).join(' or '),
    fulls: cities.map((city) => [a.street, city, a.region, a.postal].join(' ')),
  };
};
// The office a row is assigned to, else the default office (WAVES_LOCATIONS[0]) — the dashboard's reference NAP.
function expectedNapFor(row) {
  return officeOf(WAVES_LOCATIONS.find((l) => l.id === row.location_id) || WAVES_LOCATIONS[0]);
}
// What a listing may legitimately show: its assigned office, or any office when unassigned.
function candidatesFor(row) {
  const assigned = WAVES_LOCATIONS.find((l) => l.id === row.location_id);
  return (assigned ? [assigned] : WAVES_LOCATIONS).map(officeOf);
}
const hasSequence = (normalizedText, sequence) => Boolean(sequence) && ` ${normalizedText} `.includes(` ${sequence} `);

const BRAND_RE = /waves\s+pest\s+control/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4})/g;
const fmtPhone = (k) => `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}`;

// Expanded JSON-LD wraps values as {"@value": ...} (possibly inside arrays, addresses and their
// fields). Unwrap them all BEFORE any field is read, so a name, telephone or street given that
// way is judged as its value, not as "[object Object]".
function unwrapLd(v) {
  if (Array.isArray(v)) return v.map(unwrapLd);
  if (v && typeof v === 'object') {
    if ('@value' in v) return unwrapLd(v['@value']);
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, unwrapLd(val)]));
  }
  return v;
}

// Every named/phoned/addressed schema.org node in the page's JSON-LD (arrays, @graph, mainEntity).
function jsonLdNodes(html) {
  const out = [];
  const visit = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    if (Array.isArray(raw)) return raw.forEach(visit);
    const node = unwrapLd(raw);
    if (!node || typeof node !== 'object') return; // a bare {"@value": ...} is not an entity
    if (node.name || node.telephone || node.address) out.push(node);
    if (node['@graph']) visit(node['@graph']);
    if (node.mainEntity) visit(node.mainEntity);
  };
  for (const m of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1])); } catch { /* malformed block: ignore */ }
  }
  return out;
}

const OFFICE_PHONE_KEYS = new Set(WAVES_LOCATIONS.map((l) => phoneKey(l.phone)));
const isWavesNode = (n) => alnum(n.name).includes(alnum(BRAND_NAME))
  || [].concat(n.telephone || []).some((p) => OFFICE_PHONE_KEYS.has(phoneKey(p)));

// ONLY entities that are Waves (their name says so, or their phone is one of our four offices)
// are evidence; a directory's own Organization or another business's node never is. A page can
// carry several (a parent Organization plus a branch LocalBusiness): pick the one that matches
// the expected office(s) — phone first, then street, then city; with nothing matching, the first
// address-bearing one is judged (a stated mismatch). Name, phone and address come from that one node.
function wavesEntity(html, candidates = []) {
  const mine = jsonLdNodes(html).filter(isWavesNode);
  const score = (node) => {
    const phones = [].concat(node.telephone ?? []).map(phoneKey);
    const addr = node.address ? (addressStrings(node.address, candidates) || {}).parsed || null : null;
    const best = candidates.reduce((max, c) => Math.max(max,
      (phones.includes(c.phoneKey) ? 100 : 0) + (addr && addr.street === c.street ? 10 : 0) + (addr && addr.city && c.cities.includes(addr.city) ? 1 : 0)), 0);
    return best + (node.address ? 0.5 : 0);
  };
  return mine.reduce((top, n) => (top === null || score(n) > score(top) ? n : top), null);
}

// An `address` given as an array lists several: judge the entry matching the expected office(s)
// (street, then city — the node-selection scoring), else the first.
function pickAddress(entries, candidates) {
  let best = null;
  let bestScore = -1;
  for (const entry of entries) {
    const parsed = addressStrings(entry).parsed;
    const score = candidates.reduce((max, c) => Math.max(max, (parsed.street === c.street ? 10 : 0) + (parsed.city && c.cities.includes(parsed.city) ? 1 : 0)), 0);
    if (score > bestScore) { best = entry; bestScore = score; }
  }
  return best;
}

// A JSON-LD address (object or string) as { parsed, raw, display }: `parsed` is normalized for
// comparison (postal = first 5 digits); `raw` and `display` are the values AS GIVEN.
function addressStrings(address, candidates = []) {
  if (Array.isArray(address)) address = pickAddress(address.filter(Boolean), candidates);
  if (!address) return null;
  if (typeof address === 'string') {
    const parsed = parseAddress(address);
    return { parsed, raw: { street: address.split(/[,\n]/)[0].trim(), city: parsed.city, region: parsed.region, postal: parsed.postal }, display: address };
  }
  const raw = { street: address.streetAddress || null, city: address.addressLocality || null, region: address.addressRegion || null, postal: address.postalCode || null };
  const parsed = {
    street: normalizeStreet(raw.street) || null,
    city: normalizeStreet(raw.city) || null,
    region: normalizeStreet(raw.region) || null,
    postal: (String(raw.postal || '').match(/\d{5}/) || [null])[0],
  };
  const display = [raw.street, raw.city, [raw.region, raw.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  return { parsed, raw, display };
}

// A JSON-LD text value as stated (value objects are already unwrapped): a string, or an array of
// them; any other object is kept as its JSON so it is still judged (and fails) rather than read
// as unstated.
function statedText(v) {
  const one = Array.isArray(v) ? v.filter((x) => x != null && String(x).trim() !== '').join(' ') : v;
  if (one == null || (typeof one !== 'object' && String(one).trim() === '')) return null;
  return typeof one === 'object' ? JSON.stringify(one) : String(one).trim();
}

const decodeHtmlText = (str) => decodeHTML(String(str || '')).replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
// A malformed percent-encoding (href="tel:%") must not fail the whole page: fall back to the raw value.
function safeDecodeURI(value) {
  try { return decodeURIComponent(value); } catch { return String(value); }
}

// What the page says. `entity` is the Waves JSON-LD entity's own stated fields (null when the
// page has none); `textPhones` is every phone in the visible text and tel: links.
function extractNap(html, candidates = []) {
  // Entities (&nbsp;, &amp;, numeric) are decoded before name, phone and address are read.
  const text = decodeHtmlText(visibleText(html));
  const textPhones = new Set();
  for (const m of text.matchAll(PHONE_RE)) if (phoneKey(m[0]).length === 10) textPhones.add(phoneKey(m[0]));
  for (const m of String(html).matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const k = phoneKey(safeDecodeURI(m[1])); if (k.length === 10) textPhones.add(k);
  }
  const title = decodeHtmlText((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const node = wavesEntity(html, candidates);
  // "Stated" is tracked apart from "parsed": a field the entity gives but we cannot read is a
  // stated field that fails, never an unstated one that page text may fill in.
  const rawPhones = [].concat(node ? node.telephone ?? [] : []).map((p) => String(p).trim()).filter(Boolean);
  const entity = node && {
    name: statedText(node.name),
    rawPhones,
    phones: rawPhones.map(phoneKey).filter((k) => k.length === 10),
    address: addressStrings(node.address, candidates),
  };
  return { text, textPhones: [...textPhones], title: title.replace(/\s+/g, ' ').trim(), entity };
}

// Street-address-like strings in visible text: number + street name + a common suffix.
const STREET_SUFFIX = 'St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Cir|Circle|Pl|Place|Way|Trl|Trail|Hwy|Highway|Pkwy|Parkway';
// Any US state + ZIP on the page means an address is shown, whatever its street looks like
// ("99 Palm Terrace, Atlanta, GA 30303"): a USPS state code (or Florida) followed by a ZIP. Only
// real codes count, so "PO 12345" or "NO 12345" is not an address. Any case right after a comma
// ("Atlanta, ga 30303"). Without a comma, upper or title case ("GA 30303", "Ga 30303"), except
// codes that are also words or ID labels ("Order ID 12345", "Hi 12345"): those need a comma or
// a house number shortly before ("99 Palm Terrace Boise ID 83702").
const US_STATE_CODES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const ZIP_TAIL = '\\.?,?\\s+\\d{5}(?:-\\d{4})?\\b';
const AMBIGUOUS_STATE_CODES = new Set(['ID', 'IN', 'OR', 'OK', 'ME', 'HI', 'OH', 'AL', 'LA', 'MS', 'CO', 'DE', 'PA']);
const BARE_STATE_CODES = US_STATE_CODES.split('|').filter((c) => !AMBIGUOUS_STATE_CODES.has(c));
const BARE_STATE_ALTS = [...BARE_STATE_CODES, ...BARE_STATE_CODES.map((c) => c[0] + c[1].toLowerCase())].join('|');
const STATE_ZIP_RE = new RegExp(`\\b(?:${BARE_STATE_ALTS}|[Ff][Ll]|[Ff]lorida|FLORIDA)${ZIP_TAIL}`);
const AMBIGUOUS_ALTS = [...AMBIGUOUS_STATE_CODES].flatMap((c) => [c, c[0] + c[1].toLowerCase()]).join('|');
// Within 120 characters, not a word count, so long street and city names still count.
const NUMBERED_STATE_ZIP_RE = new RegExp(`(?<![\\w-])\\d{1,6}\\s[^;!?]{1,120}?\\s(?:${AMBIGUOUS_ALTS})${ZIP_TAIL}`);
const COMMA_STATE_ZIP_RE = new RegExp(`,\\s*\\b(?:${US_STATE_CODES}|Florida)${ZIP_TAIL}`, 'i');
const ADDRESS_LIKE_RE = new RegExp(`(?<![\\w-])\\d{1,6}\\s+(?:[A-Za-z0-9.'-]+\\s+){1,4}?(?:${STREET_SUFFIX})\\b\\.?(?:\\s+(?:North|South|East|West|N|S|E|W)\\b\\.?)?`, 'gi');

// Address, conservative: a false "unverified" is fine, a false "verified" is not.
// A Waves entity's stated address IS the listing's address: its street must EQUAL the office's
// normalized street (not a substring), and any locality / postal code / region it states must
// equal the office's; each stated field that differs is its own mismatch and page text cannot
// change that. Without a stated street, the visible text confirms only when it contains the
// office's whole normalized address ("<number> <street> <suffix> [directional] <city> fl <zip5>"; the city may be the postal city or the office's display name)
// contiguously on word boundaries. Other address-like strings leave it unconfirmed (a sidebar
// may list other businesses, so never a mismatch); none at all means the page shows no address.
// `observed` is always what the page said, never the office's canonical address.
const isStated = (v) => v != null && String(v).trim() !== ''; // stated, even if it did not parse

// The Waves entity's stated address: each stated part must match the office. null when it states
// no street and no mismatching part, so the visible text is consulted instead.
function judgeEntityAddress({ parsed, raw, display }, office) {
  const parts = [
    { field: 'address', raw: raw.street, ok: parsed.street === office.street, expected: office.address, seen: display },
    { field: 'city', raw: raw.city, ok: office.cities.includes(parsed.city), expected: office.cityLabel, seen: raw.city },
    { field: 'postal_code', raw: raw.postal, ok: parsed.postal === office.postal, expected: office.postal, seen: raw.postal },
    { field: 'region', raw: raw.region, ok: parsed.region === office.region, expected: 'FL', seen: raw.region },
  ];
  const mismatches = parts.filter((p) => isStated(p.raw) && !p.ok).map(({ field, expected, seen }) => ({ field, expected, seen }));
  if (mismatches.length) return { confirmed: false, checked: true, mismatches, unconfirmed: null, observed: display };
  if (isStated(raw.street)) return { confirmed: true, checked: true, mismatches, unconfirmed: null, observed: display };
  return null;
}

// Visible text confirms only when it holds the office's whole normalized address. Otherwise an
// address shown anywhere (street-like string, or any state + ZIP) leaves it unconfirmed.
function judgeTextAddress(nap, office, entityAddress) {
  const seen = nap.text.match(ADDRESS_LIKE_RE) || [];
  const normalizedText = normalizeStreet(nap.text);
  if (office.fulls.some((full) => hasSequence(normalizedText, full))) {
    const ours = seen.find((m) => normalizeStreet(m) === office.street) || seen[0] || null;
    return { confirmed: true, checked: true, mismatches: [], unconfirmed: null, observed: ours };
  }
  const zip = STATE_ZIP_RE.exec(nap.text) || COMMA_STATE_ZIP_RE.exec(nap.text) || NUMBERED_STATE_ZIP_RE.exec(nap.text);
  const first = seen[0] ? seen[0].trim() : (zip ? nap.text.slice(Math.max(0, zip.index - 60), zip.index + zip[0].length).trim() : null);
  return { confirmed: false, checked: false, mismatches: [], unconfirmed: first, observed: (entityAddress && entityAddress.display) || first };
}

function judgeAddress(nap, office) {
  const a = nap.entity && nap.entity.address;
  return (a && judgeEntityAddress(a, office)) || judgeTextAddress(nap, office, a);
}

// Name and phone. ONE precedence rule: a field the Waves JSON-LD entity states IS the listing's
// value for it and page text never overrides it; only a field the entity leaves unstated is read
// from the visible text. Only the ENTITY's stated phone can prove a phone mismatch: a phone in
// the visible text (support line, ad, sidebar) is not listing evidence, so ours confirms and its
// absence leaves the phone unconfirmed. With several candidate offices, judge against the one
// whose phone matched (else the first, the default office).
function judgeIdentity(nap, candidates) {
  const { entity } = nap;
  const phoneStated = Boolean(entity && entity.rawPhones.length);
  const phonePool = phoneStated ? entity.phones : nap.textPhones;
  const expected = candidates.find((c) => phonePool.includes(c.phoneKey)) || candidates[0];
  const nameText = entity && entity.name ? entity.name : `${nap.text} ${nap.title}`;
  const namePresent = alnum(nameText).includes(alnum(expected.name));
  const ourPhoneInText = nap.textPhones.some((k) => candidates.some((c) => c.phoneKey === k));
  const phoneOk = phonePool.includes(expected.phoneKey);
  const expectedPhones = candidates.map((c) => c.phone).join(' or ');
  const mismatches = [];
  if (!namePresent) mismatches.push({ field: 'name', expected: expected.name, seen: (entity && entity.name) || nap.title || null });
  if (phoneStated && !phoneOk) mismatches.push({ field: 'phone', expected: expectedPhones, seen: entity.phones.length ? entity.phones.slice(0, 3).map(fmtPhone) : entity.rawPhones.slice(0, 3) });
  return { expected, phoneStated, phoneOk, mismatches, noNap: !namePresent && !phoneStated && !ourPhoneInText };
}

// Stored values are what the page showed, never the office's canonical values.
function observedNap(nap, who, address) {
  const { entity } = nap;
  let phone = null;
  if (who.phoneStated) phone = entity.phones.length ? fmtPhone(who.phoneOk ? who.expected.phoneKey : entity.phones[0]) : entity.rawPhones[0];
  else if (who.phoneOk) phone = fmtPhone(who.expected.phoneKey);
  return { nap_name: (entity && entity.name) || (nap.text.match(BRAND_RE) || [null])[0], nap_phone: phone, nap_address: address.observed };
}

// Why a fetched page cannot be judged at all (null = readable): a non-2xx, a bot challenge, a
// non-HTML body, or a branded soft-404. None of these is ever "missing".
function unreadableReason(page) {
  if (page.blocked) return 'blocked_host';
  if (page.error) return page.error;
  if (page.status < 200 || page.status >= 300) return `http_${page.status}`;
  const kind = classifyPageBody(page.html || '', page.contentType, { strictChallenge: true });
  if (kind === 'challenge') return 'challenge';
  if (kind === 'non_html') return 'non_html';
  return notFoundHeading(page.html || '') ? 'soft_404' : null;
}

/**
 * Pure classifier: a fetched page -> { status, nap_*, detail }. `page` is
 * contact-finder's fetchPage result; `candidates` are the NAPs it may match
 * (candidatesFor). Nothing here reaches the network.
 */
function classifyListing(page, candidates) {
  const blocked = (reason, extra = {}) => ({ status: 'fetch-blocked', nap: null, detail: { reason, http_status: page.status || null, ...extra } });
  const unreadable = unreadableReason(page);
  if (unreadable) return blocked(unreadable);

  const nap = extractNap(page.html || '', candidates);
  // A short page is a JS shell / empty page unless it carries a usable Waves entity (one that
  // states a telephone), which is then judged on its own.
  const usableEntity = Boolean(nap.entity && nap.entity.rawPhones.length);
  if (nap.text.length < MIN_VISIBLE_CHARS && !usableEntity) return blocked('empty_or_js_only');
  const who = judgeIdentity(nap, candidates);
  if (who.noNap) return blocked('no_nap_found');

  const address = judgeAddress(nap, who.expected);
  const mismatches = [...who.mismatches, ...address.mismatches];
  const observed = observedNap(nap, who, address);
  const base = { http_status: page.status, final_url: page.finalUrl, office: who.expected.locationId, address_checked: address.checked };

  // A cut-off body proves nothing either way: what was cut may hold a conflicting address or
  // JSON-LD entity (so never verified) or may not repeat a mismatch (so never mismatched).
  if (page.truncated) return blocked('truncated');
  if (mismatches.length) return { status: 'mismatched', nap: observed, detail: { ...base, mismatches } };
  if (!who.phoneOk) {
    // No phone anywhere on the page: nothing readable to judge (fetch-blocked). Phones shown but
    // none ours: the listing's phone is unconfirmed, never a mismatch.
    if (!nap.textPhones.length) return blocked('phone_not_found', { final_url: page.finalUrl });
    return { status: 'unverified', nap: observed, detail: { ...base, reason: 'phone_unconfirmed', seen: nap.textPhones.slice(0, 3).map(fmtPhone) } };
  }
  if (address.unconfirmed) return { status: 'unverified', nap: observed, detail: { ...base, reason: 'address_unconfirmed', seen: address.unconfirmed } };
  return { status: 'verified', nap: observed, detail: base };
}

async function checkRow(row, seams = {}) {
  if (!row.listing_url) return { status: 'unverified', nap: null, detail: { reason: 'no_listing_url' } };
  const page = await contactFinder.fetchPage(row.listing_url, { ...seams, timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS });
  return classifyListing(page, candidatesFor(row));
}

// nap_name / nap_phone are varchar(255) (20260401000045). A directory page can
// state anything, so stored values are clipped to fit; a clipped value keeps its
// fuller observed form (bounded) in status_detail.observed as evidence.
const NAP_COLUMN_MAX = 255;
const EVIDENCE_MAX = 2000;
function napColumns(nap, detail) {
  const out = { nap_name: null, nap_phone: null, nap_address: null };
  if (!nap) return { columns: out, detail };
  const observed = {};
  for (const [col, max] of [['nap_name', NAP_COLUMN_MAX], ['nap_phone', NAP_COLUMN_MAX], ['nap_address', EVIDENCE_MAX]]) {
    const value = nap[col] == null ? null : String(nap[col]);
    out[col] = value == null ? null : value.slice(0, max);
    if (value != null && value.length > max) observed[col] = value.slice(0, EVIDENCE_MAX);
  }
  return { columns: out, detail: Object.keys(observed).length ? { ...detail, observed } : detail };
}

function statusCounts(rows) {
  return Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.status === s).length]));
}

class CitationAuditor {
  // `seams` ({ fetchFn, resolveHostFn }) exist for tests; production uses fetchPage's defaults.
  async audit(seams = {}) {
    logger.info('Citation audit running...');
    const rows = await db('seo_citations').whereNot('status', 'missing');
    const audited = [];
    let failed = 0;
    for (const row of rows) {
      let res;
      try {
        res = await checkRow(row, seams);
      } catch (err) {
        res = { status: 'fetch-blocked', nap: null, detail: { reason: `audit_error: ${err.message}` } };
      }
      // Conditional on the row still being what was fetched: a staff edit (URL, office,
      // missing/unverified) made mid-sweep must not be overwritten by this result.
      let stillSame = db('seo_citations').where({ id: row.id, listing_url: row.listing_url, location_id: row.location_id, status: row.status })
        .whereNot('status', 'missing');
      stillSame = row.updated_at
        ? stillSame.whereRaw('abs(extract(epoch from updated_at) * 1000 - ?) < 1', [new Date(row.updated_at).getTime()]) // pg keeps microseconds, JS ms
        : stillSame.whereNull('updated_at');
      const { columns, detail } = napColumns(res.nap, res.detail);
      let changed;
      try {
        changed = await stillSame.update({
          status: res.status,
          status_detail: JSON.stringify(detail),
          ...columns,
          nap_consistent: res.status === 'verified' ? true : res.status === 'mismatched' ? false : null,
          last_checked: etDateString(),
          updated_at: new Date(),
        });
      } catch (err) {
        // One row's write must never abort the rest of the weekly sweep.
        logger.error(`Citation audit: row ${row.id} could not be saved: ${err.message}`);
        failed += 1;
        continue;
      }
      if (changed) audited.push({ status: res.status });
      else logger.warn(`Citation audit: row ${row.id} changed during the sweep; result discarded`);
    }
    const counts = statusCounts(audited);
    logger.info(`Citation audit: ${JSON.stringify(counts)} (${audited.length} of ${rows.length} written${failed ? `, ${failed} failed to save` : ''})`);
    const result = { total: audited.length, skipped: rows.length - audited.length - failed, failed, ...counts };
    // The rest of the sweep already ran; a partial or total write failure still has to reach the
    // cron health wrapper (runExclusive records a thrown run as failed), so reject AFTER the loop.
    if (failed) throw Object.assign(new Error(`Citation audit: ${failed} of ${rows.length} row(s) could not be saved`), { result });
    return result;
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
    if (patch.listing_url && !isHttpUrl(patch.listing_url)) throw invalid('listing_url must be an http(s) URL');
    if ('priority' in patch && !['high', 'medium', 'low'].includes(patch.priority)) throw invalid('priority must be high, medium or low');
    if (updates.status !== undefined) {
      if (!['missing', 'unverified'].includes(updates.status)) throw invalid("status can only be set to 'missing' or 'unverified'; the audit sets the rest");
      patch.status = updates.status;
    } else if ('listing_url' in patch || 'location_id' in patch) {
      // A save that changes neither the URL nor the office (same values, normalized alike)
      // is a no-op and must not wipe the audit evidence.
      const stored = await db('seo_citations').where('id', citationId).first();
      if (!stored) return;
      const norm = (v) => String(v ?? '').trim() || null;
      const changed = ['listing_url', 'location_id'].some((k) => k in patch && patch[k] !== norm(stored[k]));
      if (changed) patch.status = 'unverified';
    }
    // A reset drops every piece of stale audit evidence, not just the verdict.
    if (patch.status) Object.assign(patch, { status_detail: null, nap_consistent: null, nap_name: null, nap_phone: null, nap_address: null, last_checked: null });
    await db('seo_citations').where('id', citationId).update({ ...patch, updated_at: new Date() });
  }
}

module.exports = new CitationAuditor();
module.exports.statusCounts = statusCounts; // shared with backlink-monitor's dashboard
module.exports._internals = { classifyListing, candidatesFor, expectedNapFor, extractNap, normalizeStreet, parseAddress, streetOfAddress, STATES };
