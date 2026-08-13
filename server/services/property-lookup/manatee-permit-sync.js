'use strict';

/**
 * Manatee County pool-permit sync — pulls the public ACA "Pool Permits
 * (CSV)" report (reportID 22615) into pool_permit_records.
 *
 * Why (pool facts Step 3): the live GIS permits layer county-permits.js
 * queries carries OPEN permits only, and the PAO extra-features roll lags
 * a finished pool by up to a year. This report is the only public Manatee
 * source that includes CLOSED Pool-Spa permits, keyed by issued date.
 *
 * Fetch flow (live-probed 2026-08-13; ACA is ASP.NET WebForms):
 *   1. GET  ReportParameter.aspx?reportID=22615 → session cookie +
 *      __VIEWSTATE / __EVENTVALIDATION / ACA_CS_FIELD tokens.
 *   2. POST the same URL with __EVENTTARGET=btnSave and the two issued-date
 *      params (MM/DD/YYYY). Referer + Origin headers are REQUIRED — ACA's
 *      CSRF check rejects the post without them.
 *   3. GET  ShowReport.aspx (same session) → APPLICATION/CSV body.
 *
 * The report covers unincorporated Manatee County only (municipalities
 * permit separately) and Pool-Spa records only — screen enclosures
 * ("Aluminum Structure") are not in this report and remain GIS-only.
 *
 * Sync cadence: weekly cron (scheduler.js), trailing REFRESH_DAYS window so
 * statuses keep moving (Permit Issued → Closed). First enabled run on an
 * empty table backfills from BACKFILL_START in 6-month chunks. Everything
 * is inert unless GATE_PERMIT_SYNC is set (gate checked inside
 * syncPoolPermits — single source of truth), and every failure is
 * fail-open: the lookup path treats a missing/stale table as "no signal".
 *
 * Logs are prefixed `[pool-permit-sync]`; addresses and parcel ids never
 * appear in logs (AGENTS.md PII rule) — counts + elapsed only.
 */

const { parse: parseCsv } = require('csv-parse/sync');
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { addressKey } = require('../customer-properties');

const ACA_BASE = 'https://aca-prod.accela.com/MANATEE/Report/';
// Report registry (all live-probed 2026-08-13). Each report's parameter
// form has its own date-field ids; overridable without a deploy if the
// county rebuilds a report. The pool report is Pool-Spa records only; the
// two construction reports carry building-type/type-of-work vocabulary
// (no pool/enclosure/re-roof categories exist in any public report).
const REPORTS = {
  pool: {
    reportId: 22615,
    dateFromField: process.env.MANATEE_POOL_REPORT_DATE_FROM_FIELD || 'Date_26133',
    dateToField: process.env.MANATEE_POOL_REPORT_DATE_TO_FIELD || 'Date_26134',
  },
  // "Permits Issued by Date Range" — issued building permits (construction
  // start). Windowed by ISSUED date.
  under_construction: {
    reportId: 17907,
    dateFromField: process.env.MANATEE_UC_REPORT_DATE_FROM_FIELD || 'Date_21665',
    dateToField: process.env.MANATEE_UC_REPORT_DATE_TO_FIELD || 'Date_21666',
  },
  // "Certificates of Occupancy Issued by Date Range" — construction end /
  // brand-new-home ground truth. Windowed by CO date.
  cos: {
    reportId: 17709,
    dateFromField: process.env.MANATEE_CO_REPORT_DATE_FROM_FIELD || 'Date_21431',
    dateToField: process.env.MANATEE_CO_REPORT_DATE_TO_FIELD || 'Date_21432',
  },
};
const reportParamUrl = (reportId) => `${ACA_BASE}ReportParameter.aspx?module=&reportID=${reportId}&reportType=LINK_REPORT_LIST`;
const reportShowUrl = (reportId) => `${ACA_BASE}ShowReport.aspx?module=&reportID=${reportId}&reportType=LINK_REPORT_LIST`;

