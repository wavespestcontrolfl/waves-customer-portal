'use strict';
/**
 * Shareable lawn card (GATE_REPORT_WEB_SHARE, owner 2026-10-20, idea 8).
 *
 * The web report offers a "Share your lawn" button when the lawn score is 85 or
 * more. The page builds the image in the browser. This module holds the server
 * side: the gate pair, the payload key, and the front photo bytes.
 *
 * Why a server photo route: the lawn photos live in a private bucket and the
 * report links are signed URLs without CORS headers, so a browser canvas that
 * draws one is tainted and cannot export an image. The same-origin route below
 * streams the front photo for this report token, resized, with the file
 * metadata (GPS) removed, so the canvas reads it freely.
 */
const db = require('../../models/db');
const shotList = require('../lawn-photo-shots');
const featureGates = require('../../config/feature-gates');
const logger = require('../logger');

const WEB_SHARE_MIN_SCORE = 85;
const SHARE_PHOTO_MAX_EDGE = 1600;

// Both gates strict and read at call time; a partial gates module reads as off.
function webShareEnabled(gates = featureGates) {
  return typeof gates.reportSimpleWebLive === 'function' && gates.reportSimpleWebLive()
    && typeof gates.reportWebShareLive === 'function' && gates.reportWebShareLive();
}

// The best front-yard photo of the visit's own assessment (the one the report
// shows), or null. Same pick order as the report's photo read.
async function findShareFrontPhoto(service, { knex = db } = {}) {
  const { loadLinkedLawnAssessment } = require('./report-data');
  const assessment = await loadLinkedLawnAssessment(service, knex);
  if (!assessment?.id) return null;
  const rows = await knex('lawn_assessment_photos')
    .where({ assessment_id: assessment.id, customer_visible: true })
    .orderBy('is_best_photo', 'desc')
    .orderBy('quality_score', 'desc')
    .orderBy('photo_order', 'asc')
    .limit(shotList.SHOT_CAP)
    .select('s3_key', 'zone');
  return rows.find((row) => shotList.normalizeShotZone(row.zone) === 'front'
    && row.s3_key && !String(row.s3_key).startsWith('pending/')) || null;
}

/**
 * The /data payload key: `{ score }` only for a lawn visit scoring 85 or more
 * that has a front photo, while the referral program is active. Null = no key.
 * Callback visits take no share offer (a complaint visit is no moment for it).
 */
async function buildWebShare(v1Data, service, { knex = db, referralEngine = require('../referral-engine') } = {}) {
  if (v1Data?.serviceLine !== 'lawn' || v1Data.internalOnly || v1Data.isCallback === true) return null;
  const score = Number(v1Data.reportV2?.snapshot?.overallScore);
  if (!Number.isFinite(score) || score < WEB_SHARE_MIN_SCORE) return null;
  if (!(await findShareFrontPhoto(service, { knex }))) return null;
  const settings = await referralEngine.getLiveSettings();
  if (!settings?.program_active) return null;
  return { score: Math.round(score) };
}

// The /data route's one call: adds `webShare` to a live simple-web payload while both gates are on. Best-effort
// by contract: any failure leaves the page as it is today.
async function attachWebShare(v1Data, service, gates = featureGates) {
  if (v1Data.internalOnly || !webShareEnabled(gates)) return;
  try {
    const webShare = await buildWebShare(v1Data, service);
    if (webShare) v1Data.webShare = webShare;
  } catch (err) {
    logger.warn(`[reports-public] web share offer suppressed (code=${err?.code || 'none'})`);
  }
}

// The front photo for the card: upright, at most 1600 px on a side, JPEG, no
// metadata (sharp drops EXIF unless asked to keep it).
async function readSharePhoto(photoRow, { photoService = require('../photos'), sharp = require('sharp') } = {}) {
  const { buffer } = await photoService.getPhotoBuffer(photoRow.s3_key);
  return sharp(buffer)
    .rotate()
    .resize({ width: SHARE_PHOTO_MAX_EDGE, height: SHARE_PHOTO_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { WEB_SHARE_MIN_SCORE, webShareEnabled, findShareFrontPhoto, buildWebShare, attachWebShare, readSharePhoto };
