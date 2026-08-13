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
 * is inert unless GATE_POOL_PERMIT_SYNC is set (gate checked inside
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
const REPORT_QS = 'module=&reportID=22615&reportType=LINK_REPORT_LIST';
const PARAM_URL = `${ACA_BASE}ReportParameter.aspx?${REPORT_QS}`;
const SHOW_URL = `${ACA_BASE}ShowReport.aspx?${REPORT_QS}`;
// Field ids on the parameter form (Issued Date From / To). Live-probed;
// overridable without a deploy if the county rebuilds the report.
const DATE_FROM_FIELD = process.env.MANATEE_POOL_REPORT_DATE_FROM_FIELD || 'Date_26133';
const DATE_TO_FIELD = process.env.MANATEE_POOL_REPORT_DATE_TO_FIELD || 'Date_26134';

const DEFAULT_TIMEOUT_MS = 60000;
const REFRESH_DAYS = 180;
const BACKFILL_START = '2023-01-01';
const BACKFILL_CHUNK_MONTHS = 6;
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

async function fetchWithSession(url, { cookies, body, timeoutMs }) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: PARAM_URL,
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
async function fetchPoolPermitCsv(fromMdy, toMdy, timeoutMs = syncTimeoutMs()) {
  const cookies = [];
  const paramPage = await (await fetchWithSession(PARAM_URL, { cookies, timeoutMs })).text();
  const form = new URLSearchParams({
    __EVENTTARGET: 'btnSave',
    __EVENTARGUMENT: '',
    __VIEWSTATE: hiddenValue(paramPage, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hiddenValue(paramPage, '__VIEWSTATEGENERATOR'),
    __VIEWSTATEENCRYPTED: '',
    __EVENTVALIDATION: hiddenValue(paramPage, '__EVENTVALIDATION'),
    ACA_CS_FIELD: hiddenValue(paramPage, 'ACA_CS_FIELD'),
    [DATE_FROM_FIELD]: fromMdy,
    [`${DATE_FROM_FIELD}_ext_ClientState`]: '',
    [DATE_TO_FIELD]: toMdy,
    [`${DATE_TO_FIELD}_ext_ClientState`]: '',
  });
  const submit = await fetchWithSession(PARAM_URL, { cookies, body: form.toString(), timeoutMs });
  const submitBody = await submit.text();
  if (!submitBody.includes('ShowReport.aspx')) {
    throw new Error('report submit did not yield a ShowReport redirect');
  }
  const report = await fetchWithSession(SHOW_URL, { cookies, timeoutMs });
  const ctype = String(report.headers.get('content-type') || '');
  const text = await report.text();
  if (!/csv/i.test(ctype)) throw new Error(`report output is not CSV (${ctype || 'no content-type'})`);
  return text;
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
 * ("COTELLA CV" never keys equal to "Cotella Cove"). Null when the address
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
 * Loose key from a FREEFORM one-line address ("658 Cotella Cove, Bradenton,
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
  // "658 COTELLA CV\nBRADENTON, 34212" — line 1 street, line 2 "CITY, ZIP".
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

async function upsertRows(rows) {
  let written = 0;
  for (const row of rows) {
    await db('pool_permit_records')
      .insert({ ...row, last_seen_at: db.fn.now() })
      .onConflict('record_id')
      .merge({
        record_status: row.record_status,
        job_value: row.job_value,
        issued_date: row.issued_date,
        address_line1: row.address_line1,
        city: row.city,
        zip: row.zip,
        parcel_raw: row.parcel_raw,
        parcel_pin: row.parcel_pin,
        address_key: row.address_key,
        address_loose_key: row.address_loose_key,
        contractor_name: row.contractor_name,
        contractor_license: row.contractor_license,
        owner_name: row.owner_name,
        last_seen_at: db.fn.now(),
      });
    written += 1;
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
 * truth): a disabled gate returns {skipped:'gated'} before any DB read.
 * Empty table → chunked backfill from BACKFILL_START; otherwise a trailing
 * REFRESH_DAYS window so statuses keep converging. A window fetch failure
 * aborts the run (partial windows would look like "synced through today").
 */
async function syncPoolPermits({ timeoutMs } = {}) {
  if (!gateEnvValue('GATE_POOL_PERMIT_SYNC')) return { skipped: 'gated' };
  const t0 = Date.now();
  const existing = await db('pool_permit_records').count('id as n').first();
  const empty = !Number(existing?.n || 0);
  const windows = empty
    ? windowsSince(BACKFILL_START, BACKFILL_CHUNK_MONTHS)
    : (() => {
      const from = new Date(Date.now() - REFRESH_DAYS * 24 * 60 * 60 * 1000);
      return [[mdy(from), mdy(new Date())]];
    })();

  let fetched = 0;
  let written = 0;
  for (const [from, to] of windows) {
    const csv = await fetchPoolPermitCsv(from, to, timeoutMs);
    const rows = parsePoolPermitCsv(csv);
    fetched += rows.length;
    written += await upsertRows(rows);
  }
  logger.info('[pool-permit-sync] sync complete', {
    mode: empty ? 'backfill' : 'refresh',
    windows: windows.length,
    fetched,
    written,
    elapsedMs: Date.now() - t0,
  });
  return { mode: empty ? 'backfill' : 'refresh', windows: windows.length, fetched, written };
}

/**
 * Newest non-Canceled synced Pool-Spa permit for a parcel/address, or null.
 * Read path for county-permits.js — must stay cheap and fail-open (callers
 * swallow throws). Match precedence: parcel PIN, exact address key, loose
 * key. A Canceled permit is not pool evidence.
 */
async function findSyncedPoolPermit({ parcelPin, addrKey, looseKey } = {}) {
  if (!parcelPin && !addrKey && !looseKey) return null;
  const query = db('pool_permit_records')
    .whereNot('record_status', 'Canceled')
    .orderBy('issued_date', 'desc')
    .first();
  query.where((b) => {
    let started = false;
    const add = (col, val) => {
      if (!val) return;
      if (started) b.orWhere(col, val);
      else b.where(col, val);
      started = true;
    };
    add('parcel_pin', parcelPin ? String(parcelPin) : null);
    add('address_key', addrKey);
    add('address_loose_key', looseKey);
  });
  const row = await query;
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

module.exports = {
  syncPoolPermits,
  findSyncedPoolPermit,
  looseAddressKey,
  looseKeyFromFreeform,
  _private: {
    fetchPoolPermitCsv,
    parsePoolPermitCsv,
    normalizeRow,
    parcelPinFromRaw,
    windowsSince,
    hiddenValue,
    mdy,
  },
};