const DEFAULT_TIMEOUT_MS = 60000;
const BACKFILL_CHUNK_MONTHS = 6;
// Full-range sync starts (env-overridable — tests use a near date for a
// single window; ops can trim history without a deploy).
const poolSyncStartIso = () => process.env.POOL_PERMIT_SYNC_START || '2023-01-01';
const constructionSyncStartIso = () => process.env.CONSTRUCTION_PERMIT_SYNC_START || '2024-01-01';
const USER_AGENT = 'Mozilla/5.0 (WavesPortal pool-permit-sync)';

function syncTimeoutMs() {
  const n = Number(process.env.POOL_PERMIT_SYNC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

/** MM/DD/YYYY (the form's expected format) from a Date, UTC-based. */
function mdy(date) {
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${m}/${d}/${date.getUTCFullYear()}`;
}

/** Hidden-input value by name from an ASP.NET page. */
function hiddenValue(html, name) {
  const re = new RegExp(`name="${name.replace(/[$]/g, '\\$')}"[^>]*?value="([^"]*)"`);
  const m = html.match(re);
  return m ? m[1] : '';
}

async function fetchWithSession(url, { cookies, body, timeoutMs, referer }) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: referer,
    Origin: 'https://aca-prod.accela.com',
  };
  if (cookies.length) headers.Cookie = cookies.join('; ');
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Node fetch folds duplicate Set-Cookie into getSetCookie().
    for (const c of res.headers.getSetCookie?.() || []) {
      const pair = c.split(';')[0];
      if (pair) cookies.push(pair);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One report window → raw CSV text. Throws on any failure (callers decide
 * whether a window failure aborts the sync).
 */
async function fetchAcaReportCsv({ reportId, dateFromField, dateToField }, fromMdy, toMdy, timeoutMs = syncTimeoutMs()) {
  const cookies = [];
  const paramUrl = reportParamUrl(reportId);
  const referer = paramUrl;
  const paramPage = await (await fetchWithSession(paramUrl, { cookies, timeoutMs, referer })).text();
  const form = new URLSearchParams({
    __EVENTTARGET: 'btnSave',
    __EVENTARGUMENT: '',
    __VIEWSTATE: hiddenValue(paramPage, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hiddenValue(paramPage, '__VIEWSTATEGENERATOR'),
    __VIEWSTATEENCRYPTED: '',
    __EVENTVALIDATION: hiddenValue(paramPage, '__EVENTVALIDATION'),
    ACA_CS_FIELD: hiddenValue(paramPage, 'ACA_CS_FIELD'),
    [dateFromField]: fromMdy,
    [`${dateFromField}_ext_ClientState`]: '',
    [dateToField]: toMdy,
    [`${dateToField}_ext_ClientState`]: '',
  });
  const submit = await fetchWithSession(paramUrl, { cookies, body: form.toString(), timeoutMs, referer });
  const submitBody = await submit.text();
  if (!submitBody.includes('ShowReport.aspx')) {
    throw new Error('report submit did not yield a ShowReport redirect');
  }
  const report = await fetchWithSession(reportShowUrl(reportId), { cookies, timeoutMs, referer });
  const ctype = String(report.headers.get('content-type') || '');
  const text = await report.text();
  if (!/csv/i.test(ctype)) throw new Error(`report output is not CSV (${ctype || 'no content-type'})`);
  return text;
}

/** Pool-report window (kept as the named entry the tests and docs pin). */
async function fetchPoolPermitCsv(fromMdy, toMdy, timeoutMs = syncTimeoutMs()) {
  return fetchAcaReportCsv(REPORTS.pool, fromMdy, toMdy, timeoutMs);
}

/**
 * "13 digits ending 000" is the report's parcel-number shape for a base
 * parcel — the leading 10 digits are the PAO PIN the GIS layer keys on.
 * Anything else keeps its raw digits (still matchable, just less likely).
 */
function parcelPinFromRaw(parcelRaw) {
  const first = String(parcelRaw || '').split('-')[0].replace(/\D/g, '');
  if (!first) return null;
  if (first.length === 13 && first.endsWith('000')) return first.slice(0, 10);
  return first;
}

/**
 * Loose join key: house number + first street word + zip. Exists because the
 * report abbreviates suffixes the shared addressKey canon doesn't map
 * ("SAMPLE CV" never keys equal to "Sample Cove"). Null when the address
 * doesn't start with a house number — a loose key built from a street
 * without one would collide entire streets.
 */
function looseAddressKey(line1, zip) {
  const m = String(line1 || '').trim().toLowerCase().match(/^(\d+)\s+([a-z0-9]+)/);
  const z = (String(zip || '').match(/\d{5}/) || [''])[0];
  if (!m || !z) return null;
  return `${m[1]}${m[2]}${z}`;
}

/**
 * Loose key from a FREEFORM one-line address ("658 Sample Cove, Bradenton,
 * FL 34212") — house number + first street word + the LAST 5-digit group
 * (the zip; the house number itself can be 5 digits, so "first" is wrong).
 * Null when either anchor is missing.
 */
function looseKeyFromFreeform(address) {
  const s = String(address || '').trim().toLowerCase();
  const m = s.match(/^(\d+)\s+([a-z0-9]+)/);
  const zips = s.match(/\b\d{5}\b/g);
  const zip = zips ? zips[zips.length - 1] : null;
  if (!m || !zip || zip === m[1]) return null;
  return `${m[1]}${m[2]}${zip}`;
}

/** One CSV row (report headers) → a pool_permit_records row, or null. */
function normalizeRow(row) {
  const recordId = String(row['RECORD ID'] || '').trim();
  if (!recordId) return null;
  // "658 SAMPLE CV\nBRADENTON, 34212" — line 1 street, line 2 "CITY, ZIP".
  const addrBlock = String(row['ADDR FULL BLOCK'] || '');
  const [line1Raw = '', line2Raw = ''] = addrBlock.split(/\r?\n/);
  const line1 = line1Raw.trim();
  const cityZip = line2Raw.trim().match(/^(.*?),?\s*(\d{5})?$/) || [];
  const city = (cityZip[1] || '').replace(/,$/, '').trim() || null;
  const zip = cityZip[2] || null;
  const jobValue = Number(String(row['Applicant Job Value'] || '').replace(/[^0-9.]/g, ''));
  const issuedRaw = String(row['Permit Issued Date'] || '').trim();
  const issued = issuedRaw ? new Date(issuedRaw) : null;
  return {
    county: 'Manatee',
    record_id: recordId,
    record_status: String(row['RECORD STATUS'] || '').trim() || null,
    record_type: String(row['RECORD TYPE'] || '').trim() || null,
    project_type: String(row['Type of Project'] || '').trim() || null,
    job_value: Number.isFinite(jobValue) && jobValue > 0 ? jobValue : null,
    issued_date: issued && !Number.isNaN(issued.getTime())
      ? issued.toISOString().slice(0, 10)
      : null,
    address_line1: line1 || null,
    city,
    zip,
    parcel_raw: String(row['PARCEL NBR'] || '').trim() || null,
    parcel_pin: parcelPinFromRaw(row['PARCEL NBR']),
    address_key: line1 ? addressKey({ address_line1: line1, city, zip }) || null : null,
    address_loose_key: looseAddressKey(line1, zip),
    contractor_name: String(row['BUSINESS NAME'] || '').trim() || null,
    contractor_license: String(row['LICENSE NBR'] || '').trim() || null,
    owner_name: String(row['NAME FULL'] || '').trim() || null,
  };
}

function parsePoolPermitCsv(csvText) {
  const records = parseCsv(csvText.replace(/^﻿/, ''), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  return records.map(normalizeRow).filter(Boolean);
}

const UPSERT_CHUNK = 500;

/**
 * Last-wins dedupe on the upsert conflict key. Adjacent report windows
 * share their boundary date (ACA date params are inclusive), so boundary
 * records arrive twice — and two copies of one key in a single batched
 * INSERT .. ON CONFLICT chunk aborts the whole transaction ("command
 * cannot affect row a second time"). Last-wins keeps the later window's
 * (fresher) copy.
 */
function dedupeByKey(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(row[key], row);
  return [...map.values()];
}

/**
 * Chunked array upserts inside the caller's transaction. Rows in one call
 * MUST share the same key set (knex unions columns across an array insert
 * and would write NULL for keys a row omits — exactly what the per-report
 * construction rows rely on NOT happening).
 */
async function upsertChunked(trx, table, conflictCol, rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK).map((row) => ({ ...row, last_seen_at: trx.fn.now() }));
    const mergeCols = Object.keys(chunk[0]).filter((k) => k !== conflictCol && k !== 'county');
    try {
      await trx(table).insert(chunk).onConflict(conflictCol).merge(mergeCols);
    } catch (err) {
      // Sanitized rethrow: a raw Postgres error can echo row values
      // (owner names, addresses) via constraint details — the message
      // propagates into scheduler logs (AGENTS.md PII rule).
      throw new Error(`${table} upsert failed: ${err?.code || err?.name || 'db_error'}`);
    }
    written += chunk.length;
  }
  return written;
}

/** [from, to] UTC date pairs covering start→now in chunk-month steps. */
function windowsSince(startIso, chunkMonths) {
  const windows = [];
  const end = new Date();
  let cursor = new Date(`${startIso}T00:00:00Z`);
  while (cursor < end) {
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + chunkMonths);
    windows.push([mdy(cursor), mdy(next < end ? next : end)]);
    cursor = next;
  }
  return windows;
}

