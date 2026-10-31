/**
 * procurement/siteone-programs-check.js — monthly SiteOne savings-programs check.
 *
 * On the 1st of each month (9:00 AM ET, scheduler.js) the portal signs in to
 * siteone.com with the SAME stored login the order bot uses, reads SiteOne's
 * savings programs (Early Order Programs, promotions, Partners Program points),
 * compares them with last month's snapshot and rings ONE admin notification:
 * new programs, programs ending within 30 days, Partners points expiring within
 * 60 days. Nothing to report = no bell.
 *
 * READ-ONLY on SiteOne: the session only navigates and reads page text. It never
 * adds to the cart, never changes account settings, never clicks order or
 * checkout. The browser is the order bot's egress-locked one
 * (adapters/siteone.js readSignedIn).
 *
 * Gate: GATE_SITEONE_PROGRAMS_CHECK, strict opt-in via gateEnvValue, read at
 * CALL time. Off → { skipped: 'gated' } before any DB read or browser launch.
 *
 * Snapshot: JSON text in system_settings, key procurement.siteone_programs_snapshot (the
 * latest list, the diff source) plus one history row per month,
 * procurement.siteone_programs_snapshot.YYYY-MM, kept 24 months (loadProgramHistory).
 * Saved only after a successful read, and (when a bell is due) only after the
 * bell landed, so a bell that failed is not lost with the snapshot.
 *
 * Failure (no vendor, no login, browser or login failed, /eop yields 0
 * programs): one "SiteOne programs check failed" bell, no snapshot write, and
 * the error is rethrown so job_health goes red.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { raiseAdminAlert, breaksAlertRules } = require('../admin-alert-compose');

const GATE = 'GATE_SITEONE_PROGRAMS_CHECK';
const SNAPSHOT_KEY = 'procurement.siteone_programs_snapshot'; // the latest list: the diff source
const HISTORY_PREFIX = `${SNAPSHOT_KEY}.`; // one row per month: procurement.siteone_programs_snapshot.YYYY-MM
const HISTORY_KEEP_MONTHS = 24;
const BASE = 'https://www.siteone.com';
const LINK = `${BASE}/eop`;
const URLS = {
  eop: `${BASE}/eop`,
  promotions: `${BASE}/en/Promotions`,
  turf: `${BASE}/eop-turf-fl`,
  pest: `${BASE}/eop-pestmanagement`,
  partners: `${BASE}/en/my-account/accountPartnerProgram`,
};
const ENDING_DAYS = 30;
const POINTS_DAYS = 60;
const OFFER_TEXT_CHARS = 1200;
const WHY_MAX = 110; // docs/admin-notifications.md: one sentence, 110 characters
const ALERT_LINK = '/admin/inventory?tab=restock'; // admin alerts link to an admin page; the SiteOne URL is in the detail
const PAGE_TIMEOUT = 45000;

const SOURCE_LABEL = { group: 'SiteOne program', supplier: 'Supplier EOP', promo: 'Promotion' };

// ---- date parsing -----------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '(?:,?\\s*(\\d{4}))?';
// Start: "Sept. 1", "September 1, 2026". End: same, or just a day ("Oct. 1 - 31, 2026").
const RANGE_RE = new RegExp(`(${MONTH_WORD})\\.?\\s+${DAY}${YEAR}\\s*(?:-|\\u2013|\\u2014|to|through|thru)\\s*(?:(${MONTH_WORD})\\.?\\s+)?${DAY}${YEAR}`, 'i');
const THROUGH_RE = new RegExp(`(?:now\\s+)?(?:through|thru|until|ends?)\\s+(${MONTH_WORD})\\.?\\s+${DAY}${YEAR}`, 'i');
const SINGLE_DATE_RE = new RegExp(`(${MONTH_WORD})\\.?\\s*${DAY}\\s*,?\\s*(\\d{4})`, 'i');

function monthIndex(word) {
  const i = MONTHS.indexOf(String(word || '').slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
}

function iso(y, m, d) {
  if (!y || !m || !d || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const squash = (s) => String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();

/**
 * First date range in `text`. Returns { start, end, dateText } (ISO dates, either
 * may be null) or null when the text has no date. A start without a year takes
 * the end's year, minus one when that would put the start after the end
 * ("September 1 - February 12, 2027" → 2026-09-01 .. 2027-02-12).
 * "Now through <date>" has no start.
 */
