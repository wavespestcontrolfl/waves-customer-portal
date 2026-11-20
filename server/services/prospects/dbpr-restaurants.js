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
 * or on); the scheduler checks it before the run starts, so job_health keeps the last real outcome. A read with under
 * 90% of the rows of the fullest complete read of the same file and fiscal year is short (a download that stopped
 * early): its rows are written and the run fails (readProblem). That measure is kept in system_settings. A copy of
 * an older fiscal year than one already read, or a file with no row from the last 14 days, fails the same way.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { isInServiceAreaCounty } = require('../call-triage-flags');
const { isExcludedLocality, isExcludedZip } = require('../excluded-localities');
const { eachDbprCsvRow, defaultFetchText } = require('../commercial-suite-size/dbpr-food-license');
const { nanpNationalDigits, isValidNanpNumber } = require('../../utils/phone');
const { etDateString, etCalendarDaysUntil } = require('../../utils/datetime-et');

const EXTRACT_BASE = 'https://www2.myfloridalicense.com/sto/file_download/extracts/';
const FILES = {
  inspection: '7fdinspi.csv',
  new_license: 'newfood.csv',
  owner_change: 'chgownr_food.csv',
};
// Every column a parser reads. A row without one is skipped and counted (hasEveryColumn): no License ID would store
// inspections whose report can never be read, no city or ZIP would let Punta Gorda rows through, and a renamed name,
// address or phone column would store blanks that no later file repairs (a known key only refreshes last_seen_at).
// An empty cell is still allowed. The two license files share one layout. loadFile refuses a whole file whose
// header lacks one.
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
    'License Type Code', 'License ID', 'Inspection Visit ID', 'Visit Number', 'Inspection Date', 'Inspection Type',
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

// PostgreSQL text and jsonb refuse a NUL character, and one in any field would fail its whole insert batch: it
// becomes a space here, where every stored text value passes.
const clean = (v, max) => {
  const s = String(v == null ? '' : v).replaceAll('\0', ' ').replace(/\s+/g, ' ').trim();
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
// list of those places; it decides by city name or by a Punta Gorda-only ZIP. Each value is cleaned first, as it is
// stored: a check on the raw value could pass a city whose stored copy is excluded ("PUNTA\0GORDA" stores as
// "PUNTA GORDA").
// A row with no county cannot be placed: it is malformed, not outside the area, so a file whose county cells went
// blank fails instead of passing with no prospects. A blank city or ZIP only means no excluded place.
function hasNoCounty(county) {
  return !clean(county);
}

function inServiceArea(county, city, zip) {
  return isInServiceAreaCounty(clean(county)) && !isExcludedLocality(clean(city)) && !isExcludedZip(clean(zip));
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

// A visit number: a whole number from 1, or null when blank or 0 (not known); undefined when it does not read
// ("Visit 1"), which makes the row malformed, like a bad date.
function visitNumberOf(value) {
  const text = clean(value);
  if (!text) return null;
  const number = wholeNumber(text);
  if (number === null) return undefined;
  return number || null;
}

// The public report page's address is built from these two ids only (the page reads are the next change), so both
// must be digits.
const ID_RE = /^\d{1,12}$/;

// csv-parse keeps a row cut short, with only the cells it has. Such a row is skipped and counted: stored, it would
// keep blanks that no later file repairs. An empty cell is a cell, so it passes. The parsers test this before the
// area, as a row cut before its county cannot be placed at all. Each row in the area is then checked whole and,
// when it passes, counted as good (counts.valid), cited or not, so a caller can tell a quiet file from a broken one.
function hasEveryColumn(row, kind) {
  return REQUIRED_COLUMNS[kind].every((column) => column in row);
}

// Notes a copy's visit number against its visit: the highest one any copy gives wins.
function noteHighest(highest, key, number) {
  if (key && number) highest.set(key, Math.max(highest.get(key) || 0, number));
}

// The record with the highest visit number any copy of its visit gave (noteHighest), or the record as it is.
function raiseVisit(record, visits) {
  const highest = visits.get(record.source_key);
  return highest ? { ...record, detail: { ...record.detail, visitNumber: highest } } : record;
}

/**
 * Inspection rows -> one record per visit that cited violation 35, in the three counties. A row cut short, or a row
 * in the area with a bad report id, date (or one after `today`, when given), violation-35 count or visit number, is
 * skipped and counted in counts.malformed; a row in the area that passes counts in counts.valid, cited or not.
 * Every copy of a visit in the area whose visit number reads, cited or not, valid or not, notes it in `visits`, and
 * each record takes the highest: a visit any copy names as a later visit (a callback listed once more as visit 1)
 * is never a first visit. loadFile reads a row at a time, so it passes one `visits` for the whole file and raises
 * the kept records again once every row is read.
 */
function parseInspectionRows(rows, counts = {}, today = null, visits = new Map()) {
  counts.malformed ??= 0;
  counts.valid ??= 0;
  const out = [];
  for (const row of rows) {
    if (!hasEveryColumn(row, 'inspection')) {
      counts.malformed += 1;
      continue;
    }
    if (hasNoCounty(row['County Name'])) {
      counts.malformed += 1;
      continue;
    }
    if (!inServiceArea(row['County Name'], row['Location City'], row['Location Zip Code'])) continue;
    const sourceKey = clean(row['Inspection Visit ID']);
    const licenseId = clean(row['License ID'], 40);
    const eventDate = parseUsDate(row['Inspection Date']);
    const cited = wholeNumber(row['Violation 35']);
    const visitNumber = visitNumberOf(row['Visit Number']);
    noteHighest(visits, sourceKey, visitNumber);
    // A row without both report ids is left out: its report could never be read, and once stored it would block a
    // corrected copy (a known key only refreshes last_seen_at). A later file with the ids adds it.
    if (!ID_RE.test(sourceKey || '') || !ID_RE.test(licenseId || '') || !eventDate || (today && eventDate > today) || cited === null
      || visitNumber === undefined) {
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
        // The violation-35 citations the file counted: a report page that lists fewer cannot answer.
        violation35: cited,
        // Which visit of the inspection this is: only the first visit's report page answers. A 0 or a blank is not
        // known: null, so a re-read of a later file fills it.
        visitNumber,
      },
    });
  }
  return out.map((record) => raiseVisit(record, visits));
}