/**
 * Weekly sync entry point (scheduler). Gated inside (single source of
 * truth): a disabled gate returns {skipped:'gated'} before any fetch or DB
 * read. EVERY run re-syncs the full range from BACKFILL_START — no
 * refresh-mode inference: the tables are small (a few thousand rows/year),
 * so a full pass is ~7 report requests, and it structurally removes both
 * the partial-backfill trap (a half-written first load flipping later runs
 * into a truncated window) and the stale-status window (a permit Canceled
 * long after issuance is re-read every week). All windows are fetched
 * before anything is written, and the writes run in ONE transaction —
 * an aborted run leaves the previous sync intact.
 */
async function syncPoolPermits({ timeoutMs } = {}) {
  if (!gateEnvValue('GATE_PERMIT_SYNC')) return { skipped: 'gated' };
  const t0 = Date.now();
  const windows = windowsSince(poolSyncStartIso(), BACKFILL_CHUNK_MONTHS);
  const staged = [];
  for (const [from, to] of windows) {
    const csv = await fetchPoolPermitCsv(from, to, timeoutMs);
    staged.push(...parsePoolPermitCsv(csv));
  }
  // A full-range fetch that parses to ZERO rows is a schema break (renamed
  // headers make normalizeRow drop every record), never a real result —
  // years of history always contain permits. Failing loud beats a
  // "successful" 0-row sync that lets evidence silently go stale.
  if (!staged.length) throw new Error('pool report returned no parseable rows — schema change?');
  const allRows = dedupeByKey(staged, 'record_id');
  const fetched = allRows.length;
  const written = allRows.length
    ? await db.transaction((trx) => upsertChunked(trx, 'pool_permit_records', 'record_id', allRows))
    : 0;
  logger.info('[permit-sync] pool sync complete', {
    windows: windows.length,
    fetched,
    written,
    elapsedMs: Date.now() - t0,
  });
  return { windows: windows.length, fetched, written };
}

