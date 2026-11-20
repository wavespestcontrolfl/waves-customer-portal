/**
 * Weekly restaurant prospect list from Florida's public restaurant files (DBPR; free, no key; owner approval
 * 2026-11-19). Backend only: it fills `restaurant_prospects` and sends nothing to anyone, calls no AI.
 *
 *   7fdinspi.csv      district 7 inspections, current fiscal year. Kept: visits that cited violation 35 in
 *                     Manatee, Sarasota or Charlotte, outside Punta Gorda (not served; excluded-localities.js).
 *   newfood.csv       new licenses statewide. Kept: the three counties, outside Punta Gorda.
 *   chgownr_food.csv  ownership changes statewide. Kept: the same places. In this file the values under
 *                     "Primary Phone Number" and "Mailing County Code" arrive swapped, so a phone is picked by shape.
 *
 * The state rebuilds the three files each morning, and each holds one fiscal year (July to June): on July 1 they
 * start over. The year before is not posted as these CSVs. Its archives are statewide XLSX files, checked
 * 2026-11-20: inspections about 55 MB, new licenses posted about July 9, no ownership-change archive since 2022-23.
 * Reading them is not worth one day of rows a year. So the job also runs daily on June 24-30 (scheduler.js), and
 * at most the last day of June goes unread.
 *
 * Violation 35 holds two codes. 35A is pest evidence (roaches, rodents, flies); 35B is outer openings not protected
 * (a door that does not self-close). The CSV has only the count. pest_evidence: NULL = the public report page is not
 * read yet, true = a 35A finding, false = 35B only. The report-page reads that fill it are the next change; until
 * then every inspection stays NULL.
 *
 * Fail soft: a download, parse or database failure logs a count-only warning and goes into the result object; the
 * sync itself never throws. The scheduler marks a run with failures as failed in job_health. Logs carry counts and
 * elapsed time only, never a business name, address or phone. Kill switch: env DBPR_PROSPECT_SYNC_DISABLED (1, true
 * or on).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { isInServiceAreaCounty } = require('../call-triage-flags');
const { isExcludedLocality, isExcludedZip } = require('../excluded-localities');
const { eachDbprCsvRow, defaultFetchText } = require('../commercial-suite-size/dbpr-food-license');
const { nanpNationalDigits, isValidNanpNumber } = require('../../utils/phone');

const EXTRACT_BASE = 'https://www2.myfloridalicense.com/sto/file_download/extracts/';
const FILES = {
  inspection: '7fdinspi.csv',
  new_license: 'newfood.csv',
  owner_change: 'chgownr_food.csv',
};
// Every column a parser reads. A file whose header lacks one is refused whole: no License ID would store inspections
// whose report can never be read, no city or ZIP would let Punta Gorda rows through, and a renamed name, address or
// phone column would store blanks that no later file repairs (a known key only refreshes last_seen_at). A row cut
// short is skipped and counted for the same reason (hasEveryColumn). An empty cell is still allowed. The two license
// files share one layout.
const PLACE_COLUMNS = ['Location City', 'Location Zip Code'];
const LICENSE_COLUMNS = [
  'Application Number', 'Application Type', 'Application Approval Date', 'License Number', 'License Type Code',
  'Business Name', 'Location Street Address', 'Location Address Line 2', 'Location Address Line 3', ...PLACE_COLUMNS,
  'Location County',
  'Primary Phone Number', 'Secondary Phone Number', 'Mailing County Code', 'Number of Seats',
];
const REQUIRED_COLUMNS = {
  inspection: [
    'County Name', ...PLACE_COLUMNS, 'Location Address', 'Business (DBA-Does Business As) Name', 'License Number',
    'License Type Code', 'License ID', 'Inspection Visit ID', 'Inspection Date', 'Inspection Type',
    'Inspection Disposition', 'Number of High Priority Violations', 'Violation 35',
  ],
  new_license: LICENSE_COLUMNS,
  owner_change: LICENSE_COLUMNS,
};
// restaurant_prospects.source_key is varchar(40). A longer key is skipped, never cut: two cut keys could merge two
// applications, and one value too long would make PostgreSQL refuse its whole insert batch.
const KEY_MAX = 40;

const FILE_TIMEOUT_MS = 60 * 1000;
const REPORT_MAX_ATTEMPTS = 3;
const UPSERT_CHUNK = 500;

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

// The three served counties (the shared county test: "Sarasota" and "Sarasota County" both count), less the places
// inside them Waves does not serve (Punta Gorda, owner ruling 2026-10-22). services/excluded-localities.js is the one
// list of those places; it decides by city name or by a Punta Gorda-only ZIP.
function inServiceArea(county, city, zip) {
  return isInServiceAreaCounty(county) && !isExcludedLocality(city) && !isExcludedZip(zip);
}

// A trailing extension ("x12", "ext. 12", "extension 12", "#12") is dropped first, so its digits never join the number.
const PHONE_EXTENSION_RE = /\s*(?:x|ext\.?|extension|#)\s*\d{1,6}\s*$/i;

// A phone is picked by shape, never by column name: chgownr_food.csv swaps the Primary Phone and Mailing County Code
// values. The location's own line (Secondary Phone Number) comes first, then the owner's. A value counts only as a
// valid US number (ten digits, or 1 and ten digits, area code 2-9; utils/phone.js); anything else tries the next.
function pickPhone(row) {
  const candidates = [row['Secondary Phone Number'], row['Primary Phone Number'], row['Mailing County Code']];
  for (const value of candidates) {
    const ten = nanpNationalDigits(String(value || '').replace(PHONE_EXTENSION_RE, ''));
    if (ten && isValidNanpNumber(ten)) return ten;
  }
  return null;
}

// At most 9 digits, so a seat count always fits the integer column (one value out of range would refuse its whole
// insert batch).
const wholeNumber = (v) => (/^\d{1,9}$/.test(String(v || '').trim()) ? Number(String(v).trim()) : null);

// The public report page's address is built from these two ids only (the page reads are the next change), so both
// must be digits.
const ID_RE = /^\d{1,12}$/;

// csv-parse keeps a row cut short, with only the cells it has. Such a row is skipped and counted: stored, it would
// keep blanks that no later file repairs. An empty cell is a cell, so it passes. The parsers test this before the
// area, as a row cut before its county cannot be placed at all. Each row in the area is then checked whole and,
// when it passes, counted as good (counts.valid), cited or not: loadFile fails a file with no good row in the area.
function hasEveryColumn(row, kind) {
  return REQUIRED_COLUMNS[kind].every((column) => column in row);
}

/**
 * Inspection rows -> one record per visit that cited violation 35, in the three counties. A row in the area that is
 * cut short (checked before violation 35, which a short row can lack), or a code-35 row with a bad id or date, is
 * skipped and counted in counts.malformed.
 */