/**
 * New-license or ownership-change rows (same layout) -> one record per application in the three counties. A row cut
 * short, or a row in the area with no application number, one longer than the key column, or no real approval date
 * (or one after `today`, when given: a mistyped date), is skipped and counted in counts.malformed: once stored, a
 * known key only refreshes last_seen_at, so a corrected copy in a later file could never fill it in. A row kept
 * counts in counts.valid.
 */
function parseLicenseRows(rows, kind, counts = {}, today = null) {
  counts.malformed ??= 0;
  counts.valid ??= 0;
  const out = [];
  for (const row of rows) {
    if (!hasEveryColumn(row, kind)) {
      counts.malformed += 1;
      continue;
    }
    if (hasNoCounty(row['Location County'])) {
      counts.malformed += 1;
      continue;
    }
    if (!inServiceArea(row['Location County'], row['Location City'], row['Location Zip Code'])) continue;
    const sourceKey = clean(row['Application Number']);
    const eventDate = parseUsDate(row['Application Approval Date']);
    if (!sourceKey || sourceKey.length > KEY_MAX || !eventDate || (today && eventDate > today)) {
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

// ── Store ───────────────────────────────────────────────────────

// One record per (kind, source_key); a repeated key keeps its last copy. PostgreSQL refuses an upsert that names the
// same row twice in one statement. A repeated inspection keeps the highest violation-35 count and the highest visit
// number its copies give, as a re-read of another file does (FILL_DETAIL_SQL).
function dedupeByKey(records) {
  const byKey = new Map();
  for (const record of records) {
    const key = `${record.kind}|${record.source_key}`;
    const before = byKey.get(key);
    byKey.set(key, before && record.kind === 'inspection' ? withFileValues(record, before) : record);
  }
  return [...byKey.values()];
}

// The later copy of an inspection, with the highest count and the highest visit number of the two copies.
function withFileValues(record, before) {
  const highest = (key) => {
    const values = [before.detail[key], record.detail[key]].filter(Number.isInteger);
    return values.length ? Math.max(...values) : null;
  };
  return { ...record, detail: { ...record.detail, violation35: highest('violation35'), visitNumber: highest('visitNumber') } };
}

// What a re-read takes from the file into detail. A missing count or visit number is filled (stored before they were
// kept, or blank: JSON null, so ->> tests it). While the row is unanswered (pest_evidence NULL), each only rises: the
// higher count (the missing citation could be 35A) and the higher visit number (once any file names a later visit,
// the row stays a later visit, so a stale file cannot make a callback a first visit again). jsonb compares numbers
// as numbers. A blank in the file erases nothing (jsonb_strip_nulls), and nothing else in detail changes.
const FILL_DETAIL_SQL = `COALESCE(restaurant_prospects.detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'violation35', CASE WHEN restaurant_prospects.detail->>'violation35' IS NULL OR (restaurant_prospects.pest_evidence IS NULL
    AND excluded.detail->'violation35' > restaurant_prospects.detail->'violation35') THEN excluded.detail->'violation35' END,
  'visitNumber', CASE WHEN restaurant_prospects.detail->>'visitNumber' IS NULL OR (restaurant_prospects.pest_evidence IS NULL
    AND excluded.detail->'visitNumber' > restaurant_prospects.detail->'visitNumber') THEN excluded.detail->'visitNumber' END))`;

// A re-read of a known row refreshes last_seen_at and the two keys above: a pest_evidence answer, the findings and the
// attempt count are never overwritten by a later file. Returns the number of rows written.
async function upsertRecords(records) {
  const unique = dedupeByKey(records);
  let n = 0;
  for (let i = 0; i < unique.length; i += UPSERT_CHUNK) {
    const chunk = unique.slice(i, i + UPSERT_CHUNK).map((r) => ({ ...r, detail: JSON.stringify(r.detail) }));
    await db('restaurant_prospects').insert(chunk).onConflict(['kind', 'source_key'])
      .merge({ last_seen_at: db.fn.now(), detail: db.raw(FILL_DETAIL_SQL) });
    n += chunk.length;
  }
  return n;
}

// The unanswered first visits to read, newest first, at most `limit`: inspections of the window (event_date on or
// after `cutoff`) under the attempt cap, whose key is in `keys`. `keys` holds the visits the run's own good read of
// the inspection file lists as first visits with a violation-35 citation, so a visit a later file corrected, dropped
// or replayed from an older file is never read. No keys, no rows.
async function pendingInspections({ cutoff, limit, keys }) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const rows = await db('restaurant_prospects')
    .where({ kind: 'inspection' })
    .whereIn('source_key', keys)
    .whereNull('pest_evidence')
    .where('detail_attempts', '<', REPORT_MAX_ATTEMPTS)
    .where('event_date', '>=', cutoff)
    // First visits only: the report parser (the next part) answers for no other. A row stored before the visit number
    // was kept waits until a re-read of the file fills it.
    .whereRaw("detail->>'visitNumber' = '1'")
    .orderBy('event_date', 'desc')
    .limit(limit)
    .select(
      'id', 'license_id', 'source_key',
      db.raw("detail->>'violation35' AS violation35"),
      db.raw(`detail->>'visitNumber' AS "visitNumber"`),
      db.raw(`to_char(event_date, 'YYYY-MM-DD') AS "visitDate"`),
    );
  // The file's count, the visit number and the visit's date, by the names the report parser (the next part) reads.
  return rows.map((row) => ({ ...row, violation35: wholeNumber(row.violation35), visitNumber: wholeNumber(row.visitNumber) }));
}

// Saves a page's answer for the read it came from (a pendingInspections row: id, violation35, visitNumber), only while
// the row is unanswered and still holds that count and visit number: a file re-read in between (a higher count)
// leaves the row for a later read. Returns whether the answer was saved.
async function saveReport(read, report) {
  const asText = (value) => (value === null || value === undefined ? null : String(value));
  const saved = await db('restaurant_prospects')
    .where({ id: read.id })
    .whereNull('pest_evidence')
    .whereRaw("detail->>'violation35' IS NOT DISTINCT FROM ?", [asText(read.violation35)])
    .whereRaw("detail->>'visitNumber' IS NOT DISTINCT FROM ?", [asText(read.visitNumber)])
    .update({
      pest_evidence: report.pestEvidence,
      detail: db.raw("COALESCE(detail, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ findings: report.findings })]),
    });
  return saved > 0;
}

async function bumpAttempts(id) {
  await db('restaurant_prospects').where({ id }).increment('detail_attempts', 1);
}

// The fullest complete read of each file in its fiscal year, kept in system_settings: how many rows it held and the
// fiscal year. settleRead judges a read against it and saves the read in one transaction, under a lock on the file's
// key (judgeRead): two runs that overlap are judged one after the other, each against the measure the other left.
// The job settles a read only after every row of it is stored, so a read cut off by a failed write or a deploy never
// becomes the measure.
const readSettingKey = (kind) => `restaurant_prospects_read_${kind}`;

// A stored read, or null for anything else: a damaged year would make every later read look stale.
function parseRead(text) {
  try {
    const value = JSON.parse(text);
    const valid = value && /^\d{4}-07-01$/.test(value.fiscalYear) && Number.isInteger(value.rows) && value.rows >= 0;
    return valid ? { fiscalYear: value.fiscalYear, rows: value.rows } : null;
  } catch {
    return null;
  }
}

// Returns the read's problem (readProblem), or null.
async function settleRead(kind, read, now) {
  const key = readSettingKey(kind);
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [key]);
    const row = await trx('system_settings').where({ key }).first('value');
    const { problem, save } = judgeRead(parseRead(row && row.value), read, now);
    if (save) {
      const value = JSON.stringify(save);
      await trx('system_settings').insert({ key, value, category: 'prospects' })
        .onConflict('key').merge({ value, updated_at: db.fn.now() });
    }
    return problem;
  });
}

