/**
 * Weekly restaurant prospect list from Florida's public restaurant files (DBPR; free, no key; owner approval
 * 2026-11-19). Backend only: it fills `restaurant_prospects` and sends nothing to anyone, calls no AI.
 *
 *   7fdinspi.csv      district 7 inspections, current fiscal year. Kept: visits that cited violation 35 in
 *                     Manatee, Sarasota or Charlotte.
 *   newfood.csv       new licenses statewide. Kept: the three counties.
 *   chgownr_food.csv  ownership changes statewide. Kept: the three counties. In this file the values under
 *                     "Primary Phone Number" and "Mailing County Code" arrive swapped, so a phone is picked by shape.
 *
 * Violation 35 holds two codes. 35A is pest evidence (roaches, rodents, flies); 35B is outer openings not protected
 * (a door that does not self-close). The CSV has only the count, so the public report page of each recent
 * inspection is read to split them: pest_evidence NULL = not read yet, true = a 35A finding, false = 35B only.
 *
 * Fail soft: a download, parse or database failure logs a count-only warning and goes into the result object; the
 * sync never throws into the scheduler. Logs carry counts and elapsed time only, never a business name, address
 * or phone. Kill switch: env DBPR_PROSPECT_SYNC_DISABLED (1, true or on).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { SERVICE_AREA_COUNTIES } = require('../call-triage-flags');
const { parseDbprCsv, defaultFetchText } = require('../commercial-suite-size/dbpr-food-license');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const EXTRACT_BASE = 'https://www2.myfloridalicense.com/sto/file_download/extracts/';
const REPORT_BASE = 'https://www.myfloridalicense.com/inspectionDetail.asp';
const FILES = {
  inspection: '7fdinspi.csv',
  new_license: 'newfood.csv',
  owner_change: 'chgownr_food.csv',
};
const REQUIRED_COLUMNS = {
  inspection: ['County Name', 'Inspection Date', 'Inspection Visit ID', 'Violation 35'],
  new_license: ['Application Number', 'Application Approval Date', 'Location County'],
  owner_change: ['Application Number', 'Application Approval Date', 'Location County'],
};

const FILE_TIMEOUT_MS = 60 * 1000;
const REPORT_TIMEOUT_MS = 15 * 1000;
const REPORT_GAP_MS = 1000;
const REPORT_WINDOW_DAYS = 45;
const REPORT_MAX_PER_RUN = 100;
const REPORT_MAX_ATTEMPTS = 3;
const FINDING_TEXT_MAX = 400;
const UPSERT_CHUNK = 500;

const COUNTIES = new Set([...SERVICE_AREA_COUNTIES].map((c) => c.toUpperCase()));

function syncDisabled(env = process.env) {
  return /^(1|true|on)$/i.test(String(env.DBPR_PROSPECT_SYNC_DISABLED || '').trim());
}

// ── Parsers (pure) ──────────────────────────────────────────────

const clean = (v, max) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return (max ? s.slice(0, max) : s) || null;
};

// "MM/DD/YYYY" -> "YYYY-MM-DD", or null for anything that is not a real calendar date.
function parseUsDate(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function inServiceCounty(name) {
  return COUNTIES.has(String(name || '').trim().toUpperCase());
}

// A phone is picked by shape (10 or more digits), never by column name: chgownr_food.csv swaps the Primary Phone
// and Mailing County Code values. The location's own line (Secondary Phone Number) comes first, then the owner's.
function pickPhone(row) {
  const candidates = [row['Secondary Phone Number'], row['Primary Phone Number'], row['Mailing County Code']];
  for (const value of candidates) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
  }
  return null;
}

const wholeNumber = (v) => (/^\d+$/.test(String(v || '').trim()) ? Number(String(v).trim()) : null);

/** Inspection rows -> one record per visit that cited violation 35, in the three counties. */
function parseInspectionRows(rows) {
  const out = [];
  for (const row of rows) {
    if (!inServiceCounty(row['County Name'])) continue;
    if (!(Number(row['Violation 35']) > 0)) continue;
    const sourceKey = clean(row['Inspection Visit ID']);
    const eventDate = parseUsDate(row['Inspection Date']);
    if (!sourceKey || !eventDate) continue;
    out.push({
      kind: 'inspection',
      source_key: sourceKey,
      license_number: clean(row['License Number'], 40),
      license_id: clean(row['License ID'], 40),
      license_type_code: clean(row['License Type Code'], 20),
      business_name: clean(row['Business Name'] || row['Business (DBA-Does Business As) Name'], 200),
      address: clean(row['Location Address'], 200),
      city: clean(row['Location City'], 80),
      zip: clean(row['Location Zip Code'], 10),
      county: clean(row['County Name'], 40),
      phone: null,
      seats: null,
      event_date: eventDate,
      detail: {
        disposition: clean(row['Inspection Disposition'], 120),
        inspectionType: clean(row['Inspection Type'], 120),
        highPriority: wholeNumber(row['Number of High Priority Violations']),
      },
    });
  }
  return out;
}