function parseInspectionRows(rows, counts = { malformed: 0, valid: 0 }) {
  const out = [];
  for (const row of rows) {
    if (!hasEveryColumn(row, 'inspection')) {
      counts.malformed += 1;
      continue;
    }
    if (!inServiceArea(row['County Name'], row['Location City'], row['Location Zip Code'])) continue;
    const sourceKey = clean(row['Inspection Visit ID']);
    const licenseId = clean(row['License ID'], 40);
    const eventDate = parseUsDate(row['Inspection Date']);
    const cited = wholeNumber(row['Violation 35']);
    // A row without both report ids is left out: its report could never be read, and once stored it would block a
    // corrected copy (a known key only refreshes last_seen_at). A later file with the ids adds it.
    if (!ID_RE.test(sourceKey || '') || !ID_RE.test(licenseId || '') || !eventDate || cited === null) {
      counts.malformed += 1;
      continue;
    }
    counts.valid += 1;
    if (!(cited > 0)) continue;
    out.push({
      kind: 'inspection',
      source_key: sourceKey,
      license_number: clean(row['License Number'], 40),
      license_id: licenseId,
      license_type_code: clean(row['License Type Code'], 20),
      business_name: clean(row['Business (DBA-Does Business As) Name'], 200),
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

/**
 * New-license or ownership-change rows (same layout) -> one record per application in the three counties. A row in
 * the area that is cut short, has no application number, one longer than the key column, or no real approval date,
 * is skipped and counted in counts.malformed: once stored, a known key only refreshes last_seen_at, so a corrected
 * copy in a later file could never fill it in.
 */
function parseLicenseRows(rows, kind, counts = { malformed: 0, valid: 0 }) {
  const out = [];
  for (const row of rows) {
    if (!hasEveryColumn(row, kind)) {
      counts.malformed += 1;
      continue;
    }
    if (!inServiceArea(row['Location County'], row['Location City'], row['Location Zip Code'])) continue;
    const sourceKey = clean(row['Application Number']);
    const eventDate = parseUsDate(row['Application Approval Date']);
    if (!sourceKey || sourceKey.length > KEY_MAX || !eventDate) {
      counts.malformed += 1;
      continue;
    }
    counts.valid += 1;
    out.push({
      kind,
      source_key: sourceKey,
      license_number: clean(row['License Number'], 40),
      license_id: null,
      license_type_code: clean(row['License Type Code'], 20),
      business_name: clean(row['Business Name'], 200),
      address: clean(['Location Street Address', 'Location Address Line 2', 'Location Address Line 3']
        .map((column) => row[column]).filter(Boolean).join(' '), 200),
      city: clean(row['Location City'], 80),
      zip: (clean(row['Location Zip Code']) || '').slice(0, 5) || null,
      county: clean(row['Location County'], 40),
      phone: pickPhone(row),
      seats: wholeNumber(row['Number of Seats']),
      event_date: eventDate,
      detail: { applicationType: clean(row['Application Type'], 120) },
    });
  }
  return out;
}

// ── Download + store ────────────────────────────────────────────

// One record per (kind, source_key); a repeated key keeps its last copy. PostgreSQL refuses an upsert that names the
// same row twice in one statement.
function dedupeByKey(records) {
  return [...new Map(records.map((r) => [`${r.kind}|${r.source_key}`, r])).values()];
}

// A re-read of a known row refreshes last_seen_at only: a pest_evidence answer, the findings and the attempt count
// are never overwritten by a later file. Returns the number of rows written.
async function upsertRecords(records) {
  const unique = dedupeByKey(records);
  let n = 0;
  for (let i = 0; i < unique.length; i += UPSERT_CHUNK) {
    const chunk = unique.slice(i, i + UPSERT_CHUNK).map((r) => ({ ...r, detail: JSON.stringify(r.detail) }));
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

const defaultStore = { upsertRecords };

async function loadFile(kind, fetchText) {
  const text = await fetchText(`${EXTRACT_BASE}${FILES[kind]}`, FILE_TIMEOUT_MS);
  const counts = { malformed: 0, valid: 0 };
  const records = [];
  let rowsRead = 0;
  // A row at a time, so the server keeps answering requests and only the kept records stay in memory.
  const header = await eachDbprCsvRow(text, (row) => {
    rowsRead += 1;
    records.push(...(kind === 'inspection' ? parseInspectionRows([row], counts) : parseLicenseRows([row], kind, counts)));
  });
  // A required column missing from the header is renamed or gone: the whole file is refused.
  if (REQUIRED_COLUMNS[kind].some((column) => !header.includes(column))) throw new Error('unexpected file layout');
  // A header with no rows is a download cut short, not a quiet week, so the file fails. (A file whose rows all fall
  // outside the area is fine. The first file of a fiscal year can also be empty: a run on July 1 reads as failed.)
  if (!rowsRead) throw new Error('empty file');
  // Malformed rows and not one good row in the area mean a changed format (a new date format, say), not a quiet
  // week: the file fails. A file whose rows all fall outside the area, or whose good rows cite nothing, succeeds.
  if (!counts.valid && counts.malformed) throw new Error('no good row in the area');
  return { records, malformed: counts.malformed };
}

async function syncFiles(deps, result) {
  for (const kind of Object.keys(FILES)) {
    try {
      const { records, malformed } = await loadFile(kind, deps.fetchText);
      const unique = dedupeByKey(records);
      result.files[kind] = { kept: unique.length, malformed, upserted: await deps.store.upsertRecords(unique) };
    } catch (err) {
      result.failures += 1;
      result.files[kind] = { failed: true };
      logger.warn(`[dbpr-prospects] ${kind} file failed (${err.code || err.name})`);
    }
  }
}

/**
 * The weekly job. Never throws: each file's failure is counted in the result. `deps` is for tests: { fetchText, store }.
 * @returns {Promise<{ skipped?: string, failures: number, files: object, elapsedMs: number }>}
 */
async function syncRestaurantProspects(deps = {}) {
  const started = Date.now();
  const result = { failures: 0, files: {}, elapsedMs: 0 };
  if (syncDisabled()) return { ...result, skipped: 'disabled' };
  await syncFiles({ fetchText: defaultFetchText, store: defaultStore, ...deps }, result);
  result.elapsedMs = Date.now() - started;
  const counts = Object.entries(result.files)
    .map(([k, f]) => `${k}=${f.failed ? 'failed' : f.upserted}${f.malformed ? `(${f.malformed} malformed)` : ''}`).join(' ');
  logger.info(`[dbpr-prospects] ${counts} failures=${result.failures} ${result.elapsedMs}ms`);
  return result;
}

module.exports = {
  syncRestaurantProspects,
  syncDisabled,
  parseUsDate,
  parseInspectionRows,
  parseLicenseRows,
  pickPhone,
  upsertRecords,
  pendingInspections,
  saveReport,
  bumpAttempts,
};