/**
 * Newest non-Canceled synced Pool-Spa permit for a parcel/address, or null.
 * Read path for county-permits.js — must stay cheap and fail-open (callers
 * swallow throws). Match precedence: parcel PIN, exact address key, loose
 * key. A Canceled permit is not pool evidence.
 */
async function findSyncedPoolPermit({ parcelPin, addrKey, looseKey } = {}) {
  // STRICT precedence, not an OR: a parcel match is authoritative, and an
  // OR'd loose key could let a NEWER permit from a neighboring parcel that
  // shares the loose key (same house number + street word + zip) outrank
  // it and fabricate pool evidence. Address keys are consulted only when
  // the parcel finds nothing.
  const tiers = [
    parcelPin ? ['parcel_pin', String(parcelPin)] : null,
    addrKey ? ['address_key', addrKey] : null,
    looseKey ? ['address_loose_key', looseKey] : null,
  ].filter(Boolean);
  let row = null;
  for (const [col, val] of tiers) {
    const query = db('pool_permit_records')
      .whereNot('record_status', 'Canceled')
      .where(col, val)
      .orderBy('issued_date', 'desc')
      .first();
    // Address-tier guard: the loose key drops the street SUFFIX ("101 Main
    // St" and "101 Main Ave" collide), so when the caller KNOWS the parcel,
    // an address-tier row asserting a DIFFERENT clean parcel is another
    // property — only pin-less/odd-format rows may rescue a pin miss.
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
    permitNo: row.record_id,
    type: 'Pool_Spa',
    issuedAt: row.issued_date
      ? new Date(row.issued_date).toISOString().slice(0, 10)
      : null,
    status: row.record_status || null,
  };
}