/** New-license or ownership-change rows (same layout) -> one record per application in the three counties. */
function parseLicenseRows(rows, kind) {
  const out = [];
  for (const row of rows) {
    if (!inServiceCounty(row['Location County'])) continue;
    const sourceKey = clean(row['Application Number']);
    if (!sourceKey) continue;
    out.push({
      kind,
      source_key: sourceKey,
      license_number: clean(row['License Number'], 40),
      license_id: null,
      license_type_code: clean(row['License Type Code'], 20),
      business_name: clean(row['Business Name'], 200),
      address: clean([row['Location Street Address'], row['Location Address Line 2']].filter(Boolean).join(' '), 200),
      city: clean(row['Location City'], 80),
      zip: clean(String(row['Location Zip Code'] || '').slice(0, 5), 10),
      county: clean(row['Location County'], 40),
      phone: pickPhone(row),
      seats: wholeNumber(row['Number of Seats']),
      event_date: parseUsDate(row['Application Approval Date']),
      detail: { applicationType: clean(row['Application Type'], 120) },
    });
  }
  return out;
}

const VIOLATION_CODE_RE = /(?<![\w-])\d\d[A-Z]?-\d\d-\d(?![\w-])/g;
// The page footer follows the last violation; it starts with the state office's street address.
const PAGE_FOOTER_RE = /\s*2601 Blair Stone Road[\s\S]*$/;

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function reportText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Report page HTML -> { pestEvidence, findings: [{ code, text }] }, or null when the page is not an inspection
 * report (an error page or a changed layout must count as a failed read, never as "no pests"). findings holds the
 * 35A entries only. An entry runs from its code to the next code.
 */
function parseInspectionReport(html) {
  const text = reportText(html);
  if (!/Inspection Information/.test(text)) return null;
  const marks = [...text.matchAll(VIOLATION_CODE_RE)];
  const findings = [];
  marks.forEach((mark, i) => {
    if (!/^35A-/.test(mark[0])) return;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(mark.index + mark[0].length, end).replace(PAGE_FOOTER_RE, '').trim();
    findings.push({ code: mark[0], text: body.slice(0, FINDING_TEXT_MAX) });
  });
  return { pestEvidence: findings.length > 0, findings };
}

// ── Download + store ────────────────────────────────────────────

function dedupeByKey(records) {
  return [...new Map(records.map((r) => [`${r.kind}|${r.source_key}`, r])).values()];
}

// A re-read of a known row refreshes last_seen_at only: a pest_evidence answer, the findings and the attempt count
// are never overwritten by a later file.
async function upsertRecords(records) {
  let n = 0;
  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const chunk = records.slice(i, i + UPSERT_CHUNK).map((r) => ({ ...r, detail: JSON.stringify(r.detail) }));
    await db('restaurant_prospects').insert(chunk).onConflict(['kind', 'source_key']).merge({ last_seen_at: db.fn.now() });
    n += chunk.length;
  }
  return n;
}

async function pendingInspections({ cutoff, limit }) {
  const rows = await db('restaurant_prospects')
    .where({ kind: 'inspection' })
    .whereNull('pest_evidence')
    .where('detail_attempts', '<', REPORT_MAX_ATTEMPTS)
    .where('event_date', '>=', cutoff)
    .orderBy('event_date', 'desc')
    .limit(limit)
    .select('id', 'license_id', 'source_key');
  return rows;
}