// ── Weekly job ──────────────────────────────────────────────────

const defaultStore = { upsertRecords, settleRead };

// The row width each file has, as cells minus header names. The inspection file fills every header column. The
// license files never fill their last two (Base Risk Level, Secondary Risk Level): every row of the 2026-11-20 files
// has 36 cells under 38 names. Any other width means a cell went missing or crept in and every cell after it moved:
// a shifted phone, license number or report id would pass every other check. Such a row is malformed, a 38-cell
// license row too (two stray cells reach 38). So a file that starts to fill the risk levels fails, by the rule
// below, until this width is changed.
const ROW_WIDTHS = { inspection: 0, new_license: -2, owner_change: -2 };
// Malformed rows may be at most this share of the rows that count (loadFile).
const MALFORMED_SHARE = 0.1;

// The column with each row's own date. The state cuts each file by it: every row of the 2026-11-20 files falls in
// one fiscal year.
const DATE_COLUMN = { inspection: 'Inspection Date', new_license: 'Application Approval Date', owner_change: 'Application Approval Date' };

async function loadFile(kind, fetchText, now) {
  const text = await fetchText(`${EXTRACT_BASE}${FILES[kind]}`, FILE_TIMEOUT_MS);
  const counts = { malformed: 0, valid: 0 };
  const records = [];
  const today = etDateString(now);
  let rowsRead = 0;
  // Each fiscal year's row count and newest date, by the row's own date.
  const years = new Map();
  // Good rows in the area, cited or not, by fiscal year.
  const goodByYear = new Map();
  // The highest visit number each inspection visit's copies give, from anywhere in the file (parseInspectionRows).
  const visits = new Map();
  // A row at a time, so the server keeps answering requests and only the kept records stay in memory.
  const header = await eachDbprCsvRow(text, (row, { cells, columns }) => {
    rowsRead += 1;
    if (cells - columns !== ROW_WIDTHS[kind]) {
      counts.malformed += 1;
      return;
    }
    const day = parseUsDate(row[DATE_COLUMN[kind]]);
    // A row dated after today (Eastern) is a mistyped date: it never makes a file look fresh or of a later year. The
    // parsers skip it, counted as malformed only when it is in the area (stored, it would stay wrong).
    if (day && day <= today) {
      const year = fiscalYearOf(day);
      const seen = years.get(year) || { rows: 0, newest: day };
      years.set(year, { rows: seen.rows + 1, newest: day > seen.newest ? day : seen.newest });
    }
    const good = counts.valid;
    records.push(...(kind === 'inspection' ? parseInspectionRows([row], counts, today, visits) : parseLicenseRows([row], kind, counts, today)));
    if (counts.valid > good && day) goodByYear.set(fiscalYearOf(day), (goodByYear.get(fiscalYearOf(day)) || 0) + 1);
  });
  // A required column missing from the header is renamed or gone. One named twice would take the later cell (a
  // renamed column could give two applications one key). Either way the whole file is refused.
  if (REQUIRED_COLUMNS[kind].some((column) => header.filter((name) => name === column).length !== 1)) {
    throw new Error('unexpected file layout');
  }
  // A header with no rows is a download cut short, not a quiet week, so the file fails. The files start over on
  // July 1, so in the first week of July (Eastern date; it spans the July 4 holiday) a header alone may be a new year
  // with nothing in it yet: it passes here, and readProblem fails it once a read of the new year has held a row. A
  // file whose rows all fall outside the area is fine.
  if (!rowsRead && !/-07-0[1-7]$/.test(today)) throw new Error('empty file');
  // Rows without one readable date up to today leave nothing to measure the file by (a cut file of rows outside the
  // area, say): it fails. Only a header alone, above, reads with no fiscal year.
  if (rowsRead && !years.size) throw new Error('no dated row');
  // The fiscal year most rows fall in (null for a header alone), with that year's row count and newest date, so a
  // stray date of another year never moves a file, makes it look fresh or swells its measure.
  const [fiscalYear, year] = [...years].sort((a, b) => b[1].rows - a[1].rows)[0] || [null, null];
  // A good row in the area dated in another fiscal year is a stray date (a mistyped one, or a file the state started
  // over late), whether it cites violation 35 or not. Stored, it would stay wrong (a known key only refreshes
  // last_seen_at), so like a date after today it is malformed and not kept; the file of its own year stores it.
  const otherYears = [...goodByYear].reduce((sum, [y, rows]) => (y === fiscalYear ? sum : sum + rows), 0);
  counts.malformed += otherYears;
  counts.valid -= otherYears;
  // A copy of a visit later in the file than its kept record (a callback listed again, uncited) raises it here, once
  // every row is read. Only inspection rows fill `visits`.
  const kept = records.filter((record) => fiscalYearOf(record.event_date) === fiscalYear).map((record) => raiseVisit(record, visits));
  // Malformed rows over a tenth of the rows that count mean a changed format (a new date format, rows of a new
  // width), not a stray row: the file fails, even beside good rows. With no good row, one malformed row fails it. The
  // rows that count are the good and malformed ones: malformed counts rows in the area and rows that cannot be placed
  // (a wrong width) or that are dated in another fiscal year; a row outside the area never counts, whatever its date. A file whose rows all fall outside the
  // area, or whose good rows cite nothing, succeeds. Each file holds the whole year, so a later good read still
  // writes every row.
  if (counts.malformed > (counts.valid + counts.malformed) * MALFORMED_SHARE) throw new Error('too many malformed rows');
  return { records: kept, malformed: counts.malformed, rows: year ? year.rows : 0, fiscalYear, newest: year && year.newest };
}