function parseDateRange(text) {
  const t = squash(text);
  const r = RANGE_RE.exec(t);
  if (r) {
    const sMonth = monthIndex(r[1]);
    const sDay = Number(r[2]);
    const sYear = r[3] ? Number(r[3]) : null;
    const eMonth = r[4] ? monthIndex(r[4]) : sMonth; // "Oct. 1 - 31, 2026"
    const eDay = Number(r[5]);
    const eYear = r[6] ? Number(r[6]) : null;
    if (sMonth && eMonth) {
      const endYear = eYear || sYear;
      let startYear = sYear;
      if (!startYear && endYear) {
        startYear = endYear;
        const same = iso(startYear, sMonth, sDay);
        const end = iso(endYear, eMonth, eDay);
        if (same && end && same > end) startYear = endYear - 1;
      }
      const start = iso(startYear, sMonth, sDay);
      const end = iso(endYear || startYear, eMonth, eDay);
      // No year anywhere ("Oct. 1 - Dec. 4"): still a dated program, dates unknown.
      return { start, end, dateText: squash(r[0]) };
    }
  }
  const th = THROUGH_RE.exec(t);
  if (th) {
    const m = monthIndex(th[1]);
    const end = th[3] ? iso(Number(th[3]), m, Number(th[2])) : null;
    return { start: null, end, dateText: squash(th[0]) };
  }
  return null;
}

// A date range that is the whole point of the line ("DEADLINE EXTENDED: July 1 - ..."),
// not a sentence that happens to contain one.
function dateLine(line) {
  const range = parseDateRange(line);
  if (!range) return null;
  const t = squash(line);
  const idx = t.toLowerCase().indexOf(range.dateText.toLowerCase());
  if (idx < 0) return null;
  const before = t.slice(0, idx).replace(/[:\s-]+$/, '').trim();
  const after = t.slice(idx + range.dateText.length).trim();
  if (after.length > 40 || before.length > 40) return null;
  return { ...range, note: before || null };
}

function parseSingleDate(text) {
  const m = SINGLE_DATE_RE.exec(squash(text));
  if (!m) return null;
  return iso(Number(m[3]), monthIndex(m[1]), Number(m[2]));
}

// ---- page text parsing -------------------------------------------------------

function textLines(text) {
  return String(text == null ? '' : text).split(/\r?\n/).map(squash).filter(Boolean);
}

const BOILERPLATE = /^(select a program|view eop offer|view offer|learn more|shop now|view details|supplier early order programs|early order programs?|view all|see all|more info)\b/i;
const isBoilerplate = (line) => BOILERPLATE.test(line.replace(/[^\w\s&]+$/g, '')) || /^[^\w]*$/.test(line);

