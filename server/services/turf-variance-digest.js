'use strict';

// Weekly owner exception email: lawn turf estimates vs field actuals.
//
// The nightly estimate-actuals reconcile (estimate-actuals.js) already writes
// turf_delta_pct — (treated − estimated) / estimated — per completed lawn
// service; the ledger surfaces on /admin/estimates but nothing pushed a drift
// signal to the owner (2026-08-05 audit: a vision overshoot class only shows
// up when someone goes looking). This module reads that ledger and emails
// ONLY when the last 30 days drift past a threshold — exception-based per the
// hands-off rule: a green window sends nothing, ever.
//
// Subject grammar follows the ops-email convention (first word = the owner's
// action): ACT because a drifting estimator needs a recalibration/field-check
// decision. Direction wording: turf_delta_pct is positive when the treated
// area EXCEEDS the estimate, i.e. estimates are running LOW (underpriced);
// negative → HIGH (overpriced).
//
// Live by default with a kill switch (TURF_VARIANCE_DIGEST_DISABLED=1) —
// the owner asked for this rollup explicitly, and its quiet state is the
// common one. Cron wiring: Mondays 7:05am ET in scheduler.js, inside
// runExclusive so a deploy-overlap tick can't double-send.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');

const digestDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.TURF_VARIANCE_DIGEST_DISABLED || '').toLowerCase());
const digestEmail = () => process.env.TURF_VARIANCE_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const WINDOW_DAYS = 30;
// |avg turf delta| that turns a quiet ledger into an ACT email, and the
// minimum sample count below which an average is noise. Env-tunable so the
// owner can tighten/loosen without a deploy.
const alertPct = () => {
  const n = Number(process.env.TURF_VARIANCE_ALERT_PCT);
  return Number.isFinite(n) && n > 0 ? n : 15;
};
const minSamples = () => {
  const n = Number(process.env.TURF_VARIANCE_MIN_SAMPLES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
const OUTLIER_LIMIT = 5;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtPct(value) {
  const n = Number(value);
  return `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}%`;
}

function fmtSqFt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString()} sq ft` : '—';
}

// Rows with a turf comparison inside the ET-anchored window. `estimated` /
// `actual` are the ledger's JSONB snapshots ({ turfSqFt } / { treatedSqft });
// turf_delta_pct is the precomputed scalar.
async function loadTurfWindow() {
  return db('estimate_actuals')
    .whereNotNull('turf_delta_pct')
    .where('service_date', '>=', db.raw(`(now() at time zone 'America/New_York')::date - ?::int`, [WINDOW_DAYS]))
    .select('service_record_id', 'service_date', 'estimated', 'actual', 'turf_delta_pct')
    .orderBy('service_date', 'desc');
}

function jsonField(value, key) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return (JSON.parse(value) || {})[key]; } catch { return null; }
  }
  return value[key];
}

// Pure composition: null = nothing worth an email (the common, quiet case).
function composeTurfVarianceDigest(rows, { thresholdPct = alertPct(), samplesFloor = minSamples() } = {}) {
  const samples = (rows || []).filter((row) => Number.isFinite(Number(row.turf_delta_pct)));
  if (samples.length < samplesFloor) return null;
  const avg = samples.reduce((sum, row) => sum + Number(row.turf_delta_pct), 0) / samples.length;
  if (Math.abs(avg) < thresholdPct) return null;

  // Positive delta = treated more than estimated = estimates running LOW.
  const direction = avg > 0 ? 'low' : 'high';
  const consequence = avg > 0
    ? 'treated area exceeds what was estimated (underpriced turf)'
    : 'estimated area exceeds what techs actually treat (overpriced turf)';
  const subject = `ACT: lawn turf estimates running ${direction} — avg ${fmtPct(avg)} vs field actuals (${samples.length} services, ${WINDOW_DAYS}d)`;

  const outliers = [...samples]
    .sort((a, b) => Math.abs(Number(b.turf_delta_pct)) - Math.abs(Number(a.turf_delta_pct)))
    .slice(0, OUTLIER_LIMIT);
  const outlierTextLines = outliers.map((row) => {
    const day = String(row.service_date).slice(0, 10);
    return `- ${day}: est ${fmtSqFt(jsonField(row.estimated, 'turfSqFt'))} vs treated ${fmtSqFt(jsonField(row.actual, 'treatedSqft'))} (${fmtPct(row.turf_delta_pct)}) — service ${row.service_record_id}`;
  });
  const text = [
    `Lawn turf estimates are running ${direction} vs field actuals: avg ${fmtPct(avg)} across ${samples.length} completed services in the last ${WINDOW_DAYS} days — ${consequence}.`,
    '',
    `Largest deltas:`,
    ...outlierTextLines,
    '',
    `Ledger: ${adminPortalUrl()}/admin/estimates`,
  ].join('\n');
  const html = [
    `<p>Lawn turf estimates are running <strong>${direction}</strong> vs field actuals: avg <strong>${esc(fmtPct(avg))}</strong> across ${samples.length} completed services in the last ${WINDOW_DAYS} days — ${esc(consequence)}.</p>`,
    '<p><strong>Largest deltas:</strong></p>',
    `<ul style="margin:0 0 12px 18px;padding:0;">${outliers.map((row) => {
      const day = String(row.service_date).slice(0, 10);
      return `<li style="margin:0 0 6px 0;">${esc(day)}: est ${esc(fmtSqFt(jsonField(row.estimated, 'turfSqFt')))} vs treated ${esc(fmtSqFt(jsonField(row.actual, 'treatedSqft')))} (<strong>${esc(fmtPct(row.turf_delta_pct))}</strong>) — service ${esc(row.service_record_id)}</li>`;
    }).join('')}</ul>`,
    `<p><a href="${esc(adminPortalUrl())}/admin/estimates">Open the estimates ledger</a></p>`,
  ].join('\n');

  return { subject, text, html, avgDeltaPct: Math.round(avg * 100) / 100, samples: samples.length, direction };
}

async function runTurfVarianceDigest(opts = {}) {
  let rows;
  try {
    rows = await (opts.loadRows || loadTurfWindow)();
  } catch (err) {
    logger.error(`[turf-variance] window query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composeTurfVarianceDigest(rows, opts.thresholds || {});
  if (!composed) return { skipped: 'within_threshold' };

  if (digestDisabled()) {
    logger.info(`[turf-variance] disabled — would send: avg ${composed.avgDeltaPct}% over ${composed.samples} services`);
    return { skipped: 'disabled', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[turf-variance] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only — a mis-set recipient env must
  // skip, never leak pricing-calibration state outward.
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[turf-variance] recipient is not an internal address — skipping send; set a valid TURF_VARIANCE_DIGEST_EMAIL');
    return { skipped: 'recipient', ...composed };
  }

  try {
    await mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      categories: ['ops', 'turf-variance'],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[turf-variance] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  logger.info(`[turf-variance] sent: avg ${composed.avgDeltaPct}% over ${composed.samples} services`);
  return { sent: true, ...composed };
}

module.exports = {
  runTurfVarianceDigest,
  _private: { composeTurfVarianceDigest },
};