// The first day (July 1) of the fiscal year a day (YYYY-MM-DD) falls in.
function fiscalYearOf(day) {
  const [year, month] = day.split('-').map(Number);
  return `${month >= 7 ? year : year - 1}-07-01`;
}

// Each file holds one fiscal year and only grows until the state starts it over, so a full read holds at least about
// as many rows as the fullest complete read of the same year (the measure). A download that stopped early but ends on
// a whole row passes every check in loadFile. So a complete read also fails when (readProblem):
//   stale   its fiscal year is earlier than the measure's (an older copy, a cache say), or no row is from the last
//           14 days (a frozen file: the state posts every day; this also ends a June file served on into July);
//   short   it holds under 90% of the measure's rows (under 20 rows in the measure the check waits), or it is a
//           header alone after a read of the same fiscal year held a row (loadFile passes one only in early July).
// Its rows are still written (each one is whole and valid), the run counts a failure, and the read never becomes
// the measure, so a download cut at the same place each week fails each week. A read belongs to the fiscal year of
// its rows, so a file the state starts over late is still last year's file, and only the rows of that year count
// (kept or not, in the area or not): other years' rows never swell the measure. If the
// state truly removed rows, check the file by hand, then delete the system_settings row
// restaurant_prospects_read_<kind>: the next read sets the measure again.
const SHORT_SHARE = 0.9;
const SHORT_MIN_ROWS = 20;
const FRESH_DAYS = 14;
const READ_FLAGS = ['stale', 'short'];