async function saveReport(id, report) {
  await db('restaurant_prospects')
    .where({ id })
    .whereNull('pest_evidence')
    .update({
      pest_evidence: report.pestEvidence,
      detail: db.raw("COALESCE(detail, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ findings: report.findings })]),
    });
}

async function bumpAttempts(id) {
  await db('restaurant_prospects').where({ id }).increment('detail_attempts', 1);
}

const defaultStore = { upsertRecords, pendingInspections, saveReport, bumpAttempts };
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const ID_RE = /^\d{1,12}$/;

function reportUrl(visitId, licenseId) {
  if (!ID_RE.test(String(visitId)) || !ID_RE.test(String(licenseId))) return null;
  return `${REPORT_BASE}?InspVisitID=${visitId}&id=${licenseId}`;
}

async function loadFile(kind, fetchText) {
  const text = await fetchText(`${EXTRACT_BASE}${FILES[kind]}`, FILE_TIMEOUT_MS);
  const rows = parseDbprCsv(text);
  const missing = REQUIRED_COLUMNS[kind].filter((c) => !rows.length || !(c in rows[0]));
  if (missing.length) throw new Error('unexpected file layout');
  return kind === 'inspection' ? parseInspectionRows(rows) : parseLicenseRows(rows, kind);
}

async function syncFiles(deps, result) {
  for (const kind of Object.keys(FILES)) {
    try {
      const records = dedupeByKey(await loadFile(kind, deps.fetchText));
      result.files[kind] = { kept: records.length, upserted: await deps.store.upsertRecords(records) };
    } catch (err) {
      result.failures += 1;
      result.files[kind] = { failed: true };
      logger.warn(`[dbpr-prospects] ${kind} file failed (${err.code || err.name})`);
    }
  }
}

async function readOneReport(row, deps) {
  const url = reportUrl(row.source_key, row.license_id);
  if (!url) return null;
  const report = parseInspectionReport(await deps.fetchText(url, REPORT_TIMEOUT_MS));
  if (report) await deps.store.saveReport(row.id, report);
  return report;
}

// Newest first, at most REPORT_MAX_PER_RUN a run, one request a second. Each result is written as it is read, so a
// killed run keeps its progress. A failed read adds 1 to detail_attempts and leaves pest_evidence NULL.
async function readReports(deps, result, now) {
  const cutoff = etDateString(addETDays(now, -REPORT_WINDOW_DAYS));
  const pending = await deps.store.pendingInspections({ cutoff, limit: REPORT_MAX_PER_RUN });
  for (let i = 0; i < pending.length; i += 1) {
    if (i > 0) await deps.sleep(REPORT_GAP_MS);
    let report = null;
    try {
      report = await readOneReport(pending[i], deps);
    } catch {
      report = null;
    }
    if (report) {
      result.reportsRead += 1;
      if (report.pestEvidence) result.pestFound += 1;
    } else {
      result.reportsFailed += 1;
      await deps.store.bumpAttempts(pending[i].id);
    }
  }
}

/**
 * The weekly job. Never throws. `deps` is for tests: { fetchText, sleep, store, now }.
 * @returns {Promise<{ skipped?: string, failures: number, files: object, reportsRead: number,
 *   reportsFailed: number, pestFound: number, elapsedMs: number }>}
 */
async function syncRestaurantProspects(deps = {}) {
  const started = Date.now();
  const result = { failures: 0, files: {}, reportsRead: 0, reportsFailed: 0, pestFound: 0, elapsedMs: 0 };
  if (syncDisabled()) return { ...result, skipped: 'disabled' };
  const ctx = { fetchText: defaultFetchText, sleep: defaultSleep, store: defaultStore, ...deps };
  try {
    await syncFiles(ctx, result);
    await readReports(ctx, result, ctx.now || new Date());
  } catch (err) {
    result.failures += 1;
    logger.warn(`[dbpr-prospects] sync stopped early (${err.code || err.name})`);
  }
  result.elapsedMs = Date.now() - started;
  const counts = Object.entries(result.files).map(([k, f]) => `${k}=${f.failed ? 'failed' : f.upserted}`).join(' ');
  logger.info(`[dbpr-prospects] ${counts} reportsRead=${result.reportsRead} reportsFailed=${result.reportsFailed} pestFound=${result.pestFound} failures=${result.failures} ${result.elapsedMs}ms`);
  return result;
}

module.exports = {
  syncRestaurantProspects,
  syncDisabled,
  parseUsDate,
  parseInspectionRows,
  parseLicenseRows,
  parseInspectionReport,
  pickPhone,
  reportUrl,
  upsertRecords,
  pendingInspections,
  saveReport,
  bumpAttempts,
};
