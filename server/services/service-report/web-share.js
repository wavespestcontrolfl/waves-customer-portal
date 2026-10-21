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
const { detectServiceLine } = require('./service-line-configs');
const featureGates = require('../../config/feature-gates');
const logger = require('../logger');

const WEB_SHARE_MIN_SCORE = 85;
const SHARE_PHOTO_MAX_EDGE = 1600;

// Both gates strict and read at call time; a partial gates module reads as off.
function webShareEnabled(gates = featureGates) {
  return typeof gates.reportSimpleWebLive === 'function' && gates.reportSimpleWebLive()
    && typeof gates.reportWebShareLive === 'function' && gates.reportWebShareLive();
}

// The best front-yard photo of one assessment (the pick order the report's photo read uses), or null.
async function frontPhotoOf(assessmentId, knex) {
  const rows = await knex('lawn_assessment_photos')
    .where({ assessment_id: assessmentId, customer_visible: true })
    .orderBy('is_best_photo', 'desc')
    .orderBy('quality_score', 'desc')
    .orderBy('photo_order', 'asc')
    .limit(shotList.SHOT_CAP)
    .select('s3_key', 'zone');
  return rows.find((row) => shotList.normalizeShotZone(row.zone) === 'front'
    && row.s3_key && !String(row.s3_key).startsWith('pending/')) || null;
}

/**
 * THE eligibility rule for the lawn card, used by /data (to offer it), the share-photo route (to serve the
 * photo) and the referral-link route (before any promoter enrollment): a lawn visit that is not a callback,
 * whose own assessment scores 85 or more and has a customer-visible front-yard photo. When
 * `requestedAssessmentId` is given it must be that very assessment (the one /data scored). Suppressed
 * reports and the referral program's state are the callers' checks. Returns
 * { score, assessmentId, photo } or null.
 */
async function resolveShareEligibility(service, { knex = db, requestedAssessmentId = null } = {}) {
  if (!service || service.is_callback === true) return null;
  const line = service.service_line || detectServiceLine(service.service_type);
  if (line !== 'lawn') return null;
  const { loadLinkedLawnAssessment, formatLawnAssessmentScore } = require('./report-data');
  const assessment = await loadLinkedLawnAssessment(service, knex);
  if (!assessment?.id) return null;
  if (requestedAssessmentId != null && String(assessment.id) !== String(requestedAssessmentId)) return null;
  const score = Number(formatLawnAssessmentScore(assessment)?.overallScore);
  if (!Number.isFinite(score) || score < WEB_SHARE_MIN_SCORE) return null;
  const photo = await frontPhotoOf(assessment.id, knex);
  if (!photo) return null;
  return { score: Math.round(score), assessmentId: String(assessment.id), photo };
}

/**
 * The /data payload key: `{ score, assessmentId }` for an eligible visit (see resolveShareEligibility) while
 * the referral program is active. Null = no key.
 */
async function buildWebShare(v1Data, service, { knex = db, referralEngine = require('../referral-engine') } = {}) {
  if (v1Data?.internalOnly) return null;
  const eligible = await resolveShareEligibility(service, { knex });
  if (!eligible) return null;
  const settings = await referralEngine.getLiveSettings();
  if (!settings?.program_active) return null;
  return { score: eligible.score, assessmentId: eligible.assessmentId };
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

module.exports = { WEB_SHARE_MIN_SCORE, webShareEnabled, resolveShareEligibility, buildWebShare, attachWebShare, readSharePhoto };