function readProblem(last, read, now) {
  // A header alone (loadFile passes one only in the first week of July) has no year or date to measure: it is the new
  // year starting, until a read of the new year has held a row.
  if (!read.fiscalYear) {
    return last && last.fiscalYear === fiscalYearOf(etDateString(now)) && last.rows > 0
      ? { flag: 'short', text: `is short: no rows, after a read of this fiscal year held ${last.rows}` }
      : null;
  }
  if (last && read.fiscalYear < last.fiscalYear) {
    return { flag: 'stale', text: `is stale: its rows are from the fiscal year that began ${read.fiscalYear}, after a read of ${last.fiscalYear}` };
  }
  if (!read.newest || etCalendarDaysUntil(read.newest, now) < -FRESH_DAYS) {
    return { flag: 'stale', text: `is stale: no row from the last ${FRESH_DAYS} days (newest ${read.newest || 'none'})` };
  }
  if (last && last.fiscalYear === read.fiscalYear && last.rows >= SHORT_MIN_ROWS && read.rows < last.rows * SHORT_SHARE) {
    return { flag: 'short', text: `is short: ${read.rows} rows, the fullest complete read had ${last.rows}` };
  }
  return null;
}

// The verdict on a read against the stored measure (last), and the read to store in its place: one with no problem
// that is fuller (a newer fiscal year, or more rows in the same year). A header alone is never stored.
function judgeRead(last, read, now) {
  const problem = readProblem(last, read, now);
  const fuller = !last || read.fiscalYear > last.fiscalYear || (read.fiscalYear === last.fiscalYear && read.rows > last.rows);
  const save = !problem && Boolean(read.fiscalYear) && fuller;
  return { problem, save: save ? { fiscalYear: read.fiscalYear, rows: read.rows } : null };
}