function normName(s) {
  return squash(s).toLowerCase().replace(/[^a-z0-9&% ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function programKey(source, name, dateText) {
  return `${normName(source)}|${normName(name)}|${normName(dateText || '')}`;
}

function makeProgram(source, name, range, extra = {}) {
  const dateText = range ? range.dateText : '';
  return {
    key: programKey(source, name, dateText),
    source,
    name: squash(name).slice(0, 140),
    dateText,
    start: range ? range.start : null,
    end: range ? range.end : null,
    ...extra,
  };
}

function dedupe(programs) {
  const seen = new Set();
  return programs.filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
}

// Name = the nearest earlier line that reads like a title. `max` bounds the walk.
function titleBefore(lines, i, { max = 4, skipSentences = false } = {}) {
  for (let j = i - 1; j >= 0 && i - j <= max; j -= 1) {
    const l = lines[j];
    if (isBoilerplate(l) || dateLine(l)) continue;
    if (skipSentences && (/[.!?]$/.test(l) || l.length > 70 || /^save\b/i.test(l))) continue;
    return l;
  }
  return null;
}

/**
 * /eop: SiteOne program groups (before the "Supplier Early Order Programs"
 * heading) and supplier programs (after it). A program is a dated line; its
 * name is the line just above it.
 */
function parseEopPage(text) {
  const lines = textLines(text);
  const marker = lines.findIndex((l) => /^supplier early order programs\b/i.test(l));
  const out = [];
  lines.forEach((line, i) => {
    const range = dateLine(line);
    if (!range) return;
    const supplier = marker >= 0 && i > marker;
    const name = titleBefore(lines, i, { max: 3 });
    if (!name) return;
    const extra = {};
    if (range.note) extra.note = range.note;
    if (supplier) {
      const next = lines[i + 1];
      if (next && !isBoilerplate(next) && !dateLine(next) && !(lines[i + 2] && dateLine(lines[i + 2]))) extra.desc = next.slice(0, 200);
    }
    out.push(makeProgram(supplier ? 'supplier' : 'group', name, range, extra));
  });
  return dedupe(out);
}

/** /en/Promotions: promotion blocks with a title, a date range, and an offer line. */
function parsePromotionsPage(text) {
  const lines = textLines(text);
  const out = [];
  lines.forEach((line, i) => {
    const range = dateLine(line);
    if (!range) return;
    const name = titleBefore(lines, i, { max: 4, skipSentences: true });
    if (!name) return;
    const extra = {};
    if (range.note) extra.note = range.note;
    const offer = lines[i + 1];
    if (offer && !dateLine(offer) && /^save\b|%/i.test(offer) && offer.length <= 80) extra.desc = offer;
    out.push(makeProgram('promo', name, range, extra));
  });
  return dedupe(out);
}

function toInt(s) {
  const n = Number(String(s || '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && String(s || '').match(/\d/) ? n : null;
}

/** Partners page: available points, dollar value, expiring points + date. */
function parsePartnersPage(text) {
  const t = squash(text);
  const available = /(\d[\d,]*)\s+points\b/i.exec(t);
  const dollars = /redeem points[^$]{0,40}\$\s*(\d[\d,]*(?:\.\d{2})?)/i.exec(t) || /\$\s*(\d[\d,]*(?:\.\d{2})?)/.exec(t);
  const expiring = /expiring soon\s*(\d[\d,]*)\s*pts/i.exec(t);
  const expires = /expires by\s+([A-Za-z.]+\s*\d{1,2}\s*,?\s*\d{4})/i.exec(t);
  const status = /current year:\s*([A-Za-z ]{3,20}?)(?:\s+redeem|\s+\$|$)/i.exec(t);
  return {
    available: available ? toInt(available[1]) : null,
    dollarValue: dollars ? Number(dollars[1].replace(/,/g, '')) : null,
    expiringPoints: expiring ? toInt(expiring[1]) : 0,
    expiresOn: expires ? parseSingleDate(expires[1]) : null,
    status: status ? squash(status[1]) : null,
  };
}

// ---- compare ------------------------------------------------------------------

function readSnapshot(raw) {
  if (!raw) return null;
  try {
    const snap = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return snap && Array.isArray(snap.programs) ? snap : null;
  } catch { return null; }
}

/**
 * programs: current parsed list. prev: last snapshot or null (first run).
 * today: ISO ET date. Programs already ended are kept in the snapshot but are
 * never reported as new or current.
 */
function diffPrograms({ programs, prev, partners, today, addDays = defaultAddDays }) {
  const ended = (p) => p.end && p.end < today;
  const known = new Set(prev ? prev.programs.map((p) => p.key) : []);
  const live = programs.filter((p) => !ended(p));
  const horizon = addDays(today, ENDING_DAYS);
  const pointsHorizon = addDays(today, POINTS_DAYS);
  const added = prev ? live.filter((p) => !known.has(p.key)) : live;
  const endingSoon = live.filter((p) => p.end && p.end >= today && p.end <= horizon);
  const pointsSoon = !!(partners && partners.expiringPoints > 0 && partners.expiresOn
    && partners.expiresOn >= today && partners.expiresOn <= pointsHorizon);
  return { baseline: !prev, added, endingSoon, live, pointsSoon };
}

function defaultAddDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return etDateString(addETDays(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), days));
}

// ---- notification text ----------------------------------------------------------

function shortDate(isoDate) {
  if (!isoDate) return '';
  const [, m, d] = isoDate.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function clip(s, n) {
  const t = squash(s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 3)).trimEnd()}...`;
}

/**
 * The alert's headline action and its one-sentence why (docs/admin-notifications.md
 * section 2: headline 60 with the area, why 110 and one sentence). Counts first;
 * program names only when they fit and read cleanly.
 */
function buildAlertText(d, partners) {
  let action;
  if (d.baseline) action = `read the ${d.live.length} SiteOne programs`;
  else if (d.added.length) action = `review ${plural(d.added.length, 'new SiteOne program', 'new SiteOne programs')}`;
  else if (d.endingSoon.length) action = `use SiteOne programs ending soon`;
  else action = 'redeem SiteOne points before they expire';

  const parts = [];
  if (d.baseline) parts.push(`${d.live.length} programs found on the first check`);
  else if (d.added.length) parts.push(`${d.added.length} new`);
  if (d.endingSoon.length) parts.push(`${d.endingSoon.length} end within ${ENDING_DAYS} days`);
  if (d.pointsSoon) parts.push(`${partners.expiringPoints.toLocaleString('en-US')} points expire ${shortDate(partners.expiresOn)}`);
  let why = `${parts.join('; ')}.`;
  const names = (d.added.length ? d.added : d.endingSoon).map((p) => p.name).slice(0, 3).join(', ');
  if (parts.length === 1 && names && !breaksAlertRules(names)) { // names only when they follow one plain count
    const withNames = `${parts.join('; ')}: ${names}.`;
    if (withNames.length <= WHY_MAX && !breaksAlertRules(withNames)) why = withNames;
  }
  return { action, why: clip(why, WHY_MAX) };
}

function programLine(p) {
  const when = p.dateText ? ` (${p.dateText})` : ' (no dates found)';
  const extra = [p.note, p.desc].filter(Boolean).join(' - ');
  return `- [${SOURCE_LABEL[p.source] || p.source}] ${p.name}${when}${extra ? ` - ${clip(extra, 140)}` : ''}`;
}

function buildDetail({ diff, partners, offers, warnings, today }) {
  const out = [];
  const section = (title, list) => {
    if (!list.length) return;
    out.push(title, ...list.map(programLine), '');
  };
  section(diff.baseline ? 'FIRST CHECK - all current programs' : `NEW (${diff.added.length})`, diff.baseline ? diff.live : diff.added);
  section(`ENDING WITHIN ${ENDING_DAYS} DAYS (${diff.endingSoon.length})`, diff.endingSoon);
  if (partners) {
    const bits = [];
    if (partners.available != null) bits.push(`${partners.available.toLocaleString('en-US')} points available${partners.dollarValue != null ? ` ($${partners.dollarValue.toFixed(2)})` : ''}`);
    if (partners.expiringPoints > 0) bits.push(`${partners.expiringPoints.toLocaleString('en-US')} expire ${partners.expiresOn ? shortDate(partners.expiresOn) : '(date not read)'}`);
    if (partners.status) bits.push(`status ${partners.status}`);
    if (bits.length) out.push(partners.carriedForward ? 'PARTNERS PROGRAM (last reading; the page was not read this run)' : 'PARTNERS PROGRAM', `- ${bits.join('; ')}`, '');
  }
  if (!diff.baseline) section(`ALL CURRENT (${diff.live.length})`, diff.live);
  if (offers && (offers.turf || offers.pest)) {
    out.push('OFFER TEXT');
    if (offers.turf) out.push(`Florida turf: ${offers.turf}`);
    if (offers.pest) out.push(`Pest management: ${offers.pest}`);
    out.push('');
  }
  if (warnings.length) out.push('NOT READ THIS RUN', ...warnings.map((w) => `- ${w}`), '');
  out.push(`Read ${today}. Link: ${LINK}`);
  return out.join('\n').trim();
}

// ---- reading the site -------------------------------------------------------------

async function readPageText(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  // page.goto() resolves, it does not throw, on an HTTP 404/500 (Codex #6800 r1 P2). An error page
  // must fail this read, so the caller's warning / carry-forward branch runs instead of parsing it.
  const status = response && typeof response.status === 'function' ? Number(response.status()) : null;
  if (status != null && status >= 400) throw new Error(`SiteOne answered HTTP ${status}`);
  if (typeof page.waitForLoadState === 'function') await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const landed = String(typeof page.url === 'function' ? page.url() : url);
  if (!/^https:\/\/([a-z0-9-]+\.)*siteone\.com\//i.test(landed)) throw new Error(`redirected off siteone.com (${landed.slice(0, 60)})`);
  if (/\/login\b/i.test(landed)) throw new Error('SiteOne sent the page back to the sign-in form');
  const text = await page.evaluate(() => (globalThis.document && globalThis.document.body ? globalThis.document.body.innerText : ''));
  return String(text || '');
}

async function readAll(page, prev) {
  const warnings = [];
  const safe = async (label, url) => {
    try { return await readPageText(page, url); }
    catch (e) { warnings.push(`${label}: ${clip(e.message, 100)}`); return null; }
  };
  // /eop is the one page the run cannot do without.
  const eopText = await readPageText(page, URLS.eop);
  const programs = parseEopPage(eopText);
  if (!programs.length) throw new Error('SiteOne /eop page showed 0 programs (page changed or not signed in)');

  const promoText = await safe('Promotions page', URLS.promotions);
  let promos = promoText != null ? parsePromotionsPage(promoText) : null;
  // A page that loads but shows no promotion (a loading shell, a changed page) is not a
  // month with none: treat it as unread, or they all come back as "new" next month.
  if (promos && !promos.length) { warnings.push('Promotions page: no promotions found on the page'); promos = null; }
  if (promos) programs.push(...promos);
  else if (prev) programs.push(...prev.programs.filter((p) => p.source === 'promo')); // unread is not "gone" and not "new"

  const turfText = await safe('Florida turf offer', URLS.turf);
  const pestText = await safe('Pest management offer', URLS.pest);
  const partnersText = await safe('Partners page', URLS.partners);
  let partners = partnersText != null ? parsePartnersPage(partnersText) : null;
  // A 200 page with no points total (loading shell, changed page) must not replace the saved
  // reading with zero expiring points (pre-push audit P1, #6800): treat it as unread.
  if (partners && partners.available == null) { warnings.push('Partners page: no points total found on the page'); partners = null; }
  // Unread is not "no points": keep last month's reading, marked, so an expiring-points alert
  // cannot drop out for a month and the snapshot never records empty points (Codex #6800 r1 P2).
  if (partners == null && prev && prev.points) partners = { ...prev.points, carriedForward: true };
  return {
    programs: dedupe(programs),
    partners,
    offers: {
      turf: turfText ? squash(turfText).slice(0, OFFER_TEXT_CHARS) : null,
      pest: pestText ? squash(pestText).slice(0, OFFER_TEXT_CHARS) : null,
    },
    warnings,
  };
}

// ---- the run ------------------------------------------------------------------------

async function findVendor(conn) {
  return conn('vendors').where({ code: 1 }).whereRaw("lower(name) = 'siteone'").first('id', 'name', 'code');
}

async function loadSnapshot(conn) {
  const row = await conn('system_settings').where({ key: SNAPSHOT_KEY }).first('value');
  return readSnapshot(row && row.value);
}

const MONTH_KEY_RE = /\.(\d{4}-\d{2})$/;

// Oldest month still kept when `month` (YYYY-MM) is saved: 24 months, this one included.
function oldestKeptMonth(month, keep = HISTORY_KEEP_MONTHS) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) - (keep - 1);
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

async function upsertSetting(c, key, value, description) {
  await c('system_settings')
    .insert({ key, value, category: 'procurement', description })
    .onConflict('key').merge({ value, updated_at: c.fn.now() });
}

/**
 * Latest list (the diff source) AND this month's history row, in one transaction,
 * with history rows older than 24 months deleted in the same write.
 */
async function saveSnapshot(conn, snapshot, month) {
  const value = JSON.stringify(snapshot);
  const write = async (c) => {
    await upsertSetting(c, SNAPSHOT_KEY, value, 'SiteOne savings programs seen by the latest monthly check (siteone-programs-check.js)');
    await upsertSetting(c, `${HISTORY_PREFIX}${month}`, value, `SiteOne savings programs seen by the ${month} monthly check`);
    const cutoff = oldestKeptMonth(month);
    const rows = await c('system_settings').where('key', 'like', `${HISTORY_PREFIX}%`).select('key');
    const stale = rows.map((r) => r.key).filter((k) => { const m = MONTH_KEY_RE.exec(k); return m && m[1] < cutoff; });
    if (stale.length) await c('system_settings').whereIn('key', stale).del();
  };
  if (typeof conn.transaction === 'function') await conn.transaction(write);
  else await write(conn);
}

/**
 * What the check saw each month, newest first: [{ month, takenAt, programs, points }].
 * No route and no UI read it yet; it is the bot's memory of past programs.
 */
async function loadProgramHistory(conn = db, { months = 12 } = {}) {
  const rows = await conn('system_settings').where('key', 'like', `${HISTORY_PREFIX}%`).select('key', 'value').orderBy('key', 'desc').limit(Math.max(1, Math.floor(Number(months)) || 12));
  const out = [];
  for (const r of rows) {
    const m = MONTH_KEY_RE.exec(r.key);
    const snap = m && readSnapshot(r.value);
    if (snap) out.push({ month: m[1], takenAt: snap.takenAt || null, programs: snap.programs, points: snap.points || null });
  }
  return out.sort((a, b) => (a.month < b.month ? 1 : -1));
}

/**
 * runSiteOneProgramsCheck({ conn, now, raise, getCredentials, readSignedIn, launchBrowser, resolveHostIps })
 * Everything is injectable so tests never touch the network, a browser or the DB.
 */
async function runSiteOneProgramsCheck(deps = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated' };
  const conn = deps.conn || db;
  const now = deps.now ? new Date(deps.now) : new Date();
  const today = etDateString(now);
  const month = today.slice(0, 7);
  const raise = deps.raise || raiseAdminAlert;
  const getCredentials = deps.getCredentials || ((c, id) => require('../vendor-credentials').getVendorLoginCredentials(c, id));
  const readSignedIn = deps.readSignedIn || require('./adapters/siteone').readSignedIn;

  const fail = async (err) => {
    const reason = clip(err && err.message ? err.message : String(err), 400);
    logger.error(`[siteone-programs] check failed: ${reason}`);
    try {
      await raise('system', {
        area: 'System',
        action: 'SiteOne programs check failed',
        why: 'The monthly read of SiteOne programs did not finish; the reason is in the details.',
        severity: 'needs-you',
        link: ALERT_LINK,
        subject: { type: 'check', id: 'siteone-programs' },
        doneWhen: 'check_succeeds',
        who: 'claude',
      }, { dedupeKey: `siteone-programs-failed:${month}`, refreshOnDedupe: true, detail: `${reason}\nLink: ${LINK}` });
    } catch (e) { logger.warn(`[siteone-programs] failure alert not sent: ${e.message}`); }
    throw err instanceof Error ? err : new Error(reason);
  };

  let prev; let read;
  try {
    const vendor = await findVendor(conn);
    if (!vendor) throw new Error('SiteOne vendor row (name SiteOne, code 1) not found');
    const credentials = await getCredentials(conn, vendor.id);
    prev = await loadSnapshot(conn);
    read = await readSignedIn(
      { credentials, launchBrowser: deps.launchBrowser, resolveHostIps: deps.resolveHostIps },
      (page) => readAll(page, prev),
    );
  } catch (err) {
    return fail(err);
  }

  const diff = diffPrograms({ programs: read.programs, prev, partners: read.partners, today, addDays: deps.addDays });
  const due = diff.added.length > 0 || diff.endingSoon.length > 0 || diff.pointsSoon;
  let notified = false;
  try {
    if (due) {
      const text = buildAlertText(diff, read.partners);
      const landed = await raise('system', {
        area: 'Inventory',
        action: text.action,
        why: text.why,
        severity: 'needs-you',
        link: ALERT_LINK,
        subject: { type: 'check', id: 'siteone-programs' },
        doneWhen: 'programs_reviewed',
        who: 'person',
      }, {
        dedupeKey: `siteone-programs:${month}`,
        refreshOnDedupe: true,
        detail: buildDetail({ diff, partners: read.partners, offers: read.offers, warnings: read.warnings, today }),
      });
      // the alert writer swallows its own insert failures and returns null: keep the
      // old snapshot so next run still sees these programs as new.
      if (!landed) throw new Error('the admin notification was not saved');
      notified = true;
    }
    await saveSnapshot(conn, { version: 1, takenAt: now.toISOString(), programs: read.programs, points: read.partners }, month);
  } catch (err) {
    return fail(err);
  }
  logger.info(`[siteone-programs] ${read.programs.length} programs, ${diff.added.length} new, ${diff.endingSoon.length} ending soon, notified=${notified}`);
  return {
    programs: read.programs.length,
    baseline: diff.baseline,
    added: diff.added.length,
    endingSoon: diff.endingSoon.length,
    pointsSoon: diff.pointsSoon,
    notified,
    warnings: read.warnings,
  };
}

module.exports = {
  runSiteOneProgramsCheck,
  parseDateRange,
  parseEopPage,
  parsePromotionsPage,
  parsePartnersPage,
  diffPrograms,
  buildAlertText,
  buildDetail,
  programKey,
  loadProgramHistory,
  oldestKeptMonth,
  SNAPSHOT_KEY,
  HISTORY_PREFIX,
  SITEONE_PROGRAMS_GATE: GATE,
};