// ── Construction reports (Under Construction + COs Issued) ──

/**
 * The construction reports prepend HTML heading lines before the CSV
 * proper — the real header is the first line starting `"Permit"`.
 */
function stripReportPreamble(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('"Permit"'));
  if (start === -1) throw new Error('construction report CSV header not found');
  return lines.slice(start).join('\n');
}

const trimmed = (v) => String(v ?? '').trim() || null;

function reportDateToIso(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Last 5-digit group in a one-line job address is the zip. */
function zipFromJobAddress(address) {
  const zips = String(address || '').match(/\b\d{5}\b/g);
  return zips ? zips[zips.length - 1] : null;
}

/**
 * One construction-report CSV row → a construction_permit_records row, or
 * null. The two reports share most columns but differ on status/type-of-
 * work: under_construction has CurrentStatus + TypeofWork; cos has Status +
 * CODate. Keys absent from a report are OMITTED from the row so the upsert
 * merge never nulls a value the other report wrote.
 */
function normalizeConstructionRow(row, reportKey) {
  const permitNo = trimmed(row.Permit);
  if (!permitNo) return null;
  const address = trimmed(reportKey === 'under_construction' ? row.JobAddress : (row.JobAddress ?? row['Job Address']));
  const jobValue = Number(String(row.JobValue ?? '').replace(/[^0-9.]/g, ''));
  const out = {
    county: 'Manatee',
    permit_no: permitNo,
    status: trimmed(reportKey === 'under_construction' ? row.CurrentStatus : row.Status),
    permit_type: trimmed(row.Type),
    issued_date: reportDateToIso(row.IssuedDate),
    job_value: Number.isFinite(jobValue) && jobValue > 0 ? jobValue : null,
    address_raw: address,
    zip: zipFromJobAddress(address),
    parcel_raw: trimmed(row.Parcel),
    parcel_pin: parcelPinFromRaw(row.Parcel),
    address_loose_key: looseKeyFromFreeform(address),
    contractor_name: trimmed(row.BusName),
    contractor_license: trimmed(row['Lic Number']),
    owner_name: trimmed(row.Owner),
  };
  if (reportKey === 'under_construction') out.type_of_work = trimmed(row.TypeofWork);
  if (reportKey === 'cos') out.co_date = reportDateToIso(row.CODate);
  return out;
}

function parseConstructionCsv(csvText, reportKey) {
  const records = parseCsv(stripReportPreamble(csvText), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  return records.map((r) => normalizeConstructionRow(r, reportKey)).filter(Boolean);
}

/**
 * Sync both construction reports. Same full-range-every-run contract as
 * syncPoolPermits (all windows fetched first, ONE transaction, no
 * refresh-mode inference — see that function's comment). Per report the
 * rows share a uniform key set; the under_construction batch is written
 * before the cos batch so the CO merge lands on rows carrying
 * type_of_work, and separate per-report upsert calls keep knex's
 * column-union from writing NULLs into the other report's fields.
 */
async function syncConstructionPermits({ timeoutMs } = {}) {
  if (!gateEnvValue('GATE_PERMIT_SYNC')) return { skipped: 'gated' };
  const t0 = Date.now();
  const windows = windowsSince(constructionSyncStartIso(), BACKFILL_CHUNK_MONTHS);
  const staged = { under_construction: [], cos: [] };
  for (const reportKey of ['under_construction', 'cos']) {
    for (const [from, to] of windows) {
      const csv = await fetchAcaReportCsv(REPORTS[reportKey], from, to, timeoutMs);
      staged[reportKey].push(...parseConstructionCsv(csv, reportKey));
    }
    // Same schema-break guard as the pool sync: a full-range report that
    // parses to zero rows is a renamed-headers failure, not a result.
    if (!staged[reportKey].length) {
      throw new Error(`${reportKey} report returned no parseable rows — schema change?`);
    }
    staged[reportKey] = dedupeByKey(staged[reportKey], 'permit_no');
  }
  const fetched = staged.under_construction.length + staged.cos.length;
  const written = fetched
    ? await db.transaction(async (trx) => {
      const a = await upsertChunked(trx, 'construction_permit_records', 'permit_no', staged.under_construction);
      const b = await upsertChunked(trx, 'construction_permit_records', 'permit_no', staged.cos);
      return a + b;
    })
    : 0;
  logger.info('[permit-sync] construction sync complete', {
    windows: windows.length,
    fetched,
    written,
    elapsedMs: Date.now() - t0,
  });
  return { windows: windows.length, fetched, written };
}

/**
 * Scheduler entry: both synced sources under one gate. Each section runs
 * even when the other fails (a broken construction report must not stop
 * the pool sync), but ANY section failure re-throws after both have run —
 * a swallowed failure would record the cron as healthy while a report
 * stays broken indefinitely.
 */
async function syncPermits(options = {}) {
  if (!gateEnvValue('GATE_PERMIT_SYNC')) return { skipped: 'gated' };
  const out = { errors: [] };
  try {
    out.pool = await syncPoolPermits(options);
  } catch (err) {
    out.errors.push(`pool: ${err?.message || err}`);
  }
  try {
    out.construction = await syncConstructionPermits(options);
  } catch (err) {
    out.errors.push(`construction: ${err?.message || err}`);
  }
  if (out.errors.length) {
    const parts = [
      out.pool ? `pool ok (${out.pool.written} rows)` : null,
      out.construction ? `construction ok (${out.construction.written} rows)` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`permit sync failed: ${out.errors.join(' | ')}${parts ? ` — ${parts}` : ''}`);
  }
  return out;
}

const CONSTRUCTION_ACTIVE_MONTHS = 24;
const NEW_BUILD_CO_MONTHS = 18;
// A permit absent from the weekly full-range report re-sync (canceled or
// withdrawn without ever getting a CO) stops having its last_seen_at
// refreshed — after this many days unseen it no longer counts as active
// construction. Also fails quiet when the sync itself goes stale: a table
// nobody refreshes shouldn't keep asserting active construction.
const ACTIVE_SEEN_WITHIN_DAYS = 30;

function monthsAgoIso(months) {
  const d = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

const toIso = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

/**
 * Synced construction evidence for a parcel/address. Each signal is its own
 * TARGETED query (a row-scan capped at N let later trade/alteration permits
 * push the signal-carrying record out of the window):
 *   underConstruction — a permit issued within 24 months, no CO, status not
 *     terminal, AND still present in the county's current report
 *     (last_seen_at fresh — a vanished permit was canceled/withdrawn) →
 *     satellite imagery may predate the build.
 *   newBuild — a permit with type-of-work "New ..." whose CO is within 18
 *     months. FAIL CLOSED on missing type_of_work: a CO-report-only row
 *     (permit issued before the UC sync range) never counts — an
 *     alteration's CO must not read as a brand-new home.
 * Returns null when neither signal fires — no evidence is attached for
 * merely-has-permit-history parcels. Strict parcel-first precedence (the
 * loose key is only consulted when the parcel tier has no signal — an OR
 * would let a neighbor's permit fabricate evidence).
 */
async function findConstructionActivity({ parcelPin, looseKey } = {}) {
  const tiers = [
    parcelPin ? ['parcel_pin', String(parcelPin)] : null,
    looseKey ? ['address_loose_key', looseKey] : null,
  ].filter(Boolean);
  if (!tiers.length) return null;
  const activeFloor = monthsAgoIso(CONSTRUCTION_ACTIVE_MONTHS);
  const coFloor = monthsAgoIso(NEW_BUILD_CO_MONTHS);
  const seenAfter = new Date(Date.now() - ACTIVE_SEEN_WITHIN_DAYS * 24 * 60 * 60 * 1000);
  for (const [col, val] of tiers) {
    // Same address-tier parcel guard as findSyncedPoolPermit: with a known
    // parcel, a loose-key row asserting a DIFFERENT clean pin is another
    // property (the loose key drops street suffixes).
    const parcelGuard = (query) => {
      if (col !== 'parcel_pin' && parcelPin) {
        query.where((b) => b.whereNull('parcel_pin')
          .orWhere('parcel_pin', String(parcelPin))
          .orWhereRaw("parcel_pin !~ '^[0-9]{10}$'"));
      }
      return query;
    };
    const ucRow = await parcelGuard(db('construction_permit_records')
      .where(col, val)
      .whereNull('co_date')
      .where('issued_date', '>=', activeFloor)
      .where('last_seen_at', '>=', seenAfter)
      .whereRaw("LOWER(COALESCE(status, '')) NOT IN ('closed', 'canceled', 'withdrawn')")
      .orderBy('issued_date', 'desc'))
      .first();
    const nbRow = await parcelGuard(db('construction_permit_records')
      .where(col, val)
      .whereNotNull('co_date')
      .where('co_date', '>=', coFloor)
      .whereRaw("type_of_work ILIKE 'new%'")
      .orderBy('co_date', 'desc'))
      .first();
    if (ucRow || nbRow) {
      // Per-signal permit detail — one flat permitNo next to two flags let
      // a reader attribute the wrong permit to a signal when both fire.
      const shape = (row) => (row ? {
        permitNo: row.permit_no,
        status: row.status || null,
        permitType: row.permit_type || null,
        typeOfWork: row.type_of_work || null,
        issuedAt: toIso(row.issued_date),
        coIssuedAt: toIso(row.co_date),
      } : null);
      return {
        underConstruction: Boolean(ucRow),
        newBuild: Boolean(nbRow),
        activePermit: shape(ucRow),
        newBuildPermit: shape(nbRow),
      };
    }
  }
  return null;
}

module.exports = {
  syncPoolPermits,
  syncConstructionPermits,
  syncPermits,
  findSyncedPoolPermit,
  findConstructionActivity,
  looseAddressKey,
  looseKeyFromFreeform,
  _private: {
    fetchPoolPermitCsv,
    fetchAcaReportCsv,
    parsePoolPermitCsv,
    parseConstructionCsv,
    normalizeRow,
    normalizeConstructionRow,
    stripReportPreamble,
    zipFromJobAddress,
    parcelPinFromRaw,
    windowsSince,
    hiddenValue,
    mdy,
    REPORTS,
  },
};