async function syncFiles(deps, result) {
  for (const kind of Object.keys(FILES)) {
    try {
      const { records, malformed, rows, fiscalYear, newest } = await loadFile(kind, deps.fetchText, deps.now);
      const unique = dedupeByKey(records);
      result.files[kind] = { kept: unique.length, malformed, upserted: await deps.store.upsertRecords(unique) };
      // Judged only once every row of this read is stored (settleRead). The rows are whole and valid, so they stay
      // written even when the read fails.
      const problem = await deps.store.settleRead(kind, { fiscalYear, rows, newest }, deps.now);
      if (problem) {
        result.failures += 1;
        result.files[kind][problem.flag] = true;
        logger.warn(`[dbpr-prospects] ${kind} file ${problem.text}`);
      }
    } catch (err) {
      result.failures += 1;
      result.files[kind] = { failed: true };
      logger.warn(`[dbpr-prospects] ${kind} file failed (${err.code || err.name})`);
    }
  }
}

/**
 * The weekly job. Never throws: each file's failure is counted in the result. `deps` is for tests:
 * { fetchText, store, now }.
 * @returns {Promise<{ skipped?: string, failures: number, files: object, elapsedMs: number }>}
 */
async function syncRestaurantProspects(deps = {}) {
  const started = Date.now();
  const result = { failures: 0, files: {}, elapsedMs: 0 };
  if (syncDisabled()) return { ...result, skipped: 'disabled' };
  await syncFiles({ fetchText: defaultFetchText, store: defaultStore, now: new Date(), ...deps }, result);
  result.elapsedMs = Date.now() - started;
  const counts = Object.entries(result.files)
    .map(([k, f]) => `${k}=${f.failed ? 'failed' : f.upserted}${READ_FLAGS.filter((flag) => f[flag]).map((flag) => `(${flag})`).join('')}`
      + `${f.malformed ? `(${f.malformed} malformed)` : ''}`)
    .join(' ');
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
  settleRead,
  judgeRead,
};
