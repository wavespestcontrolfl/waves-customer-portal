const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { applyContactNormalization } = require('../utils/intake-normalize');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString, formatETDate } = require('../utils/datetime-et');
const { formatSmsTimeRange } = require('../utils/sms-time-format');
const { shortenOrPassthrough } = require('../services/short-url');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');
const { WAVEGUARD: PRICING_WAVEGUARD } = require('../services/pricing-engine/constants');
const slotReservation = require('../services/slot-reservation');
const rateLimit = require('express-rate-limit');
const { generateEstimate } = require('../services/pricing-engine');
const { PEST, ONE_TIME, ANNUAL_PREPAY_DISCOUNT_PCT } = require('../services/pricing-engine/constants');
const addonDefaults = require('../config/addon-defaults-by-frequency');
const BillingCadence = require('../services/billing-cadence');
const {
  markLinkedLeadEstimateAccepted,
  markLinkedLeadEstimateViewed,
} = require('../services/lead-estimate-link');
const { buildEstimateMembershipContext } = require('../services/estimate-membership-context');
const { isActivePlanCustomer } = require('../services/waveguard-existing-services');
const {
  ensureDepositSatisfied,
  resolveDepositPolicyForEstimate,
  linkedScheduledServiceId,
  computeDepositAmount,
} = require('../services/estimate-deposits');
const CardHolds = require('../services/estimate-card-holds');
const {
  cleanupEstimatePricingCache,
  clearEstimatePricingCache,
  getEstimatePricingCache,
  setEstimatePricingCache,
} = require('../services/estimate-pricing-cache');
const {
  answerEstimateQuestion,
  buildEstimateAssistantContext,
} = require('../services/estimate-assistant');
const { loadPublicEstimateSupportSources } = require('../services/estimate-ai-context');
const { triggerAdminFollowupCall } = require('../services/admin-followup-call');
const {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_E164,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} = require('../constants/business');
const {
  pricingBundleMatchesEstimateTotals,
} = require('../services/estimate-pricing-bundle-utils');
const {
  estimateDataHasUnresolvedManagerApproval,
  commercialRiskTypeReviewNeeded,
  commercialLowConfidenceRange,
  commercialLowConfidenceRequiresSiteQuote,
} = require('../services/estimate-delivery-options');
const {
  createEstimateAddServiceRequest,
} = require('../services/estimate-add-service-request');
const featureGates = require('../config/feature-gates');
const { getCachedLookup } = require('../services/property-lookup/lookup-cache');
const {
  parcelOverlayEnabled,
  buildParcelOverlayParam,
} = require('./property-lookup-v2');

const ESTIMATE_ASK_TOKEN_SECRET = process.env.ESTIMATE_ASK_TOKEN_SECRET
  || config.jwt.secret
  || crypto.randomBytes(32).toString('hex');
const ESTIMATE_ASK_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const addServiceRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many service requests submitted. Please wait before sending another or call our office.' },
});

function scheduledDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value).split('T')[0];
}

function scheduledTimeOnly(value) {
  const raw = String(value || '').trim();
  return raw ? raw.slice(0, 5) : '08:00';
}

async function registerAcceptedEstimateAppointmentReminder({
  appointment,
  customerId,
  serviceType,
  appointmentReminders = AppointmentReminders,
}) {
  if (!appointment?.id || !customerId) return null;
  const date = scheduledDateOnly(appointment.scheduled_date);
  if (!date) return null;

  return appointmentReminders.registerAppointment(
    appointment.id,
    customerId,
    `${date}T${scheduledTimeOnly(appointment.window_start)}`,
    serviceType || appointment.service_type || 'Pest Control',
    'estimate_accept_slot',
    { sendConfirmation: false },
  );
}

// View-count hygiene. We surface view_count + last_viewed_at on the admin
// estimates dashboard, so the count needs to mean "the customer opened it"
// — not "iMessage unfurled the link" or "Virginia previewed it from the
// office." Three filters, applied to BOTH the view_count increment and the
// per-open estimate_views insert:
//   1. UA allowlist: drop anything whose user-agent matches a known bot /
//      preview / scanner / CLI client (shared with public-shortlinks via
//      utils/bot-ua so the shortlink click counter applies the same rules).
//   2. Admin marker cookie: a long-lived signed JWT set by /api/admin/auth
//      on every login + /me. Per-device, per-browser; survives network
//      changes.
//   3. Admin IP allowlist: legacy WAVES_ADMIN_IPS support for office/network
//      previews that do not carry the marker cookie.
// First-view side-effects (status flip + admin in-app notification) use the
// same gate; a filtered preview must not make the estimate look customer-opened.
const { isBotUserAgent } = require('../utils/bot-ua');

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '')
    .toString().split(',')[0].trim().slice(0, 64);
}

// estimates.customer_phone may be freeform (admin input) or E.164 (quote
// wizard) while customers.phone is freeform — compare on the last 10 digits
// like admin-customers/admin-communications do, never on the raw string.
function phoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function normalizeAddressForMatch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Multiple live profiles can legitimately share a phone (landlord + rental
// property via quick-add). Only reuse one when the match is unambiguous: a
// single phone hit, or — among several — a unique email or service-address
// match. Otherwise return null so the accept creates a fresh profile;
// attaching the tier/monthly_rate/schedules to a guessed profile splits the
// real customer's history.
function pickAcceptCustomerMatch(candidates, estimate) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  let pool = candidates;
  const email = String(estimate.customer_email || '').trim().toLowerCase();
  if (email) {
    const byEmail = pool.filter((c) => String(c.email || '').trim().toLowerCase() === email);
    if (byEmail.length === 1) return byEmail[0];
    if (byEmail.length > 1) pool = byEmail;
  }
  const estAddr = normalizeAddressForMatch(estimate.address);
  if (estAddr) {
    const byAddress = pool.filter((c) => {
      const line1 = normalizeAddressForMatch(c.address_line1);
      // estimate.address is the full address; address_line1 is the street
      // line. Require a meaningful street line so '' never matches, and a
      // token boundary so '12 oak' can't match '12 oakridge dr'.
      return line1.length >= 5 && (estAddr === line1 || estAddr.startsWith(line1 + ' '));
    });
    if (byAddress.length === 1) return byAddress[0];
  }
  return null;
}

// Tiny cookie-header parser — avoids pulling in cookie-parser for one read.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const target = name + '=';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      try { return decodeURIComponent(trimmed.slice(target.length)); } catch { return null; }
    }
  }
  return null;
}

function hasAdminMarker(req) {
  const token = readCookie(req, 'waves_admin');
  if (!token) return false;
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    return payload && payload.kind === 'admin_marker';
  } catch { return false; }
}

function requestUserAgent(req) {
  if (typeof req?.get === 'function') return req.get('user-agent');
  return req?.headers?.['user-agent'] || req?.headers?.['User-Agent'] || '';
}

function estimateHasBeenSent(estimate) {
  if (!estimate) return true;
  return !!estimate.sent_at;
}

function shouldCountView(req, ip, estimate = null) {
  if (!estimateHasBeenSent(estimate)) return false;
  // Expired links don't count as views or fire first-view side effects (status
  // flip + admin "Estimate viewed" notify). The legacy server-HTML path
  // short-circuits to the expired page before any view tracking; the React
  // /:token/data path reaches here instead, so the guard lives centrally so
  // both renderers agree. Accepted estimates past expiry still render + count
  // (mirrors the `status !== 'accepted'` carve-out in handleEstimateView).
  if (estimate && estimate.expires_at
    && new Date(estimate.expires_at) < new Date()
    && estimate.status !== 'accepted') return false;
  if (isBotUserAgent(requestUserAgent(req))) return false;
  if (hasAdminMarker(req)) return false;
  if (isAdminIp(ip)) return false;
  return true;
}

function shouldApplyFirstViewSideEffects(req, ip, estimate = null) {
  return shouldCountView(req, ip, estimate);
}

function hashEstimateToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function signEstimateAskToken(estimate = {}, tokenOverride) {
  const token = tokenOverride || estimate.token;
  return jwt.sign({
    kind: 'estimate_ask',
    estimateId: String(estimate.id || ''),
    tokenHash: hashEstimateToken(token),
  }, ESTIMATE_ASK_TOKEN_SECRET, { expiresIn: ESTIMATE_ASK_TOKEN_TTL_SECONDS });
}

function verifyEstimateAskToken(req, estimate) {
  const supplied = req.get('x-estimate-ask-token') || req.body?.askToken;
  if (!supplied) return false;
  try {
    const payload = jwt.verify(String(supplied), ESTIMATE_ASK_TOKEN_SECRET);
    return payload?.kind === 'estimate_ask'
      && String(payload.estimateId || '') === String(estimate.id || '')
      && payload.tokenHash === hashEstimateToken(estimate.token || req.params.token);
  } catch {
    return false;
  }
}

function isEstimateAskAnswerable(estimate = {}, now = new Date()) {
  if (!estimate) return false;
  if (estimate.archived_at) return false;
  if (['accepted', 'declined', 'expired', 'send_failed'].includes(estimate.status)) return false;
  if (estimate.expires_at && new Date(estimate.expires_at) < now) return false;
  return true;
}

function buildEstimateAskQueryLog({ estimateId, question, result = {} }) {
  const questionChars = String(question || '').length;
  const answerChars = String(result.answer || '').length;
  const source = String(result.source || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'unknown';
  return {
    prompt: `[public_estimate:${estimateId}] question_chars=${questionChars}`,
    response: `[redacted] source=${source} answer_chars=${answerChars}`,
    tool_calls: JSON.stringify([{
      name: 'public_estimate_ask',
      input: { questionChars },
      result: { source, answerChars },
    }]),
    operator_id: null,
  };
}

// Map a one-time service name to the booking page's service id (matches PublicBookingPage SERVICES)
function bookingServiceFor(name) {
  const n = String(name || '').toLowerCase();
  // Bora-Care is checked before termite/pest so a "Bora-Care Wood Treatment" (or
  // "Termite Bora-Care") label routes the /book link + SMS to the Bora-Care visit
  // instead of falling through to the Pest Control bucket.
  if (n.includes('bora') || n.includes('borate')) return { id: 'bora_care', label: 'Bora-Care Wood Treatment' };
  if (n.includes('lawn') || n.includes('turf') || n.includes('aeration') || n.includes('seed') || n.includes('weed')) return { id: 'lawn_care', label: 'Lawn Care' };
  if (n.includes('mosquito')) return { id: 'mosquito', label: 'Mosquito Control' };
  if (n.includes('tree') || n.includes('shrub') || n.includes('palm') || n.includes('ornamental')) return { id: 'tree_shrub', label: 'Tree & Shrub Service' };
  if (n.includes('termite') || n.includes('wdo')) return { id: 'termite', label: 'Termite Inspection' };
  if (n.includes('rodent') || n.includes('rat') || n.includes('mouse')) return { id: 'rodent', label: 'Rodent Control' };
  return { id: 'pest_control', label: 'Pest Control' };
}

// Customer-facing service name for the post-booking confirmation SMS.
// Prefer the specific one-time service the customer actually scheduled
// (e.g. "German Roach Cleanout") over the generic booking bucket that
// bookingServiceFor collapses roach/specialty services into — that bucket
// is correct for routing the /book link's ?service= param but reads wrong
// as confirmation copy once a real appointment exists. Falls back to the
// estimate's service_interest, then the supplied bucket label.
function confirmationServiceLabel(oneTimeList, estimate, fallbackLabel) {
  const specific = (Array.isArray(oneTimeList) ? oneTimeList[0]?.name : '')
    || estimate?.service_interest
    || fallbackLabel
    || '';
  return String(specific).replace(/\s+/g, ' ').trim() || String(fallbackLabel || '').trim();
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value).split('T')[0];
}

function hhmm(value) {
  return value ? String(value).slice(0, 5) : '';
}

function parseEstimateDataSafe(estimate = {}) {
  const raw = estimate.estimate_data;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw || {};
}

function shapeLinkedAppointment(row) {
  if (!row) return null;
  return {
    id: row.id,
    scheduledDate: dateOnly(row.scheduled_date),
    windowStart: hhmm(row.window_start),
    windowEnd: hhmm(row.window_end),
    windowDisplay: row.window_display || null,
    serviceType: row.service_type || 'Service visit',
    status: row.status || null,
  };
}

async function findLinkedUpcomingAppointment(estimate = {}, estData = null, opts = {}) {
  const conn = opts.database || db;
  const requestedId = opts.appointmentId ? String(opts.appointmentId) : '';
  const data = estData || parseEstimateDataSafe(estimate);
  const linkedId = data?.scheduled_service_id ? String(data.scheduled_service_id) : '';
  const today = etDateString();
  if (!linkedId && !estimate.id) return null;

  const q = conn('scheduled_services')
    .whereIn('status', ['pending', 'confirmed'])
    .where('scheduled_date', '>=', today)
    .where((builder) => {
      if (estimate.customer_id) {
        builder.whereNull('customer_id').orWhere('customer_id', estimate.customer_id);
      } else {
        builder.whereNull('customer_id');
      }
    })
    .andWhere((builder) => {
      builder.whereNull('reservation_expires_at')
        .orWhereRaw('reservation_expires_at > NOW()');
    })
    .where((builder) => {
      if (linkedId) builder.where('id', linkedId);
      if (estimate.id) builder.orWhere('source_estimate_id', estimate.id);
    })
    .orderBy('scheduled_date', 'asc')
    .orderBy('window_start', 'asc');

  if (requestedId) q.where('id', requestedId);
  const row = await q.first();
  if (!row) return null;
  if (requestedId && String(row.id) !== requestedId) return null;
  return row;
}

async function renderTemplate(templateKey, vars, fallback, context = {}) {
  const body = await renderEditableSmsTemplate(templateKey, vars, context);
  return body || fallback;
}

async function renderEditableSmsTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Server-rendered customer estimate page
// ──────────────────────────────────────────────────────────────────

const BRAND = {
  blue: '#009CDE', blueDark: '#065A8C', blueDeeper: '#1B2C5B', blueLight: '#E3F5FD',
  yellow: '#F6C343', navy: '#0F172A', green: '#16A34A', red: '#C8102E',
  sand: '#FDF6EC', sandDark: '#F5EBD7',
};

const ESTIMATE_BUTTON_BLUE = BRAND.blueDeeper;

// App-store links — the iOS app is live, so the Apple badge links to the
// listing by default (env var still overrides). Android isn't published yet,
// so the Google Play badge is hidden entirely until WAVES_ANDROID_APP_URL is
// set (no dead/non-clickable badge once one store is live). Only when BOTH are
// empty does the card fall back to the "coming soon" preview with both badges.
const APP_STORE_URL = process.env.WAVES_IOS_APP_URL || 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = process.env.WAVES_ANDROID_APP_URL || '';

// Self-contained inline-SVG store badges (no hosted assets / no broken images).
function appStoreBadgeSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="40" viewBox="0 0 132 40" role="img" aria-label="Download on the App Store"><rect width="132" height="40" rx="7" fill="#000"/><rect x="0.75" y="0.75" width="130.5" height="38.5" rx="6.25" fill="none" stroke="#5A5A5A"/><path fill="#fff" transform="translate(12 8.5) scale(0.92)" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/><text x="40" y="17" fill="#fff" font-family="Inter,Helvetica,Arial,sans-serif" font-size="7.5" letter-spacing="0.2">Download on the</text><text x="39" y="31" fill="#fff" font-family="Inter,Helvetica,Arial,sans-serif" font-size="16.5" font-weight="600">App Store</text></svg>';
}
function googlePlayBadgeSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="135" height="40" viewBox="0 0 135 40" role="img" aria-label="Get it on Google Play"><rect width="135" height="40" rx="7" fill="#000"/><rect x="0.75" y="0.75" width="133.5" height="38.5" rx="6.25" fill="none" stroke="#5A5A5A"/><g transform="translate(11 9) scale(0.92)"><path fill="#00C3FF" d="M4 3 13 12 4 21Z"/><path fill="#00E676" d="M4 3 16.5 9.8 13 12Z"/><path fill="#FFD500" d="M16.5 9.8 20.5 12 16.5 14.2Z"/><path fill="#FF3D00" d="M13 12 16.5 14.2 4 21Z"/></g><text x="40" y="17" fill="#fff" font-family="Inter,Helvetica,Arial,sans-serif" font-size="7.5" letter-spacing="0.6">GET IT ON</text><text x="39.5" y="31" fill="#fff" font-family="Inter,Helvetica,Arial,sans-serif" font-size="16" font-weight="600">Google Play</text></svg>';
}
function appBadge(svg, url, label) {
  return url
    ? `<a class="app-badge" href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(label)}">${svg}</a>`
    : `<span class="app-badge" role="img" aria-label="${escapeHtml(label)} — coming soon">${svg}</span>`;
}

// Feather-style stroke icons for the Waves-app feature chips (inherit currentColor).
const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';
const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 20.5l1.8-4.4A8 8 0 1 1 21 11.5z"/></svg>';
const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>';
const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h4"/></svg>';
const ICON_FAMILY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.2 19.2c0-3.4 2.8-5.6 5.8-5.6s5.8 2.2 5.8 5.6"/><path d="M16.2 5.4a3 3 0 0 1 0 5.8"/><path d="M17.4 13.8c2.6.4 4.4 2.4 4.4 5.4"/></svg>';
const ICON_CARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 10h18M6.5 14.5h4"/></svg>';

// SSR top bar — phone on the LEFT, full Waves logo on the RIGHT. The
// logo is /waves-logo.png served from client/public so the static and
// React surfaces share the exact same artwork (and cache line).
function shellTopBar() {
  return `<header class="top-bar">
    <div class="top-bar-inner">
      <a href="${WAVES_SUPPORT_PHONE_TEL}" class="top-phone">${WAVES_SUPPORT_PHONE_DISPLAY}</a>
      <img src="/waves-logo.png" alt="Waves" class="top-logo"/>
    </div>
  </header>`;
}

// Mobile sticky "Questions?" bar pinned to the bottom of the customer
// estimate page. Desktop keeps the top phone link and footer CTA visible
// without covering long-form estimate content.
function shellQuestionsBar() {
  return `<div class="q-bar" role="region" aria-label="Questions for Waves">
    <a href="${WAVES_SUPPORT_PHONE_TEL}" class="q-btn q-call" aria-label="Call Waves at ${WAVES_SUPPORT_PHONE_DISPLAY}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>
      <span>Questions? Call Waves</span>
    </a>
    <a href="${WAVES_SUPPORT_SMS_TEL}" class="q-btn q-text" aria-label="Text Waves at ${WAVES_SUPPORT_PHONE_DISPLAY}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>Questions? Text Waves!</span>
    </a>
  </div>`;
}

// WaveGuard tier discounts — read live from the pricing engine's constants
// module (see docs/pricing/POLICY.md). Read on every access (not snapshotted
// at module load) so values that db-bridge syncs from pricing_config or that
// admin updates trigger via /admin/pricing-config flow through immediately.
// Earlier this had Platinum hardcoded at 0.18, drifting from the WaveGuard
// Platinum bundle's 20% discount.
function tierDiscount(tier) {
  const key = String(tier || '').toLowerCase();
  return PRICING_WAVEGUARD.tiers[key]?.discount ?? 0;
}

function snapshotTierDiscount(estData, tier) {
  const discounts = estData?.sendSnapshot?.tierDiscounts || estData?.pricingContext?.tierDiscounts || {};
  const direct = discounts?.[tier];
  const lower = discounts?.[String(tier || '').toLowerCase()];
  const value = Number(direct ?? lower);
  return Number.isFinite(value) ? value : null;
}

function tierDiscountForEstimate(estData, tier, fallbackDiscount = null) {
  const snapshotted = snapshotTierDiscount(estData, tier);
  if (snapshotted != null) return snapshotted;
  if (fallbackDiscount !== null && fallbackDiscount !== undefined) {
    const fallback = Number(fallbackDiscount);
    if (Number.isFinite(fallback)) return fallback;
  }
  return tierDiscount(tier);
}

function recurringResultStats(estData = {}) {
  const estResult = estData?.result || estData || {};
  return estResult?.results || estData?.results || {};
}

function selectedResultStatsRow(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.find((t) => t?.selected || t?.isSelected)
    || rows.find((t) => t?.recommended || t?.isRecommended)
    || rows[0]
    || null;
}

function visitsForRecurringServiceName(name, resultStats = {}) {
  const n = String(name || '').toLowerCase();
  if (n.includes('pest')) return resultStats.pest?.apps;
  if (n.includes('lawn') && Array.isArray(resultStats.lawn)) {
    const sel = resultStats.lawn.find((t) => t.recommended) || resultStats.lawn[0];
    return sel?.v;
  }
  if (n.includes('mosquito') && Array.isArray(resultStats.mq)) {
    const sel = resultStats.mq.find((t) => t.selected || t.isSelected) ||
      resultStats.mq.find((t) => t.recommended || t.isRecommended) ||
      resultStats.mq[0];
    return sel?.v;
  }
  if (n.includes('tree') && Array.isArray(resultStats.ts)) return selectedResultStatsRow(resultStats.ts)?.v;
  if (n.includes('termite') && n.includes('bait')) return 4;
  return null;
}

function selectedPestTierForFirstVisit(estData = {}, pestRecurring = null) {
  const resultStats = recurringResultStats(estData);
  const pestTiers = Array.isArray(resultStats.pestTiers) ? resultStats.pestTiers : [];
  return pestTiers.find((t) => Math.abs(Number(t?.mo || 0) - Number(pestRecurring?.monthlyBase || 0)) < 0.01)
    || pestTiers[0]
    || null;
}

function recurringServiceFirstVisitPrice(svc = {}, {
  estData = {},
  tierDiscount = 0,
  prefMonthlyOff = 0,
  pestRecurring = null,
  selectedPestTier = null,
} = {}) {
  const resultStats = recurringResultStats(estData);
  const pestTier = selectedPestTier || selectedPestTierForFirstVisit(estData, pestRecurring);
  const name = svc?.name || svc?.label || svc?.service;
  const n = String(name || '').toLowerCase();
  const visits = (() => {
    if (n.includes('pest')) {
      return Number(pestTier?.apps || pestTier?.v || resultStats.pest?.apps || pestRecurring?.visitsPerYear || 4) || null;
    }
    const explicit = Number(svc?.visitsPerYear ?? svc?.visits ?? svc?.frequency);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return Number(visitsForRecurringServiceName(name, resultStats)) || null;
  })();
  const anchorPrice = (() => {
    let base = null;
    if (n.includes('pest')) {
      const pestPa = Number(pestTier?.pa || 0);
      if (pestPa > 0) base = pestPa;
    }
    if (base == null) {
      const explicit = Number(svc?.perTreatment ?? svc?.perApp ?? svc?.perVisit ?? svc?.pa);
      if (Number.isFinite(explicit) && explicit > 0) base = explicit;
    }
    if (base == null && visits > 0) {
      const monthly = Number(svc?.mo || svc?.monthly || 0);
      if (monthly > 0) base = (monthly * 12) / visits;
    }
    return base == null ? null : Math.round(base * 100) / 100;
  })();
  const serviceDiscount = recurringServiceReceivesTierDiscount(svc) ? Number(tierDiscount || 0) : 0;
  const basePrice = anchorPrice == null ? null : Math.round(anchorPrice * (1 - serviceDiscount) * 100) / 100;
  const prefPerTreatmentOff = n.includes('pest') && visits > 0
    ? (Number(prefMonthlyOff || 0) * 12) / visits
    : 0;
  const price = basePrice == null ? null : Math.max(0, Math.round((basePrice - prefPerTreatmentOff) * 100) / 100);
  return { visits, anchorPrice, basePrice, price };
}

function resolveRecurringFirstVisitAmount(services = [], opts = {}) {
  let missingServicePrice = false;
  const total = (Array.isArray(services) ? services : []).reduce((sum, svc) => {
    const { price } = recurringServiceFirstVisitPrice(svc, opts);
    if (!Number.isFinite(price) || price <= 0) {
      missingServicePrice = true;
      return sum;
    }
    return Math.round((sum + price) * 100) / 100;
  }, 0);
  return !missingServicePrice && total > 0 ? total : null;
}

function frequencyTreatmentAmount(row = {}) {
  return firstPositiveNumber(
    row?.displayPrice,
    row?.priceAfterDiscount,
    row?.netPerTreatment,
    row?.price,
    row?.perTreatment,
    row?.perApp,
    row?.perVisit,
    row?.pa,
  );
}

function frequencyTreatmentsCoverServices(rows = [], services = []) {
  const expectedKeys = (Array.isArray(services) ? services : [])
    .map((svc) => recurringServiceKey(svc))
    .filter(Boolean);
  if (!expectedKeys.length) return true;

  const pricedKeys = new Set((Array.isArray(rows) ? rows : [])
    .filter((row) => frequencyTreatmentAmount(row))
    .map((row) => recurringServiceKey(row))
    .filter(Boolean));
  return expectedKeys.every((key) => pricedKeys.has(key));
}

function resolveRecurringFirstVisitAmountFromFrequency(frequency = {}, { prefMonthlyOff = 0, services = null } = {}) {
  const rows = Array.isArray(frequency?.perServiceTreatments)
    ? frequency.perServiceTreatments
    : [];
  if (services && !frequencyTreatmentsCoverServices(rows, services)) return null;
  const total = rows.reduce((sum, row) => {
    const amount = frequencyTreatmentAmount(row);
    if (!amount) return sum;
    const serviceName = String(row?.service || row?.label || '').toLowerCase();
    const visits = Number(row?.visitsPerYear ?? row?.visits ?? row?.frequency);
    const discount = serviceName.includes('pest') && visits > 0
      ? (Number(prefMonthlyOff || 0) * 12) / visits
      : 0;
    const adjusted = Math.max(0, Math.round((amount - discount) * 100) / 100);
    return adjusted > 0 ? Math.round((sum + adjusted) * 100) / 100 : sum;
  }, 0);
  return total > 0 ? total : null;
}

function resolveRecurringInvoiceFirstVisitAmount({
  recurringFirstVisitAmount = null,
  effectiveBillingCadence = null,
  monthlyTotal = null,
} = {}) {
  const firstVisitAmount = Number(recurringFirstVisitAmount);
  if (Number.isFinite(firstVisitAmount) && firstVisitAmount > 0) {
    return Math.round(firstVisitAmount * 100) / 100;
  }
  const cadenceAmount = Number(effectiveBillingCadence?.amount);
  if (Number.isFinite(cadenceAmount) && cadenceAmount > 0) {
    return Math.round(cadenceAmount * 100) / 100;
  }
  const monthly = Number(monthlyTotal);
  return Number.isFinite(monthly) && monthly > 0
    ? Math.round(monthly * 3 * 100) / 100
    : null;
}

function estimateAcceptError(message, status = 422) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function roundInvoiceAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

function oneTimeInvoiceLabelForCategory(category, fallback = 'One-time service') {
  switch (category) {
    case 'pest_control': return 'One-Time Pest Control';
    case 'lawn_care': return 'One-Time Lawn Care';
    case 'tree_shrub': return 'One-Time Tree & Shrub Service';
    case 'mosquito': return 'One-Time Mosquito Control';
    case 'termite_bait': return 'Termite Bait Installation';
    case 'pre_slab_termiticide': return 'Pre-Slab Termiticide Treatment';
    case 'bora_care': return 'Bora-Care Wood Treatment';
    case 'termite_trenching': return 'Termite Treatment';
    case 'rodent': return 'Rodent Remediation';
    case 'bundle': return 'One-Time Service';
    default: return fallback;
  }
}

function oneTimeInvoiceRowLabel(row = {}) {
  return String(row.displayName || row.label || row.name || row.service || '').trim();
}

function isBillableOneTimeInvoiceItem(row = {}) {
  if (!row || typeof row !== 'object') return false;
  if (row.quoteRequired === true || row.requiresCustomQuote === true) return false;
  const service = String(row.service || '').toLowerCase();
  if (service === 'one_time_adjustment' || service === 'rodent_bundle_discount') return false;
  if (isWaveGuardSetupOneTimeItem(row)) return false;
  return oneTimeItemAmount(row) > 0;
}

function buildOneTimeInvoiceServiceLabel({
  estimate = {},
  estData = {},
  pricingBundle = null,
  oneTimeList = [],
} = {}) {
  const hasCustomerChoice = !!(estimate.show_one_time_option || estimate.showOneTimeOption);
  if (hasCustomerChoice) {
    const category = serviceCategoryForOneTimeChoice(estData, pricingBundle);
    return oneTimeInvoiceLabelForCategory(category, 'One-Time Pest Control');
  }

  const listRow = Array.isArray(oneTimeList)
    ? oneTimeList.find(isBillableOneTimeInvoiceItem)
    : null;
  const breakdown = pricingBundle?.oneTimeBreakdown || normalizeOneTimeBreakdown(estData);
  const breakdownRow = Array.isArray(breakdown?.items)
    ? breakdown.items.find(isBillableOneTimeInvoiceItem)
    : null;
  const row = listRow || breakdownRow || null;
  const rowLabel = row ? oneTimeInvoiceRowLabel(row) : '';
  const category = row ? serviceCategoryForOneTimeItem(row) : serviceCategoryForOneTimeChoice(estData, pricingBundle);

  // A row whose only label is the raw engine service key (e.g. "bora_care",
  // which normalizeOneTimeBreakdown falls back to when no name is stored) is not
  // a customer-facing label — prefer the mapped category label.
  const rowLabelIsRawServiceKey = !!rowLabel && !!row
    && rowLabel.toLowerCase() === String(row.service || '').toLowerCase();
  if (rowLabel && !rowLabelIsRawServiceKey) return rowLabel;
  return oneTimeInvoiceLabelForCategory(category);
}

function recurringInvoiceServiceLabel(rows = []) {
  const labels = (Array.isArray(rows) ? rows : [])
    .map((svc) => String(
      svc?.displayName
        || svc?.name
        || svc?.label
        || recurringServiceDisplayName(recurringServiceKey(svc))
        || '',
    ).trim())
    .filter(Boolean);
  return labels.length ? labels.join(' + ') : 'Pest Control';
}

function buildEstimateInvoiceModeDraft({
  estimate = {},
  estData = {},
  pricingBundle = null,
  oneTimeList = [],
  recurringSvcList = [],
  treatAsOneTime = false,
  effectiveOneTimeTotal = null,
  effectiveMonthlyTotal = null,
  recurringFirstVisitAmount = null,
  effectiveBillingCadence = null,
  selectedFrequency = null,
} = {}) {
  if (treatAsOneTime) {
    const amount = roundInvoiceAmount(effectiveOneTimeTotal);
    if (!(amount > 0)) {
      throw estimateAcceptError('Invoice-mode one-time acceptance requires a billable one-time amount.');
    }
    const serviceLabel = buildOneTimeInvoiceServiceLabel({
      estimate,
      estData,
      pricingBundle,
      oneTimeList,
    });
    // Itemize when the accepted one-time list covers more than one billable service
    // (e.g. a pest visit plus a Bora-Care add-on) so each charge is visible on the
    // invoice instead of being hidden inside a single "One-Time Pest Control" line.
    // Only itemize when the rows reconcile to the billed amount; else keep one line.
    const billableRows = (Array.isArray(oneTimeList) ? oneTimeList : [])
      .map((row) => ({
        description: String(row?.label || row?.name || '').trim(),
        unit_price: roundInvoiceAmount(row?.price),
      }))
      .filter((row) => row.description && Number(row.unit_price) > 0);
    const rowsTotal = billableRows.reduce((sum, row) => Math.round((sum + row.unit_price) * 100) / 100, 0);
    const itemize = billableRows.length > 1 && Math.abs(rowsTotal - amount) < 0.01;
    const lineItems = itemize
      ? billableRows.map((row) => ({ description: row.description, quantity: 1, unit_price: row.unit_price }))
      : [{ description: serviceLabel, quantity: 1, unit_price: amount }];
    const title = itemize
      ? `${billableRows.map((row) => row.description).join(' + ')} — one-time service`
      : `${serviceLabel} — one-time service`;
    return {
      invoiceKind: 'one_time',
      serviceLabel,
      amount,
      title,
      lineItems,
      notes: `Auto-generated from accepted estimate #${estimate.id || 'unknown'} (invoice-mode one-time).`,
    };
  }

  const monthly = roundInvoiceAmount(effectiveMonthlyTotal ?? estimate.monthly_total ?? estimate.monthlyTotal ?? 0) || 0;
  const firstVisitInvoiceAmount = resolveRecurringInvoiceFirstVisitAmount({
    recurringFirstVisitAmount,
    effectiveBillingCadence,
    monthlyTotal: monthly,
  });
  const amount = roundInvoiceAmount(firstVisitInvoiceAmount);
  if (!(amount > 0)) {
    throw estimateAcceptError('Invoice-mode recurring acceptance requires a billable first-visit amount.');
  }
  const svcType = recurringInvoiceServiceLabel(recurringSvcList);
  const cadenceLabel = String(effectiveBillingCadence?.frequencyLabel || selectedFrequency?.label || 'Recurring').toLowerCase();
  const visitNoun = String(effectiveBillingCadence?.visitChargeLabel || '')
    .replace(/^Charged after each\s+/i, '')
    || `${cadenceLabel} visit`;

  return {
    invoiceKind: 'recurring_first_visit',
    serviceLabel: svcType,
    amount,
    title: `${svcType} — first ${visitNoun}`,
    lineItems: [{
      description: `${svcType} (${cadenceLabel} recurring — first ${visitNoun})`,
      quantity: 1,
      unit_price: amount,
    }],
    notes: `Auto-generated from accepted estimate #${estimate.id || 'unknown'} (invoice-mode recurring). Monthly equivalent: $${monthly.toFixed(2)}/mo.`,
  };
}

function pestTreatmentRowForFrequency(frequency = {}) {
  const rows = Array.isArray(frequency?.perServiceTreatments)
    ? frequency.perServiceTreatments
    : [];
  return rows.find((row) => /pest/i.test(String(row?.service || row?.label || ''))) || null;
}

function pestVisitsForFrequency(frequency = {}) {
  const pestRow = pestTreatmentRowForFrequency(frequency);
  const visits = Number(pestRow?.visitsPerYear ?? pestRow?.visits ?? pestRow?.frequency);
  return Number.isFinite(visits) && visits > 0 ? visits : null;
}

function pestMonthlyBaseForFrequency(frequency = {}) {
  const pestRow = pestTreatmentRowForFrequency(frequency);
  const visits = pestVisitsForFrequency(frequency);
  const amount = firstPositiveNumber(
    pestRow?.perTreatment,
    pestRow?.perApp,
    pestRow?.perVisit,
    pestRow?.pa,
    pestRow?.priceBeforeDiscount,
    pestRow?.displayPrice,
    pestRow?.priceAfterDiscount,
    pestRow?.netPerTreatment,
    pestRow?.price,
  );
  return amount && visits ? Math.round(((amount * visits) / 12) * 100) / 100 : null;
}

// ── Service-preference pricing modifiers ──────────────────────
// Customers can opt out of interior spraying or exterior (eave/cobweb)
// sweeping on RECURRING pest only ($10/visit each). On one-time pest
// both are bundled in — the one-time price already reflects "the works"
// (full perimeter + granular + IGR + eave sweep + interior) and there's
// no per-visit recurring savings to give back, so opt-out yields $0.
const SERVICE_PREFS = {
  interior_spray:  { perVisit: 10, oneTime: 0, label: 'Interior spraying',  offDesc: 'No interior treatment — tech sprays and inspects the perimeter only.' },
  exterior_sweep:  { perVisit: 10, oneTime: 0, label: 'Exterior eave sweep', offDesc: 'No eave/cobweb sweep on the exterior. Tech still performs the perimeter treatment.' },
};
const SERVICE_PREF_KEYS = Object.keys(SERVICE_PREFS);
const DEFAULT_PREFS = SERVICE_PREF_KEYS.reduce((a, k) => (a[k] = true, a), {});

const SERVICE_COPY = {
  pest_control: {
    headline: "Hey {first}, choose your pest control option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your property before pricing this estimate',
    aiBody: 'We reviewed your home, lot, and pest-risk factors before pricing this plan.',
    askChips: [
      'How do you handle ants?',
      'Can you treat inside?',
      'When am I charged?',
      'What happens after approval?',
    ],
    priceWording: {},
  },
  rodent: {
    headline: "Hey {first}, here's your rodent remediation plan.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed rodent activity signals at your property',
    aiBody: 'We reviewed property conditions linked to rodent pressure and entry risk.',
    askChips: [
      'Trapping vs exclusion?',
      'Do I need sanitation?',
      'Is the inspection fee credited?',
      "How long until they're gone?",
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  tree_shrub: {
    headline: "Hey {first}, choose your tree & shrub option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your beds and trees before pricing this estimate',
    aiBody: 'We reviewed your beds, trees, and treatment needs before pricing this plan.',
    askChips: [
      'Which trees get treated?',
      'What gets applied?',
      'When do visits start?',
      'Can I prepay annually?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  mosquito: {
    headline: "Hey {first}, choose your mosquito control option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your lot and mosquito pressure before pricing this estimate',
    aiBody: 'We reviewed your lot, resting zones, and mosquito pressure before pricing this plan.',
    askChips: [
      'How long does each visit last?',
      'Pet & kid safe?',
      'When does the season start?',
      'What about my pool area?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  termite_bait: {
    headline: "Hey {first}, choose your termite protection option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your termite perimeter before pricing this estimate',
    aiBody: 'We reviewed your home, lot, and termite perimeter before pricing this plan.',
    askChips: [
      "What's monitored?",
      'How often are stations checked?',
      'Basic vs Premier?',
      'What about active termites?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  foam_recurring: {
    headline: "Hey {first}, choose your recurring foam treatment option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your foam treatment scope before pricing this plan',
    aiBody: 'We reviewed the drill points and treatment areas before pricing this recurring foam plan.',
    askChips: [
      'What does each visit cover?',
      'How often do you come out?',
      'Can I prepay annually?',
      'What about active termites?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  termite_trenching: {
    headline: "Hey {first}, here's your termite trenching quote.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI mapped your trenching path and confirmed required linear feet',
    aiBody: 'We measured the trenching path and linear footage used for this quote.',
    askChips: [
      'How long does the barrier last?',
      'What product is used?',
      "What's covered?",
      'Do you renew it?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this quote.",
    },
  },
  pre_slab_termiticide: {
    headline: "Hey {first}, here's your pre-slab termite treatment quote.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed the slab area before pricing this estimate',
    aiBody: 'We priced the pre-slab soil treatment from the measured slab area, selected product, and warranty option.',
    askChips: [
      'What product is used?',
      'Do I get documentation?',
      'What warranty is selected?',
      'When should this be done?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this quote.",
    },
  },
  bora_care: {
    headline: "Hey {first}, here's your Bora-Care wood treatment quote.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your wood-treatment areas before pricing this estimate',
    aiBody: 'We priced the Bora-Care borate wood treatment from the measured attic and surface areas and the product application rate.',
    askChips: [
      'What does Bora-Care treat?',
      'Is Bora-Care safe for pets & kids?',
      'What product is used for Bora-Care?',
      'When should this be done?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this quote.",
    },
  },
  lawn_care: {
    headline: "Hey {first}, choose your lawn care option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your lawn before pricing this estimate',
    aiBody: 'We reviewed your lawn size, turf type, and treatment needs before pricing this plan.',
    askChips: [
      'How does your lawn assessment tech work?',
      'What lawn issues do you check?',
      'When do visits start?',
      'What about weeds?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for lawn care.",
    },
  },
  bundle: {
    headline: "Hey {first}, here's your custom Waves plan.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your property before pricing this estimate',
    aiBody: 'We reviewed the services, property details, and pricing rules used for this plan.',
    askChips: [
      'What is included in this plan?',
      'How do you handle ants?',
      'How does your lawn assessment tech work?',
      'Are pets and kids safe?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
};

// Map a recurring frequency label → visits per year. Used to convert
// per-visit discount into the monthly-displayed discount so the
// estimator math stays honest (quarterly customers see $3.33/mo per
// toggle, monthly customers see $10/mo per toggle, etc.).
function visitsPerYearFromFrequency(freq) {
  const f = String(freq || '').toLowerCase().replace(/[-_\s]/g, '');
  if (f === 'monthly') return 12;
  if (f === 'bimonthly' || f === 'everyotherweek' || f === 'everyothermonth') return 6;
  if (f === 'quarterly' || f === '') return 4;
  if (f === 'semiannual' || f === 'biannual') return 2;
  if (f === 'annual' || f === 'yearly') return 1;
  return 4;
}

function frequencyKeyFromVisitsPerYear(visitsPerYear) {
  const n = Number(visitsPerYear || 0);
  if (n >= 12) return 'monthly';
  if (n >= 6) return 'bi_monthly';
  return 'quarterly';
}

function billingIntervalMonthsForFrequencyKey(key) {
  if (key === 'quarterly') return 3;
  if (key === 'bi_monthly') return 2;
  return 1;
}

function pricePeriodLabelForFrequencyKey(key) {
  if (key === 'quarterly') return '/quarter';
  if (key === 'bi_monthly') return '/bi-monthly';
  return '/mo';
}

function pricePeriodWordForFrequencyKey(key) {
  if (key === 'quarterly') return 'quarter';
  if (key === 'bi_monthly') return 'bi-monthly visit';
  return 'month';
}

function intervalPriceFromMonthly(monthlyAmount, frequencyKey) {
  const amount = Number(monthlyAmount || 0) * billingIntervalMonthsForFrequencyKey(frequencyKey);
  return Math.round(amount * 100) / 100;
}

// How many pest-control recurring services are in this estimate + the
// lowest visit frequency among them. Returns null if there's no pest
// line at all (in which case we hide the prefs toggles entirely).
// `monthlyBase` is the sum of the pest line(s) monthly total before the
// preference toggles are applied — used together with the engine's
// PEST.floor to cap how much the toggles can discount.
function detectPestRecurring(recurring) {
  // RESIDENTIAL pest only. The interior-spray / exterior-eave-sweep opt-out
  // ($10/visit each) is a residential-pest preference; commercial_pest is FLAT.
  // Match by the normalized service KEY, NOT a /pest/i name substring — which
  // also matches "Commercial Pest Control" and would let a customer subtract the
  // residential opt-out discounts from (and persist a lower) commercial price.
  const pest = (recurring || []).filter((s) => recurringServiceKey(s) === 'pest_control');
  if (!pest.length) return null;
  const vpy = pest.reduce((acc, s) => Math.max(acc, visitsPerYearFromFrequency(s.frequency || s.billing || s.cadence)), 0) || 4;
  const monthlyBase = pest.reduce((acc, s) => acc + Number(s.mo || s.monthly || 0), 0);
  return { count: pest.length, visitsPerYear: vpy, monthlyBase };
}

// The interior-spray / exterior-eave-sweep preference toggles describe the
// GENERAL pest-control visit. They do not apply to specialty one-time services
// (German Roach Cleanout, standalone cockroach, wasp/stinging, exclusion, etc.),
// so only a general one-time pest line should surface them.
function isGeneralPestOneTimeItem(it = {}) {
  const service = String(it.service || '').toLowerCase();
  // Commercial pest is flat (no interior/exterior opt-out) — never a general
  // residential pest item, even though its name contains "Pest".
  if (service.startsWith('commercial_')) return false;
  if (service === 'one_time_pest' || service === 'pest_control') return true;
  if (service === 'german_roach') return false; // specialty cleanout (handled separately)
  const name = String(it.name || it.displayName || it.label || '').toLowerCase();
  // Specialty programs — interior-spray / eave-sweep don't apply to these.
  // Note: a plain "cleanout" (e.g. the general "Initial Pest Cleanout" service)
  // is NOT a specialty and keeps the toggles; only roach/insect specialties drop them.
  if (/roach|cockroach|wasp|bee|hornet|stinging|exclusion|flea|bed\s*bug|termite|rodent|wdo|mosquito|tree|shrub|lawn/.test(name)) return false;
  return /pest|\bant\b/.test(name);
}

function detectPestOneTime(oneTimeItems) {
  return (oneTimeItems || []).some(isGeneralPestOneTimeItem);
}

// Sum of general one-time pest item prices on this estimate (matches
// detectPestOneTime). Used to clamp the one-time toggle discount above
// ONE_TIME.pest.floor.
function pestOneTimeBase(oneTimeItems) {
  return (oneTimeItems || [])
    .filter(isGeneralPestOneTimeItem)
    .reduce((acc, it) => acc + Number(it.price || 0), 0);
}

// German Roach Cleanout is a multi-visit specialty program (priced one-time but
// run over 2/3/4 visits). It gets its own customer copy + the Waves Guarantee,
// and never the general-pest preference toggles.
//
// Match the standalone cleanout only — the canonical `german_roach` service
// key, or a name that names the cleanout program ("roach … cleanout"). A bare
// "german roach" mention is NOT enough: a recurring pest plan's first-visit
// add-on (Initial German Roach Knockdown, service `pest_initial_roach`) also
// says "German Roach" but is not the cleanout, and must not inherit cleanout
// copy or specialty Ask Waves prompts.
function isGermanRoachCleanoutOneTimeItem(it = {}) {
  const service = String(it.service || '').toLowerCase();
  if (service === 'german_roach') return true;
  if (service === 'pest_initial_roach') return false; // first-visit knockdown add-on, not the cleanout
  const raw = [it.name, it.label, it.displayName].filter(Boolean).join(' ').toLowerCase();
  return raw.includes('roach') && raw.includes('cleanout');
}

function germanRoachVisitPhrase(visits) {
  const n = Number(visits) || 0;
  const words = { 1: 'One visit', 2: 'Two visits', 3: 'Three visits', 4: 'Four visits' };
  return words[n] || (n > 0 ? `${n} visits` : 'Multiple visits');
}

// German-roach specialty Ask Waves prompts. Both carry the "roach" keyword so
// the Ask Waves fallback routes them to the pest/roach answer branch (the
// multi-visit cleanout copy), not the generic scheduling or catch-all reply.
// Shared so the server-rendered page (buildEstimateAskPrompts) and the React
// data contract (attachPublicPricingContract) surface identical chips.
const GERMAN_ROACH_ASK_CHIPS = [
  'How do you get rid of German roaches?',
  'How long until the roaches are gone?',
];

// Generic pest_control service chips the German-roach specialty replaces. The
// universal billing chips in SERVICE_COPY.pest_control.askChips ("When am I
// charged?", "What happens after approval?") are kept.
const GENERIC_PEST_SERVICE_CHIPS = ['How do you handle ants?', 'Can you treat inside?'];

// Safety quick-question shown for any chemical service. Shared so the React
// data contract surfaces it for roach cleanouts exactly like buildEstimateAskPrompts.
const SAFETY_ASK_CHIP = 'Are pets and kids safe?';
// Bora-Care-only quotes use a Bora-Care-worded safety chip so it routes to the
// borate-specific answer instead of the generic label-direction safety copy.
const BORA_CARE_SAFETY_ASK_CHIP = 'Is Bora-Care safe for pets & kids?';
// Bora-Care service chip — shared between the SSR prompt builder and the React
// pricing contract so a Bora-Care add-on surfaces it on both paths.
const BORA_CARE_ASK_CHIP = 'What does Bora-Care treat?';

// Service-aware "Ask Waves" quick-question chips: up to 2 estimate-specific
// service prompts, a safety chip for any chemical service, then universal
// billing chips — capped at 4 so the prompt row stays scannable.
//
// German Roach Cleanout is a one-time specialty that detectPestOneTime
// deliberately excludes (it never trips hasPestOneTime), so it's detected on
// its own here. Without this, a German-roach estimate falls back to the
// generic billing-only chips with no specialty prompts.
function buildEstimateAskPrompts(recurring = [], oneTimeItems = [], pestRecurring = null, hasPestOneTime = false) {
  const recurringList = Array.isArray(recurring) ? recurring : [];
  const oneTimeList = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  const servicePrompts = [];
  const hasLawn = recurringList.some((s) => /lawn|turf/i.test(s?.name || s?.label || s?.service || ''));
  const hasMosquito = recurringList.some((s) => /mosquito/i.test(s?.name || s?.label || s?.service || ''))
    || oneTimeList.some((item) => serviceCategoryForOneTimeItem(item) === 'mosquito');
  // Bora-Care rows are excluded here even when their label contains "termite"
  // so the bait/barrier branch never fires for them — they get their own prompt.
  const hasTermite = recurringList.some((s) => /termite/i.test(s?.name || s?.label || s?.service || ''))
    || oneTimeList.some((item) => !isBoraCareOneTimeItem(item)
      && (/termite/i.test(item?.service || item?.label || item?.name || '')
        || ['termite_bait', 'termite_trenching', 'pre_slab_termiticide'].includes(serviceCategoryForOneTimeItem(item))));
  const hasTreeShrub = recurringList.some((s) => /\btree\b|shrub/i.test(s?.name || s?.label || s?.service || ''));
  const hasRodent = recurringList.some((s) => /rodent/i.test(s?.name || s?.label || s?.service || ''));
  const hasPalm = recurringList.some((s) => /palm/i.test(s?.name || s?.label || s?.service || ''));
  // Bora-Care is a borate wood treatment, not a bait or barrier — keep it off
  // the termite-method branch above and give it its own prompt.
  const hasBoraCare = oneTimeList.some(isBoraCareOneTimeItem);
  const hasGermanRoach = oneTimeList.some(isGermanRoachCleanoutOneTimeItem)
    || recurringList.some(isGermanRoachCleanoutOneTimeItem);
  const hasPestAny = !!pestRecurring || hasPestOneTime || hasGermanRoach;
  if (hasGermanRoach) {
    servicePrompts.push(...GERMAN_ROACH_ASK_CHIPS);
  } else if (hasPestAny) {
    servicePrompts.push('How do you handle ants?');
  }
  if (hasLawn) servicePrompts.push('How does your lawn assessment tech work?');
  if (hasMosquito) servicePrompts.push('How long does it last?');
  if (hasTermite) {
    // Match the prompt to the actual termite method so the chip isn't
    // misleading. Pre-slab is a soil treatment and trenching is a liquid
    // barrier — neither uses bait stations. Recurring/monitoring termite plans
    // keep the bait prompt. Mirrors the per-subtype chips in SERVICE_COPY.
    const termiteOneTimeCategories = oneTimeList.map(serviceCategoryForOneTimeItem);
    if (oneTimeList.some(isPreSlabOneTimeItem) || termiteOneTimeCategories.includes('pre_slab_termiticide')) {
      servicePrompts.push('How does pre-slab treatment work?');
    } else if (termiteOneTimeCategories.includes('termite_trenching')) {
      servicePrompts.push('How long does the barrier last?');
    } else {
      servicePrompts.push('How does the bait work?');
    }
  }
  if (hasTreeShrub) servicePrompts.push('Which trees get treated?');
  if (hasRodent) servicePrompts.push('Where do bait stations go?');
  if (hasPalm) servicePrompts.push('Why injections vs. spray?');
  // Bora-Care is an unusual one-time add-on; prioritize its chip so a mixed
  // estimate with two other service prompts still surfaces it before the slice.
  if (hasBoraCare) servicePrompts.unshift(BORA_CARE_ASK_CHIP);

  const hasChemicalService = hasPestAny || hasLawn || hasMosquito || hasTermite || hasTreeShrub || hasRodent || hasPalm || hasBoraCare;
  // A Bora-Care-only quote gets a Bora-Care-worded safety chip so clicking it
  // reaches the borate-specific answer; mixed estimates keep the generic chip.
  // "Only" mirrors hasOnlyBoraCareServiceMix: no other recurring service flag and
  // no other billable one-time row. Use isNonBillableOneTimeRow (NOT
  // isBillableOneTimeInvoiceItem, which exempts one_time_adjustment) so a *positive*
  // adjustment counts as another billable charge and blocks the Bora-Care-only chip.
  const hasOtherBillableOneTime = oneTimeList.some(
    (it) => !isBoraCareOneTimeItem(it) && !isNonBillableOneTimeRow(it),
  );
  const boraCareOnly = hasBoraCare && !hasPestAny && !hasLawn && !hasMosquito
    && !hasTermite && !hasTreeShrub && !hasRodent && !hasPalm && !hasOtherBillableOneTime;
  const prompts = servicePrompts.slice(0, 2);
  if (hasChemicalService) prompts.push(boraCareOnly ? BORA_CARE_SAFETY_ASK_CHIP : SAFETY_ASK_CHIP);
  for (const prompt of ['When am I charged?', 'What happens after approval?']) {
    if (prompts.length >= 4) break;
    prompts.push(prompt);
  }
  return prompts;
}

// Minimum monthly price for a recurring pest plan at the given cadence,
// derived from the engine's own floor rather than a chosen fraction.
// Mirrors service-pricing.js `pricePestControl`: basePrice is floored
// at PEST.floor, then multiplied by the cadence's frequency multiplier
// before being turned into a monthly. Defaults to v1 rates (the live
// shape for admin-created estimates); v2 multipliers are slightly
// gentler so falling back to v1 just makes the floor a touch lower,
// which is the safer direction.
function pestMonthlyFloor(visitsPerYear) {
  const freqKey = visitsPerYear >= 12 ? 'monthly'
                : visitsPerYear >= 6  ? 'bimonthly'
                : 'quarterly';
  const freqMult = PEST.frequencyDiscounts.v1?.[freqKey] ?? 1.0;
  return PEST.floor * freqMult * visitsPerYear / 12;
}

function normalizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (raw && typeof raw === 'object') {
    for (const k of SERVICE_PREF_KEYS) {
      if (k in raw) out[k] = raw[k] !== false;
    }
  }
  return out;
}

// Compute the monthly + one-time discount for a given set of prefs.
// Returns { monthlyOff, oneTimeOff } in dollars (positive numbers).
// Clamps so the remaining pest price never drops below the engine's
// own floors (PEST.floor for recurring per-visit, ONE_TIME.pest.floor
// for one-time). Without the clamp, a small pest estimate could be
// dragged to $0 via the toggles.
// Resolve the pre-discount monthly base from an estimate row + parsed
// estimate_data blob, in priority order:
//   1. recurring.services plus supplemental palm/rodent recurring fields
//      (lets customer-facing recalculation keep non-qualifiers separate)
//   2. estimate_data.baseMonthly / preDiscountMonthly  (explicit, set by
//      a prior /preferences self-heal or by the engine when it rendered
//      the estimate)
//   3. engine result's annualBeforeDiscount / 12
//   4. estimate.monthly_total — DISCOUNTED. Last-resort fallback. Stale
//      after a tier change since it reflects the previous tier's discount;
//      callers that need to recompute under a new tier should treat this
//      branch as a smell.
//
// Returns { baseMonthly, source } so callers can see which branch fired
// and decide whether to persist baseMonthly back to estimate_data
// (self-heal). The source string is one of:
//   'explicit' | 'engine' | 'summed' | 'fallback-discounted'
function monthlyValueForRecurringService(svc = {}) {
  const monthly = firstPositiveNumber(svc.mo, svc.monthly, svc.monthlyTotal);
  if (monthly) return monthly;
  const annual = firstPositiveNumber(svc.annualAfterCredits, svc.annualAfterDiscount, svc.annual);
  return annual ? annual / 12 : 0;
}

function roundMonthly(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function resolveExplicitDiscountableMonthly(explicit, nonDiscountableMonthly, estimate = {}) {
  if (!(explicit > 0)) return 0;
  if (!(nonDiscountableMonthly > 0)) return explicit;

  const currentMonthly = Number(estimate.monthly_total ?? estimate.monthlyTotal ?? 0);
  if (currentMonthly > 0) {
    const discount = tierDiscount(estimate.waveguard_tier || estimate.waveGuardTier || estimate.tier);
    const asTotalDiscountable = Math.max(0, explicit - nonDiscountableMonthly);
    const asTotalMonthly = roundMonthly((asTotalDiscountable * (1 - discount)) + nonDiscountableMonthly);
    const asDiscountableMonthly = roundMonthly((explicit * (1 - discount)) + nonDiscountableMonthly);
    if (Math.abs(asTotalMonthly - currentMonthly) + 0.5 < Math.abs(asDiscountableMonthly - currentMonthly)) {
      return asTotalDiscountable;
    }
  }

  return explicit;
}

function resolveRecurringMonthlyParts(estimate, parsedData) {
  const estResult = parsedData?.result || parsedData || {};
  const recurringServices = recurringServicesWithSupplements(estResult);
  const serviceParts = recurringServices.reduce((parts, svc) => {
    const monthly = monthlyValueForRecurringService(svc);
    if (!(monthly > 0)) return parts;
    if (recurringServiceReceivesTierDiscount(svc)) {
      parts.discountableBaseMonthly += monthly;
    } else {
      parts.nonDiscountableMonthly += monthly;
    }
    return parts;
  }, { discountableBaseMonthly: 0, nonDiscountableMonthly: 0 });
  const explicit = Number(parsedData?.baseMonthly || parsedData?.preDiscountMonthly || 0);
  const engineDerived = Number(estResult?.recurring?.annualBeforeDiscount || 0) / 12;
  const nonDiscountableMonthly = serviceParts.nonDiscountableMonthly;
  const discountableFromServices = serviceParts.discountableBaseMonthly;
  const discountableFromFallback = engineDerived > 0
    ? engineDerived
    : resolveExplicitDiscountableMonthly(explicit, nonDiscountableMonthly, estimate);
  const discountableBaseMonthly = discountableFromServices > 0
    ? discountableFromServices
    : discountableFromFallback;
  const serviceTotal = discountableBaseMonthly + nonDiscountableMonthly;
  if (recurringServices.length > 0 && serviceTotal > 0) {
    return {
      baseMonthly: roundMonthly(serviceTotal),
      discountableBaseMonthly: roundMonthly(discountableBaseMonthly),
      nonDiscountableMonthly: roundMonthly(nonDiscountableMonthly),
      source: 'summed',
    };
  }

  if (explicit > 0) {
    return {
      baseMonthly: explicit,
      discountableBaseMonthly: explicit,
      nonDiscountableMonthly: 0,
      source: 'explicit',
    };
  }

  if (engineDerived > 0) {
    const baseMonthly = roundMonthly(engineDerived);
    return {
      baseMonthly,
      discountableBaseMonthly: baseMonthly,
      nonDiscountableMonthly: 0,
      source: 'engine',
    };
  }

  const fallback = Number(estimate.monthly_total ?? estimate.monthlyTotal ?? 0);
  return {
    baseMonthly: fallback,
    discountableBaseMonthly: fallback,
    nonDiscountableMonthly: 0,
    source: 'fallback-discounted',
  };
}

function monthlyForRecurringParts(parts = {}, tier, monthlyOff = 0, discountResolver = tierDiscount) {
  const discountable = Number(parts.discountableBaseMonthly || 0);
  const nonDiscountable = Number(parts.nonDiscountableMonthly || 0);
  const off = Number(monthlyOff || 0);
  const total = discountable * (1 - discountResolver(tier)) + nonDiscountable - off;
  return Math.max(0, Math.round(total * 100) / 100);
}

function normalizeManualDiscountSummary(estData = {}) {
  const result = estData?.result && typeof estData.result === 'object'
    ? estData.result
    : (estData?.engineResult && typeof estData.engineResult === 'object' ? estData.engineResult : estData);
  const candidates = [
    result?.manualDiscount,
    result?.totals?.manualDiscount,
    result?.summary?.manualDiscount,
    estData?.summary?.manualDiscount,
  ];
  const manual = candidates.find((item) => item && Number(item.amount) > 0);
  if (!manual) return null;
  const amount = Math.round(Number(manual.amount) * 100) / 100;
  return {
    ...manual,
    amount,
    label: manual.label || manual.catalogName || (manual.type === 'PERCENT' ? `Discount (${manual.value}%)` : 'Discount'),
    scope: manual.scope || 'recurring_annual_after_waveguard',
    stackingOrder: manual.stackingOrder || 'after_waveguard',
  };
}

function manualDiscountMonthlyAmount(estData = {}) {
  const manual = normalizeManualDiscountSummary(estData);
  if (!manual) return 0;
  // Monthly figure tracks the recurring slice only; the one-time slice is shown
  // in the one-time total, not amortized across recurring months.
  const recurring = Number(manual.recurringAmount ?? manual.amount);
  return recurring > 0 ? Math.round((recurring / 12) * 100) / 100 : 0;
}

function manualDiscountForRecurringBase(manualDiscount = null, discountableAnnualBase = 0) {
  if (!manualDiscount || !(discountableAnnualBase > 0)) return null;
  const type = manualDiscount.type === 'PERCENT' ? 'PERCENT' : 'FIXED';
  const value = Number(manualDiscount.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const recurringBase = Math.round(discountableAnnualBase * 100) / 100;
  let amount;
  let requestedAmount;
  let capped = false;
  if (type === 'PERCENT') {
    amount = Math.round(recurringBase * (value / 100) * 100) / 100;
    requestedAmount = amount;
  } else {
    // FIXED dollar discounts were already split into recurring/one-time slices by
    // generateEstimate, and the one-time slice is cadence-invariant (one-time
    // work doesn't change with the recurring cadence). Derive the recurring slice
    // as (value − one-time slice) capped to THIS cadence's recurring base, so
    // recurring + one-time always sums back to the fixed value regardless of the
    // cadence the customer picks — never re-proportion against the recurring base
    // alone, which would leave the two slices no longer totaling the fixed amount.
    requestedAmount = Math.round(value * 100) / 100;
    const savedOneTime = Math.max(0, Number(manualDiscount.oneTimeAmount) || 0);
    const recurringSlice = Math.max(0, Math.round((requestedAmount - savedOneTime) * 100) / 100);
    amount = Math.min(recurringSlice, recurringBase);
    capped = amount < recurringSlice;
  }
  if (!(amount > 0)) return null;
  return {
    ...manualDiscount,
    type,
    value,
    requestedAmount,
    amount,
    // This per-cadence object represents only the recurring price card, so its
    // whole amount is the recurring slice. Overwrite the (stale) spread
    // recurringAmount/oneTimeAmount from the originally generated cadence.
    recurringAmount: amount,
    oneTimeAmount: 0,
    monthlyAmount: Math.round((amount / 12) * 100) / 100,
    discountableBase: recurringBase,
    capped: capped || manualDiscount.capped === true,
    capReason: capped ? 'discountable_base' : (manualDiscount.capReason || null),
    scope: manualDiscount.scope || 'recurring_annual_after_waveguard',
    stackingOrder: manualDiscount.stackingOrder || 'after_waveguard',
  };
}

function resolveBaseMonthly(estimate, parsedData) {
  const parts = resolveRecurringMonthlyParts(estimate, parsedData);
  return { baseMonthly: parts.baseMonthly, source: parts.source };
}

function computePrefDiscount(prefs, pestRecurring, hasPestOneTime, pestOneTimeTotal = 0) {
  let monthlyOff = 0;
  let oneTimeOff = 0;
  const p = normalizePrefs(prefs);
  for (const k of SERVICE_PREF_KEYS) {
    if (p[k] === false) {
      if (pestRecurring) {
        // $perVisit × visits/yr ÷ 12 = monthly-equivalent discount
        monthlyOff += (SERVICE_PREFS[k].perVisit * pestRecurring.visitsPerYear) / 12;
      }
      if (hasPestOneTime) {
        oneTimeOff += SERVICE_PREFS[k].oneTime;
      }
    }
  }
  if (pestRecurring) {
    const floor = pestMonthlyFloor(pestRecurring.visitsPerYear);
    const pestMonthlyBase = Number(pestRecurring.monthlyBase || 0);
    const maxMonthlyOff = Math.max(0, pestMonthlyBase - floor);
    monthlyOff = Math.min(monthlyOff, maxMonthlyOff);
  }
  if (pestOneTimeTotal > 0) {
    const maxOneTimeOff = Math.max(0, pestOneTimeTotal - ONE_TIME.pest.floor);
    oneTimeOff = Math.min(oneTimeOff, maxOneTimeOff);
  }
  return {
    monthlyOff: Math.round(monthlyOff * 100) / 100,
    oneTimeOff: Math.round(oneTimeOff * 100) / 100,
  };
}

function preferenceMonthlyOffForPestVisits(prefs, visitsPerYear, monthlyBase = null) {
  const visits = Number(visitsPerYear || 0);
  if (!(visits > 0)) return 0;
  const p = normalizePrefs(prefs);
  const monthlyOff = SERVICE_PREF_KEYS.reduce((sum, key) => {
    return p[key] === false ? sum + ((SERVICE_PREFS[key].perVisit * visits) / 12) : sum;
  }, 0);
  const base = Number(monthlyBase);
  let cappedOff = monthlyOff;
  if (Number.isFinite(base) && base > 0) {
    const floor = pestMonthlyFloor(visits);
    if (base - cappedOff < floor) {
      cappedOff = Math.max(0, base - floor);
    }
  }
  return Math.round(cappedOff * 100) / 100;
}

const PERKS = [
  'Priority scheduling — you jump the queue',
  'Re-service between visits at no charge',
  'Locked-in pricing for 12 months',
  'Free annual termite inspection',
  '15% off any one-time treatment',
  'One point of contact — no call-center runaround',
  'Text your tech directly for quick questions',
  'Customer portal for service history, invoices, and payments',
  'Owner-operator accountability on every visit',
];

const LAWN_CARE_PERKS = [
  'Locked-in pricing for 12 months',
  'Seasonal product rotations matched to Southwest Florida turf cycles',
  'Lawn health scored every visit — turf density, weeds, and color tracked over time',
  'Re-service between visits at no charge',
  'Text your tech directly for quick questions',
  'Billing after completed lawn care visits',
  'Owner-operator accountability on every visit',
];

const MOSQUITO_PERKS = [
  'Directed barrier applications to mosquito resting zones',
  'Standing-water and breeding-source notes after visits',
  'Program options matched to seasonal or monthly pressure',
  'Owner-operator accountability on every visit',
];

const TERMITE_BAIT_PERKS = [
  'Termite station service matched to your home perimeter',
  'Visit notes after completed termite protection visits',
  'Locked-in pricing for 12 months',
  'Owner-operator accountability on every visit',
];

// Canonical SWFL stores — name, physical address, ZIPs, spoke page slug
// on wavespestcontrol.com, and Google Place ID for map links. Mirrors
// server/config/locations.js but kept inline so the SSR estimate page
// stays self-contained (no require cycle at render time).
const LOCATIONS = [
  { name: 'Lakewood Ranch', address: '13649 Luxe Ave #110, Bradenton, FL 34211', phone: WAVES_SUPPORT_PHONE_DISPLAY, phoneRaw: WAVES_SUPPORT_PHONE_E164, slug: 'pest-control-bradenton-fl', placeId: 'ChIJVbBOKGYyTCgRVFz8_lu61Mw' },
  { name: 'Parrish',        address: '5155 115th Cir E, Parrish, FL 34219',      phone: '(941) 297-2817', phoneRaw: '+19412972817', slug: 'pest-control-parrish-fl',   placeId: 'ChIJM32aQRIlw4gRr7goqhbAVpw' },
  { name: 'Sarasota',       address: '1450 Pine Warbler Pl, Sarasota, FL 34240', phone: '(941) 297-2606', phoneRaw: '+19412972606', slug: 'pest-control-sarasota-fl',  placeId: 'ChIJeT_63_Y5w4gRGTNLozgSmdw' },
  { name: 'Venice',         address: '1978 S Tamiami Trl #10, Venice, FL 34293', phone: '(941) 297-3337', phoneRaw: '+19412973337', slug: 'pest-control-venice-fl',    placeId: 'ChIJ81vmrblZw4gRREDmlDUpq0E' },
];

// Footer — company contact + social profiles. Kept in one place so the
// estimate footer and (future) other SSR customer surfaces share exactly
// one source.
const COMPANY = {
  legalName: 'Waves Pest Control, LLC',
  phone: WAVES_SUPPORT_PHONE_DISPLAY,
  phoneRaw: WAVES_SUPPORT_PHONE_E164,
  email: 'contact@wavespestcontrol.com',
};

const SOCIAL_LINKS = [
  { name: 'Facebook',  url: 'https://facebook.com/wavespestcontrol',  path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol', path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
  { name: 'YouTube',   url: 'https://youtube.com/@wavespestcontrol',  path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  { name: 'TikTok',    url: 'https://tiktok.com/@wavespestcontrol',   path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { name: 'X',         url: 'https://x.com/wavespest',                path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
];

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isPresent(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

// Reason tokens that get purpose-written customer copy instead of a humanized
// token (mirrors client/src/lib/quoteDisplay). "commercial_risk_type_review"
// would otherwise read "Commercial risk type review" (internal jargon).
const FRIENDLY_QUOTE_REASONS = {
  commercial_risk_type_review:
    'Your Waves account manager will confirm this commercial service plan with you before it’s finalized.',
  commercial_low_confidence_site_confirmation:
    'This commercial estimate needs a quick site confirmation — your Waves account manager will confirm the price with you before it’s finalized.',
};

function humanizeQuoteReason(value) {
  if (!isPresent(value)) return '';
  const raw = String(value).trim();
  const friendly = FRIENDLY_QUOTE_REASONS[raw.toLowerCase()];
  if (friendly) return friendly;
  const looksLikeToken = raw.includes('_') || /^[A-Z0-9-]+$/.test(raw);
  if (!looksLikeToken) return raw;
  const sentence = raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return sentence ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : '';
}

function quoteRequiredReasonCandidates(item = {}) {
  if (!item || typeof item !== 'object') return [];
  const candidates = [
    item.customQuoteReason,
    item.quoteRequiredReason,
    item.reason,
    item.warning,
    item.warningText,
    ...(Array.isArray(item.warnings) ? item.warnings : []),
    ...(Array.isArray(item.manualReviewReasons) ? item.manualReviewReasons : []),
    ...(Array.isArray(item.measurementWarnings) ? item.measurementWarnings : []),
  ];
  const seen = new Set();
  return candidates
    .map(humanizeQuoteReason)
    .filter(Boolean)
    .filter((reason) => {
      const key = reason.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function quoteRequiredReasonText(item = {}, fallback = 'Inspection required before final pricing.') {
  return quoteRequiredReasonCandidates(item)[0] || fallback;
}

function rawQuoteRequiredReason(item = {}) {
  if (!item || typeof item !== 'object') return null;
  const candidates = [
    item.reason,
    item.customQuoteReason,
    item.quoteRequiredReason,
    item.warning,
    item.warningText,
    ...(Array.isArray(item.warnings) ? item.warnings : []),
    ...(Array.isArray(item.manualReviewReasons) ? item.manualReviewReasons : []),
    ...(Array.isArray(item.measurementWarnings) ? item.measurementWarnings : []),
  ];
  return candidates.find(isPresent) || null;
}

function fmtMoney(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function roundPositiveMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

function buildStandardPayPerApplicationInvoiceCopy({
  setupAmount = 0,
  firstApplicationAmount = 0,
  fallbackNoPaymentCopy = 'No payment is charged on this page. Your first service visit will be billed after completion.',
} = {}) {
  const setup = roundPositiveMoney(setupAmount);
  const firstApplication = roundPositiveMoney(firstApplicationAmount);
  const total = Math.round((setup + firstApplication) * 100) / 100;
  const hasSetup = setup > 0;
  const hasFirstApplication = firstApplication > 0;

  if (hasSetup && hasFirstApplication) {
    return {
      hasSetup,
      hasFirstApplication,
      setupAmount: setup,
      firstApplicationAmount: firstApplication,
      totalAmount: total,
      payAfterBody: `Approve now; after you confirm, we send the setup + first application invoice for ${fmtMoney(total)} so you can pay before service.`,
      payPrefCardSub: `Invoice includes WaveGuard setup + first application (${fmtMoney(total)}).`,
      billingSmall: `No payment is charged on this page. After confirmation, we open an invoice for setup plus the first application totaling ${fmtMoney(total)}.`,
    };
  }

  if (hasSetup) {
    return {
      hasSetup,
      hasFirstApplication,
      setupAmount: setup,
      firstApplicationAmount: firstApplication,
      totalAmount: total,
      payAfterBody: `Approve now; after you confirm, we send the WaveGuard setup invoice for ${fmtMoney(setup)} so you can pay before service.`,
      payPrefCardSub: `Invoice includes WaveGuard setup (${fmtMoney(setup)}).`,
      billingSmall: `No payment is charged on this page. After confirmation, we open the ${fmtMoney(setup)} setup invoice so you can pay in-flow.`,
    };
  }

  if (hasFirstApplication) {
    return {
      hasSetup,
      hasFirstApplication,
      setupAmount: setup,
      firstApplicationAmount: firstApplication,
      totalAmount: total,
      payAfterBody: `Approve now; after you confirm, we send the first application invoice for ${fmtMoney(firstApplication)} so you can pay before service.`,
      payPrefCardSub: `Invoice includes the first application (${fmtMoney(firstApplication)}).`,
      billingSmall: `No payment is charged on this page. After confirmation, we open the first application invoice for ${fmtMoney(firstApplication)}.`,
    };
  }

  return {
    hasSetup,
    hasFirstApplication,
    setupAmount: setup,
    firstApplicationAmount: firstApplication,
    totalAmount: total,
    payAfterBody: fallbackNoPaymentCopy,
    payPrefCardSub: 'Your first service visit will be billed after completion.',
    billingSmall: fallbackNoPaymentCopy,
  };
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function treatmentVisitsForPricingRow(row = {}) {
  return firstPositiveNumber(
    row?.visitsPerYear,
    row?.appsPerYear,
    row?.visits,
    row?.apps,
    row?.frequency,
  );
}

function displayedTreatmentAmountForPricingRow(row = {}) {
  return firstPositiveNumber(
    row?.displayPrice,
    row?.netPerTreatment,
    row?.price,
    row?.perTreatment,
  );
}

function baseTreatmentAmountForPricingRow(row = {}) {
  return firstPositiveNumber(
    row?.perTreatment,
    row?.rawPerTreatment,
    row?.anchorPrice,
    row?.displayPrice,
    row?.netPerTreatment,
    row?.price,
  );
}

function pestRecurringForPricingRows(rows = []) {
  const pestRows = rows.filter((row) => recurringServiceKey(row) === 'pest_control');
  if (!pestRows.length) return null;
  const visitsPerYear = pestRows.reduce((max, row) => {
    const visits = treatmentVisitsForPricingRow(row);
    return visits && visits > max ? visits : max;
  }, 0) || 4;
  const monthlyBase = pestRows.reduce((sum, row) => {
    const amount = baseTreatmentAmountForPricingRow(row);
    const visits = treatmentVisitsForPricingRow(row) || visitsPerYear;
    return amount && visits ? sum + ((amount * visits) / 12) : sum;
  }, 0);
  return { count: pestRows.length, visitsPerYear, monthlyBase };
}

function sameDayVisitTotalForPricingFrequency(frequency = {}, opts = {}) {
  const rows = Array.isArray(frequency?.perServiceTreatments)
    ? frequency.perServiceTreatments
    : [];
  if (opts.services && !frequencyTreatmentsCoverServices(rows, opts.services)) return null;
  const fallback = Number(frequency?.sameDayTreatmentTotal);
  const prefMonthlyOff = opts.preferences
    ? computePrefDiscount(opts.preferences, pestRecurringForPricingRows(rows), false, 0).monthlyOff
    : 0;
  const pestRowWeights = rows.map((row) => {
    if (recurringServiceKey(row) !== 'pest_control') return 0;
    const amount = displayedTreatmentAmountForPricingRow(row);
    const visits = treatmentVisitsForPricingRow(row);
    return amount && visits ? (amount * visits) / 12 : 0;
  });
  const pestWeightTotal = pestRowWeights.reduce((sum, weight) => sum + weight, 0);
  let missingTreatmentAmount = false;
  const total = rows.reduce((sum, row, index) => {
    let amount = displayedTreatmentAmountForPricingRow(row);
    if (!(amount > 0)) {
      missingTreatmentAmount = true;
      return sum;
    }
    if (amount && prefMonthlyOff > 0 && pestWeightTotal > 0 && recurringServiceKey(row) === 'pest_control') {
      const visits = treatmentVisitsForPricingRow(row);
      const rowMonthlyOff = prefMonthlyOff * (pestRowWeights[index] / pestWeightTotal);
      const perTreatmentOff = visits ? (rowMonthlyOff * 12) / visits : 0;
      amount = Math.max(0, amount - perTreatmentOff);
    }
    return amount ? sum + amount : sum;
  }, 0);
  if (!missingTreatmentAmount && total > 0) return Math.round(total * 100) / 100;

  if (Number.isFinite(fallback) && fallback > 0) return Math.round(fallback * 100) / 100;
  return null;
}

function recurringServiceKey(svc = {}) {
  const raw = String(svc.service || svc.key || svc.name || svc.label || svc.displayName || '').toLowerCase();
  const words = raw.replace(/[_-]+/g, ' ');
  if (
    raw.includes('palm_injection')
    || raw.includes('palm_treatment')
    || /\bpalm injection\b|\bpalm tree\b|\bpalms?\b/.test(words)
  ) return 'palm_injection';
  // NOT commercial — commercial_rodent_bait must reach the commercial block below
  // and keep its distinct (non-WaveGuard-discountable) key.
  if (
    !raw.includes('commercial') && (
      raw.includes('rodent_bait')
      || raw.includes('rodent_monitoring')
      || (raw.includes('rodent') && /bait|station|monitor/.test(raw))
    )
  ) return 'rodent_bait';
  if (!raw.includes('commercial') && /\brodent\b|\brat\b|\bmouse\b|\bmice\b/.test(words)) return 'rodent';
  // Commercial auto-priced lines must keep a DISTINCT key — otherwise the
  // residential lawn/tree special-cases below normalize them to lawn_care /
  // tree_shrub, which are WaveGuard-qualifying, and an existing commercial
  // customer's flat commercial price gets discounted on accept (money bug).
  if (raw.includes('commercial')) {
    if (raw.includes('lawn') || raw.includes('turf')) return 'commercial_lawn';
    if (raw.includes('tree') || raw.includes('shrub') || raw.includes('ornamental')) return 'commercial_tree_shrub';
    if (raw.includes('mosquito')) return 'commercial_mosquito';
    // Only the recurring BAIT/monitoring/station programs get the bait key —
    // commercial termite trenching/WDO or rodent trapping/exclusion are one-time
    // specialty work, not the recurring line, and must not inherit its
    // discount/tax/scheduling behavior (mirrors the residential rodent_bait gate).
    if (raw.includes('termite') && /bait|station|monitor/.test(raw)) return 'commercial_termite_bait';
    if (raw.includes('rodent') && /bait|station|monitor/.test(raw)) return 'commercial_rodent_bait';
    if (raw.includes('pest')) return 'commercial_pest';
  }
  if (raw.includes('pest')) return 'pest_control';
  if (raw.includes('lawn')) return 'lawn_care';
  if (raw.includes('tree') || raw.includes('shrub') || raw.includes('ornamental')) return 'tree_shrub';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('termite') && raw.includes('bait')) return 'termite_bait';
  if (raw.includes('pre_slab') || raw.includes('pre-slab') || raw.includes('preslab') || /\bpre\s+slab\b/.test(words)) return 'pre_slab_termiticide';
  if (raw.includes('termite') && /(trench|trenching|liquid|barrier|termidor|treatment)/.test(raw)) return 'termite_trenching';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function recurringServiceReceivesTierDiscount(svc = {}) {
  const key = recurringServiceKey(svc);
  if (key === 'lawn_care') {
    return svc.excludeFromPctDiscount !== true;
  }
  if (
    svc.discountable === false ||
    svc.discount?.discountable === false ||
    svc.discount?.policy === 'LAWN_V2_NET_55_FLOOR_PRICE' ||
    svc.waveGuardDiscountEligible === false ||
    svc.discountEligible === false ||
    svc.excludeFromPctDiscount === true
  ) return false;
  if (key === 'palm_injection' || key === 'rodent_bait' || key === 'rodent') return false;
  if (PRICING_WAVEGUARD.excludedFromPercentDiscount[key] === true || svc.excludeFromPctDiscount === true) return false;
  if (PRICING_WAVEGUARD.qualifyingServices.includes(key)) return true;
  if (svc.waveGuardDiscountEligible === false || svc.discountEligible === false) return false;
  return false;
}

function recurringServiceReceivesManualDiscount(svc = {}) {
  const key = recurringServiceKey(svc);
  return ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito'].includes(key) &&
    svc.noRecurringDiscount !== true &&
    svc.discountEligible !== false &&
    svc.excludeFromPctDiscount !== true;
}

function recurringServiceCountsTowardTier(svc = {}) {
  const key = recurringServiceKey(svc);
  if (svc.waveGuardTierEligible === false || svc.countsTowardWaveGuardTier === false) return false;
  return PRICING_WAVEGUARD.qualifyingServices.includes(key);
}

function recurringServiceDisplayName(key) {
  switch (key) {
    case 'pest_control': return 'Pest Control';
    case 'lawn_care': return 'Lawn Care';
    case 'tree_shrub': return 'Tree & Shrub';
    case 'mosquito': return 'Mosquito';
    case 'termite_bait': return 'Termite Bait';
    case 'foam_recurring': return 'Recurring Foam Treatment';
    case 'palm_injection': return 'Palm Injection';
    case 'rodent_bait': return 'Rodent Bait Stations';
    case 'rodent': return 'Rodent Remediation';
    case 'commercial_lawn': return 'Commercial Turf Treatment Program';
    case 'commercial_tree_shrub': return 'Commercial Tree & Shrub';
    case 'commercial_pest': return 'Commercial Pest Control';
    case 'commercial_mosquito': return 'Commercial Mosquito';
    case 'commercial_termite_bait': return 'Commercial Termite Bait Monitoring';
    case 'commercial_rodent_bait': return 'Commercial Rodent Bait Stations';
    default: return null;
  }
}

function isLawnCareOneTimeItem(item = {}) {
  const raw = [item.service, item.name, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!raw || raw.includes('waveguard setup') || raw.includes('membership')) return true;
  return /\blawn|turf|weed|fertili[sz]|chinch|fung/.test(raw);
}

function isPreSlabOneTimeItem(item = {}) {
  const raw = [item.service, item.name, item.label, item.displayName, item.detail, item.det]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.includes('pre slab')
    && (raw.includes('termite') || raw.includes('termiticide') || raw.includes('soil treatment') || raw.includes('termidor'));
}

function preSlabCustomerCopy(items = []) {
  const preSlabItems = (Array.isArray(items) ? items : []).filter(isPreSlabOneTimeItem);
  const hasExtendedWarranty = preSlabItems.some((item) => {
    const raw = [item.warrantyStatus, item.detail, item.det]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (item.warrantyExtendedSelected === true) return true;
    if (raw.includes('no extended')) return false;
    return raw.includes('extended 5') || raw.includes('5-year') || raw.includes('5yr');
  });
  // Two slots render this copy — the one-time note inside the price card and
  // the mini-guarantee line below it. Split the service description from the
  // warranty assurance so they don't print the same sentence twice (the
  // German-roach one-time follows the same note + guarantee shape).
  return {
    note: 'Includes pre-slab soil treatment for the measured slab area. Certificate/termite-treatment documentation is provided when required.',
    warranty: 'Warranty terms depend on the selected warranty option.'
      + (hasExtendedWarranty ? '' : ' No extended warranty selected.'),
  };
}

// Bora-Care is a one-time borate wood treatment (service key `bora_care` from
// the pricing engine). It is applied to bare wood — attic/raw framing and
// surface areas like foundation and block. Detect it explicitly by service key
// so it is never misclassified as the pest_control default.
function isBoraCareOneTimeItem(item = {}) {
  const service = String(item?.service || '').toLowerCase();
  if (service === 'bora_care' || service === 'boracare') return true;
  const raw = [item.service, item.name, item.label, item.displayName, item.detail, item.det]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return /\bbora\s*care\b/.test(raw) || raw.includes('borate');
}

// Customer-facing one-time note for a Bora-Care estimate. Description only —
// the estimate intentionally carries no guarantee/coverage line for this
// service, so the mini-guarantee slot is omitted at the render site.
function boraCareCustomerCopy() {
  return {
    note: 'Bora-Care is a borate wood treatment applied to the measured attic and surface areas. It treats bare wood for termites, wood-boring beetles, and wood-decay fungi.',
  };
}

function hasOnlyLawnCareServiceMix(recurring = [], oneTimeItems = []) {
  const recurringRows = Array.isArray(recurring) ? recurring : [];
  const oneTimeRows = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  return recurringRows.length > 0
    && recurringRows.every((svc) => recurringServiceKey(svc) === 'lawn_care')
    && !detectPestOneTime(oneTimeRows)
    && oneTimeRows.every(isLawnCareOneTimeItem);
}

function isMosquitoOneTimeItem(item = {}) {
  if (isActualMosquitoOneTimeItem(item)) return true;
  if (String(item.service || '').toLowerCase() === 'one_time_adjustment') return true;
  const raw = [item.service, item.name, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return !raw || raw.includes('waveguard setup') || raw.includes('membership');
}

function isActualMosquitoOneTimeItem(item = {}) {
  const category = serviceCategoryForOneTimeItem(item);
  if (category === 'mosquito') return true;
  const raw = [item.service, item.name, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.includes('mosquito') || raw.includes('bti') || raw.includes('dunk');
}

function hasOnlyMosquitoServiceMix(recurring = [], oneTimeItems = []) {
  const recurringRows = Array.isArray(recurring) ? recurring : [];
  const oneTimeRows = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  const recurringMosquitoOnly = recurringRows.length > 0
    && recurringRows.every((svc) => recurringServiceKey(svc) === 'mosquito')
    && oneTimeRows.every(isMosquitoOneTimeItem);
  const oneTimeMosquitoOnly = recurringRows.length === 0
    && oneTimeRows.length > 0
    && oneTimeRows.some(isActualMosquitoOneTimeItem)
    && oneTimeRows.every(isMosquitoOneTimeItem);
  return !detectPestOneTime(oneTimeRows) && (recurringMosquitoOnly || oneTimeMosquitoOnly);
}

function isTreeShrubOneTimeItem(item = {}) {
  const raw = [item.service, item.name, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!raw || raw.includes('waveguard setup') || raw.includes('membership')) return true;
  return /\btree|shrub|ornamental/.test(raw);
}

function hasOnlyTreeShrubServiceMix(recurring = [], oneTimeItems = []) {
  const recurringRows = Array.isArray(recurring) ? recurring : [];
  const oneTimeRows = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  return recurringRows.length > 0
    && recurringRows.every((svc) => recurringServiceKey(svc) === 'tree_shrub')
    && !detectPestOneTime(oneTimeRows)
    && oneTimeRows.every(isTreeShrubOneTimeItem);
}

function isTermiteBaitOneTimeItem(item = {}) {
  const category = serviceCategoryForOneTimeItem(item);
  if (category === 'termite_bait') return true;
  const raw = [item.service, item.name, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!raw || raw.includes('waveguard setup') || raw.includes('membership')) return true;
  return raw.includes('termite') && /(bait|station|install|trelona|advance)/.test(raw);
}

function hasOnlyTermiteBaitServiceMix(recurring = [], oneTimeItems = []) {
  const recurringRows = Array.isArray(recurring) ? recurring : [];
  const oneTimeRows = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  return recurringRows.length > 0
    && recurringRows.every((svc) => recurringServiceKey(svc) === 'termite_bait')
    && !detectPestOneTime(oneTimeRows)
    && oneTimeRows.every(isTermiteBaitOneTimeItem);
}

function isTermiteTrenchingOneTimeItem(item = {}) {
  // Bora-Care is a borate wood treatment, never a liquid trench/barrier. Exclude
  // it up front so a label like "Termite Bora-Care Treatment" can't match the raw
  // "termite … treatment" heuristic below and steal the trenching copy/branch.
  if (isBoraCareOneTimeItem(item)) return false;
  const category = serviceCategoryForOneTimeItem(item);
  if (category === 'termite_trenching') return true;
  const raw = [item.service, item.name, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.includes('termite') && /(trench|trenching|liquid|barrier|termidor|treatment)/.test(raw);
}

function isInspectionReviewOneTimeItem(item = {}) {
  const raw = [item.service, item.name, item.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return /(inspection|field review|office review)/.test(raw);
}

function hasOnlyTermiteTrenchingServiceMix(recurring = [], oneTimeItems = []) {
  const recurringRows = Array.isArray(recurring) ? recurring : [];
  const oneTimeRows = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  return recurringRows.length === 0
    && oneTimeRows.length > 0
    && oneTimeRows.some(isTermiteTrenchingOneTimeItem)
    && oneTimeRows.every((item) => isTermiteTrenchingOneTimeItem(item) || isInspectionReviewOneTimeItem(item));
}

// True for one-time rows that carry no billable service of their own, so they
// must not change the detected service mix: inspection/field-review lines, the
// WaveGuard setup/membership fee, and any discount/credit/zero row (amount <= 0).
// A *positive* unrecognized charge (e.g. a billable `one_time_adjustment` row that
// normalizeOneTimeBreakdown adds when oneTime.total exceeds the listed items) is a
// real charge for something else and is intentionally NOT treated as ignorable.
function isNonBillableOneTimeRow(item = {}) {
  if (isInspectionReviewOneTimeItem(item)) return true;
  const service = String(item?.service || '').toLowerCase();
  if (service === 'waveguard_setup' || isWaveGuardSetupOneTimeItem(item)) return true;
  const amount = Number(item?.amount ?? item?.price ?? item?.total);
  return Number.isFinite(amount) && amount <= 0;
}

function hasOnlyBoraCareServiceMix(recurring = [], oneTimeItems = []) {
  const recurringRows = Array.isArray(recurring) ? recurring : [];
  const oneTimeRows = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  // Ignore only non-billable rows (discounts like the WaveGuard member discount,
  // the setup fee, inspections) so a Bora-Care-only quote with a discount line
  // still counts as Bora-Care-only — while a positive unknown charge still blocks
  // the "only" classification (it switches copy + suppresses the mini-guarantee).
  return recurringRows.length === 0
    && oneTimeRows.some(isBoraCareOneTimeItem)
    && oneTimeRows.every((item) => isBoraCareOneTimeItem(item)
      || isNonBillableOneTimeRow(item));
}

function isAnnualPrepayEligibleServiceMix(recurring = [], oneTimeItems = []) {
  // Every recurring service mix can prepay the year now: pest/mosquito waive the
  // WaveGuard setup, all other recurring services take a prepay discount off the
  // recurring annual. Only one-time-only (no recurring) estimates are ineligible.
  const recurringRows = Array.isArray(recurring) ? recurring : [];
  return recurringRows.length > 0;
}

function mergeSupplementalRecurringRow(existing = {}, supplemental = {}) {
  const merged = { ...existing };
  Object.entries(supplemental).forEach(([key, value]) => {
    if (value == null || value === '') return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    const current = merged[key];
    const currentMissing = current == null
      || current === ''
      || (typeof current === 'number' && current <= 0);
    const shouldPreferSupplement = [
      'service',
      'name',
      'displayName',
      'mo',
      'monthly',
      'monthlyTotal',
      'annual',
      'perTreatment',
      'visitsPerYear',
      'cadenceLabel',
      'detail',
      'waveGuardDiscountEligible',
      'waveGuardTierEligible',
      'countsTowardWaveGuardTier',
      'discountable',
      'discountEligible',
      'excludeFromPctDiscount',
      'discount',
      'pricingVersion',
      'pricingSource',
      'tierLabel',
    ].includes(key);
    if (currentMissing || shouldPreferSupplement) {
      merged[key] = value;
    }
  });
  return merged;
}

function recurringServicesWithSupplements(estResult = {}) {
  const recurring = estResult.recurring || {};
  const resultStats = estResult.results || {};
  const services = Array.isArray(recurring.services) ? recurring.services.slice() : [];
  const indexByKey = new Map();
  services.forEach((svc, index) => {
    const key = recurringServiceKey(svc);
    if (key && !indexByKey.has(key)) indexByKey.set(key, index);
  });

  const upsertSupplement = (key, row) => {
    if (!row) return;
    const existingIndex = indexByKey.get(key);
    if (existingIndex != null) {
      services[existingIndex] = mergeSupplementalRecurringRow(services[existingIndex], row);
      return;
    }
    services.push(row);
    indexByKey.set(key, services.length - 1);
  };

  const RECURRING_LINE_SERVICES = new Set(['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'termite_bait', 'palm_injection', 'rodent_bait', 'foam_recurring', 'commercial_lawn', 'commercial_tree_shrub', 'commercial_pest', 'commercial_mosquito', 'commercial_termite_bait', 'commercial_rodent_bait']);
  if (Array.isArray(estResult.lineItems)) {
    estResult.lineItems.forEach((item) => {
      const key = recurringServiceKey(item);
      if (!RECURRING_LINE_SERVICES.has(key)) return;
      const annual = key === 'lawn_care'
        ? firstPositiveNumber(item.annualBeforeDiscount, item.annual, item.ann)
        : firstPositiveNumber(item.annualAfterDiscount, item.annualAfterCredits, item.annual, item.ann);
      const monthly = key === 'lawn_care'
        ? firstPositiveNumber(item.monthlyBeforeDiscount, item.monthly, item.mo, annual ? annual / 12 : null)
        : firstPositiveNumber(item.monthlyAfterDiscount, item.monthlyAfterCredits, item.monthly, item.mo, annual ? annual / 12 : null);
      if (!(annual > 0 || monthly > 0)) return;
      const itemDiscount = key === 'lawn_care'
        ? { ...(item.discount || {}), discountable: true }
        : item.discount;
      if (key === 'lawn_care' && itemDiscount) delete itemDiscount.policy;
      upsertSupplement(key, {
        service: key,
        // item.name carries the cadence for foam ("Recurring Foam Treatment
        // (Quarterly)"); keep it ahead of the generic display name so the
        // recurrence pattern inferred on accept matches the sold cadence.
        name: item.displayName || item.label || item.name || recurringServiceDisplayName(key),
        displayName: item.displayName || item.label || item.name || recurringServiceDisplayName(key),
        // Carry the commercial "estimated — confirmed on site" disclaimer through
        // to the rendered/accepted row so a saved quote-wizard commercial draft
        // never renders/sends the auto-priced line without it.
        detail: item.detail || item.disclaimer || null,
        disclaimer: item.disclaimer || null,
        mo: monthly || null,
        monthly: monthly || null,
        annual: annual || (monthly ? Math.round(monthly * 12 * 100) / 100 : null),
        perTreatment: firstPositiveNumber(item.perApp, item.perVisit),
        visitsPerYear: firstPositiveNumber(item.visitsPerYear, item.visits, item.frequency, item.appsPerYear),
        // Carry cadence (foam) so pattern inference / cadence-aware shapers don't
        // fall back to the monthly billing key; null for services without one.
        cadence: item.cadence || null,
        frequencyKey: item.cadence || null,
        estimatedDurationMinutes: firstPositiveNumber(item.estimatedDurationMinutes, item.estimated_duration_minutes) || null,
        waveGuardDiscountEligible: recurringServiceReceivesTierDiscount(item),
        waveGuardTierEligible: item.waveGuardTierEligible !== false && item.countsTowardWaveGuardTier !== false,
        countsTowardWaveGuardTier: item.countsTowardWaveGuardTier !== false,
        discountable: key === 'lawn_care' ? true : (item.discountable ?? item.discount?.discountable),
        discountEligible: key === 'lawn_care' ? true : item.discountEligible,
        excludeFromPctDiscount: item.excludeFromPctDiscount,
        // Carry the engine line's taxability so the annual-prepay blended rate
        // (resolveCommercialPrepayTaxRate) taxes the taxable commercial pest /
        // mosquito / termite / rodent share — engine-backed (quote-wizard) accepts
        // source recurring rows from lineItems, and without these flags those
        // newly-taxable commercial lines would prepay-tax as $0.
        taxable: item.taxable,
        taxCategory: item.taxCategory,
        discount: itemDiscount,
        pricingVersion: item.pricingVersion,
        pricingSource: item.pricingSource,
      });
    });
  }

  const palmMonthly = firstPositiveNumber(
    recurring.palmInjectionMo,
    resultStats.injection?.monthlyAfterCredits,
    resultStats.injection?.mo,
  );
  if (palmMonthly) {
    const appsPerYear = firstPositiveNumber(resultStats.injection?.appsPerYear) || 1;
    const annual = firstPositiveNumber(
      recurring.palmInjectionAnn,
      resultStats.injection?.annualAfterCredits,
      palmMonthly * 12,
    ) || palmMonthly * 12;
    const perTreatment = appsPerYear > 0 ? Math.round((annual / appsPerYear) * 100) / 100 : null;
    upsertSupplement('palm_injection', {
      service: 'palm_injection',
      name: 'Palm Injection',
      displayName: 'Palm Injection',
      mo: palmMonthly,
      monthly: palmMonthly,
      annual,
      perTreatment,
      visitsPerYear: appsPerYear,
      cadenceLabel: resultStats.injection?.treatmentLabel || 'Palm treatment',
      detail: resultStats.injection?.detail || null,
      waveGuardDiscountEligible: false,
      tierLabel: 'Recurring service',
    });
  }

  const rodentMonthly = firstPositiveNumber(recurring.rodentBaitMo, resultStats.rodBaitMo);
  if (rodentMonthly) {
    const visitsPerYear = firstPositiveNumber(resultStats.rodBaitVisitsPerYear, resultStats.rodentBait?.visitsPerYear) || 4;
    const annual = Math.round(rodentMonthly * 12 * 100) / 100;
    const size = resultStats.rodBaitSize || resultStats.rodentBait?.size || null;
    upsertSupplement('rodent_bait', {
      service: 'rodent_bait',
      name: 'Rodent Bait Stations',
      displayName: 'Rodent Bait Stations',
      mo: rodentMonthly,
      monthly: rodentMonthly,
      annual,
      perTreatment: visitsPerYear > 0 ? Math.round((annual / visitsPerYear) * 100) / 100 : null,
      visitsPerYear,
      cadenceLabel: 'Quarterly monitoring',
      detail: size ? `${size} property · monitoring stations` : 'Monitoring stations',
      waveGuardDiscountEligible: false,
      tierLabel: 'Recurring service',
    });
  }

  return services;
}

function prettySignalValue(value) {
  if (!value) return null;
  return String(value)
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatLawnTurfType(value) {
  if (value && typeof value === 'object') {
    const fields = ['track', 'grassType', 'turfType', 'type', 'name'];
    for (const field of fields) {
      const formatted = formatLawnTurfType(value[field]);
      if (formatted) return formatted;
    }
    return null;
  }
  if (typeof value === 'boolean' || value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (['unknown', 'n_a', 'na', 'none', 'null'].includes(key)) return null;
  const labels = {
    st_augustine: 'St. Augustine',
    st_augustine_grass: 'St. Augustine',
    saint_augustine: 'St. Augustine',
    floratam: 'Floratam',
    bermuda: 'Bermuda',
    bahia: 'Bahia',
    bahiagrass: 'Bahia',
    zoysia: 'Zoysia',
    empire_zoysia: 'Empire Zoysia',
    centipede: 'Centipede',
    mixed: 'Mixed',
  };
  return labels[key] || prettySignalValue(raw);
}

function lawnTurfTypeMetricValue({ inputs = {}, engineInputs = {}, property = {}, parsedData = {}, estResult = {} } = {}) {
  const inputServices = inputs.services || {};
  const engineServices = engineInputs.services || {};
  const candidates = [
    inputServices.lawn?.track,
    inputServices.lawn?.grassType,
    inputServices.lawn?.turfType,
    engineServices.lawn?.track,
    engineServices.lawn?.grassType,
    engineServices.lawn?.turfType,
    inputs.lawnTrack,
    inputs.grassType,
    inputs.turfType,
    inputs.turf_type,
    inputs.lawnGrassType,
    engineInputs.lawnTrack,
    engineInputs.grassType,
    engineInputs.turfType,
    engineInputs.turf_type,
    engineInputs.lawnGrassType,
    property.grassType,
    property.turfType,
    property.turfProfile?.grassType,
    property.turfProfile?.turfType,
    parsedData.turfProfile?.grassType,
    parsedData.turfProfile?.turfType,
    estResult.turfProfile?.grassType,
    estResult.turfProfile?.turfType,
  ];
  for (const candidate of candidates) {
    const formatted = formatLawnTurfType(candidate);
    if (formatted) return formatted;
  }
  return null;
}

function firstPresentValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function prettyKnownSignalValue(value) {
  if (typeof value === 'boolean' || value == null) return null;
  if (typeof value === 'number' && value === 0) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (['unknown', 'n_a', 'na', 'none', 'null', 'false', 'no', '0', 'zero'].includes(key)) return null;
  return prettySignalValue(raw);
}

function firstKnownTreeShrubSignal(...values) {
  for (const value of values) {
    const formatted = prettyKnownSignalValue(value);
    if (formatted) return formatted;
  }
  return null;
}

function selectedMosquitoProgram(resultStats = {}) {
  const rows = Array.isArray(resultStats.mq) ? resultStats.mq : [];
  const selectedIndex = Number(resultStats.mqMeta?.ri);
  return rows.find((row) => row?.recommended)
    || (Number.isInteger(selectedIndex) ? rows[selectedIndex] : null)
    || rows[0]
    || null;
}

function mosquitoProgramMetricValue({ resultStats = {}, mosquitoInputs = {}, engineMosquitoInputs = {}, inputs = {} } = {}) {
  const selected = selectedMosquitoProgram(resultStats);
  const visits = firstPositiveNumber(selected?.v, selected?.visits, selected?.visitsPerYear);
  const raw = String(
    selected?.n
    || selected?.name
    || mosquitoInputs.tier
    || mosquitoInputs.program
    || engineMosquitoInputs.tier
    || engineMosquitoInputs.program
    || inputs.mosquitoProgram
    || ''
  ).trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const program = key.includes('monthly') || key.includes('monthly12') || visits === 12
    ? 'Monthly'
    : (key.includes('seasonal') || key.includes('seasonal9') || visits === 9 ? 'Seasonal' : prettySignalValue(raw));
  if (!program) return null;
  return visits ? `${program} (${Math.round(visits).toLocaleString()} visits/year)` : program;
}

function mosquitoPressureMetricValue(resultStats = {}) {
  const pressure = Number(resultStats.mqMeta?.pr);
  if (!Number.isFinite(pressure) || pressure <= 0) return null;
  const rounded = Math.round(pressure * 100) / 100;
  return `${rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })}x`;
}

function treeShrubBedAreaMetricValue({ treeShrubInputs = {}, inputs = {}, property = {}, resultStats = {} } = {}) {
  const source = String(firstPresentValue(
    treeShrubInputs.bedAreaSource,
    inputs.bedAreaSource,
    property.bedAreaSource,
    resultStats.tsMeta?.bedAreaSource,
  ) || '').trim().toLowerCase();
  if (source === 'fallback') return null;

  return firstPositiveNumber(
    treeShrubInputs.bedArea,
    treeShrubInputs.estimatedBedArea,
    treeShrubInputs.estimatedBedAreaSf,
    inputs.bedArea,
    inputs.estimatedBedArea,
    inputs.estimatedBedAreaSf,
    property.bedArea,
    property.estimatedBedArea,
    property.estimatedBedAreaSf,
    resultStats.tsMeta?.eb,
    resultStats.tsMeta?.bedArea,
  );
}

function treeShrubProfileMetricValue({
  treeShrubInputs = {},
  inputs = {},
  inputFeatures = {},
  property = {},
  propertyFeatures = {},
  resultStats = {},
} = {}) {
  const treeCount = firstPositiveNumber(
    treeShrubInputs.treeCount,
    inputs.treeCount,
    inputFeatures.treeCount,
    property.treeCount,
    propertyFeatures.treeCount,
    resultStats.tsMeta?.et,
    resultStats.tsMeta?.treeCount,
  );
  const treeSignal = treeCount
    ? `${Math.round(treeCount).toLocaleString()} trees`
    : (() => {
      const density = firstKnownTreeShrubSignal(
        treeShrubInputs.treeDensity,
        treeShrubInputs.trees,
        inputFeatures.trees,
        property.treeDensity,
        propertyFeatures.trees,
        resultStats.tsMeta?.treeDensity,
      );
      return density ? `${density} trees` : null;
    })();
  const shrubDensity = firstKnownTreeShrubSignal(
    treeShrubInputs.shrubDensity,
    treeShrubInputs.shrubs,
    inputFeatures.shrubs,
    property.shrubDensity,
    propertyFeatures.shrubs,
    resultStats.tsMeta?.shrubDensity,
  );
  const shrubSignal = shrubDensity ? `${shrubDensity} shrubs` : null;
  const parts = [treeSignal, shrubSignal].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function normalizeFeaturePresence(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value == null || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'detected', 'present'].includes(raw)) return 'yes';
  if (['no', 'n', 'false', '0', 'none', 'not detected', 'absent'].includes(raw)) return 'no';
  if (['possible', 'maybe', 'unknown_possible'].includes(raw)) return 'possible';
  if (raw === 'unknown' || raw === 'n/a') return null;
  return null;
}

function firstFeaturePresence(...values) {
  let sawPossible = false;
  let sawNo = false;
  for (const value of values) {
    const normalized = normalizeFeaturePresence(value);
    if (normalized === 'yes') return 'yes';
    if (normalized === 'possible') sawPossible = true;
    if (normalized === 'no') sawNo = true;
  }
  if (sawPossible) return 'possible';
  return sawNo ? 'no' : null;
}

function poolLanaiMetricValue({ pool, poolCage, poolCageSize } = {}) {
  const poolState = normalizeFeaturePresence(pool);
  const cageState = normalizeFeaturePresence(poolCage);
  const size = prettySignalValue(poolCageSize);
  const cleanSize = size && size !== 'None' ? size : null;
  if (cageState === 'yes') return cleanSize ? `Yes (${cleanSize} cage)` : 'Yes (screened lanai)';
  if (poolState === 'yes') return 'Yes (pool)';
  if (cageState === 'possible' || poolState === 'possible') return 'Possible';
  if (cageState === 'no' || poolState === 'no') return 'No';
  return null;
}

function sentenceList(items) {
  const clean = items.map((item) => String(item || '').trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] || '';
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

function buildWaveGuardIntelligencePayload(estimate = {}, estData = {}, opts = {}) {
  let parsedData = estData;
  if (typeof parsedData === 'string') {
    try { parsedData = JSON.parse(parsedData); } catch { parsedData = {}; }
  }
  parsedData = parsedData && typeof parsedData === 'object' ? parsedData : {};

  const estResult = parsedData.result || parsedData.engineResult || parsedData || {};
  const inputs = parsedData.inputs || parsedData.engineInputs || {};
  const engineInputs = parsedData.engineInputs || {};
  const property = estResult.property || parsedData.property || {};
  const resultStats = estResult.results || parsedData.results || {};
  const recurringServices = Array.isArray(opts.recurringServices)
    ? opts.recurringServices
    : recurringServicesWithSupplements(estResult);
  const inputServices = inputs.services || {};
  const engineServices = engineInputs.services || {};
  const serviceKeys = recurringServices.map(recurringServiceKey).filter(Boolean);
  const intelligenceOneTimeItems = Array.isArray(opts.pricingBundle?.oneTimeBreakdown?.items)
    ? opts.pricingBundle.oneTimeBreakdown.items
    : normalizeOneTimeBreakdown(parsedData).items;
  const oneTimeCategories = new Set(
    intelligenceOneTimeItems
      .map(serviceCategoryForOneTimeItem)
      .filter(Boolean)
  );
  const serviceNames = recurringServices
    .map((svc) => svc?.name || svc?.label || svc?.displayName || svc?.service)
    .filter(Boolean)
    .map((name) => {
      const raw = String(name);
      switch (raw) {
        case 'pest_control': return 'Pest Control';
        case 'lawn_care': return 'Lawn Care';
        case 'tree_shrub': return 'Tree & Shrub';
        case 'termite_bait': return 'Termite Bait';
        case 'palm_injection': return 'Palm Injection';
        case 'rodent_bait': return 'Rodent Bait Stations';
        default: return raw;
      }
    });
  const hasLawn = serviceNames.some((name) => /lawn|turf/i.test(name))
    || !!inputServices.lawn
    || !!inputServices.lawnCare
    || inputs.svcLawn === true;
  const isLawnOnly = serviceNames.length > 0
    && serviceNames.every((name) => /lawn|turf/i.test(String(name)));
  const hasMosquito = serviceKeys.includes('mosquito')
    || !!inputServices.mosquito
    || !!inputServices.oneTimeMosquito
    || !!engineServices.mosquito
    || !!engineServices.oneTimeMosquito
    || inputs.svcMosquito === true
    || inputs.svcOnetimeMosquito === true
    || oneTimeCategories.has('mosquito');
  const isMosquitoOnly = hasMosquito
    && hasOnlyMosquitoServiceMix(recurringServices, intelligenceOneTimeItems);
  const hasTermiteBait = serviceNames.some((name) => isTermiteBaitServiceName(name))
    || !!inputServices.termiteBait
    || !!inputServices.termite;
  const isTermiteBaitOnly = hasTermiteBait
    && serviceKeys.length > 0
    && serviceKeys.every((key) => key === 'termite_bait');
  const hasTreeShrub = serviceKeys.includes('tree_shrub')
    || !!inputServices.treeShrub
    || !!inputServices.tree_shrub
    || !!engineServices.treeShrub
    || !!engineServices.tree_shrub
    || inputs.svcTreeShrub === true;
  const isTreeShrubOnly = hasTreeShrub
    && serviceKeys.length > 0
    && serviceKeys.every((key) => key === 'tree_shrub');
  const isBoraCareOnly = oneTimeCategories.has('bora_care')
    && hasOnlyBoraCareServiceMix(recurringServices, intelligenceOneTimeItems);

  const stories = firstPositiveNumber(inputs.stories, property.stories) || 1;
  const homeSqFt = firstPositiveNumber(
    inputs.homeSqFt,
    inputs.home_sqft,
    property.homeSqFt,
    property.home_sqft,
    Number(property.footprint || 0) * stories,
  );
  const lotSqFt = firstPositiveNumber(
    inputs.lotSqFt,
    inputs.lot_sqft,
    property.lotSqFt,
    property.lot_sqft,
  );
  const lawnSqFt = hasLawn ? firstPositiveNumber(
    inputs.lawnSqFt,
    inputs.turfSqFt,
    property.lawnSqFt,
    property.turfSqFt,
  ) : null;
  const termitePerimeterFt = hasTermiteBait
    ? firstPositiveNumber(resultStats.tmBait?.perim, property.termitePerimeterFt, inputs.termitePerimeterFt)
    : null;
  const mosquitoInputs = inputServices.mosquito || inputServices.oneTimeMosquito || {};
  const engineMosquitoInputs = engineServices.mosquito || engineServices.oneTimeMosquito || {};
  const mosquitoOneTimeItem = intelligenceOneTimeItems.find((item) => serviceCategoryForOneTimeItem(item) === 'mosquito') || {};
  const mosquitoTreatmentAreaSqFt = isMosquitoOnly
    ? firstPositiveNumber(
      resultStats.mqMeta?.treatableSqFt,
      mosquitoInputs.treatableSqFt,
      mosquitoInputs.treatableAreaSqFt,
      engineMosquitoInputs.treatableSqFt,
      engineMosquitoInputs.treatableAreaSqFt,
      mosquitoOneTimeItem.treatableSqFt,
      mosquitoOneTimeItem.treatableAreaSqFt,
      mosquitoOneTimeItem.mosquitoTreatableSqFt,
      mosquitoOneTimeItem.mosquitoTreatmentAreaSqFt,
      inputs.mosquitoTreatableSqFt,
      inputs.mosquitoTreatmentAreaSqFt,
      property.mosquitoTreatableSqFt,
      property.mosquitoTreatmentAreaSqFt,
    )
    : null;
  const mosquitoProgram = isMosquitoOnly
    ? mosquitoProgramMetricValue({ resultStats, mosquitoInputs, engineMosquitoInputs, inputs })
    : null;
  const mosquitoPressure = isMosquitoOnly ? mosquitoPressureMetricValue(resultStats) : null;
  const turfType = isLawnOnly ? lawnTurfTypeMetricValue({ inputs, engineInputs, property, parsedData, estResult }) : null;
  const aiAnalysis = parsedData.aiAnalysis || estResult.aiAnalysis || {};
  const inputFeatures = inputs.features || parsedData.features || {};
  const propertyFeatures = property.features || {};
  const treeShrubInputs = inputServices.treeShrub
    || inputServices.tree_shrub
    || engineServices.treeShrub
    || engineServices.tree_shrub
    || {};
  const treeShrubBedArea = isTreeShrubOnly
    ? treeShrubBedAreaMetricValue({ treeShrubInputs, inputs, property, resultStats })
    : null;
  const treeShrubProfile = isTreeShrubOnly
    ? treeShrubProfileMetricValue({ treeShrubInputs, inputs, inputFeatures, property, propertyFeatures, resultStats })
    : null;
  const complexity = prettySignalValue(
    aiAnalysis.landscape_complexity
    || aiAnalysis.landscapeComplexity
    || property.landscapeComplexity
    || inputs.landscapeComplexity
  );
  const poolLanaiValue = poolLanaiMetricValue({
    pool: firstFeaturePresence(
      inputs.pool,
      inputs.hasPool,
      inputFeatures.pool,
      property.pool,
      property.hasPool,
      property.has_pool,
      propertyFeatures.pool,
      aiAnalysis.pool,
      aiAnalysis.hasPool,
    ),
    poolCage: firstFeaturePresence(
      inputs.poolCage,
      inputs.hasPoolCage,
      inputFeatures.poolCage,
      property.poolCage,
      property.hasPoolCage,
      property.pool_cage,
      propertyFeatures.poolCage,
      aiAnalysis.poolCage,
      aiAnalysis.hasPoolCage,
    ),
    poolCageSize: inputs.poolCageSize
      || inputFeatures.poolCageSize
      || property.poolCageSize
      || property.pool_cage_size
      || propertyFeatures.poolCageSize
      || aiAnalysis.poolCageSize,
  });

  const dedupeMetrics = (items) => {
    const seen = new Set();
    const result = [];
    for (const metric of items.filter(Boolean)) {
      const key = String(metric.label || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(metric);
    }
    return result.slice(0, 6);
  };

  const metrics = dedupeMetrics([
    homeSqFt ? { label: 'Home', value: `${Math.round(homeSqFt).toLocaleString()} sq ft` } : null,
    lotSqFt ? { label: 'Lot', value: `${Math.round(lotSqFt).toLocaleString()} sq ft` } : null,
    mosquitoTreatmentAreaSqFt ? { label: 'Mosquito treatment area', value: `${Math.round(mosquitoTreatmentAreaSqFt).toLocaleString()} sq ft` } : null,
    mosquitoProgram ? { label: 'Mosquito program', value: mosquitoProgram } : null,
    mosquitoPressure ? { label: 'Mosquito pressure', value: mosquitoPressure } : null,
    poolLanaiValue ? { label: 'Pool/Lanai', value: poolLanaiValue } : null,
    treeShrubBedArea ? { label: 'Ornamental beds', value: `${Math.round(treeShrubBedArea).toLocaleString()} sq ft` } : null,
    treeShrubProfile ? { label: 'Trees/Shrubs', value: treeShrubProfile } : null,
    lawnSqFt ? { label: 'Treatable lawn', value: `${Math.round(lawnSqFt).toLocaleString()} sq ft` } : null,
    turfType ? { label: 'Grass type', value: turfType } : null,
    termitePerimeterFt ? { label: 'Termite perimeter', value: `${Math.round(termitePerimeterFt).toLocaleString()} linear ft` } : null,
    complexity ? { label: 'Complexity', value: complexity } : null,
  ]);

  const satelliteUrl = estimate.satelliteUrl || estimate.satellite_url || parsedData.satelliteUrl || null;
  const intelligenceTitle = isLawnOnly
    ? 'Waves AI reviewed your lawn before pricing this estimate'
    : (isTreeShrubOnly
      ? 'Waves AI reviewed your beds and trees before pricing this estimate'
      : (isMosquitoOnly
        ? 'Waves AI reviewed your mosquito treatment zones before pricing this estimate'
        : (isTermiteBaitOnly
          ? 'Waves AI reviewed your termite perimeter before pricing this estimate'
          : (isBoraCareOnly
            ? 'Waves AI reviewed your wood-treatment areas before pricing this estimate'
            : 'Waves AI reviewed your property before pricing this estimate'))));
  const intelligenceBody = isLawnOnly
    ? (satelliteUrl || metrics.length
      ? 'Waves AI reviews satellite imagery, property records, and treatable lawn area to shape your lawn care plan.'
      : 'Waves AI reviews the available property details, selected services, and pricing rules to shape your lawn care plan.')
    : (isTreeShrubOnly
      ? (satelliteUrl || metrics.length
        ? 'Waves AI reviews satellite imagery, property records, and visible bed and tree conditions to shape your tree & shrub plan.'
        : 'Waves AI reviews the available property details, selected services, and pricing rules to shape your tree & shrub plan.')
      : (isMosquitoOnly
        ? (satelliteUrl || metrics.length
          ? 'Waves AI reviews satellite imagery, property records, and mosquito pressure factors to shape your mosquito control plan.'
          : 'Waves AI reviews the available property details, selected services, and pricing rules to shape your mosquito control plan.')
        : (isTermiteBaitOnly
          ? (satelliteUrl || metrics.length
            ? 'Waves AI reviews satellite imagery, property records, and termite perimeter details to shape your termite protection plan.'
            : 'Waves AI reviews the available property details, selected services, and pricing rules to shape your termite protection plan.')
          : (isBoraCareOnly
            ? 'Waves AI reviews your selected wood-treatment areas and the Bora-Care application rate to price this treatment.'
            : (satelliteUrl || metrics.length
              ? 'Waves AI reviews satellite imagery, property records, and visible service areas to show the details behind your WaveGuard plan.'
              : 'Waves AI reviews the available property details, selected services, and pricing rules to shape your WaveGuard plan.')))));
  return {
    eyebrow: 'Waves AI',
    title: intelligenceTitle,
    body: intelligenceBody,
    satelliteUrl,
    metrics,
    signals: [],
  };
}

// ── "Show your work" trust block (estimateShowYourWork gate) ───────
// Customer-facing explanation of WHERE the property facts behind the
// quote came from. Built from the wizard lookup profile persisted at
// estimate_data.enriched — admin/tech estimates without it return null
// and the section stays hidden. Friendly labels only: raw provider
// names, evidence URLs, scores, and parcel IDs never reach the page.
const SHOW_YOUR_WORK_SOURCE_LABELS = {
  verified: 'Verified on-site',
  county: 'County records',
  cadastral: 'County records',
  permit: 'Permit records',
};

function showYourWorkSourceLabel(sourceType) {
  return SHOW_YOUR_WORK_SOURCE_LABELS[String(sourceType || '').trim().toLowerCase()]
    || 'Satellite AI analysis';
}

function showYourWorkCountyName(county) {
  return String(county || '')
    .trim()
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

// Parcel-outline satellite image for the AI card. The polygon never
// persists on the estimate row — it only lives in the property_lookups
// cache — so this re-reads the cached row by address and reuses the
// estimator's own Static Maps overlay builder. Read-only: ANY miss or
// error returns null so the page falls back to the stored satellite_url,
// and nothing here logs the address/parcel/coords (public-route PII rule).
async function resolveShowYourWorkOverlayUrl(estimate = {}) {
  try {
    if (!parcelOverlayEnabled()) return null;
    const address = estimate.address || null;
    if (!address) return null;
    const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!googleKey) return null;
    const row = await getCachedLookup(address);
    if (!row) return null;
    let parcel = row.parcel;
    if (typeof parcel === 'string') {
      try { parcel = JSON.parse(parcel); } catch { parcel = null; }
    }
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    if (!parcel?.polygon || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const overlayParam = buildParcelOverlayParam(parcel.polygon);
    if (!overlayParam) return null;
    return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=640x640&maptype=satellite&format=png&${overlayParam}&key=${googleKey}`;
  } catch {
    return null;
  }
}

async function buildShowYourWork(estimate = {}, estData = {}) {
  let parsedData = estData;
  if (typeof parsedData === 'string') {
    try { parsedData = JSON.parse(parsedData); } catch { parsedData = {}; }
  }
  const enriched = parsedData && typeof parsedData === 'object' ? parsedData.enriched : null;
  if (!enriched || typeof enriched !== 'object') return null;

  const evidence = enriched.fieldEvidence && typeof enriched.fieldEvidence === 'object'
    ? enriched.fieldEvidence
    : {};
  const sourceFor = (field) => showYourWorkSourceLabel(evidence[field]?.sourceType);

  const homeSqFt = firstPositiveNumber(enriched.homeSqFt);
  const lotSqFt = firstPositiveNumber(enriched.lotSqFt);
  const stories = firstPositiveNumber(enriched.stories);
  const yearBuilt = firstPositiveNumber(enriched.yearBuilt);
  const poolState = normalizeFeaturePresence(enriched.pool);
  const poolCageSqft = firstPositiveNumber(enriched.poolCageSqft);
  const turfSqFt = firstPositiveNumber(enriched.estimatedTurfSf);

  // Pool provenance: fieldEvidence.hasPool when the lookup recorded it,
  // otherwise the merged poolSource ('verified'/'county' map to the same
  // friendly labels; 'vision' falls through to Satellite AI analysis).
  const poolSourceType = evidence.hasPool?.sourceType
    || (['verified', 'county'].includes(enriched.poolSource) ? enriched.poolSource : null);

  const facts = [
    homeSqFt ? { label: 'Home size', value: `${Math.round(homeSqFt).toLocaleString()} sq ft`, source: sourceFor('squareFootage') } : null,
    lotSqFt ? { label: 'Lot size', value: `${Math.round(lotSqFt).toLocaleString()} sq ft`, source: sourceFor('lotSize') } : null,
    stories ? { label: 'Stories', value: `${Math.round(stories)} ${Math.round(stories) === 1 ? 'story' : 'stories'}`, source: sourceFor('stories') } : null,
    yearBuilt ? { label: 'Year built', value: String(Math.round(yearBuilt)), source: sourceFor('yearBuilt') } : null,
    poolState === 'yes' || poolState === 'possible'
      ? { label: 'Pool', value: poolState === 'yes' ? 'Yes' : 'Possible', source: showYourWorkSourceLabel(poolSourceType) }
      : null,
    // poolCageSqft only ever comes from the county extra-features roll
    // (no fieldEvidence entry exists for it), so the label is fixed.
    poolCageSqft
      ? { label: 'Screen enclosure', value: `About ${Math.round(poolCageSqft).toLocaleString()} sq ft`, source: 'County records' }
      : null,
    turfSqFt ? {
      label: 'Treatable turf',
      value: `${Math.round(turfSqFt).toLocaleString()} sq ft${enriched.turfCappedToParcel === true ? ' (bounded by your county parcel area)' : ''}`,
      source: sourceFor('estimatedTurfSf'),
    } : null,
  ].filter(Boolean);

  // Parcel match line — county + assessed area only, never the parcel id.
  const parcel = enriched.parcel && typeof enriched.parcel === 'object' ? enriched.parcel : null;
  const parcelCounty = parcel ? showYourWorkCountyName(parcel.county) : '';
  const parcelArea = parcel ? firstPositiveNumber(parcel.areaSqft) : null;
  const parcelLine = parcelCounty
    ? `Matched to ${parcelCounty} County parcel records${parcelArea ? ` — ${Math.round(parcelArea).toLocaleString()} sq ft parcel` : ''}.`
    : null;

  const qualityNote = enriched.propertyDataQuality?.level === 'low'
    ? "A few of these details were hard to confirm remotely — we'll confirm them on-site before treatment."
    : null;

  if (!facts.length && !parcelLine) return null;

  const overlaySatelliteUrl = await resolveShowYourWorkOverlayUrl(estimate);
  return { facts, parcelLine, qualityNote, overlaySatelliteUrl };
}

function renderExpiredPage(estimate) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Estimate Expired — Waves</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,system-ui,sans-serif;background:#FAF8F3;color:#1B2C5B;min-height:100vh;display:flex;flex-direction:column}
  .top-bar{background:#fff;border-bottom:1px solid #E7E2D7}
  .top-bar-inner{max-width:960px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:16px 24px}
  .top-phone{color:#1B2C5B;font-size:15px;font-weight:500;text-decoration:none}
  .top-logo{height:28px;display:block}
  .wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 24px}
  .box{max-width:560px;background:#fff;border-radius:8px;padding:40px;text-align:center;border:1px solid #E7E2D7}
  h1{font-family:'Source Serif 4',Georgia,serif;font-weight:500;letter-spacing:0;font-size:32px;margin:0 0 12px;color:#1B2C5B}
  p{line-height:1.6;color:#3F4A65}
  a.btn{display:inline-block;margin-top:16px;padding:12px 22px;background:#1B2C5B;color:#fff;text-decoration:none;border-radius:8px;font-weight:500}
</style>
</head><body>
${shellTopBar()}
<div class="wrap"><div class="box">
  <h1>This estimate has expired</h1>
  <p>Hi ${escapeHtml((estimate.customerName || '').split(' ')[0] || 'there')} — the estimate for <strong>${escapeHtml(estimate.address || 'your property')}</strong> is no longer active. Give us a call and we'll put together a fresh one.</p>
  <a class="btn" href="${WAVES_SUPPORT_PHONE_TEL}">Call ${WAVES_SUPPORT_PHONE_DISPLAY}</a>
</div></div>
</body></html>`;
}

function renderEstimateNotFoundPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Estimate Not Found — Waves</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,system-ui,sans-serif;background:#FAF8F3;color:#1B2C5B;min-height:100vh;display:flex;flex-direction:column}
  .top-bar{background:#fff;border-bottom:1px solid #E7E2D7}
  .top-bar-inner{max-width:960px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:16px 24px}
  .top-phone{color:#1B2C5B;font-size:15px;font-weight:500;text-decoration:none}
  .top-logo{height:28px;display:block}
  .wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 24px}
  .box{max-width:520px;background:#fff;border-radius:8px;padding:40px;text-align:center;border:1px solid #E7E2D7}
  h1{font-family:'Source Serif 4',Georgia,serif;font-weight:500;letter-spacing:0;font-size:32px;line-height:1.12;margin:0 0 12px;color:#1B2C5B}
  p{line-height:1.6;color:#3F4A65;margin:0}
  a.btn{display:inline-block;margin-top:18px;padding:12px 22px;background:#1B2C5B;color:#fff;text-decoration:none;border-radius:8px;font-weight:700}
</style>
</head><body>
${shellTopBar()}
<div class="wrap"><div class="box">
  <h1>Estimate not found</h1>
  <p>This link may have expired or is no longer valid. Give us a call and we can send a fresh estimate link.</p>
  <a class="btn" href="${WAVES_SUPPORT_PHONE_TEL}">Call ${WAVES_SUPPORT_PHONE_DISPLAY}</a>
</div></div>
</body></html>`;
}


// Server-rendered "Your WaveGuard membership" block for existing customers.
// Mirrors the React MembershipCard in EstimateViewPage.jsx. Returns '' when
// there is no membership context (leads, or any error upstream).
function renderMembershipBlockHtml(membership) {
  if (!membership || !membership.isExistingCustomer) return '';

  // Bronze carries no tier discount, so there are no member benefits to show:
  // gate the whole card on the snapshot's combined tier. This must be the
  // snapshot tier (the one that priced this estimate at save), NOT a live
  // customers.waveguard_tier read — the record only updates on acceptance, so
  // it would hide the upgrade story for a Bronze customer whose estimate is
  // priced at Silver. Snapshot shapes have drifted before (see the cross-sell
  // fallback below), so a snapshot missing tierDiscountPct falls through to
  // the row checks rather than losing its card. The snapshot itself still
  // flows regardless: the setup-fee waiver and cross-sell pick read it
  // independently of this card.
  if (membership.tierDiscountPct != null && !(Number(membership.tierDiscountPct) > 0)) return '';

  const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  // Only rows with a real, non-zero benefit render — the pricing engine's
  // margin guard can cap the applied discount to 0 even at Silver+, and a
  // bare "Member pricing" row with no figure is the same no-benefit card
  // this gate exists to suppress.
  const existing = (Array.isArray(membership.existingServices) ? membership.existingServices : [])
    .filter((s) => Number(s.extraDiscountPct) > 0);
  const added = (Array.isArray(membership.newServices) ? membership.newServices : [])
    .filter((s) => Number(s.discountPct) > 0
      || Number(s.perApplicationSavings) > 0
      || Number(s.monthlySavings) > 0);
  // Nothing to say (e.g. a re-quote of a service the member already has) —
  // skip rather than render a header-and-badge-only card.
  if (!membership.upgrade && existing.length === 0 && added.length === 0) return '';

  const hello = membership.firstName
    ? `Welcome back, ${escapeHtml(membership.firstName)}`
    : 'Welcome back';

  const upgradeHtml = membership.upgrade ? `
    <div class="wg-upgrade">
      Adding ${escapeHtml(membership.upgrade.addedServiceLabels.join(' & ') || 'this service')}
      bumps your membership from <strong>${escapeHtml(membership.upgrade.fromLabel)}</strong>
      up to <strong>${escapeHtml(membership.upgrade.toLabel)}</strong>
      &mdash; an extra ${membership.upgrade.deltaPct}% off every qualifying service,
      including the ones you already have.
    </div>` : '';

  const existingHtml = existing.length ? `
    <div class="wg-section">
      <div class="wg-section-title">Your existing services</div>
      ${existing.map((s) => `
        <div class="wg-row">
          <span class="wg-row-label">${escapeHtml(s.label)}</span>
          <span class="wg-row-val">
            +${s.extraDiscountPct}% off${Number(s.perVisitSavings) > 0
              ? ` &middot; save ${money(s.perVisitSavings)}/visit${s.remainingVisits > 0
                ? ` on your ${s.remainingVisits === 1 ? '' : `${s.remainingVisits} `}remaining${s.prepaid ? ' prepaid' : ''} ${s.remainingVisits === 1 ? 'visit' : 'visits'}`
                : ''}`
              : ''}
          </span>
        </div>`).join('')}
    </div>` : '';

  const addedHtml = added.length ? `
    <div class="wg-section">
      <div class="wg-section-title">This estimate</div>
      ${added.map((s) => `
        <div class="wg-row">
          <span class="wg-row-label">${escapeHtml(s.label)}</span>
          <span class="wg-row-val">
            ${s.discountPct > 0 ? `${s.discountPct}% member discount` : 'Member pricing'}${Number(s.perApplicationSavings) > 0
              ? ` &middot; save ${money(s.perApplicationSavings)} per application`
              : (Number(s.monthlySavings) > 0 ? ` &middot; save ${money(s.monthlySavings)}/mo` : '')}
          </span>
        </div>`).join('')}
    </div>` : '';

  return `
  <section class="card wg-member-card">
    <div class="wg-member-header">
      <div>
        <h2>${hello}</h2>
        <p class="ai-blurb">Here&rsquo;s what your WaveGuard membership saves you on this estimate.</p>
      </div>
      <span class="wg-tier-badge wg-tier-${escapeHtml(membership.tier)}">WaveGuard ${escapeHtml(membership.tierLabel)}</span>
    </div>
    ${upgradeHtml}
    ${existingHtml}
    ${addedHtml}
  </section>`;
}

function renderPage(token, estimate, estData, membership, opts = {}) {
  const est = estimate;
  // "Show your work" payload — built (gate-checked) by the caller; null
  // keeps every byte of the rendered page identical to the pre-gate HTML.
  const showYourWork = opts.showYourWork || null;
  const estimateAskToken = signEstimateAskToken(est, token);
  const tier = est.tier || 'Bronze';
  const firstName = escapeHtml((est.customerName || '').split(' ')[0] || 'there');
  const fullName = escapeHtml(est.customerName || '');
  const address = escapeHtml(est.address || '');
  const customerEmail = escapeHtml(est.customerEmail || '');
  const customerPhoneRaw = String(est.customerPhone || '').replace(/\D/g, '');
  const customerPhoneDigits = customerPhoneRaw.length === 11 && customerPhoneRaw.startsWith('1') ? customerPhoneRaw.slice(1) : customerPhoneRaw;
  const customerPhoneDisplay = customerPhoneDigits.length === 10
    ? `(${customerPhoneDigits.slice(0, 3)}) ${customerPhoneDigits.slice(3, 6)}-${customerPhoneDigits.slice(6)}`
    : escapeHtml(est.customerPhone || '');

  const estResult = estData?.result || estData || {};
  const pricingFrequenciesForView = Array.isArray(est.pricingFrequencies) ? est.pricingFrequencies : [];
  const savedEstimateTierDiscount = Number(estResult?.recurring?.discount);
  const estimateTierDiscount = tierDiscountForEstimate(
    estData,
    tier,
    Number.isFinite(savedEstimateTierDiscount) ? savedEstimateTierDiscount : null,
  );
  const recurring = recurringServicesWithSupplements(estResult);
  const oneTimeItems = [...(estResult?.oneTime?.items || []), ...(estResult?.oneTime?.specItems || [])];
  // Bora-Care detection reads the normalized one-time rows — the same set the
  // Waves AI card uses — so it stays consistent with the AI card and also covers
  // nested-result / engine-backed estimates that don't populate
  // result.oneTime.items directly.
  const boraCareOneTimeRows = normalizeOneTimeBreakdown(estData).items;
  const hasPreSlabOneTime = oneTimeItems.some(isPreSlabOneTimeItem);
  const preSlabCopy = hasPreSlabOneTime ? preSlabCustomerCopy(oneTimeItems) : null;
  const hasBoraCareOneTime = boraCareOneTimeRows.some(isBoraCareOneTimeItem);
  const boraCareCopy = hasBoraCareOneTime ? boraCareCustomerCopy() : null;
  const germanRoachCleanoutItem = oneTimeItems.find(isGermanRoachCleanoutOneTimeItem);
  const germanRoachOneTimeCopy = germanRoachCleanoutItem
    ? `${germanRoachVisitPhrase(germanRoachCleanoutItem.visits)} to break the breeding cycle. Pay on service day, no recurring schedule.`
    : '';
  const germanRoachGuaranteeCopy = '100% guaranteed with the Waves Guarantee.';
  const recurringMonthlyParts = resolveRecurringMonthlyParts(est, estData);
  const storedBaseMonthly = Number(recurringMonthlyParts.baseMonthly || est.monthlyTotal || 0);

  const pestRecurring = detectPestRecurring(recurring);
  const hasPestOneTime = detectPestOneTime(oneTimeItems);
  const pestOneTimeTotal = hasPestOneTime ? pestOneTimeBase(oneTimeItems) : 0;
  const showPrefs = !!(pestRecurring || hasPestOneTime);
  const prefs = normalizePrefs(estData?.preferences);
  const { monthlyOff: prefMonthlyOff, oneTimeOff: prefOneTimeOff } = computePrefDiscount(prefs, pestRecurring, hasPestOneTime, pestOneTimeTotal);
  const manualDiscount = normalizeManualDiscountSummary(estData);
  const manualDiscountMonthly = manualDiscount
    ? Math.round((Number(manualDiscount.recurringAmount ?? manualDiscount.amount) / 12) * 100) / 100
    : 0;
  const hasOnlyLawnCareServices = hasOnlyLawnCareServiceMix(recurring, oneTimeItems);
  const hasOnlyMosquitoServices = hasOnlyMosquitoServiceMix(recurring, oneTimeItems);
  const hasOnlyTreeShrubServices = hasOnlyTreeShrubServiceMix(recurring, oneTimeItems);
  const hasOnlyTermiteBaitServices = hasOnlyTermiteBaitServiceMix(recurring, oneTimeItems);
  const hasOnlyTermiteTrenchingServices = hasOnlyTermiteTrenchingServiceMix(recurring, oneTimeItems);
  const hasOnlyBoraCareServices = hasOnlyBoraCareServiceMix(recurring, boraCareOneTimeRows);
  const pageCopy = hasOnlyLawnCareServices
    ? {
        heroSuffix: "here's your lawn care estimate.",
        recurringAssurance: 'Your plan includes scheduled turf applications, visit notes, and treatment timing matched to Southwest Florida conditions.',
        aggregateDayLabel: 'lawn care',
        billingHeading: 'Choose how you want to pay',
        billingLede: null,
        payAfterTitle: 'Pay per application',
        payAfterBody: 'Approve now; after you confirm, we send the setup + first application invoice so you can pay before service.',
        noPaymentCopy: 'No payment is charged on this page. Your first service visit will be billed after completion.',
        bookingTitle: 'Pick your first lawn care visit',
        bookingSubhead: 'Choose a window to get your lawn care plan started.',
        payPrefHeading: 'Choose how you want to pay',
        payPrefCardTitle: 'Pay per application',
        payPrefCardSub: 'Invoice includes WaveGuard setup + first application.',
        prepayTitle: 'Pay the 12-month plan in full',
        prepayBody: 'Choose the 12-month plan up front; we send the annual invoice automatically after confirmation and waive the setup.',
        prepayButtonSub: 'Approve annual prepay and the setup is included at no charge.',
        cardConfirmTitle: 'Confirm invoice',
        cardConfirmSub: 'next step creates your invoice and makes secure payment available.',
        perksHeading: 'What your lawn care plan includes',
        perksBody: 'Your plan includes visit notes, locked-in pricing, and treatment timing for Southwest Florida lawns.',
        finalHeading: 'Ready to start lawn care?',
        finalSubhead: "Let's get your lawn on the schedule.",
        finalBody: 'No payment today. No surprise increases.',
      }
    : (hasOnlyMosquitoServices
      ? {
          heroSuffix: "here's your mosquito control estimate.",
          recurringAssurance: 'Your plan targets shaded resting zones, lanai edges, and breeding-source pressure around your property.',
          aggregateDayLabel: 'mosquito control',
          billingHeading: 'Choose how you want to pay',
          billingLede: null,
          payAfterTitle: 'Pay per application',
          payAfterBody: 'Approve now; after you confirm, we send the setup + first application invoice so you can pay before service.',
          noPaymentCopy: 'No payment is charged on this page. Your first mosquito control visit will be billed after completion.',
          bookingTitle: 'Pick your first mosquito control visit',
          bookingSubhead: 'Choose a window to get your mosquito control plan started.',
          payPrefHeading: 'Choose how you want to pay',
          payPrefCardTitle: 'Pay per application',
          payPrefCardSub: 'Invoice includes WaveGuard setup + first application.',
          prepayTitle: 'Pay the 12-month plan in full',
          prepayBody: 'Choose the 12-month plan up front; we send the annual invoice automatically after confirmation.',
          prepayButtonSub: 'Approve annual prepay for the mosquito control plan.',
          cardConfirmTitle: 'Confirm invoice',
          cardConfirmSub: 'next step creates your invoice and makes secure payment available.',
          perksHeading: 'What your mosquito control plan includes',
          perksBody: 'Your plan includes directed barrier treatments, resting-zone targeting, and source-reduction notes for Southwest Florida mosquito pressure.',
          finalHeading: 'Ready to start mosquito control?',
          finalSubhead: "Let's get your mosquito plan on the schedule.",
          finalBody: 'No payment today. No surprise increases.',
        }
      : (hasOnlyTreeShrubServices
        ? {
          heroSuffix: "here's your tree & shrub estimate.",
          recurringAssurance: 'Your plan includes scheduled ornamental treatments, visit notes, and treatment timing matched to Southwest Florida conditions.',
          aggregateDayLabel: 'tree & shrub care',
          billingHeading: 'Choose how you want to pay',
          billingLede: null,
          payAfterTitle: 'Pay per application',
          payAfterBody: 'Approve now; after you confirm, we send the setup + first application invoice so you can pay before service.',
          noPaymentCopy: 'No payment is charged on this page. Your first service visit will be billed after completion.',
          bookingTitle: 'Pick your first tree & shrub visit',
          bookingSubhead: 'Choose a window to get your tree & shrub plan started.',
          payPrefHeading: 'Choose how you want to pay',
          payPrefCardTitle: 'Pay per application',
          payPrefCardSub: 'Invoice includes WaveGuard setup + first application.',
          prepayTitle: 'Pay the 12-month plan in full',
          prepayBody: 'Choose the 12-month plan up front; we send the annual invoice automatically after confirmation and waive the setup.',
          prepayButtonSub: 'Approve annual prepay and the setup is included at no charge.',
          cardConfirmTitle: 'Confirm invoice',
          cardConfirmSub: 'next step creates your invoice and makes secure payment available.',
          perksHeading: 'What your tree & shrub plan includes',
          perksBody: 'Your plan includes ornamental treatments, visit notes, and service timing for Southwest Florida landscapes.',
          finalHeading: 'Ready to start tree & shrub?',
          finalSubhead: "Let's get your tree & shrub plan on the schedule.",
          finalBody: 'No payment today. No surprise increases.',
        }
      : (hasOnlyTermiteBaitServices
        ? {
            heroSuffix: "here's your termite protection estimate.",
            recurringAssurance: 'Your plan includes termite station service and treatment timing matched to your home perimeter.',
            aggregateDayLabel: 'termite protection',
            billingHeading: 'Choose how you want to pay',
            billingLede: null,
            payAfterTitle: 'Pay per application',
            payAfterBody: 'Approve now; after you confirm, we send the setup + first application invoice so you can pay before service.',
            noPaymentCopy: 'No payment is charged on this page. Your first termite protection visit will be billed after completion.',
            bookingTitle: 'Pick your first termite protection visit',
            bookingSubhead: 'Choose a window to get your termite protection plan started.',
            payPrefHeading: 'Choose how you want to pay',
            payPrefCardTitle: 'Pay per application',
            payPrefCardSub: 'Invoice includes WaveGuard setup + first application.',
            prepayTitle: 'Pay the 12-month plan in full',
            prepayBody: 'Choose the 12-month plan up front; we send the annual invoice automatically after confirmation.',
            prepayButtonSub: 'Approve annual prepay for the termite protection plan.',
            cardConfirmTitle: 'Confirm invoice',
            cardConfirmSub: 'next step creates your invoice and makes secure payment available.',
            perksHeading: 'What your termite protection plan includes',
            perksBody: 'Your plan includes termite station service, visit notes, and treatment details tied to your home perimeter.',
            finalHeading: 'Ready to start termite protection?',
            finalSubhead: "Let's get your termite protection plan on the schedule.",
            finalBody: 'No payment today. No surprise increases.',
          }
        : (hasOnlyTermiteTrenchingServices
          ? {
              heroSuffix: "here's your termite trenching quote.",
              recurringAssurance: 'This trenching quote is based on the measured treatment path and office review.',
              aggregateDayLabel: 'termite trenching',
              billingHeading: 'Choose how you want to pay',
              billingLede: null,
              payAfterTitle: 'Pay per application',
              payAfterBody: 'Approve now; after you confirm, we send the invoice so you can pay before service.',
              noPaymentCopy: 'No payment is charged on this page. Waves will finish the inspection review before pricing is finalized.',
              bookingTitle: 'Review your termite trenching quote with Waves',
              bookingSubhead: 'Waves will confirm the treatment path before a normal service slot is reserved online.',
              payPrefHeading: 'Choose how you want to pay',
              payPrefCardTitle: 'Pay per application',
              payPrefCardSub: 'Invoice is sent automatically after confirmation.',
              prepayTitle: 'Pay in full',
              prepayBody: 'Waves will confirm final pricing before collecting payment.',
              prepayButtonSub: 'Approve termite trenching follow-up.',
              cardConfirmTitle: 'Confirm invoice',
              cardConfirmSub: 'next step creates your invoice and makes secure payment available.',
              perksHeading: 'What this termite trenching quote includes',
              perksBody: 'This quote uses the measured trenching path and any field review needed before final approval.',
              finalHeading: 'Ready to review termite trenching?',
              finalSubhead: "Let's finish the trenching review with Waves.",
              finalBody: 'No payment today. No surprise increases.',
            }
          : (hasOnlyBoraCareServices
            ? {
                heroSuffix: "here's your Bora-Care wood treatment quote.",
                recurringAssurance: 'This quote is based on the measured attic and surface wood areas treated with Bora-Care.',
                aggregateDayLabel: 'Bora-Care wood treatment',
                billingHeading: 'Choose how you want to pay',
                billingLede: null,
                payAfterTitle: 'Pay per application',
                payAfterBody: 'Approve now; after you confirm, we send the invoice so you can pay before service.',
                noPaymentCopy: 'No payment is charged on this page. Your Bora-Care treatment will be billed after completion.',
                bookingTitle: 'Pick your Bora-Care treatment visit',
                bookingSubhead: 'Choose a window to get your Bora-Care wood treatment scheduled.',
                payPrefHeading: 'Choose how you want to pay',
                payPrefCardTitle: 'Pay per application',
                payPrefCardSub: 'Invoice is sent automatically after confirmation.',
                prepayTitle: 'Pay in full',
                prepayBody: 'We send the invoice automatically after confirmation.',
                prepayButtonSub: 'Approve the Bora-Care wood treatment.',
                cardConfirmTitle: 'Confirm invoice',
                cardConfirmSub: 'next step creates your invoice and makes secure payment available.',
                perksHeading: 'What your Bora-Care treatment includes',
                perksBody: 'Bora-Care is applied to the measured bare wood and treats it for termites, wood-boring beetles, and wood-decay fungi.',
                finalHeading: 'Ready to schedule your Bora-Care treatment?',
                finalSubhead: "Let's get your Bora-Care wood treatment on the schedule.",
                finalBody: 'No payment today.',
              }
            : {
              heroSuffix: "here's your custom quote.",
              recurringAssurance: 'Try us risk-free — 90-day money-back guarantee.',
              aggregateDayLabel: 'complete home protection',
              billingHeading: 'Choose how you want to pay',
              billingLede: null,
              payAfterTitle: 'Pay per application',
              payAfterBody: 'Approve now; after you confirm, we send the setup + first application invoice so you can pay before service.',
              noPaymentCopy: 'No payment is charged on this page. Your first service visit will be billed after completion.',
              bookingTitle: 'Find a date & time that works for you',
              bookingSubhead: 'These are the soonest open service windows we can offer. Nearby route days are marked when a tech is already close by.',
              payPrefHeading: 'Choose how you want to pay',
              payPrefCardTitle: 'Pay per application',
              payPrefCardSub: 'Invoice includes WaveGuard setup + first application.',
              prepayTitle: 'Pay the 12-month plan in full',
              prepayBody: 'Choose the 12-month plan up front; we send the annual invoice automatically after confirmation and waive the setup.',
              prepayButtonSub: 'Approve annual prepay and the setup is included at no charge.',
              cardConfirmTitle: 'Confirm invoice',
              cardConfirmSub: 'next step creates your invoice and makes secure payment available.',
              perksHeading: 'What WaveGuard members get',
              perksBody: 'Your WaveGuard membership goes beyond routine visits - priority service, locked-in pricing, and protection between treatments.',
              finalHeading: 'Go Waves! Wave Goodbye to Pests!',
              finalSubhead: '',
              finalBody: '',
            })))));

  // One-time toggle — admin opted this estimate into letting the customer
  // pick "single visit" instead of a recurring plan. Only renders when the
  // flag is on AND we have a non-zero alternative one-time price.
  const showOneTimeOption = !!est.showOneTimeOption;
  const oneTimeChoicePrice = Number(est.oneTimeChoicePrice || 0);
  const canChooseOneTime = showOneTimeOption && oneTimeChoicePrice > 0;
  const isOneTimeOnly = isStructuralOneTimeOnlyEstimate(estData, est);
  const displayPestOnly = canChooseOneTime && Number(pestRecurring?.monthlyBase || 0) > 0;
  const billingRecurring = displayPestOnly
    ? recurring.filter((svc) => isPestServiceName(svc?.name || svc?.label || svc?.service))
    : recurring;
  const baseMonthly = displayPestOnly ? Number(pestRecurring.monthlyBase || 0) : storedBaseMonthly;
  const recurringMonthlyBeforeDiscounts = displayPestOnly
    ? Math.round(baseMonthly * (1 - estimateTierDiscount) * 100) / 100
    : Math.max(0, Math.round((Number(est.monthlyTotal || 0) + manualDiscountMonthly + prefMonthlyOff) * 100) / 100);

  const tierPrices = {};
  const discountResolver = (t) => tierDiscountForEstimate(estData, t);
  ['Bronze', 'Silver', 'Gold', 'Platinum'].forEach((t) => {
    tierPrices[t] = displayPestOnly
      ? Math.max(0, Math.round((baseMonthly * (1 - discountResolver(t)) - manualDiscountMonthly - prefMonthlyOff) * 100) / 100)
      : monthlyForRecurringParts(recurringMonthlyParts, t, manualDiscountMonthly + prefMonthlyOff, discountResolver);
  });

  const monthlyTotal = Math.max(0, Math.round((recurringMonthlyBeforeDiscounts - manualDiscountMonthly - prefMonthlyOff) * 100) / 100);
  const annualTotal = Math.max(0, Math.round(monthlyTotal * 12 * 100) / 100);
  const onetimeTotal = Math.max(0, Number(est.onetimeTotal || 0) - prefOneTimeOff);
  // A wide low-confidence commercial estimate is force-manual: the customer view
  // must show the "site confirmation" state (not an approve button that the
  // accept endpoint would 409). Detected from estData here since the persisted
  // est.quoteRequired flag was set at auto-price time (before this backstop).
  const quoteRequired = est.quoteRequired === true || est.status === 'quote_required'
    || commercialLowConfidenceRequiresSiteQuote(estData);
  // An authored commercial proposal is quote-required by design (manual
  // acceptance), but its public copy must describe the emailed PDF + account-
  // manager follow-up, NOT the generic "inspection required" field-review state.
  const commercialProposal = estData?.proposal?.enabled === true;
  // Was the formal proposal PDF actually emailed on the send? Stamped by the
  // send path (estimate_data.proposalDelivery). For an SMS-only send — or one
  // where the email/PDF failed — this is false, and the copy must not claim an
  // emailed PDF the customer never received.
  const proposalPdfEmailed = estData?.proposalDelivery?.pdfEmailed === true;
  const quoteRequirementForDisplay = quoteRequired ? resolveEstimateQuoteRequirement(null, estData) : { reason: null };
  // A commercial risk-type hold is an internal classification step (the account
  // manager sets the business type), not a customer inspection — its banner/card
  // copy is account-manager follow-up, like a proposal.
  const commercialRiskType = quoteRequired
    && (est.quoteRequiredReason || quoteRequirementForDisplay.reason) === 'commercial_risk_type_review';
  // A commercial low-confidence hold (the ±20% range is too wide to show) is a
  // site-confirmation step, not a customer inspection — account-manager copy.
  const commercialLowConfidence = quoteRequired
    && (est.quoteRequiredReason || quoteRequirementForDisplay.reason) === 'commercial_low_confidence_site_confirmation';
  const quoteDisplayReason = quoteRequired && !commercialRiskType && !commercialLowConfidence
    ? quoteRequiredReasonText({ reason: est.quoteRequiredReason || quoteRequirementForDisplay.reason })
    : '';
  const locked = est.status === 'accepted' || quoteRequired;
  // Narrow low-confidence estimate (not forced to a site quote): show the ±20%
  // price range + a "confirmed on site" note instead of a single figure.
  const commercialPriceRange = quoteRequired ? { hasLowConfidence: false } : commercialLowConfidenceRange(estData);

  // Commercial auto-priced lawn/tree estimates are approval-only: no booking
  // form, no billing/payment-setup card, no slots. The customer approves and a
  // Waves account manager confirms scope on-site, schedules the visits, and
  // invoices manually (owner directive — commercial can't be self-scheduled or
  // billed like a residential WaveGuard plan). Detected off the priced
  // commercial recurring line; pest-only commercial is quoteRequired (manual
  // proposal) and handled by the commercialProposal copy above.
  const commercialManualAccept = !locked && (
    estData?.commercialEstimatedPricing === true
    || recurring.some((s) => {
      const k = String(recurringServiceKey(s) || s.service || s.name || '').toLowerCase();
      return k.includes('commercial_lawn') || k.includes('commercial_tree') || k.includes('commercial_pest') || k.includes('commercial_mosquito') || k.includes('commercial_termite') || k.includes('commercial_rodent');
    })
  );

  const savingsPerMo = Math.max(0, Math.round((baseMonthly - recurringMonthlyBeforeDiscounts) * 100) / 100);
  // Per-day figure is a true daily rate: annual cost / 365 (monthly * 12 / 365).
  const dayPrice = Math.round((monthlyTotal * 12 / 365) * 100) / 100;

  const R = estResult?.results || {};
  const hasTermiteBait = recurring.some((s) => isTermiteBaitServiceName(s.name || s.label || s.service));

  // Bundle upsell ladder:
  //   1 svc  → offer the complementary one  → Silver (10%)
  //   2 svc  → offer Mosquito if missing    → Gold   (15%)
  //   3+ svc → no upsell                    → already Gold+/Platinum
  // Future-proof: the "next tier" copy comes from the service count
  // after adding, not a hardcoded string.
  const qualifyingRecurring = recurring.filter(recurringServiceCountsTowardTier);
  const qualifyingKeys = new Set(qualifyingRecurring.map(recurringServiceKey));

  // Existing customers must never be offered a service they already have —
  // fold the account's qualifying services (membership snapshot) into the
  // estimate's before picking the upsell. existingServiceKeys is the raw key
  // list; older snapshots only carry existingServices (upgrade-only), so both
  // are read.
  const isExistingMember = !!(membership && membership.isExistingCustomer);
  const combinedQualifyingKeys = new Set([
    ...qualifyingKeys,
    ...(isExistingMember ? (membership.existingServiceKeys || []) : []),
    ...(isExistingMember ? (membership.existingServices || []).map((s) => s.key) : []),
    ...(isExistingMember ? (membership.newServices || []).map((s) => s.key) : []),
  ]);

  let upsellService = null;
  if (isExistingMember) {
    // Already-a-customer ladder: seasonal mosquito first (easier yes), then
    // termite bait stations — whichever they don't have yet.
    if (!combinedQualifyingKeys.has('mosquito')) {
      upsellService = 'Seasonal Mosquito';
    } else if (!combinedQualifyingKeys.has('termite_bait')) {
      upsellService = 'Termite Bait Stations';
    }
  } else if (qualifyingRecurring.length === 1) {
    upsellService = recurringServiceKey(qualifyingRecurring[0]) === 'pest_control' ? 'Lawn Care' : 'Pest Control';
  } else if (qualifyingRecurring.length === 2 && !qualifyingKeys.has('mosquito')) {
    upsellService = 'WaveGuard Mosquito';
  }
  const showUpsell = !!upsellService && !canChooseOneTime && !isOneTimeOnly;

  const nextTierCount = (isExistingMember ? combinedQualifyingKeys.size : qualifyingRecurring.length) + 1;
  const nextTierName = nextTierCount >= 4 ? 'Platinum' : nextTierCount === 3 ? 'Gold' : 'Silver';
  const nextTierPct = nextTierCount >= 4 ? 20 : nextTierCount === 3 ? 15 : 10;

  const recurringRows = recurring.map((s) => {
    const mo = Number(s.mo || s.monthly || 0);
    const discounted = Math.round(mo * (1 - estimateTierDiscount) * 100) / 100;
    return `<tr><td>${escapeHtml(s.name)}</td><td style="text-align:right">${fmtMoney(discounted)}/mo</td></tr>`;
  }).join('');

  // Services for the hero eyebrow with frequency prefix — e.g.
  // "Quarterly Pest Control + Monthly Lawn Care". Per-service frequency
  // comes from the engine's R block (estResult.results); falls back to the
  // bare name when we can't resolve a clean frequency label.
  const visitsToLabel = (v) => {
    const n = Number(v);
    if (n === 12) return 'Monthly';
    if (n === 6) return 'Bi-monthly';
    if (n === 4) return 'Quarterly';
    if (n === 26) return 'Bi-weekly';
    if (n === 8) return '8-visit';
    if (n === 2) return 'Semi-annual';
    if (n === 1) return 'Annual';
    return null;
  };
  const visitsForService = (name) => {
    const n = String(name || '').toLowerCase();
    if (n.includes('pest')) return R.pest?.apps;
    if (n.includes('lawn') && Array.isArray(R.lawn)) {
      const sel = R.lawn.find((t) => t.recommended) || R.lawn[0];
      return sel?.v;
    }
    if (n.includes('mosquito') && Array.isArray(R.mq)) {
      const sel = R.mq.find((t) => t.selected || t.isSelected) ||
        R.mq.find((t) => t.recommended || t.isRecommended) ||
        R.mq[0];
      return sel?.v;
    }
    if (n.includes('tree') && Array.isArray(R.ts)) return selectedResultStatsRow(R.ts)?.v;
    if (n.includes('termite') && n.includes('bait')) return 4;
    return null;
  };
  const labelWithFreq = (name) => {
    const visits = Number(visitsForService(name));
    return visits > 0 ? `${name} (${visits}x)` : name;
  };
  const pestTiers = Array.isArray(R.pestTiers) ? R.pestTiers : [];
  const selectedPestTier = pestTiers.find((t) => Math.abs(Number(t?.mo || 0) - Number(pestRecurring?.monthlyBase || 0)) < 0.01) || pestTiers[0] || null;
  const pestTierCadence = selectedPestTier?.label || visitsToLabel(pestRecurring?.visitsPerYear);
  const selectedPestFrequencyKey = (() => {
    const label = String(selectedPestTier?.label || pestTierCadence || '').toLowerCase().replace(/[-\s]/g, '_');
    if (label === 'bi_monthly' || label === 'bimonthly') return 'bi_monthly';
    if (label === 'monthly') return 'monthly';
    if (label === 'quarterly') return 'quarterly';
    return pestRecurring ? 'quarterly' : null;
  })();
  const selectedRecurringFrequencyKey = selectedPestFrequencyKey || (hasTermiteBait ? 'quarterly' : null);
  const selectedRecurringFrequencyForView = selectedRecurringFrequencyKey
    ? (pricingFrequenciesForView.find((frequency) => frequency?.key === selectedRecurringFrequencyKey) || null)
    : defaultFrequencyFromList(pricingFrequenciesForView);
  const selectedServiceTierBillsMonthlyForView = !!selectedRecurringFrequencyForView?.billingFrequencyKey
    && selectedRecurringFrequencyForView.billingFrequencyKey === 'monthly';
  const pestChoiceLabel = pestRecurring && canChooseOneTime
    ? `${pestTierCadence ? `${pestTierCadence} ` : ''}Pest Control or One-Time Pest Control`
    : null;
  const quotedServiceNames = recurring.map((s) => labelWithFreq(s.name)).filter(Boolean);
  // Build the one-time hero names per row so every billable line is represented,
  // even the name-less engine shape `{ service: 'bora_care', price }` mixed with a
  // named row. A row whose only "name" is the raw service key maps to the friendly
  // category label (mirrors buildOneTimeInvoiceServiceLabel). Source from the raw
  // rows when present, else the normalized billable rows (nested-result shape).
  const friendlyOneTimeRowName = (it) => {
    const name = String(it.displayName || it.name || it.label || '').trim();
    const isRawKey = !!name && name.toLowerCase() === String(it.service || '').toLowerCase();
    return name && !isRawKey
      ? name
      : (oneTimeInvoiceLabelForCategory(serviceCategoryForOneTimeItem(it), name) || name);
  };
  const quotedOneTimeNames = (oneTimeItems.length
    ? oneTimeItems
    : boraCareOneTimeRows.filter(isBillableOneTimeInvoiceItem))
    .map(friendlyOneTimeRowName)
    .filter(Boolean);
  const quotedServicesLabel = pestChoiceLabel || (quotedServiceNames.length
    ? quotedServiceNames.join(' + ')
    : (quotedOneTimeNames.length ? quotedOneTimeNames.join(' + ') : `WaveGuard ${tier}`));
  const recurringPricePeriodWord = pricePeriodWordForFrequencyKey(selectedRecurringFrequencyKey);
  const recurringDisplayTotal = intervalPriceFromMonthly(monthlyTotal, selectedRecurringFrequencyKey);
  const recurringDisplayBase = intervalPriceFromMonthly(baseMonthly, selectedRecurringFrequencyKey);
  const recurringDisplaySavings = intervalPriceFromMonthly(savingsPerMo, selectedRecurringFrequencyKey);
  const recurringDisplayManualDiscount = intervalPriceFromMonthly(manualDiscountMonthly, selectedRecurringFrequencyKey);
  const manualDiscountHtml = manualDiscount && recurringDisplayManualDiscount > 0
    ? `<div class="manual-discount-row" data-mode-only="recurring"><span>${escapeHtml(manualDiscount.label || 'Discount')}</span><strong>-${fmtMoney(recurringDisplayManualDiscount)} / ${escapeHtml(recurringPricePeriodWord)}</strong></div>`
    : '';

  // WaveGuard Membership setup ($99). Applies only to recurring Pest or Mosquito
  // mixes; lawn, termite-bait, rodent-bait, tree & shrub, and palm carry no setup
  // fee (they get a 5% annual-prepay discount instead). A mix containing pest or
  // mosquito always charges the setup — the 5% never stacks on top.
  // Older v1 estimates may not have oneTime.membershipFee cached, so fall back
  // to the pricing constant when a qualifying recurring line is present.
  const explicitMembershipFee = Number(estResult?.oneTime?.membershipFee || 0);
  const hasRecurringMosquito = recurring.some((svc) => recurringServiceKey(svc) === 'mosquito');
  const hasWaveGuardMembership = !!pestRecurring || hasRecurringMosquito;
  const membershipFee = hasWaveGuardMembership
    ? (explicitMembershipFee > 0 ? explicitMembershipFee : Number(PEST.initialFee || 99))
    : 0;
  // Existing customers never pay the setup again — the fee is waived outright
  // (shown struck-through), and with no waivable fee the annual-prepay option
  // drops too: existing customers are offered pay-per-application only.
  // estimate-converter mirrors this so the accept invoice can't include it.
  const membershipSetupWaivedForExistingCustomer = isExistingMember && membershipFee > 0;
  const showMembershipFee = membershipFee > 0 && !locked && !membershipSetupWaivedForExistingCustomer;

  const tierDiscountPct = Math.round(estimateTierDiscount * 100);
  const servicePriority = (svc) => {
    const key = recurringServiceKey(svc);
    if (key === 'pest_control') return 0;
    if (key === 'lawn_care') return 1;
    if (key === 'tree_shrub') return 2;
    if (key === 'mosquito') return 3;
    if (key === 'termite_bait') return 4;
    if (key === 'palm_injection') return 5;
    if (key === 'rodent_bait') return 6;
    return 2;
  };
  const billingServiceRows = billingRecurring
    .slice()
    .sort((a, b) => servicePriority(a) - servicePriority(b))
    .map((svc) => {
      const serviceKey = recurringServiceKey(svc);
      const name = svc?.displayName || recurringServiceDisplayName(serviceKey) || svc?.name || svc?.label || 'Service';
      const firstVisitPricing = recurringServiceFirstVisitPrice(svc, {
        estData,
        tierDiscount: estimateTierDiscount,
        prefMonthlyOff,
        pestRecurring,
        selectedPestTier,
      });
      const { visits, anchorPrice, basePrice, price } = firstVisitPricing;
      const isPest = /pest/i.test(String(name));
      const isLawn = /lawn|turf/i.test(String(name));
      const visitText = visits
        ? `${Math.round(visits).toLocaleString()} ${visits === 1 ? 'application' : 'applications'}/year`
        : 'Service applications/year';
      const cadenceText = svc?.cadenceLabel || (isPest && pestTierCadence ? `${pestTierCadence} service` : '');
      const displayCadenceText = isPest && /quarterly service/i.test(String(cadenceText || ''))
        ? ''
        : cadenceText;
      // Commercial turf reframe (owner 2026-07-01): the visits-present branch below
      // shows only "N applications/year" and drops svc.detail, so the mowing-exclusion
      // scope note the reframe added never reaches the customer. Surface a concise
      // version on the card for the commercial turf line only (fuller copy still shows
      // via svc.detail in the no-visits fallback).
      const isCommercialTurf = serviceKey === 'commercial_lawn' || /commercial turf/i.test(String(name));
      const scopeNote = isCommercialTurf ? 'Does not include mowing, edging, or landscape maintenance' : '';
      const detailHtml = displayCadenceText || visits
        ? [
            displayCadenceText ? escapeHtml(displayCadenceText) : null,
            escapeHtml(visitText),
            scopeNote ? escapeHtml(scopeNote) : null,
          ].filter(Boolean).join(' &middot; ')
        : escapeHtml(svc?.detail || 'Service applications/year');
      return {
        name,
        detailHtml,
        kind: isPest ? 'pest' : (isLawn ? 'lawn' : (serviceKey || 'other')),
        visits,
        anchorPrice,
        basePrice,
        price,
        tierLabel: svc?.tierLabel || (String(serviceKey || '').startsWith('commercial_') ? 'Commercial' : `WaveGuard ${tier}`),
      };
    });
  const allBillingRowsHaveVisitPrice = billingServiceRows.length > 0
    && billingServiceRows.every((row) => {
      const price = Number(row.price);
      return Number.isFinite(price) && price > 0;
    });
  const resolvedFirstServiceVisitTotal = resolveRecurringFirstVisitAmount(billingRecurring, {
    estData,
    tierDiscount: estimateTierDiscount,
    prefMonthlyOff,
    pestRecurring,
    selectedPestTier,
  }) || 0;
  const firstServiceVisitTotal = allBillingRowsHaveVisitPrice
    ? (resolvedFirstServiceVisitTotal || billingServiceRows.reduce((sum, row) => sum + Number(row.price), 0))
    : null;
  const billingModeAttr = canChooseOneTime ? ' data-mode-only="recurring"' : '';
  const setupDueToday = showMembershipFee ? membershipFee : 0;
  const standardInvoiceFirstApplicationAmount = !selectedServiceTierBillsMonthlyForView
    && firstServiceVisitTotal != null
    && firstServiceVisitTotal > 0
    ? firstServiceVisitTotal
    : 0;
  const standardInvoiceCopy = buildStandardPayPerApplicationInvoiceCopy({
    setupAmount: setupDueToday,
    firstApplicationAmount: standardInvoiceFirstApplicationAmount,
    fallbackNoPaymentCopy: pageCopy.noPaymentCopy,
  });
  const standardInvoiceTotal = standardInvoiceCopy.totalAmount;
  const standardInvoiceDynamicTotalHtml = `<span data-standard-invoice-copy-total data-standard-setup-due="${Number(setupDueToday || 0)}">${fmtMoney(standardInvoiceTotal)}</span>`;
  const standardInvoiceBillingSmallHtml = standardInvoiceCopy.hasSetup && standardInvoiceCopy.hasFirstApplication
    ? `No payment is charged on this page. After confirmation, we open an invoice for setup plus the first application totaling ${standardInvoiceDynamicTotalHtml}.`
    : (standardInvoiceCopy.hasSetup
        ? `No payment is charged on this page. After confirmation, we open the ${fmtMoney(setupDueToday)} setup invoice so you can pay in-flow.`
        : (standardInvoiceCopy.hasFirstApplication
            ? `No payment is charged on this page. After confirmation, we open the first application invoice for ${standardInvoiceDynamicTotalHtml}.`
            : escapeHtml(pageCopy.noPaymentCopy)));
  // Annual prepay shows for ANY recurring estimate with an annual total. The
  // incentive depends on the mix: pest/mosquito waive the WaveGuard setup;
  // every other recurring service takes ANNUAL_PREPAY_DISCOUNT_PCT off the
  // recurring annual (never one-time installs, which aren't in annualTotal).
  const prepayEligibleMix = !quoteRequired && !locked && annualTotal > 0
    && billingRecurring.length > 0
    && isAnnualPrepayEligibleServiceMix(recurring, oneTimeItems);
  const annualPrepayWaivesMembership = showMembershipFee;
  // Use the converter's shared calc so the displayed total === the invoiced total,
  // including the non-discountable margin floor clamp (effective rate may be < the
  // configured % for margin-protected mixes).
  const prepayResolved = require('../services/estimate-converter').resolveAnnualPrepayInvoiceTotal({
    baseAnnual: annualTotal,
    recurringServices: recurring,
    estimateData: estData,
  });
  const prepayDiscountAmount = annualPrepayWaivesMembership ? 0 : prepayResolved.discount;
  const prepayDiscountRate = annualPrepayWaivesMembership ? 0 : prepayResolved.rate;
  const prepayDiscountPctLabel = `${Math.round(prepayDiscountRate * 100)}%`;
  // Annual prepay is offered to NEW customers only (unchanged invariant) and only
  // when it carries an incentive: the setup waiver (pest/mosquito) or the prepay
  // discount (no-fee services). Existing members stay pay-per-application only.
  const showAnnualPrepayOption = prepayEligibleMix && !isExistingMember
    && (annualPrepayWaivesMembership || prepayDiscountAmount > 0);
  const prepayInvoiceTotal = annualPrepayWaivesMembership
    ? annualTotal
    : (() => {
      const base = Math.max(0, prepayResolved.amount);
      // Commercial prepay is taxed on the taxable pest share — quote the
      // TAX-INCLUSIVE total here so the page matches the invoice/PaymentIntent
      // the converter creates (same blended rate + post-discount allocation +
      // the customer's effective rate resolved in handleEstimateView). Mirror
      // InvoiceService's rounding (tax dollars to cents, then add).
      if (!commercialManualAccept) return base;
      const taxRate = require('../services/estimate-converter').resolveCommercialPrepayTaxRate(recurring, {
        prepayDiscountApplied: prepayResolved.discount > 0,
        baseRate: opts.prepayBaseRate,
      });
      const tax = Math.round(base * taxRate * 100) / 100;
      return Math.round((base + tax) * 100) / 100;
    })();
  const existingAppointment = est.existingAppointment || null;
  const prepayMembershipSummaryHtml = annualPrepayWaivesMembership
    ? `<div class="payment-summary-row discount"><span>WaveGuard Membership Setup</span><strong><s>${fmtMoney(membershipFee)}</s> $0</strong></div>`
    : (prepayDiscountAmount > 0
      ? `<div class="payment-summary-row discount"><span>Prepay discount (${prepayDiscountPctLabel})</span><strong>-${fmtMoney(prepayDiscountAmount)}</strong></div>`
      : '');
  // Prepay body/button copy is incentive-aware: the per-service pageCopy still
  // says "waive the setup", which is only accurate for the fee services. No-fee
  // services advertise the prepay discount instead.
  const prepayBodyCopy = annualPrepayWaivesMembership || prepayDiscountAmount <= 0
    ? pageCopy.prepayBody
    : `Choose the 12-month plan up front and save ${prepayDiscountPctLabel}; we send the annual invoice automatically after confirmation.`;
  const prepayButtonSubCopy = annualPrepayWaivesMembership || prepayDiscountAmount <= 0
    ? pageCopy.prepayButtonSub
    : `Approve annual prepay and save ${prepayDiscountPctLabel} on the recurring annual.`;
  const showBillingCard = !quoteRequired && !locked && !commercialManualAccept && billingRecurring.length > 0;
  const requirePaymentSetupBeforeSlots = showBillingCard;
  const standardInvoiceLede = standardInvoiceCopy.hasSetup && standardInvoiceCopy.hasFirstApplication
    ? 'Pay per application with a setup + first application invoice after confirmation.'
    : (standardInvoiceCopy.hasSetup
        ? 'Pay per application with a setup invoice after confirmation.'
        : (standardInvoiceCopy.hasFirstApplication
            ? 'Pay per application with a first application invoice after confirmation.'
            : 'Pay per application after completion.'));
  const billingLede = pageCopy.billingLede || (showAnnualPrepayOption
    ? `${standardInvoiceLede} Or choose the 12-month prepay option and pay the annual invoice in-flow.`
    : standardInvoiceLede);
  const billingCardHtml = showBillingCard ? `
  <section class="card billing-card" id="payment-setup-card"${billingModeAttr}>
    <h2>${escapeHtml(pageCopy.billingHeading)}</h2>
    <p class="billing-lede">${escapeHtml(billingLede)}</p>
    <div class="payment-choice-grid">
      <div class="payment-choice">
        <div class="payment-choice-head">
          <h3>${escapeHtml(pageCopy.payAfterTitle)}</h3>
        </div>
        <p class="payment-choice-body">${escapeHtml(standardInvoiceCopy.payAfterBody)}</p>
        <div class="payment-summary-list">
          ${showMembershipFee ? `<div class="payment-summary-row"><span>WaveGuard Membership Setup</span><strong>${fmtMoney(setupDueToday)}</strong></div>` : ''}
          ${membershipSetupWaivedForExistingCustomer && !locked ? `<div class="payment-summary-row discount"><span>WaveGuard Membership Setup</span><strong><s>${fmtMoney(membershipFee)}</s> $0</strong></div>` : ''}
          <div class="payment-summary-row"><span>First service visit</span>${firstServiceVisitTotal != null ? `<strong data-first-visit-total data-first-visit-amount="${Number(firstServiceVisitTotal || 0)}">${fmtMoney(firstServiceVisitTotal)}</strong>` : '<strong>After completion</strong>'}</div>
          ${standardInvoiceTotal > 0 ? `<div class="payment-summary-row payment-summary-total"><span>Invoice total</span><strong data-standard-invoice-total data-standard-setup-due="${Number(setupDueToday || 0)}">${fmtMoney(standardInvoiceTotal)}</strong></div>` : ''}
        </div>
        ${membershipSetupWaivedForExistingCustomer && !locked ? `<p class="billing-small">Setup waived &mdash; you're already a Waves customer.</p>` : ''}
        <p class="billing-small">${standardInvoiceBillingSmallHtml}</p>
        <button type="button" class="payment-choice-cta" data-payment-setup="pay_at_visit">Choose pay per application</button>
        <p class="billing-small">Next: pick a time, then confirm. We send the invoice automatically and make secure payment available.</p>
      </div>
      ${showAnnualPrepayOption ? `
      <div class="payment-choice">
        <div class="payment-choice-head">
          <h3>${escapeHtml(pageCopy.prepayTitle)}</h3>
          ${annualPrepayWaivesMembership
            ? `<span class="payment-choice-badge primary">Setup waived</span>`
            : (prepayDiscountAmount > 0 ? `<span class="payment-choice-badge primary">Save ${prepayDiscountPctLabel}</span>` : '')}
        </div>
        <p class="payment-choice-body">${escapeHtml(prepayBodyCopy)}</p>
        <div class="payment-summary-list">
          <div class="payment-summary-row"><span>Annual plan total</span><strong data-annual-total>${fmtMoney(annualTotal)}</strong></div>
          ${prepayMembershipSummaryHtml}
          <div class="payment-summary-row payment-summary-total"><span>Prepay invoice total</span><strong data-prepay-invoice-total data-prepay-discount-rate="${prepayDiscountRate}">${fmtMoney(prepayInvoiceTotal)}</strong></div>
        </div>
        <p class="billing-small">No payment is charged on this page. After confirmation, your annual prepay invoice totals <span data-prepay-copy-total data-prepay-discount-rate="${prepayDiscountRate}">${fmtMoney(prepayInvoiceTotal)}</span> and secure payment is available.</p>
        ${showMembershipFee && !annualPrepayWaivesMembership ? `<p class="billing-small">The WaveGuard Membership is included with the 12-month plan invoice.</p>` : ''}
        <button type="button" class="payment-choice-cta primary" data-payment-setup="prepay_annual">Annual prepay</button>
        <p class="billing-small">Next: pick a time, then confirm. We send the invoice automatically and make secure payment available.</p>
      </div>` : ''}
    </div>
  </section>` : '';

  // Cancel / refund / guarantee terms — surfaced on the SSR estimate so a
  // high-consideration buyer sees exactly where they stand before approving.
  // Policy (owner-confirmed): setup fully refundable, annual prepay prorated
  // on unused visits, cancel anytime with no contract, 90-day money-back +
  // free re-service. Gated to recurring plans (same condition as the billing
  // card) and mode-aware so it hides in one-time mode.
  const planTermsCardHtml = showBillingCard ? `
  <section class="card plan-terms-card"${billingModeAttr}>
    <h2>Cancel, refunds &amp; our guarantee</h2>
    <p class="billing-lede">No contracts and no lock-in. Here&rsquo;s exactly where you stand if your plans change.</p>
    <ul class="plan-terms-list">
      <li class="plan-terms-item">
        <span class="plan-terms-term">Cancel anytime &mdash; no contract</span>
        <span class="plan-terms-detail">No long-term commitment. Stop after any visit, with no cancellation fee.</span>
      </li>
      ${showMembershipFee && !membershipSetupWaivedForExistingCustomer ? `<li class="plan-terms-item">
        <span class="plan-terms-term">Your ${fmtMoney(membershipFee)} setup is refundable</span>
        <span class="plan-terms-detail">Change your mind? Just ask and we&rsquo;ll refund the WaveGuard setup in full.</span>
      </li>` : ''}
      ${showAnnualPrepayOption ? `<li class="plan-terms-item">
        <span class="plan-terms-term">Annual prepay is prorated</span>
        <span class="plan-terms-detail">On the 12-month prepay plan, cancel anytime and we refund every application you haven&rsquo;t used yet, prorated.</span>
      </li>` : ''}
      <li class="plan-terms-item">
        <span class="plan-terms-term">90-day money-back guarantee</span>
        <span class="plan-terms-detail">Not satisfied? We re-treat between visits free &mdash; and you&rsquo;re backed by a 90-day money-back guarantee.</span>
      </li>
    </ul>
  </section>` : '';

  const servicePriceCardsHtml = billingServiceRows
    .filter((row) => row.price != null)
    .map((row) => {
      const savings = row.anchorPrice != null ? Math.max(0, Math.round((row.anchorPrice - row.price) * 100) / 100) : 0;
      const day = row.visits > 0 ? Math.round((row.price * row.visits / 365) * 100) / 100 : null;
      const dayPriceHtml = day != null
        ? `<span data-service-card-day data-service-kind="${escapeHtml(row.kind)}" data-service-visits="${Number(row.visits || 0)}" data-service-base-price="${Number(row.basePrice || 0)}">${fmtMoney(day)}</span>`
        : '';
      const dayPriceCopy = hasOnlyLawnCareServices
        ? `That\u2019s just ${dayPriceHtml}/day to stop lawn pests before they turn green grass brown.`
        : `That\u2019s just ${dayPriceHtml}/day for ${escapeHtml(row.name.toLowerCase())}.`;
      return `
        <section class="service-price-card">
          <div class="service-price-name">${escapeHtml(row.name)}</div>
          <div class="service-price-detail">${row.detailHtml}</div>
          <div class="big-price service-big-price">
            ${savings > 0 ? `<span class="anchor">${fmtMoney(row.anchorPrice)} / application</span>` : ''}
            <span class="num" data-service-card-price data-service-kind="${escapeHtml(row.kind)}" data-service-visits="${Number(row.visits || 0)}" data-service-base-price="${Number(row.basePrice || 0)}">${fmtMoney(row.price)}</span>
            <span class="per">application</span>
            <span class="tier-lbl">${escapeHtml(row.tierLabel)}</span>
          </div>
          ${savings > 0 && !commercialManualAccept ? `<div class="save-row"><span class="save-pill">You save <span data-service-card-savings data-service-kind="${escapeHtml(row.kind)}" data-service-visits="${Number(row.visits || 0)}" data-service-base-price="${Number(row.basePrice || 0)}" data-service-anchor-price="${Number(row.anchorPrice || 0)}">${fmtMoney(savings)}</span> / application with WaveGuard ${escapeHtml(tier)}</span></div>` : ''}
          ${day != null ? `<div class="day-price">${dayPriceCopy}</div>` : ''}
        </section>`;
    })
    .join('');
  const serviceCardsMonthlyTotal = billingServiceRows.reduce((sum, row) => {
    if (row.price == null || !(row.visits > 0)) return null;
    if (sum == null) return null;
    return sum + (row.price * row.visits / 12);
  }, 0);
  const serviceCardsCoverRecurringTotal = billingRecurring.length > 0
    && servicePriceCardsHtml
    && billingServiceRows.every((row) => row.price != null && row.visits > 0)
    && serviceCardsMonthlyTotal != null
    && Math.abs(serviceCardsMonthlyTotal - monthlyTotal) < 0.05;
  const supplementalServiceRowsHtml = !serviceCardsCoverRecurringTotal
    ? billingServiceRows
      .filter((row) => row.price != null && !['pest', 'lawn', 'lawn_care'].includes(String(row.kind || '').toLowerCase()))
      .map((row) => `
        <div class="supplemental-service-row">
          <div>
            <div class="supplemental-service-name">${escapeHtml(row.name)}</div>
            <div class="supplemental-service-detail">${row.detailHtml}</div>
          </div>
          <strong>${fmtMoney(row.price)} / application</strong>
        </div>`)
      .join('')
    : '';
  const supplementalServiceSummaryHtml = supplementalServiceRowsHtml
    ? `<div class="supplemental-service-list" data-mode-only="recurring">${supplementalServiceRowsHtml}</div>`
    : '';
  const recurringChoiceTreatmentHtml = (() => {
    if (!(canChooseOneTime && serviceCardsCoverRecurringTotal && billingServiceRows.length === 1)) return '';
    const row = billingServiceRows[0];
    const savings = row.anchorPrice != null ? Math.max(0, Math.round((row.anchorPrice - row.price) * 100) / 100) : 0;
    const day = row.visits > 0 ? Math.round((row.price * row.visits / 365) * 100) / 100 : null;
    const dayPriceHtml = day != null
      ? `<span data-service-card-day data-service-kind="${escapeHtml(row.kind)}" data-service-visits="${Number(row.visits || 0)}" data-service-base-price="${Number(row.basePrice || 0)}">${fmtMoney(day)}</span>`
      : '';
    return `
      <div class="choice-treatment" data-mode-only="recurring">
        <div class="choice-treatment-name">${escapeHtml(row.name)}</div>
        <div class="choice-treatment-detail">${row.detailHtml}</div>
        <div class="big-price choice-treatment-price">
          ${savings > 0 ? `<span class="anchor">${fmtMoney(row.anchorPrice)} / application</span>` : ''}
          <span class="num" data-service-card-price data-service-kind="${escapeHtml(row.kind)}" data-service-visits="${Number(row.visits || 0)}" data-service-base-price="${Number(row.basePrice || 0)}">${fmtMoney(row.price)}</span>
          <span class="per">application</span>
          <span class="tier-lbl">${escapeHtml(row.tierLabel)}</span>
        </div>
        ${savings > 0 && !commercialManualAccept ? `<div class="save-row"><span class="save-pill">You save <span data-service-card-savings data-service-kind="${escapeHtml(row.kind)}" data-service-visits="${Number(row.visits || 0)}" data-service-base-price="${Number(row.basePrice || 0)}" data-service-anchor-price="${Number(row.anchorPrice || 0)}">${fmtMoney(savings)}</span> / application with WaveGuard ${escapeHtml(tier)}</span></div>` : ''}
        ${day != null ? `<div class="day-price">That\u2019s just ${dayPriceHtml}/day for ${escapeHtml(row.name.toLowerCase())}.</div>` : ''}
      </div>`;
  })();
  const oneTimeOnlyHeroPriceHtml = `
      <div class="choice-treatment">
        <div class="choice-treatment-name">${escapeHtml(quotedOneTimeNames[0] || quotedServicesLabel || 'One-time service')}</div>
        <div class="choice-treatment-detail">${escapeHtml(hasPreSlabOneTime ? 'Pre-slab soil treatment' : (hasOnlyBoraCareServices ? 'Bora-Care wood treatment' : 'One-time service'))}</div>
        <div class="big-price choice-treatment-price">
          <span class="num" id="onetime-display">${fmtMoney(onetimeTotal || oneTimeChoicePrice)}</span>
          <span class="per">one-time</span>
        </div>
        <div class="onetime-note">
          ${escapeHtml(hasPreSlabOneTime ? preSlabCopy.note : (hasOnlyBoraCareServices ? boraCareCopy.note : (germanRoachCleanoutItem ? germanRoachOneTimeCopy : 'One visit, pay on service day. No recurring schedule.')))}
        </div>
      </div>
    `;
  const recurringHeroPriceHtml = quoteRequired ? `
      <div class="big-price" data-mode-only="recurring">
        <span class="num" style="font-size:42px">Quote Required</span>
      </div>
      <div class="day-price" data-mode-only="recurring">${escapeHtml(quoteDisplayReason)}</div>
    ` : (isOneTimeOnly ? oneTimeOnlyHeroPriceHtml : (serviceCardsCoverRecurringTotal ? `
      ${recurringChoiceTreatmentHtml || `<div class="service-price-list" data-mode-only="recurring">${servicePriceCardsHtml}</div>`}
    ` : `
      <div class="big-price" data-mode-only="recurring">
        ${savingsPerMo > 0 ? `<span class="anchor" id="anchor-display">${fmtMoney(recurringDisplayBase)} / ${escapeHtml(recurringPricePeriodWord)}</span>` : ''}
        <span class="num" id="monthly-display">${fmtMoney(recurringDisplayTotal)}</span>
        <span class="per">${escapeHtml(recurringPricePeriodWord)}</span>
        <span class="tier-lbl">${commercialManualAccept ? 'Commercial' : `WaveGuard ${escapeHtml(tier)}`}</span>
      </div>
      ${savingsPerMo > 0 && !commercialManualAccept ? `<div class="save-row" data-mode-only="recurring" data-aggregate-save-row><span class="save-pill">You save <span id="savings-display">${fmtMoney(recurringDisplaySavings)}</span> / ${escapeHtml(recurringPricePeriodWord)} with WaveGuard ${escapeHtml(tier)}</span></div>` : ''}
      ${manualDiscountHtml}
      <div class="day-price" data-mode-only="recurring">${hasOnlyLawnCareServices ? `That\u2019s just ${fmtMoney(dayPrice)}/day to stop lawn pests before they turn green grass brown.` : `That\u2019s just ${fmtMoney(dayPrice)}/day for ${escapeHtml(pageCopy.aggregateDayLabel)}.`}</div>
      ${supplementalServiceSummaryHtml}
    `));

  const separatelyBilledOneTimeItems = oneTimeItems.filter((it) => {
    if (isWaveGuardSetupOneTimeItem(it)) return false;
    if (canChooseOneTime && isOneTimePestChoiceItem(it)) return false;
    return true;
  });
  const displayableOneTimeItems = quoteRequired
    ? []
    : separatelyBilledOneTimeItems.filter((it) => it.quoteRequired !== true);
  const separatelyBilledOneTimeTotal = displayableOneTimeItems.reduce((sum, it) => {
    const price = oneTimeItemAmount(it);
    return price ? Math.round((sum + price) * 100) / 100 : sum;
  }, 0);
  const realOneTimeRows = displayableOneTimeItems.map((it) => {
    const price = oneTimeItemAmount(it);
    const includedByServiceCredit = it.serviceSpecificDiscountApplied === true;
    if (price <= 0 && !includedByServiceCredit) return '';
    const detail = isTermiteInstallItem(it) ? formatTermiteBaitDetail(R.tmBait, it.detail) : it.detail;
    const priceHtml = includedByServiceCredit ? 'Included' : fmtMoney(price);
    return `<tr><td>${escapeHtml(friendlyOneTimeRowName(it) || 'One-time service')}${detail ? `<div class="sub">${escapeHtml(detail)}</div>` : ''}</td><td style="text-align:right">${priceHtml}</td></tr>`;
  }).filter(Boolean).join('');
  const hasRealOneTime = realOneTimeRows.length > 0;
  // Net the manual/custom one-time discount slice into the legacy (non-React)
  // HTML card so its itemized total matches the already-discounted hero and
  // accept totals. The slice never covers the termite install fee (kept at full
  // price), so capping at the gross row total leaves protected charges intact.
  const manualOneTimeDiscount = (!quoteRequired && hasRealOneTime)
    ? Math.min(separatelyBilledOneTimeTotal, Math.max(0, Number(manualDiscount?.oneTimeAmount) || 0))
    : 0;
  const manualOneTimeDiscountRowHtml = manualOneTimeDiscount > 0
    ? `<tr><td>${escapeHtml(manualDiscount.label || 'Discount')}<div class="sub">one-time</div></td><td style="text-align:right">-${fmtMoney(manualOneTimeDiscount)}</td></tr>`
    : '';
  const oneTimeRows = realOneTimeRows;
  const oneTimeRowsTotal = hasRealOneTime
    ? Math.max(0, Math.round((separatelyBilledOneTimeTotal - manualOneTimeDiscount) * 100) / 100)
    : onetimeTotal;
  const oneTimeItemsCardHtml = oneTimeRows ? `
  <div class="card"${canChooseOneTime ? ' data-mode-only="recurring"' : ''} style="margin-top:24px">
    <h3>${isOneTimeOnly ? 'Service details' : 'One-time items (billed separately)'}</h3>
    <table>${oneTimeRows}${manualOneTimeDiscountRowHtml}
      <tr><td><strong>${isOneTimeOnly ? 'Total' : 'One-time total'}</strong></td><td style="text-align:right"><strong>${fmtMoney(oneTimeRowsTotal)}</strong></td></tr>
    </table>
    ${hasRealOneTime && !isOneTimeOnly ? `<p style="font-size:13px;opacity:.65;margin:12px 0 0">These are scheduled after your recurring service starts. The WaveGuard member rate includes 15% off any one-time treatment.</p>` : ''}
  </div>` : '';

  const perksHtml = (hasOnlyLawnCareServices
    ? LAWN_CARE_PERKS
    : (hasOnlyMosquitoServices
      ? MOSQUITO_PERKS
      : (hasOnlyTermiteBaitServices ? TERMITE_BAIT_PERKS : PERKS)))
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join('');
  const reviewFallbacks = LOCATIONS.slice(0, 3).map((l) => ({
    reviewerName: `Waves ${l.name}`,
    text: `Read current Google reviews for our ${l.name} location.`,
    location: l.name,
    url: `https://www.google.com/maps/place/?q=place_id:${l.placeId}`,
    fallback: true,
  }));
  const socialsHtml = SOCIAL_LINKS.map((s) => `<a class="soc" href="${s.url}" target="_blank" rel="noopener" aria-label="${escapeHtml(s.name)}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${s.path}"/></svg></a>`).join('');

  // ── Waves AI block ──────────────────────────────────────────────
  // Canonical customer-facing AI/property explanation. The same payload
  // is exposed to the React v2 estimate via GET /:token/data.
  const intelligence = buildWaveGuardIntelligencePayload(est, estData, { recurringServices: recurring });
  // "Show your work" extension of the same card: parcel-outline satellite
  // image swaps in for the plain one when available, and the facts /
  // parcel-match / quality-note block lands after the metrics grid. All
  // three fragments are '' when showYourWork is null (gate off) so the
  // card output stays byte-identical to today.
  const aiSatelliteSrc = showYourWork?.overlaySatelliteUrl
    || (intelligence ? intelligence.satelliteUrl : null);
  const aiSatelliteCaptionHtml = showYourWork?.overlaySatelliteUrl ? `
    <p class="ai-satellite-caption">Red outline: your property boundary from county records.</p>` : '';
  const showYourWorkHtml = showYourWork ? `
    <div class="ai-show-work">
      <div class="ai-show-work-title">Where these details came from</div>
      ${showYourWork.facts.length ? `<div class="ai-fact-list">
        ${showYourWork.facts.map((f) => `<div class="ai-fact"><div><div class="ai-fact-label">${escapeHtml(f.label)}</div><div class="ai-fact-val">${escapeHtml(f.value)}</div></div><span class="ai-fact-source">${escapeHtml(f.source)}</span></div>`).join('')}
      </div>` : ''}
      ${showYourWork.parcelLine ? `<p class="ai-parcel-line">${escapeHtml(showYourWork.parcelLine)}</p>` : ''}
      ${showYourWork.qualityNote ? `<p class="ai-quality-note">${escapeHtml(showYourWork.qualityNote)}</p>` : ''}
    </div>` : '';
  const showYourWorkCss = showYourWork ? `
  .ai-satellite-caption{margin:6px 0 0;font-size:12px;color:#6B7280;line-height:1.45}
  .ai-show-work{display:grid;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid #E7E2D7}
  .ai-show-work-title{font-size:14px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
  .ai-fact-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  @media(max-width:720px){.ai-fact-list{grid-template-columns:1fr}}
  .ai-fact{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff;border:1px solid #E7E2D7;border-radius:10px;padding:10px 12px}
  .ai-fact-label{font-size:14px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
  .ai-fact-val{font-family:'Source Serif 4',Georgia,serif;font-size:18px;font-weight:500;color:#1B2C5B}
  .ai-fact-source{flex:none;padding:5px 9px;border-radius:999px;background:#E3F5FD;color:#065A8C;font:800 14px/1 Inter,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
  .ai-parcel-line{margin:0;font-size:14px;color:#3F4A65;line-height:1.5}
  .ai-quality-note{margin:0;font-size:14px;color:#3F4A65;line-height:1.5}` : '';
  const aiBlockHtml = intelligence ? `
  <section class="card ai-card waveguard-ai-card">
    <div class="intelligence-header">
      <div>
        <h2>${escapeHtml(intelligence.title)}</h2>
      </div>
      <span class="intelligence-badge">${escapeHtml(intelligence.eyebrow || 'Waves AI')}</span>
    </div>
    <p class="ai-blurb">${escapeHtml(intelligence.body)}</p>
    ${aiSatelliteSrc ? `<img class="ai-satellite" src="${escapeHtml(aiSatelliteSrc)}" alt="Satellite view of ${escapeHtml(est.address || 'your property')}" loading="lazy"/>` : ''}${aiSatelliteCaptionHtml}
    ${intelligence.metrics.length ? `<div class="ai-grid">
      ${intelligence.metrics.map((m) => `<div class="ai-metric"><div class="ai-metric-label">${escapeHtml(m.label)}</div><div class="ai-metric-val">${escapeHtml(m.value)}</div></div>`).join('')}
    </div>` : ''}${showYourWorkHtml}
    ${intelligence.signals.length ? `<div class="intelligence-signals">
      ${intelligence.signals.map((signal) => `<div class="intelligence-signal">${escapeHtml(signal)}</div>`).join('')}
    </div>` : ''}
  </section>` : '';
  const membershipBlockHtml = renderMembershipBlockHtml(membership);
  // Ask Waves chips read the raw rows merged with the normalized one-time rows
  // (the same superset the AI card + Bora-Care detection use), so engine-backed /
  // nested-result estimates still surface service-specific chips like
  // "What does Bora-Care treat?". Duplicates are harmless — every chip is added on
  // a boolean, never per row.
  const askPrompts = buildEstimateAskPrompts(
    recurring,
    [...oneTimeItems, ...boraCareOneTimeRows],
    pestRecurring,
    hasPestOneTime,
  );
  const estimateAskEnabled = isEstimateAskAnswerable({
    status: est.status,
    expires_at: est.expiresAt || est.expires_at,
  });
  const estimateAskBlockHtml = estimateAskEnabled ? `
  <section class="card estimate-ask-card" aria-labelledby="estimate-ask-title">
    <div class="estimate-ask-heading">
      <div>
        <h2 id="estimate-ask-title">Ask Waves</h2>
        <p class="ai-blurb">Get quick answers about your plan, pricing, scheduling, or service before you continue.</p>
      </div>
    </div>
    <form class="estimate-ask-form" id="estimate-ask-form">
      <input id="estimate-ask-input" name="estimate_question" type="text" maxlength="500" autocomplete="off" placeholder="Ask about services, pricing, scheduling, or Waves" aria-label="Ask Waves about this estimate">
      <button type="submit" id="estimate-ask-submit">Ask</button>
    </form>
    <div class="estimate-ask-prompts" aria-label="Example questions">
      ${askPrompts.map((prompt) => `<button type="button" data-estimate-ask-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`).join('')}
    </div>
    <div class="estimate-ask-answer" id="estimate-ask-answer" aria-live="polite" hidden></div>
  </section>` : '';

  // ── Service-prefs toggle card (only when estimate has a pest line) ────
  function renderPrefRow(key) {
    const cfg = SERVICE_PREFS[key];
    const on = prefs[key] !== false;
    // Per-row "if you toggle this off, you save …" label
    let savingsLabel = '';
    if (pestRecurring && hasPestOneTime) {
      const rec = (cfg.perVisit * pestRecurring.visitsPerYear) / 12;
      const freqKey = frequencyKeyFromVisitsPerYear(pestRecurring.visitsPerYear);
      savingsLabel = `Save ${fmtMoney(intervalPriceFromMonthly(rec, freqKey))}${pricePeriodLabelForFrequencyKey(freqKey)} + ${fmtMoney(cfg.oneTime)} on one-time`;
    } else if (pestRecurring) {
      const rec = (cfg.perVisit * pestRecurring.visitsPerYear) / 12;
      const freqKey = frequencyKeyFromVisitsPerYear(pestRecurring.visitsPerYear);
      savingsLabel = `Save ${fmtMoney(intervalPriceFromMonthly(rec, freqKey))}${pricePeriodLabelForFrequencyKey(freqKey)}`;
    } else if (hasPestOneTime) {
      savingsLabel = `Save ${fmtMoney(cfg.oneTime)}`;
    }
    return `
    <div class="pref-row${on ? '' : ' off'}" data-pref-row="${key}">
      <div class="pref-label">
        <div class="pref-title">${escapeHtml(cfg.label)} included</div>
        <div class="pref-desc" data-pref-desc>${on ? 'Toggle off if you want to skip this.' : escapeHtml(cfg.offDesc)}</div>
        <div class="pref-savings${on ? '' : ' none'}" data-pref-savings>${on ? escapeHtml(savingsLabel) : 'Applied to your estimate'}</div>
      </div>
      <label class="switch" title="${escapeHtml(cfg.label)}">
        <input type="checkbox" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''} data-pref-key="${key}"/>
        <span class="slider"></span>
      </label>
    </div>`;
  }
  const recurringOnlyAttr = canChooseOneTime ? ' data-mode-only="recurring"' : '';
  const prefsBlockHtml = showPrefs ? `
  <section class="card prefs-card"${recurringOnlyAttr}>
    <h2>Skip parts you don't need</h2>
    <p class="card-sub">Both are on by default. Toggle off whatever you don't want and the price adjusts instantly.</p>
    <div class="prefs-list">
      ${SERVICE_PREF_KEYS.map(renderPrefRow).join('')}
    </div>
  </section>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Your Waves Estimate</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  body{margin:0;font-family:Inter,system-ui,sans-serif;background:#FAF8F3;color:#1B2C5B;line-height:1.55;min-height:100vh;display:flex;flex-direction:column}
  @keyframes click-pulse{0%{transform:scale(1)}40%{transform:scale(.96)}100%{transform:scale(1)}}
  .is-click-pulse{animation:click-pulse .22s ease-out}
  h1,h2,h3{font-family:'Source Serif 4',Georgia,serif;font-weight:500;letter-spacing:0;margin:0 0 12px;color:#1B2C5B}
  h1{font-size:clamp(40px,6vw,64px);line-height:1.04;max-width:860px}
  h2{font-size:clamp(22px,3vw,28px);line-height:1.2}
  h3{font-size:18px;font-weight:600}
  p{margin:0 0 12px}
  .eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:#6B7280;font-weight:600;margin-bottom:6px;font-family:Inter,system-ui,sans-serif}
  .top-bar{background:#fff;border-bottom:1px solid #E7E2D7}
  .top-bar-inner{max-width:960px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:16px 24px}
  .top-phone{color:#1B2C5B;font-size:15px;font-weight:500;text-decoration:none}
  .top-phone:hover{color:${BRAND.blueDark}}
  .top-logo{height:28px;display:block}
  .wrap{flex:1;max-width:1040px;width:100%;margin:0 auto;padding:62px 24px 80px}
  .hero{padding:10px 0 28px;max-width:900px}
  .hero .addr{color:#3F4A65;font-size:17px;margin-top:8px}
  .hero-contact{text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:#6B7280;font-weight:600;margin-top:6px;font-family:Inter,system-ui,sans-serif}
  .service-price-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:28px;max-width:900px}
  .service-price-card{padding:18px 20px;border:1px solid #D9D3C4;border-radius:12px;background:#F2EEE0;box-shadow:0 6px 18px rgba(15,23,42,.10),0 2px 4px rgba(15,23,42,.06);display:flex;flex-direction:column}
  .service-price-name{font-size:15px;font-weight:800;color:#1B2C5B;line-height:1.35}
  .service-price-detail{font-size:12px;color:#6B7280;line-height:1.45;margin-top:2px;min-height:18px}
  .big-price{display:flex;align-items:baseline;gap:12px 18px;margin-top:28px;flex-wrap:wrap}
  .service-big-price{margin-top:14px;gap:8px 12px;align-content:flex-start}
  .big-price .anchor{font-family:'Source Serif 4',Georgia,serif;font-size:28px;color:#9CA3AF;text-decoration:line-through}
  .big-price .num{font-family:'Source Serif 4',Georgia,serif;font-weight:500;font-size:clamp(62px,8vw,84px);line-height:.92;color:#1B2C5B}
  .service-big-price .anchor{font-size:22px;flex-basis:100%}
  .service-big-price .num{font-size:clamp(44px,5vw,58px)}
  .big-price .per{font-size:24px;color:#6B7280}
  .service-big-price .per{font-size:18px}
  .big-price .tier-lbl{display:inline-block;padding:4px 10px;border-radius:6px;background:#EEF2FF;color:#1B2C5B;font-weight:600;font-size:12px;letter-spacing:.04em}
  .save-row{margin-top:10px;min-height:20px}
  .save-pill{display:inline-block;color:${BRAND.green};font-size:13px;font-weight:600}
  .service-price-card>.day-price{padding-top:8px}
  .supplemental-service-list{display:grid;gap:8px;max-width:720px;margin:18px auto 0}
  .supplemental-service-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:12px 14px;border:1px solid #E7E2D7;border-radius:10px;background:#fff;text-align:left}
  .supplemental-service-name{font-size:14px;font-weight:800;color:#1B2C5B;line-height:1.35}
  .supplemental-service-detail{font-size:12px;color:#6B7280;line-height:1.45;margin-top:2px}
  .supplemental-service-row strong{font-size:14px;line-height:1.25;color:#1B2C5B;white-space:nowrap}
  .day-price{margin-top:8px;font-size:14px;color:#6B7280}
  .setup-fee{margin-top:12px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;max-width:520px;padding:12px 14px;border:1px solid #D4CBB8;border-radius:10px;background:#fff}
  .setup-fee-title{font-size:14px;font-weight:700;color:#1B2C5B;line-height:1.35}
  .setup-fee-sub{font-size:12px;color:#6B7280;margin-top:2px;line-height:1.45}
  .per-treatment{margin-top:14px;max-width:520px;padding:14px 16px;border:1px solid #E7E2D7;border-radius:10px;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.04)}
  .per-treatment-title{font-size:12px;font-weight:700;color:#1B2C5B;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px}
  .per-treatment-rows{display:grid;gap:8px}
  .pt-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:baseline}
  .pt-label{font-size:14px;color:#1B2C5B;line-height:1.35}
  .pt-cadence{font-size:12px;color:#6B7280;margin-left:2px}
  .pt-price{font-size:14px;font-weight:700;color:#1B2C5B;white-space:nowrap}
  .pt-price span,.pt-suffix{font-weight:500;color:#6B7280}
  .pt-total{border-top:1px solid #E7E2D7;padding-top:8px;margin-top:2px}
  .pt-total .pt-label{font-weight:700}
  .mini-guarantee{margin-top:10px;font-size:13px;color:#1B2C5B}
  .mini-guarantee[data-mode-only="one_time"]{margin-top:4px;font-size:14px;line-height:1.55;color:#3F4A65}
  .mode-toggle{display:inline-flex;gap:4px;margin-top:18px;padding:4px;background:#F8FCFE;border-radius:999px;border:1px solid #CFE7F5}
  .mode-btn{appearance:none;border:0;background:transparent;color:#475569;font:600 13px/1 Inter,system-ui,sans-serif;padding:10px 18px;border-radius:999px;cursor:pointer;letter-spacing:.02em;transition:background .15s,color .15s}
  .mode-btn.is-active{background:${ESTIMATE_BUTTON_BLUE};color:#fff;box-shadow:0 1px 4px rgba(15,23,42,.12)}
  .mode-btn:not(.is-active):hover{color:#1B2C5B}
  .choice-treatment{padding:14px 0 8px;max-width:720px}
  .choice-treatment-name{font-size:15px;font-weight:800;color:#1B2C5B;line-height:1.35}
  .choice-treatment-detail{font-size:13px;color:#6B7280;line-height:1.45;margin-top:2px}
  .choice-treatment-price{margin-top:14px}
  .choice-treatment .save-row{margin-top:8px}
  .choice-treatment .day-price{margin-top:8px}
  .onetime-note{margin-top:14px;font-size:14px;color:#3F4A65;line-height:1.55;max-width:640px}
  @media(max-width:760px){.service-price-list{grid-template-columns:1fr}.service-big-price .num{font-size:clamp(42px,14vw,56px)}.supplemental-service-row{grid-template-columns:1fr}.supplemental-service-row strong{white-space:normal}}
  .card{background:#F2EEE0;border-radius:12px;padding:24px;margin-bottom:16px;border:1px solid #D9D3C4;box-shadow:0 6px 18px rgba(15,23,42,.10),0 2px 4px rgba(15,23,42,.06)}
  .card h2{margin:0 0 6px}
  .card h3{margin:0 0 10px}
  .card-sub{color:#6B7280;font-size:14px;margin:0 0 14px}
  .ai-card{background:#F2EEE0}
  .waveguard-ai-card{display:grid;gap:14px}
  .intelligence-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .intelligence-header h2{margin-bottom:0}
  .intelligence-badge{flex:none;align-self:flex-start;padding:6px 10px;border-radius:999px;background:#E3F5FD;color:#065A8C;font-size:12px;font-weight:800;line-height:1;letter-spacing:0;text-transform:uppercase}
  .ai-blurb{margin:0 0 14px;color:#3F4A65;font-size:14px;line-height:1.55}
  .ai-satellite{display:block;width:100%;max-height:320px;object-fit:cover;border-radius:10px;border:1px solid #E7E2D7;margin-top:0;background:#F7F5EE}${showYourWorkCss}
  .ai-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}
  @media(max-width:720px){.ai-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .ai-metric{background:#fff;border:1px solid #E7E2D7;border-radius:10px;padding:10px 12px}
  .ai-metric-label{font-size:14px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
  .ai-metric-val{font-family:'Source Serif 4',Georgia,serif;font-size:18px;font-weight:500;color:#1B2C5B}
  .intelligence-signals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:2px}
  @media(max-width:760px){.intelligence-header{display:grid}.intelligence-signals{grid-template-columns:1fr}}
  .intelligence-signal{border:1px solid #E7E2D7;border-left:4px solid #009CDE;border-radius:10px;background:#fff;padding:10px 12px;color:#3F4A65;font-size:16px;line-height:1.45}
  .wg-member-card{display:grid;gap:14px}
  .wg-member-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .wg-member-header h2{margin-bottom:0}
  @media(max-width:760px){.wg-member-header{display:grid}}
  .wg-tier-badge{flex:none;align-self:flex-start;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:800;line-height:1;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;border:1px solid #D9D3C4}
  .wg-tier-bronze{background:#F3E7D8;color:#8A5A21}
  .wg-tier-silver{background:#ECEEF1;color:#525B66}
  .wg-tier-gold{background:#FBF1D6;color:#8A6A12}
  .wg-tier-platinum{background:#EDEFF2;color:#2B3340}
  .wg-upgrade{background:#fff;border:1px solid #E7E2D7;border-left:4px solid #009CDE;border-radius:10px;padding:12px 14px;color:#1B2C5B;font-size:15px;line-height:1.5}
  .wg-section{display:grid;gap:8px}
  .wg-section-title{font-size:13px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
  .wg-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;background:#fff;border:1px solid #E7E2D7;border-radius:10px;padding:10px 12px}
  .wg-row-label{color:#1B2C5B;font-weight:600;font-size:15px}
  .wg-row-val{color:#1F7A4D;font-size:14px;font-weight:600;text-align:right}
  .estimate-ask-card{display:grid;gap:12px}
  .estimate-ask-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .estimate-ask-form{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}
  .estimate-ask-form input{width:100%;min-height:48px;border:1px solid #CFE7F5;border-radius:10px;padding:12px 14px;font:500 15px/1.35 Inter,system-ui,sans-serif;color:#1B2C5B;background:#F8FCFE;outline:none}
  .estimate-ask-form input:focus{border-color:${ESTIMATE_BUTTON_BLUE};box-shadow:0 0 0 3px rgba(27,44,91,.14);background:#fff}
  .estimate-ask-form button{min-height:48px;border:0;border-radius:10px;padding:0 18px;background:${ESTIMATE_BUTTON_BLUE};color:#fff;font:700 14px/1 Inter,system-ui,sans-serif;cursor:pointer}
  .estimate-ask-form button:disabled{opacity:.65;cursor:not-allowed}
  .estimate-ask-prompts{display:flex;flex-wrap:wrap;gap:8px}
  .estimate-ask-prompts button{appearance:none;border:1px solid ${ESTIMATE_BUTTON_BLUE};background:${ESTIMATE_BUTTON_BLUE};color:#fff;border-radius:999px;padding:8px 12px;font:700 12px/1 Inter,system-ui,sans-serif;cursor:pointer}
  .estimate-ask-prompts button:hover{background:#121E3D;border-color:#121E3D}
  .estimate-ask-answer{border-left:4px solid ${ESTIMATE_BUTTON_BLUE};background:#F8FCFE;border-radius:10px;padding:12px 14px;color:#1B2C5B;font-size:14px;line-height:1.55;white-space:pre-line}
  .estimate-ask-answer[data-state="error"]{border-left-color:#C8102E;background:#FFF5F5}
  @media(max-width:640px){.estimate-ask-form{grid-template-columns:1fr}.estimate-ask-form button{width:100%}}
  .billing-card{display:grid;gap:16px}
  .billing-card h2{margin-bottom:0}
  .billing-lede{margin:0;color:#3F4A65;font-size:15px;line-height:1.6}
  .payment-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  @media(max-width:760px){.payment-choice-grid{grid-template-columns:1fr}}
  .payment-choice{border:1px solid #E7E2D7;border-radius:10px;background:#fff;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 3px 10px rgba(15,23,42,.08),0 1px 2px rgba(15,23,42,.05)}
  .payment-choice.is-selected{border-color:${ESTIMATE_BUTTON_BLUE};box-shadow:0 0 0 3px rgba(27,44,91,.08)}
  .payment-choice-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .payment-choice h3{font-family:Inter,system-ui,sans-serif;font-size:16px;line-height:1.25;font-weight:800;letter-spacing:0;margin:0;color:#1B2C5B}
  .payment-choice-badge{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:#F8FCFE;border:1px solid #CFE7F5;color:#1B2C5B;padding:5px 9px;font:800 11px/1 Inter,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
  .payment-choice-badge.primary{background:#ECFDF5;border-color:#BBF7D0;color:#166534}
  .payment-choice p{margin:0;color:#6B7280;font-size:13px;line-height:1.5}
  .payment-choice-body{min-height:39px}
  .payment-summary-list{display:grid;border-top:1px solid #E7E2D7;border-bottom:1px solid #E7E2D7;margin:2px 0}
  .payment-summary-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid #F0ECE2}
  .payment-summary-row:first-child{border-top:0}
  .payment-summary-row span{font-size:12px;color:#6B7280;font-weight:800;text-transform:uppercase;letter-spacing:.06em;line-height:1.35}
  .payment-summary-row strong{font-size:14px;line-height:1.2;font-weight:800;color:#1B2C5B;text-align:right;white-space:nowrap}
  .payment-summary-row.discount strong,.payment-summary-row.discount span{color:${BRAND.green}}
  .payment-summary-row strong s{color:#9CA3AF;text-decoration-color:${BRAND.red};text-decoration-thickness:2px;margin-right:6px}
  .payment-summary-row.payment-summary-total{border-top:1px solid #1B2C5B;margin-top:4px;padding-top:12px}
  .payment-summary-row.payment-summary-total span{color:#1B2C5B}
  .payment-summary-row.payment-summary-total strong{font-size:15px;color:#1B2C5B}
  .plan-terms-card{display:grid;gap:14px}
  .plan-terms-card h2{margin-bottom:0}
  .plan-terms-list{display:grid;gap:10px;margin:0;padding:0;list-style:none}
  .plan-terms-item{display:grid;gap:3px;background:#fff;border:1px solid #E7E2D7;border-left:4px solid #1F7A4D;border-radius:10px;padding:12px 14px}
  .plan-terms-term{font-size:15px;font-weight:800;color:#1B2C5B;line-height:1.3}
  .plan-terms-detail{font-size:14px;color:#3F4A65;line-height:1.5}
  .manual-discount-row{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:12px 0 0;padding:10px 12px;border:1px solid #DCFCE7;border-radius:10px;background:#F0FDF4;color:${BRAND.green};font-size:14px;font-weight:800}
  .manual-discount-row strong{white-space:nowrap;font-size:14px}
  .payment-choice-cta{margin-top:auto;width:100%;border:1px solid ${ESTIMATE_BUTTON_BLUE};background:${ESTIMATE_BUTTON_BLUE};color:#fff;border-radius:8px;padding:12px 14px;font:800 13px/1.2 Inter,system-ui,sans-serif;cursor:pointer;text-align:center;transition:background .15s,color .15s,border-color .15s}
  .payment-choice-cta:hover:not([disabled]),.payment-choice-cta[aria-pressed="true"]{background:#121E3D;border-color:#121E3D}
  .payment-choice-cta.primary{background:${ESTIMATE_BUTTON_BLUE};border-color:${ESTIMATE_BUTTON_BLUE};color:#fff}
  .payment-choice-cta.primary:hover:not([disabled]),.payment-choice-cta.primary[aria-pressed="true"]{background:#121E3D;border-color:#121E3D}
  .payment-choice-cta[disabled]{opacity:.55;cursor:not-allowed}
  .billing-line{padding-top:8px;border-top:1px solid #F0ECE2;color:#1B2C5B;font-size:13px;font-weight:700;line-height:1.45}
  .billing-line.discount{color:${BRAND.green}}
  .billing-total-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-top:10px;border-top:1px solid #E7E2D7}
  .billing-total-row span{font-size:13px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .billing-total-row strong{font-family:'Source Serif 4',Georgia,serif;font-size:28px;font-weight:600;color:#1B2C5B;white-space:nowrap}
  .billing-small{font-size:12px!important;color:#6B7280!important;line-height:1.5!important}
  .payment-setup-summary{border:1px solid #D8E7F0;border-radius:12px;background:#F8FCFE;padding:14px 16px;margin:0 0 18px;display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
  .payment-setup-summary-main{min-width:0}
  .payment-setup-summary-kicker{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#6B7280;margin-bottom:5px}
  .payment-setup-summary-title{font-size:16px;font-weight:800;color:#1B2C5B;line-height:1.25;margin-bottom:4px}
  .payment-setup-summary-body{font-size:13px;color:#3F4A65;line-height:1.5}
  .payment-setup-summary-change{border:1px solid #CFE7F5;background:#fff;color:#1B2C5B;border-radius:8px;padding:8px 10px;font:800 12px/1 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
  .payment-setup-summary-change:hover{border-color:${ESTIMATE_BUTTON_BLUE}}
  @media(max-width:560px){.payment-setup-summary{display:block}.payment-setup-summary-change{margin-top:12px;width:100%}}
  .prefs-card h2{margin-bottom:4px}
  .prefs-list{margin-top:14px;display:flex;flex-direction:column;gap:10px}
  .pref-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px;background:#fff;border:1px solid #E7E2D7;border-radius:10px;transition:all .15s;box-shadow:0 3px 10px rgba(15,23,42,.08),0 1px 2px rgba(15,23,42,.05)}
  .pref-row.off{background:#F7F5EE;border-color:#D4CBB8}
  .pref-row .pref-label{flex:1;min-width:0}
  .pref-row .pref-title{font-weight:600;font-size:14px;color:#1B2C5B}
  .pref-row .pref-desc{font-size:12px;color:#6B7280;margin-top:2px;line-height:1.5}
  .pref-row .pref-savings{font-size:12px;color:${BRAND.green};font-weight:600;margin-top:4px}
  .pref-row .pref-savings.none{color:#9CA3AF;font-weight:500}
  .switch{position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0;margin-top:2px}
  .switch input{opacity:0;width:0;height:0}
  .switch .slider{position:absolute;cursor:pointer;inset:0;background:#D4CBB8;border-radius:24px;transition:.2s}
  .switch .slider::before{content:'';position:absolute;height:18px;width:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.15)}
  .switch input:checked+.slider{background:#1B2C5B}
  .switch input:checked+.slider::before{transform:translateX(18px)}
  .switch input:disabled+.slider{opacity:.5;cursor:not-allowed}
  .booking-card h2{font-family:Inter,system-ui,sans-serif;font-size:22px;font-weight:600;letter-spacing:0;color:#1B2C5B;margin:0 0 8px;line-height:1.2}
  .booking-card .card-sub{font-size:14px;color:#6B7280;margin:0 0 20px;line-height:1.55}
  .existing-appt-card{border:1px solid #E2E8F0;border-radius:12px;background:#fff;padding:14px 16px;margin-bottom:18px}
  .existing-appt-kicker{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6B7280;margin-bottom:6px}
  .existing-appt-title{font-size:18px;font-weight:800;color:#1B2C5B;line-height:1.3}
  .existing-appt-sub{font-size:14px;color:#3F4A65;margin-top:4px;line-height:1.4}
  .booking-state{padding:14px;border:1px dashed #E7E2D7;border-radius:10px;background:#F7F5EE;font-size:13px;color:#6B7280;text-align:center}
  .slot-list{display:grid;gap:10px}
  .date-finder{margin:0 0 16px;display:grid;gap:10px;padding:16px;border:1px solid #CFE7F5;border-radius:12px;background:#fff}
  .date-finder-eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:#64748B}
  .date-finder-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .date-finder-row input[type=text]{flex:1;min-width:200px;min-height:44px;border:1px solid #CFE7F5;border-radius:10px;padding:10px 12px;font-size:15px;color:#1B2C5B;background:#F8FCFE;box-sizing:border-box}
  .date-finder-row input[type=date]{min-height:44px;border:1px solid #CFE7F5;border-radius:10px;padding:10px 12px;font-size:15px;color:#1B2C5B;background:#fff}
  .date-finder-label{font-size:13px;color:#64748B;font-weight:600}
  .date-finder-btn{min-height:44px;border:0;border-radius:10px;padding:0 18px;background:#1B2C5B;color:#fff;font-size:14px;font-weight:700;cursor:pointer}
  .date-finder-btn[disabled]{opacity:.6;cursor:not-allowed}
  .date-finder-summary{font-size:14px;line-height:1.5;color:#1B2C5B;background:#F0F7FC;border:1px solid #CFE7F5;border-radius:10px;padding:10px 12px}
  .finder-soft{font-size:14px;line-height:1.4;color:#9A3412;background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;padding:10px 12px;margin-bottom:10px}
  #finder-area .slot-list{margin-top:10px}
  .slot-more{margin-top:10px;border:1px solid #E7E2D7;border-radius:12px;background:#fff;overflow:hidden}
  .slot-more summary{list-style:none;cursor:pointer;padding:12px 14px;color:#1B2C5B;font-size:14px;font-weight:700}
  .slot-more summary::-webkit-details-marker{display:none}
  .slot-more summary::after{content:'+';float:right;font-size:18px;line-height:1;color:#6B7280}
  .slot-more[open] summary::after{content:'–'}
  .slot-more-list{display:grid;gap:10px;padding:0 12px 12px}
  .slot-btn{width:100%;padding:14px 16px;border-radius:12px;cursor:pointer;background:#fff;color:#1B2C5B;border:1.5px solid #E2E8F0;text-align:left;transition:background-color .15s,border-color .15s,color .15s;font-family:Inter,system-ui,sans-serif}
  .slot-btn:hover:not([disabled]){border-color:${ESTIMATE_BUTTON_BLUE}}
  .slot-btn.selected{border-color:${ESTIMATE_BUTTON_BLUE};background:${ESTIMATE_BUTTON_BLUE};color:#fff}
  .slot-btn .slot-day{display:block;font-size:14px;font-weight:600;color:#6B7280;margin-bottom:5px;line-height:1.25}
  .slot-btn .slot-time{display:block;font-size:20px;font-weight:700;margin-bottom:4px;line-height:1.2}
  .slot-btn .slot-reason{display:block;font-size:14px;color:#6B7280;line-height:1.35}
  .slot-btn.selected .slot-day{color:rgba(255,255,255,.82)}
  .slot-btn.selected .slot-reason{color:rgba(255,255,255,.86)}
  .pay-pref-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}
  .pay-pref-grid.options{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  @media(max-width:560px){.pay-pref-grid,.pay-pref-grid.options{grid-template-columns:1fr}}
  .pay-pref-choice{display:flex;flex-direction:column;gap:8px}
  .pay-pref-btn{background:#fff;border:2px solid #E7E2D7;border-radius:10px;padding:14px;text-align:center;cursor:pointer;font:inherit;color:inherit;transition:border-color .15s,background .15s;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:100%}
  .pay-pref-btn:hover:not([disabled]){border-color:${BRAND.blueDark}}
  .pay-pref-btn[disabled]{opacity:.5;cursor:not-allowed}
  .pay-pref-btn .pay-pref-title{font-size:14px;font-weight:600;color:#1B2C5B}
  .pay-pref-note{font-size:13px;color:#6B7280;line-height:1.45;padding:0 2px;text-align:center}
  .pay-pref-choice[hidden]{display:none}
  .pay-pref-btn[hidden]+.pay-pref-note{display:none}
  #deposit-overlay{position:fixed;inset:0;background:rgba(27,44,91,.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
  #deposit-overlay .deposit-card{background:#fff;border:1px solid #E7E2D7;border-radius:14px;max-width:440px;width:100%;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.25);max-height:90vh;overflow:auto}
  #deposit-overlay .deposit-error{color:#C8312F;font-size:14px;line-height:1.45;margin-top:10px}
  .pay-pref-btn[aria-pressed="true"]{box-shadow:0 0 0 3px rgba(27,44,91,.16)}
  .pay-pref-btn .pay-pref-sub{font-size:12px;color:#6B7280;line-height:1.45}
  .pay-pref-btn.primary{background:#1B2C5B;color:#fff;border-color:#1B2C5B}
  .pay-pref-btn.primary .pay-pref-title{color:#fff}
  .pay-pref-btn.primary .pay-pref-sub{color:rgba(255,255,255,.8)}
  .pay-pref-btn.prepay{background:${ESTIMATE_BUTTON_BLUE};color:#fff;border-color:${ESTIMATE_BUTTON_BLUE}}
  .pay-pref-btn.prepay .pay-pref-title{color:#fff}
  .pay-pref-btn.prepay .pay-pref-sub{color:rgba(255,255,255,.85)}
  .reservation-banner{background:#ECFDF5;border:1px solid ${BRAND.green};color:#065F46;border-radius:10px;padding:12px 14px;font-size:13px;margin-top:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .review-payment-summary{font-size:14px;color:#374151;line-height:1.45;margin:12px 0 0;font-weight:600}
  .reservation-banner .countdown{font-family:'Source Serif 4',Georgia,serif;font-weight:500;color:#065F46;font-size:15px}
  table{width:100%;border-collapse:collapse}
  td{padding:10px 0;border-bottom:1px solid #E7E2D7;vertical-align:top;font-size:14px}
  tr:last-child td{border-bottom:0}
  td.val{text-align:right;font-weight:500;color:#1B2C5B}
  .sub{font-size:12px;color:#6B7280;margin-top:2px}
  .cta{display:block;width:100%;padding:14px 22px;background:#1B2C5B;color:#fff;border:none;border-radius:10px;font-family:Inter,system-ui,sans-serif;font-weight:500;font-size:16px;cursor:pointer;transition:all .15s;text-align:center;text-decoration:none}
  .cta:hover:not([disabled]){background:#121E3D}
  .cta.secondary{background:transparent;color:#1B2C5B;border:1px solid #1B2C5B}
  .cta[disabled]{opacity:.6;cursor:not-allowed}
  .upsell{background:#F2EEE0;border:1px solid #D9D3C4;border-radius:12px;padding:18px;margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s;width:100%;text-align:left;font:inherit;color:inherit;-webkit-tap-highlight-color:rgba(27,44,91,.12);box-shadow:0 6px 18px rgba(15,23,42,.10),0 2px 4px rgba(15,23,42,.06)}
  .upsell:hover{background:#EDE8D8;border-color:#C9C0AA;box-shadow:0 8px 22px rgba(15,23,42,.14),0 3px 6px rgba(15,23,42,.08)}
  .upsell:active{background:#EDE8D8}
  .upsell:disabled{opacity:.7;cursor:wait}
  .upsell.requested{background:#ECFDF5;border-color:#86EFAC;box-shadow:0 6px 18px rgba(22,101,52,.12),0 2px 4px rgba(22,101,52,.08)}
  .upsell.requested:disabled{opacity:1;cursor:default}
  .upsell .txt{flex:1;min-width:200px}
  .upsell h3{color:#1B2C5B;margin:0 0 4px}
  .upsell-btn{background:#1B2C5B;color:#fff;padding:12px 20px;border-radius:8px;border:none;font-weight:500;cursor:pointer;font-size:14px;min-height:44px;pointer-events:none}
  .upsell.requested .upsell-btn{background:#166534}
  .upsell-request-status{background:#ECFDF5;border:1px solid #86EFAC;color:#14532D;border-radius:10px;padding:12px 14px;margin:-4px 0 16px;font-size:14px;line-height:1.45}
  .upsell-request-status strong{display:block;color:#14532D;margin-bottom:2px}
  @media(max-width:520px){.upsell-btn{width:100%}}
  .perks-list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
  @media(max-width:640px){.perks-list{grid-template-columns:1fr}}
  .perks-list li{background:#fff;border:1px solid #E7E2D7;border-radius:12px;padding:14px 16px 14px 40px;position:relative;font:500 14px/1.4 Inter,system-ui,sans-serif;color:#1B2C5B;box-shadow:0 3px 10px rgba(15,23,42,.08),0 1px 2px rgba(15,23,42,.05)}
  .perks-list li::before{content:'✓';position:absolute;left:14px;top:14px;color:${BRAND.green};font-weight:700;font-size:14px;line-height:1.4}
  .app-shots{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:4px 0 18px}
  @media(max-width:560px){.app-shots{grid-template-columns:1fr 1fr;gap:18px}}
  @media(max-width:340px){.app-shots{grid-template-columns:1fr}}
  .app-shot{margin:0;display:flex;flex-direction:column}
  .app-shot .phone{background:#1B2C5B;border-radius:22px;padding:5px;box-shadow:0 12px 26px rgba(15,23,42,.20),0 3px 8px rgba(15,23,42,.12)}
  .app-shot .phone img{display:block;width:100%;height:auto;border-radius:17px;background:#fff}
  .app-shot figcaption{margin-top:11px}
  .app-shot figcaption strong{display:block;font:700 14px/1.2 Inter,system-ui,sans-serif;color:#1B2C5B}
  .app-shot figcaption span{display:block;margin-top:2px;font:500 12.5px/1.35 Inter,system-ui,sans-serif;color:#3F4A65}
  .app-promo{margin-top:16px;padding:16px;border-radius:12px;background:${BRAND.blueLight};border:1px solid #CDEBFA}
  .app-promo-head strong{display:block;font:700 15px/1.3 Inter,system-ui,sans-serif;color:#1B2C5B}
  .app-promo-head span{display:block;margin-top:2px;font:500 13px/1.45 Inter,system-ui,sans-serif;color:#3F4A65}
  .app-features{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0 14px}
  @media(max-width:560px){.app-features{grid-template-columns:repeat(2,1fr)}}
  .app-feature{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #DCEAF3;border-radius:10px;padding:10px 11px}
  .af-ico{flex:0 0 auto;width:28px;height:28px;border-radius:7px;background:${BRAND.blueLight};color:${BRAND.blueDark};display:flex;align-items:center;justify-content:center}
  .af-ico svg{width:17px;height:17px}
  .app-feature>span{font:600 12.5px/1.25 Inter,system-ui,sans-serif;color:#1B2C5B}
  .app-badges{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:2px}
  .app-badges.is-coming-soon{opacity:.92}
  .app-badge{display:inline-flex;line-height:0;border-radius:7px}
  .app-badge svg{display:block;height:40px;width:auto}
  .app-badge-caption{flex-basis:100%;margin-top:-2px;font:600 12px/1 Inter,system-ui,sans-serif;color:${BRAND.blueDark};letter-spacing:.02em}
  .review-carousel{background:transparent;border:0;padding:0;position:relative}
  .review-track{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;transition:opacity .3s}
  @media(max-width:760px){.review-track{grid-template-columns:1fr}}
  .review-card{background:#fff;border:1px solid #E7E2D7;border-radius:10px;padding:16px;min-height:178px;display:flex;flex-direction:column}
  .review-card .stars{color:${BRAND.yellow};font-size:14px;margin-bottom:8px;letter-spacing:1px}
  .review-card p{font-size:13px;margin:0 0 12px;font-style:italic;line-height:1.55;color:#3F4A65;flex:1}
  .review-card.review-profile-card p{font-style:normal}
  .rev-meta{font-size:12px;color:#6B7280}
  .review-link{display:inline-flex;margin-top:10px;color:#1B2C5B;font-size:13px;font-weight:800;text-decoration:none}
  .review-link:hover{text-decoration:underline}
  .review-dots{display:flex;justify-content:center;gap:6px;margin-top:14px}
  .review-dots button{width:7px;height:7px;border-radius:50%;border:none;background:#D4CBB8;cursor:pointer;padding:0;transition:all .2s}
  .review-dots button.active{background:#1B2C5B;width:18px;border-radius:4px}
  .review-track.fade{opacity:0}
  .reviews-header{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;color:#1B2C5B;font-weight:600}
  .reviews-header .stars{color:${BRAND.yellow};letter-spacing:1px;font-size:14px}
  .locs{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:14px}
  @media(max-width:560px){.locs{grid-template-columns:1fr}}
  .loc{background:#F7F5EE;border:1px solid #E7E2D7;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:4px}
  .loc .loc-name{color:#1B2C5B;font-size:14px;font-weight:600;text-decoration:none}
  .loc .loc-name:hover{text-decoration:underline}
  .loc .loc-addr{color:#3F4A65;font-size:12px;text-decoration:none;line-height:1.4}
  .loc .loc-addr:hover{text-decoration:underline}
  .loc .loc-phone{color:#1B2C5B;font-size:13px;font-weight:500;text-decoration:none}
  .loc .loc-phone:hover{text-decoration:underline}
  .loc .loc-hours{color:${BRAND.green};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
  .final{background:#1B2C5B;color:#fff;text-align:center;padding:32px 24px;border-radius:14px;border:1px solid #1B2C5B}
  .final h2{color:#fff;margin:0 0 6px}
  .final-subhead{color:#fff;margin:0 0 10px;font-size:20px;font-weight:600}
  .final p{color:rgba(255,255,255,.8);font-size:14px}
  .accepted-banner{background:#ECFDF5;border:1px solid ${BRAND.green};color:${BRAND.green};text-align:center;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:500;font-size:14px}
  .quote-required-banner{background:#FFF7ED;border:1px solid #FDBA74;color:#9A3412;text-align:center;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:500;font-size:14px}
  .site-footer{text-align:center;padding:40px 20px 32px;color:#6B7280;font-size:12px;border-top:1px solid #E7E2D7;background:#FAF8F3;margin:32px -20px -64px}
  .site-footer-socials{display:flex;justify-content:center;gap:12px;margin-bottom:16px}
  .site-footer-socials .soc{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:#F7F5EE;border:1px solid #E7E2D7;color:#1B2C5B;transition:all .15s}
  .site-footer-socials .soc:hover{background:#1B2C5B;color:#fff;border-color:#1B2C5B}
  .site-footer-contact{margin-bottom:10px;font-size:13px;color:#3F4A65}
  .site-footer-contact a{color:#1B2C5B;text-decoration:none;font-weight:500}
  .site-footer-contact a:hover{text-decoration:underline}
  .site-footer-contact .dot{margin:0 8px;color:#9CA3AF}
  .site-footer-legal{font-size:11px;color:#6B7280}
  #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1B2C5B;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:100}
  #toast.show{opacity:1}
  .q-bar{display:none}
  .q-bar .q-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:10px 14px;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none;line-height:1.2;transition:background .15s,color .15s}
  .q-bar .q-btn svg{flex-shrink:0}
  .q-bar .q-call{background:#1B2C5B;color:#fff}
  .q-bar .q-call:hover{background:#121E3D}
  .q-bar .q-text{background:#F7F5EE;color:#1B2C5B;border:1px solid #E7E2D7}
  .q-bar .q-text:hover{background:#EDE8D8}
  @media(max-width:760px){
    #toast{bottom:calc(80px + env(safe-area-inset-bottom,0))}
    .q-bar{position:fixed;left:0;right:0;bottom:0;z-index:90;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0));background:rgba(255,255,255,.96);backdrop-filter:saturate(140%) blur(8px);-webkit-backdrop-filter:saturate(140%) blur(8px);border-top:1px solid #E7E2D7;box-shadow:0 -2px 12px rgba(15,23,42,.06)}
    body{padding-bottom:calc(76px + env(safe-area-inset-bottom,0))}
  }
  @media(max-width:480px){.q-bar .q-btn{font-size:13px;padding:10px}}
</style>
</head><body>

${shellTopBar()}

<div class="wrap">

  ${est.status === 'accepted' ? `<div class="accepted-banner">✓ You\u2019ve accepted this estimate — we\u2019ll be in touch shortly.</div>` : ''}
  ${quoteRequired && est.status !== 'accepted' ? (commercialProposal
    ? `<div class="quote-required-banner">${proposalPdfEmailed
        ? 'Your formal proposal is attached as a PDF to the email we sent.'
        : 'Your Waves account manager has your formal proposal and will share the PDF with you directly.'} There\u2019s no online checkout for a commercial bid \u2014 your account manager will follow up to finalize. Questions? Call <a href="tel:${COMPANY.phoneRaw}" style="color:#9A3412">${COMPANY.phone}</a>.</div>`
    : commercialRiskType
    ? `<div class="quote-required-banner">This is a commercial service plan \u2014 your Waves account manager will confirm the details with you and finalize it directly, so there\u2019s no online checkout for this one. Questions? Call <a href="tel:${COMPANY.phoneRaw}" style="color:#9A3412">${COMPANY.phone}</a>.</div>`
    : commercialLowConfidence
    ? `<div class="quote-required-banner">We just need a quick site confirmation to finalize this commercial estimate \u2014 your Waves account manager will confirm the price with you directly, so there\u2019s no online checkout for this one. Questions? Call <a href="tel:${COMPANY.phoneRaw}" style="color:#9A3412">${COMPANY.phone}</a>.</div>`
    : `<div class="quote-required-banner">This treatment needs an inspection before it can be accepted online. Call <a href="tel:${COMPANY.phoneRaw}" style="color:#9A3412">${COMPANY.phone}</a> and we\u2019ll finish the quote.${quoteDisplayReason ? `<div style="margin-top:8px;font-weight:700">${escapeHtml(quoteDisplayReason)}</div>` : ''}</div>`) : ''}

  <div class="hero">
    <div class="eyebrow">Your estimate · ${escapeHtml(quotedServicesLabel)}</div>
    <h1>Hey ${firstName}, ${canChooseOneTime ? 'choose your pest control option.' : escapeHtml(pageCopy.heroSuffix)}</h1>
    ${fullName ? `<div class="hero-contact">${fullName}</div>` : ''}
    ${address ? `<div class="hero-contact">${address}</div>` : ''}
    ${customerEmail ? `<div class="hero-contact">${customerEmail}</div>` : ''}
    ${customerPhoneDisplay ? `<div class="hero-contact">${customerPhoneDisplay}</div>` : ''}
    ${canChooseOneTime ? `
    <div class="mode-toggle" role="group" aria-label="Pest control service type">
      <button type="button" class="mode-btn is-active" data-mode-set="recurring" aria-pressed="true">${escapeHtml(pestTierCadence || 'Recurring')} Pest Control</button>
      <button type="button" class="mode-btn" data-mode-set="one_time" aria-pressed="false">One-Time Pest Control</button>
    </div>` : ''}
    ${recurringHeroPriceHtml}
    ${canChooseOneTime ? `
    <div class="choice-treatment" data-mode-only="one_time" hidden>
      <div class="choice-treatment-name">One-Time Pest Control</div>
      <div class="choice-treatment-detail">Single treatment</div>
      <div class="big-price choice-treatment-price">
        <span class="num" id="onetime-display">${fmtMoney(oneTimeChoicePrice)}</span>
        <span class="per">one-time</span>
      </div>
      <div class="onetime-note">
        One visit, pay on service day. No recurring schedule, no tier discount.
      </div>
    </div>
    ` : ''}
    ${quoteRequired || isOneTimeOnly ? '' : `<div class="mini-guarantee" data-mode-only="recurring">${escapeHtml(pageCopy.recurringAssurance)}</div>`}
    ${isOneTimeOnly && !hasOnlyBoraCareServices ? `<div class="mini-guarantee">${escapeHtml(hasPreSlabOneTime ? preSlabCopy.warranty : (germanRoachCleanoutItem ? germanRoachGuaranteeCopy : 'Includes a 30-day callback period if pests return after this visit.'))}</div>` : ''}
    ${canChooseOneTime ? `<div class="mini-guarantee" data-mode-only="one_time" hidden>Includes a 30-day callback period if pests return after this visit.</div>` : ''}
    ${oneTimeItemsCardHtml}
  </div>

  ${membershipBlockHtml}

  ${aiBlockHtml}

  ${estimateAskBlockHtml}

  ${billingCardHtml}

  ${planTermsCardHtml}

  ${prefsBlockHtml}

  ${showUpsell ? `
	  <button type="button" class="upsell"${recurringOnlyAttr} onclick="inquireBundle('${escapeHtml(upsellService)}')" aria-label="Get a bundle quote for ${escapeHtml(upsellService)}">
	    <span class="txt">
	      <h3>${escapeHtml(hasOnlyLawnCareServices && upsellService === 'Pest Control' ? 'Add Pest Control for bundled pricing' : `Add ${upsellService} and save more`)}</h3>
	      <div style="font-size:14px">${escapeHtml(hasOnlyLawnCareServices && upsellService === 'Pest Control'
          ? `Want the home perimeter covered too? Bundling unlocks ${nextTierName} tier pricing (${nextTierPct}% off qualifying services).`
          : `Bundling unlocks ${nextTierName} tier pricing (${nextTierPct}% off qualifying services). Curious what that looks like?`)}</div>
	    </span>
    <span class="upsell-btn">Get a bundle quote</span>
  </button>
  <div class="upsell-request-status" id="upsell-request-status" hidden>
    <strong>Request received.</strong>
    <span id="upsell-request-status-copy">Got it. We are reviewing this service for your property and will follow up with a revised estimate shortly.</span>
  </div>` : ''}

  ${locked ? '' : commercialManualAccept ? `
  <section class="card booking-card" id="commercial-accept-card">
    <h2 id="booking-title">Approve your commercial service</h2>
    <p class="card-sub">This is a commercial service plan. Approve your estimate and a Waves account manager will schedule your visits and send your invoice &mdash; no card or deposit needed now.</p>
    <p class="card-sub" style="font-style:italic">Pricing is estimated from your property details and confirmed on site before your first visit.</p>
    ${commercialPriceRange.hasLowConfidence ? `<p class="card-sub" style="font-weight:700">Estimated range: ${fmtMoney(commercialPriceRange.rangeLowMonthly)}&ndash;${fmtMoney(commercialPriceRange.rangeHighMonthly)}/mo &mdash; final price confirmed on site.</p>` : ''}
    <div class="pay-pref-grid options">
      <div class="pay-pref-choice">
        <button type="button" class="pay-pref-btn primary" id="commercial-approve-btn" data-commercial-mode="monthly"><span class="pay-pref-title">Approve &amp; pay monthly</span></button>
        <div class="pay-pref-note">We&rsquo;ll invoice you each month &mdash; no card needed now.</div>
      </div>
      ${showAnnualPrepayOption ? `<div class="pay-pref-choice">
        <button type="button" class="pay-pref-btn prepay" id="commercial-prepay-btn" data-commercial-mode="prepay"><span class="pay-pref-title">Prepay the year &mdash; save 5%</span></button>
        <div class="pay-pref-note">${escapeHtml(prepayButtonSubCopy)}</div>
      </div>` : ''}
    </div>
    <div class="pay-pref-note" id="commercial-approve-note" style="display:none" aria-live="polite"></div>
  </section>
  ` : `
  <section class="card booking-card" id="booking-card"${existingAppointment ? '' : (requirePaymentSetupBeforeSlots && !isOneTimeOnly ? ' style="display:none"' : '')}>
    <h2 id="booking-title">${escapeHtml(pageCopy.bookingTitle)}</h2>
    ${existingAppointment ? `
      <p class="card-sub">Your visit is already on the schedule. Choose how you want to pay to approve this estimate.</p>
      <div class="existing-appt-card">
        <div class="existing-appt-kicker">Existing appointment</div>
        <div class="existing-appt-title">${escapeHtml(existingAppointment.windowDisplay || `${existingAppointment.scheduledDate}${existingAppointment.windowStart ? ` at ${existingAppointment.windowStart}` : ''}`)}</div>
        <div class="existing-appt-sub">${escapeHtml(existingAppointment.serviceType || pageCopy.aggregateDayLabel || 'Service visit')}</div>
      </div>
    ` : `
      <p class="card-sub">${escapeHtml(pageCopy.bookingSubhead)}</p>
      <div id="payment-setup-summary" class="payment-setup-summary" style="display:none">
        <div class="payment-setup-summary-main">
          <div class="payment-setup-summary-kicker">Selected invoice option</div>
          <div class="payment-setup-summary-title" id="payment-setup-summary-title">Invoice option selected</div>
          <div class="payment-setup-summary-body" id="payment-setup-summary-body">Review the invoice setup, then choose a service window.</div>
        </div>
        <button type="button" class="payment-setup-summary-change" id="change-payment-setup-btn">Change payment option</button>
      </div>
      <div id="date-finder" class="date-finder">
        <div class="date-finder-eyebrow">Waves AI</div>
        <div class="date-finder-row">
          <input id="ai-when-input" type="text" placeholder="Search a date or time \u2014 try &quot;next Tuesday afternoon&quot;" maxlength="120" aria-label="Search for a service date or time" />
          <button type="button" id="ai-when-btn" class="date-finder-btn">Search</button>
        </div>
        <div class="date-finder-row">
          <label for="date-pick-input" class="date-finder-label">Or pick a date</label>
          <input id="date-pick-input" type="date" aria-label="Pick a service date" />
        </div>
        <div id="ai-when-summary" class="date-finder-summary" style="display:none"></div>
        <div id="finder-area"></div>
      </div>
      <div id="slot-area" class="booking-state">Checking the route map\u2026</div>
    `}
    <div id="pay-pref-area" style="${existingAppointment ? '' : 'display:none'}">
      <h3 id="pay-pref-heading" style="margin:20px 0 4px">${escapeHtml(pageCopy.payPrefHeading)}</h3>
      <p class="card-sub" id="pay-pref-subhead" style="margin:0">${escapeHtml(billingLede)}</p>
      <div class="pay-pref-grid options">
        <div class="pay-pref-choice">
          <button type="button" class="pay-pref-btn primary" data-pay-pref="pay_at_visit" data-pay-pref-card><span class="pay-pref-title">${escapeHtml(pageCopy.payPrefCardTitle)}</span></button>
          <div class="pay-pref-note">${escapeHtml(standardInvoiceCopy.payPrefCardSub)}</div>
        </div>
        <div class="pay-pref-choice">
          <button type="button" class="pay-pref-btn" data-pay-pref="pay_at_visit" data-pay-pref-visit hidden><span class="pay-pref-title" data-pay-visit-title>Pay at the visit</span></button>
          <div class="pay-pref-note" data-pay-visit-sub>We will collect payment with the tech on-site. No card needed now.</div>
        </div>
        ${showAnnualPrepayOption ? `<div class="pay-pref-choice"><button type="button" class="pay-pref-btn prepay" data-pay-pref="prepay_annual" data-pay-pref-prepay><span class="pay-pref-title">${escapeHtml(pageCopy.prepayTitle)}</span></button><div class="pay-pref-note">${escapeHtml(prepayButtonSubCopy)}</div></div>` : ''}
      </div>
    </div>
    <div id="review-area" style="display:none">
      ${existingAppointment ? '<div class="reservation-banner"><span>Appointment already scheduled</span></div>' : '<div class="reservation-banner"><span>Slot held for you</span><span class="countdown" id="reservation-countdown">15:00</span></div>'}
      ${existingAppointment ? '<div class="review-payment-summary" id="existing-review-pay-summary" aria-live="polite"></div>' : ''}
      <div class="pay-pref-grid">
        <button type="button" class="pay-pref-btn primary" id="confirm-book-btn"><span class="pay-pref-title" id="confirm-book-title">${existingAppointment ? '' : escapeHtml(pageCopy.cardConfirmTitle)}</span><span class="pay-pref-sub" id="confirm-book-sub">${existingAppointment ? '' : 'You will be taken to a secure Stripe page to add your card.'}</span></button>
        ${existingAppointment ? '' : '<button type="button" class="pay-pref-btn" id="change-booking-pick-btn"><span class="pay-pref-title">Change my pick</span><span class="pay-pref-sub">Release this slot and choose a different time or payment option.</span></button>'}
      </div>
      <div class="pay-pref-note" id="deposit-due-note" style="display:none" aria-live="polite"></div>
    </div>
  </section>
  `}

  ${quoteRequired || isOneTimeOnly || commercialManualAccept ? '' : `<div class="card" data-mode-only="recurring">
    <h2>${escapeHtml(pageCopy.perksHeading)}</h2>
    <p class="ai-blurb">${escapeHtml(pageCopy.perksBody)}</p>
    <ul class="perks-list">${perksHtml}</ul>
  </div>`}

  <div class="card transparency-card">
    <h2>Watch every visit &mdash; right from your phone</h2>
    <p class="ai-blurb">Live GPS, visit reports, and alerts you control &mdash; the Waves app keeps you in the loop from booking to done.</p>
    <div class="app-shots">
      <figure class="app-shot">
        <div class="phone"><img src="/images/app/app-tracking.webp" width="760" height="1647" loading="lazy" alt="Waves app visit screen with a live-GPS tech-en-route update before arrival"></div>
        <figcaption><strong>See your tech coming</strong><span>Live GPS, the hour before arrival</span></figcaption>
      </figure>
      <figure class="app-shot">
        <div class="phone"><img src="/images/app/app-visits.webp" width="760" height="1647" loading="lazy" alt="Waves app Visits screen listing upcoming and completed service visits"></div>
        <figcaption><strong>Every visit &amp; report</strong><span>Upcoming, past, and what we did</span></figcaption>
      </figure>
      <figure class="app-shot">
        <div class="phone"><img src="/images/app/app-alerts.webp" width="760" height="1647" loading="lazy" alt="Waves app notification settings, with each alert set to text, email, or both"></div>
        <figcaption><strong>Alerts you control</strong><span>Text, email, or both</span></figcaption>
      </figure>
      <figure class="app-shot">
        <div class="phone"><img src="/images/app/app-contacts.webp" width="760" height="1647" loading="lazy" alt="Waves app on-location contacts screen to add a spouse, tenant, or property manager"></div>
        <figcaption><strong>Loop in your family</strong><span>Spouse, tenant, or property manager</span></figcaption>
      </figure>
    </div>
    <div class="app-promo">
      <span class="app-promo-head"><strong>It&rsquo;s all in the Waves app</strong><span>One login for your whole household &mdash; everything in one place.</span></span>
      <div class="app-features">
        <div class="app-feature"><span class="af-ico">${ICON_PIN}</span><span>Live tech tracking</span></div>
        <div class="app-feature"><span class="af-ico">${ICON_CHAT}</span><span>Text your tech</span></div>
        <div class="app-feature"><span class="af-ico">${ICON_DOC}</span><span>Photo &amp; video reports</span></div>
        <div class="app-feature"><span class="af-ico">${ICON_FAMILY}</span><span>Add family to alerts</span></div>
        <div class="app-feature"><span class="af-ico">${ICON_CARD}</span><span>Billing &amp; autopay</span></div>
        <div class="app-feature"><span class="af-ico">${ICON_CAL}</span><span>Reschedule &amp; history</span></div>
      </div>
      <span class="app-badges${APP_STORE_URL || PLAY_STORE_URL ? '' : ' is-coming-soon'}">
        ${APP_STORE_URL || !PLAY_STORE_URL ? appBadge(appStoreBadgeSvg(), APP_STORE_URL, 'Download Waves on the App Store') : ''}
        ${PLAY_STORE_URL || !APP_STORE_URL ? appBadge(googlePlayBadgeSvg(), PLAY_STORE_URL, 'Get Waves on Google Play') : ''}
        ${APP_STORE_URL || PLAY_STORE_URL ? '' : '<span class="app-badge-caption">Coming soon to iPhone &amp; Android</span>'}
      </span>
    </div>
  </div>

  <div class="card">
    <h2>Customer reviews</h2>
    <p class="ai-blurb">Real Google reviews from homeowners across our service area.</p>
    <div class="review-carousel" id="review-carousel">
      <div class="review-track" id="review-track">
        <div class="review-card">
          <div class="stars">\u2605\u2605\u2605\u2605\u2605</div>
          <p>Loading reviews from our customers\u2026</p>
          <div class="rev-meta"></div>
        </div>
      </div>
      <div class="review-dots" id="review-dots"></div>
    </div>
  </div>

  ${quoteRequired && est.status !== 'accepted' ? (commercialProposal ? `
  <div class="final">
    <h2>Your commercial proposal is ready</h2>
    <p>${proposalPdfEmailed
      ? 'We’ve emailed your formal proposal as a PDF.'
      : 'Your Waves account manager has your formal proposal and will send the PDF to you directly.'} There’s no online checkout for a commercial bid — your account manager will follow up to answer questions and finalize the agreement.</p>
    <a href="tel:${COMPANY.phoneRaw}" class="cta" style="display:inline-block;max-width:360px;margin:16px auto 0;background:#fff;color:#1B2C5B;text-decoration:none">Call ${COMPANY.phone}</a>
    <div style="margin-top:20px;font-size:14px">
      Questions? Call <a href="tel:${COMPANY.phoneRaw}" style="color:#fff;font-weight:700">${COMPANY.phone}</a>
    </div>
  </div>` : `
  <div class="final">
    <h2>${commercialRiskType || commercialLowConfidence ? 'Your account manager will finalize this' : 'Inspection required to finish this quote'}</h2>
    <p>${commercialRiskType
      ? 'This is a commercial service plan. Your Waves account manager will confirm the details with you and finalize it directly, so there’s no online checkout for this one.'
      : commercialLowConfidence
      ? 'We just need a quick site confirmation to finalize this commercial estimate. Your Waves account manager will confirm the price with you directly, so there’s no online checkout for this one.'
      : escapeHtml(quoteDisplayReason || 'This treatment needs a field review before we can finalize pricing or book it online.')}</p>
    <a href="tel:${COMPANY.phoneRaw}" class="cta" style="display:inline-block;max-width:360px;margin:16px auto 0;background:#fff;color:#1B2C5B;text-decoration:none">Call ${COMPANY.phone}</a>
    <div style="margin-top:20px;font-size:14px">
      Questions? Call <a href="tel:${COMPANY.phoneRaw}" style="color:#fff;font-weight:700">${COMPANY.phone}</a>
    </div>
  </div>`) : `
  <div class="final">
    <h2${isOneTimeOnly ? '' : ' data-mode-only="recurring"'}>${escapeHtml(isOneTimeOnly ? 'Ready to book?' : pageCopy.finalHeading)}</h2>
    ${pageCopy.finalSubhead && !isOneTimeOnly ? `<div class="final-subhead" data-mode-only="recurring">${escapeHtml(pageCopy.finalSubhead)}</div>` : ''}
    ${canChooseOneTime ? `<h2 data-mode-only="one_time" hidden>Go Waves! Wave Goodbye to Pests!</h2>` : ''}
    ${pageCopy.finalBody ? `<p>${escapeHtml(pageCopy.finalBody)}</p>` : ''}
    ${locked ? '' : `<button type="button" class="cta pick-time-cta" style="max-width:360px;margin:16px auto 0;background:#fff;color:#1B2C5B">${commercialManualAccept ? 'Approve estimate' : 'Pick a time and book'}</button>`}
    <div style="margin-top:20px;font-size:14px">
      Questions? Call <a href="tel:${COMPANY.phoneRaw}" style="color:#fff;font-weight:700">${COMPANY.phone}</a>
    </div>
  </div>`}

  <footer class="site-footer">
    <div class="site-footer-socials">${socialsHtml}</div>
    <div class="site-footer-contact">
      <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>
      <span class="dot">&middot;</span>
      <a href="tel:${COMPANY.phoneRaw}">${COMPANY.phone}</a>
    </div>
    <div class="site-footer-legal">&copy; ${new Date().getFullYear()} ${COMPANY.legalName}. All rights reserved.</div>
  </footer>
</div>

<div id="toast"></div>

${shellQuestionsBar()}

<script>
  const TOKEN = ${JSON.stringify(token)};
  const API = '/api/estimates/' + TOKEN;
  const DEPOSIT_POLICY = ${JSON.stringify(est.depositPolicy || { enforced: false, required: false })};
  const ESTIMATE_ASK_TOKEN = ${JSON.stringify(estimateAskToken)};
  const DEFAULT_RECURRING_FREQUENCY = ${JSON.stringify(selectedRecurringFrequencyKey)};
  const INITIAL_SERVICE_MODE = ${JSON.stringify(isOneTimeOnly ? 'one_time' : 'recurring')};
  const REQUIRE_PAYMENT_SETUP_BEFORE_SLOTS = ${JSON.stringify(requirePaymentSetupBeforeSlots)};
  const BILLING_INTERVAL_MONTHS = ${JSON.stringify(billingIntervalMonthsForFrequencyKey(selectedRecurringFrequencyKey))};
  const PRICE_PERIOD_WORD = ${JSON.stringify(recurringPricePeriodWord)};
  const REVIEW_FALLBACKS = ${JSON.stringify(reviewFallbacks)};
  const RECURRING_PAY_PREF_HEADING = ${JSON.stringify(pageCopy.payPrefHeading)};
  const BOOKING_TITLE = ${JSON.stringify(pageCopy.bookingTitle)};
  const BOOKING_SUBHEAD = ${JSON.stringify(pageCopy.bookingSubhead)};
  const CARD_CONFIRM_TITLE = ${JSON.stringify(pageCopy.cardConfirmTitle)};
  const CARD_CONFIRM_SUB = ${JSON.stringify(pageCopy.cardConfirmSub)};
  const ANNUAL_PREPAY_INVOICE_TOTAL = ${JSON.stringify(prepayInvoiceTotal)};
  const STANDARD_INVOICE_SETUP_DUE = ${JSON.stringify(setupDueToday)};
  const STANDARD_INVOICE_HAS_FIRST_APPLICATION = ${JSON.stringify(standardInvoiceCopy.hasFirstApplication)};
  const STANDARD_NO_PAYMENT_COPY = ${JSON.stringify(pageCopy.noPaymentCopy)};
  const fmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const roundMoney = (n) => Math.round(Number(n || 0) * 100) / 100;
  const intervalPrice = (monthly) => Math.round(Number(monthly || 0) * BILLING_INTERVAL_MONTHS * 100) / 100;
  const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); };
  // Subtle click pulse on any button — fires once per click, self-removes after animation
  document.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : ev.target?.parentElement;
    if (!target) return;
    const btn = target.closest('button, .cta, .upsell, .review-card-link');
    if (!btn || btn.disabled) return;
    btn.classList.remove('is-click-pulse');
    void btn.offsetWidth;
    btn.classList.add('is-click-pulse');
    setTimeout(() => btn.classList.remove('is-click-pulse'), 240);
  });
  const refreshBillingAmounts = (monthlyTotal, annualTotal, prefMonthlyOff) => {
    const monthly = Number(monthlyTotal || 0);
    const annual = Number.isFinite(Number(annualTotal))
      ? Number(annualTotal)
      : Math.round(monthly * 12 * 100) / 100;
    const prefOff = Number(prefMonthlyOff || 0);
    document.querySelectorAll('[data-annual-total]').forEach((el) => {
      el.textContent = fmt(annual);
    });
    document.querySelectorAll('[data-prepay-invoice-total]').forEach((el) => {
      const discountRate = Number(el.dataset.prepayDiscountRate || 0);
      const invoiceTotal = Math.max(0, Math.round(annual * (1 - discountRate) * 100) / 100);
      el.textContent = fmt(invoiceTotal);
    });
    document.querySelectorAll('[data-prepay-copy-total]').forEach((el) => {
      const discountRate = Number(el.dataset.prepayDiscountRate || 0);
      const invoiceTotal = Math.max(0, Math.round(annual * (1 - discountRate) * 100) / 100);
      el.textContent = fmt(invoiceTotal);
    });
    let firstVisitTotal = 0;
    document.querySelectorAll('[data-service-card-price]').forEach((el) => {
      const base = Number(el.dataset.serviceBasePrice || 0);
      const visits = Number(el.dataset.serviceVisits || 0);
      if (!(base > 0)) return;
      const discount = el.dataset.serviceKind === 'pest' && visits > 0
        ? (prefOff * 12) / visits
        : 0;
      const adjusted = Math.max(0, Math.round((base - discount) * 100) / 100);
      firstVisitTotal = Math.round((firstVisitTotal + adjusted) * 100) / 100;
      el.textContent = fmt(adjusted);
    });
    document.querySelectorAll('[data-first-visit-total]').forEach((el) => {
      if (firstVisitTotal > 0) {
        el.textContent = fmt(firstVisitTotal);
        el.dataset.firstVisitAmount = String(firstVisitTotal);
      }
    });
    document.querySelectorAll('[data-standard-invoice-total]').forEach((el) => {
      const setupDue = Number(el.dataset.standardSetupDue || 0);
      const invoiceFirstVisitTotal = STANDARD_INVOICE_HAS_FIRST_APPLICATION && firstVisitTotal > 0 ? firstVisitTotal : 0;
      const invoiceTotal = roundMoney(setupDue + invoiceFirstVisitTotal);
      if (invoiceTotal > 0) el.textContent = fmt(invoiceTotal);
    });
    document.querySelectorAll('[data-standard-invoice-copy-total]').forEach((el) => {
      const setupDue = Number(el.dataset.standardSetupDue || 0);
      const invoiceFirstVisitTotal = STANDARD_INVOICE_HAS_FIRST_APPLICATION && firstVisitTotal > 0 ? firstVisitTotal : 0;
      const invoiceTotal = roundMoney(setupDue + invoiceFirstVisitTotal);
      if (invoiceTotal > 0) el.textContent = fmt(invoiceTotal);
    });
    document.querySelectorAll('[data-service-card-savings]').forEach((el) => {
      const base = Number(el.dataset.serviceBasePrice || 0);
      const anchor = Number(el.dataset.serviceAnchorPrice || 0);
      const visits = Number(el.dataset.serviceVisits || 0);
      if (!(base > 0) || !(anchor > 0)) return;
      const discount = el.dataset.serviceKind === 'pest' && visits > 0
        ? (prefOff * 12) / visits
        : 0;
      const adjusted = Math.max(0, Math.round((base - discount) * 100) / 100);
      el.textContent = fmt(Math.max(0, Math.round((anchor - adjusted) * 100) / 100));
    });
    document.querySelectorAll('[data-service-card-day]').forEach((el) => {
      const base = Number(el.dataset.serviceBasePrice || 0);
      const visits = Number(el.dataset.serviceVisits || 0);
      if (!(base > 0) || !(visits > 0)) return;
      const discount = el.dataset.serviceKind === 'pest'
        ? (prefOff * 12) / visits
        : 0;
      const adjusted = Math.max(0, Math.round((base - discount) * 100) / 100);
      el.textContent = fmt(Math.round((adjusted * visits / 365) * 100) / 100);
    });
  };

  document.querySelectorAll('.ai-satellite').forEach((img) => {
    const hideIfBroken = () => { if (!img.naturalWidth) img.hidden = true; };
    img.addEventListener('error', hideIfBroken);
    setTimeout(hideIfBroken, 1200);
  });

  const estimateAskForm = document.getElementById('estimate-ask-form');
  const estimateAskInput = document.getElementById('estimate-ask-input');
  const estimateAskSubmit = document.getElementById('estimate-ask-submit');
  const estimateAskAnswer = document.getElementById('estimate-ask-answer');
  async function submitEstimateQuestion(promptText) {
    if (!estimateAskInput || !estimateAskSubmit || !estimateAskAnswer) return;
    const q = String(promptText || estimateAskInput.value || '').trim();
    if (!q) return;
    estimateAskSubmit.disabled = true;
    estimateAskSubmit.textContent = 'Asking...';
    estimateAskAnswer.hidden = false;
    estimateAskAnswer.dataset.state = 'loading';
    estimateAskAnswer.textContent = 'Checking...';
    try {
      const r = await fetch('/api/public/estimates/' + TOKEN + '/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Estimate-Ask-Token': ESTIMATE_ASK_TOKEN },
        body: JSON.stringify({
          question: q,
          selectedFrequency: DEFAULT_RECURRING_FREQUENCY,
          serviceMode: bookingState.serviceMode || INITIAL_SERVICE_MODE,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'question_failed');
      estimateAskAnswer.dataset.state = 'ready';
      estimateAskAnswer.textContent = data.answer || 'I could not answer that from this estimate.';
      estimateAskInput.value = '';
    } catch (e) {
      estimateAskAnswer.dataset.state = 'error';
      estimateAskAnswer.textContent = 'I could not answer that right now. Call or text Waves at (941) 297-5749.';
    } finally {
      estimateAskSubmit.disabled = false;
      estimateAskSubmit.textContent = 'Ask';
    }
  }
  if (estimateAskForm) {
    estimateAskForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitEstimateQuestion();
    });
  }
  document.querySelectorAll('[data-estimate-ask-prompt]').forEach((btn) => {
    btn.addEventListener('click', function () {
      const prompt = btn.dataset.estimateAskPrompt || btn.textContent || '';
      if (estimateAskInput) estimateAskInput.value = prompt;
      submitEstimateQuestion(prompt);
    });
  });

  // Service-preferences toggles — PUT /:token/preferences and refresh totals.
  document.querySelectorAll('[data-pref-key]').forEach((input) => {
    input.addEventListener('change', async (ev) => {
      const key = ev.target.dataset.prefKey;
      const next = !!ev.target.checked;
      ev.target.disabled = true;
      try {
        const r = await fetch(API + '/preferences', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: next }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed');
        const monthlyDisplay = document.getElementById('monthly-display');
        if (monthlyDisplay) monthlyDisplay.textContent = fmt(intervalPrice(data.monthlyTotal));
        refreshBillingAmounts(data.monthlyTotal, data.annualTotal, data.prefMonthlyOff);
        document.querySelectorAll('[data-monthly-echo]').forEach(el => el.textContent = fmt(intervalPrice(data.monthlyTotal)));
        if (data.onetimeTotal != null) {
          const oneTimeDisplay = document.getElementById('onetime-display');
          if (oneTimeDisplay) oneTimeDisplay.textContent = fmt(data.onetimeTotal);
          document.querySelectorAll('[data-onetime-echo]').forEach(el => el.textContent = fmt(data.onetimeTotal));
        }
        const dayEl = document.getElementById('day-price'); if (dayEl) dayEl.textContent = fmt(Math.round((data.monthlyTotal * 12 / 365) * 100) / 100);
        if (data.tierPrices) {
          document.querySelectorAll('[data-price-for]').forEach((pel) => {
            const t = pel.dataset.priceFor;
            if (data.tierPrices[t] != null) pel.innerHTML = fmt(intervalPrice(data.tierPrices[t])) + '<span class="per">' + PRICE_PERIOD_WORD + '</span>';
          });
        }
        const anchor = document.getElementById('anchor-display');
        const saveRow = document.querySelector('[data-aggregate-save-row]');
        const savingsEl = document.getElementById('savings-display');
        if (anchor || saveRow || savingsEl) {
          if (data.savingsPerMo > 0) {
            if (saveRow) saveRow.style.display = '';
            if (savingsEl) savingsEl.textContent = fmt(intervalPrice(data.savingsPerMo));
            if (anchor) anchor.textContent = fmt(intervalPrice(data.baseMonthly)) + ' / ' + PRICE_PERIOD_WORD;
          } else if (saveRow) {
            saveRow.style.display = 'none';
          }
        }
        const row = ev.target.closest('[data-pref-row]');
        if (row) {
          row.classList.toggle('off', !next);
          const desc = row.querySelector('[data-pref-desc]');
          const sav = row.querySelector('[data-pref-savings]');
          if (desc && data.prefMeta && data.prefMeta[key]) {
            desc.textContent = next ? 'Toggle off if you want to skip this.' : data.prefMeta[key].offDesc;
          }
          if (sav && data.prefMeta && data.prefMeta[key]) {
            sav.classList.toggle('none', !next);
            sav.textContent = next ? data.prefMeta[key].savingsLabel : 'Applied to your estimate';
          }
        }
        toast(next ? 'Added back to your plan' : 'Removed — price updated');
      } catch (e) {
        ev.target.checked = !next;
        toast('Could not update. Try again.');
      } finally {
        ev.target.disabled = false;
      }
    });
  });

  // ── Booking flow: slots → reserve → confirm+accept ───────────
  // Shared state for the booking card. Each step transitions the visible
  // sub-section. Reservation auto-expires server-side after 15 min; the
  // client countdown is cosmetic but matches the backend hold.
  const EXISTING_APPOINTMENT_ID = ${JSON.stringify(existingAppointment?.id || null)};
  const bookingState = {
    selectedSlotId: null,
    selectedSlotLabel: null,
    pendingPref: null,
    pickedPref: null,
    reservation: null,
    isReserving: false,
    countdownTimer: null,
    serviceMode: INITIAL_SERVICE_MODE,
    reserveAttemptId: 0,
  };

  function bookingRequiresPaymentSetup() {
    return REQUIRE_PAYMENT_SETUP_BEFORE_SLOTS && bookingState.serviceMode !== 'one_time';
  }

  function buildSlotContext() {
    const context = { serviceMode: bookingState.serviceMode || INITIAL_SERVICE_MODE };
    if (context.serviceMode === 'recurring' && DEFAULT_RECURRING_FREQUENCY) {
      context.selectedFrequency = DEFAULT_RECURRING_FREQUENCY;
    }
    return context;
  }

  function syncPaymentSetupCards() {
    document.querySelectorAll('[data-payment-setup]').forEach((btn) => {
      const selected = bookingState.pendingPref === btn.dataset.paymentSetup;
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      btn.disabled = bookingState.isReserving || !!bookingState.reservation;
      const card = btn.closest('.payment-choice');
      if (card) card.classList.toggle('is-selected', selected);
    });
  }

  function setBookingChoiceControlsDisabled(disabled) {
    document.querySelectorAll('[data-pay-pref], .slot-btn').forEach((b) => { b.disabled = !!disabled; });
  }

  function currentAnnualPrepayInvoiceText() {
    const el = document.querySelector('[data-prepay-invoice-total]');
    const text = el && String(el.textContent || '').trim();
    return text || fmt(ANNUAL_PREPAY_INVOICE_TOTAL);
  }

  function firstVisitTotalText() {
    const el = document.querySelector('[data-first-visit-total]');
    const text = el && String(el.textContent || '').trim();
    return text || 'after completion';
  }

  function currentFirstVisitAmount() {
    if (!STANDARD_INVOICE_HAS_FIRST_APPLICATION) return 0;
    const el = document.querySelector('[data-first-visit-total]');
    const amount = Number(el?.dataset?.firstVisitAmount || 0);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }

  function currentStandardInvoiceTotal() {
    return roundMoney(Number(STANDARD_INVOICE_SETUP_DUE || 0) + currentFirstVisitAmount());
  }

  function standardInvoiceTotalText() {
    const total = currentStandardInvoiceTotal();
    return total > 0 ? fmt(total) : 'after completion';
  }

  function standardPayPerApplicationSummaryBody() {
    const setupDue = Number(STANDARD_INVOICE_SETUP_DUE || 0);
    const hasSetup = setupDue > 0;
    const hasFirstApplication = STANDARD_INVOICE_HAS_FIRST_APPLICATION && currentFirstVisitAmount() > 0;
    if (hasSetup && hasFirstApplication) {
      return 'No payment is charged here. After confirmation, we open an invoice for setup plus the first application totaling ' + standardInvoiceTotalText() + '; choose a service window to continue.';
    }
    if (hasSetup) {
      return 'No payment is charged here. After confirmation, we open the setup invoice for ' + fmt(setupDue) + '; choose a service window to continue.';
    }
    if (hasFirstApplication) {
      return 'No payment is charged here. After confirmation, we open the first application invoice for ' + firstVisitTotalText() + '; choose a service window to continue.';
    }
    return STANDARD_NO_PAYMENT_COPY + ' Choose a service window to continue.';
  }

  function updatePaymentSetupSummary(pref) {
    const summary = document.getElementById('payment-setup-summary');
    if (!summary) return;
    const bookingTitle = document.getElementById('booking-title');
    const bookingSubhead = document.querySelector('#booking-card > .card-sub');
    const title = document.getElementById('payment-setup-summary-title');
    const body = document.getElementById('payment-setup-summary-body');
    if (bookingTitle) bookingTitle.textContent = 'Review your invoice setup';
    if (pref === 'prepay_annual') {
      if (bookingSubhead) bookingSubhead.textContent = 'Annual prepay is selected. Review the invoice setup, then choose a service window.';
      if (title) title.textContent = 'Annual prepay invoice';
      if (body) body.textContent = 'No payment is charged here. Your annual prepay invoice for ' + currentAnnualPrepayInvoiceText() + ' is sent automatically after confirmation; choose a service window to continue.';
    } else {
      if (bookingSubhead) bookingSubhead.textContent = 'Pay per application is selected. Review the invoice setup, then choose a service window.';
      if (title) title.textContent = 'Pay per application';
      if (body) body.textContent = standardPayPerApplicationSummaryBody();
    }
    summary.style.display = '';
    if (location.hash !== '#invoice-setup') {
      history.pushState(null, '', '#invoice-setup');
    }
  }

  function resetPaymentSetupSummary() {
    const summary = document.getElementById('payment-setup-summary');
    if (summary) summary.style.display = 'none';
    const bookingTitle = document.getElementById('booking-title');
    const bookingSubhead = document.querySelector('#booking-card > .card-sub');
    if (bookingTitle) bookingTitle.textContent = BOOKING_TITLE;
    if (bookingSubhead) bookingSubhead.textContent = BOOKING_SUBHEAD;
  }

  function returnToPaymentSetupChoices() {
    bookingState.pendingPref = null;
    bookingState.pickedPref = null;
    syncPaymentSetupCards();
    resetPaymentSetupSummary();
    const setupCard = document.getElementById('payment-setup-card');
    if (setupCard) {
      setupCard.style.display = '';
      try { setupCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      catch (e) { setupCard.scrollIntoView(true); }
    }
    if (!EXISTING_APPOINTMENT_ID && bookingRequiresPaymentSetup()) {
      hideBookingCardUntilSetup();
    }
  }

  function ensureBookingCardVisible() {
    // Commercial estimates render an approval card (no slots) in place of the
    // booking card — fall back to it so the hero CTA still scrolls somewhere.
    const target = document.getElementById('booking-card') || document.getElementById('commercial-accept-card');
    if (!target) return null;
    target.style.display = '';
    if (target.id === 'booking-card' && target.dataset.slotsLoaded !== 'true') {
      target.dataset.slotsLoaded = 'true';
      loadSlots();
    }
    return target;
  }

  function scrollToBookingCard() {
    const target = ensureBookingCardVisible();
    if (!target) return;
    try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (e) { target.scrollIntoView(true); }
    target.animate([
      { boxShadow: '0 0 0 0 rgba(27,44,91,0)' },
      { boxShadow: '0 0 0 6px rgba(27,44,91,.16)' },
      { boxShadow: '0 0 0 0 rgba(27,44,91,0)' },
    ], { duration: 900, easing: 'ease-out' });
  }

  function hideBookingCardUntilSetup() {
    if (!bookingRequiresPaymentSetup()) return;
    const target = document.getElementById('booking-card');
    if (!target) return;
    target.style.display = 'none';
    target.dataset.slotsLoaded = 'false';
  }

  function choosePaymentSetup(pref) {
    if (bookingState.isReserving) {
      toast('Hold on while we reserve that time.');
      return;
    }
    if (bookingState.reservation) {
      toast('Use Change my pick before switching payment option.');
      const reviewArea = document.getElementById('review-area');
      if (reviewArea) reviewArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    bookingState.pendingPref = pref;
    bookingState.pickedPref = null;
    syncPaymentSetupCards();
    updatePaymentSetupSummary(pref);
    const setupCard = document.getElementById('payment-setup-card');
    if (setupCard) setupCard.style.display = 'none';
    if (EXISTING_APPOINTMENT_ID) {
      pickExistingAppointmentPref(pref);
      return;
    }
    scrollToBookingCard();
    if (bookingState.selectedSlotId) {
      pickPaymentPref(pref);
    } else {
      toast(pref === 'prepay_annual' ? 'Annual prepay selected. Pick a time to continue.' : 'Pay at the visit selected. Pick a time to continue.');
    }
  }

  // Recurring/one-time inline toggle. Swaps visibility of [data-mode-only]
  // elements (hero price block, perks card, final CTA copy) and stamps
  // bookingState.serviceMode so the next /reserve and /accept calls
  // include it in their bodies.
  function setServiceMode(mode) {
    if (mode !== 'recurring' && mode !== 'one_time') return;
    if (bookingState.isReserving) {
      toast('Hold on while we reserve that time.');
      return;
    }
    const changed = bookingState.serviceMode !== mode;
    bookingState.serviceMode = mode;
    document.querySelectorAll('[data-mode-only]').forEach((el) => {
      el.hidden = el.dataset.modeOnly !== mode;
    });
    document.querySelectorAll('[data-mode-set]').forEach((btn) => {
      const on = btn.dataset.modeSet === mode;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    syncPaymentMode();
    if (changed && bookingState.reservation) {
      cancelReservation();
    } else if (changed) {
      bookingState.reserveAttemptId += 1;
      bookingState.isReserving = false;
      bookingState.pendingPref = null;
      bookingState.pickedPref = null;
      bookingState.selectedSlotId = null;
      bookingState.selectedSlotLabel = null;
      const bookingCard = document.getElementById('booking-card');
      if (bookingCard) bookingCard.dataset.slotsLoaded = 'false';
      syncPaymentSetupCards();
      setBookingChoiceControlsDisabled(false);
      if (bookingRequiresPaymentSetup()) {
        const setupCard = document.getElementById('payment-setup-card');
        if (setupCard) setupCard.style.display = '';
        resetPaymentSetupSummary();
        hideBookingCardUntilSetup();
      } else {
        ensureBookingCardVisible();
      }
      document.querySelectorAll('[data-pay-pref]').forEach((b) => { b.disabled = false; });
    }
  }
  document.querySelectorAll('[data-mode-set]').forEach((btn) => {
    btn.addEventListener('click', () => setServiceMode(btn.dataset.modeSet));
  });

  function syncPaymentMode() {
    const isOneTime = bookingState.serviceMode === 'one_time';
    const cardBtn = document.querySelector('[data-pay-pref-card]');
    const visitBtn = document.querySelector('[data-pay-pref-visit]');
    const prepayBtn = document.querySelector('[data-pay-pref-prepay]');
    const heading = document.getElementById('pay-pref-heading');
    const subhead = document.getElementById('pay-pref-subhead');
    const visitTitle = document.querySelector('[data-pay-visit-title]');
    const visitSub = document.querySelector('[data-pay-visit-sub]');
    if (cardBtn) {
      cardBtn.hidden = isOneTime;
      cardBtn.classList.toggle('primary', !isOneTime);
    }
    if (visitBtn) {
      visitBtn.hidden = !isOneTime;
      visitBtn.classList.toggle('primary', isOneTime);
    }
    if (prepayBtn) {
      prepayBtn.hidden = isOneTime;
    }
    [cardBtn, visitBtn, prepayBtn].forEach((btn) => {
      const choice = btn && btn.closest('.pay-pref-choice');
      if (choice) choice.hidden = !!btn.hidden;
    });
    if (heading) heading.textContent = isOneTime ? 'Book your visit' : RECURRING_PAY_PREF_HEADING;
    if (subhead) {
      subhead.textContent = isOneTime
        ? 'This books a single visit. You will not be charged today.'
        : ${JSON.stringify(billingLede)};
    }
    if (visitTitle) visitTitle.textContent = isOneTime ? 'Book + pay on service day' : 'Pay at the visit';
    if (visitSub) {
      visitSub.textContent = isOneTime
        ? 'We will collect payment with the tech on-site. No card needed now.'
        : 'We will collect payment with the tech on-site. No card needed now.';
    }
    syncPaymentSetupCards();
  }
  syncPaymentMode();

  function fmtSlotDay(dateStr) {
    try {
      const d = new Date(dateStr + 'T12:00:00');
      return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    } catch { return dateStr; }
  }
  function fmtSlotTime(start) {
    const fmt = (t) => {
      if (!t) return '';
      const [h, m] = String(t).split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    };
    return fmt(start);
  }
  function slotReason(s) {
    if (s.routeOptimal) {
      return s.techFirstName
        ? s.techFirstName + ' will already be nearby.'
        : 'We\\'ll already be nearby.';
    }
    return 'Open route window for your area.';
  }

  function renderSlot(s) {
    const day = fmtSlotDay(s.date);
    const start = fmtSlotTime(s.windowStart);
    const reason = slotReason(s);
    return '<button type="button" class="slot-btn" data-slot-id="' + s.slotId + '" data-slot-label="' + day + ' at ' + start + '">'
      + '<span class="slot-day">' + day + '</span>'
      + '<span class="slot-time">' + start + '</span>'
      + '<span class="slot-reason">' + reason + '</span>'
      + '</button>';
  }

  function attachSlotHandlers(container) {
    if (!container) return;
    container.querySelectorAll('.slot-btn').forEach((btn) => btn.addEventListener('click', () => selectSlot(btn)));
  }
  function renderSlotsHtml(slots) {
    const html = ['<div class="slot-list">'];
    slots.forEach((s) => html.push(renderSlot(s)));
    html.push('</div>');
    return html.join('');
  }

  // Commercial estimates have no bookable slot — approve directly (no slot, no
  // card, no deposit). The server marks it accepted, writes the non-member
  // 'Commercial' tier, skips auto-scheduling, and notifies the team to schedule
  // + invoice manually. 'prepay' bills the year upfront at the 5% prepay
  // discount (the server creates the prepay invoice; no setup fee on commercial).
  async function approveCommercialManual(mode) {
    const isPrepay = mode === 'prepay';
    const btns = [document.getElementById('commercial-approve-btn'), document.getElementById('commercial-prepay-btn')];
    const note = document.getElementById('commercial-approve-note');
    btns.forEach((b) => { if (b) b.disabled = true; });
    try {
      const payload = { serviceMode: 'recurring' };
      if (isPrepay) payload.paymentMethodPreference = 'prepay_annual';
      const r = await fetch(API + '/accept', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 409) {
        toast('This estimate is no longer active.');
        setTimeout(() => location.reload(), 900);
        return;
      }
      if (!r.ok) throw new Error((data && data.error) || 'approve failed');
      toast('Approved! A Waves account manager will reach out to schedule your commercial service.');
      if (note) {
        note.style.display = '';
        note.textContent = isPrepay
          ? 'Approved \\u2014 your annual prepay invoice is on its way, and we\\'ll be in touch to schedule.'
          : 'Approved \\u2014 we\\'ll be in touch shortly to schedule and invoice.';
      }
      setTimeout(() => location.reload(), 1400);
    } catch (e) {
      toast('Could not approve right now. Call ${COMPANY.phone} and we will get you set up.');
      btns.forEach((b) => { if (b) b.disabled = false; });
    }
  }

  async function loadSlots() {
    const area = document.getElementById('slot-area');
    if (!area) return;
    try {
      const slotContext = buildSlotContext();
      const slotParams = new URLSearchParams();
      slotParams.set('serviceMode', slotContext.serviceMode);
      slotParams.set('windowDays', '14');
      if (slotContext.selectedFrequency) {
        slotParams.set('selectedFrequency', slotContext.selectedFrequency);
      }
      const slotUrl = '/api/public/estimates/' + TOKEN + '/available-slots?' + slotParams.toString();
      const r = await fetch(slotUrl);
      if (!r.ok) throw new Error('slot fetch failed');
      const body = await r.json();
      const primary = body.primary || [];
      const expander = body.expander || [];
      const allSlots = primary.concat(expander);
      const slots = allSlots.slice(0, 6);
      const moreSlots = allSlots.slice(6, 9);
      if (!slots.length) {
        area.className = 'booking-state';
        area.innerHTML = 'No times available in the next 14 days. <a href="tel:${COMPANY.phoneRaw}" style="color:#1B2C5B;font-weight:600">Call ${COMPANY.phone}</a> and we\\'ll get you on the schedule.';
        return;
      }
      area.className = '';
      const html = [];
      html.push('<div class="slot-list">');
      slots.forEach((s) => html.push(renderSlot(s)));
      html.push('</div>');
      if (moreSlots.length) {
        html.push('<details class="slot-more"><summary>Show ' + moreSlots.length + ' more open slot' + (moreSlots.length === 1 ? '' : 's') + '</summary><div class="slot-more-list">');
        moreSlots.forEach((s) => html.push(renderSlot(s)));
        html.push('</div></details>');
      }
      area.innerHTML = html.join('');
      attachSlotHandlers(area);
    } catch (e) {
      area.className = 'booking-state';
      area.innerHTML = 'Could not load times right now. <a href="tel:${COMPANY.phoneRaw}" style="color:#1B2C5B;font-weight:600">Call ${COMPANY.phone}</a> and we will get you scheduled.';
    }
  }

  // ── Waves AI date/time finder (search + specific-date pick) ──
  function renderFinderResults(body) {
    const area = document.getElementById("finder-area");
    if (!area) return;
    const primary = (body && body.primary) || [];
    const expander = (body && body.expander) || [];
    const all = primary.concat(expander);
    if (!all.length) {
      area.innerHTML = '<div class="booking-state">No open times then. <a href="tel:${COMPANY.phoneRaw}" style="color:#1B2C5B;font-weight:600">Call ${COMPANY.phone}</a> and we\\'ll fit you in.</div>';
      return;
    }
    const nearby = (body && typeof body.nearby === 'boolean') ? body.nearby : all.some(function (s) { return s.routeOptimal; });
    const soft = nearby ? '' : '<div class="finder-soft">No route near you that day yet — here\\'s what\\'s close.</div>';
    area.innerHTML = soft + renderSlotsHtml(all);
    attachSlotHandlers(area);
  }

  async function runAiWhenSearch() {
    const input = document.getElementById("ai-when-input");
    const btn = document.getElementById("ai-when-btn");
    const summary = document.getElementById("ai-when-summary");
    const query = input ? String(input.value || "").trim() : "";
    if (!query) return;
    if (btn) { btn.disabled = true; btn.textContent = "Searching…"; }
    if (summary) { summary.style.display = ""; summary.textContent = "Checking the route map…"; }
    try {
      const ctx = buildSlotContext();
      const r = await fetch("/api/public/estimates/" + TOKEN + "/find-slots", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Estimate-Ask-Token": ESTIMATE_ASK_TOKEN },
        body: JSON.stringify({ query: query, serviceMode: ctx.serviceMode, selectedFrequency: ctx.selectedFrequency }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error((body && body.error) || "search failed");
      if (summary) summary.textContent = body.summary || "";
      const datePick = document.getElementById("date-pick-input");
      if (datePick) datePick.value = "";
      renderFinderResults(body);
    } catch (e) {
      if (summary) summary.textContent = "Could not search just now. Call ${COMPANY.phone} and we will help.";
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Search"; }
    }
  }

  async function pickFinderDate(date) {
    if (!date) return;
    const summary = document.getElementById("ai-when-summary");
    const area = document.getElementById("finder-area");
    if (area) area.innerHTML = '<div class="booking-state">Loading times…</div>';
    if (summary) summary.style.display = "none";
    try {
      const ctx = buildSlotContext();
      const params = new URLSearchParams();
      params.set("serviceMode", ctx.serviceMode);
      if (ctx.selectedFrequency) params.set("selectedFrequency", ctx.selectedFrequency);
      params.set("date", date);
      const r = await fetch("/api/public/estimates/" + TOKEN + "/available-slots?" + params.toString());
      const body = await r.json();
      if (!r.ok) throw new Error("slot fetch failed");
      const aiInput = document.getElementById("ai-when-input");
      if (aiInput) aiInput.value = "";
      renderFinderResults(body);
    } catch (e) {
      if (area) area.innerHTML = '<div class="booking-state">Could not load that day. Call ${COMPANY.phone}.</div>';
    }
  }

  function initDateFinder() {
    const btn = document.getElementById("ai-when-btn");
    const input = document.getElementById("ai-when-input");
    const datePick = document.getElementById("date-pick-input");
    if (btn) btn.addEventListener("click", runAiWhenSearch);
    if (input) input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runAiWhenSearch(); } });
    if (datePick) {
      const pad = function (n) { return n < 10 ? "0" + n : "" + n; };
      const toStr = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
      const today = new Date();
      const max = new Date(); max.setDate(max.getDate() + 90);
      datePick.min = toStr(today);
      datePick.max = toStr(max);
      datePick.addEventListener("change", function () { pickFinderDate(datePick.value); });
    }
  }

  function selectSlot(btn) {
    if (bookingState.isReserving) {
      toast('Hold on while we reserve that time.');
      return;
    }
    document.querySelectorAll('.slot-btn').forEach((el) => el.classList.remove('selected'));
    btn.classList.add('selected');
    bookingState.selectedSlotId = btn.dataset.slotId;
    bookingState.selectedSlotLabel = btn.dataset.slotLabel;
    if (bookingState.pendingPref && bookingState.serviceMode === 'recurring') {
      pickPaymentPref(bookingState.pendingPref);
      return;
    }
    const payArea = document.getElementById('pay-pref-area');
    if (payArea) {
      payArea.style.display = '';
      payArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function pickPaymentPref(pref) {
    if (bookingState.isReserving) {
      toast('Hold on while we reserve that time.');
      return;
    }
    if (!bookingState.selectedSlotId) {
      toast('Pick a time first.');
      return;
    }
    if (bookingState.serviceMode === 'one_time') {
      pref = 'pay_at_visit';
    }
    const attemptId = bookingState.reserveAttemptId + 1;
    bookingState.reserveAttemptId = attemptId;
    bookingState.isReserving = true;
    bookingState.pendingPref = pref;
    bookingState.pickedPref = pref;
    syncPaymentSetupCards();
    setBookingChoiceControlsDisabled(true);
    try {
      const reservePayload = buildSlotContext();
      reservePayload.slotId = bookingState.selectedSlotId;
      const r = await fetch('/api/public/estimates/' + TOKEN + '/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reservePayload),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        if (attemptId !== bookingState.reserveAttemptId || bookingState.reservation) return;
        const message = data.error || 'Could not reserve this slot.';
        if (/slot no longer available/i.test(message)) {
          toast('That slot was just taken. Pick another.');
          loadSlots();
        } else {
          toast(message);
          if (/estimate is no longer active/i.test(message)) {
            setTimeout(() => location.reload(), 900);
          }
        }
        bookingState.isReserving = false;
        setBookingChoiceControlsDisabled(false);
        bookingState.pendingPref = null;
        bookingState.pickedPref = null;
        syncPaymentSetupCards();
        return;
      }
      if (!r.ok) throw new Error('reserve failed');
      const body = await r.json();
      if (attemptId !== bookingState.reserveAttemptId) {
        if (body.scheduledServiceId) {
          fetch('/api/public/estimates/' + TOKEN + '/reserve/' + encodeURIComponent(body.scheduledServiceId), { method: 'DELETE' }).catch(function () {});
        }
        return;
      }
      bookingState.isReserving = false;
      bookingState.reservation = { scheduledServiceId: body.scheduledServiceId, expiresAt: body.expiresAt };
      syncPaymentSetupCards();
      // Swap UI: hide slot list + pay pref, show review
      resetPaymentSetupSummary();
      document.getElementById('slot-area').style.display = 'none';
      document.getElementById('pay-pref-area').style.display = 'none';
      const reviewArea = document.getElementById('review-area');
      reviewArea.style.display = '';
      const confirmBtn = document.getElementById('confirm-book-btn');
      if (confirmBtn) confirmBtn.disabled = false;
      const title = document.getElementById('confirm-book-title');
      const sub = document.getElementById('confirm-book-sub');
    if (pref === 'pay_at_visit' && bookingState.serviceMode === 'recurring') {
      if (title) title.textContent = CARD_CONFIRM_TITLE;
      if (sub) sub.textContent = (bookingState.selectedSlotLabel || 'Your slot') + ' · ' + CARD_CONFIRM_SUB;
    } else if (pref === 'prepay_annual') {
      if (title) title.textContent = 'Confirm annual prepay';
      if (sub) sub.textContent = (bookingState.selectedSlotLabel || 'Your slot') + ' · annual prepay invoice for ' + currentAnnualPrepayInvoiceText() + ' will be available for optional payment after confirmation.';
      } else {
        if (title) title.textContent = 'Confirm and book';
        if (sub) sub.textContent = (bookingState.selectedSlotLabel || 'Your slot') + ' · pay at the visit, no card needed now.';
      }
      updateDepositNote();
      startReservationCountdown(body.expiresAt);
      reviewArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      if (attemptId !== bookingState.reserveAttemptId || bookingState.reservation) return;
      toast('Could not reserve. Try again or call ${COMPANY.phone}.');
      bookingState.isReserving = false;
      setBookingChoiceControlsDisabled(false);
      bookingState.pendingPref = null;
      bookingState.pickedPref = null;
      syncPaymentSetupCards();
    }
  }

  function pickExistingAppointmentPref(pref) {
    if (bookingState.serviceMode === 'one_time') {
      pref = 'pay_at_visit';
    }
    bookingState.pendingPref = pref;
    bookingState.pickedPref = pref;
    syncPaymentSetupCards();
    const payArea = document.getElementById('pay-pref-area');
    const reviewArea = document.getElementById('review-area');
    if (payArea) payArea.style.display = '';
    if (reviewArea) reviewArea.style.display = '';
    const confirmBtn = document.getElementById('confirm-book-btn');
    if (confirmBtn) confirmBtn.disabled = false;
    const title = document.getElementById('confirm-book-title');
    const sub = document.getElementById('confirm-book-sub');
    const summary = document.getElementById('existing-review-pay-summary');
    document.querySelectorAll('[data-pay-pref]').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.payPref === pref ? 'true' : 'false');
    });
    if (pref === 'prepay_annual') {
      if (title) title.textContent = 'Confirm annual prepay';
      if (sub) sub.textContent = 'Your existing appointment stays scheduled. Annual prepay invoice for ' + currentAnnualPrepayInvoiceText() + ' will be available for optional payment after confirmation.';
      if (summary) summary.textContent = 'Selected invoice option: Pay the 12-month plan in full.';
    } else if (pref === 'pay_at_visit' && bookingState.serviceMode === 'one_time') {
      if (title) title.textContent = 'Confirm appointment';
      if (sub) sub.textContent = 'Your existing appointment stays scheduled. We will collect payment with the tech on-site.';
      if (summary) summary.textContent = 'Selected payment option: Pay at the visit.';
    } else {
      if (title) title.textContent = CARD_CONFIRM_TITLE;
      if (sub) sub.textContent = 'Your existing appointment stays scheduled. ' + CARD_CONFIRM_SUB;
      if (summary) summary.textContent = 'Selected invoice option: Pay per application.';
    }
    updateDepositNote();
    if (reviewArea) reviewArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function startReservationCountdown(expiresAt) {
    if (bookingState.countdownTimer) clearInterval(bookingState.countdownTimer);
    const tick = () => {
      const el = document.getElementById('reservation-countdown');
      if (!el) return;
      const msLeft = new Date(expiresAt).getTime() - Date.now();
      if (msLeft <= 0) {
        el.textContent = 'expired';
        clearInterval(bookingState.countdownTimer);
        toast('Reservation expired — pick another time.');
        cancelReservation();
        return;
      }
      const total = Math.floor(msLeft / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      el.textContent = m + ':' + (s < 10 ? '0' + s : s);
    };
    tick();
    bookingState.countdownTimer = setInterval(tick, 1000);
  }

  function cancelReservation() {
    if (bookingState.countdownTimer) { clearInterval(bookingState.countdownTimer); bookingState.countdownTimer = null; }
    bookingState.reserveAttemptId += 1;
    bookingState.isReserving = false;
    // Fire-and-forget DELETE to release the server-side hold. If the
    // request fails (offline, etc.) the 15-min expiry will reclaim the
    // row anyway, so we don't await or block the UI.
    const res = bookingState.reservation;
    if (res && res.scheduledServiceId) {
      fetch('/api/public/estimates/' + TOKEN + '/reserve/' + encodeURIComponent(res.scheduledServiceId), { method: 'DELETE' }).catch(function () {});
    }
    bookingState.reservation = null;
    bookingState.selectedSlotId = null;
    bookingState.selectedSlotLabel = null;
    bookingState.pendingPref = null;
    bookingState.pickedPref = null;
    syncPaymentSetupCards();
    setBookingChoiceControlsDisabled(false);
    document.getElementById('review-area').style.display = 'none';
    const slotArea = document.getElementById('slot-area');
    if (slotArea) slotArea.style.display = '';
    const payArea = document.getElementById('pay-pref-area');
    const confirmBtn = document.getElementById('confirm-book-btn');
    if (confirmBtn) confirmBtn.disabled = false;
    if (payArea) {
      payArea.style.display = EXISTING_APPOINTMENT_ID ? '' : 'none';
      document.querySelectorAll('[data-pay-pref]').forEach((b) => { b.disabled = false; });
    }
    if (EXISTING_APPOINTMENT_ID) return;
    if (bookingRequiresPaymentSetup()) {
      const setupCard = document.getElementById('payment-setup-card');
      if (setupCard) setupCard.style.display = '';
      resetPaymentSetupSummary();
      hideBookingCardUntilSetup();
    } else {
      // Reload slots to reflect any changes since the first fetch
      loadSlots();
    }
  }

  function showInvoiceOptionalSuccess(data) {
    if (bookingState.countdownTimer) { clearInterval(bookingState.countdownTimer); bookingState.countdownTimer = null; }
    bookingState.isReserving = false;
    bookingState.reservation = null;
    setBookingChoiceControlsDisabled(false);
    const slotArea = document.getElementById('slot-area');
    const payArea = document.getElementById('pay-pref-area');
    const setupCard = document.getElementById('payment-setup-card');
    const reviewArea = document.getElementById('review-area');
    if (slotArea) slotArea.style.display = 'none';
    if (payArea) payArea.style.display = 'none';
    if (setupCard) setupCard.style.display = 'none';
    if (!reviewArea) return;
    const isOneTimeInvoice = data && data.serviceMode === 'one_time';
    const invoiceName = data && data.billingTerm === 'prepay_annual'
      ? 'annual prepay invoice'
      : (isOneTimeInvoice ? 'one-time service invoice' : 'setup + first application invoice');
    const payTitle = isOneTimeInvoice ? 'Pay invoice' : 'Pay now and save card';
    const paySub = 'Your ' + invoiceName + ' is ready. Payment is optional right now.';
    reviewArea.style.display = '';
    reviewArea.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = 'reservation-banner';
    banner.innerHTML = '<span>Appointment booked</span>';

    const grid = document.createElement('div');
    grid.className = 'pay-pref-grid';

    const payLink = document.createElement('a');
    payLink.className = 'pay-pref-btn primary';
    payLink.href = data.invoicePayUrl;
    payLink.innerHTML = '<span class="pay-pref-title">' + payTitle + '</span>'
      + '<span class="pay-pref-sub">' + paySub + '</span>';

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'pay-pref-btn';
    doneBtn.innerHTML = '<span class="pay-pref-title">I will pay later</span>'
      + '<span class="pay-pref-sub">Your appointment stays booked. Use the invoice link whenever you are ready.</span>';
    doneBtn.addEventListener('click', function () {
      doneBtn.disabled = true;
      doneBtn.innerHTML = '<span class="pay-pref-title">You are all set</span>'
        + '<span class="pay-pref-sub">Your appointment stays booked. Use the invoice link later if you want to pay online.</span>';
      toast('Payment skipped for now. Your appointment stays booked.');
    });

    grid.appendChild(payLink);
    grid.appendChild(doneBtn);
    reviewArea.appendChild(banner);
    reviewArea.appendChild(grid);
    try { reviewArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    catch (e) { reviewArea.scrollIntoView(true); }
    toast('Booked! Payment is optional right now.');
  }

  // ----- Acceptance deposit (flat $49 recurring / $99 one-time) -----
  // DEPOSIT_POLICY.required gates the whole block: while the
  // ESTIMATE_DEPOSIT_REQUIRED flag is dark, or this customer is exempt
  // (existing plan customer), none of this runs and accept behaves as before.
  let depositStripeJsPromise = null;
  function loadStripeJs() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    if (depositStripeJsPromise) return depositStripeJsPromise;
    depositStripeJsPromise = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.async = true;
      s.onload = function () { resolve(window.Stripe); };
      s.onerror = function () { depositStripeJsPromise = null; reject(new Error('stripe.js failed to load')); };
      document.head.appendChild(s);
    });
    return depositStripeJsPromise;
  }

  function depositAmountForMode() {
    return bookingState.serviceMode === 'one_time'
      ? DEPOSIT_POLICY.oneTimeAmount
      : DEPOSIT_POLICY.recurringAmount;
  }

  function updateDepositNote() {
    const note = document.getElementById('deposit-due-note');
    if (!note) return;
    if (!DEPOSIT_POLICY.required || bookingState.pickedPref === 'prepay_annual') {
      note.style.display = 'none';
      return;
    }
    note.textContent = bookingState.depositPaymentIntentId
      ? 'Deposit received — it will be applied to your first invoice.'
      : 'A ' + fmt(depositAmountForMode()) + ' deposit is due today to hold your spot — it is applied to your first invoice.';
    note.style.display = '';
  }

  function closeDepositOverlay() {
    const o = document.getElementById('deposit-overlay');
    if (o && o.parentNode) o.parentNode.removeChild(o);
  }

  function showDepositOverlay(intent) {
    return new Promise(function (resolve) {
      closeDepositOverlay();
      const overlay = document.createElement('div');
      overlay.id = 'deposit-overlay';
      overlay.innerHTML = '<div class="deposit-card">'
        + '<h3 style="margin:0 0 6px">Reserve your appointment</h3>'
        + '<p class="card-sub" style="margin:0 0 14px">A ' + fmt(intent.amount) + ' deposit holds your spot. It is applied to your first invoice.'
        + (Number(intent.receivedTotal) > 0 ? ' (' + fmt(intent.receivedTotal) + ' already received.)' : '')
        + '</p>'
        + '<div id="deposit-payment-element"></div>'
        + '<div id="deposit-error" class="deposit-error" role="alert" style="display:none"></div>'
        + '<div class="pay-pref-grid" style="margin-top:14px">'
        + '<button type="button" class="pay-pref-btn primary" id="deposit-pay-btn" disabled><span class="pay-pref-title">Pay ' + fmt(intent.amount) + ' deposit</span></button>'
        + '<button type="button" class="pay-pref-btn" id="deposit-cancel-btn"><span class="pay-pref-title">Not now</span></button>'
        + '</div>'
        + '</div>';
      document.body.appendChild(overlay);
      const errEl = overlay.querySelector('#deposit-error');
      const payBtn = overlay.querySelector('#deposit-pay-btn');
      const showError = function (message) {
        if (errEl) { errEl.textContent = message; errEl.style.display = ''; }
        if (payBtn) payBtn.disabled = false;
      };
      overlay.querySelector('#deposit-cancel-btn').addEventListener('click', function () {
        closeDepositOverlay();
        resolve({ ok: false, cancelled: true });
      });
      loadStripeJs().then(function (StripeCtor) {
        const stripe = StripeCtor(intent.publishableKey);
        const elements = stripe.elements({
          clientSecret: intent.clientSecret,
          appearance: { theme: 'stripe', variables: { borderRadius: '8px', fontFamily: 'Inter, system-ui, sans-serif' } },
        });
        const paymentElement = elements.create('payment');
        paymentElement.mount('#deposit-payment-element');
        paymentElement.on('ready', function () { payBtn.disabled = false; });
        // Accept-gate contract: ensureDepositSatisfied live-verifies the PI
        // and only honors status === 'succeeded' — a processing PI would 402
        // at accept. So only succeeded advances; processing shows a pending
        // message, and re-taps re-check the PI status instead of
        // re-confirming an in-flight intent.
        const succeedWith = function (pi) {
          if (!pi || pi.status !== 'succeeded') return false;
          bookingState.depositPaymentIntentId = pi.id;
          updateDepositNote();
          closeDepositOverlay();
          resolve({ ok: true });
          return true;
        };
        const PROCESSING_MSG = 'Your payment is processing — give it a few seconds, then tap Pay again. You will not be charged twice.';
        payBtn.addEventListener('click', function () {
          payBtn.disabled = true;
          if (errEl) errEl.style.display = 'none';
          stripe.retrievePaymentIntent(intent.clientSecret).then(function (existing) {
            if (existing && succeedWith(existing.paymentIntent)) return null;
            if (existing && existing.paymentIntent && existing.paymentIntent.status === 'processing') {
              showError(PROCESSING_MSG);
              return null;
            }
            return stripe.confirmPayment({
              elements: elements,
              confirmParams: { return_url: window.location.href },
              redirect: 'if_required',
            }).then(function (result) {
              if (result.error) {
                showError(result.error.message || 'Payment did not go through. Try another card.');
                return;
              }
              if (succeedWith(result.paymentIntent)) return;
              showError(result.paymentIntent && result.paymentIntent.status === 'processing'
                ? PROCESSING_MSG
                : 'Payment is still pending. Try again in a moment.');
            });
          }).catch(function () {
            showError('Payment did not go through. Try again.');
          });
        });
      }).catch(function () {
        showError('Could not load the secure payment form. Check your connection and try again.');
      });
    });
  }

  async function collectDepositIfNeeded() {
    if (!DEPOSIT_POLICY.required) return { ok: true };
    if (bookingState.pickedPref === 'prepay_annual') return { ok: true }; // exempt — server re-verifies at accept
    if (bookingState.depositPaymentIntentId) return { ok: true }; // collected this session or via 3DS return
    let r;
    let data = {};
    try {
      r = await fetch('/api/public/estimates/' + TOKEN + '/deposit-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceMode: bookingState.serviceMode,
          paymentMethodPreference: bookingState.pickedPref,
        }),
      });
      data = await r.json().catch(function () { return {}; });
    } catch (e) {
      return { ok: false, message: 'Could not start the deposit. Check your connection and try again.' };
    }
    if (r.status === 409 && data.exemptReason) return { ok: true }; // policy says nothing owed
    if (!r.ok) return { ok: false, message: data.error || 'Could not start the deposit. Please try again.' };
    if (data.alreadySatisfied) return { ok: true }; // ledger already covers the policy amount
    return showDepositOverlay(data);
  }

  // 3DS redirect return: Stripe sends the customer back with
  // ?payment_intent=...&redirect_status=succeeded after a challenge. The
  // accept gate live-verifies the PI server-side (metadata pinned to this
  // estimate), so carrying the id forward is flow sugar, not trust.
  (function () {
    try {
      const params = new URLSearchParams(window.location.search);
      const piFromRedirect = params.get('payment_intent');
      if (piFromRedirect && params.get('redirect_status') === 'succeeded') {
        bookingState.depositPaymentIntentId = piFromRedirect;
        toast('Deposit received — pick your time to finish booking.');
      }
      if (piFromRedirect) {
        ['payment_intent', 'payment_intent_client_secret', 'redirect_status'].forEach(function (k) { params.delete(k); });
        const qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
      }
    } catch (e) { /* non-fatal */ }
  })();

  async function confirmBooking() {
    const btn = document.getElementById('confirm-book-btn');
    if (btn) btn.disabled = true;
    setBookingChoiceControlsDisabled(true);
    try {
      const deposit = await collectDepositIfNeeded();
      if (!deposit.ok) {
        if (deposit.message) toast(deposit.message);
        if (btn) btn.disabled = false;
        setBookingChoiceControlsDisabled(false);
        return;
      }
      const payload = {
        slotId: bookingState.selectedSlotId,
        paymentMethodPreference: bookingState.pickedPref,
        serviceMode: bookingState.serviceMode,
      };
      if (bookingState.depositPaymentIntentId) {
        payload.depositPaymentIntentId = bookingState.depositPaymentIntentId;
      }
      if (EXISTING_APPOINTMENT_ID) {
        payload.existingAppointmentId = EXISTING_APPOINTMENT_ID;
        delete payload.slotId;
      }
      if (bookingState.serviceMode === 'recurring' && DEFAULT_RECURRING_FREQUENCY) {
        payload.selectedFrequency = DEFAULT_RECURRING_FREQUENCY;
      }
      const r = await fetch(API + '/accept', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (r.status === 402 && data.code === 'DEPOSIT_REQUIRED') {
        // Ledger disagrees with what we collected (refund or partial under
        // us) — drop the cached PI so the next confirm mints a fresh top-up.
        bookingState.depositPaymentIntentId = null;
        updateDepositNote();
        toast(data.error || 'A deposit is required to confirm your booking.');
        if (btn) btn.disabled = false;
        setBookingChoiceControlsDisabled(false);
        return;
      }
      if (r.status === 409) {
        toast(/expired|no active reservation/i.test(data.error || '')
          ? 'Reservation expired — pick another time.'
          : 'Slot conflict — pick another time.');
        cancelReservation();
        return;
      }
      if (!r.ok) throw new Error(data.error || 'accept failed');
      if (bookingState.countdownTimer) clearInterval(bookingState.countdownTimer);
      // Recurring accepts show the invoice action without blocking the booking.
      if (data.nextStep === 'pay_invoice' && data.invoicePayUrl) {
        showInvoiceOptionalSuccess(data);
      } else {
        const prepayAmount = data.prepayInvoiceAmount != null ? fmt(Number(data.prepayInvoiceAmount)) : null;
        toast(data.nextStep === 'prepay_invoice'
          ? 'Approved! Annual prepay' + (prepayAmount ? ' for ' + prepayAmount : '') + ' is confirmed. Our team will follow up with the invoice.'
          : 'Booked! We will be in touch shortly.');
        setTimeout(() => location.reload(), 1200);
      }
    } catch (e) {
      toast('Could not confirm. Call ${COMPANY.phone} if this keeps happening.');
      if (btn) btn.disabled = false;
      setBookingChoiceControlsDisabled(false);
    }
  }

  // Wire pay-pref buttons once DOM is ready (script runs after the card
  // is emitted inline so the nodes already exist).
      document.querySelectorAll('[data-pay-pref]').forEach((b) => {
        b.addEventListener('click', () => {
          if (EXISTING_APPOINTMENT_ID) pickExistingAppointmentPref(b.dataset.payPref);
          else pickPaymentPref(b.dataset.payPref);
        });
      });
  document.querySelectorAll('[data-payment-setup]').forEach((b) => {
    b.addEventListener('click', () => choosePaymentSetup(b.dataset.paymentSetup));
  });
  const confirmBookBtn = document.getElementById('confirm-book-btn');
  if (confirmBookBtn) {
    confirmBookBtn.addEventListener('click', confirmBooking);
  }
  // Commercial approval card (no slots) — approve monthly-invoice or prepay.
  document.querySelectorAll('[data-commercial-mode]').forEach((b) => {
    b.addEventListener('click', () => approveCommercialManual(b.dataset.commercialMode));
  });
  const changeBookingPickBtn = document.getElementById('change-booking-pick-btn');
  if (changeBookingPickBtn) {
    changeBookingPickBtn.addEventListener('click', cancelReservation);
  }
  const changePaymentSetupBtn = document.getElementById('change-payment-setup-btn');
  if (changePaymentSetupBtn) {
    changePaymentSetupBtn.addEventListener('click', returnToPaymentSetupChoices);
  }

  // Kick off the slot fetch if the booking card is on the page (i.e.,
  // estimate is not yet accepted/expired).
  if (document.getElementById('booking-card') && !bookingRequiresPaymentSetup()) {
    loadSlots();
  }
  if (document.getElementById('date-finder')) {
    initDateFinder();
  }



  // Rotating Google reviews from /api/reviews/featured (same pool as wavespestcontrol.com)
  (async function initReviews() {
    let reviews = [];
    try {
      const r = await fetch('/api/reviews/featured?limit=8');
      const data = await r.json();
      reviews = (data.reviews || []).filter(x => x.text && x.text.length > 40);
    } catch (e) { /* silent */ }
    if (!reviews.length) {
      reviews = REVIEW_FALLBACKS;
    }
    if (!reviews.length) {
      document.getElementById('review-carousel').style.display = 'none';
      return;
    }
    const track = document.getElementById('review-track');
    const dots = document.getElementById('review-dots');
    if (!track || !dots) return;
    const pageSize = 3;
    const pageCount = Math.max(1, Math.ceil(reviews.length / pageSize));
    Array.from({ length: pageCount }).forEach((_, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', 'Review group ' + (i + 1));
      b.addEventListener('click', () => show(i, true));
      dots.appendChild(b);
    });
    let page = 0;
    let timer = null;
    function makeReviewCard(r) {
      const card = document.createElement('div');
      card.className = r.fallback ? 'review-card review-profile-card' : 'review-card';
      const stars = document.createElement('div');
      stars.className = 'stars';
      const rating = Math.max(1, Math.min(5, Math.round(Number(r.starRating || 5))));
      stars.textContent = '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
      const text = document.createElement('p');
      text.textContent = r.fallback ? r.text : '\u201C' + r.text + '\u201D';
      const meta = document.createElement('div');
      meta.className = 'rev-meta';
      const name = document.createElement('strong');
      name.textContent = r.reviewerName || 'Waves customer';
      meta.appendChild(name);
      if (r.location) {
        meta.appendChild(document.createTextNode(' \u00B7 ' + r.location));
      }
      card.appendChild(stars);
      card.appendChild(text);
      card.appendChild(meta);
      if (r.url) {
        const link = document.createElement('a');
        link.className = 'review-link';
        link.href = r.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = r.fallback ? 'Open Google reviews' : 'View local reviews';
        card.appendChild(link);
      }
      return card;
    }
    function show(i, manual) {
      page = (i + pageCount) % pageCount;
      track.classList.add('fade');
      setTimeout(() => {
        track.innerHTML = '';
        const start = page * pageSize;
        const visibleCount = Math.min(pageSize, reviews.length);
        Array.from({ length: visibleCount }).forEach((_, offset) => {
          track.appendChild(makeReviewCard(reviews[(start + offset) % reviews.length]));
        });
        dots.querySelectorAll('button').forEach((b, n) => b.classList.toggle('active', n === page));
        track.classList.remove('fade');
      }, 250);
      if (manual && timer) { clearInterval(timer); timer = setInterval(() => show(page + 1), 6000); }
    }
    show(0);
    timer = setInterval(() => show(page + 1), 6000);
  })();

  // Bundle-applied banner. When the page loads with ?bundle_applied=1,
  // show a one-time dismissible banner above the hero so the customer
  // sees "we just auto-applied your bundle" before they start reading.
  (function () {
    if (!/[?&]bundle_applied=1/.test(location.search)) return;
    var div = document.createElement('div');
    div.setAttribute('role', 'status');
    div.style.cssText = 'background:#ECFDF5;border:1px solid #10B981;color:#064E3B;padding:12px 16px;border-radius:8px;margin:0 auto 16px;max-width:820px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;';
    var params = new URLSearchParams(location.search);
    var tier = (params.get('bundle_tier') || 'updated').replace(/[^A-Za-z ]/g, '').slice(0, 24) || 'updated';
    var tierText = tier === 'updated' ? 'Updated bundle pricing' : tier + ' tier pricing';
    div.innerHTML = '<span><strong>Bundle applied.</strong> ' + tierText + ' is now reflected below. We also sent a heads-up to our office.</span><button type="button" aria-label="Dismiss" style="background:none;border:none;color:#064E3B;cursor:pointer;font-size:18px;line-height:1;padding:4px 8px;">\u00D7</button>';
    div.querySelector('button').addEventListener('click', function () { div.remove(); });
    var wrap = document.querySelector('.wrap') || document.body;
    wrap.insertBefore(div, wrap.firstChild);
  })();

  // "Pick a time and book" — scroll to the booking card and flash it
  // briefly so the tap is visibly confirmed (on mobile the scroll can be
  // subtle when the user is near the bottom of a tall page). Uses
  // addEventListener instead of inline onclick to avoid silent-fail on
  // older iOS Safari when the handler uses optional chaining.
  (function () {
    var btns = document.querySelectorAll('.pick-time-cta');
    if (!btns.length) return;
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (bookingRequiresPaymentSetup() && !bookingState.pendingPref) {
          var setupTarget = document.getElementById('payment-setup-card');
          if (!setupTarget) return;
          try { setupTarget.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          catch (e) { setupTarget.scrollIntoView(true); }
          setupTarget.animate([
            { boxShadow: '0 0 0 0 rgba(27,44,91,0)' },
            { boxShadow: '0 0 0 6px rgba(27,44,91,.16)' },
            { boxShadow: '0 0 0 0 rgba(27,44,91,0)' },
          ], { duration: 900, easing: 'ease-out' });
          toast('Choose a payment option first.');
          return;
        }
        scrollToBookingCard();
      });
    });
  })();

  async function inquireBundle(svc) {
    var card = document.querySelector('.upsell');
    var pill = document.querySelector('.upsell-btn');
    var status = document.getElementById('upsell-request-status');
    try {
      if (card) card.disabled = true;
      if (pill) pill.textContent = 'Sending request\u2026';
      var r = await fetch(API + '/bundle-inquiry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedService: svc })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data && data.error ? data.error : 'request failed');
      if (data && data.bundled) {
        toast('Bundle applied \u2014 ' + data.bundled.tier + ' tier pricing');
        var sep = location.search ? '&' : '?';
        var tierParam = data.bundled.tier ? '&bundle_tier=' + encodeURIComponent(data.bundled.tier) : '';
        setTimeout(function () { location.href = location.pathname + location.search + sep + 'bundle_applied=1' + tierParam; }, 700);
      } else {
        toast('Request received.');
        if (card) {
          card.disabled = true;
          card.classList.add('requested');
        }
        if (pill) pill.textContent = 'Request received';
        if (status) {
          var copy = document.getElementById('upsell-request-status-copy');
          if (copy && data && data.confirmation && data.confirmation.message) copy.textContent = data.confirmation.message;
          status.hidden = false;
          try { status.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
          catch (scrollErr) { status.scrollIntoView(false); }
        }
      }
    } catch (e) {
      toast('Could not send. Call (941) 297-5749.');
      if (card) card.disabled = false;
      if (pill) pill.textContent = 'Get a bundle quote';
    }
  }
</script>
</body></html>`;
}

function sendEstimatePage(res, token, estimate, estData, membership, opts = {}) {
  res
    .set('Cache-Control', 'no-cache, no-store, must-revalidate')
    .set('Pragma', 'no-cache')
    .set('Expires', '0')
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(renderPage(token, estimate, estData, membership, opts));
}

// Existing-customer estimate treatment — waived WaveGuard setup fee and no
// annual-prepay option — is frozen onto the estimate as estimate_data
// .membershipSnapshot at send-time. That treatment must only apply to customers
// who actually hold a WaveGuard plan today. A frozen snapshot can go stale: a
// lead whose initial service auto-scheduled a recurring follow-up was once
// misclassified as "existing," or a member's plan lapsed. Re-check the live
// plan status and drop a stale "existing customer" snapshot so the estimate
// renders the correct new-customer pricing ($99 setup + annual prepay). Mutates
// estimate.estimate_data in place so every downstream consumer
// (buildEstimateMembershipContext, buildPricingBundle's annual-prepay gate, the
// server-HTML renderPage) sees the reconciled value. Never throws.
async function reconcileFrozenMembershipSnapshot(estimate) {
  try {
    if (!estimate || !estimate.customer_id) return;
    // Never reconcile an accepted or price-locked estimate: that deal was
    // committed at the send-time classification, so a later plan lapse must
    // not retroactively change the terms the customer accepted.
    if (estimate.status === 'accepted' || estimate.price_locked_at) return;
    const isString = typeof estimate.estimate_data === 'string';
    const estData = isString
      ? JSON.parse(estimate.estimate_data)
      : (estimate.estimate_data || null);
    const snapshot = estData && estData.membershipSnapshot;
    if (!snapshot || !snapshot.isExistingCustomer) return;
    if (await isActivePlanCustomer(db, estimate.customer_id)) return;
    // Drop every frozen artifact derived from the stale "existing customer"
    // classification, not just the snapshot: priorQualifyingServices is
    // re-injected by extractEngineInputs() on every recompute (keeping the
    // combined-tier discount), and sendSnapshot.pricingBundle is consulted by
    // buildPricingBundle() before the runtime cache (returning the old bundle
    // with no waivable setup fee). Leaving either behind lets the lead keep
    // member pricing / undercharge even after the snapshot is gone.
    delete estData.membershipSnapshot;
    delete estData.priorQualifyingServices;
    invalidateSendSnapshotPricingBundle(estData);
    estimate.estimate_data = isString ? JSON.stringify(estData) : estData;
    // The runtime pricing cache key ignores estimate_data content, so bust it
    // here to force a fresh recompute with the new-customer setup fee + annual
    // prepay restored.
    clearEstimatePricingCache(estimate.id);
  } catch (err) {
    logger.warn(`[estimate-public] membership snapshot reconcile skipped: ${err.message}`);
  }
}

async function handleEstimateView(req, res, next) {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) {
      return res.status(404).set('Content-Type', 'text/html').send(renderEstimateNotFoundPage());
    }
    await reconcileFrozenMembershipSnapshot(estimate);

    // Parsed once here (post-reconcile) so the V2 gate's one-time check below
    // can read it; reused by the rest of the handler.
    const estData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;

    // V2 gate — when this estimate's row has use_v2_view=true, or when it
    // uses customer options only implemented in the React view, skip the
    // server-HTML pipeline entirely and let the request fall through to
    // the SPA static-index fallback at server/index.js's app.get('*',...).
    // The React page owns view tracking + first-view side effects via
    // GET /:token/data; do NOT double-count them here.
    // show_one_time_option is now handled inline by the rich server-HTML
    // via the recurring/one-time mode toggle (see canChooseOneTime branch
    // in renderPage). It no longer routes to the React V2 view.
    // One-time card-on-file hold lives ONLY in the React view's capture UI.
    // When the flag is on, route any one-time-eligible estimate to React so the
    // card hold can be captured — otherwise the legacy server-HTML page would
    // accept without a hold and the server would reject with CARD_HOLD_REQUIRED.
    // Dark by default: isCardHoldEnabled() is false until ONE_TIME_CARD_HOLD.
    const cardHoldForcesReactView = CardHolds.isCardHoldEnabled()
      && estimate.bill_by_invoice !== true
      && (estimate.show_one_time_option === true || isStructuralOneTimeOnlyEstimate(estData, estimate));
    const shouldUseReactEstimateView = (estimate.use_v2_view === true
      || estimate.bill_by_invoice === true
      || cardHoldForcesReactView)
      // Unpublished estimates (draft/scheduled) stay on the legacy server-HTML
      // renderer so office staff can still preview a draft via /estimate/<token>
      // before it's sent. The React `/:token/data` gate 404s drafts (security),
      // so routing them to React would break draft preview; the default flip
      // only takes effect once the estimate is actually published.
      && !UNPUBLISHED_ESTIMATE_STATUSES.includes(estimate.status);
    if (shouldUseReactEstimateView && req.path.startsWith('/estimate/')) {
      return next();
    }

    if (new Date(estimate.expires_at) < new Date() && estimate.status !== 'accepted') {
      return res.set('Content-Type', 'text/html').send(
        renderExpiredPage({ address: estimate.address, customerName: estimate.customer_name })
      );
    }

    // Track every real view (count + last_viewed_at). Bot UAs and admin
    // IPs are filtered upstream by shouldCountView so the dashboard count
    // reflects actual customer opens.
    const requestIp = clientIp(req);
    const countThisView = shouldCountView(req, requestIp, estimate);
    if (countThisView) {
      try {
        await db('estimates').where({ id: estimate.id }).update({
          view_count: db.raw('COALESCE(view_count, 0) + 1'),
          last_viewed_at: db.fn.now(),
        });
      } catch (e) { logger.error(`[estimate-view] view tracking failed: ${e.message}`); }

      // Per-open log (Estimates v2 spec §4) — one row per open with ip + UA.
      // Wrapped so a schema drift can't break the public estimate page.
      try {
        const ua = (req.get('user-agent') || '').slice(0, 1000);
        await db('estimate_views').insert({
          estimate_id: estimate.id,
          viewed_at: db.fn.now(),
          ip: requestIp || null,
          user_agent: ua || null,
        });
      } catch (e) { logger.warn(`[estimate-view] estimate_views insert skipped: ${e.message}`); }
    }

    // First-view actions: set viewed_at/status and notify admin in-app.
    // Admin preview links should render the exact customer page without
    // making the estimate look customer-opened.
    if (!estimate.viewed_at && shouldApplyFirstViewSideEffects(req, requestIp, estimate) && !['accepted', 'declined', 'expired'].includes(estimate.status)) {
      // Don't break an in-flight send's `sending` claim (which also gates
      // PUT /:id/proposal): stamp viewed_at but leave status='sending' alone —
      // the send's final write reconciles to `viewed` via viewed_at. Any other
      // non-terminal status flips to `viewed` as before.
      await db('estimates').where({ id: estimate.id }).update({
        viewed_at: db.fn.now(),
        status: db.raw("CASE WHEN status = 'sending' THEN status ELSE 'viewed' END"),
      });
      try {
        await markLinkedLeadEstimateViewed({ estimateId: estimate.id });
      } catch (e) {
        logger.warn(`[estimate-view] linked lead view status update failed: ${e.message}`);
      }

      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyAdmin('estimate', `Estimate viewed: ${estimate.customer_name}`, `${estimate.address || 'no address'} \u2014 $${estimate.monthly_total || 0}/mo`, { icon: '\u{1F4CB}', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } });
      } catch (e) { logger.error(`[notifications] Estimate viewed notification failed: ${e.message}`); }
    }

    const linkedAppointment = await findLinkedUpcomingAppointment(estimate, estData);
    let pricingBundleForView = null;
    try {
      pricingBundleForView = await buildPricingBundle(estimate);
    } catch (e) {
      logger.warn(`[estimate-view] pricing bundle quote guard skipped: ${e.message}`);
    }
    const quoteRequirement = resolveEstimateQuoteRequirement(pricingBundleForView, estData);

    // One-time alternative price for the inline toggle. Mirrors the
    // resolveAcceptOneTimeTotal logic on accept so the customer sees the
    // same number that gets committed if they pick "single visit".
    let oneTimeChoicePrice = 0;
    if (estimate.show_one_time_option) {
      oneTimeChoicePrice = resolveAcceptOneTimeTotal(estimate, pricingBundleForView);
    }

    // Existing-customer WaveGuard membership context (null for leads / on error).
    const membership = await buildEstimateMembershipContext(estimate);

    // Deposit policy for the page's accept flow. Resolved without a payment
    // preference — the prepay-annual exemption applies when the customer
    // actually picks it, at deposit-intent/accept time. Both class amounts
    // ride along so the page shows the right figure on the recurring/one-time
    // toggle. Inert ({enforced:false}) while ESTIMATE_DEPOSIT_REQUIRED is off.
    const depositStructuralOneTime = isStructuralOneTimeOnlyEstimate(estData, estimate);
    const depositPolicyForView = await resolveDepositPolicyForEstimate({
      estimate,
      paymentMethodPreference: null,
      membership,
      oneTime: depositStructuralOneTime,
      oneTimeUninvoiced: depositStructuralOneTime && estimate.bill_by_invoice !== true,
    });
    // Card-hold policy "as if one-time" — surfaced so the page can require a
    // card when the customer books a single visit (enforced client-side only
    // in one_time mode).
    const cardHoldOneTimePolicyForView = CardHolds.resolveCardHoldPolicy({
      treatAsOneTime: true,
      billByInvoice: estimate.bill_by_invoice === true,
      paymentMethodPreference: null,
    });

    // "Show your work" trust block — wizard estimates only (needs
    // estimate_data.enriched). With the gate off this stays null and the
    // rendered HTML is byte-identical to today's page.
    let showYourWork = null;
    if (featureGates.isEnabled('estimateShowYourWork')) {
      showYourWork = await buildShowYourWork(estimate, estData);
    }

    // Commercial prepay is taxed — resolve the customer's effective rate
    // (exemptions + county, forced commercial) so the estimate PAGE's prepay
    // total matches the tax-inclusive invoice the converter creates. Async, so
    // resolve here and pass into the (sync) renderPage. Non-commercial → 0.
    const prepayBaseRate = isCommercialAutoAcceptEstimate(estimate)
      ? await require('../services/estimate-converter').resolveCommercialPrepayBaseRate(estimate.customer_id || null, { forceCommercial: true })
      : 0;

    sendEstimatePage(res, req.params.token, {
      id: estimate.id,
      status: estimate.status === 'accepted'
        ? estimate.status
        : (quoteRequirement.quoteRequired ? 'quote_required' : estimate.status),
      quoteRequired: quoteRequirement.quoteRequired,
      quoteRequiredReason: quoteRequirement.reason || null,
      customerName: estimate.customer_name,
      customerEmail: estimate.customer_email,
      customerPhone: estimate.customer_phone,
      address: estimate.address,
      monthlyTotal: parseFloat(estimate.monthly_total || 0),
      annualTotal: parseFloat(estimate.annual_total || 0),
      onetimeTotal: parseFloat(estimate.onetime_total || 0),
      tier: estimate.waveguard_tier,
      createdAt: estimate.created_at,
      expiresAt: estimate.expires_at,
      satelliteUrl: estimate.satellite_url || null,
      showOneTimeOption: !!estimate.show_one_time_option,
      oneTimeChoicePrice,
      pricingFrequencies: Array.isArray(pricingBundleForView?.frequencies)
        ? pricingBundleForView.frequencies
        : [],
      existingAppointment: shapeLinkedAppointment(linkedAppointment),
      depositPolicy: depositPolicyForView.enforced ? {
        enforced: true,
        required: depositPolicyForView.required,
        slotRequired: depositPolicyForView.slotRequired,
        exemptReason: depositPolicyForView.exemptReason || null,
        recurringAmount: computeDepositAmount({ oneTime: false }),
        oneTimeAmount: computeDepositAmount({ oneTime: true }),
      } : { enforced: false, required: false },
      // One-time card-on-file hold. Resolved "as if one-time" so the page knows
      // whether a card is required when the customer books a single visit; the
      // frontend only enforces it once serviceMode is one_time. Inert
      // ({enforced:false}) while ONE_TIME_CARD_HOLD is off.
      cardHoldPolicy: cardHoldOneTimePolicyForView.enforced ? {
        enforced: true,
        requiredForOneTime: cardHoldOneTimePolicyForView.required,
        noShowFeeAmount: cardHoldOneTimePolicyForView.noShowFeeAmount || CardHolds.cardHoldNoShowFee(),
        cancelWindowHours: cardHoldOneTimePolicyForView.cancelWindowHours || CardHolds.cardHoldCancelWindowHours(),
      } : { enforced: false, requiredForOneTime: false },
    }, estData, membership, { showYourWork, prepayBaseRate });
  } catch (err) { next(err); }
}

// GET /api/estimates/:token — customer views estimate (no auth) — server-rendered HTML
router.get('/:token', handleEstimateView);

// Auto-priced commercial lawn/tree estimates are approval-only: no bookable
// slot, no booking deposit/card, and no auto-scheduling — the team confirms
// scope on-site, schedules, and invoices. They CAN prepay the year at the
// standard 5% discount (there is no WaveGuard setup fee on commercial). Mirrors
// estimate-slots-public's isCommercialAutoEstimate — keep both in sync.
function isCommercialAutoAcceptEstimate(estimate = {}) {
  let data = estimate.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
  data = data || {};
  if (data.commercialEstimatedPricing === true) return true;
  const isCommercialSvc = (s) => {
    const k = String(s?.service || s?.serviceKey || s?.name || '').toLowerCase();
    return k.includes('commercial_lawn') || k.includes('commercial_tree') || k.includes('commercial_pest') || k.includes('commercial_mosquito') || k.includes('commercial_termite') || k.includes('commercial_rodent');
  };
  const lineItems = Array.isArray(data.engineResult?.lineItems) ? data.engineResult.lineItems : [];
  if (lineItems.some((li) => li && li.estimatedPricing === true && isCommercialSvc(li) && Number(li.annual) > 0)) return true;
  const recurringRows = [
    ...(Array.isArray(data.result?.recurring?.services) ? data.result.recurring.services : []),
    ...(Array.isArray(data.recurring?.services) ? data.recurring.services : []),
  ];
  return recurringRows.some(isCommercialSvc);
}

// PUT /api/estimates/:token/accept — customer accepts
// Body (backward compatible — both optional):
//   { slotId?: string, paymentMethodPreference?: 'card_on_file' | 'deposit_now' | 'pay_at_visit' | 'prepay_annual' }
// When slotId is present, a prior POST /:token/reserve call must have
// created a scheduled_services reservation row for the same estimate.
// The accept handler commits that reservation inside the existing
// transaction — customer_id gets linked, reservation_expires_at cleared.
// Paths without slotId behave exactly as pre-PR-B.1 (EstimateConverter
// creates scheduled_services post-transaction).
router.put('/:token/accept', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    await reconcileFrozenMembershipSnapshot(estimate);
    if (estimate.status === 'accepted') return res.json({ success: true, alreadyAccepted: true });
    if (!isEstimateAcceptActive(estimate)) {
      return res.status(409).json({ error: 'Estimate is no longer active' });
    }

    const firstName = (estimate.customer_name || '').split(' ')[0] || 'there';

    // Commercial auto-priced lawn/tree: approval-only manual-billing workflow.
    // No booking deposit/card, no auto-schedule, no auto-invoice; the converter
    // writes the non-member 'Commercial' tier and notifies the team to schedule
    // + invoice. The customer may still prepay the year (standard 5% off) with
    // NO slot — the prepay path already skips scheduling and waives the (absent)
    // setup fee.
    const isCommercialAccept = isCommercialAutoAcceptEstimate(estimate);

    // Slot commit inputs. Validate early so we can reject before opening
    // a transaction if the payload is malformed.
    const slotId = req.body && typeof req.body.slotId === 'string' ? req.body.slotId.trim() : '';
    const existingAppointmentId = req.body && typeof req.body.existingAppointmentId === 'string' ? req.body.existingAppointmentId.trim() : '';
    if (slotId && existingAppointmentId) {
      return res.status(400).json({ error: 'Choose either a new slot or the existing appointment, not both' });
    }
    const paymentMethodPreference = normalizeAcceptPaymentMethodPreference(req.body?.paymentMethodPreference);
    // Billing term is a separate concept from payment method. "prepay_annual"
    // means the customer is paying for 12 months upfront, which waives the
    // $99 WaveGuard setup fee. The converter reads this to decide what kind
    // of draft invoice to create at accept time.
    const billingTerm = paymentMethodPreference === 'prepay_annual' ? 'prepay_annual' : 'standard';
    const annualPrepaySelected = billingTerm === 'prepay_annual';
    // serviceMode — 'recurring' (default) | 'one_time'. When one_time, the
    // customer picked the inline toggle on the v2 estimate view and
    // explicitly asked for a single visit instead of a recurring plan.
    // Gates post-commit behavior: no onboarding session, no customer tier
    // upgrade, no EstimateConverter recurring schedule creation.
    const requestedOneTime = req.body?.serviceMode === 'one_time';
    const serviceMode = requestedOneTime ? 'one_time' : 'recurring';
    // Billing choices are only meaningful for recurring accepts: the
    // converter creates the matching invoice after the slot is confirmed.
    // Reject up front rather than fulfill the request half-way.
    if (requestedOneTime && paymentMethodPreference === 'prepay_annual') {
      return res.status(400).json({ error: `${paymentMethodPreference} is not available for one-time visits — pick pay_at_visit instead` });
    }
    const selectedFrequencyKey = (() => {
      const raw = req.body?.selectedFrequency;
      return typeof raw === 'string' ? raw.trim() : '';
    })();
    // Invoice-mode: admin opted the estimate into legacy auto-invoicing.
    // Standard recurring accepts now also use invoice payment links, while
    // this flag keeps the older bill-by-invoice amount rules in place.
    const billByInvoice = !!estimate.bill_by_invoice;
    if (annualPrepaySelected && billByInvoice) {
      return res.status(400).json({ error: 'annual prepay is not available for invoice-mode estimates' });
    }
    if (annualPrepaySelected && !slotId && !existingAppointmentId && !isCommercialAccept) {
      return res.status(400).json({ error: 'annual prepay requires selecting a service appointment first' });
    }
    if (billByInvoice && !estimate.customer_id && !estimate.customer_phone) {
      return res.status(400).json({ error: 'invoice-mode estimates require a linked customer or customer phone before online acceptance' });
    }

    let reservationRow = null;
    if (slotId) {
      const parsed = slotReservation._internals.parseSlotId(slotId);
      if (!parsed) return res.status(400).json({ error: 'invalid slotId format' });

      // Find the reservation row for THIS estimate matching the requested
      // slot. Prevents a malicious client from passing a slotId reserved
      // for someone else's estimate.
      reservationRow = await db('scheduled_services')
        .where({
          source_estimate_id: estimate.id,
          scheduled_date: parsed.date,
          window_start: parsed.windowStart,
        })
        .modify((q) => { if (parsed.techId) q.where('technician_id', parsed.techId); })
        .whereNotNull('reservation_expires_at')
        .first();

      if (!reservationRow) {
        return res.status(409).json({ error: 'no active reservation for this slot — re-pick and try again' });
      }
      if (new Date(reservationRow.reservation_expires_at) < new Date()) {
        return res.status(409).json({ error: 'reservation expired — re-pick a slot' });
      }
    }

    // Parse estimate data + detect one-time-only vs recurring (read-only — safe outside txn)
    const rawEstData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;
    const estData = withSupplementedRecurringServices(rawEstData) || rawEstData || {};
    const existingAppointmentRow = existingAppointmentId
      ? await findLinkedUpcomingAppointment(estimate, estData, { appointmentId: existingAppointmentId })
      : null;
    if (existingAppointmentId && !existingAppointmentRow) {
      return res.status(409).json({ error: 'existing appointment is not linked to this active estimate' });
    }
    if (
      existingAppointmentRow?.customer_id
      && estimate.customer_id
      && String(existingAppointmentRow.customer_id) !== String(estimate.customer_id)
    ) {
      return res.status(409).json({ error: 'existing appointment belongs to a different customer' });
    }
    const estimateForPricing = estData === rawEstData ? estimate : { ...estimate, estimate_data: estData };
    const pricingBundle = await buildPricingBundle(estimateForPricing);
    const quoteRequirement = resolveEstimateQuoteRequirement(pricingBundle, estData);
    if (quoteRequirement.quoteRequired) {
      const needsManagerApproval = quoteRequirement.reason === 'st_augustine_dethatching';
      const commercialProposal = quoteRequirement.reason === 'commercial_proposal';
      const commercialRiskType = quoteRequirement.reason === 'commercial_risk_type_review';
      const commercialLowConfidence = quoteRequirement.reason === 'commercial_low_confidence_site_confirmation';
      return res.status(409).json({
        error: needsManagerApproval
          ? 'Manager approval is required before this estimate can be accepted online'
          : commercialProposal
          ? 'This is a custom commercial proposal — your Waves account manager will finalize acceptance with you directly.'
          : commercialRiskType
          ? 'Your Waves account manager will confirm this commercial service plan with you before it’s finalized.'
          : commercialLowConfidence
          ? 'This estimate needs a quick site confirmation before it’s finalized — your Waves account manager will confirm the price with you.'
          : 'This estimate requires an inspection before it can be accepted online',
        quoteRequired: true,
        managerApprovalRequired: needsManagerApproval,
        reason: quoteRequirement.reason || 'QUOTE_REQUIRED',
      });
    }

    let { recurringSvcList, oneTimeList } = acceptanceServiceLists(estData);
    if (estimate.show_one_time_option && recurringSvcList.some((svc) => isPestServiceName(svc?.name || svc?.label || svc?.service))) {
      recurringSvcList = recurringSvcList.filter((svc) => isPestServiceName(svc?.name || svc?.label || svc?.service));
    }
    const isOneTimeOnly = isStructuralOneTimeOnlyEstimate(estData, estimate);
    const oneTimeChoicePrice = resolveAcceptOneTimeTotal(estimate, pricingBundle);
    const canChooseOneTime = !!estimate.show_one_time_option && oneTimeChoicePrice > 0;
    if (requestedOneTime && !isOneTimeOnly && !canChooseOneTime) {
      return res.status(400).json({ error: 'one-time option is not available for this estimate' });
    }
    // Customer-choice "treat as one-time" — either the estimate is
    // structurally one-time-only, OR the customer picked the one-time
    // toggle on the v2 view (serviceMode='one_time'). Gates the same
    // post-commit branches (no onboarding session, no tier upgrade,
    // no recurring schedule via EstimateConverter).
    const treatAsOneTime = isOneTimeOnly || serviceMode === 'one_time';

    // One-time card-on-file hold (dark until ONE_TIME_CARD_HOLD). Read straight
    // from the raw body so the normalized payment preference + existing
    // pay-at-visit semantics stay untouched: the hold is an orthogonal saved
    // card, not a payment method. A required hold means a one-time accept must
    // carry a captured SetupIntent before it can commit.
    const cardHoldSetupIntentId = typeof req.body?.cardHoldSetupIntentId === 'string'
      ? req.body.cardHoldSetupIntentId.trim() : '';
    const cardHoldPolicy = CardHolds.resolveCardHoldPolicy({
      treatAsOneTime,
      billByInvoice,
      paymentMethodPreference,
    });
    let cardHoldVerification = null;

    // ─────────────────────────────────────────────
    // REQUIRED ACCEPTANCE DEPOSIT (dark until ESTIMATE_DEPOSIT_REQUIRED).
    // Every acceptance requires a verified deposit except prepay-annual
    // (paying in full) and existing plan customers — whose commitment gate
    // is booking the appointment itself. Flat per-service-class amounts:
    // one-time accepts pay the heavier amount and the credit lands on their
    // completed-visit invoice (createFromService roll-forward); recurring
    // accepts credit the first invoice created here. Verification never
    // trusts the client: webhook-recorded deposit, else live Stripe
    // retrieval of the named PaymentIntent with metadata pinned to this
    // estimate.
    // ─────────────────────────────────────────────
    const acceptMembership = await buildEstimateMembershipContext(estimate);
    // The scheduled_service whose per-job payer the eventual invoice will resolve.
    // It MUST be the appointment actually being accepted — never an unrelated
    // linked/source appointment: an existing-appointment accept uses its validated
    // row; a new-slot accept books a fresh reservation that carries no per-job
    // payer, so it stays customer-default (null); only when neither is supplied do
    // we fall back to the estimate's own live linked appointment (source_estimate_id
    // / persisted link). Resolved ONCE and threaded into the deposit exemption, the
    // bill-by-invoice create, and the post-accept refund sweep so all three agree.
    const acceptLinkedSsId = (existingAppointmentId && existingAppointmentRow?.id)
      ? String(existingAppointmentRow.id)
      : (slotId ? null : await linkedScheduledServiceId(estimate));
    // resolveDepositPolicyForEstimate adds the LIVE plan-customer fallback
    // (legacy customer-linked estimates have no membershipSnapshot) and
    // oneTimeUninvoiced forces a booking on one-time pay-at-visit accepts —
    // without an appointment there is no source_estimate_id for the
    // roll-forward to credit the deposit against.
    const depositPolicy = await resolveDepositPolicyForEstimate({
      estimate,
      paymentMethodPreference,
      membership: acceptMembership,
      oneTime: treatAsOneTime,
      oneTimeUninvoiced: treatAsOneTime && estimate.bill_by_invoice !== true,
      scheduledServiceId: acceptLinkedSsId,
      // Scope already resolved above to the accepted appointment — don't let the
      // resolver re-derive an unrelated linked appointment when this is null.
      useLinkedFallback: false,
    });
    if (isCommercialAccept) {
      // Commercial bills by manual invoice after on-site confirmation, not a
      // booking deposit/card — and nothing is auto-scheduled, so there is no
      // first-visit invoice to credit a deposit against. Exempt the commitment
      // deposit (and its slot requirement) so the customer can approve online.
      depositPolicy.required = false;
      depositPolicy.slotRequired = false;
      depositPolicy.exemptReason = 'commercial_manual_billing';
    }
    // Card hold supersedes the one-time deposit: a required card hold means NO
    // money is taken at booking, so don't ALSO require/charge a deposit when
    // both rollout flags happen to be on (ONE_TIME_CARD_HOLD + the deposit).
    if (cardHoldPolicy.required && depositPolicy.required) {
      depositPolicy.required = false;
      depositPolicy.exemptReason = 'card_hold_supersedes';
    }
    if (depositPolicy.slotRequired && !slotId && !existingAppointmentId) {
      return res.status(400).json({
        error: 'Please pick your first appointment to confirm this service',
        code: 'APPOINTMENT_REQUIRED',
      });
    }
    if (depositPolicy.required) {
      const depositPaymentIntentId = typeof req.body?.depositPaymentIntentId === 'string'
        ? req.body.depositPaymentIntentId.trim()
        : null;
      // requiredAmount enforces the RESOLVED class amount, not mere presence:
      // a $49 recurring deposit must not unlock a one-time accept that owes
      // $99 — the accept would proceed under-collected after a mode switch.
      const depositCheck = await ensureDepositSatisfied({
        estimate,
        depositPaymentIntentId,
        requiredAmount: depositPolicy.amount,
      });
      if (!depositCheck.satisfied) {
        return res.status(402).json({
          error: 'To confirm your service, a deposit is required and will be applied toward your first visit',
          code: 'DEPOSIT_REQUIRED',
          depositRequired: true,
          depositAmount: depositPolicy.amount,
          depositReceived: depositCheck.receivedTotal || 0,
        });
      }
    }

    // Card-hold gate (pre-commit): a one-time accept that requires a hold must
    // have a booked appointment AND a captured card before we commit — the
    // completion + no-show charges resolve from the booked scheduled_service,
    // and the card is re-verified live against Stripe, never trusted from the
    // client. Enforced for EVERY one-time accept while the flag is on (card is
    // how you book), regardless of which payment preference the client sent.
    if (cardHoldPolicy.required) {
      if (!slotId && !existingAppointmentId) {
        return res.status(400).json({
          error: 'Please pick your appointment so we can hold it with a card',
          code: 'APPOINTMENT_REQUIRED',
        });
      }
      cardHoldVerification = await CardHolds.verifyCardHoldIntent({ estimate, setupIntentId: cardHoldSetupIntentId });
      if (!cardHoldVerification.ok) {
        return res.status(402).json({
          error: 'Add a card to hold your appointment to confirm this visit',
          code: 'CARD_HOLD_REQUIRED',
          noShowFeeAmount: cardHoldPolicy.noShowFeeAmount,
          cancelWindowHours: cardHoldPolicy.cancelWindowHours,
        });
      }
    }

    const acceptedOneTimeChoiceList = treatAsOneTime && !isOneTimeOnly
      ? acceptedOneTimeChoiceListForEstimate(estimate, estData, pricingBundle, oneTimeChoicePrice)
      : null;
    if (acceptedOneTimeChoiceList) {
      oneTimeList = acceptedOneTimeChoiceList;
    }
    if (treatAsOneTime && paymentMethodPreference === 'prepay_annual') {
      return res.status(400).json({ error: `${paymentMethodPreference} is not available for one-time visits — pick pay_at_visit instead` });
    }
    const paymentPreferenceError = validateRecurringSlotPaymentPreference({
      slotId,
      existingAppointmentId,
      treatAsOneTime,
      billByInvoice,
      paymentMethodPreference,
    });
    if (paymentPreferenceError) {
      return res.status(400).json({ error: paymentPreferenceError });
    }
    if (annualPrepaySelected && !isAnnualPrepayEligibleServiceMix(recurringSvcList, oneTimeList)) {
      return res.status(400).json({ error: 'annual prepay is not available for this estimate' });
    }
    // Existing customers are pay-per-application only — the page never offers
    // prepay, but a stale/crafted client could still POST it. Reject so
    // EstimateConverter can't open an annual prepay invoice/term for them.
    if (annualPrepaySelected && estData?.membershipSnapshot?.isExistingCustomer) {
      return res.status(400).json({ error: 'annual prepay is not available for existing customers — pick pay_at_visit instead' });
    }
    const pricingFrequencies = Array.isArray(pricingBundle?.frequencies) ? pricingBundle.frequencies : [];
    const selectedFrequency = !treatAsOneTime && pricingFrequencies.length
      ? (selectedFrequencyKey
        ? pricingFrequencies.find((f) => f.key === selectedFrequencyKey)
        : defaultFrequencyFromList(pricingFrequencies))
      : null;
    let pricingVisitFrequency = selectedFrequency
      || null;
    if (selectedFrequencyKey && !treatAsOneTime && !selectedFrequency) {
      return res.status(400).json({ error: 'selectedFrequency is not available for this estimate' });
    }
    // Per-service cadence: in a bundle the customer may pick each selectable
    // service's cadence independently. `serviceCadences` maps a service key to
    // its chosen tier key; the matching precomputed combo carries the
    // authoritative total (priced through the same shapeFromV1 path the view
    // showed, so accepted == shown == billed — no client-trusted price).
    const serviceCadences = (() => {
      const raw = req.body?.serviceCadences;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const out = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v.trim()) out[String(k)] = v.trim();
      }
      return Object.keys(out).length ? out : null;
    })();
    const serviceCadenceCombos = Array.isArray(pricingBundle?.serviceCadenceCombos)
      ? pricingBundle.serviceCadenceCombos
      : [];
    let selectedCombo = null;
    if (!treatAsOneTime && serviceCadences && serviceCadenceCombos.length) {
      const requestedNonPest = Object.keys(serviceCadences);
      selectedCombo = serviceCadenceCombos.find((c) => {
        const sel = c.selection || {};
        // Requested non-pest selections must match exactly (no more, no less).
        const comboNonPest = Object.keys(sel).filter((k) => k !== 'pest_control');
        if (comboNonPest.length !== requestedNonPest.length) return false;
        if (!requestedNonPest.every((k) => sel[k] === serviceCadences[k])) return false;
        // If the combo carries a pest axis, the chosen pest cadence must match.
        if (sel.pest_control) return sel.pest_control === selectedFrequencyKey;
        return true;
      }) || null;
      if (!selectedCombo) {
        return res.status(400).json({ error: 'selected service cadence combination is not available for this estimate' });
      }
    }
    // Re-base the visit-pricing frequency on the selected combo so BOTH the
    // recurring total AND the first-application invoice / same-day-visit math use
    // the chosen per-service treatments (matches the client's combinedFrequency).
    // Keeps the base entry's pest cadence key (billing interval is unchanged).
    if (selectedCombo && pricingVisitFrequency) {
      pricingVisitFrequency = {
        ...pricingVisitFrequency,
        monthly: selectedCombo.monthly,
        annual: selectedCombo.annual,
        perServiceTreatments: selectedCombo.perServiceTreatments ?? pricingVisitFrequency.perServiceTreatments,
        sameDayTreatmentTotal: selectedCombo.sameDayTreatmentTotal ?? pricingVisitFrequency.sameDayTreatmentTotal,
      };
    }
    const effectiveMonthlyTotal = selectedCombo?.monthly != null
      ? Number(selectedCombo.monthly)
      : (selectedFrequency?.monthly != null ? Number(selectedFrequency.monthly) : Number(estimate.monthly_total || 0));
    const effectiveAnnualTotal = selectedCombo?.annual != null
      ? Number(selectedCombo.annual)
      : (selectedFrequency?.annual != null ? Number(selectedFrequency.annual) : Number(estimate.annual_total || 0));
    const annualPrepayInvoiceAmount = annualPrepaySelected
      ? resolveAnnualPrepayInvoiceAmount(effectiveAnnualTotal, effectiveMonthlyTotal)
      : null;
    // annualPrepayInvoiceAmount is the UNDISCOUNTED recurring annual (the base the
    // converter needs). For post-accept customer/admin messaging AND the API
    // response we must quote the amount actually invoiced — the converter's shared
    // calc applies the discount and the margin-floor clamp, so this always matches.
    // Commercial prepay tax is the customer's EFFECTIVE rate (exemptions +
    // county), not a hardcoded 7% — resolve it for the display so the quoted
    // amount matches the invoice the converter creates. A linked customer
    // resolves their real rate; a brand-new one (no row yet) defaults to the FL
    // rate, which is also what the converter's new-customer invoice resolves.
    const prepayDisplayBaseRate = annualPrepaySelected && isCommercialAccept
      ? await require('../services/estimate-converter').resolveCommercialPrepayBaseRate(estimate.customer_id || null, {})
      : 0;
    const annualPrepayDisplayAmount = annualPrepaySelected && annualPrepayInvoiceAmount != null
      ? (() => {
        const converter = require('../services/estimate-converter');
        const resolved = converter.resolveAnnualPrepayInvoiceTotal({
          baseAnnual: annualPrepayInvoiceAmount,
          recurringServices: recurringSvcList,
          estimateData: estData,
        });
        const base = resolved.amount;
        // Commercial prepay is taxed on the taxable pest share — quote the
        // TAX-INCLUSIVE total so the customer/admin message matches the invoice
        // + PaymentIntent the converter creates (uses the same blended rate +
        // post-discount allocation). Residential prepay is untaxed (rate 0).
        const taxRate = isCommercialAccept
          ? converter.resolveCommercialPrepayTaxRate(recurringSvcList, { prepayDiscountApplied: resolved.discount > 0, baseRate: prepayDisplayBaseRate })
          : 0;
        // Mirror InvoiceService EXACTLY: tax dollars rounded to cents, then added
        // to the base — so the messaged amount equals inv.total to the cent.
        const tax = Math.round(base * taxRate * 100) / 100;
        return Math.round((base + tax) * 100) / 100;
      })()
      : null;
    const effectiveOneTimeTotal = treatAsOneTime ? oneTimeChoicePrice : Number(estimate.onetime_total || 0);
    const acceptedFrequencyKey = selectedFrequency?.billingFrequencyKey || selectedFrequency?.key || selectedFrequencyKey;
    const acceptedServiceTierKey = selectedFrequency?.billingFrequencyKey ? selectedFrequency.key : null;
    const acceptedSchedulingFrequencyKey = acceptedServiceTierKey || acceptedFrequencyKey;
    const selectedServiceTierBillsMonthly = !!acceptedServiceTierKey && acceptedFrequencyKey === 'monthly';
    let acceptedEstDataForPricing = selectedFrequency
      ? applySelectedMosquitoTierToEstimateData(
          applySelectedLawnTierToEstimateData(
            applySelectedTreeShrubTierToEstimateData(estData, selectedFrequency),
            selectedFrequency,
          ),
          selectedFrequency,
        )
      : estData;
    // Per-service cadence: rewrite each independently-selected non-pest tier into
    // the recurring rows so the converter schedules + bills each service at its
    // chosen cadence (lawn / tree / mosquito have apply-helpers; see NON_PEST_RESULT_ROWS).
    if (selectedCombo && serviceCadences) {
      const rDisc = Number(estData?.result?.recurring?.discount) || 0;
      for (const [svcKey, tierKey] of Object.entries(serviceCadences)) {
        const svcRow = recurringSvcList.find((s) => recurringServiceKey(s) === svcKey);
        const ladder = bundleSectionLadderForService(svcKey, acceptedEstDataForPricing, svcRow || { service: svcKey }, rDisc);
        const tierEntry = ladder && ladder.find((e) => e.key === tierKey);
        if (!tierEntry) continue;
        if (svcKey === 'lawn_care') {
          acceptedEstDataForPricing = applySelectedLawnTierToEstimateData(acceptedEstDataForPricing, tierEntry);
        } else if (svcKey === 'tree_shrub') {
          acceptedEstDataForPricing = applySelectedTreeShrubTierToEstimateData(acceptedEstDataForPricing, tierEntry);
        } else if (svcKey === 'mosquito') {
          acceptedEstDataForPricing = applySelectedMosquitoTierToEstimateData(acceptedEstDataForPricing, tierEntry);
        }
      }
    }
    if (acceptedEstDataForPricing !== estData) {
      const acceptedLists = acceptanceServiceLists(acceptedEstDataForPricing);
      recurringSvcList = acceptedLists.recurringSvcList;
      oneTimeList = acceptedLists.oneTimeList;
      if (estimate.show_one_time_option && recurringSvcList.some((svc) => isPestServiceName(svc?.name || svc?.label || svc?.service))) {
        recurringSvcList = recurringSvcList.filter((svc) => isPestServiceName(svc?.name || svc?.label || svc?.service));
      }
    }
    const effectiveBillingCadence = !treatAsOneTime
      ? BillingCadence.resolveBillingCadence({
          monthlyRate: effectiveMonthlyTotal,
          frequencyKey: selectedFrequency?.billingFrequencyKey || selectedFrequency?.key || selectedFrequencyKey,
          estimateData: acceptedEstDataForPricing,
          fallbackFrequencyKey: 'quarterly',
        })
      : null;
    const acceptPrefs = normalizePrefs(acceptedEstDataForPricing?.preferences);
    const selectedFrequencyPestVisits = pestVisitsForFrequency(selectedFrequency);
    const selectedFrequencyPestMonthlyBase = pestMonthlyBaseForFrequency(selectedFrequency);
    const acceptPestRecurring = detectPestRecurring(recurringSvcList);
    const { monthlyOff: storedCadencePrefMonthlyOff } = computePrefDiscount(acceptPrefs, acceptPestRecurring, false, 0);
    const acceptPrefMonthlyOff = selectedFrequencyPestVisits
      ? preferenceMonthlyOffForPestVisits(acceptPrefs, selectedFrequencyPestVisits, selectedFrequencyPestMonthlyBase)
      : storedCadencePrefMonthlyOff;
    const acceptTier = estimate.waveguard_tier || pricingBundle?.waveGuardTier || 'Bronze';
    const acceptEstResult = acceptedEstDataForPricing?.result || acceptedEstDataForPricing || {};
    const savedAcceptTierDiscount = Number(acceptEstResult?.recurring?.discount);
    const acceptTierDiscount = tierDiscountForEstimate(
      acceptedEstDataForPricing,
      acceptTier,
      Number.isFinite(savedAcceptTierDiscount) ? savedAcceptTierDiscount : null,
    );
    const selectedFrequencyFirstVisitAmount = selectedServiceTierBillsMonthly
      ? null
      : resolveRecurringFirstVisitAmountFromFrequency(
          pricingVisitFrequency,
          { prefMonthlyOff: acceptPrefMonthlyOff, services: recurringSvcList },
        );
    const recurringFirstVisitAmount = !treatAsOneTime && !selectedServiceTierBillsMonthly
      ? selectedFrequencyFirstVisitAmount || resolveRecurringFirstVisitAmount(recurringSvcList, {
          estData: acceptedEstDataForPricing,
          tierDiscount: acceptTierDiscount,
          prefMonthlyOff: acceptPrefMonthlyOff,
          pestRecurring: acceptPestRecurring,
        })
      : null;
    const sameDayVisitTotal = !treatAsOneTime && !selectedServiceTierBillsMonthly
      ? sameDayVisitTotalForPricingFrequency(pricingVisitFrequency, { preferences: acceptPrefs, services: recurringSvcList })
      : null;
    const firstApplicationInvoiceAmount = !treatAsOneTime && !selectedServiceTierBillsMonthly && billingTerm !== 'prepay_annual'
      ? (sameDayVisitTotal || recurringFirstVisitAmount || null)
      : null;
    const visitEstimatedPrice = treatAsOneTime
      ? effectiveOneTimeTotal
      : (billingTerm === 'prepay_annual' ? null : (firstApplicationInvoiceAmount || effectiveBillingCadence?.amount));
    const acceptedOneTimeServiceLabel = treatAsOneTime
      ? buildOneTimeInvoiceServiceLabel({
          estimate,
          estData: acceptedEstDataForPricing,
          pricingBundle,
          oneTimeList,
        })
      : null;

    // All DB mutations run atomically so a mid-flight failure can't leave a
    // half-created customer without an onboarding session (or vice versa).
    // Customer-facing sends and notifications fire AFTER the commit below.
    // Annual-prepay conversion is intentionally inside the transaction so the
    // accepted state cannot commit without its prepay invoice + term.
    const txResult = await db.transaction(async (trx) => {
      const acceptedUpdates = {
        status: 'accepted',
        accepted_at: trx.fn.now(),
        // Persist what the customer actually booked so a later reopen recaps the
        // right plan — the React page otherwise derives mode + frequency and
        // would show a mixed estimate's recurring plan for a one-time accept, or
        // the default frequency card for a non-default recurring choice.
        // Use the RESOLVED mode (treatAsOneTime), not the raw request value: a
        // structurally one-time estimate commits as one_time even when the body
        // omits serviceMode.
        accepted_service_mode: treatAsOneTime ? 'one_time' : serviceMode,
        // Persist the UI SELECTION key the customer picked (what the React
        // recap matches against `section.frequencies[].key`), NOT the billing
        // cadence: for lawn/tree tier rows `acceptedFrequencyKey` resolves to
        // `billingFrequencyKey` ('monthly'), which never matches the tier keys
        // (basic/enhanced/…), so the recap would fall back to the default card.
        accepted_frequency_key: treatAsOneTime ? null : (selectedFrequency?.key || selectedFrequencyKey || null),
        // Acceptance is where money commits — freeze the price. The frequency
        // rung selected below is the one legitimate accept-time re-derive; it is
        // written into this same atomic update, so derive→lock cannot race or
        // leave a stale-price lock. The .whereNotIn('status', ['accepted',...])
        // guard on the update prevents a second accept from re-pricing.
        price_locked_at: trx.fn.now(),
        price_locked_by: 'customer_accept',
        pricing_authority: 'LOCKED',
      };
      let nextEstimateData = acceptedEstDataForPricing && typeof acceptedEstDataForPricing === 'object'
        ? { ...acceptedEstDataForPricing }
        : null;
      if (nextEstimateData) {
        acceptedUpdates.estimate_data = JSON.stringify(nextEstimateData);
      }
      if (selectedFrequency) {
        acceptedUpdates.monthly_total = effectiveMonthlyTotal;
        acceptedUpdates.annual_total = effectiveAnnualTotal;
        nextEstimateData = nextEstimateData || {};
        nextEstimateData.customerSelection = {
          ...(nextEstimateData.customerSelection || {}),
          frequency: acceptedFrequencyKey,
          frequencyKey: acceptedFrequencyKey,
          frequencyLabel: effectiveBillingCadence.frequencyLabel || selectedFrequency.label,
          ...(acceptedServiceTierKey ? {
            serviceTier: acceptedServiceTierKey,
            serviceTierKey: acceptedServiceTierKey,
            serviceTierLabel: selectedFrequency.label,
          } : {}),
          monthlyTotal: effectiveMonthlyTotal,
          annualTotal: effectiveAnnualTotal,
          billingAmount: effectiveBillingCadence.amount,
          billingIntervalMonths: effectiveBillingCadence.intervalMonths,
          billingPeriodLabel: effectiveBillingCadence.periodLabel,
          // Per-service cadence choices (lawn/tree) when the customer set them
          // independently — recorded for the receipt/admin; the chosen tiers are
          // already rewritten into the recurring rows for scheduling/billing.
          ...(serviceCadences ? { serviceCadences } : {}),
          selectedAt: new Date().toISOString(),
        };
        const persistPestOnlyRecurringChoice = shouldPersistPestOnlyRecurringChoice(estimate, nextEstimateData);
        if (persistPestOnlyRecurringChoice && Array.isArray(nextEstimateData.result?.recurring?.services)) {
          nextEstimateData.result = {
            ...nextEstimateData.result,
            recurring: {
              ...nextEstimateData.result.recurring,
              services: nextEstimateData.result.recurring.services.filter((svc) => isPestServiceName(svc?.name || svc?.label || svc?.service)),
            },
          };
        }
        if (persistPestOnlyRecurringChoice && Array.isArray(nextEstimateData.recurring?.services)) {
          nextEstimateData.recurring = {
            ...nextEstimateData.recurring,
            services: nextEstimateData.recurring.services.filter((svc) => isPestServiceName(svc?.name || svc?.label || svc?.service)),
          };
        }
        acceptedUpdates.estimate_data = JSON.stringify(nextEstimateData);
      }
      const acceptedEstimateForScheduling = nextEstimateData
        ? {
            ...estimateForPricing,
            monthly_total: acceptedUpdates.monthly_total ?? estimateForPricing.monthly_total,
            annual_total: acceptedUpdates.annual_total ?? estimateForPricing.annual_total,
            estimate_data: nextEstimateData,
          }
        : estimateForPricing;
      if (treatAsOneTime && effectiveOneTimeTotal > 0 && Number(estimate.onetime_total || 0) !== effectiveOneTimeTotal) {
        acceptedUpdates.onetime_total = effectiveOneTimeTotal;
      }
      const acceptedCount = await trx('estimates')
        .where({ id: estimate.id })
        .whereNotIn('status', ['accepted', 'declined', 'expired', 'send_failed', 'draft', 'scheduled'])
        .andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>=', trx.raw('NOW()')))
        .update(acceptedUpdates);
      if (!acceptedCount) {
        const err = new Error('Estimate is no longer active');
        err.status = 409;
        throw err;
      }

      let customerId = estimate.customer_id;
      if (!customerId && estimate.customer_phone) {
        // Match on last-10 digits (format-insensitive), skip soft-deleted
        // rows, and order deterministically: exact raw match first, then the
        // most recently updated profile. Reuse a profile only when the match
        // is unambiguous (pickAcceptCustomerMatch).
        const matchDigits = phoneLast10(estimate.customer_phone);
        const candidates = await trx('customers')
          .where((q) => {
            q.where({ phone: estimate.customer_phone });
            if (matchDigits) {
              q.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${matchDigits}`]);
            }
          })
          .whereNull('deleted_at')
          .orderByRaw('(phone = ?) DESC NULLS LAST', [estimate.customer_phone])
          .orderBy('updated_at', 'desc');
        // No row cap: a property manager can hold many profiles on one
        // phone, and truncating by recency could drop the one profile
        // whose email/address uniquely matches — splitting the estimate
        // off the existing account. pickAcceptCustomerMatch needs the
        // full set to judge ambiguity.
        const existing = pickAcceptCustomerMatch(candidates, estimate);
        if (!existing && candidates.length > 1) {
          logger.warn(`[estimate-accept] ${candidates.length} live customers share phone for estimate ${estimate.id}; no unique email/address match — creating a new profile`);
        }
        if (existing) {
          customerId = existing.id;
        } else {
          const nameParts = (estimate.customer_name || 'New Customer').split(' ');
          const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
          const [newCust] = await trx('customers').insert(applyContactNormalization({
            first_name: nameParts[0] || 'New',
            last_name: nameParts.slice(1).join(' ') || 'Customer',
            phone: estimate.customer_phone,
            email: estimate.customer_email || null,
            address_line1: estimate.address || '',
            city: '', state: 'FL', zip: '',
            // One-time accepts must not look like WaveGuard members: a
            // monthly_rate > 0 with active+autopay defaults would put them
            // in billing-cron's monthly charge sweep. 'One-Time' is an
            // explicit non-membership tier (the column defaults to 'Bronze'
            // if omitted, so it must be set).
            waveguard_tier: treatAsOneTime ? 'One-Time' : (estimate.waveguard_tier || 'Bronze'),
            monthly_rate: treatAsOneTime ? null : effectiveMonthlyTotal,
            member_since: etDateString(),
            referral_code: code,
          })).returning('*');
          customerId = newCust.id;
          await trx('property_preferences').insert({ customer_id: customerId });
          await trx('notification_prefs').insert({ customer_id: customerId });
        }
        await trx('estimates').where({ id: estimate.id }).update({ customer_id: customerId });
      }

      // Copy the estimate's service-preference selections onto the customer
      // row so tech routes + the customer portal see the same source of truth.
      // Defensive: skip if the column hasn't been migrated yet (older envs).
      if (customerId) {
        try {
          const prefs = normalizePrefs(estData?.preferences);
          if (await trx.schema.hasColumn('customers', 'service_preferences')) {
            await trx('customers').where({ id: customerId }).update({
              service_preferences: JSON.stringify(prefs),
            });
          }
        } catch (e) { logger.warn(`[estimate-accept] service_preferences copy skipped: ${e.message}`); }
      }

      let reservationCommitted = false;
      const acceptedAppointmentsToRegister = [];
      // Commit the slot reservation (if one) now that we have customerId.
      // Runs inside the same trx so either everything lands or nothing
      // does — a mid-flight failure here won't leave a committed customer
      // paired with an un-committed reservation (or vice versa).
      if (reservationRow && customerId) {
        try {
          const committedAppointment = await slotReservation.commitReservation({
            scheduledServiceId: reservationRow.id,
            customerId,
            paymentMethodPreference,
            estimatedPrice: visitEstimatedPrice,
            estimate: acceptedEstimateForScheduling,
            serviceMode: treatAsOneTime ? 'one_time' : serviceMode,
            selectedFrequency: acceptedSchedulingFrequencyKey,
            trx,
          });
          reservationCommitted = true;
          if (committedAppointment?.id) {
            acceptedAppointmentsToRegister.push(committedAppointment);
          }
        } catch (commitErr) {
          if (commitErr.code === 'RESERVATION_EXPIRED') {
            const err = new Error('reservation expired — re-pick a slot');
            err.status = 409;
            throw err;
          }
          if (commitErr.code === 'SLOT_UNAVAILABLE') {
            const err = new Error('slot no longer available — re-pick a slot');
            err.status = 409;
            throw err;
          }
          throw commitErr;
        }
      }
      if (existingAppointmentRow && customerId) {
        if (
          existingAppointmentRow.customer_id
          && String(existingAppointmentRow.customer_id) !== String(customerId)
        ) {
          const err = new Error('existing appointment belongs to a different customer');
          err.status = 409;
          throw err;
        }
        if (isReservationHeldAppointment(existingAppointmentRow)) {
          try {
            const committedAppointment = await slotReservation.commitReservation({
              scheduledServiceId: existingAppointmentRow.id,
              customerId,
              paymentMethodPreference,
              estimatedPrice: visitEstimatedPrice,
              estimate: acceptedEstimateForScheduling,
              serviceMode: treatAsOneTime ? 'one_time' : serviceMode,
              selectedFrequency: acceptedSchedulingFrequencyKey,
              trx,
            });
            reservationCommitted = true;
            if (committedAppointment?.id) {
              acceptedAppointmentsToRegister.push(committedAppointment);
            }
          } catch (commitErr) {
            if (commitErr.code === 'RESERVATION_EXPIRED') {
              const err = new Error('reservation expired — re-pick a slot');
              err.status = 409;
              throw err;
            }
            if (commitErr.code === 'SLOT_UNAVAILABLE') {
              const err = new Error('slot no longer available — re-pick a slot');
              err.status = 409;
              throw err;
            }
            throw commitErr;
          }
        } else {
          const updates = {
            source_estimate_id: estimate.id,
            customer_id: existingAppointmentRow.customer_id || customerId,
            reservation_expires_at: null,
            payment_method_preference: paymentMethodPreference,
          };
          if (visitEstimatedPrice != null && Number.isFinite(Number(visitEstimatedPrice))) {
            updates.estimated_price = Number(visitEstimatedPrice);
          }
          const updatedCount = await trx('scheduled_services')
            .where({ id: existingAppointmentRow.id })
            .whereIn('status', ['pending', 'confirmed'])
            .where('scheduled_date', '>=', etDateString())
            .where((builder) => {
              builder.whereNull('customer_id').orWhere('customer_id', customerId);
            })
            .where((builder) => {
              builder.whereNull('source_estimate_id').orWhere('source_estimate_id', estimate.id);
            })
            .update(updates);
          assertExistingAppointmentUpdateApplied(updatedCount);
          reservationCommitted = true;
          acceptedAppointmentsToRegister.push({
            ...existingAppointmentRow,
            ...updates,
          });
        }
      }

      // Record the one-time card hold atomically with the booking. The pm id
      // is frozen onto the hold row here (inside the accept transaction) so the
      // completion + no-show charges can resolve it; the card is attached to
      // the customer post-commit (retryable). Pinned to the just-committed
      // appointment so the charge triggers find it.
      if (cardHoldPolicy.required && cardHoldVerification?.ok) {
        // A required hold MUST land on a committed appointment + customer, or
        // completion/no-show charging has nothing to resolve. Fail closed (roll
        // the accept back) rather than commit a holdless one-time booking — e.g.
        // an email-only lead where customerId never resolved and the slot commit
        // was skipped.
        const heldAppointmentId = acceptedAppointmentsToRegister[0]?.id || null;
        if (!customerId || !reservationCommitted || !heldAppointmentId) {
          throw estimateAcceptError('Could not hold your appointment — please pick a time and try again');
        }
        await CardHolds.recordCardHoldHeld({
          estimateId: estimate.id,
          customerId,
          scheduledServiceId: heldAppointmentId,
          setupIntentId: cardHoldVerification.setupIntentId,
          paymentMethodId: cardHoldVerification.paymentMethodId,
          trx,
        });
      }

      // Recurring public accepts continue through the invoice payment page;
      // the payment method is captured on /pay/:token.

      let invoiceModeResult = false;
      let invoiceIdResult = null;
      let invoiceAmountResult = null;
      let invoicePayUrlResult = null;
      let invoiceServiceLabelResult = acceptedOneTimeServiceLabel || null;
      let invoiceKindResult = null;
      let annualPrepayConversionResult = null;
      if (billByInvoice) {
        if (!customerId) {
          throw estimateAcceptError('invoice-mode acceptance requires a customer record before creating the invoice');
        }
        const InvoiceService = require('../services/invoice');
        const invoiceDraft = buildEstimateInvoiceModeDraft({
          estimate,
          estData: acceptedEstDataForPricing,
          pricingBundle,
          oneTimeList,
          recurringSvcList,
          treatAsOneTime,
          effectiveOneTimeTotal,
          effectiveMonthlyTotal,
          recurringFirstVisitAmount,
          effectiveBillingCadence,
          selectedFrequency,
        });
        // Acceptance deposit credits this first invoice through create()'s
        // depositCredit param — create() caps the request against its own
        // after-tax total (a pre-tax cap here under-applied the credit on
        // taxed invoices and stranded the difference on the ledger) and
        // reports the effective amount back as applied_deposit_credit.
        // Read through the accept trx so the consume below shares its
        // snapshot; a read failure degrades to "no credit" (the deposit
        // stays received on the ledger), never to an unbacked discount.
        const { pendingDepositCredit: pendingEstimateDepositCredit, consumeDepositCredit: consumeEstimateDepositCredit } = require('../services/estimate-deposits');
        const invoiceDepositCredit = await pendingEstimateDepositCredit(estimate.id, trx).catch(() => null);
        const requestedInvoiceDepositCredit = invoiceDepositCredit ? Number(invoiceDepositCredit.amount) : 0;
        const inv = await InvoiceService.create({
          database: trx,
          customerId,
          // Same appointment scope the deposit exemption used, so the invoice
          // resolves the same per-job payer (scheduled_services.payer_id) instead
          // of falling back to self-pay when the customer has no default payer.
          ...(acceptLinkedSsId ? { scheduledServiceId: acceptLinkedSsId } : {}),
          title: invoiceDraft.title,
          lineItems: invoiceDraft.lineItems,
          notes: invoiceDraft.notes,
          dueDate: etDateString(),
          ...(requestedInvoiceDepositCredit > 0
            ? { depositCredit: { amount: requestedInvoiceDepositCredit, estimateId: estimate.id } }
            : {}),
        });
        if (!inv?.id) {
          throw new Error('Invoice-mode acceptance could not create an invoice');
        }
        const appliedInvoiceDepositCredit = Number(inv.applied_deposit_credit) || 0;
        if (appliedInvoiceDepositCredit > 0) {
          const allocatedDepositCredit = await consumeEstimateDepositCredit({
            estimateId: estimate.id,
            amount: appliedInvoiceDepositCredit,
            invoiceId: inv.id,
            trx,
          });
          if (Math.round(allocatedDepositCredit * 100) !== Math.round(appliedInvoiceDepositCredit * 100)) {
            // The ledger could not back the discount (a refund landed
            // mid-accept) — roll the whole acceptance back rather than
            // leave a discounted invoice beside an unconsumed deposit.
            throw new Error(`deposit allocation mismatch on invoice-mode accept for estimate ${estimate.id} — acceptance rolled back`);
          }
          if (appliedInvoiceDepositCredit < requestedInvoiceDepositCredit) {
            logger.warn(`[estimate-public] deposit partially applied to invoice-mode accept for estimate ${estimate.id} — remainder stays on the ledger`);
          }
        }
        invoiceModeResult = true;
        invoiceIdResult = inv.id;
        // The customer-facing amount is the invoice's actual after-tax,
        // after-credit total — the same figure the /pay page collects.
        invoiceAmountResult = Number(inv.total) || 0;
        invoicePayUrlResult = inv.token ? `/pay/${inv.token}` : null;
        invoiceServiceLabelResult = invoiceDraft.serviceLabel;
        invoiceKindResult = invoiceDraft.invoiceKind;
      }

      if (annualPrepaySelected) {
        if (!customerId) {
          throw estimateAcceptError('annual prepay acceptance requires a customer record before creating the prepay invoice');
        }
        const EstimateConverter = require('../services/estimate-converter');
        annualPrepayConversionResult = await EstimateConverter.convertEstimate(estimate.id, {
          database: trx,
          billingTerm,
          skipAutoSchedule: true,
          skipMembershipEmail: true,
          prepayInvoiceAmount: annualPrepayInvoiceAmount,
          firstApplicationAmount: firstApplicationInvoiceAmount,
          allowFirstApplicationFallback: false,
          autoSendInvoice: false,
          deferFollowUpReminderRegistration: true,
        });
        if (!annualPrepayConversionResult?.draftInvoiceId) {
          throw new Error('Annual prepay invoice was not created');
        }
        invoiceModeResult = true;
        invoiceIdResult = annualPrepayConversionResult.draftInvoiceId;
        invoiceAmountResult = annualPrepayConversionResult.draftInvoiceAmount || annualPrepayDisplayAmount || null;
        invoicePayUrlResult = annualPrepayConversionResult.draftInvoicePayUrl || null;
        invoiceServiceLabelResult = 'Annual prepay';
        invoiceKindResult = 'annual_prepay';
      }

      return {
        customerId,
        reservationCommitted,
        acceptedAppointmentsToRegister,
        invoiceMode: invoiceModeResult,
        invoiceId: invoiceIdResult,
        invoiceAmount: invoiceAmountResult,
        invoicePayUrl: invoicePayUrlResult,
        invoiceServiceLabel: invoiceServiceLabelResult,
        invoiceKind: invoiceKindResult,
        annualPrepayConversion: annualPrepayConversionResult,
      };
    });

    const { customerId, reservationCommitted } = txResult;
    // Attach the held card to the customer (post-commit, best-effort). The hold
    // row already carries the pm id for charging, so a transient attach failure
    // never breaks the booking — it self-heals on retry / first charge.
    if (cardHoldPolicy.required && cardHoldVerification?.ok && customerId) {
      void CardHolds.attachCardHoldPaymentMethod({
        customerId,
        paymentMethodId: cardHoldVerification.paymentMethodId,
      }).catch(() => {});
    }
    let invoiceMode = txResult.invoiceMode === true;
    let invoiceId = txResult.invoiceId || null;
    let invoiceAmount = txResult.invoiceAmount || null;
    let invoicePayUrl = txResult.invoicePayUrl || null;
    let invoiceLinkDelivered = false;
    let invoiceServiceLabel = txResult.invoiceServiceLabel || acceptedOneTimeServiceLabel || null;
    const invoiceKind = txResult.invoiceKind || null;
    const annualPrepayConversion = txResult.annualPrepayConversion || null;
    let acceptedAppointmentsToRegister = txResult.acceptedAppointmentsToRegister || [];
    if (annualPrepaySelected && acceptedAppointmentsToRegister.length) {
      const appointmentIds = acceptedAppointmentsToRegister.map((appt) => appt?.id).filter(Boolean);
      const refreshedRows = appointmentIds.length
        ? await db('scheduled_services').whereIn('id', appointmentIds).select('*').catch((e) => {
            logger.warn(`[estimate-accept] Appointment refresh after annual prepay conversion failed: ${e.message}`);
            return [];
          })
        : [];
      if (refreshedRows.length) {
        const byId = new Map(refreshedRows.map((row) => [String(row.id), row]));
        acceptedAppointmentsToRegister = acceptedAppointmentsToRegister.map((appt) => (
          byId.get(String(appt.id)) || appt
        ));
      }
    }
    for (const appointment of acceptedAppointmentsToRegister) {
      try {
        await registerAcceptedEstimateAppointmentReminder({
          appointment,
          customerId,
          serviceType: appointment.service_type,
        });
      } catch (e) {
        logger.error(`[estimate-accept] Appointment reminder registration failed for ${appointment.id}: ${e.message}`);
      }
    }
    const deferredFollowUpReminderRows = Array.isArray(annualPrepayConversion?.deferredFollowUpReminderRows)
      ? annualPrepayConversion.deferredFollowUpReminderRows
      : [];
    for (const appointment of deferredFollowUpReminderRows) {
      try {
        await registerAcceptedEstimateAppointmentReminder({
          appointment,
          customerId,
          serviceType: appointment.service_type,
        });
      } catch (e) {
        logger.error(`[estimate-accept] Follow-up reminder registration failed for ${appointment.id}: ${e.message}`);
      }
    }
    // Annual-prepay conversion runs inside the accept transaction, so the
    // converter defers the new-recurring welcome SMS rather than send it
    // against uncommitted customer rows. Fire it here, post-commit.
    if (annualPrepayConversion?.welcomeSms) {
      const { sendNewRecurringWelcome } = require('../services/new-recurring-welcome-sms');
      void sendNewRecurringWelcome(annualPrepayConversion.welcomeSms)
        .catch((e) => logger.error(`[estimate-accept] welcome SMS failed for customer ${customerId}: ${e.message}`));
    }
    if (customerId) {
      try {
        await markLinkedLeadEstimateAccepted({
          estimateId: estimate.id,
          customerId,
          monthlyValue: treatAsOneTime ? null : effectiveMonthlyTotal,
          initialServiceValue: effectiveOneTimeTotal || estimate.onetime_total || null,
          waveguardTier: estimate.waveguard_tier || null,
        });
      } catch (e) {
        logger.error(`[estimate-accept] Linked lead conversion failed for estimate ${estimate.id}: ${e.message}`);
      }
    }

    // Send acceptance SMS to customer. Invoice-mode sends its own SMS
    // via InvoiceService.sendViaSMS later (pay link, not onboarding /
    // booking link) — so skip this branch entirely when bill_by_invoice
    // is set to avoid a double-text.
    let bookingUrl = null;
    let oneTimeBookingService = null;
    const confirmedAppointmentRow = reservationRow || (existingAppointmentId ? existingAppointmentRow : null);
    if (treatAsOneTime && !billByInvoice && !reservationCommitted) {
      oneTimeBookingService = bookingServiceFor(acceptedOneTimeServiceLabel || oneTimeList[0]?.name || '');
      const longBookingUrl = `https://portal.wavespestcontrol.com/book?service=${oneTimeBookingService.id}&source=estimate-accept`;
      bookingUrl = await shortenOrPassthrough(longBookingUrl, {
        kind: 'booking',
        entityType: 'estimates',
        entityId: estimate.id,
        customerId,
      });
    }
    if (estimate.customer_phone && !billByInvoice && treatAsOneTime) {
      try {
        if (treatAsOneTime) {
          const primarySvc = oneTimeBookingService || bookingServiceFor(acceptedOneTimeServiceLabel || oneTimeList[0]?.name || '');
          const confirmedServiceLabel = confirmationServiceLabel(oneTimeList, estimate, acceptedOneTimeServiceLabel || primarySvc.label);
          if (bookingUrl) {
            const customerBody = await renderTemplate(
              'estimate_accepted_onetime',
              { first_name: firstName, service_label: primarySvc.label, booking_url: bookingUrl },
              undefined,
              { workflow: 'estimate_accept_onetime_booking', entity_type: 'estimate', entity_id: estimate.id },
            );
            if (!customerBody) {
              logger.warn(`[estimate-accept] estimate_accepted_onetime template missing/disabled; skipping customer SMS for estimate ${estimate.id}`);
            } else {
              const sendResult = await sendCustomerMessage({
                to: estimate.customer_phone,
                body: customerBody,
                channel: 'sms',
                audience: customerId ? 'customer' : 'lead',
                purpose: 'estimate_followup',
                customerId: customerId || undefined,
                estimateId: estimate.id,
                identityTrustLevel: customerId ? 'phone_matches_customer' : 'estimate_token_verified',
                consentBasis: customerId ? undefined : {
                  status: 'transactional_allowed',
                  source: 'estimate_token_acceptance',
                  capturedAt: new Date().toISOString(),
                },
                entryPoint: 'estimate_accept_onetime_booking',
                metadata: { original_message_type: 'estimate_accepted_onetime' },
              });
              if (sendResult.blocked || sendResult.sent === false) throw new Error(`customer SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
              logger.info(`[estimate-accept] One-time booking SMS sent for estimate ${estimate.id} - ${primarySvc.label}`);
            }
          } else {
            const scheduledDate = dateOnly(confirmedAppointmentRow?.scheduled_date);
            const serviceDate = scheduledDate
              ? formatETDate(new Date(`${scheduledDate}T12:00:00Z`))
              : 'your selected date';
            const start = hhmm(confirmedAppointmentRow?.window_start);
            const end = hhmm(confirmedAppointmentRow?.window_end);
            const timeWindow = start && end ? formatSmsTimeRange(`${start}-${end}`) : 'your selected window';
            const customerBody = await renderTemplate(
              'appointment_confirmation',
              {
                first_name: firstName,
                service_type: confirmedServiceLabel,
                date: serviceDate,
                time: timeWindow,
              },
              undefined,
              { workflow: 'estimate_accept_onetime_confirmed', entity_type: 'scheduled_service', entity_id: confirmedAppointmentRow?.id || estimate.id },
            );
            if (!customerBody) {
              logger.warn(`[estimate-accept] appointment_confirmation template missing/disabled; skipping customer SMS for estimate ${estimate.id}`);
            }
            // Honor the customer's account-level New Appointment Confirmation
            // channel (sms | email | both). Default 'sms' keeps the exact prior
            // send; a lead with no customerId resolves to 'sms' as well.
            await AppointmentReminders.deliverConfirmationByChannel({
              customerId: customerId || undefined,
              scheduledServiceId: confirmedAppointmentRow?.id,
              serviceLabel: confirmedServiceLabel,
              smsAttempt: async () => {
                if (!customerBody) return false;
                const sendResult = await sendCustomerMessage({
                  to: estimate.customer_phone,
                  body: customerBody,
                  channel: 'sms',
                  audience: 'customer',
                  purpose: 'appointment_confirmation',
                  customerId: customerId || undefined,
                  appointmentId: confirmedAppointmentRow?.id,
                  estimateId: estimate.id,
                  identityTrustLevel: 'service_contact_authorized',
                  entryPoint: 'estimate_accept_onetime_confirmed',
                  metadata: { original_message_type: 'appointment_confirmation' },
                });
                if (sendResult.blocked || sendResult.sent === false) throw new Error(`customer SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
                logger.info(`[estimate-accept] One-time confirmation SMS sent for estimate ${estimate.id} - ${confirmedServiceLabel}`);
                return sendResult.sent === true;
              },
            });
          }
        } else if (annualPrepaySelected) {
          const amountText = annualPrepayDisplayAmount != null ? ` for ${fmtMoney(annualPrepayDisplayAmount)}` : '';
          const customerBody = await renderEditableSmsTemplate(
            'estimate_accepted_annual_prepay',
            {
              first_name: firstName,
              waveguard_tier: estimate.waveguard_tier || 'Bronze',
              amount_text: amountText,
            },
            { workflow: 'estimate_accept_annual_prepay', entity_type: 'estimate', entity_id: estimate.id },
          );
          if (!customerBody) {
            logger.warn(`[estimate-accept] estimate_accepted_annual_prepay SMS template missing/disabled/unrenderable; skipping customer SMS for estimate ${estimate.id}`);
          } else {
            const sendResult = await sendCustomerMessage({
              to: estimate.customer_phone,
              body: customerBody,
              channel: 'sms',
              audience: customerId ? 'customer' : 'lead',
              purpose: 'estimate_followup',
              customerId: customerId || undefined,
              estimateId: estimate.id,
              identityTrustLevel: customerId ? 'phone_matches_customer' : 'estimate_token_verified',
              consentBasis: customerId ? undefined : {
                status: 'transactional_allowed',
                source: 'estimate_token_acceptance',
                capturedAt: new Date().toISOString(),
              },
              entryPoint: 'estimate_accept_annual_prepay',
              metadata: { original_message_type: 'estimate_accepted_annual_prepay' },
            });
            if (sendResult.blocked || sendResult.sent === false) throw new Error(`customer SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
            logger.info(`[estimate-accept] Annual prepay acceptance SMS sent for estimate ${estimate.id}`);
          }
        }
        // Standard recurring accepts no longer send a separate acceptance SMS;
        // the onboarding handoff text was retired with the onboarding flow.
        // Customers continue through the invoice/pay-link path below.
      } catch (e) { logger.error(`[estimate-accept] Acceptance SMS failed: ${e.message}`); }
    }

    if (invoiceId && (billByInvoice || annualPrepaySelected)) {
      try {
        const InvoiceService = require('../services/invoice');
        const delivery = await InvoiceService.sendViaSMSAndEmail(invoiceId, {
          payUrlParams: estimateInvoicePayUrlParams({
            billingTerm,
            saveCard: !treatAsOneTime,
          }),
        });
        if (delivery?.payUrl) invoicePayUrl = delivery.payUrl;
        if (delivery?.ok) {
          invoiceLinkDelivered = true;
        } else {
          const errors = [
            delivery?.sms?.error && `sms: ${delivery.sms.error}`,
            delivery?.email?.error && `email: ${delivery.email.error}`,
          ].filter(Boolean).join(' | ');
          logger.error(`[estimate-accept] Invoice delivery failed: ${errors || 'unknown error'}`);
        }
      } catch (deliveryErr) {
        logger.error(`[estimate-accept] Invoice delivery failed: ${deliveryErr.message}`);
      }
      logger.info(`[estimate-accept] Invoice-mode invoice ${invoiceId} created for estimate ${estimate.id} — $${invoiceAmount}; delivery=${invoiceLinkDelivered ? 'sent' : 'failed'}`);
    }

    // Auto-convert estimate to active customer (Feature #5). Skip entirely
    // when this is a one-time booking — EstimateConverter creates recurring
    // scheduled_services rows + upgrades the customer's WaveGuard tier +
    // marks them active_customer. None of that applies for a single-visit
    // one-time booking. Reservation row (if any) already holds the slot.
    if (customerId && !treatAsOneTime && !annualPrepaySelected) {
      try {
        const EstimateConverter = require('../services/estimate-converter');
        // In invoice-mode we generated the invoice inside the accept
        // transaction. Suppress converter setup/prepay invoices to avoid
        // duplicates.
        const conversion = await EstimateConverter.convertEstimate(estimate.id, {
          billingTerm,
          // Commercial schedules + invoices manually (owner directive): never
          // auto-schedule a wrong-length visit and never auto-create/send an
          // invoice before the on-site scope confirmation.
          skipSetupInvoice: billByInvoice || isCommercialAccept,
          skipAutoSchedule: isCommercialAccept,
          prepayInvoiceAmount: annualPrepayInvoiceAmount,
          // Commercial (standard) bills manually — create NO auto first-
          // application invoice (which would also mis-tax a mixed plan); the team
          // invoices after on-site confirmation. The commercial customer is
          // marked property_type='commercial' by the converter so that manual
          // invoice taxes the taxable services (pest) correctly.
          firstApplicationAmount: isCommercialAccept ? null : firstApplicationInvoiceAmount,
          allowFirstApplicationFallback: false,
          autoSendInvoice: !isCommercialAccept,
        });
        if (conversion?.draftInvoiceId) {
          invoiceMode = true;
          invoiceId = conversion.draftInvoiceId;
          invoiceAmount = conversion.draftInvoiceAmount || null;
          invoicePayUrl = conversion.draftInvoicePayUrl || null;
          invoiceLinkDelivered = !!conversion.invoiceDelivery?.ok;
        }
        logger.info(`[estimate-accept] Auto-conversion completed for estimate ${estimate.id} (billingTerm=${billingTerm}, invoiceMode=${billByInvoice})`);
      } catch (e) {
        logger.error(`[estimate-accept] Auto-conversion failed: ${e.message}`);
        if (annualPrepaySelected) {
          return res.status(500).json({
            error: 'Annual prepay setup could not be completed. Please contact the office so we can finish your prepay invoice.',
            billingTerm,
          });
        }
      }
    } else if (customerId && treatAsOneTime) {
      logger.info(`[estimate-accept] Skipped EstimateConverter for estimate ${estimate.id} (one-time booking)`);
    }

    // Third-party Bill-To: never advertise a payer-billed invoice to the
    // homeowner. InvoiceService.create() and the EstimateConverter auto-resolve a
    // default payer, so the FINAL invoice from any path above may be payer-billed
    // — it was emailed to the payer AP (sendViaSMSAndEmail already suppressed the
    // homeowner SMS). Null the customer pay URL AND flag the accept as
    // payer-billed so the success/notification builders don't promise a pay link
    // or a pay_invoice next-step the homeowner can't use (they get the report;
    // nothing is due from them). invoiceMode/invoiceLinkDelivered stay intact so
    // the ADMIN copy still correctly reflects that the invoice was sent.
    let invoiceIsPayerBilled = false;
    if (invoiceId) {
      let payerCheck = null;
      try {
        payerCheck = await db('invoices').where({ id: invoiceId }).first('payer_id');
      } catch (e) {
        // Fail closed: if we can't verify the final invoice's payer status, do
        // NOT leave a homeowner pay URL that might be the payer's bearer
        // /pay/:token. Suppressing a genuine self-pay link on a rare read error
        // is recoverable (the customer pays from the portal billing tab); leaking
        // the payer's token is not. pay_invoice is gated on the URL client-side,
        // so nulling it also drops the spurious next-step.
        invoicePayUrl = null;
        logger.warn(`[estimate-accept] payer status check failed for invoice ${invoiceId}; failing closed (suppressed pay URL): ${e.message}`);
      }
      if (payerCheck?.payer_id) {
        invoiceIsPayerBilled = true;
        invoicePayUrl = null;
      }
    }

    // Exempt-path deposit sweep: the customer paid a deposit and then
    // accepted through a path that owes none (switched to prepay-annual, or
    // membership made them exempt). The webhook's staleness gate only
    // catches money that lands AFTER acceptance — money recorded BEFORE an
    // exempt accept would otherwise sit on the ledger forever. Refund it.
    // Required paths never sweep: their unapplied remainder rolls forward
    // to the next service-record invoice. Post-commit and best-effort —
    // failures alert + leave the truth on the ledger.
    //
    // Third-party Bill-To also sweeps: a deposit-policy exemption only fires
    // when the estimate's customer is KNOWN at policy time. An unlinked estimate
    // can be matched to an existing payer customer during accept — the deposit
    // was required + collected, but the customer is payer-billed and every
    // invoice they ever get (now or at a future visit) skips homeowner deposit
    // credit, so the money would strand. Resolve payer status from the FINAL
    // bound customer, not just the accept-time invoice: a one-time / pay-at-visit
    // payer accept creates no invoice now (the invoice is the completed-visit one
    // via createFromService), so invoiceIsPayerBilled stays false. Refund here
    // rather than roll forward. resolveForInvoice fails soft to self-pay; on a
    // miss we skip the refund (the deposit still rolls forward as before).
    let customerIsPayerBilled = invoiceIsPayerBilled;
    if (!customerIsPayerBilled && customerId) {
      try {
        const PayerService = require('../services/payer');
        // throwOnError: this is the only post-accept path that refunds a deposit
        // collected before the customer was known. A fail-soft lookup error would
        // collapse to self-pay, skip the refund, and strand a payer-billed deposit
        // indefinitely (accepted estimates are never terminal-swept). Re-throw and
        // log at ERROR so the unresolved deposit surfaces for reconciliation
        // rather than vanishing silently.
        const resolvedSweepPayer = await PayerService.resolveForInvoice({ customerId, scheduledServiceId: acceptLinkedSsId, throwOnError: true });
        customerIsPayerBilled = !!resolvedSweepPayer?.payerId;
      } catch (e) {
        logger.error(`[estimate-accept] payer resolve for deposit sweep failed (customer ${customerId}, estimate ${estimate.id}) — deposit left on ledger for reconciliation: ${e.message}`);
      }
    }
    const payerBilledSweep = customerIsPayerBilled && depositPolicy.required;
    if ((depositPolicy.enforced && !depositPolicy.required) || payerBilledSweep) {
      try {
        const { refundUnconsumedDeposits } = require('../services/estimate-deposits');
        await refundUnconsumedDeposits({
          estimateId: estimate.id,
          reason: payerBilledSweep ? 'payer_billed_accept' : `exempt_accept:${depositPolicy.exemptReason || 'unknown'}`,
        });
      } catch (e) {
        logger.error(`[estimate-accept] exempt-path deposit sweep failed for estimate ${estimate.id}: ${e.message}`);
      }
    }

    // In-app notifications for estimate accepted. Invoice-mode copy uses
    // invoiceMode, not billByInvoice, so we don't promise a pay link if
    // invoice creation/send failed or was skipped for a zero amount.
    try {
      const NotificationService = require('../services/notification-service');
      // Detect an all-commercial recurring accept so the copy says "Commercial
      // service plan", not a WaveGuard tier. Public-quote commercial drafts
      // don't set estimate.waveguard_tier, so it would otherwise default Bronze.
      let acceptTierLabel = estimate.waveguard_tier || 'Bronze';
      try {
        const EstimateConverter = require('../services/estimate-converter');
        const acceptRecurring = EstimateConverter.recurringServicesFromEstimateData(parseEstimateDataSafe(estimate) || {});
        // Mirror the converter's commercialOnlyRecurring predicate: a commercial
        // recurring line with NO WaveGuard-qualifying service is a Commercial
        // non-member plan — even alongside a non-qualifying add-on (e.g. foam).
        const hasCommercial = acceptRecurring.some((svc) =>
          String(svc.service || svc.name || '').toLowerCase().includes('commercial'));
        const qualifyingCount = EstimateConverter.countTierQualifyingRecurringServices(acceptRecurring);
        if (hasCommercial && qualifyingCount === 0) {
          acceptTierLabel = 'Commercial';
        }
      } catch { /* fall back to the estimate tier */ }
      const notificationPayload = buildAcceptNotificationPayload({
        customerName: estimate.customer_name,
        waveguardTier: acceptTierLabel,
        monthlyTotal: effectiveMonthlyTotal || estimate.monthly_total,
        serviceLabel: invoiceServiceLabel || acceptedOneTimeServiceLabel || oneTimeList[0]?.name || 'One-time service',
        treatAsOneTime,
        billByInvoice,
        invoiceMode,
        invoiceLinkDelivered,
        invoicePayUrl,
        payerBilled: invoiceIsPayerBilled,
        reservationCommitted,
        bookingUrl,
        billingTerm,
        annualPrepayAmount: annualPrepayDisplayAmount,
      });
      await NotificationService.notifyAdmin('estimate', notificationPayload.adminTitle, notificationPayload.adminBody, { icon: '\u2705', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId, invoiceId } });
      if (customerId) {
        await NotificationService.notifyCustomer(customerId, 'account', notificationPayload.customerTitle, notificationPayload.customerBody, { icon: '\u2705', link: notificationPayload.customerLink, metadata: { estimateId: estimate.id, invoiceId } });
      }
    } catch (e) { logger.error(`[notifications] Estimate accepted notification failed: ${e.message}`); }

    // Customer-facing accepts should get the same admin phone workflow as a
    // quote request: call Adam from a Waves number during business hours, then
    // auto-bridge to the customer when the leadAutoBridge gate is enabled.
    // Admin "mark won" uses server/routes/admin-estimates.js and does not
    // pass through this public route.
    try {
      await triggerAdminFollowupCall({
        customerId,
        customerName: estimate.customer_name,
        customerPhone: estimate.customer_phone,
        address: estimate.address,
        source: 'estimate-accept',
        eventLabel: 'Estimate accepted',
        sourceLabel: buildAcceptOfficeFallback({
          customerName: estimate.customer_name,
          address: estimate.address,
          waveguardTier: estimate.waveguard_tier || 'Bronze',
          monthlyTotal: effectiveMonthlyTotal || estimate.monthly_total,
          serviceLabel: invoiceServiceLabel || acceptedOneTimeServiceLabel || oneTimeList[0]?.name || 'One-time service',
          treatAsOneTime,
          billByInvoice,
          invoiceMode,
          invoiceLinkDelivered,
          invoicePayUrl,
          reservationCommitted,
          billingTerm,
          annualPrepayAmount: annualPrepayDisplayAmount,
        }),
      });
    } catch (e) {
      logger.error(`[estimate-accept] Admin follow-up call failed: ${e.message}`);
    }

    res.json(buildAcceptSuccessPayload({
      invoiceMode,
      invoiceLinkDelivered,
      invoiceId,
      invoiceAmount,
      invoicePayUrl,
      payerBilled: invoiceIsPayerBilled,
      invoiceKind,
      invoiceServiceLabel,
      billingTerm,
      prepayInvoiceAmount: annualPrepayDisplayAmount,
      bookingUrl,
      treatAsOneTime,
      reservationCommitted,
    }));
  } catch (err) {
    // Translate user-visible 4xx errors thrown from inside the transaction
    // (e.g. reservation expiring between the pre-tx check and the commit).
    if (err && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// PUT /api/estimates/:token/select-tier — customer selects a WaveGuard tier
router.put('/:token/select-tier', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!isEstimateAcceptActive(estimate)) return res.status(400).json({ error: 'Estimate is no longer active' });
    // Reconcile before this handler recomputes + persists, so a stale
    // "existing customer" classification isn't written back into estimate_data.
    await reconcileFrozenMembershipSnapshot(estimate);

    const { selectedTier } = req.body;
    const ALLOWED_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];
    if (!selectedTier || !ALLOWED_TIERS.includes(selectedTier)) {
      return res.status(400).json({ error: 'selectedTier must be one of: ' + ALLOWED_TIERS.join(', ') });
    }

    const previousTier = estimate.waveguard_tier || 'Bronze';

    // Server-side pricing — never trust client totals.
    let parsedData = {};
    try { parsedData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {}); }
    catch { parsedData = {}; }

    // Resolve base via the shared helper. Critical here: an unguarded
    // fallback to estimate.monthly_total compounds the discount (Silver→
    // Platinum on $90 gives $72 instead of the correct $80 from a $100
    // base). The helper prefers explicit baseMonthly → engine-derived →
    // summed → discounted-fallback. We persist the derived value back
    // below so the next tier flip on this row is a no-op for resolution.
    const recurringMonthlyParts = resolveRecurringMonthlyParts(estimate, parsedData);
    const { baseMonthly, source: baseSource } = recurringMonthlyParts;
    const manualMonthlyOff = manualDiscountMonthlyAmount(parsedData);
    const monthlyTotal = monthlyForRecurringParts(
      recurringMonthlyParts,
      selectedTier,
      manualMonthlyOff,
      (tierName) => tierDiscountForEstimate(parsedData, tierName),
    );
    const annualTotal = Math.max(0, Math.round(monthlyTotal * 12 * 100) / 100);

    // Self-heal estimate_data.baseMonthly when we resolved it from the
    // engine result or summed services. Doesn't write when source is
    // 'explicit' (no change) or 'fallback-discounted' (unsafe to persist
    // a discounted value as if it were a base).
    const shouldPersistPricingBlob = invalidateSendSnapshotPricingBundle(parsedData);
    const writes = {
      waveguard_tier: selectedTier,
      monthly_total: monthlyTotal,
      annual_total: annualTotal,
      updated_at: db.fn.now(),
    };
    let shouldPersistEstimateData = shouldPersistPricingBlob;
    if ((baseSource === 'engine' || baseSource === 'summed') && baseMonthly > 0
        && Number(parsedData.baseMonthly || 0) !== baseMonthly) {
      parsedData.baseMonthly = baseMonthly;
      shouldPersistEstimateData = true;
    }
    if (shouldPersistEstimateData) {
      writes.estimate_data = JSON.stringify(parsedData);
    }
    // TOCTOU guard: isEstimateAcceptActive() above ran on a pre-read. A
    // concurrent accept commits status='accepted' + price_locked_at, and
    // EstimateConverter re-reads the row AFTER that commit — an unconditional
    // write here would clobber the locked price into customers.monthly_rate.
    // Mirror the accept transaction's status guard on the UPDATE itself and
    // bail if the row was accepted/locked in the meantime.
    const tierUpdateCount = await db('estimates')
      .where({ id: estimate.id })
      .whereNotIn('status', ['accepted', 'declined', 'expired', 'send_failed', 'draft', 'scheduled'])
      .whereNull('price_locked_at')
      .update(writes);
    if (!tierUpdateCount) {
      return res.status(409).json({ error: 'Estimate is no longer active' });
    }

    // Notify admin of tier selection
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate',
        `Tier upgrade: ${estimate.customer_name}`,
        `Selected ${selectedTier} (was ${previousTier}) \u2014 $${monthlyTotal}/mo`,
        { icon: '\u2B06\uFE0F', link: '/admin/estimates', metadata: { estimateId: estimate.id } }
      );
    } catch (e) { logger.error(`[estimate] Tier selection notification failed: ${e.message}`); }

    logger.info(`[estimate] ${estimate.customer_name} selected ${selectedTier} tier (was ${previousTier}) — $${monthlyTotal}/mo`);
    res.json({ success: true, tier: selectedTier, monthlyTotal, annualTotal });
  } catch (err) { next(err); }
});

// PUT /api/estimates/:token/preferences — customer toggles a service preference
// (interior_spray / exterior_sweep) on the public estimate page. Persists the
// new preference to estimate_data.preferences, recomputes monthly / annual /
// one-time totals, updates the row, and returns a fresh price payload for
// client-side re-render.
router.put('/:token/preferences', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!isEstimateAcceptActive(estimate)) return res.status(400).json({ error: 'Estimate is no longer active' });
    // Reconcile before this handler recomputes + persists, so a stale
    // "existing customer" classification isn't written back into estimate_data.
    await reconcileFrozenMembershipSnapshot(estimate);

    // Only accept known pref keys; coerce to boolean.
    const patch = {};
    for (const k of SERVICE_PREF_KEYS) {
      if (k in (req.body || {})) patch[k] = req.body[k] !== false;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'No valid preference fields provided' });
    }

    let parsedData = {};
    try { parsedData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {}); }
    catch { parsedData = {}; }

    const nextPrefs = normalizePrefs({ ...(parsedData.preferences || {}), ...patch });

    const estResult = parsedData.result || parsedData || {};
    const recurring = recurringServicesWithSupplements(estResult);
    const oneTimeItems = [...(estResult?.oneTime?.items || []), ...(estResult?.oneTime?.specItems || [])];
    const pestRecurring = detectPestRecurring(recurring);
    const hasPestOneTime = detectPestOneTime(oneTimeItems);
    const pestOneTimeTotal = hasPestOneTime ? pestOneTimeBase(oneTimeItems) : 0;
    // The interior-spray / exterior-sweep preferences only apply to RESIDENTIAL
    // pest (recurring or one-time). With no residential pest line there's nothing
    // to discount — no-op so a commercial-only estimate can't persist a lower
    // total via these toggles. (The pref card isn't rendered for it either.)
    if (!pestRecurring && !hasPestOneTime) {
      return res.status(400).json({ error: 'Service preferences are not available for this estimate' });
    }

    // baseMonthly resolution via shared helper (see resolveBaseMonthly).
    // Persisted back to estimate_data.baseMonthly below so subsequent
    // toggles + tier flips on this row are a no-op for resolution.
    const recurringMonthlyParts = resolveRecurringMonthlyParts(estimate, parsedData);
    const { baseMonthly: resolvedBaseMonthly } = recurringMonthlyParts;
    const baseMonthly = estimate.show_one_time_option && Number(pestRecurring?.monthlyBase || 0) > 0
      ? Number(pestRecurring.monthlyBase || 0)
      : resolvedBaseMonthly;

    const currentTier = estimate.waveguard_tier || 'Bronze';
    const savedDiscount = Number(parsedData?.result?.recurring?.discount);
    const preferenceDiscountResolver = (tierName) => tierDiscountForEstimate(
      parsedData,
      tierName,
      tierName === currentTier && Number.isFinite(savedDiscount) ? savedDiscount : null,
    );
    const currentDiscount = preferenceDiscountResolver(currentTier);

    const { monthlyOff, oneTimeOff } = computePrefDiscount(nextPrefs, pestRecurring, hasPestOneTime, pestOneTimeTotal);
    const manualMonthlyOff = manualDiscountMonthlyAmount(parsedData);
    const recurringMonthlyBeforeManualAndPrefs = estimate.show_one_time_option && Number(pestRecurring?.monthlyBase || 0) > 0
      ? Math.max(0, Math.round(baseMonthly * (1 - currentDiscount) * 100) / 100)
      : monthlyForRecurringParts(recurringMonthlyParts, currentTier, 0, preferenceDiscountResolver);
    const monthlyTotal = estimate.show_one_time_option && Number(pestRecurring?.monthlyBase || 0) > 0
      ? Math.max(0, Math.round((baseMonthly * (1 - currentDiscount) - manualMonthlyOff - monthlyOff) * 100) / 100)
      : monthlyForRecurringParts(recurringMonthlyParts, currentTier, manualMonthlyOff + monthlyOff, preferenceDiscountResolver);
    const annualTotal  = Math.max(0, Math.round(monthlyTotal * 12 * 100) / 100);
    const derivedOneTimeChoiceBase = estimate.show_one_time_option
      ? oneTimeChoiceAmountForEstimate(
          { ...estimate, estimate_data: parsedData },
          { ...parsedData, preferences: nextPrefs },
          null,
        )
      : null;
    const onetimeBase = Number(derivedOneTimeChoiceBase || parsedData.onetimeTotalBase || estimate.onetime_total || 0);
    const onetimeTotal = Math.max(0, Math.round((onetimeBase - oneTimeOff) * 100) / 100);
    const tierPrices = {};
    ['Bronze', 'Silver', 'Gold', 'Platinum'].forEach((t) => {
      tierPrices[t] = estimate.show_one_time_option && Number(pestRecurring?.monthlyBase || 0) > 0
        ? Math.max(0, Math.round((baseMonthly * (1 - preferenceDiscountResolver(t)) - manualMonthlyOff - monthlyOff) * 100) / 100)
        : monthlyForRecurringParts(recurringMonthlyParts, t, manualMonthlyOff + monthlyOff, preferenceDiscountResolver);
    });

    // Persist — merge new prefs + self-healed baseMonthly back onto the blob.
    parsedData.preferences = nextPrefs;
    if (baseMonthly > 0) parsedData.baseMonthly = baseMonthly;
    invalidateSendSnapshotPricingBundle(parsedData);
    // TOCTOU guard: same as select-tier above — the accept-active check ran
    // on a pre-read, so the UPDATE itself must refuse rows that a concurrent
    // accept has locked (status flip + price_locked_at), or the recomputed
    // totals here would overwrite the frozen accepted price.
    const prefUpdateCount = await db('estimates')
      .where({ id: estimate.id })
      .whereNotIn('status', ['accepted', 'declined', 'expired', 'send_failed', 'draft', 'scheduled'])
      .whereNull('price_locked_at')
      .update({
        estimate_data: JSON.stringify(parsedData),
        monthly_total: monthlyTotal,
        annual_total: annualTotal,
        onetime_total: onetimeTotal,
        updated_at: db.fn.now(),
      });
    if (!prefUpdateCount) {
      return res.status(409).json({ error: 'Estimate is no longer active' });
    }
    clearEstimatePricingCache(estimate.id);

    // Per-row metadata for client re-render (off-desc + savings label)
    const prefMeta = {};
    for (const k of SERVICE_PREF_KEYS) {
      const cfg = SERVICE_PREFS[k];
      let savingsLabel = '';
      if (pestRecurring && hasPestOneTime) {
        const rec = Math.round(((cfg.perVisit * pestRecurring.visitsPerYear) / 12) * 100) / 100;
        const freqKey = frequencyKeyFromVisitsPerYear(pestRecurring.visitsPerYear);
        const intervalSavings = intervalPriceFromMonthly(rec, freqKey);
        savingsLabel = `Save $${intervalSavings.toFixed(intervalSavings % 1 ? 2 : 0)}${pricePeriodLabelForFrequencyKey(freqKey)} + $${cfg.oneTime} on one-time`;
      } else if (pestRecurring) {
        const rec = Math.round(((cfg.perVisit * pestRecurring.visitsPerYear) / 12) * 100) / 100;
        const freqKey = frequencyKeyFromVisitsPerYear(pestRecurring.visitsPerYear);
        const intervalSavings = intervalPriceFromMonthly(rec, freqKey);
        savingsLabel = `Save $${intervalSavings.toFixed(intervalSavings % 1 ? 2 : 0)}${pricePeriodLabelForFrequencyKey(freqKey)}`;
      } else if (hasPestOneTime) {
        savingsLabel = `Save $${cfg.oneTime}`;
      }
      prefMeta[k] = { offDesc: cfg.offDesc, savingsLabel };
    }

    const savingsPerMo = Math.max(0, Math.round((baseMonthly - recurringMonthlyBeforeManualAndPrefs) * 100) / 100);

    logger.info(`[estimate] ${estimate.customer_name} toggled ${Object.keys(patch).join(', ')} -> ${JSON.stringify(patch)} ($${monthlyTotal}/mo)`);
    res.json({
      success: true,
      preferences: nextPrefs,
      baseMonthly,
      monthlyTotal,
      annualTotal,
      onetimeTotal,
      prefMonthlyOff: monthlyOff,
      tierPrices,
      savingsPerMo,
      prefMeta,
    });
  } catch (err) { next(err); }
});

// POST /api/estimates/:token/bundle-inquiry — customer requests an add-on.
// Creates a durable service request, sends customer confirmation, notifies
// the team, and stores any pricing attempt as a draft revision only.
router.post('/:token/bundle-inquiry', addServiceRequestLimiter, async (req, res, next) => {
  try {
    const result = await createEstimateAddServiceRequest({
      estimateToken: req.params.token,
      // Prefer the human-readable label (suggestedService) over the bare
      // service key — both normalize to the same key, but only the label
      // carries seasonal intent ("Seasonal Mosquito" → seasonal9 draft).
      requestedService: req.body?.suggestedService || req.body?.requestedService,
    });
    res.status(result.deduped ? 200 : 201).json(result);
  } catch (err) {
    const status = Number(err.statusCode || err.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || 'Request could not be processed' });
    }
    next(err);
  }
});

// PUT /api/estimates/:token/decline
router.put('/:token/decline', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    const guard = resolveEstimateDeclineGuard(estimate);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    if (guard.alreadyDeclined) return res.json({ success: true, alreadyDeclined: true });

    const declinedCount = await db('estimates')
      .where({ id: estimate.id })
      .whereNotIn('status', ['accepted', 'declined', 'expired', 'send_failed', 'draft', 'scheduled'])
      .andWhere((q) => q.whereNull('expires_at').orWhere('expires_at', '>=', db.raw('NOW()')))
      .update({ status: 'declined', declined_at: db.fn.now(), updated_at: db.fn.now() });
    if (!declinedCount) {
      const fresh = await db('estimates').where({ id: estimate.id }).first('status', 'expires_at');
      const freshGuard = resolveEstimateDeclineGuard(fresh);
      if (freshGuard.alreadyDeclined) return res.json({ success: true, alreadyDeclined: true });
      return res.status(409).json({ error: 'Estimate is no longer active' });
    }

    // Refund any acceptance deposit the customer paid before declining \u2014
    // post-commit and best-effort (the daily terminal-estimate sweep in
    // estimate-expiration is the self-healing backstop). Without this, a
    // paid-then-declined deposit has no refund path and strands on the
    // ledger.
    try {
      const { refundUnconsumedDeposits } = require('../services/estimate-deposits');
      await refundUnconsumedDeposits({ estimateId: estimate.id, reason: 'estimate_declined' });
    } catch (e) {
      logger.error(`[estimate-decline] deposit refund sweep failed for estimate ${estimate.id}: ${e.message}`);
    }

    // Notify admin of declined estimate
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate', `Estimate declined: ${estimate.customer_name}`, `${estimate.address || 'no address'} \u2014 $${estimate.monthly_total || 0}/mo`, { icon: '\u274C', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } });
    } catch (e) { logger.error(`[notifications] Estimate declined notification failed: ${e.message}`); }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/estimates/:token/data — JSON shape for the React v2 view
// =========================================================================
// Same-origin auth model as the HTML handler: token is the only gate.
// Ported view-side-effects:
//   - view_count++ + last_viewed_at + estimate_views row: every real customer
//     200. Bot scanners, link previews, admin-cookie previews, and admin IPs
//     are filtered out.
//   - First-view transition (status='sent' → 'viewed', viewed_at stamp,
//     admin in-app notification): fires only when viewed_at IS NULL AND the
//     request passes the same real-customer-view gate. Keeps preview clicks
//     from triggering "customer just opened" alerts.
//
// Admin allowlist: WAVES_ADMIN_IPS env var, comma-separated. Unset =
// fire-for-everyone (fail open — matches current HTML behavior).
//
// Pricing recompute: runs the engine once per active pest-capable frequency
// (quarterly / bi_monthly / monthly — engine supports 3 today; 5-stop
// slider waits on Waves deciding an every_6_weeks discount). Cached per
// estimateId 10 min.

const ADMIN_IP_ALLOWLIST = (process.env.WAVES_ADMIN_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const FREQUENCY_LADDER = [
  { key: 'quarterly',  label: 'Quarterly',   engineFrequency: 'quarterly' },
  { key: 'bi_monthly', label: 'Bi-monthly',  engineFrequency: 'bimonthly' },
  { key: 'monthly',    label: 'Monthly',     engineFrequency: 'monthly' },
];

function extractRequestIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '')
    .toString().split(',')[0].trim();
  return raw.slice(0, 64);
}

function isAdminIp(ip) {
  if (!ip || !ADMIN_IP_ALLOWLIST.length) return false;
  return ADMIN_IP_ALLOWLIST.includes(ip);
}

// Derive engine inputs from stored estimate_data. Admin-UI estimates
// carry { inputs, result, ... } (v1 client-engine shape). IB-sourced
// estimates carry { engineInputs, engineResult }. Either works.
function extractEngineInputs(estData) {
  if (!estData || typeof estData !== 'object') return null;
  const base = (estData.engineInputs && typeof estData.engineInputs === 'object')
    ? estData.engineInputs
    : (estData.inputs && typeof estData.inputs === 'object')
      ? estData.inputs
      : null;
  if (!base) return null;
  // Existing-customer reprice: replay the prior qualifying services persisted at
  // save so any public recompute (bundle CTA, frequency slider) keeps the
  // COMBINED WaveGuard tier instead of reverting to this estimate's services
  // alone. Shallow copy so the stored object isn't mutated.
  if (Array.isArray(estData.priorQualifyingServices) && estData.priorQualifyingServices.length) {
    return { ...base, priorQualifyingServices: estData.priorQualifyingServices };
  }
  return base;
}

function canVaryPestFrequency(engineInputs) {
  return !!engineInputs?.services?.pest;
}

// Convert one generateEstimate result into the frequency ladder entry
// shape the React view consumes.
function shapeFrequencyEntry(ladder, engineResult, engineInputs) {
  const summary = engineResult?.summary || {};
  const lineItems = Array.isArray(engineResult?.lineItems) ? engineResult.lineItems : [];

  // "included" checklist: every service on the line-item list counts as
  // included AT this frequency. For v1 we treat it as a flat boolean
  // ladder — each frequency's checklist is the line items emitted by
  // running the engine at that frequency. If a service disappears at
  // a lower frequency (engine drops it), it simply doesn't appear.
  const included = lineItems
    .filter((li) => li && (li.service || li.name))
    .map((li) => ({
      key: li.service || li.name,
      label: li.displayName || li.service || li.name,
      detail: li.note || li.frequency || null,
      includedAtThisFrequency: true,
    }));

  // Add-ons: treat line items as add-ons ONLY if the defaults config
  // explicitly marks any for pre-check. If nothing's pre-checked for this
  // frequency, return an empty list so the customer-facing AddOnsBlock
  // hides entirely (avoids surfacing already-included services as fake
  // "toggles"). True add-on catalog for v1 estimates is a follow-up.
  const preCheckedKeys = new Set(addonDefaults[ladder.key] || []);
  const hasPreChecked = included.some((item) => preCheckedKeys.has(item.key));
  const addOns = hasPreChecked
    ? included.map((item) => ({
        ...item,
        preChecked: preCheckedKeys.has(item.key),
      }))
    : [];

  const monthly = summary.recurringMonthlyAfterDiscount ?? null;
  const annual = summary.recurringAnnualAfterDiscount ?? null;
  const onetime = summary.oneTimeTotal ?? null;
  const manualDiscount = summary.manualDiscount && Number(summary.manualDiscount.amount) > 0
    ? {
        ...summary.manualDiscount,
        // monthlyAmount is the per-month recurring figure, so it tracks only the
        // recurring slice; the one-time slice is reflected in the one-time total.
        monthlyAmount: Math.round(
          (Number(summary.manualDiscount.recurringAmount ?? summary.manualDiscount.amount) / 12) * 100,
        ) / 100,
      }
    : null;

  // Per-treatment breakdown — pull perApp/visitsPerYear off each recurring
  // line item the engine emitted. Labels match the displayed service name;
  // visitsPerYear may sit under several aliases depending on the line item
  // (mosquito uses `visits`, T&S uses `frequency`; palm and rodent bait
  // are separate recurring lines that do not receive WaveGuard percentage
  // discounts).
  const RECURRING_LINE_SERVICES = new Set(['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'termite_bait', 'palm_injection', 'rodent_bait', 'foam_recurring', 'commercial_lawn', 'commercial_tree_shrub', 'commercial_pest', 'commercial_mosquito', 'commercial_termite_bait', 'commercial_rodent_bait']);
  const labelForRecurring = (svc) => {
    switch (svc) {
      case 'pest_control': return 'Pest Control';
      case 'lawn_care': return 'Lawn Care';
      case 'tree_shrub': return 'Tree & Shrub';
      case 'mosquito': return 'Mosquito';
      case 'termite_bait': return 'Termite Bait';
      case 'palm_injection': return 'Palm Injection';
      case 'rodent_bait': return 'Rodent Bait Stations';
      case 'foam_recurring': return 'Recurring Foam Treatment';
      default: return svc;
    }
  };
  const perServiceTreatments = lineItems
    .filter((li) => li && RECURRING_LINE_SERVICES.has(li.service))
    .map((li) => {
      const visits = Number(li.visitsPerYear ?? li.visits ?? li.frequency ?? li.appsPerYear);
      const netAnnual = firstPositiveNumber(li.annualAfterCredits, li.annualAfterDiscount, li.annual);
      const netPerTreatment = Number.isFinite(visits) && visits > 0 && netAnnual
        ? netAnnual / visits
        : null;
      const netPriceFirst = !recurringServiceReceivesTierDiscount(li) && netPerTreatment;
      const explicitPerTreatment = Number(li.perApp ?? li.perVisit);
      const pa = netPriceFirst
        || (Number.isFinite(explicitPerTreatment) && explicitPerTreatment > 0 ? explicitPerTreatment : netPerTreatment);
      const displayPrice = Number.isFinite(netPerTreatment) && netPerTreatment > 0
        ? Math.round(netPerTreatment * 100) / 100
        : (Number.isFinite(pa) && pa > 0 ? Math.round(pa * 100) / 100 : null);
      return {
        service: li.service,
        label: li.displayName || li.name || labelForRecurring(li.service),
        perTreatment: Number.isFinite(pa) && pa > 0 ? pa : null,
        displayPrice,
        visitsPerYear: Number.isFinite(visits) && visits > 0 ? visits : null,
        estimatedDurationMinutes: firstPositiveNumber(li.estimatedDurationMinutes, li.estimated_duration_minutes) || null,
        // Carry the per-service cadence (foam has its own, e.g. bimonthly) so a
        // mixed plan whose top-level frequency is the generic quarterly ladder
        // row still surfaces/seeds each service at its sold cadence.
        cadence: li.cadence || null,
        frequencyKey: li.cadence || li.frequencyKey || null,
        waveGuardDiscountEligible: recurringServiceReceivesTierDiscount(li),
      };
    });
  const sameDayTreatmentTotal = perServiceTreatments.reduce(
    (sum, row) => sum + (Number.isFinite(row.perTreatment) ? row.perTreatment : 0),
    0,
  );

  return {
    key: ladder.key,
    label: ladder.label,
    monthly: monthly != null ? Number(monthly) : null,
    annual: annual != null ? Number(annual) : null,
    perVisit: lineItems.find((li) => li?.service === 'pest_control')?.perApp ?? null,
    oneTimeTotal: onetime != null ? Number(onetime) : null,
    manualDiscount,
    included,
    addOns,
    perServiceTreatments,
    sameDayTreatmentTotal: Math.round(sameDayTreatmentTotal * 100) / 100,
  };
}

// v1 client-engine shape — the admin UI's deprecated estimateEngine.js
// stores results under estimate_data.result with pre-computed pestTiers
// for all three frequencies. When present, use those directly instead of
// trying to re-run the modular server engine (whose input shape is
// incompatible with v1's flat `svcPest:true, pestFreq:"4"` flags).
//
// Returns null if this isn't a v1-shape estimate. Caller falls back to
// engine-invocation path (modular engine / IB path / etc).
const V1_LABEL_TO_LADDER = {
  'Quarterly':  { key: 'quarterly',  label: 'Quarterly' },
  'Bi-Monthly': { key: 'bi_monthly', label: 'Bi-monthly' },
  'Monthly':    { key: 'monthly',    label: 'Monthly' },
};

// Pull the auto-fired Initial Roach Knockdown line item out of the saved
// estimate data so the public estimate view can surface it as a first-visit
// fee separate from the general one-time bucket. Matches by canonical service
// key first; falls back to a name regex for older cached payloads written
// before v1-legacy-mapper started preserving `service` on its output items.
// Returns null if not present.
const ROACH_NAME_RX = /initial.*(palmetto|german|roach).*knockdown/i;

function oneTimeItemSearchText(item = {}) {
  return [
    item.service,
    item.key,
    item.label,
    item.displayName,
    item.name,
  ].filter(Boolean).join(' ').toLowerCase().replace(/[_-]+/g, ' ');
}

function oneTimeItemAmount(item = {}) {
  const raw = Number(item.amount ?? item.price ?? item.total);
  const discounted = Number(item.priceAfterDiscount ?? item.totalAfterDiscount);
  const amount = Number.isFinite(raw) && raw < 0
    ? (Number.isFinite(discounted) && discounted !== 0 ? discounted : raw)
    : (Number.isFinite(discounted) ? discounted : raw);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function isWaveGuardSetupOneTimeItem(item = {}) {
  const text = oneTimeItemSearchText(item);
  return text.includes('waveguard setup')
    || text.includes('waveguard membership')
    || text.includes('membership setup fee');
}

function isOneTimePestChoiceItem(item = {}) {
  const text = oneTimeItemSearchText(item);
  if (text.includes('pest initial') || ROACH_NAME_RX.test(text)) return false;
  return text.includes('one time pest')
    || text.includes('one-time pest')
    || text.includes('onetime pest');
}

function oneTimeItemLooksPestSpecialty(item = {}) {
  const service = String(item.service || '').toLowerCase();
  const text = oneTimeItemSearchText(item);
  if (service === 'one_time_adjustment' || isWaveGuardSetupOneTimeItem(item) || isOneTimePestChoiceItem(item)) {
    return false;
  }
  if (
    service === 'pest_control'
    || service === 'pest_initial_cleanout'
    || service === 'initial_pest_cleanout'
    || service === 'pest_cleanout'
    || text.includes('initial pest cleanout')
    || text.includes('general pest cleanout')
  ) {
    return false;
  }
  return service === 'pest_initial_roach'
    || /\b(roach|cockroach|ant|spider|flea|wasp|bee|hornet|stinging|bed\s*bug|bedbug)\b/.test(text);
}

function isOneTimeChoiceItemForCategory(item = {}, category = 'pest_control') {
  if (category === 'pest_control') return isOneTimePestChoiceItem(item);
  const itemCategory = serviceCategoryForOneTimeItem(item);
  if (itemCategory !== category) return false;
  const text = oneTimeItemSearchText(item);
  if (!text.includes('one time') && !text.includes('one-time') && !text.includes('onetime')) return false;
  return !isWaveGuardSetupOneTimeItem(item) && String(item.service || '').toLowerCase() !== 'one_time_adjustment';
}

// Bora-Care is a separately-billed add-on that rides alongside whichever cadence
// the customer picks. It must not contribute to the one-time-choice classification,
// or a recurring pest estimate with a Bora-Care add-on classifies as "bundle" and
// the One-Time Pest Control choice is never built (the accept flow then falls back
// to the add-on total instead of the selected pest visit).
function oneTimeChoiceClassificationItems(items = []) {
  return (Array.isArray(items) ? items : []).filter(
    (item) => serviceCategoryForOneTimeItem(item) !== 'bora_care',
  );
}

function serviceCategoryForOneTimeChoice(estData = {}, pricingBundle = null) {
  const breakdown = pricingBundle?.oneTimeBreakdown || normalizeOneTimeBreakdown(estData);
  const result = estData?.result || estData?.engineResult || estData || {};
  return deriveServiceCategory(
    estData,
    recurringServicesWithSupplements(result),
    oneTimeChoiceClassificationItems(breakdown.items || []),
  );
}

function oneTimePestChoiceAmountFromBreakdown(breakdown = {}) {
  return oneTimeChoiceAmountFromBreakdown(breakdown, 'pest_control');
}

function oneTimePestChoiceAmountFromPerApp(perApp) {
  const amount = Number(perApp);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const multiplier = Number(ONE_TIME.pest?.multiplier);
  const floor = Number(ONE_TIME.pest?.floor);
  return Math.max(
    Number.isFinite(floor) && floor > 0 ? floor : 199,
    Math.round(amount * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 2.2)),
  );
}

function rowLooksQuarterly(row = {}) {
  const label = String(row.label || row.name || row.key || row.frequency || row.billingFrequencyKey || '').toLowerCase();
  const visits = Number(row.apps ?? row.v ?? row.visitsPerYear ?? row.visits);
  return label.includes('quarter')
    || row.key === 'quarterly'
    || row.billingFrequencyKey === 'quarterly'
    || (Number.isFinite(visits) && visits > 0 && visits <= 4);
}

function pestTierPerApp(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const explicit = firstPositiveNumber(
    row.pa,
    row.perApp,
    row.perVisit,
    row.perTreatment,
    row.basePrice,
  );
  if (explicit) return Math.round(explicit * 100) / 100;
  const visits = firstPositiveNumber(row.apps, row.v, row.visitsPerYear, row.visits);
  const monthly = firstPositiveNumber(row.mo, row.monthly, row.monthlyBase);
  if (visits && monthly) return Math.round(((monthly * 12) / visits) * 100) / 100;
  const annual = firstPositiveNumber(row.ann, row.annual, row.annualTotal);
  if (visits && annual) return Math.round((annual / visits) * 100) / 100;
  return null;
}

function oneTimePestChoiceAmountFromResultStats(estData = {}) {
  const result = estData?.result && typeof estData.result === 'object'
    ? estData.result
    : (estData && typeof estData === 'object' ? estData : {});
  const innerResults = result.results && typeof result.results === 'object'
    ? result.results
    : {};
  const tiers = [
    ...(Array.isArray(innerResults.pestTiers) ? innerResults.pestTiers : []),
    ...(Array.isArray(result.pestTiers) ? result.pestTiers : []),
  ];
  if (!tiers.length) return null;
  const tier = tiers.find(rowLooksQuarterly) || tiers[0];
  return oneTimePestChoiceAmountFromPerApp(pestTierPerApp(tier));
}

function pestPerAppFromFrequency(frequency = {}) {
  const pestRow = pestTreatmentRowForFrequency(frequency);
  if (!pestRow) return null;
  return pestTierPerApp(pestRow);
}

function oneTimePestChoiceAmountFromFrequencies(frequencies = []) {
  if (!Array.isArray(frequencies) || !frequencies.length) return null;
  const ordered = [
    ...frequencies.filter(rowLooksQuarterly),
    ...frequencies.filter((row) => !rowLooksQuarterly(row)),
  ];
  for (const frequency of ordered) {
    const amount = oneTimePestChoiceAmountFromPerApp(pestPerAppFromFrequency(frequency));
    if (amount) return amount;
  }
  return null;
}

function oneTimePestChoiceAmountFromRecurringServices(recurringServices = []) {
  const services = Array.isArray(recurringServices) ? recurringServices : [];
  for (const service of services) {
    if (!isPestServiceName(service?.name || service?.label || service?.service)) continue;
    const amount = oneTimePestChoiceAmountFromPerApp(pestTierPerApp(service));
    if (amount) return amount;
  }
  return null;
}

function oneTimePestChoiceAmountForEstimate(estimate = {}, estData = {}, pricingBundle = null) {
  return oneTimePestChoiceAmountFromFrequencies(pricingBundle?.frequencies)
    || oneTimePestChoiceAmountFromResultStats(estData)
    || oneTimePestChoiceAmountFromRecurringServices(
      recurringServicesWithSupplements(estData?.result || estData?.engineResult || estData || {}),
    )
    || oneTimePestChoiceAmountFromBreakdown(
      pricingBundle?.oneTimeBreakdown || normalizeOneTimeBreakdown(estData),
    );
}

// Distributes the manual one-time discount slice across the discountable
// preserved specialty rows (net prices), so the one-time choice path — whose
// total drives the accept/charge amount — never quotes or bills the gross fee.
// PERCENT recomputes exactly on the carried subtotal; FIXED uses the engine's
// one-time slice capped to that subtotal. Rows are reduced proportionally with
// the last row absorbing the rounding remainder.
function applyManualOneTimeDiscountToChoiceRows(rows = [], manualDiscount = null) {
  if (!Array.isArray(rows) || rows.length === 0 || !manualDiscount) return rows;
  const subtotal = rows.reduce((sum, r) => Math.round((sum + Number(r.price || 0)) * 100) / 100, 0);
  if (!(subtotal > 0)) return rows;
  const value = Number(manualDiscount.value);
  let discount = 0;
  if (manualDiscount.type === 'PERCENT' && Number.isFinite(value) && value > 0) {
    discount = Math.round(subtotal * (value / 100) * 100) / 100;
  } else {
    const slice = Number(manualDiscount.oneTimeAmount);
    if (Number.isFinite(slice) && slice > 0) discount = Math.round(slice * 100) / 100;
  }
  discount = Math.min(subtotal, discount);
  if (!(discount > 0)) return rows;
  let remaining = discount;
  return rows.map((row, i) => {
    const price = Number(row.price || 0);
    const cut = i === rows.length - 1
      ? remaining
      : Math.round(discount * (price / subtotal) * 100) / 100;
    remaining = Math.round((remaining - cut) * 100) / 100;
    return {
      ...row,
      price: Math.round((price - cut) * 100) / 100,
      grossPrice: price,
      manualDiscountApplied: Math.round(cut * 100) / 100,
    };
  });
}

// One-time rows that ride alongside the selected one-time pest visit and must be
// preserved on it: pest specialties (roach cleanout, etc.) AND separately-billed
// Bora-Care add-ons. Both are billed regardless of the recurring-vs-one-time pest
// choice, so dropping them under-bills the customer. The manual one-time discount
// is applied ONCE across the combined set, so a fixed one-time slice isn't
// distributed twice (which separate per-category calls would do).
function preservedOneTimeAddOnRowsFromBreakdown(breakdown = {}, manualDiscount = null) {
  const items = Array.isArray(breakdown?.items) ? breakdown.items : [];
  const rows = items.map((item) => {
    if (!item || typeof item !== 'object') return null;
    if (item.quoteRequired === true) return null;
    if (isWaveGuardSetupOneTimeItem(item)) return null;
    if (isOneTimePestChoiceItem(item)) return null;
    if (String(item.service || '').toLowerCase() === 'one_time_adjustment') return null;
    const isBoraCare = isBoraCareOneTimeItem(item);
    if (!oneTimeItemLooksPestSpecialty(item) && !isBoraCare) return null;
    const amount = oneTimeItemAmount(item);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    let label = item.label || item.name || 'Pest treatment';
    let name = item.name || label;
    // A name-less engine Bora-Care row carries the raw service key as its label;
    // surface the friendly category label instead.
    if (isBoraCare && (label === 'Pest treatment' || label.toLowerCase() === String(item.service || '').toLowerCase())) {
      label = oneTimeInvoiceLabelForCategory('bora_care');
      name = label;
    }
    return {
      service: item.service || null,
      name,
      label,
      price: Math.round(amount * 100) / 100,
      detail: item.detail || null,
    };
  }).filter(Boolean);
  return applyManualOneTimeDiscountToChoiceRows(rows, manualDiscount);
}

// The manual one-time discount to apply when preserving add-on rows for a choice.
// finalizePricingBundle() already aligns the bundle into a net choice breakdown
// (the discount applied once, baked into the add-on rows, and a synthetic
// "One-Time Pest Control" row present). When the accept path re-runs this over
// that already-net breakdown, re-applying the discount would subtract the slice a
// second time — so return null in that case and only apply it on the raw breakdown.
function manualDiscountForChoiceBreakdown(breakdown = {}, estData = {}) {
  // Only the aligned choice breakdown built by oneTimeChoiceBreakdownForEstimate is
  // already net of the manual one-time discount — detect it by its explicit marker,
  // NOT the mere presence of a one_time_pest row (a raw/admin-saved estimate can
  // carry that row, and there the discount must still be applied to the add-ons).
  if (breakdown && breakdown.choiceAligned === true) return null;
  return normalizeManualDiscountSummary(estData);
}

function oneTimeChoiceAmountForEstimate(estimate = {}, estData = {}, pricingBundle = null) {
  if (!(estimate.show_one_time_option || estimate.showOneTimeOption)) return null;
  const breakdown = pricingBundle?.oneTimeBreakdown || normalizeOneTimeBreakdown(estData);
  const recurring = recurringServicesWithSupplements(estData?.result || estData?.engineResult || estData || {});
  const category = deriveServiceCategory(estData, recurring, oneTimeChoiceClassificationItems(breakdown.items));
  if (category === 'pest_control') {
    const pestChoiceAmount = oneTimePestChoiceAmountForEstimate(estimate, estData, pricingBundle);
    if (!pestChoiceAmount) return null;
    const addOnTotal = preservedOneTimeAddOnRowsFromBreakdown(breakdown, manualDiscountForChoiceBreakdown(breakdown, estData))
      .reduce((sum, item) => Math.round((sum + Number(item.price || 0)) * 100) / 100, 0);
    return Math.round((pestChoiceAmount + addOnTotal) * 100) / 100;
  }
  return oneTimeChoiceAmountFromBreakdown(breakdown, category);
}

function acceptedOneTimeChoiceListForEstimate(estimate = {}, estData = {}, pricingBundle = null, choicePrice = null) {
  if (!(estimate.show_one_time_option || estimate.showOneTimeOption)) return null;
  const breakdown = pricingBundle?.oneTimeBreakdown || normalizeOneTimeBreakdown(estData);
  const recurring = recurringServicesWithSupplements(estData?.result || estData?.engineResult || estData || {});
  const category = deriveServiceCategory(estData, recurring, oneTimeChoiceClassificationItems(breakdown.items));
  if (category !== 'pest_control') return null;
  const pestChoiceAmount = oneTimePestChoiceAmountForEstimate(estimate, estData, pricingBundle);
  const amount = Number(pestChoiceAmount || choicePrice);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return [{
    service: 'one_time_pest',
    name: 'One-Time Pest Control',
    label: 'One-Time Pest Control',
    price: Math.round(amount * 100) / 100,
  }, ...preservedOneTimeAddOnRowsFromBreakdown(breakdown, manualDiscountForChoiceBreakdown(breakdown, estData))];
}

function oneTimeChoiceBreakdownForEstimate(estimate = {}, estData = {}, pricingBundle = null, choicePrice = null) {
  const choiceList = acceptedOneTimeChoiceListForEstimate(estimate, estData, pricingBundle, choicePrice);
  if (!choiceList) return null;
  const existingBreakdown = pricingBundle?.oneTimeBreakdown || normalizeOneTimeBreakdown(estData);
  const hasQuoteRequiredItems = existingBreakdown?.quoteRequired === true
    || (Array.isArray(existingBreakdown?.quoteRequiredItems) && existingBreakdown.quoteRequiredItems.length > 0)
    || (Array.isArray(existingBreakdown?.items) && existingBreakdown.items.some((item) => item.quoteRequired === true));
  if (hasQuoteRequiredItems) return null;
  const items = choiceList.map((item) => ({
    service: item.service,
    label: item.label || item.name,
    amount: Number(item.price || 0),
    detail: item.detail || 'Single treatment',
    kind: 'charge',
  }));
  const total = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return {
    items,
    total: Math.round(total * 100) / 100,
    quoteRequired: false,
    quoteRequiredItems: [],
    // Marks this as the aligned choice breakdown whose add-on rows are already net
    // of the manual one-time discount, so the accept path doesn't re-apply it.
    choiceAligned: true,
  };
}

function alignOneTimeChoiceBreakdown(payload = {}, estimate = {}, estData = {}) {
  if (!(estimate.show_one_time_option || estimate.showOneTimeOption)) return payload;
  const choicePrice = oneTimeChoiceAmountForEstimate(estimate, estData, payload);
  const choiceBreakdown = oneTimeChoiceBreakdownForEstimate(estimate, estData, payload, choicePrice);
  if (!choiceBreakdown) return payload;
  return {
    ...payload,
    anchorOneTimePrice: choiceBreakdown.total,
    oneTimeBreakdown: choiceBreakdown,
  };
}

function oneTimeChoiceAmountFromBreakdown(breakdown = {}, category = 'pest_control') {
  const items = Array.isArray(breakdown.items) ? breakdown.items : [];
  const total = items.reduce((sum, item) => {
    if (!isOneTimeChoiceItemForCategory(item, category) || item.quoteRequired === true) return sum;
    const amount = oneTimeItemAmount(item);
    return amount > 0 ? Math.round((sum + amount) * 100) / 100 : sum;
  }, 0);
  return total > 0 ? total : null;
}

function findInitialRoachItem(_pestTiers, estData) {
  const result = estData?.result || {};
  const buckets = [
    result.oneTime?.items,
    result.oneTime?.specItems,
    result.results?.oneTime?.items,
    result.results?.oneTime?.specItems,
  ];
  for (const list of buckets) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((it) => {
      if (!it) return false;
      if (it.service === 'pest_initial_roach') return true;
      const name = it.name || it.label || '';
      return ROACH_NAME_RX.test(name);
    });
    if (hit && hit.price) {
      return {
        price: Number(hit.price) || 0,
        label: hit.label || hit.name || 'Initial Roach Knockdown',
      };
    }
  }
  return null;
}

function normalizeOneTimeBreakdown(estData) {
  const result = estData?.result && typeof estData.result === 'object'
    ? estData.result
    : (estData?.engineResult && typeof estData.engineResult === 'object' ? estData.engineResult : null);
  if (!result) return { items: [], total: 0, quoteRequired: false, quoteRequiredItems: [] };

  const rows = [];
  const seen = new Set();
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : null;
  const nestedOneTime = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : null;
  const addRows = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (item.onProg === true || item.includedOnProgram === true) continue;

      const quoteRequired = item.quoteRequired === true || item.requiresCustomQuote === true;
      const rawPrice = Number(item.price ?? item.amount ?? item.total);
      const discounted = Number(item.priceAfterDiscount ?? item.totalAfterDiscount);
      const amount = Number.isFinite(rawPrice) && rawPrice < 0
        ? (Number.isFinite(discounted) && discounted !== 0 ? discounted : rawPrice)
        : (Number.isFinite(discounted) ? discounted : rawPrice);
      const includedByServiceCredit = item.serviceSpecificDiscountApplied === true;
      if (!quoteRequired && (!Number.isFinite(amount) || (amount === 0 && !includedByServiceCredit))) continue;

      const label = String(item.label || item.displayName || item.name || item.service || 'One-time service').trim();
      const service = item.service || (ROACH_NAME_RX.test(label) ? 'pest_initial_roach' : null);
      const rawDetail = item.detail || item.det || item.note || item.frequency || null;
      const detail = isTermiteInstallItem({ ...item, label, service })
        ? formatTermiteBaitDetail(result.results?.tmBait, rawDetail)
        : rawDetail;
      const key = [service || '', label, amount, detail || ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        service,
        label,
        amount: quoteRequired ? null : Math.round(amount * 100) / 100,
        detail,
        kind: quoteRequired ? 'quote_required' : (includedByServiceCredit ? 'included' : (amount < 0 ? 'discount' : 'charge')),
        quoteRequired,
        reason: rawQuoteRequiredReason(item),
        customQuoteReason: item.customQuoteReason || null,
        requiresCustomQuote: item.requiresCustomQuote === true,
        warning: item.warning || item.warningText || null,
        warnings: Array.isArray(item.warnings) ? item.warnings : [],
        manualReviewReasons: Array.isArray(item.manualReviewReasons) ? item.manualReviewReasons : [],
        measurementWarnings: Array.isArray(item.measurementWarnings) ? item.measurementWarnings : [],
        warrantyStatus: item.warrantyStatus || null,
        warrantyExtendedSelected: item.warrantyExtendedSelected === true,
        offerKey: item.offerKey || null,
        visits: item.visits || null,
        warrantyType: item.warrantyType || null,
        warrantyLabel: item.warrantyLabel || null,
        guaranteeScope: item.guaranteeScope || null,
        guaranteeStatus: item.guaranteeStatus || null,
        guaranteeExclusions: Array.isArray(item.guaranteeExclusions) ? item.guaranteeExclusions : [],
        guaranteeWindowDaysAfterFollowUp: item.guaranteeWindowDaysAfterFollowUp || null,
        maxIncludedRetreats: item.maxIncludedRetreats || null,
        prepChecklistRequired: item.prepChecklistRequired === true,
        petSourceAttestationRequired: item.petSourceAttestationRequired === true,
        exteriorStatus: item.exteriorStatus || null,
      });
    }
  };

  addRows(oneTime?.items);
  if (nestedOneTime && nestedOneTime !== oneTime) addRows(nestedOneTime.items);
  const membershipFee = Number(oneTime?.membershipFee ?? nestedOneTime?.membershipFee);
  // WaveGuard setup fee only applies when recurring pest or mosquito is part of
  // the estimate. Lawn / termite-bait / rodent-bait / T&S / palm never carry it,
  // even if a stale membershipFee was cached in oneTime.
  const recurringServicesForFee = Array.isArray(result?.recurring?.services)
    ? result.recurring.services
    : (Array.isArray(result?.results?.recurring?.services) ? result.results.recurring.services : []);
  const hasRecurringPest = recurringServicesForFee.some((s) => /pest/i.test(String(s?.name || s?.service || '')));
  const hasRecurringMosquito = recurringServicesForFee.some((s) => recurringServiceKey(s) === 'mosquito');
  const hasExplicitWaveGuardSetup = rows.some((row) => row.service === 'waveguard_setup' || isWaveGuardSetupOneTimeItem(row));
  if (Number.isFinite(membershipFee) && membershipFee > 0 && (hasRecurringPest || hasRecurringMosquito) && !hasExplicitWaveGuardSetup) {
    addRows([{
      service: 'waveguard_setup',
      name: 'WaveGuard setup',
      price: membershipFee,
      detail: 'Membership setup fee',
    }]);
  }
  const termiteInstall = Number(oneTime?.tmInstall ?? nestedOneTime?.tmInstall);
  const termiteInstallItems = [
    ...(Array.isArray(oneTime?.items) ? oneTime.items : []),
    ...(nestedOneTime && nestedOneTime !== oneTime && Array.isArray(nestedOneTime.items) ? nestedOneTime.items : []),
  ];
  const hasTermiteInstallRow = termiteInstallItems.some((item) => {
      const amount = Number(item?.price ?? item?.amount);
      const label = String(item?.label || item?.name || item?.service || '').toLowerCase();
      return Number.isFinite(amount)
        && Math.abs(amount - termiteInstall) < 0.01
        && (label.includes('install') || item?.service === 'termite_bait_installation');
    });
  if (Number.isFinite(termiteInstall) && termiteInstall > 0 && !hasTermiteInstallRow) {
    addRows([{
      service: 'termite_bait_installation',
      name: 'Termite bait installation',
      price: termiteInstall,
    }]);
  }
  if (Array.isArray(result.specItems)) {
    addRows(result.specItems);
  } else {
    addRows(oneTime?.specItems);
    if (nestedOneTime && nestedOneTime !== oneTime) addRows(nestedOneTime.specItems);
  }
  addRows(result.lineItems);
  if (Array.isArray(result.lineItems)) {
    const installationRows = result.lineItems
      .filter((item) => item && typeof item === 'object' && Number(item.installation?.price) > 0)
      .map((item) => ({
        service: `${item.service || 'service'}_installation`,
        name: `${item.label || item.displayName || item.name || item.service || 'Service'} installation`,
        price: Number(item.installation.price),
        detail: isTermiteBaitServiceName(item.service)
          ? formatTermiteBaitDetail(item, item.stations ? `${item.stations} stations` : null)
          : (item.stations ? `${item.stations} stations` : null),
      }));
    addRows(installationRows);
  }

  // Manual / custom discounts carry a one-time slice that is pooled into the
  // summary rather than pushed onto individual line prices. Emit it as an
  // explicit discount row so the breakdown nets out correctly for BOTH shapes:
  // mapped estimates (whose oneTime.total is already net — difference then
  // reconciles to 0) and raw engineResult-backed estimates (which have no
  // oneTime.total and otherwise sum gross line items).
  const manualOneTimeSlice = [
    result?.manualDiscount,
    result?.totals?.manualDiscount,
    result?.summary?.manualDiscount,
  ]
    .map((m) => Number(m?.oneTimeAmount))
    .find((n) => Number.isFinite(n) && n > 0) || 0;
  if (manualOneTimeSlice > 0) {
    const manualLabel = [
      result?.manualDiscount,
      result?.totals?.manualDiscount,
      result?.summary?.manualDiscount,
    ].find((m) => m && Number(m.oneTimeAmount) > 0);
    rows.push({
      service: 'manual_discount',
      label: manualLabel?.label || manualLabel?.catalogName || 'Discount',
      amount: -Math.round(manualOneTimeSlice * 100) / 100,
      detail: null,
      kind: 'discount',
    });
  }

  const rowTotal = rows.reduce((sum, row) => sum + row.amount, 0);
  const rawExplicitTotal = Number(oneTime?.total ?? nestedOneTime?.total);
  // If we suppressed the WaveGuard setup row above (non-pest/mosquito estimate
  // with a stale membershipFee cached in oneTime.total), strip that fee from the
  // explicit total so the difference logic doesn't resurface it as a generic
  // "Other one-time services" charge.
  const suppressedMembershipFee = Number.isFinite(membershipFee)
    && membershipFee > 0
    && !hasRecurringPest
    && !hasRecurringMosquito
    ? membershipFee
    : 0;
  const explicitTotal = Number.isFinite(rawExplicitTotal)
    ? Math.round((rawExplicitTotal - suppressedMembershipFee) * 100) / 100
    : rawExplicitTotal;
  const difference = Math.round(((Number.isFinite(explicitTotal) ? explicitTotal : rowTotal) - rowTotal) * 100) / 100;
  if (difference !== 0) {
    rows.push({
      service: 'one_time_adjustment',
      label: 'Other one-time services',
      amount: difference,
      detail: null,
      kind: difference < 0 ? 'discount' : 'charge',
    });
  }
  const total = Number.isFinite(explicitTotal) ? explicitTotal : rowTotal + difference;
  const quoteRequiredItems = rows.filter((row) => row.quoteRequired === true);
  return {
    items: rows,
    total: Math.round(total * 100) / 100,
    quoteRequired: quoteRequiredItems.length > 0,
    quoteRequiredItems,
  };
}

function resolveEstimateQuoteRequirement(pricingBundle = null, estData = null) {
  const breakdown = pricingBundle?.oneTimeBreakdown
    || (estData ? normalizeOneTimeBreakdown(estData) : null);
  const managerApprovalRequired = estimateDataHasUnresolvedManagerApproval(
    estData || pricingBundle?.estimateData || pricingBundle?.estimate_data
  );
  const quoteRequiredItems = Array.isArray(breakdown?.quoteRequiredItems)
    ? breakdown.quoteRequiredItems
    : (Array.isArray(breakdown?.items) ? breakdown.items.filter((item) => item.quoteRequired === true) : []);
  // An authored commercial proposal (the multi-building PDF) is accepted
  // manually after a board review — never through the residential self-serve
  // accept-and-charge flow, whose single-cadence, pre-tax stored totals would
  // disagree with the emailed proposal PDF. Surface it as a custom quote so
  // the public view shows the formal-proposal state and the accept endpoint
  // refuses online acceptance.
  const commercialProposal = estData?.proposal?.enabled === true;
  // A commercial pest/rodent estimate with no classified business type can't be
  // self-serve accepted — the risk type drives the service cadence and the
  // customer can't set it. Surface it as quote-required so the public view shows
  // the "account manager will finalize" state and the accept endpoint refuses
  // online acceptance (the admin classifies + accepts manually). See
  // commercialRiskTypeReviewNeeded.
  const commercialRiskTypeReview = commercialRiskTypeReviewNeeded(
    estData || pricingBundle?.estimateData || pricingBundle?.estimate_data
  );
  // A commercial estimate whose low-confidence ±20% range is too wide (> $300/mo
  // swing) can't be shown as a usable range — force a site-confirmed manual quote
  // (decision 7 backstop). Narrower low-confidence estimates keep their range and
  // stay self-serve approvable.
  const commercialLowConfidenceSiteQuote = commercialLowConfidenceRequiresSiteQuote(
    estData || pricingBundle?.estimateData || pricingBundle?.estimate_data
  );
  const quoteRequired = pricingBundle?.quoteRequired === true
    || breakdown?.quoteRequired === true
    || quoteRequiredItems.length > 0
    || managerApprovalRequired
    || commercialProposal
    || commercialRiskTypeReview
    || commercialLowConfidenceSiteQuote;

  return {
    quoteRequired,
    reason: managerApprovalRequired
      ? 'st_augustine_dethatching'
      : (quoteRequiredItems[0]?.reason || pricingBundle?.quoteRequiredReason
        || (commercialProposal ? 'commercial_proposal' : null)
        || (commercialRiskTypeReview ? 'commercial_risk_type_review' : null)
        || (commercialLowConfidenceSiteQuote ? 'commercial_low_confidence_site_confirmation' : null)),
    items: quoteRequiredItems,
  };
}

function annualPrepayEligibleForEstimateData(estData) {
  if (!estData || typeof estData !== 'object') return false;
  // Existing customers get pay-per-application only — no annual prepay
  // option and no waivable setup fee (the setup is waived outright; see
  // estimate-converter's matching guard on the accept invoice).
  if (estData.membershipSnapshot && estData.membershipSnapshot.isExistingCustomer) return false;
  const { recurringSvcList, oneTimeList } = acceptanceServiceLists(estData);
  return isAnnualPrepayEligibleServiceMix(recurringSvcList, oneTimeList);
}

function attachQuoteRequirement(payload, estData = null) {
  const quoteState = resolveEstimateQuoteRequirement(payload, estData);
  return {
    ...payload,
    annualPrepayEligible: annualPrepayEligibleForEstimateData(estData),
    quoteRequired: quoteState.quoteRequired,
    quoteRequiredReason: quoteState.reason,
    quoteRequiredItems: quoteState.items,
  };
}

function isStructuralOneTimeOnlyEstimate(estData, estimate = {}) {
  const result = estData?.result && typeof estData.result === 'object'
    ? estData.result
    : (estData && typeof estData === 'object' ? estData : {});
  const recurring = result.recurring && typeof result.recurring === 'object'
    ? result.recurring
    : {};
  const nestedRecurring = result.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  const recurringServices = [
    ...(Array.isArray(recurring.services) ? recurring.services : []),
    ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
  ];
  const recurringRowsRequireQuote = recurringServices.some((row) => (
    row?.quoteRequired === true
    || row?.requiresCustomQuote === true
    || row?.quote_required === true
    || row?.requires_custom_quote === true
  ));
  const recurringRowsHaveDollarAmount = recurringServices.some((row) => firstPositiveNumber(
    row?.mo,
    row?.monthly,
    row?.monthlyTotal,
    row?.monthly_total,
    row?.monthlyBase,
    row?.monthlyAfterDiscount,
    row?.monthlyAfterCredits,
    row?.ann,
    row?.annual,
    row?.annualTotal,
    row?.annual_total,
    row?.annualAfterDiscount,
    row?.annualAfterCredits,
    row?.perTreatment,
    row?.perVisit,
    row?.perApp,
    row?.pa,
    row?.price,
  ) != null);
  const hasRecurringAmount = [
    recurring.monthlyTotal,
    recurring.grandTotal,
    recurring.annualAfterDiscount,
    recurring.annualTotal,
    nestedRecurring.monthlyTotal,
    nestedRecurring.grandTotal,
    nestedRecurring.annualAfterDiscount,
    nestedRecurring.annualTotal,
    estimate.monthly_total,
    estimate.annual_total,
    estimate.monthlyTotal,
    estimate.annualTotal,
  ].some((value) => Number(value || 0) > 0) || recurringRowsHaveDollarAmount;
  const oneTimeBreakdown = normalizeOneTimeBreakdown(estData);

  return !recurringRowsRequireQuote
    && !hasRecurringAmount
    && oneTimeBreakdown.items.length > 0
    && Number(oneTimeBreakdown.total || 0) > 0;
}

function defaultServiceModeForEstimate(estData, estimate = {}) {
  return isStructuralOneTimeOnlyEstimate(estData, estimate) ? 'one_time' : 'recurring';
}

function shouldPersistPestOnlyRecurringChoice(estimate = {}, estData = {}) {
  if (!(estimate.show_one_time_option || estimate.showOneTimeOption)) return false;
  return oneTimePestChoiceAmountForEstimate(estimate, estData) > 0;
}

function acceptanceServiceLists(estData) {
  const result = estData?.result && typeof estData.result === 'object'
    ? estData.result
    : (estData && typeof estData === 'object' ? estData : {});
  const nestedRecurring = result.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nestedOneTime = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  const rawOneTimeRows = [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
    ...(Array.isArray(nestedOneTime.items) ? nestedOneTime.items : []),
    ...(Array.isArray(nestedOneTime.specItems) ? nestedOneTime.specItems : []),
    ...(Array.isArray(result.specItems) ? result.specItems : []),
  ].filter((item) => item && item.onProg !== true && item.includedOnProgram !== true);
  const oneTimeList = rawOneTimeRows.length
    ? rawOneTimeRows
    : normalizeOneTimeBreakdown(estData).items.map((item) => ({
        service: item.service,
        name: item.label,
        price: item.amount,
      }));

  return {
    recurringSvcList: uniqueRecurringServiceRows([
      // Engine-invocation estimates (quote wizard / IB agent drafts) persist the
      // priced lines under estData.engineResult with no v1-mapped
      // result.recurring.services, so source recurring rows from engineResult too
      // (same `result || engineResult || estData` idiom used elsewhere in this
      // file) — otherwise a foam-only engine-backed accept yields an empty
      // recurring list and EstimateConverter schedules/seeds/invoices nothing.
      ...recurringServicesWithSupplements(estData?.result || estData?.engineResult || estData || {}),
      ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
    ]),
    oneTimeList,
  };
}

function uniqueRecurringServiceRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row) return false;
    const key = recurringServiceKey(row) || String(row.name || row.label || row.service || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withSupplementedRecurringServices(estData) {
  if (!estData || typeof estData !== 'object') return estData;
  const hasResult = estData.result && typeof estData.result === 'object';
  const result = hasResult ? estData.result : estData;
  // Engine-invocation estimates have no v1-mapped result; their priced recurring
  // lines live under estData.engineResult.lineItems. Pull those in so foam (and
  // any other engine-backed recurring service) is supplemented onto the estData
  // the accept path reads, matching the result|engineResult fallback used across
  // this file.
  const engineResult = !hasResult && estData.engineResult && typeof estData.engineResult === 'object'
    ? estData.engineResult
    : null;
  const rootRecurring = hasResult && estData.recurring && typeof estData.recurring === 'object'
    ? estData.recurring
    : null;
  const rootResult = rootRecurring
    ? {
        ...estData,
        recurring: rootRecurring,
        results: estData.results || result.results,
      }
    : null;
  let services = uniqueRecurringServiceRows([
    ...recurringServicesWithSupplements(result),
    ...(engineResult ? recurringServicesWithSupplements(engineResult) : []),
    ...(rootResult ? recurringServicesWithSupplements(rootResult) : []),
  ]);
  // engineInputs-only estimates (no stored result/engineResult) are a supported
  // path — buildPricingBundle replays the engine to show a sellable frequency.
  // Replay here too so the accept path / EstimateConverter see the same recurring
  // rows; otherwise such a foam quote accepts with a locked total but an empty
  // recurring list (no schedule, follow-ups, or invoice).
  if (!services.length && !hasResult && !engineResult) {
    const engineInputs = extractEngineInputs(estData);
    if (engineInputs) {
      try {
        services = uniqueRecurringServiceRows(
          recurringServicesWithSupplements(generateEstimate(engineInputs)),
        );
      } catch (err) {
        logger.error(`[estimate-data] recurring supplement engine replay failed: ${err.message}`);
      }
    }
  }
  if (!services.length) return estData;
  const nextResult = {
    ...result,
    recurring: {
      ...(result.recurring || {}),
      services,
    },
  };
  if (!hasResult) return nextResult;
  const nextData = { ...estData, result: nextResult };
  if (rootRecurring) {
    nextData.recurring = {
      ...rootRecurring,
      services,
    };
  }
  return nextData;
}

function resolveAcceptOneTimeTotal(estimate = {}, pricingBundle = null) {
  if (estimate.show_one_time_option || estimate.showOneTimeOption) {
    let breakdown = pricingBundle?.oneTimeBreakdown || null;
    let estData = null;
    if (!breakdown && estimate.estimate_data) {
      try {
        estData = typeof estimate.estimate_data === 'string'
          ? JSON.parse(estimate.estimate_data)
          : estimate.estimate_data;
        breakdown = normalizeOneTimeBreakdown(estData);
      } catch { /* fall through to legacy candidates */ }
    } else if (estimate.estimate_data) {
      try {
        estData = typeof estimate.estimate_data === 'string'
          ? JSON.parse(estimate.estimate_data)
          : estimate.estimate_data;
      } catch { estData = null; }
    }
    const choicePrice = oneTimeChoiceAmountForEstimate(estimate, estData || {}, {
      ...(pricingBundle || {}),
      oneTimeBreakdown: breakdown || pricingBundle?.oneTimeBreakdown,
    });
    if (choicePrice) return choicePrice;
  }
  const candidates = [
    pricingBundle?.anchorOneTimePrice,
    pricingBundle?.oneTimeBreakdown?.total,
    estimate.onetime_total,
  ];
  for (const candidate of candidates) {
    const amount = Number(candidate || 0);
    if (Number.isFinite(amount) && amount > 0) {
      return Math.round(amount * 100) / 100;
    }
  }
  return 0;
}

function normalizeAcceptPaymentMethodPreference(raw) {
  if (raw === 'card_on_file' || raw === 'deposit_now' || raw === 'pay_at_visit') return 'pay_at_visit';
  if (raw === 'prepay_annual') return raw;
  return null;
}

function validateRecurringSlotPaymentPreference({
  slotId = '',
  existingAppointmentId = '',
  treatAsOneTime = false,
  billByInvoice = false,
  paymentMethodPreference = null,
} = {}) {
  if ((!slotId && !existingAppointmentId) || treatAsOneTime || billByInvoice) return null;
  if (paymentMethodPreference === 'pay_at_visit' || paymentMethodPreference === 'prepay_annual') return null;
  return 'Choose pay per application or annual prepay before booking this recurring plan';
}

function isReservationHeldAppointment(row = {}) {
  return !!row?.reservation_expires_at;
}

function assertExistingAppointmentUpdateApplied(updatedCount) {
  const count = Array.isArray(updatedCount) ? updatedCount.length : Number(updatedCount) || 0;
  if (count > 0) return count;

  const err = new Error('existing appointment is no longer available — re-pick a slot');
  err.status = 409;
  throw err;
}

// Statuses that mean the estimate hasn't been published to the customer yet —
// a leaked bearer URL for one of these is the same exposure class as a draft.
// All six estimate insert paths create rows as status='draft'; an operator-
// scheduled send is status='scheduled' (with a future expiry) until the send
// claim flips it to 'sending'. 'sending'/'sent'/'viewed' ARE published (the
// customer link is out, possibly mid-send before expires_at is written), so
// they are intentionally NOT here.
const UNPUBLISHED_ESTIMATE_STATUSES = ['draft', 'scheduled'];

function isEstimateAcceptActive(estimate = {}, now = new Date()) {
  if (estimate.archived_at) return false;
  if (['accepted', 'declined', 'expired', 'send_failed'].includes(estimate.status)) return false;
  // An unpublished estimate (draft / scheduled-but-not-yet-sent) must never be
  // acceptable through the public link. The legacy server-HTML page short-
  // circuited these to the expired page, but the React accept flow reaches this
  // guard instead. Status (not a null expiry) is the signal, so a mid-send
  // 'sending' row whose expiry isn't written yet stays acceptable.
  if (UNPUBLISHED_ESTIMATE_STATUSES.includes(estimate.status)) return false;
  if (estimate.expires_at && new Date(estimate.expires_at) < now) return false;
  return true;
}

// Whether the public React estimate page may receive this estimate's full
// payload (quote + customer PII). The SPA fetches GET /:token/data for ANY
// token, so — unlike the legacy server-HTML page, which rendered the
// expired/not-found shell before building any payload — this must gate the
// data endpoint explicitly. Accepted/declined are legitimate terminal views
// the customer can reopen (legacy rendered them in full); a draft/scheduled
// (unpublished) or expired/send_failed estimate must not be exposed; everything
// else (sending/sent/viewed) is gated only by a real, past expiry — a missing
// expiry during the brief mid-send window does NOT 404. Admin previews bypass
// this at the call site so staff can still review drafts.
function isEstimateCustomerViewable(estimate = {}, now = new Date()) {
  if (!estimate || estimate.archived_at) return false;
  if (['accepted', 'declined'].includes(estimate.status)) return true;
  if (UNPUBLISHED_ESTIMATE_STATUSES.includes(estimate.status)) return false;
  if (['expired', 'send_failed'].includes(estimate.status)) return false;
  if (estimate.expires_at && new Date(estimate.expires_at) < now) return false;
  return true;
}

function resolveEstimateDeclineGuard(estimate, now = new Date()) {
  if (!estimate) {
    return { ok: false, status: 404, error: 'Estimate not found' };
  }
  if (estimate.status === 'declined') {
    return { ok: true, alreadyDeclined: true };
  }
  if (['accepted', 'expired'].includes(estimate.status)) {
    return { ok: false, status: 409, error: 'Estimate is no longer active' };
  }
  if (estimate.expires_at && new Date(estimate.expires_at) < now) {
    return { ok: false, status: 409, error: 'Estimate is no longer active' };
  }
  return { ok: true };
}

function buildAcceptSuccessPayload({
  invoiceMode = false,
  invoiceLinkDelivered = false,
  invoiceId = null,
  invoiceAmount = null,
  invoicePayUrl = null,
  payerBilled = false,
  invoiceKind = null,
  invoiceServiceLabel = null,
  billingTerm = 'standard',
  prepayInvoiceAmount = null,
  bookingUrl = null,
  treatAsOneTime = false,
  reservationCommitted = false,
} = {}) {
  let nextStep = 'confirmed';
  // Third-party Bill-To: a payer-billed invoice is the payer's to pay — the
  // homeowner has no pay-invoice step (the invoice went to the payer AP inbox).
  if (!payerBilled && (invoiceMode || (!treatAsOneTime && invoiceId && invoicePayUrl))) nextStep = 'pay_invoice';
  else if (treatAsOneTime && !reservationCommitted) nextStep = 'book_one_time';
  // A payer-billed annual-prepay accept also has no homeowner step — the prepay
  // invoice went to the payer AP inbox, so don't surface prepay follow-up copy.
  else if (!payerBilled && !treatAsOneTime && billingTerm === 'prepay_annual') nextStep = 'prepay_invoice';

  const decoratedInvoicePayUrl = decorateEstimateInvoicePayUrl(invoicePayUrl, {
    billingTerm,
    saveCard: !treatAsOneTime,
  });

  return {
    success: true,
    nextStep,
    serviceMode: treatAsOneTime ? 'one_time' : 'recurring',
    reservationCommitted,
    invoiceMode,
    invoiceLinkDelivered,
    invoiceId,
    invoiceAmount,
    invoicePayUrl: decoratedInvoicePayUrl,
    invoiceKind,
    invoiceServiceLabel,
    billingTerm,
    prepayInvoiceAmount,
    bookingUrl,
  };
}

function decorateEstimateInvoicePayUrl(rawUrl, { billingTerm = 'standard', saveCard = true } = {}) {
  if (!rawUrl) return null;
  const value = String(rawUrl);
  try {
    const isAbsolute = /^https?:\/\//i.test(value);
    const parsed = new URL(value, 'https://portal.wavespestcontrol.com');
    const params = estimateInvoicePayUrlParams({ billingTerm, saveCard });
    Object.entries(params).forEach(([key, paramValue]) => parsed.searchParams.set(key, paramValue));
    if (!saveCard) parsed.searchParams.delete('saveCard');
    return isAbsolute
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const [beforeHash, hash = ''] = value.split('#');
    const joiner = beforeHash.includes('?') ? '&' : '?';
    const params = new URLSearchParams(estimateInvoicePayUrlParams({ billingTerm, saveCard }));
    return `${beforeHash}${joiner}${params.toString()}${hash ? `#${hash}` : ''}`;
  }
}

function estimateInvoicePayUrlParams({ billingTerm = 'standard', saveCard = true } = {}) {
  const params = {
    source: 'estimate',
  };
  if (saveCard) params.saveCard = '1';
  if (billingTerm) params.billingTerm = String(billingTerm);
  return params;
}

function buildAcceptOfficeFallback({
  customerName = '',
  address = '',
  waveguardTier = 'Bronze',
  monthlyTotal = 0,
  serviceLabel = 'service',
  treatAsOneTime = false,
  billByInvoice = false,
  invoiceMode = false,
  invoiceLinkDelivered = false,
  invoicePayUrl = null,
  reservationCommitted = false,
  billingTerm = 'standard',
  annualPrepayAmount = null,
} = {}) {
  const safeCustomerName = String(customerName || '').trim() || 'Unknown customer';
  const safeAddress = String(address || '').trim() || 'address unavailable';

  if (billByInvoice) {
    const label = treatAsOneTime
      ? `${serviceLabel} one-time service`
      : `${waveguardTier} WaveGuard $${monthlyTotal}/mo`;
    const invoiceText = invoiceLinkDelivered
      ? 'Invoice pay link sent.'
      : (invoiceMode || invoicePayUrl ? 'Invoice created; optional pay link available.' : 'Invoice mode selected.');
    return `Estimate accepted by ${safeCustomerName} at ${safeAddress} - ${label}. ${invoiceText}`;
  }
  if (treatAsOneTime) {
    const nextStep = reservationCommitted ? 'Appointment confirmed.' : 'Booking link sent.';
    return `One-time estimate accepted by ${safeCustomerName} at ${safeAddress} - ${serviceLabel}. ${nextStep}`;
  }
  if (billingTerm === 'prepay_annual') {
    const amountText = annualPrepayAmount != null ? ` ${fmtMoney(annualPrepayAmount)}` : '';
    const invoiceText = invoiceLinkDelivered
      ? 'Invoice pay link sent.'
      : (invoiceMode || invoicePayUrl ? 'Invoice created; optional pay link available.' : 'Invoice follow-up needed.');
    return `Estimate accepted by ${safeCustomerName} at ${safeAddress} - ${waveguardTier} WaveGuard annual prepay${amountText}. ${invoiceText}`;
  }
  if (invoiceMode || invoicePayUrl) {
    const invoiceText = invoiceLinkDelivered
      ? 'Setup + first application invoice pay link sent.'
      : 'Setup + first application invoice created; optional pay link available.';
    return `Estimate accepted by ${safeCustomerName} at ${safeAddress} - ${waveguardTier} WaveGuard $${monthlyTotal}/mo. ${invoiceText}`;
  }
  return `Estimate accepted by ${safeCustomerName} at ${safeAddress} - ${waveguardTier} WaveGuard $${monthlyTotal}/mo. Invoice follow-up needed.`;
}

async function fireBundleQuoteRequestedNotification({ estimate, suggestedService, bundled }, triggerFn) {
  if (!estimate) return null;
  const trigger = triggerFn || require('../services/notification-triggers').triggerNotification;
  return trigger('bundle_quote_requested', {
    estimateId: estimate.id,
    customerId: estimate.customer_id || null,
    customerName: estimate.customer_name || 'Customer',
    suggestedService: suggestedService || 'a service',
    bundled: !!bundled,
    previousTier: estimate.waveguard_tier || 'Bronze',
    previousMonthly: Number(estimate.monthly_total || 0),
    newTier: bundled?.tier || null,
    newMonthly: bundled?.newMonthly ?? null,
  });
}

function buildAcceptNotificationPayload({
  customerName = '',
  waveguardTier = 'Bronze',
  monthlyTotal = 0,
  serviceLabel = 'One-time service',
  treatAsOneTime = false,
  billByInvoice = false,
  invoiceMode = false,
  invoiceLinkDelivered = false,
  invoicePayUrl = null,
  payerBilled = false,
  reservationCommitted = false,
  bookingUrl = null,
  billingTerm = 'standard',
  annualPrepayAmount = null,
} = {}) {
  // Third-party Bill-To: the invoice + pay link went to the payer's AP inbox;
  // the homeowner gets the report and owes nothing, so never advertise a
  // customer pay link. This must precede every billing-term branch below — the
  // converter auto-resolves a default payer even when billByInvoice is false
  // (standard / annual recurring accepts), so a payer-billed invoice can reach
  // here with billByInvoice unset; its invoicePayUrl is already nulled, but the
  // term branches below would still tell the homeowner to use the pay link.
  // Admin copy still reflects that the invoice was sent.
  if (payerBilled) {
    const planLabel = treatAsOneTime ? serviceLabel : `${waveguardTier} WaveGuard $${monthlyTotal}/mo`;
    // Mirror the non-payer invoice-mode paths: only claim the invoice reached the
    // billing contact when delivery actually succeeded. A payer with no usable AP
    // email fails sendViaSMSAndEmail (invoiceLinkDelivered=false) — surface that
    // as office follow-up rather than a false "sent" state. The homeowner owes
    // nothing either way.
    if (!invoiceLinkDelivered) {
      return {
        adminTitle: `Estimate accepted: ${customerName}`,
        adminBody: `${planLabel} approved. Invoice billed to a third-party payer, but automatic delivery to their AP inbox failed — office follow-up needed.`,
        customerTitle: 'Estimate accepted',
        customerBody: `Your ${planLabel} is approved. We'll coordinate billing with your billing contact — nothing is due from you.`,
        customerLink: '/?tab=billing',
      };
    }
    return {
      adminTitle: `Estimate accepted: ${customerName}`,
      adminBody: `${planLabel} approved. Invoice billed to a third-party payer — sent to their AP inbox.`,
      customerTitle: 'Estimate accepted',
      customerBody: `Your ${planLabel} is approved. The invoice was sent to your billing contact — nothing is due from you.`,
      customerLink: '/?tab=billing',
    };
  }

  // Commercial recurring accepts are a flat service plan, NOT a WaveGuard
  // membership — use service-plan copy instead of the "{tier} WaveGuard"
  // fallback (which would otherwise read "Bronze WaveGuard plan approved").
  if (!treatAsOneTime && String(waveguardTier || '').trim().toLowerCase() === 'commercial') {
    const planLabel = `Commercial service plan ($${monthlyTotal}/mo)`;
    return {
      adminTitle: `Estimate accepted: ${customerName}`,
      adminBody: `${planLabel} approved.${invoicePayUrl ? ' Invoice pay link sent.' : ' Office to confirm details + schedule the recurring visits.'}`,
      customerTitle: 'Estimate accepted',
      customerBody: `Your ${planLabel} is approved. A Waves team member will confirm the details and schedule your service.`,
      customerLink: '/?tab=billing',
    };
  }

  if (billByInvoice) {
    if (treatAsOneTime) {
      if (!invoiceMode || !invoiceLinkDelivered) {
        return {
          adminTitle: `One-time estimate accepted: ${customerName}`,
          adminBody: `${serviceLabel} approved. Invoice was not sent automatically; office follow-up needed.`,
          customerTitle: 'Estimate accepted',
          customerBody: `Your ${serviceLabel} estimate is approved. Our team will follow up with the invoice details.`,
          customerLink: invoicePayUrl || '/?tab=billing',
        };
      }
      return {
        adminTitle: `One-time estimate accepted: ${customerName}`,
        adminBody: `${serviceLabel} approved. Invoice pay link is being sent.`,
        customerTitle: 'Estimate accepted',
        customerBody: `Your ${serviceLabel} estimate is approved. Use the invoice pay link if you want to pay now, or pay later.`,
        customerLink: invoicePayUrl || '/?tab=billing',
      };
    }
    if (!invoiceMode || !invoiceLinkDelivered) {
      return {
        adminTitle: `Estimate accepted: ${customerName}`,
        adminBody: `${waveguardTier} WaveGuard $${monthlyTotal}/mo approved. Invoice was not sent automatically; office follow-up needed.`,
        customerTitle: 'Estimate accepted',
        customerBody: `Your ${waveguardTier} WaveGuard plan is approved. Our team will follow up with the invoice details.`,
        customerLink: invoicePayUrl || '/?tab=billing',
      };
    }
    return {
      adminTitle: `Estimate accepted: ${customerName}`,
      adminBody: `${waveguardTier} WaveGuard $${monthlyTotal}/mo approved. Invoice pay link is being sent.`,
      customerTitle: 'Estimate accepted',
      customerBody: `Your ${waveguardTier} WaveGuard plan is approved. Use the invoice pay link if you want to pay now and save a card, or pay later.`,
      customerLink: invoicePayUrl || '/?tab=billing',
    };
  }

  if (treatAsOneTime) {
    const adminBody = reservationCommitted
      ? `${serviceLabel} approved and appointment confirmed.`
      : `${serviceLabel} approved. ${bookingUrl ? 'Booking link sent.' : 'Office follow-up needed to schedule.'}`;
    const customerBody = reservationCommitted
      ? `Your ${serviceLabel} appointment is confirmed. Check your phone for the confirmation text.`
      : bookingUrl
        ? `Your ${serviceLabel} estimate is approved. Pick your appointment from the booking link we sent.`
        : `Your ${serviceLabel} estimate is approved. Our team will follow up to help schedule your appointment.`;
    return {
      adminTitle: `One-time estimate accepted: ${customerName}`,
      adminBody,
      customerTitle: 'One-time service approved',
      customerBody,
      customerLink: bookingUrl || '/?tab=schedule',
    };
  }

  if (billingTerm === 'prepay_annual') {
    const amountText = annualPrepayAmount != null ? ` ${fmtMoney(annualPrepayAmount)}` : '';
    if (!invoiceMode && !invoicePayUrl) {
      return {
        adminTitle: `Estimate accepted: ${customerName}`,
        adminBody: `${waveguardTier} WaveGuard annual prepay${amountText} approved. Invoice follow-up needed.`,
        customerTitle: 'Estimate accepted',
        customerBody: `Your ${waveguardTier} WaveGuard plan is approved. Our team will follow up with the annual prepay invoice details.`,
        customerLink: '/?tab=billing',
      };
    }
    const sentText = invoiceLinkDelivered ? 'Invoice pay link sent.' : 'Invoice created; optional pay link available.';
    return {
      adminTitle: `Estimate accepted: ${customerName}`,
      adminBody: `${waveguardTier} WaveGuard annual prepay${amountText} approved. ${sentText}`,
      customerTitle: 'Estimate accepted',
      customerBody: `Your ${waveguardTier} WaveGuard plan is approved. Use the invoice pay link if you want to pay now and save a card, or pay later.`,
      customerLink: invoicePayUrl || '/?tab=billing',
    };
  }

  if (invoiceMode || invoicePayUrl) {
    const sentText = invoiceLinkDelivered ? 'Invoice pay link sent.' : 'Invoice created; optional pay link available.';
    return {
      adminTitle: `Estimate accepted: ${customerName}`,
      adminBody: `${waveguardTier} WaveGuard $${monthlyTotal}/mo approved. ${sentText}`,
      customerTitle: 'Estimate accepted',
      customerBody: `Your ${waveguardTier} WaveGuard plan is approved. Use the invoice pay link if you want to pay now and save a card, or pay later.`,
      customerLink: invoicePayUrl || '/?tab=billing',
    };
  }

  return {
    adminTitle: `Estimate accepted: ${customerName}`,
    adminBody: `${waveguardTier} WaveGuard $${monthlyTotal}/mo approved. Invoice follow-up needed.`,
    customerTitle: 'Estimate accepted',
    customerBody: `Your ${waveguardTier} WaveGuard plan is confirmed. Our team will follow up with the invoice details.`,
    customerLink: '/?tab=billing',
  };
}

function readV1Shape(estData) {
  if (!estData || typeof estData !== 'object') return null;
  const result = estData.result;
  if (!result || typeof result !== 'object') return null;

  // pestTiers lives at result.results.pestTiers in the v1 shape (nested
  // inside `results` plural, alongside `lawn`, `pest`, `lawnMeta`). Fall
  // back to result.pestTiers for any IB-path or edge shape that puts it
  // at the top of `result`.
  const innerResults = result.results && typeof result.results === 'object' ? result.results : null;
  const pestTiers = Array.isArray(innerResults?.pestTiers)
    ? innerResults.pestTiers
    : (Array.isArray(result.pestTiers) ? result.pestTiers : []);

  const recurring = result.recurring || {};
  const services = recurringServicesWithSupplements(result);
  if (pestTiers.length === 0 && services.length === 0) return null;
  return {
    pestTiers,
    services,
    tmBait: innerResults?.tmBait || result.tmBait || null,
    discount: Number(recurring.discount) || 0,
    waveGuardTier: recurring.waveGuardTier || recurring.tier || null,
    oneTimeTotal: Number(result.oneTime?.total) || 0,
    membershipFee: Number(result.oneTime?.membershipFee) || 0,
    recurringMonthlyTotal: Number(recurring.monthlyTotal) || 0,
    recurringAnnualAfter: Number(recurring.annualAfterDiscount) || 0,
    manualDiscount: normalizeManualDiscountSummary(estData),
  };
}

function shapePreferenceAddOns(prefs, pestTier) {
  if (!pestTier) return [];
  const visitsPerYear = Number(pestTier.apps || pestTier.v || 4) || 4;
  return SERVICE_PREF_KEYS.map((key) => {
    const cfg = SERVICE_PREFS[key];
    const monthlySavings = Math.round(((cfg.perVisit * visitsPerYear) / 12) * 100) / 100;
    return {
      key,
      label: cfg.label,
      detail: `${cfg.offDesc} Save $${monthlySavings.toFixed(monthlySavings % 1 ? 2 : 0)}/mo if removed.`,
      preChecked: prefs[key] !== false,
    };
  });
}

function isPestServiceName(name) {
  return recurringServiceKey({ name }) === 'pest_control';
}

function isTermiteBaitServiceName(name) {
  return recurringServiceKey({ name }) === 'termite_bait';
}

function isRodentServiceName(name) {
  const key = recurringServiceKey({ name });
  if (key === 'rodent_bait' || key === 'rodent') return true;
  const n = String(name || '').toLowerCase();
  return /\brodent\b|\brat\b|\bmouse\b|\bmice\b/.test(n);
}

function isTreeShrubServiceName(name) {
  const key = recurringServiceKey({ name });
  return key === 'tree_shrub' || key === 'palm_injection';
}

function isMosquitoServiceName(name) {
  return recurringServiceKey({ name }) === 'mosquito';
}

function isLawnServiceName(name) {
  return recurringServiceKey({ name }) === 'lawn_care';
}

function isTermiteTrenchingServiceName(name) {
  const key = recurringServiceKey({ name });
  if (key === 'termite_trenching') return true;
  const n = String(name || '').toLowerCase();
  if (n.includes('pre-slab') || n.includes('pre slab') || n.includes('preslab')) return false;
  return n.includes('termite')
    && !n.includes('bait')
    && /(trench|trenching|liquid|barrier|termidor|treatment)/.test(n);
}

function isTermiteInstallItem(item) {
  const n = String(item?.name || item?.label || item?.service || '').toLowerCase();
  return n.includes('termite_bait_installation')
    || (n.includes('termite') && n.includes('install'))
    || (n.includes('advance') && n.includes('install'))
    || (n.includes('trelona') && n.includes('install'));
}

function formatTermiteBaitDetail(tmBait, existingDetail = '') {
  const existing = String(existingDetail || '').trim();
  const stations = Number(tmBait?.sta || tmBait?.stations || 0);
  const perimeter = Number(tmBait?.perim || tmBait?.perimeter || 0);
  const parts = [];
  if (existing) {
    parts.push(existing);
  } else if (Number.isFinite(stations) && stations > 0) {
    parts.push(`${Math.round(stations).toLocaleString()} stations`);
  }
  if (
    Number.isFinite(perimeter)
    && perimeter > 0
    && !existing.toLowerCase().includes('linear')
    && !existing.includes(String(Math.round(perimeter)))
  ) {
    parts.push(`${Math.round(perimeter).toLocaleString()} linear ft perimeter`);
  }
  return parts.join(' \u00B7 ') || null;
}

function normalizeWaveGuardTierLabel(value) {
  const raw = String(value || '').replace(/^WaveGuard\s+/i, '').trim();
  return ['Bronze', 'Silver', 'Gold', 'Platinum'].find((tier) => tier.toLowerCase() === raw.toLowerCase()) || 'Bronze';
}

function categoryForRecurringServiceKey(key) {
  switch (key) {
    case 'pest_control': return 'pest_control';
    case 'lawn_care': return 'lawn_care';
    case 'tree_shrub': return 'tree_shrub';
    case 'mosquito': return 'mosquito';
    case 'termite_bait': return 'termite_bait';
    case 'foam_recurring': return 'foam_recurring';
    case 'pre_slab_termiticide': return 'pre_slab_termiticide';
    case 'rodent': return 'rodent';
    case 'rodent_bait': return 'rodent';
    case 'termite_trenching': return 'termite_trenching';
    case 'palm_injection': return 'tree_shrub';
    // Commercial auto-priced lines render with the lawn / tree-shrub section
    // copy (display only — discount eligibility is handled separately and stays
    // off). Without these, deriveServiceCategory falls through and renders pest
    // copy/ask chips for a commercial lawn or tree quote.
    case 'commercial_lawn': return 'lawn_care';
    case 'commercial_tree_shrub': return 'tree_shrub';
    case 'commercial_pest': return 'pest_control';
    case 'commercial_mosquito': return 'mosquito';
    case 'commercial_termite_bait': return 'termite_bait';
    // Match the residential rodent_bait → 'rodent' mapping above: the 'rodent_bait'
    // category has no section copy/chips, so a single commercial rodent-bait quote
    // would fall back to generic bundle copy (and one-time rodent rows wouldn't
    // group with it). Use the 'rodent' category that actually has copy.
    case 'commercial_rodent_bait': return 'rodent';
    default: return null;
  }
}

function serviceLabelForCategory(category, fallback = null) {
  switch (category) {
    case 'pest_control': return 'Pest Control';
    case 'lawn_care': return 'Lawn Care';
    case 'tree_shrub': return 'Tree & Shrub';
    case 'mosquito': return 'Mosquito Control';
    case 'termite_bait': return 'Termite Bait Stations';
    case 'foam_recurring': return 'Recurring Foam Treatment';
    case 'pre_slab_termiticide': return 'Pre-Slab Termiticide Treatment';
    case 'bora_care': return 'Bora-Care Wood Treatment';
    case 'termite_trenching': return 'Termite Trenching';
    case 'rodent': return 'Rodent Remediation';
    case 'bundle': return 'Recurring services';
    default: return fallback || recurringServiceDisplayName(category) || 'Service';
  }
}

function serviceCategoryForOneTimeItem(item = {}) {
  const name = item?.name || item?.label || item?.service || '';
  const service = String(item?.service || '').toLowerCase();
  if (!name && !service) return null;
  if (service === 'waveguard_setup' || service === 'one_time_adjustment' || service === 'rodent_bundle_discount') return null;
  if (service === 'pest_initial_roach' || service === 'one_time_pest' || oneTimeItemLooksPestSpecialty(item) || isPestServiceName(name)) return 'pest_control';
  // Bora-Care carries the canonical service key `bora_care`; classify it before
  // the generic termite-install heuristic so an install-worded label
  // (e.g. "Termite Bora-Care Install") never routes it down the bait path.
  if (isBoraCareOneTimeItem(item)) return 'bora_care';
  if (isTermiteInstallItem(item)) return 'termite_bait';
  if (isPreSlabOneTimeItem(item) || service.includes('pre_slab') || service.includes('preslab')) return 'pre_slab_termiticide';
  if (isTermiteTrenchingServiceName(name) || service === 'trenching' || service.includes('termite_trench')) return 'termite_trenching';
  if (isRodentServiceName(name) || service.includes('rodent')) return 'rodent';
  if (isTreeShrubServiceName(name) || service.includes('tree') || service.includes('shrub') || service.includes('palm')) return 'tree_shrub';
  if (isMosquitoServiceName(name) || service.includes('mosquito')) return 'mosquito';
  if (isLawnServiceName(name) || service.includes('lawn')) return 'lawn_care';
  return null;
}

function deriveServiceCategory(estData = {}, recurringServices = [], oneTimeItems = []) {
  const categories = new Set();
  const recurring = Array.isArray(recurringServices) ? recurringServices : [];
  recurring.forEach((svc) => {
    const category = categoryForRecurringServiceKey(recurringServiceKey(svc));
    if (category) categories.add(category);
  });

  const items = Array.isArray(oneTimeItems) ? oneTimeItems : [];
  items.forEach((item) => {
    const category = serviceCategoryForOneTimeItem(item);
    if (category) categories.add(category);
  });

  if (categories.size > 1) return 'bundle';
  if (categories.size === 1) return Array.from(categories)[0];

  const inputs = estData?.inputs || estData?.engineInputs || {};
  const services = inputs.services || {};
  const inferred = [
    services.pest || inputs.svcPest ? 'pest_control' : null,
    services.lawn || services.lawnCare || inputs.svcLawn ? 'lawn_care' : null,
    services.treeShrub || services.tree_shrub || inputs.svcTreeShrub ? 'tree_shrub' : null,
    services.mosquito || services.oneTimeMosquito || inputs.svcMosquito || inputs.svcOnetimeMosquito ? 'mosquito' : null,
    services.termiteBait || services.termite || inputs.svcTermiteBait ? 'termite_bait' : null,
    services.preSlabTermiticide || services.pre_slab_termiticide || services.preSlab || inputs.svcPreslab ? 'pre_slab_termiticide' : null,
    services.boraCare || services.bora_care || inputs.svcBoracare ? 'bora_care' : null,
    services.trenching || inputs.svcTrenching ? 'termite_trenching' : null,
    services.rodent || inputs.svcRodent ? 'rodent' : null,
    // Recurring foam can be the whole estimate; an engineInputs-only foam quote
    // has no saved recurring.services row, so without this it falls through to
    // the 'pest_control' default and the public page mislabels it as Pest Control.
    services.foamRecurring || inputs.svcFoamRecurring ? 'foam_recurring' : null,
  ].filter(Boolean);
  return inferred.length > 1 ? 'bundle' : (inferred[0] || 'pest_control');
}

function chipsForServiceCategory(category) {
  return SERVICE_COPY[category]?.askChips || SERVICE_COPY.bundle.askChips;
}

function mergeAskChips(categories = []) {
  const merged = [];
  const seen = new Set();
  const add = (chip) => {
    const clean = String(chip || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(clean);
  };
  categories.forEach((category) => chipsForServiceCategory(category).forEach(add));
  if (!merged.length) SERVICE_COPY.pest_control.askChips.forEach(add);
  return merged.slice(0, 6);
}

function treeShrubTierKey(row = {}) {
  const raw = String(row.key || row.tier || row.name || row.label || '').trim().toLowerCase();
  if (raw.includes('light') || raw === '4' || raw === '4x') return 'light';
  if (raw.includes('standard') || raw === '6' || raw === '6x') return 'standard';
  // 'enhanced' (9x) is retired but kept here so previously-saved estimates that
  // still carry an Enhanced row render unchanged (legacy estimates aren't re-priced).
  if (raw.includes('enhanced') || raw === '9' || raw === '9x') return 'enhanced';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;
}

function treeShrubFrequenciesFromResultStats(estData = {}) {
  const resultStats = recurringResultStats(estData);
  const rows = Array.isArray(resultStats.ts) ? resultStats.ts : [];
  const seen = new Set();
  const rawManualDiscount = normalizeManualDiscountSummary(estData);
  return rows
    .map((row) => {
      const tierKey = treeShrubTierKey(row);
      // 'enhanced' retained for backward-compat with saved pre-v4.5 estimates.
      if (!['light', 'standard', 'enhanced'].includes(tierKey) || seen.has(tierKey)) return null;
      seen.add(tierKey);
      const visits = finiteNumberOrNull(row.v ?? row.visitsPerYear ?? row.frequency);
      const monthlyBase = finiteNumberOrNull(row.mo ?? row.monthly);
      const annualBase = finiteNumberOrNull(row.ann ?? row.annual);
      const perTreatmentBase = finiteNumberOrNull(row.pa ?? row.perTreatment ?? row.perApp ?? row.perVisit);
      const discountBaseAnnual = annualBase != null
        ? annualBase
        : (monthlyBase != null ? roundMonthly(monthlyBase * 12) : 0);
      const manualDiscount = manualDiscountForRecurringBase(rawManualDiscount, discountBaseAnnual);
      const manualDiscountAmount = Number(manualDiscount?.amount || 0);
      const manualDiscountMonthly = Number(manualDiscount?.monthlyAmount || 0);
      const monthly = monthlyBase != null
        ? Math.max(0, roundMonthly(monthlyBase - manualDiscountMonthly))
        : null;
      const annual = annualBase != null
        ? Math.max(0, roundMonthly(annualBase - manualDiscountAmount))
        : (monthly != null ? roundMonthly(monthly * 12) : null);
      const perTreatment = perTreatmentBase != null
        ? Math.max(0, roundMonthly(perTreatmentBase - (visits ? manualDiscountAmount / visits : 0)))
        : null;
      // House convention: T&S tiers display as cadences (4=Quarterly,
      // 6=Bi-monthly, 9=Every 6 weeks). Light is the 4-visit Quarterly option.
      const labelBase = tierKey === 'light' ? 'Quarterly'
        : tierKey === 'enhanced' ? 'Every 6 weeks'
        : 'Bi-monthly';
      return {
        key: tierKey,
        label: labelBase,
        serviceCategory: 'tree_shrub',
        serviceTierKey: tierKey,
        monthlyBase,
        monthly,
        annual,
        perTreatment,
        visitsPerYear: visits,
        billingFrequencyKey: 'monthly',
        manualDiscount: manualDiscount || null,
        recommended: row.recommended === true || row.isRecommended === true,
        selected: row.selected === true || row.isSelected === true,
        included: [
          {
            key: `tree_shrub_${tierKey}`,
            label: `${labelBase} tree & shrub program`,
            detail: visits ? `${Math.round(visits)} visits per year` : null,
            includedAtThisFrequency: true,
          },
          {
            key: 'tree_shrub_beds_trees',
            label: 'Ornamental bed and tree treatments',
            detail: 'Plant-health treatments matched to the property plan',
            includedAtThisFrequency: true,
          },
        ],
        // Per-service treatment detail so a selected T&S cadence (Light 4x or
        // Standard 6x) carries its real visit count into the slot profile /
        // first-visit math, mirroring lawn — otherwise the slot path falls back
        // to the stored Standard row and notes can say 6x at the Light price.
        perServiceTreatments: perTreatment != null ? [{
          service: 'tree_shrub',
          label: 'Tree & Shrub',
          perTreatment,
          displayPrice: perTreatment,
          visitsPerYear: visits,
        }] : [],
        addOns: [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Ascending cadence: Light (4) before Standard (6), matching the engine
      // result order and the pest/lawn cadence-slider convention.
      const order = { light: 0, standard: 1, enhanced: 2 };
      return (order[a.key] ?? 99) - (order[b.key] ?? 99);
    });
}

// Lawn care tier → cadence. The lawn engine produces 4/6/9/12-visit tiers
// (Basic/Standard/Enhanced/Premium); customers see them as cadences, matching
// the house convention (4=Quarterly, 6=Bi-monthly, 9=Every 6 weeks, 12=Monthly).
function lawnTierKey(row = {}) {
  const raw = String(row.key || row.tier || row.name || row.label || '').trim().toLowerCase();
  const visits = finiteNumberOrNull(row.v ?? row.visitsPerYear ?? row.frequency);
  if (raw.includes('premium') || visits === 12) return 'premium';
  if (raw.includes('enhanced') || visits === 9) return 'enhanced';
  if (raw.includes('standard') || visits === 6) return 'standard';
  if (raw.includes('basic') || visits === 4) return 'basic';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;
}

const LAWN_CADENCE_LABEL = { basic: 'Quarterly', standard: 'Bi-monthly', enhanced: '9 visits / yr', premium: 'Monthly' };

// Customer-facing lawn cadence options from the stored lawn cost-floor tiers.
// Mirrors treeShrubFrequenciesFromResultStats: only fires for lawn-only
// estimates (when lawn is the sole recurring service); mixed bundles price
// lawn inside the pest cadence. Pricing is unchanged — the 4/6/9/12 cost-floor
// numbers, relabeled as Quarterly / Bi-monthly / 9 visits / yr / Monthly.
function lawnFrequenciesFromResultStats(estData = {}) {
  const resultStats = recurringResultStats(estData);
  const rows = Array.isArray(resultStats.lawn) ? resultStats.lawn : [];
  return lawnFrequenciesFromRows(rows, estData);
}

// Shared core: turn lawn cost-floor tier rows into the customer-facing cadence
// ladder. Fed by stored result.results.lawn (v1 path) and by the live engine
// lawn line item tiers (engine-invocation path) so both surfaces present the
// same 4/6/9/12 application options instead of one collapsed entry. Callers may
// pass an explicit manual discount (e.g. one read off a just-generated engine
// summary that the stored blob doesn't carry); otherwise it's read from estData.
function lawnFrequenciesFromRows(rows = [], estData = {}, manualDiscountOverride) {
  const seen = new Set();
  const rawManualDiscount = manualDiscountOverride !== undefined
    ? manualDiscountOverride
    : normalizeManualDiscountSummary(estData);
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const tierKey = lawnTierKey(row);
      if (!['basic', 'standard', 'enhanced', 'premium'].includes(tierKey) || seen.has(tierKey)) return null;
      seen.add(tierKey);
      const visits = finiteNumberOrNull(row.v ?? row.visitsPerYear ?? row.frequency);
      const monthlyBase = finiteNumberOrNull(row.mo ?? row.monthly);
      const annualBase = finiteNumberOrNull(row.ann ?? row.annual);
      const perTreatmentBase = finiteNumberOrNull(row.pa ?? row.perTreatment ?? row.perApp ?? row.perVisit);
      const discountBaseAnnual = annualBase != null
        ? annualBase
        : (monthlyBase != null ? roundMonthly(monthlyBase * 12) : 0);
      const manualDiscount = manualDiscountForRecurringBase(rawManualDiscount, discountBaseAnnual);
      const manualDiscountAmount = Number(manualDiscount?.amount || 0);
      const manualDiscountMonthly = Number(manualDiscount?.monthlyAmount || 0);
      const monthly = monthlyBase != null
        ? Math.max(0, roundMonthly(monthlyBase - manualDiscountMonthly))
        : null;
      const annual = annualBase != null
        ? Math.max(0, roundMonthly(annualBase - manualDiscountAmount))
        : (monthly != null ? roundMonthly(monthly * 12) : null);
      const perTreatment = perTreatmentBase != null
        ? Math.max(0, roundMonthly(perTreatmentBase - (visits ? manualDiscountAmount / visits : 0)))
        : null;
      const labelBase = LAWN_CADENCE_LABEL[tierKey] || 'Lawn care';
      return {
        key: tierKey,
        label: labelBase,
        serviceCategory: 'lawn_care',
        serviceTierKey: tierKey,
        monthlyBase,
        monthly,
        annual,
        perTreatment,
        visitsPerYear: visits,
        billingFrequencyKey: 'monthly',
        manualDiscount: manualDiscount || null,
        recommended: row.recommended === true || row.isRecommended === true,
        selected: row.selected === true || row.isSelected === true,
        included: [
          {
            key: `lawn_care_${tierKey}`,
            label: `${labelBase} lawn care program`,
            detail: visits ? `${Math.round(visits)} visits per year` : null,
            includedAtThisFrequency: true,
          },
          {
            key: 'lawn_care_treatments',
            label: 'Fertilization and weed-control treatments',
            detail: 'Turf treatments matched to your grass type and the season',
            includedAtThisFrequency: true,
          },
        ],
        // Per-service treatment detail — drives the same rich price-card line
        // pest/bundle estimates show (per-visit price + visits/year + benefit
        // bullets from SERVICE_INCLUSIONS.lawn_care), so lawn mirrors them.
        perServiceTreatments: perTreatment != null ? [{
          service: 'lawn_care',
          label: 'Lawn Care',
          perTreatment,
          displayPrice: perTreatment,
          visitsPerYear: visits,
        }] : [],
        addOns: [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const order = { basic: 0, standard: 1, enhanced: 2, premium: 3 };
      return (order[a.key] ?? 99) - (order[b.key] ?? 99);
    });
}

// Recurring (ongoing-plan) service keys, used to decide whether an engine
// result is lawn-only. Mirrors the canonical recurring-line set — note 'rodent'
// is NOT recurring (the recurring rodent service is rodent_bait; rodent_trapping
// is a one-time specialty that fuzzily maps onto 'rodent').
const RECURRING_SERVICE_KEYS = new Set([
  'pest_control', 'lawn_care', 'tree_shrub', 'mosquito',
  'termite_bait', 'palm_injection', 'rodent_bait', 'foam_recurring',
]);

// A recurring engine line carries real monthly/annual billing. One-time
// follow-ups (one_time_*) and specialty one-time rows (e.g. rodent_trapping)
// do NOT, so they're excluded from the lawn-only check even when their service
// key maps onto a recurring family.
function isRecurringEngineLineItem(li = {}) {
  if (!li || /^one[_-]?time/.test(String(li.service || '').toLowerCase())) return false;
  if (!RECURRING_SERVICE_KEYS.has(recurringServiceKey(li))) return false;
  const annual = finiteNumberOrNull(li.annual ?? li.annualAfterDiscount ?? li.annualBeforeDiscount);
  const monthly = finiteNumberOrNull(li.monthly ?? li.monthlyAfterDiscount);
  return (annual != null && annual > 0) || (monthly != null && monthly > 0);
}

// Apply a flat (WaveGuard) discount factor to a pre-discount tier value,
// keeping cents. factor === 1 (no membership discount) returns the value as-is.
function applyLawnTierDiscount(value, factor) {
  const n = finiteNumberOrNull(value);
  if (n == null) return null;
  if (!(factor < 1)) return n;
  return Math.round(n * factor * 100) / 100;
}

// Engine-invocation lawn-only equivalent of lawnFrequenciesFromResultStats.
// Server-authoritative / IB estimates store engineInputs (not a precomputed
// result.results.lawn), so the no-pest pricing branch reads the lawn line
// item's tier ladder off a live generateEstimate() result. Only fires when
// lawn_care is the sole recurring line — mixed bundles keep pricing lawn
// inside the pest cadence. Returns [] for any non-lawn-only result so the
// caller falls back to the single-frequency view.
function lawnFrequenciesFromEngineResult(engineResult = {}, estData = {}) {
  const recurringLineItems = (Array.isArray(engineResult?.lineItems) ? engineResult.lineItems : [])
    .filter(isRecurringEngineLineItem);
  const recurringServices = new Set(recurringLineItems.map((li) => recurringServiceKey(li)));
  if (recurringServices.size !== 1 || !recurringServices.has('lawn_care')) return [];
  const lawnLine = recurringLineItems.find((li) => recurringServiceKey(li) === 'lawn_care');
  const tiers = Array.isArray(lawnLine?.tiers) ? lawnLine.tiers : [];

  // The per-tier monthly/annual/per-app values are pre-discount market prices,
  // but generateEstimate applies the WaveGuard membership % to the lawn line for
  // existing customers (priorQualifyingServices lifts the combined tier). The
  // accept handler bills selectedFrequency.monthly/annual directly, so each tier
  // must carry the same discounted price the line total reflects.
  const beforeAnnual = finiteNumberOrNull(lawnLine?.annualBeforeDiscount);
  const afterAnnual = finiteNumberOrNull(lawnLine?.annualAfterDiscount);
  const discountFactor = (beforeAnnual && beforeAnnual > 0 && afterAnnual != null)
    ? afterAnnual / beforeAnnual
    : 1;

  // After acceptance the chosen tier is persisted in customerSelection (the
  // engine inputs are NOT restamped), so honor it when marking the selected row;
  // otherwise fall back to the engine's resolved tier.
  const selection = estData?.customerSelection || estData?.result?.customerSelection || {};
  const selectedKey = String(selection.serviceTierKey || selection.serviceTier || '').trim().toLowerCase();
  const selectedTierKey = ['basic', 'standard', 'enhanced', 'premium'].includes(selectedKey)
    ? selectedKey
    : lawnLine.tier;

  const rows = tiers.map((t) => {
    const annual = applyLawnTierDiscount(t.annual, discountFactor);
    const visits = finiteNumberOrNull(t.visits ?? t.freq);
    const monthly = annual != null
      ? Math.round((annual / 12) * 100) / 100
      : applyLawnTierDiscount(t.monthly, discountFactor);
    const perApp = (annual != null && visits)
      ? Math.round((annual / visits) * 100) / 100
      : applyLawnTierDiscount(t.perApp, discountFactor);
    return {
      name: t.label,
      tier: t.tier,
      mo: monthly,
      ann: annual,
      pa: perApp,
      v: visits,
      recommended: t.recommended === true,
      selected: t.tier === selectedTierKey,
    };
  });

  // The per-tier values above carry the WaveGuard membership discount but not
  // any manual recurring discount, which the engine surfaces on the live
  // summary. When the replayed engineInputs apply a manual discount the stored
  // blob doesn't already record, read it off the just-generated summary so each
  // tier prices/bills after the manual discount (matching the old single-entry
  // shapeFrequencyEntry path).
  const manualDiscount = normalizeManualDiscountSummary({ summary: engineResult?.summary })
    || normalizeManualDiscountSummary(estData);
  return lawnFrequenciesFromRows(rows, estData, manualDiscount);
}

function mosquitoTierKey(row = {}) {
  const raw = String(row.key || row.tier || row.selectedTier || row.program || row.n || row.name || row.label || '').trim().toLowerCase();
  const visits = finiteNumberOrNull(row.v ?? row.visits ?? row.visitsPerYear ?? row.frequency);
  if (raw.includes('monthly') || raw.includes('monthly12') || visits === 12) return 'monthly12';
  if (raw.includes('seasonal') || raw.includes('seasonal9') || visits === 9) return 'seasonal9';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;
}

function mosquitoFrequenciesFromResultStats(estData = {}) {
  const resultStats = recurringResultStats(estData);
  const rows = Array.isArray(resultStats.mq) ? resultStats.mq : [];
  const seen = new Set();
  const rawManualDiscount = normalizeManualDiscountSummary(estData);
  return rows
    .map((row) => {
      const tierKey = mosquitoTierKey(row);
      if (!['seasonal9', 'monthly12'].includes(tierKey) || seen.has(tierKey)) return null;
      seen.add(tierKey);
      const visits = finiteNumberOrNull(row.v ?? row.visits ?? row.visitsPerYear ?? row.frequency)
        || (tierKey === 'monthly12' ? 12 : 9);
      const monthlyBase = finiteNumberOrNull(row.mo ?? row.monthly);
      const annualBase = finiteNumberOrNull(row.ann ?? row.annual);
      const perTreatmentBase = finiteNumberOrNull(row.pv ?? row.pa ?? row.perTreatment ?? row.perApp ?? row.perVisit);
      const resolvedAnnualBase = annualBase != null
        ? annualBase
        : (monthlyBase != null ? roundMonthly(monthlyBase * 12) : (perTreatmentBase != null ? roundMonthly(perTreatmentBase * visits) : null));
      const resolvedMonthlyBase = monthlyBase != null
        ? monthlyBase
        : (resolvedAnnualBase != null ? roundMonthly(resolvedAnnualBase / 12) : null);
      const manualDiscount = resolvedAnnualBase != null
        ? manualDiscountForRecurringBase(rawManualDiscount, resolvedAnnualBase)
        : null;
      const manualDiscountAmount = Number(manualDiscount?.amount || 0);
      const manualDiscountMonthly = Number(manualDiscount?.monthlyAmount || 0);
      const monthly = resolvedMonthlyBase != null
        ? Math.max(0, roundMonthly(resolvedMonthlyBase - manualDiscountMonthly))
        : null;
      const annual = resolvedAnnualBase != null
        ? Math.max(0, roundMonthly(resolvedAnnualBase - manualDiscountAmount))
        : (monthly != null ? roundMonthly(monthly * 12) : null);
      const perTreatment = perTreatmentBase != null
        ? Math.max(0, roundMonthly(perTreatmentBase - (visits ? manualDiscountAmount / visits : 0)))
        : (annual != null && visits ? roundMonthly(annual / visits) : null);
      const labelBase = tierKey === 'monthly12' ? 'Monthly' : 'Seasonal';
      return {
        key: tierKey,
        label: labelBase,
        serviceCategory: 'mosquito',
        serviceTierKey: tierKey,
        monthlyBase: resolvedMonthlyBase,
        monthly,
        annual,
        perTreatment,
        visitsPerYear: visits,
        billingFrequencyKey: 'monthly',
        manualDiscount: manualDiscount || null,
        recommended: row.recommended === true || row.isRecommended === true,
        selected: row.selected === true || row.isSelected === true,
        included: [
          {
            key: `mosquito_${tierKey}`,
            label: `${labelBase} mosquito control program`,
            detail: visits ? `${Math.round(visits)} visits per year` : null,
            includedAtThisFrequency: true,
          },
          {
            key: 'mosquito_resting_zones',
            label: 'Resting-zone barrier treatment',
            detail: 'Targets shaded foliage, lanai edges, and mosquito resting areas',
            includedAtThisFrequency: true,
          },
        ],
        addOns: [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const order = { seasonal9: 0, monthly12: 1 };
      return (order[a.key] ?? 99) - (order[b.key] ?? 99);
    });
}

// Recurring foam is a single operator-chosen cadence (not a customer-selectable
// ladder like pest/mosquito), so build ONE frequency entry from the saved foam
// service row's cadence/visitsPerYear/monthly. Without this, a non-quarterly
// foam quote falls back to frequencies.slice(0,1) and is presented/billed as
// quarterly. Billed monthly (annual/12); serviced at the cadence's visitsPerYear.
function foamFrequenciesFromV1Services(services = []) {
  const row = (Array.isArray(services) ? services : [])
    .find((svc) => recurringServiceKey(svc) === 'foam_recurring');
  if (!row) return [];
  const VISITS = { quarterly: 4, bimonthly: 6, monthly: 12 };
  const VISITS_TO_CADENCE = { 4: 'quarterly', 6: 'bimonthly', 12: 'monthly' };
  const LABELS = { quarterly: 'Quarterly', bimonthly: 'Bimonthly', monthly: 'Monthly' };
  // Compact engine-backed rows (quote wizard / lead automation) persist name +
  // frequency but drop `cadence`, so derive it: explicit field → visit count →
  // the cadence baked into the line name, before defaulting to quarterly. (Check
  // bi-monthly before monthly — "bimonthly" contains "monthly".)
  const rawVisits = finiteNumberOrNull(row.visitsPerYear ?? row.visits ?? row.frequency);
  const nameLc = String(row.name ?? row.displayName ?? row.label ?? '').toLowerCase();
  const cadenceFromName = /bi-?monthly/.test(nameLc) ? 'bimonthly'
    : /monthly/.test(nameLc) ? 'monthly'
    : /quarterly/.test(nameLc) ? 'quarterly'
    : null;
  // Normalize aliases (bi_monthly → bimonthly) so an explicit row.cadence in the
  // alias form doesn't short-circuit the chain into the quarterly fallback.
  const CADENCE_ALIASES = { bi_monthly: 'bimonthly', 'bi-monthly': 'bimonthly', bimonth: 'bimonthly' };
  const normCadence = (c) => {
    const key = String(c || '').toLowerCase();
    return CADENCE_ALIASES[key] || (['quarterly', 'bimonthly', 'monthly'].includes(key) ? key : null);
  };
  const cadenceCandidate = normCadence(row.cadence)
    || normCadence(row.frequencyKey)
    || (rawVisits != null ? VISITS_TO_CADENCE[rawVisits] : null)
    || cadenceFromName;
  const cadence = ['quarterly', 'bimonthly', 'monthly'].includes(cadenceCandidate) ? cadenceCandidate : 'quarterly';
  const visits = rawVisits || VISITS[cadence];
  const monthlyBase = finiteNumberOrNull(row.mo ?? row.monthly);
  const perTreatmentBase = finiteNumberOrNull(row.perTreatment ?? row.perVisit ?? row.pv);
  // Prefer the authoritative sold annual (e.g. engine persists annual:1108,
  // monthly:92.33) so accept/invoice lock the engine price, not 92.33×12=1107.96.
  const annualBase = finiteNumberOrNull(row.annual ?? row.ann);
  const annual = annualBase != null
    ? annualBase
    : (monthlyBase != null
      ? roundMonthly(monthlyBase * 12)
      : (perTreatmentBase != null && visits ? roundMonthly(perTreatmentBase * visits) : null));
  const monthly = monthlyBase != null
    ? monthlyBase
    : (annual != null ? roundMonthly(annual / 12) : null);
  const perTreatment = perTreatmentBase != null
    ? perTreatmentBase
    : (annual != null && visits ? roundMonthly(annual / visits) : null);
  // Tier labor duration (priceRecurringFoam → 60/90/120/180) drives slot sizing.
  // The slot profile reads frequencies[].perServiceTreatments first, so carry it
  // both on the frequency and on a per-service treatment row.
  const estimatedDurationMinutes = finiteNumberOrNull(row.estimatedDurationMinutes ?? row.estimated_duration_minutes);
  const label = LABELS[cadence];
  return [{
    key: cadence,
    label,
    serviceCategory: 'foam_recurring',
    serviceTierKey: cadence,
    monthlyBase,
    monthly,
    annual,
    perTreatment,
    visitsPerYear: visits,
    billingFrequencyKey: 'monthly',
    estimatedDurationMinutes,
    // foam_recurring is non-discountable (cadence multiplier is its only
    // discount), so no manual-discount shaping here.
    manualDiscount: null,
    included: [{
      key: `foam_recurring_${cadence}`,
      label: `${label} foam treatment program`,
      detail: visits ? `${Math.round(visits)} visits per year` : null,
      includedAtThisFrequency: true,
    }],
    addOns: [],
    perServiceTreatments: [{
      service: 'foam_recurring',
      label: 'Recurring Foam Treatment',
      perTreatment,
      displayPrice: perTreatment,
      visitsPerYear: visits,
      estimatedDurationMinutes,
      waveGuardDiscountEligible: false,
    }],
  }];
}

// Engine-invocation path: build the foam frequency from the live engine result's
// foam_recurring line item (carries cadence/visitsPerYear/monthly/perVisit), so
// an engineInputs/engineResult foam quote isn't exposed as the default quarterly
// FREQUENCY_LADDER[0] entry.
function foamFrequenciesFromEngineResult(engineResult = {}) {
  const lineItems = Array.isArray(engineResult?.lineItems) ? engineResult.lineItems : [];
  const foam = lineItems.find((li) => li && (li.service === 'foam_recurring' || recurringServiceKey(li) === 'foam_recurring'));
  if (!foam) return [];
  return foamFrequenciesFromV1Services([foam]);
}

function quoteRequiredFromFrequency(frequency = {}) {
  return frequency?.quoteRequired === true
    || frequency?.kind === 'quote_required'
    || (frequency?.monthly == null && frequency?.annual == null && frequency?.perTreatment == null && frequency?.quoteRequired !== false);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function treeShrubTierRuntimeMeta(tierKey) {
  switch (String(tierKey || '').trim().toLowerCase()) {
    case 'light':
      return {
        tierKey: 'light',
        serviceKey: 'tree_shrub_quarterly',
        name: 'Quarterly Tree & Shrub Care Service',
        frequencyKey: 'quarterly',
        label: 'Quarterly',
        visitsPerYear: 4,
      };
    case 'standard':
      return {
        tierKey: 'standard',
        serviceKey: 'tree_shrub_program',
        name: 'Bi-Monthly Tree & Shrub Care Service',
        frequencyKey: 'bi_monthly',
        label: 'Bi-monthly',
        visitsPerYear: 6,
      };
    case 'enhanced':
      return {
        tierKey: 'enhanced',
        serviceKey: 'tree_shrub_6week',
        name: 'Every 6 Weeks Tree & Shrub Care Service',
        frequencyKey: 'every_6_weeks',
        label: 'Every 6 weeks',
        visitsPerYear: 9,
      };
    default:
      return null;
  }
}

function isTreeShrubTierFrequency(frequency = {}) {
  const meta = treeShrubTierRuntimeMeta(frequency?.key);
  if (!meta) return false;
  if (frequency.serviceCategory === 'tree_shrub') return true;
  const included = Array.isArray(frequency.included) ? frequency.included : [];
  return included.some((item) => {
    const raw = String(item?.key || item?.service || item?.label || '').toLowerCase();
    return raw.includes('tree_shrub') || raw.includes('tree') || raw.includes('shrub');
  });
}

function selectedTreeShrubServiceRow(existing = {}, frequency = {}) {
  const meta = treeShrubTierRuntimeMeta(frequency?.key);
  if (!meta) return existing;
  const monthly = finiteNumberOrNull(frequency.monthly ?? frequency.monthlyBase ?? existing.mo ?? existing.monthly ?? existing.monthlyTotal);
  const annual = finiteNumberOrNull(frequency.annual ?? existing.annual ?? existing.ann ?? existing.annualAfterDiscount);
  const perTreatment = finiteNumberOrNull(frequency.perTreatment ?? frequency.perVisit ?? existing.perTreatment ?? existing.perVisit ?? existing.pa);
  const visits = finiteNumberOrNull(frequency.visitsPerYear ?? existing.visitsPerYear ?? existing.visits ?? existing.v)
    || meta.visitsPerYear;
  const label = frequency.label || meta.label;
  const row = {
    ...existing,
    service: 'tree_shrub',
    serviceKey: meta.serviceKey,
    service_key: meta.serviceKey,
    name: meta.name,
    label: meta.name,
    displayName: meta.name,
    frequency: meta.frequencyKey,
    cadence: meta.frequencyKey,
    cadenceLabel: label,
    tier: meta.tierKey,
    tierKey: meta.tierKey,
    serviceTier: meta.tierKey,
    tierLabel: label,
    billingFrequencyKey: frequency.billingFrequencyKey || 'monthly',
    selected: true,
    isSelected: true,
  };
  if (monthly != null) {
    row.mo = monthly;
    row.monthly = monthly;
    row.monthlyTotal = monthly;
  }
  if (annual != null) {
    row.ann = annual;
    row.annual = annual;
    row.annualAfterDiscount = annual;
  }
  if (perTreatment != null) {
    row.pa = perTreatment;
    row.perTreatment = perTreatment;
    row.perVisit = perTreatment;
  }
  if (visits != null) {
    row.v = visits;
    row.visits = visits;
    row.visitsPerYear = visits;
    row.appsPerYear = visits;
  }
  return row;
}

function rewriteTreeShrubRecurringServices(services = [], frequency = {}) {
  if (!Array.isArray(services)) return { services, changed: false };
  let changed = false;
  const nextServices = services.map((svc) => {
    const name = svc?.name || svc?.label || svc?.displayName || svc?.service || svc?.serviceKey || svc?.service_key;
    if (!isTreeShrubServiceName(name)) return svc;
    changed = true;
    return selectedTreeShrubServiceRow(svc, frequency);
  });
  return { services: nextServices, changed };
}

function applyTreeShrubTierToRecurring(recurring = {}, frequency = {}) {
  if (!recurring || typeof recurring !== 'object') return recurring;
  const { services, changed } = rewriteTreeShrubRecurringServices(recurring.services, frequency);
  if (!changed) return recurring;
  const monthly = finiteNumberOrNull(frequency.monthly ?? frequency.monthlyBase);
  const annual = finiteNumberOrNull(frequency.annual);
  return {
    ...recurring,
    services,
    ...(monthly != null ? { monthlyTotal: monthly, grandTotal: monthly, mo: monthly } : {}),
    ...(annual != null ? { annualAfterDiscount: annual, annual, ann: annual } : {}),
  };
}

function markSelectedTreeShrubTierRows(rows = [], selectedTierKey = '') {
  if (!Array.isArray(rows)) return rows;
  const normalizedSelected = String(selectedTierKey || '').trim().toLowerCase();
  return rows.map((row) => {
    const tierKey = treeShrubTierKey(row);
    if (!['light', 'standard', 'enhanced'].includes(tierKey)) return row;
    return {
      ...row,
      selected: tierKey === normalizedSelected,
      isSelected: tierKey === normalizedSelected,
    };
  });
}

function applySelectedTreeShrubTierToEstimateData(estData = {}, frequency = {}) {
  if (!isTreeShrubTierFrequency(frequency)) return estData;
  const hasResult = estData.result && typeof estData.result === 'object';
  const sourceResult = hasResult ? estData.result : estData;
  const result = { ...sourceResult };

  if (result.recurring && typeof result.recurring === 'object') {
    result.recurring = applyTreeShrubTierToRecurring(result.recurring, frequency);
  }

  if (result.results && typeof result.results === 'object') {
    const results = { ...result.results };
    if (Array.isArray(results.ts)) {
      results.ts = markSelectedTreeShrubTierRows(results.ts, frequency.key);
    }
    if (results.recurring && typeof results.recurring === 'object') {
      results.recurring = applyTreeShrubTierToRecurring(results.recurring, frequency);
    }
    result.results = results;
  }

  if (!hasResult) return result;

  const nextData = { ...estData, result };
  if (estData.recurring && typeof estData.recurring === 'object') {
    nextData.recurring = applyTreeShrubTierToRecurring(estData.recurring, frequency);
  }
  return nextData;
}

// Lawn cadence runtime metadata — reuses the same cadence keys Tree & Shrub
// established (bi_monthly / every_6_weeks / monthly) so the accepted recurring
// line rides the proven downstream scheduling + billing plumbing.
const LAWN_CADENCE_RUNTIME = {
  basic: { tierKey: 'basic', serviceKey: 'lawn_care_quarterly', name: 'Quarterly Lawn Care Service', frequencyKey: 'quarterly', label: 'Quarterly', visitsPerYear: 4 },
  standard: { tierKey: 'standard', serviceKey: 'lawn_care_bimonthly', name: 'Bi-Monthly Lawn Care Service', frequencyKey: 'bi_monthly', label: 'Bi-monthly', visitsPerYear: 6 },
  enhanced: { tierKey: 'enhanced', serviceKey: 'lawn_care_6week', name: 'Every 6 Weeks Lawn Care Service', frequencyKey: 'every_6_weeks', label: '9 visits / yr', visitsPerYear: 9 },
  premium: { tierKey: 'premium', serviceKey: 'lawn_care_monthly', name: 'Monthly Lawn Care Service', frequencyKey: 'monthly', label: 'Monthly', visitsPerYear: 12 },
};
function lawnTierRuntimeMeta(tierKey) {
  return LAWN_CADENCE_RUNTIME[String(tierKey || '').trim().toLowerCase()] || null;
}

function isLawnTierFrequency(frequency = {}) {
  if (!lawnTierRuntimeMeta(frequency?.key)) return false;
  if (frequency.serviceCategory === 'lawn_care') return true;
  const included = Array.isArray(frequency.included) ? frequency.included : [];
  return included.some((item) => {
    const s = String(item?.key || item?.service || item?.label || '').toLowerCase();
    return s.includes('lawn') || s.includes('turf');
  });
}

function selectedLawnServiceRow(existing = {}, frequency = {}) {
  const meta = lawnTierRuntimeMeta(frequency?.key);
  if (!meta) return existing;
  const monthly = finiteNumberOrNull(frequency.monthly ?? frequency.monthlyBase ?? existing.mo ?? existing.monthly ?? existing.monthlyTotal);
  const annual = finiteNumberOrNull(frequency.annual ?? existing.annual ?? existing.ann ?? existing.annualAfterDiscount);
  const perTreatment = finiteNumberOrNull(frequency.perTreatment ?? frequency.perVisit ?? existing.perTreatment ?? existing.perVisit ?? existing.pa);
  const visits = finiteNumberOrNull(frequency.visitsPerYear ?? existing.visitsPerYear ?? existing.visits ?? existing.v) || meta.visitsPerYear;
  const label = frequency.label || meta.label;
  const row = {
    ...existing,
    service: 'lawn_care', serviceKey: meta.serviceKey, service_key: meta.serviceKey,
    name: meta.name, label: meta.name, displayName: meta.name,
    frequency: meta.frequencyKey, cadence: meta.frequencyKey, cadenceLabel: label,
    tier: meta.tierKey, tierKey: meta.tierKey, serviceTier: meta.tierKey, tierLabel: label,
    billingFrequencyKey: frequency.billingFrequencyKey || 'monthly',
    selected: true, isSelected: true,
  };
  if (monthly != null) { row.mo = monthly; row.monthly = monthly; row.monthlyTotal = monthly; }
  if (annual != null) { row.ann = annual; row.annual = annual; row.annualAfterDiscount = annual; }
  if (perTreatment != null) { row.pa = perTreatment; row.perTreatment = perTreatment; row.perVisit = perTreatment; }
  if (visits != null) { row.v = visits; row.visits = visits; row.visitsPerYear = visits; row.appsPerYear = visits; }
  return row;
}

function rewriteLawnRecurringServices(services = [], frequency = {}) {
  if (!Array.isArray(services)) return { services, changed: false };
  let changed = false;
  const nextServices = services.map((svc) => {
    const name = svc?.name || svc?.label || svc?.displayName || svc?.service || svc?.serviceKey || svc?.service_key;
    if (!isLawnServiceName(name)) return svc;
    changed = true;
    return selectedLawnServiceRow(svc, frequency);
  });
  return { services: nextServices, changed };
}

function applyLawnTierToRecurring(recurring = {}, frequency = {}) {
  if (!recurring || typeof recurring !== 'object') return recurring;
  const { services, changed } = rewriteLawnRecurringServices(recurring.services, frequency);
  if (!changed) return recurring;
  const monthly = finiteNumberOrNull(frequency.monthly ?? frequency.monthlyBase);
  const annual = finiteNumberOrNull(frequency.annual);
  return {
    ...recurring,
    services,
    ...(monthly != null ? { monthlyTotal: monthly, grandTotal: monthly, mo: monthly } : {}),
    ...(annual != null ? { annualAfterDiscount: annual, annual, ann: annual } : {}),
  };
}

function markSelectedLawnTierRows(rows = [], selectedTierKey = '') {
  if (!Array.isArray(rows)) return rows;
  const normalizedSelected = String(selectedTierKey || '').trim().toLowerCase();
  return rows.map((row) => {
    const tierKey = lawnTierKey(row);
    if (!['basic', 'standard', 'enhanced', 'premium'].includes(tierKey)) return row;
    return { ...row, selected: tierKey === normalizedSelected, isSelected: tierKey === normalizedSelected };
  });
}

// Mirror of applySelectedTreeShrubTierToEstimateData: when the customer picks a
// lawn cadence, re-stamp the recurring lawn line + results.lawn rows to that
// tier so the accepted service record schedules the chosen cadence/visits (the
// accepted PRICE already comes straight from selectedFrequency). Self-guards on
// lawn cadence frequencies, so it's a no-op for any other selection.
function applySelectedLawnTierToEstimateData(estData = {}, frequency = {}) {
  if (!isLawnTierFrequency(frequency)) return estData;
  const hasResult = estData.result && typeof estData.result === 'object';
  const sourceResult = hasResult ? estData.result : estData;
  const result = { ...sourceResult };

  if (result.recurring && typeof result.recurring === 'object') {
    result.recurring = applyLawnTierToRecurring(result.recurring, frequency);
  }
  if (result.results && typeof result.results === 'object') {
    const results = { ...result.results };
    if (Array.isArray(results.lawn)) {
      results.lawn = markSelectedLawnTierRows(results.lawn, frequency.key);
    }
    if (results.recurring && typeof results.recurring === 'object') {
      results.recurring = applyLawnTierToRecurring(results.recurring, frequency);
    }
    result.results = results;
  }

  if (!hasResult) return result;
  const nextData = { ...estData, result };
  if (estData.recurring && typeof estData.recurring === 'object') {
    nextData.recurring = applyLawnTierToRecurring(estData.recurring, frequency);
  }
  return nextData;
}

// ─── Mosquito cadence (Seasonal 9-visit / Monthly 12-visit) ──────────────────
// Mirror of the lawn cadence machinery so a customer who picks a mosquito
// cadence (in a bundle OR mosquito-only) gets it re-stamped onto the recurring
// line for scheduling/billing — the accepted PRICE already comes from the
// frequency/combo. Mosquito always bills monthly; the cadence drives visits/yr
// (Seasonal = 9 Mar–Nov, Monthly = 12). Seasonal reuses the proven 9-visit
// scheduling key (same as lawn Enhanced).
const MOSQUITO_CADENCE_RUNTIME = {
  seasonal9: { tierKey: 'seasonal9', serviceKey: 'mosquito_seasonal', name: 'Seasonal Mosquito Control', frequencyKey: 'every_6_weeks', label: 'Seasonal', visitsPerYear: 9 },
  monthly12: { tierKey: 'monthly12', serviceKey: 'mosquito_monthly', name: 'Monthly Mosquito Control', frequencyKey: 'monthly', label: 'Monthly', visitsPerYear: 12 },
};
function mosquitoTierRuntimeMeta(tierKey) {
  return MOSQUITO_CADENCE_RUNTIME[String(tierKey || '').trim().toLowerCase()] || null;
}

function isMosquitoTierFrequency(frequency = {}) {
  if (!mosquitoTierRuntimeMeta(frequency?.key)) return false;
  if (frequency.serviceCategory === 'mosquito') return true;
  const included = Array.isArray(frequency.included) ? frequency.included : [];
  return included.some((item) => String(item?.key || item?.service || item?.label || '').toLowerCase().includes('mosquito'));
}

function selectedMosquitoServiceRow(existing = {}, frequency = {}) {
  const meta = mosquitoTierRuntimeMeta(frequency?.key);
  if (!meta) return existing;
  const monthly = finiteNumberOrNull(frequency.monthly ?? frequency.monthlyBase ?? existing.mo ?? existing.monthly ?? existing.monthlyTotal);
  const annual = finiteNumberOrNull(frequency.annual ?? existing.annual ?? existing.ann ?? existing.annualAfterDiscount);
  const perTreatment = finiteNumberOrNull(frequency.perTreatment ?? frequency.perVisit ?? existing.perTreatment ?? existing.perVisit ?? existing.pa ?? existing.pv);
  const visits = finiteNumberOrNull(frequency.visitsPerYear ?? existing.visitsPerYear ?? existing.visits ?? existing.v) || meta.visitsPerYear;
  const label = frequency.label || meta.label;
  const row = {
    ...existing,
    service: 'mosquito', serviceKey: meta.serviceKey, service_key: meta.serviceKey,
    name: meta.name, label: meta.name, displayName: meta.name,
    frequency: meta.frequencyKey, cadence: meta.frequencyKey, cadenceLabel: label,
    tier: meta.tierKey, tierKey: meta.tierKey, serviceTier: meta.tierKey, tierLabel: label,
    billingFrequencyKey: frequency.billingFrequencyKey || 'monthly',
    selected: true, isSelected: true,
  };
  if (monthly != null) { row.mo = monthly; row.monthly = monthly; row.monthlyTotal = monthly; }
  if (annual != null) { row.ann = annual; row.annual = annual; row.annualAfterDiscount = annual; }
  if (perTreatment != null) { row.pa = perTreatment; row.pv = perTreatment; row.perTreatment = perTreatment; row.perVisit = perTreatment; }
  if (visits != null) { row.v = visits; row.visits = visits; row.visitsPerYear = visits; row.appsPerYear = visits; }
  return row;
}

function rewriteMosquitoRecurringServices(services = [], frequency = {}) {
  if (!Array.isArray(services)) return { services, changed: false };
  let changed = false;
  const nextServices = services.map((svc) => {
    const name = svc?.name || svc?.label || svc?.displayName || svc?.service || svc?.serviceKey || svc?.service_key;
    if (!isMosquitoServiceName(name)) return svc;
    changed = true;
    return selectedMosquitoServiceRow(svc, frequency);
  });
  return { services: nextServices, changed };
}

function applyMosquitoTierToRecurring(recurring = {}, frequency = {}) {
  if (!recurring || typeof recurring !== 'object') return recurring;
  const { services, changed } = rewriteMosquitoRecurringServices(recurring.services, frequency);
  if (!changed) return recurring;
  const monthly = finiteNumberOrNull(frequency.monthly ?? frequency.monthlyBase);
  const annual = finiteNumberOrNull(frequency.annual);
  return {
    ...recurring,
    services,
    ...(monthly != null ? { monthlyTotal: monthly, grandTotal: monthly, mo: monthly } : {}),
    ...(annual != null ? { annualAfterDiscount: annual, annual, ann: annual } : {}),
  };
}

function markSelectedMosquitoTierRows(rows = [], selectedTierKey = '') {
  if (!Array.isArray(rows)) return rows;
  const normalizedSelected = String(selectedTierKey || '').trim().toLowerCase();
  return rows.map((row) => {
    const tierKey = mosquitoTierKey(row);
    if (!['seasonal9', 'monthly12'].includes(tierKey)) return row;
    return { ...row, selected: tierKey === normalizedSelected, isSelected: tierKey === normalizedSelected };
  });
}

// Mirror of applySelectedLawnTierToEstimateData for mosquito. Self-guards on a
// mosquito cadence frequency, so it's a no-op for any other selection.
function applySelectedMosquitoTierToEstimateData(estData = {}, frequency = {}) {
  if (!isMosquitoTierFrequency(frequency)) return estData;
  const hasResult = estData.result && typeof estData.result === 'object';
  const sourceResult = hasResult ? estData.result : estData;
  const result = { ...sourceResult };

  if (result.recurring && typeof result.recurring === 'object') {
    result.recurring = applyMosquitoTierToRecurring(result.recurring, frequency);
  }
  if (result.results && typeof result.results === 'object') {
    const results = { ...result.results };
    if (Array.isArray(results.mq)) {
      results.mq = markSelectedMosquitoTierRows(results.mq, frequency.key);
    }
    if (results.recurring && typeof results.recurring === 'object') {
      results.recurring = applyMosquitoTierToRecurring(results.recurring, frequency);
    }
    result.results = results;
  }

  if (!hasResult) return result;
  const nextData = { ...estData, result };
  if (estData.recurring && typeof estData.recurring === 'object') {
    nextData.recurring = applyMosquitoTierToRecurring(estData.recurring, frequency);
  }
  return nextData;
}

function shapeServiceFrequency(frequency = {}, { allowAddOns = false } = {}) {
  const monthly = finiteNumberOrNull(frequency.monthly);
  const explicitAnnual = finiteNumberOrNull(frequency.annual);
  const annual = explicitAnnual != null ? explicitAnnual : (monthly != null ? roundMonthly(monthly * 12) : null);
  const perTreatment = finiteNumberOrNull(frequency.perTreatment ?? frequency.perVisit);
  const explicitMonthlyBase = finiteNumberOrNull(frequency.monthlyBase);
  const monthlyBase = explicitMonthlyBase != null ? explicitMonthlyBase : (pestMonthlyBaseForFrequency(frequency) ?? monthly);
  const explicitVisitsPerYear = finiteNumberOrNull(frequency.visitsPerYear);
  const visitsPerYear = explicitVisitsPerYear != null ? explicitVisitsPerYear : (pestVisitsForFrequency(frequency) || null);
  return {
    ...frequency,
    monthlyBase,
    monthly,
    annual,
    perTreatment,
    visitsPerYear,
    included: Array.isArray(frequency.included) ? frequency.included : [],
    addOns: allowAddOns && Array.isArray(frequency.addOns) ? frequency.addOns : [],
    quoteRequired: quoteRequiredFromFrequency({ ...frequency, monthly, annual, perTreatment }),
  };
}

function normalizePricingFrequencyTotals(frequency = {}) {
  if (!frequency || typeof frequency !== 'object') return frequency;
  const monthly = finiteNumberOrNull(frequency.monthly);
  const annual = finiteNumberOrNull(frequency.annual);
  if (annual != null || monthly == null) return frequency;
  return {
    ...frequency,
    annual: roundMonthly(monthly * 12),
  };
}

function defaultFrequencyKeyFor(frequencies = []) {
  if (!Array.isArray(frequencies) || frequencies.length === 0) return null;
  const selected = frequencies.find((frequency) => (
    frequency?.selected === true
    || frequency?.isSelected === true
  ));
  if (selected?.key) return selected.key;
  const recommended = frequencies.find((frequency) => (
    frequency?.recommended === true
    || frequency?.isRecommended === true
  ));
  if (recommended?.key) return recommended.key;
  return frequencies[0]?.key || null;
}

function defaultFrequencyFromList(frequencies = []) {
  if (!Array.isArray(frequencies) || frequencies.length === 0) return null;
  const defaultKey = defaultFrequencyKeyFor(frequencies);
  return frequencies.find((frequency) => frequency.key === defaultKey) || frequencies[0] || null;
}

function oneTimeContributionForCategory(oneTimeBreakdown = {}, category) {
  const items = (Array.isArray(oneTimeBreakdown?.items) ? oneTimeBreakdown.items : [])
    .filter((item) => serviceCategoryForOneTimeItem(item) === category);
  if (!items.length) return null;
  const subtotal = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return {
    items,
    subtotal: roundMonthly(subtotal),
  };
}

const RECURRING_SECTION_ORDER = [
  'pest_control',
  'lawn_care',
  'tree_shrub',
  'mosquito',
  'termite_bait',
  'palm_injection',
  'rodent_bait',
  'rodent',
];

function recurringSectionOrder(key) {
  const index = RECURRING_SECTION_ORDER.indexOf(key);
  return index === -1 ? RECURRING_SECTION_ORDER.length : index;
}

function recurringServiceRowsByKey(recurringServices = []) {
  const rowsByKey = new Map();
  (Array.isArray(recurringServices) ? recurringServices : []).forEach((svc) => {
    const key = recurringServiceKey(svc);
    if (key && !rowsByKey.has(key)) rowsByKey.set(key, svc);
  });
  return Array.from(rowsByKey.entries())
    .sort(([a], [b]) => recurringSectionOrder(a) - recurringSectionOrder(b));
}

function recurringLineKey(row = {}) {
  return recurringServiceKey({
    service: row.service,
    key: row.key,
    name: row.name || row.label || row.displayName,
  });
}

function treatmentRowForServiceFrequency(frequency = {}, key) {
  const rows = Array.isArray(frequency?.perServiceTreatments)
    ? frequency.perServiceTreatments
    : [];
  return rows.find((row) => recurringLineKey(row) === key) || null;
}

function frequencyHasTreatmentRowsForServices(frequency = {}, keys = []) {
  const rows = Array.isArray(frequency?.perServiceTreatments)
    ? frequency.perServiceTreatments
    : [];
  if (!rows.length) return false;
  const rowKeys = new Set(rows.map(recurringLineKey).filter(Boolean));
  return keys.every((key) => rowKeys.has(key));
}

function frequencyServiceRowsMonthlyTotal(frequency = {}, keys = []) {
  const total = keys.reduce((sum, key) => {
    if (sum == null) return null;
    const row = treatmentRowForServiceFrequency(frequency, key);
    if (!row) return null;
    const visitsPerYear = firstPositiveNumber(row.visitsPerYear, row.visits, row.frequency);
    const displayPrice = firstPositiveNumber(row.displayPrice, row.perTreatment, row.perVisit);
    if (visitsPerYear == null || displayPrice == null) return null;
    return sum + ((displayPrice * visitsPerYear) / 12);
  }, 0);
  return total == null ? null : roundMonthly(total);
}

function frequencyServiceRowsMatchMonthly(frequency = {}, keys = []) {
  if (!frequencyHasTreatmentRowsForServices(frequency, keys)) return false;
  const monthly = Number(frequency?.monthly);
  if (!Number.isFinite(monthly)) return false;
  const rowsMonthly = frequencyServiceRowsMonthlyTotal(frequency, keys);
  return rowsMonthly != null && Math.abs(roundMonthly(monthly) - rowsMonthly) <= 0.01;
}

function canSplitRecurringSelectableLadder(frequencies = [], recurringKeys = []) {
  const selectable = Array.isArray(frequencies)
    ? frequencies.filter((frequency) => frequency?.key)
    : [];
  if (!selectable.length) return false;
  return selectable.every((frequency) => frequencyServiceRowsMatchMonthly(frequency, recurringKeys));
}

function includedRowsForServiceFrequency(frequency = {}, key, recurringService = {}) {
  const included = Array.isArray(frequency?.included) ? frequency.included : [];
  const rows = included.filter((item) => recurringLineKey(item) === key);
  if (rows.length) return rows;
  const label = recurringService.displayName
    || recurringServiceDisplayName(key)
    || recurringService.name
    || serviceLabelForCategory(categoryForRecurringServiceKey(key) || key);
  const detail = isTermiteBaitServiceName(label)
    ? formatTermiteBaitDetail(null, recurringService.detail)
    : (recurringService.detail || recurringService.cadenceLabel || null);
  return [{
    key,
    label,
    detail,
    includedAtThisFrequency: true,
  }];
}

function frequencyFromTreatmentRow(baseFrequency = {}, key, row = {}, recurringService = {}, { allowAddOns = false, useBaseFrequencyKey = false } = {}) {
  const visitsPerYear = firstPositiveNumber(
    row.visitsPerYear,
    recurringService.visitsPerYear,
    recurringService.visits,
    recurringService.frequency,
  );
  const displayPrice = firstPositiveNumber(row.displayPrice, row.perTreatment, recurringService.perTreatment, recurringService.perVisit);
  const anchorPrice = firstPositiveNumber(row.perTreatment, row.perVisit, recurringService.perTreatment, recurringService.perVisit);
  const monthly = displayPrice && visitsPerYear
    ? roundMonthly((displayPrice * visitsPerYear) / 12)
    : null;
  const monthlyBase = anchorPrice && visitsPerYear
    ? roundMonthly((anchorPrice * visitsPerYear) / 12)
    : monthly;
  if (monthly == null && monthlyBase == null) return null;

  const useSelectableCadence = key === 'pest_control' || useBaseFrequencyKey;
  const fallbackLabel = recurringService.tierLabel
    || recurringService.cadenceLabel
    || row.label
    || recurringServiceDisplayName(key)
    || 'Recurring service';
  return {
    key: useSelectableCadence ? baseFrequency.key : 'recurring',
    label: useSelectableCadence
      ? (baseFrequency.label || fallbackLabel)
      : fallbackLabel,
    monthlyBase,
    monthly,
    annual: monthly != null ? roundMonthly(monthly * 12) : null,
    perTreatment: displayPrice || null,
    perVisit: key === 'pest_control' ? (anchorPrice || null) : null,
    visitsPerYear: visitsPerYear || null,
    included: includedRowsForServiceFrequency(baseFrequency, key, recurringService),
    addOns: allowAddOns && Array.isArray(baseFrequency.addOns) ? baseFrequency.addOns : [],
    quoteRequired: false,
  };
}

function frequencyFromRecurringService(recurringService = {}, key, recurringDiscount = 0) {
  const rawMonthly = firstPositiveNumber(recurringService.monthly, recurringService.mo);
  const receivesDiscount = recurringServiceReceivesTierDiscount(recurringService);
  const monthly = rawMonthly
    ? roundMonthly(rawMonthly * (receivesDiscount ? (1 - recurringDiscount) : 1))
    : null;
  const annual = firstPositiveNumber(recurringService.annualAfterCredits, recurringService.annualAfterDiscount, recurringService.annual, recurringService.ann, monthly ? monthly * 12 : null);
  const visitsPerYear = firstPositiveNumber(recurringService.visitsPerYear, recurringService.visits, recurringService.frequency);
  const perTreatment = firstPositiveNumber(
    recurringService.perTreatment,
    recurringService.perVisit,
    visitsPerYear && annual ? annual / visitsPerYear : null,
  );
  if (monthly == null && annual == null && perTreatment == null) return null;
  return {
    key: key === 'pest_control' ? 'quarterly' : 'recurring',
    label: recurringService.tierLabel || recurringService.cadenceLabel || recurringServiceDisplayName(key) || 'Recurring service',
    monthlyBase: rawMonthly || monthly,
    monthly,
    annual: annual != null ? roundMonthly(annual) : (monthly != null ? roundMonthly(monthly * 12) : null),
    perTreatment: perTreatment || null,
    perVisit: key === 'pest_control' ? (perTreatment || null) : null,
    visitsPerYear: visitsPerYear || null,
    included: includedRowsForServiceFrequency({}, key, recurringService),
    addOns: [],
    quoteRequired: false,
  };
}

function sectionFrequenciesForRecurringService(key, recurringService = {}, baseFrequencies = [], recurringDiscount = 0, { preserveSelectableKeys = false } = {}) {
  const allowAddOns = key === 'pest_control';
  if (key === 'pest_control') {
    const pestFrequencies = baseFrequencies
      .map((frequency) => {
        const row = treatmentRowForServiceFrequency(frequency, key);
        return row ? frequencyFromTreatmentRow(frequency, key, row, recurringService, { allowAddOns }) : null;
      })
      .filter(Boolean);
    if (pestFrequencies.length) return pestFrequencies;
  } else {
    const rowFrequencies = baseFrequencies
      .map((frequency) => {
        const row = treatmentRowForServiceFrequency(frequency, key);
        return row ? frequencyFromTreatmentRow(frequency, key, row, recurringService, {
          allowAddOns: false,
          useBaseFrequencyKey: preserveSelectableKeys,
        }) : null;
      })
      .filter(Boolean);
    if (rowFrequencies.length) return preserveSelectableKeys ? rowFrequencies : [rowFrequencies[0]];
  }

  const fallback = frequencyFromRecurringService(recurringService, key, recurringDiscount);
  return fallback ? [fallback] : [];
}

function buildServiceSection({ key, category, label, isRecurring, isPest, frequencies, setupFee, oneTimeBreakdown, quoteRequired, memberKeys }) {
  const shapedFrequencies = (Array.isArray(frequencies) ? frequencies : [])
    .map((frequency) => shapeServiceFrequency(frequency, { allowAddOns: isPest && isRecurring }));
  const sectionQuoteRequired = quoteRequired === true || shapedFrequencies.some((frequency) => frequency.quoteRequired === true);
  const normalizedMemberKeys = Array.isArray(memberKeys) && memberKeys.length ? memberKeys : [key];
  return {
    key,
    label: label || serviceLabelForCategory(category || key),
    isRecurring: !!isRecurring,
    isPest: !!isPest,
    // Single source of truth for the tier badge: eligible iff this section covers
    // at least one badge-eligible service (memberKeys defaults to [key]; a 'bundle'
    // passes all its recurring keys). The client reads this directly.
    waveGuardTierEligible: sectionTierEligibleFromKeys(isRecurring, normalizedMemberKeys),
    memberKeys: normalizedMemberKeys,
    isWaveGuardQualifier: PRICING_WAVEGUARD.qualifyingServices.includes(key),
    excludeFromPctDiscount: PRICING_WAVEGUARD.excludedFromPercentDiscount[key] === true,
    defaultFrequencyKey: defaultFrequencyKeyFor(shapedFrequencies),
    frequencies: shapedFrequencies,
    setupFee: setupFee || null,
    oneTimeContribution: oneTimeContributionForCategory(oneTimeBreakdown, category || key),
    intelligence: {
      metrics: [],
      chips: chipsForServiceCategory(category || key),
    },
    quoteRequired: sectionQuoteRequired,
    copy: SERVICE_COPY[category || key] || SERVICE_COPY.bundle,
  };
}

// ─── Per-service cadence in bundles (Layer 1: authoritative money math) ───────
// In a multi-service bundle the customer may pick EACH recurring service's
// cadence independently (e.g. pest Monthly + lawn Quarterly). The total for any
// combination is computed by reusing shapeFromV1 VERBATIM — clone v1.services
// with the chosen non-pest tier prices swapped in, then let shapeFromV1 apply the
// exact same WaveGuard discount / manual discount / preference-floor math it
// already uses for the default bundle. Because the view and the accept handler
// both price through this one path, shown == accepted == billed by construction.
//
// Non-pest per-tier prices come from the stored cost-floor tier rows
// (result.results.lawn / .ts / .mq) — the same rows the cadence extractors read.
// Only services with an applySelected*TierToEstimateData helper can be made
// independently selectable — accept rewrites the chosen tier into the recurring
// rows so the converter schedules + bills at that cadence. Lawn, Tree/Shrub, and
// Mosquito all have that helper.
const NON_PEST_RESULT_ROWS = {
  lawn_care: ['lawn', lawnTierKey],
  tree_shrub: ['ts', treeShrubTierKey],
  mosquito: ['mq', mosquitoTierKey],
};

// serviceKey -> { tierKey -> { mo, ann, pa, v, recommended, selected } } from the
// stored tier rows. These are PRE-discount per-tier prices; shapeFromV1 applies
// the discounts when it recomputes the bundle total for a given combination.
function nonPestTierBaseMap(resultStats = {}) {
  const out = {};
  for (const [serviceKey, [rowsKey, tierKeyFn]] of Object.entries(NON_PEST_RESULT_ROWS)) {
    const rows = Array.isArray(resultStats?.[rowsKey]) ? resultStats[rowsKey] : [];
    const tiers = {};
    for (const row of rows) {
      const tierKey = tierKeyFn(row);
      if (!tierKey || tiers[tierKey]) continue;
      const v = finiteNumberOrNull(row.v ?? row.visits ?? row.visitsPerYear ?? row.frequency);
      const mo = finiteNumberOrNull(row.mo ?? row.monthly);
      const ann = finiteNumberOrNull(row.ann ?? row.annual) ?? (mo != null ? roundMonthly(mo * 12) : null);
      const pa = finiteNumberOrNull(row.pa ?? row.pv ?? row.perTreatment ?? row.perApp ?? row.perVisit);
      if (mo == null && ann == null) continue;
      tiers[tierKey] = {
        mo, ann, pa, v,
        recommended: row.recommended === true || row.isRecommended === true,
        selected: row.selected === true || row.isSelected === true,
      };
    }
    if (Object.keys(tiers).length) out[serviceKey] = tiers;
  }
  return out;
}

// Swap a non-pest service row's prices/visits to the selected tier's values so
// shapeFromV1 sums the chosen cadence. (shapeFromV1 reads svc.mo for the total;
// the others keep the per-service treatment detail consistent.)
function applySelectedTierToServiceRow(svc, tier) {
  if (!tier) return svc;
  const next = { ...svc };
  if (tier.mo != null) { next.mo = tier.mo; next.monthly = tier.mo; }
  if (tier.ann != null) { next.ann = tier.ann; next.annual = tier.ann; }
  if (tier.pa != null) { next.perTreatment = tier.pa; next.perApp = tier.pa; next.perVisit = tier.pa; }
  if (tier.v != null) { next.visitsPerYear = tier.v; next.visits = tier.v; next.frequency = tier.v; }
  return next;
}

// Authoritative shapeFromV1 entry for one cadence combination. `selection` maps
// a service key to a tier key for non-pest services (pest cadence is the ladder).
function comboPricingEntry(v1, ladder, pestTier, prefs, tierBaseMap, selection = {}, options = {}) {
  const overridden = (Array.isArray(v1.services) ? v1.services : []).map((svc) => {
    const key = recurringServiceKey(svc);
    const tier = key && selection[key] ? tierBaseMap?.[key]?.[selection[key]] : null;
    return tier ? applySelectedTierToServiceRow(svc, tier) : svc;
  });
  return shapeFromV1({ ...v1, services: overridden }, ladder, pestTier, prefs, options);
}

// Stable composite key for a per-service selection, e.g. "lawn_care:basic|pest_control:monthly".
function serviceCadenceComboKey(selection = {}) {
  return Object.keys(selection)
    .filter((k) => selection[k] != null)
    .sort()
    .map((k) => `${k}:${selection[k]}`)
    .join('|');
}

// Precompute every selectable cadence combination for a bundle so the view can
// look up the authoritative total locally (no per-change round-trip) and the
// accept handler can resolve the exact same number. Returns null when there is
// nothing extra to vary (pest-only, or no non-pest service has >1 tier), or for
// no-pest bundles — in those cases the existing (non-combo) ladder already
// covers it. Per-service combos require a pest axis: the billing cadence /
// interval is driven by the pest cadence, so a no-pest bundle must NOT inherit a
// placeholder pest cadence (it would mis-resolve billing to quarterly/per-app).
function buildServiceCadenceCombos(v1, prefs, resultStats, { pestOnly = false } = {}) {
  if (!v1 || !Array.isArray(v1.services)) return null;
  const hasPest = Array.isArray(v1.pestTiers) && v1.pestTiers.length > 0;
  if (!hasPest) return null;
  const tierBaseMap = nonPestTierBaseMap(resultStats);
  const recurringKeys = Array.from(new Set(v1.services.map(recurringServiceKey).filter(Boolean)));
  const selectableNonPest = recurringKeys.filter(
    (k) => tierBaseMap[k] && Object.keys(tierBaseMap[k]).length > 1,
  );
  if (!selectableNonPest.length) return null;

  const pestAxis = Object.entries(V1_LABEL_TO_LADDER)
    .map(([label, ladder]) => ({ ladder, pestTier: v1.pestTiers.find((t) => t?.label === label) || null }))
    .filter((e) => e.pestTier);

  let combos = pestAxis.map((p) => ({
    pest: p,
    selection: { pest_control: p.ladder.key },
  }));
  for (const key of selectableNonPest) {
    const tierKeys = Object.keys(tierBaseMap[key]);
    const next = [];
    for (const combo of combos) {
      for (const tk of tierKeys) {
        next.push({ pest: combo.pest, selection: { ...combo.selection, [key]: tk } });
      }
    }
    combos = next;
  }

  return combos.map(({ pest, selection }) => {
    const entry = comboPricingEntry(v1, pest.ladder, pest.pestTier, prefs, tierBaseMap, selection, { pestOnly });
    return {
      key: serviceCadenceComboKey(selection),
      selection,
      monthly: entry.monthly,
      annual: entry.annual,
      perServiceTreatments: entry.perServiceTreatments,
      sameDayTreatmentTotal: entry.sameDayTreatmentTotal,
    };
  });
}

// Own-cadence ladder for a non-pest section in a bundle. Reuses the service's
// cadence extractor (same tier KEYS the combo ladder selects on), then reprices
// each tier post-WaveGuard-discount but PRE manual discount — manual is applied
// once to the bundle total and surfaced as its own line, so per-section cards
// must not also subtract it. Returns null unless the service offers 2+ tiers.
const BUNDLE_SECTION_EXTRACTOR = {
  lawn_care: lawnFrequenciesFromResultStats,
  tree_shrub: treeShrubFrequenciesFromResultStats,
  mosquito: mosquitoFrequenciesFromResultStats,
};
function bundleSectionLadderForService(serviceKey, estData, recurringService, recurringDiscount) {
  const extractor = BUNDLE_SECTION_EXTRACTOR[serviceKey];
  if (!extractor) return null;
  const entries = extractor(estData);
  if (!Array.isArray(entries) || entries.length < 2) return null;
  const d = recurringServiceReceivesTierDiscount(recurringService) ? (Number(recurringDiscount) || 0) : 0;
  return entries.map((e) => {
    const base = Number(e.monthlyBase);
    if (!Number.isFinite(base) || base <= 0) return { ...e, manualDiscount: null };
    const monthly = roundMonthly(base * (1 - d));
    const visits = Number(e.visitsPerYear) || null;
    const perTreatment = visits ? roundMonthly((monthly * 12) / visits) : (e.perTreatment ?? null);
    return {
      ...e,
      monthly,
      annual: roundMonthly(monthly * 12),
      perTreatment,
      manualDiscount: null,
      perServiceTreatments: Array.isArray(e.perServiceTreatments)
        ? e.perServiceTreatments.map((r) => ({ ...r, perTreatment, displayPrice: perTreatment }))
        : [],
    };
  });
}

function buildPricingServices(payload = {}, estimate = {}, estData = {}) {
  const estResult = estData?.result || estData?.engineResult || estData || {};
  const recurringServices = recurringServicesWithSupplements(estResult);
  const oneTimeBreakdown = payload.oneTimeBreakdown || normalizeOneTimeBreakdown(estData);
  const oneTimeItems = Array.isArray(oneTimeBreakdown?.items) ? oneTimeBreakdown.items : [];
  const serviceCategory = deriveServiceCategory(estData, recurringServices, oneTimeItems);
  const frequencies = Array.isArray(payload.frequencies) ? payload.frequencies : [];
  // Own-cadence section ladders are gated on the payload actually carrying the
  // backing combo pricing (set by the v1 recompute path); otherwise sections
  // keep the legacy ladder so sliders never appear without priceable combos.
  const hasServiceCadenceCombos = Array.isArray(payload.serviceCadenceCombos) && payload.serviceCadenceCombos.length > 0;
  const recurringKeys = Array.from(new Set(
    recurringServices
      .map(recurringServiceKey)
      .filter(Boolean)
  ));
  const hasRecurringPest = recurringKeys.includes('pest_control')
    || frequencies.some((frequency) => pestTreatmentRowForFrequency(frequency));
  const hasRecurringMosquito = recurringKeys.includes('mosquito');
  const isOneTimeOnly = payload.defaultServiceMode === 'one_time' || isStructuralOneTimeOnlyEstimate(estData, estimate);
  const waveGuardSetupFee = (payload.firstVisitFees || []).find((fee) => fee?.service === 'waveguard_setup') || payload.setupFee || null;
  const recurringRows = recurringServiceRowsByKey(recurringServices);
  const recurringDiscount = Number(estResult?.recurring?.discount || payload?.recurring?.discount || 0) || 0;

  if (!isOneTimeOnly && hasRecurringPest && recurringKeys.filter((key) => key !== 'pest_control').length === 0) {
    return [buildServiceSection({
      key: 'pest_control',
      category: 'pest_control',
      label: 'Pest Control',
      isRecurring: true,
      isPest: true,
      frequencies,
      setupFee: waveGuardSetupFee,
      oneTimeBreakdown,
      quoteRequired: payload.quoteRequired === true,
    })];
  }

  if (!isOneTimeOnly && recurringKeys.length === 1) {
    const key = recurringKeys[0];
    const category = categoryForRecurringServiceKey(key) || serviceCategory;
    return [buildServiceSection({
      key,
      category,
      label: recurringServiceDisplayName(key) || serviceLabelForCategory(category),
      isRecurring: true,
      isPest: key === 'pest_control',
      frequencies,
      setupFee: (key === 'pest_control' || key === 'mosquito') ? waveGuardSetupFee : null,
      oneTimeBreakdown,
      quoteRequired: payload.quoteRequired === true,
    })];
  }

  if (!isOneTimeOnly && recurringKeys.length > 1) {
    if (canSplitRecurringSelectableLadder(frequencies, recurringKeys)) {
      const hasRecurringPestSection = recurringKeys.includes('pest_control');
      const hasSelectableLadder = frequencies.filter((frequency) => frequency?.key).length > 1;
      const splitSections = recurringRows.map(([key, recurringService]) => {
        const category = categoryForRecurringServiceKey(key) || key;
        // Non-pest services in a bundle expose their OWN cadence ladder (the
        // customer picks each independently); the composite selection is priced
        // via the serviceCadenceCombos on the payload. Falls back to the legacy
        // pest-cadence-mirrored ladder when the service has only one tier.
        // Own-cadence ladders are exposed ONLY when the payload carries the
        // backing serviceCadenceCombos (priced + accept-resolvable). This keeps
        // sliders and combo pricing inseparable across snapshot / engine /
        // recompute paths — a bundle without combos keeps the legacy ladder so
        // the customer can't pick a cadence that isn't priced or persisted.
        const ownLadder = (key !== 'pest_control' && hasRecurringPestSection && hasServiceCadenceCombos)
          ? bundleSectionLadderForService(key, estData, recurringService, recurringDiscount)
          : null;
        const sectionFrequencies = (ownLadder && ownLadder.length)
          ? ownLadder
          : sectionFrequenciesForRecurringService(key, recurringService, frequencies, recurringDiscount, {
            preserveSelectableKeys: !hasRecurringPestSection || hasSelectableLadder,
          });
        if (!sectionFrequencies.length && payload.quoteRequired !== true) return null;
        return buildServiceSection({
          key,
          category,
          label: recurringService.displayName || recurringServiceDisplayName(key) || serviceLabelForCategory(category),
          isRecurring: true,
          isPest: key === 'pest_control',
          frequencies: sectionFrequencies,
          setupFee: (key === 'pest_control' || (key === 'mosquito' && !hasRecurringPestSection)) ? waveGuardSetupFee : null,
          oneTimeBreakdown,
          quoteRequired: payload.quoteRequired === true,
        });
      }).filter(Boolean);

      if (splitSections.length === recurringKeys.length) {
        return splitSections;
      }
    }

    return [buildServiceSection({
      key: 'bundle',
      category: 'bundle',
      label: 'Recurring services',
      isRecurring: true,
      isPest: hasRecurringPest,
      frequencies,
      setupFee: (hasRecurringPest || hasRecurringMosquito) ? waveGuardSetupFee : null,
      oneTimeBreakdown,
      quoteRequired: payload.quoteRequired === true,
      memberKeys: recurringKeys, // badge eligibility reflects the bundle's actual services
    })];
  }

  if (!isOneTimeOnly && recurringKeys.length === 0 && frequencies.length > 0) {
    const fallbackCategory = deriveServiceCategory(estData, [], []);
    return [buildServiceSection({
      key: fallbackCategory,
      category: fallbackCategory,
      label: serviceLabelForCategory(fallbackCategory),
      isRecurring: true,
      isPest: fallbackCategory === 'pest_control',
      frequencies,
      setupFee: (fallbackCategory === 'pest_control' || fallbackCategory === 'mosquito') ? waveGuardSetupFee : null,
      oneTimeBreakdown,
      quoteRequired: payload.quoteRequired === true,
    })];
  }

  const category = serviceCategory === 'bundle'
    ? (serviceCategoryForOneTimeItem(oneTimeItems[0]) || 'bundle')
    : serviceCategory;
  return [buildServiceSection({
    key: category,
    category,
    label: serviceLabelForCategory(category),
    isRecurring: false,
    isPest: category === 'pest_control',
    frequencies: [],
    setupFee: null,
    oneTimeBreakdown,
    quoteRequired: payload.quoteRequired === true || oneTimeBreakdown.quoteRequired === true,
  })];
}

function defaultFrequencyForSection(section = {}) {
  const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
  return frequencies.find((frequency) => frequency.key === section.defaultFrequencyKey)
    || defaultFrequencyFromList(frequencies)
    || null;
}

function buildCombinedRecurring(payload = {}, estimate = {}, estData = {}, services = []) {
  const recurringSections = services.filter((section) => section?.isRecurring);
  if (!recurringSections.length) return null;

  const estResult = estData?.result || estData?.engineResult || estData || {};
  const recurringServices = recurringServicesWithSupplements(estResult);
  const qualifyingKeys = new Set(
    recurringServices
      .filter(recurringServiceCountsTowardTier)
      .map(recurringServiceKey)
  );
  const tierLabel = normalizeWaveGuardTierLabel(payload.waveGuardTier || estimate.waveguard_tier || estimate.waveGuardTier || estimate.tier || 'Bronze');
  const frequency = defaultFrequencyForSection(recurringSections[0]);
  const legacyDefaultFrequency = defaultFrequencyFromList(payload.frequencies);
  const monthlySubtotal = roundMonthly(firstPositiveNumber(
    legacyDefaultFrequency?.monthly,
    frequency?.monthly,
    estimate.monthly_total,
    estimate.monthlyTotal,
  ) || 0);
  const annualSubtotal = roundMonthly(firstPositiveNumber(
    legacyDefaultFrequency?.annual,
    estimate.annual_total,
    estimate.annualTotal,
    monthlySubtotal ? monthlySubtotal * 12 : null,
    frequency?.annual,
  ) || 0);
  const parts = resolveRecurringMonthlyParts(estimate, estData);
  const manualDiscount = payload.manualDiscount || legacyDefaultFrequency?.manualDiscount || frequency?.manualDiscount || normalizeManualDiscountSummary(estData);
  const baseMonthly = Number(parts.baseMonthly || parts.discountableBaseMonthly || 0);
  const savingsPerMonth = baseMonthly > 0 ? Math.max(0, roundMonthly(baseMonthly - monthlySubtotal)) : 0;

  return {
    waveGuardTier: tierLabel.toLowerCase(),
    waveGuardTierLabel: tierLabel,
    qualifyingCount: qualifyingKeys.size,
    waveGuardDiscountPct: tierDiscountForEstimate(estData, tierLabel),
    monthlySubtotal,
    annualSubtotal,
    discountableBase: roundMonthly(parts.discountableBaseMonthly || 0),
    excludedBase: roundMonthly(parts.nonDiscountableMonthly || 0),
    savingsPerMonth,
    manualDiscount: manualDiscount || null,
  };
}

// Recurring service KEYS that surface the WaveGuard tier badge (Bronze), like
// pest. Per owner decision. Matched on the service key (palm_injection's section
// category aliases to 'tree_shrub' but its key stays 'palm_injection', so palm
// and rodent are simply absent from this allow-list).
const TIER_BADGE_ELIGIBLE_KEYS = new Set(['pest_control', 'lawn_care', 'tree_shrub', 'termite_bait', 'mosquito']);

// A recurring section shows the tier badge iff it represents AT LEAST ONE
// eligible service. memberKeys = the service keys the section covers ([key] for
// a single service; all recurring keys for a combined 'bundle'). This is the one
// source of truth, emitted per section as `waveGuardTierEligible` and read
// directly by the client — so: palm/rodent single sections stay badge-free, a
// bundle with an eligible service keeps the badge, and an excluded-only
// (palm+rodent) bundle does NOT badge.
function sectionTierEligibleFromKeys(isRecurring, memberKeys = []) {
  return !!isRecurring && (Array.isArray(memberKeys) ? memberKeys : []).some((k) => TIER_BADGE_ELIGIBLE_KEYS.has(k));
}

function buildRenderFlags(payload = {}, services = [], combinedRecurring = null) {
  const hasRecurringPest = services.some((section) => section?.isPest && section?.isRecurring);
  const hasPestOneTime = services.some((section) => section?.isPest && !section?.isRecurring);
  const hasWaivableSetupFee = services.some((section) => section?.isRecurring && section?.setupFee?.waivedWithPrepay);
  // Tier UI shows when any recurring section is badge-eligible. Derived from the
  // same per-section flag the client reads, so the global gate and the per-section
  // badge can never disagree. Pest-only setup fee/perks/add-ons stay on
  // hasRecurringPest below.
  const hasTierBadgeRecurringService = services.some((section) => section?.waveGuardTierEligible === true);
  const qualifyingCount = Number(combinedRecurring?.qualifyingCount || 0);
  const hasDiscountContext = Number(combinedRecurring?.waveGuardDiscountPct || 0) > 0
    || Number(combinedRecurring?.savingsPerMonth || 0) > 0;
  return {
    showRecurringSummary: combinedRecurring != null,
    showWaveGuardTierUi: hasRecurringPest || hasTierBadgeRecurringService || hasDiscountContext || qualifyingCount > 1,
    showWaveGuardPerks: hasRecurringPest || qualifyingCount > 1 || hasDiscountContext,
    showWaveGuardSetupFee: hasRecurringPest || hasWaivableSetupFee,
    showPestRecurringAddOns: hasRecurringPest && !payload.quoteRequired,
    showOneTimePestAddOns: false && hasPestOneTime,
  };
}

function attachPublicPricingContract(payload = {}, estimate = {}, estData = {}) {
  const contractPayload = Array.isArray(payload.frequencies)
    ? { ...payload, frequencies: payload.frequencies.map(normalizePricingFrequencyTotals) }
    : payload;
  const services = buildPricingServices(contractPayload, estimate, estData);
  const combinedRecurring = buildCombinedRecurring(contractPayload, estimate, estData, services);
  const serviceCategories = services.map((section) => (
    section.key === 'bundle' ? 'bundle' : (categoryForRecurringServiceKey(section.key) || section.key)
  ));
  const oneTimeBreakdownItems = contractPayload.oneTimeBreakdown?.items || [];
  const baseAskChips = mergeAskChips(serviceCategories.length ? serviceCategories : [deriveServiceCategory(estData, [], oneTimeBreakdownItems)]);
  // German Roach Cleanout classifies as generic pest_control, so mergeAskChips
  // would surface the generic ant/treat-inside chips. Lead with the roach
  // specialty prompts, keep the safety chip (it's a chemical service), and drop
  // those generic pest service chips — keeping the billing chips and any other
  // category's chips — so the React path matches the server-rendered page
  // (deduped, capped at 6).
  const askChipsBase = oneTimeBreakdownItems.some(isGermanRoachCleanoutOneTimeItem)
    ? Array.from(new Set([
        ...GERMAN_ROACH_ASK_CHIPS,
        SAFETY_ASK_CHIP,
        ...baseAskChips.filter((chip) => !GENERIC_PEST_SERVICE_CHIPS.includes(chip)),
      ])).slice(0, 6)
    : baseAskChips;
  // A separately-billed Bora-Care add-on classifies outside the recurring service
  // sections, so its chip is missing from the section-derived list. Prepend it (so
  // it survives the 6-chip cap), matching the merged one-time rows the SSR Ask
  // Waves prompt builder now reads.
  const askChips = oneTimeBreakdownItems.some(isBoraCareOneTimeItem) && !askChipsBase.includes(BORA_CARE_ASK_CHIP)
    ? Array.from(new Set([BORA_CARE_ASK_CHIP, ...askChipsBase])).slice(0, 6)
    : askChipsBase;
  // Engine-backed Bora-Care rows can arrive with the raw service key as their
  // label; map those to the friendly category label so the React breakdown header
  // and rows never show "bora_care" to customers (mirrors the SSR/invoice labels).
  const normalizedOneTimeBreakdown = contractPayload.oneTimeBreakdown && Array.isArray(contractPayload.oneTimeBreakdown.items)
    ? { ...contractPayload.oneTimeBreakdown, items: contractPayload.oneTimeBreakdown.items.map(normalizeBreakdownItemLabel) }
    : contractPayload.oneTimeBreakdown;
  const sectionQuoteRequired = services.some((section) => section.quoteRequired === true);
  return {
    ...contractPayload,
    services,
    combinedRecurring,
    renderFlags: buildRenderFlags(contractPayload, services, combinedRecurring),
    askChips,
    oneTimeBreakdown: normalizedOneTimeBreakdown,
    quoteRequired: contractPayload.quoteRequired === true || sectionQuoteRequired,
  };
}

// A breakdown row whose only label is the raw engine service key (e.g. "bora_care")
// is not customer-facing; map it to the friendly category label for the client
// payload. Mirrors the raw-key guard in buildOneTimeInvoiceServiceLabel.
function normalizeBreakdownItemLabel(item = {}) {
  if (!item || typeof item !== 'object') return item;
  const label = String(item.label || '').trim();
  const isRawKey = !!label && label.toLowerCase() === String(item.service || '').toLowerCase();
  if (!isRawKey) return item;
  const mapped = oneTimeInvoiceLabelForCategory(serviceCategoryForOneTimeItem(item), label);
  return mapped && mapped !== label ? { ...item, label: mapped } : item;
}

function finalizePricingBundle(payload = {}, estimate = {}, estData = {}) {
  const alignedPayload = alignOneTimeChoiceBreakdown(payload, estimate, estData);
  const withQuoteState = attachQuoteRequirement(alignedPayload, estData);
  const withContract = attachPublicPricingContract(withQuoteState, estimate, estData);
  const quoteState = resolveEstimateQuoteRequirement(withContract, estData);
  return {
    ...withContract,
    quoteRequired: quoteState.quoteRequired,
    quoteRequiredReason: quoteState.reason,
    quoteRequiredItems: quoteState.items,
    renderFlags: buildRenderFlags({ ...withContract, quoteRequired: quoteState.quoteRequired }, withContract.services, withContract.combinedRecurring),
  };
}

function buildEstimateAcceptanceContract({ quoteRequirement = {}, existingAppointment = null } = {}) {
  if (quoteRequirement.quoteRequired) {
    return {
      mode: 'quote_required',
      ctaLabel: 'Call Waves',
      reason: quoteRequirement.reason || 'quote_required',
    };
  }
  if (existingAppointment) {
    return {
      mode: 'existing_appointment',
      ctaLabel: 'Confirm invoice option',
      reason: null,
      appointment: shapeLinkedAppointment(existingAppointment),
    };
  }
  return {
    mode: 'standard_slot_pick',
    ctaLabel: 'Pick appointment',
    reason: null,
  };
}

function shapeFromV1(v1, ladder, pestTier, prefs, options = {}) {
  // pestTier may be null if pest isn't in this estimate. In that case
  // the frequency entry shows the recurring total regardless of freq key
  // (lawn-only / mosquito-only estimates — slider position doesn't
  // actually matter).
  const pestOnly = options.pestOnly === true && !!pestTier;
  const pestMoBefore = pestTier ? Number(pestTier.mo || 0) : 0;
  const pestAnnBefore = pestTier ? Number(pestTier.ann || 0) : 0;
  const nonPestServices = v1.services.filter((svc) => !isPestServiceName(svc?.name));
  const pestRecurring = pestTier
    ? { monthlyBase: pestMoBefore, visitsPerYear: Number(pestTier.apps || pestTier.v || 4) || 4 }
    : null;
  const { monthlyOff } = computePrefDiscount(prefs, pestRecurring, false, 0);
  const discountMonthly = (monthly, svc) => {
    const n = Number(monthly || 0);
    const discount = recurringServiceReceivesTierDiscount(svc) ? v1.discount : 0;
    return n * (1 - discount);
  };
  const pestMoAfter = pestTier ? discountMonthly(pestMoBefore, { service: 'pest_control' }) : 0;
  const nonPestMoAfter = pestOnly ? 0 : nonPestServices.reduce((sum, svc) => {
    return sum + discountMonthly(Number(svc?.mo || svc?.monthly || 0), svc);
  }, 0);
  const manualDiscountableAnnual = Math.round((
    (pestTier ? pestMoAfter * 12 : 0) +
    (pestOnly ? 0 : nonPestServices.reduce((sum, svc) => {
      if (!recurringServiceReceivesManualDiscount(svc)) return sum;
      return sum + discountMonthly(Number(svc?.mo || svc?.monthly || 0), svc) * 12;
    }, 0))
  ) * 100) / 100;
  const manualDiscount = manualDiscountForRecurringBase(v1.manualDiscount, manualDiscountableAnnual);
  const manualDiscountMonthly = Number(manualDiscount?.monthlyAmount || 0);
  const totalMoAfter = Math.max(0, Math.round((pestMoAfter + nonPestMoAfter - manualDiscountMonthly - monthlyOff) * 100) / 100);
  const totalAnnAfter = Math.round(totalMoAfter * 12 * 100) / 100;
  const treatmentDisplayPrice = (perTreatment, svc) => {
    const amount = Number(perTreatment);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const discount = recurringServiceReceivesTierDiscount(svc) ? v1.discount : 0;
    return Math.round(amount * (1 - discount) * 100) / 100;
  };

  // Included items: full recurring services list. These don't change with
  // pest frequency (changing quarterly → monthly doesn't add or remove
  // lawn care; only pest's visit cadence changes).
  const includedServices = pestOnly
    ? v1.services.filter((svc) => isPestServiceName(svc?.name))
    : v1.services;
  const included = includedServices.map((svc) => ({
    key: (svc?.name || '').toLowerCase().replace(/\s+/g, '_') || 'service',
    label: svc?.displayName || recurringServiceDisplayName(recurringServiceKey(svc)) || svc?.name || 'Service',
    detail: isTermiteBaitServiceName(svc?.name || svc?.label || svc?.service)
      ? formatTermiteBaitDetail(v1.tmBait, svc?.detail)
      : (svc?.detail || null),
    includedAtThisFrequency: true,
  }));

  const addOns = shapePreferenceAddOns(prefs, pestTier);

  // Per-treatment breakdown — one row per recurring service with its
  // pre-discount per-application price + visits/yr. Customers can see what
  // each visit costs and the combined per-treatment total when bundling.
  // Pest's row uses the currently-selected frequency's tier (pa varies by
  // cadence); non-pest rows pull perTreatment/visitsPerYear forwarded from
  // the line items at estimate-generation time.
  const perServiceTreatments = [];
  if (pestTier) {
    const pestPa = Number(pestTier.pa);
    perServiceTreatments.push({
      service: 'pest_control',
      label: `Pest Control (${pestTier.label || 'Quarterly'})`,
      perTreatment: Number.isFinite(pestPa) && pestPa > 0 ? pestPa : null,
      displayPrice: treatmentDisplayPrice(pestPa, { service: 'pest_control' }),
      visitsPerYear: Number(pestTier.apps || pestTier.v) || null,
      waveGuardDiscountEligible: true,
    });
  }
  if (!pestOnly) {
    nonPestServices.forEach((svc) => {
      const pa = Number(svc?.perTreatment ?? svc?.perApp ?? svc?.perVisit);
      const visits = Number(svc?.visitsPerYear ?? svc?.visits ?? svc?.frequency);
      perServiceTreatments.push({
        service: svc?.service || (svc?.name || '').toLowerCase().replace(/\s+/g, '_'),
        label: svc?.displayName || recurringServiceDisplayName(recurringServiceKey(svc)) || svc?.name || 'Service',
        perTreatment: Number.isFinite(pa) && pa > 0 ? pa : null,
        displayPrice: treatmentDisplayPrice(pa, svc),
        visitsPerYear: Number.isFinite(visits) && visits > 0 ? visits : null,
        waveGuardDiscountEligible: recurringServiceReceivesTierDiscount(svc),
      });
    });
  }
  const sameDayTreatmentTotal = perServiceTreatments.reduce(
    (sum, row) => sum + (Number.isFinite(row.perTreatment) ? row.perTreatment : 0),
    0,
  );

  return {
    key: ladder.key,
    label: ladder.label,
    monthly: totalMoAfter,
    annual: totalAnnAfter,
    perVisit: pestTier ? (Number(pestTier.pa) || null) : null,
    oneTimeTotal: v1.oneTimeTotal || null,
    manualDiscount,
    included,
    addOns,
    perServiceTreatments,
    sameDayTreatmentTotal: Math.round(sameDayTreatmentTotal * 100) / 100,
  };
}

function invalidateSendSnapshotPricingBundle(estData = {}) {
  if (!estData || typeof estData !== 'object' || !estData.sendSnapshot?.pricingBundle) return false;
  estData.sendSnapshot = { ...estData.sendSnapshot };
  delete estData.sendSnapshot.pricingBundle;
  delete estData.sendSnapshot.pricingBundleError;
  return true;
}

function resolveAnnualPrepayInvoiceAmount(annualTotal, monthlyTotal) {
  const annual = Number(annualTotal);
  if (Number.isFinite(annual) && annual > 0) {
    return Math.max(0, Math.round(annual * 100) / 100);
  }
  const monthly = Number(monthlyTotal);
  if (Number.isFinite(monthly) && monthly > 0) {
    return Math.max(0, Math.round(monthly * 12 * 100) / 100);
  }
  return 0;
}

async function buildPricingBundle(estimate) {
  cleanupEstimatePricingCache();
  const estData = typeof estimate.estimate_data === 'string'
    ? JSON.parse(estimate.estimate_data)
    : estimate.estimate_data;
  const storedOneTimeBreakdown = normalizeOneTimeBreakdown(estData);
  const withManualDiscount = (payload = {}) => {
    const manual = normalizeManualDiscountSummary(estData);
    if (!manual) return payload;
    const manualWithMonthly = {
      ...manual,
      // monthlyAmount is the per-month recurring figure, so it tracks only the
      // recurring slice; the one-time slice is shown in the one-time breakdown.
      monthlyAmount: Math.round((Number(manual.recurringAmount ?? manual.amount) / 12) * 100) / 100,
    };
    return {
      ...payload,
      manualDiscount: payload.manualDiscount || manualWithMonthly,
      frequencies: Array.isArray(payload.frequencies)
        ? payload.frequencies.map((frequency) => (
            frequency?.manualDiscount ? frequency : { ...frequency, manualDiscount: manualWithMonthly }
          ))
        : payload.frequencies,
    };
  };
  const withChoiceOneTimePrice = (payload = {}) => {
    if (!(estimate.show_one_time_option || estimate.showOneTimeOption)) return payload;
    const choicePrice = oneTimeChoiceAmountForEstimate(estimate, estData, {
      ...payload,
      oneTimeBreakdown: payload.oneTimeBreakdown || storedOneTimeBreakdown,
    });
    return choicePrice
      ? {
          ...payload,
          anchorOneTimePrice: choicePrice,
          oneTimeBreakdown: payload.oneTimeBreakdown || storedOneTimeBreakdown,
        }
      : payload;
  };
  const snapshotBundle = estData?.sendSnapshot?.pricingBundle;
  if (
    snapshotBundle
    && Array.isArray(snapshotBundle.frequencies)
    && pricingBundleMatchesEstimateTotals(snapshotBundle, estimate)
  ) {
    return finalizePricingBundle(withChoiceOneTimePrice(withManualDiscount({
      ...snapshotBundle,
      source: snapshotBundle.source || 'send_snapshot',
      snapshotHit: true,
    })), estimate, estData);
  }

  const cached = getEstimatePricingCache(estimate);
  if (cached) {
    return finalizePricingBundle(withChoiceOneTimePrice(withManualDiscount({ ...cached, cacheHit: true })), estimate, estData);
  }

  const prefs = normalizePrefs(estData?.preferences);

  // v1 shape (admin UI estimates) — read pre-computed pestTiers directly.
  // This is the dominant path until Session 11 retires the client engine.
  const v1 = readV1Shape(estData);
  if (v1) {
    const pestOnlyChoice = !!estimate.show_one_time_option && v1.pestTiers.length > 0;
    const frequencies = [];
    for (const [v1Label, ladder] of Object.entries(V1_LABEL_TO_LADDER)) {
      const pestTier = v1.pestTiers.find((t) => t?.label === v1Label) || null;
      frequencies.push(shapeFromV1(v1, ladder, pestTier, prefs, { pestOnly: pestOnlyChoice }));
    }

    // If no pest at all, drop the pest-cadence entries. Service-specific
    // phases can replace them with their own tier ladder.
    const hasPest = v1.pestTiers.length > 0;
    const recurringKeys = Array.from(new Set(v1.services.map(recurringServiceKey).filter(Boolean)));
    const treeShrubFreqs = !hasPest && recurringKeys.length === 1 && recurringKeys[0] === 'tree_shrub'
      ? treeShrubFrequenciesFromResultStats(estData)
      : [];
    const mosquitoFreqs = !hasPest && recurringKeys.length === 1 && recurringKeys[0] === 'mosquito'
      ? mosquitoFrequenciesFromResultStats(estData)
      : [];
    const lawnFreqs = !hasPest && recurringKeys.length === 1 && recurringKeys[0] === 'lawn_care'
      ? lawnFrequenciesFromResultStats(estData)
      : [];
    const foamFreqs = !hasPest && recurringKeys.length === 1 && recurringKeys[0] === 'foam_recurring'
      ? foamFrequenciesFromV1Services(v1.services)
      : [];
    const finalFreqs = hasPest
      ? frequencies
      : (treeShrubFreqs.length ? treeShrubFreqs
        : (mosquitoFreqs.length ? mosquitoFreqs
          : (lawnFreqs.length ? lawnFreqs
            : (foamFreqs.length ? foamFreqs : frequencies.slice(0, 1)))));
    const annualPrepayEligible = annualPrepayEligibleForEstimateData(estData);

    // First-visit fees stack — non-recurring charges shown to the customer
    // alongside their monthly price. WaveGuard membership is waivable with
    // annual prepay; the Initial Roach Knockdown (auto-fired when recurring
    // pest carries a roach type) is NOT waivable — it covers the heavier
    // visit-1 cost regardless of customer churn.
    const firstVisitFees = [];
    // The WaveGuard setup fee only applies to recurring pest/mosquito mixes — the
    // other recurring services are prepay-eligible too but carry no setup fee.
    if (annualPrepayEligible && (hasPest || recurringKeys.includes('mosquito'))) {
      firstVisitFees.push({
        service: 'waveguard_setup',
        amount: Number(v1.membershipFee || PEST.initialFee || 99) || 99,
        label: 'WaveGuard setup',
        waivedWithPrepay: true,
      });
    }
    const initialRoachItem = findInitialRoachItem(v1.pestTiers, estData);
    if (initialRoachItem) {
      firstVisitFees.push({
        service: 'pest_initial_roach',
        amount: initialRoachItem.price,
        label: initialRoachItem.label || 'Initial Roach Knockdown',
        waivedWithPrepay: false,
      });
    }

    // If the estimate has no recurring pest, the cached oneTime.total may
    // still include a stale $99 WaveGuard membership fee. The display
    // suppresses that fee for non-pest estimates; strip it from the anchor
    // price too so resolveAcceptOneTimeTotal doesn't end up charging it.
    const rawV1OneTimeTotal = v1.oneTimeTotal || Number(estimate.onetime_total || 0) || null;
    const choiceOneTimePrice = (estimate.show_one_time_option || estimate.showOneTimeOption)
      ? oneTimeChoiceAmountForEstimate(estimate, estData, { frequencies, oneTimeBreakdown: storedOneTimeBreakdown })
      : null;
    const anchorOneTimePrice = choiceOneTimePrice ?? ((!hasPest && rawV1OneTimeTotal && v1.membershipFee > 0)
      ? Math.max(0, Math.round((rawV1OneTimeTotal - v1.membershipFee) * 100) / 100)
      : rawV1OneTimeTotal);

    // Per-service cadence combinations (bundles): lets the customer pick each
    // service's cadence independently. Each combo is priced through shapeFromV1
    // (same path as the default), so the view can show the authoritative total
    // for any selection and accept resolves the exact same number. Null for
    // pest-only / single-tier / no-pest bundles (the pest ladder already covers
    // those). Computed BEFORE finalize and threaded into the payload so
    // buildPricingServices only exposes own-cadence section ladders when the
    // backing combo pricing is present — the two never desync across snapshot /
    // engine / recompute paths.
    const serviceCadenceCombos = buildServiceCadenceCombos(v1, prefs, recurringResultStats(estData), { pestOnly: pestOnlyChoice });
    const payload = finalizePricingBundle(withManualDiscount({
      frequencies: finalFreqs,
      waveGuardTier: v1.waveGuardTier || estimate.waveguard_tier || 'Bronze',
      anchorOneTimePrice,
      // Back-compat: keep `setupFee` populated with the first waivable entry
      // for any older client build still reading the singular field.
      setupFee: firstVisitFees.find((f) => f.waivedWithPrepay) || null,
      firstVisitFees,
      oneTimeBreakdown: storedOneTimeBreakdown,
      ...(serviceCadenceCombos && serviceCadenceCombos.length ? { serviceCadenceCombos } : {}),
      source: 'v1_engine_shape',
    }), estimate, estData);
    setEstimatePricingCache(estimate, payload);
    return payload;
  }

  // Otherwise: engine-invocation path (modular-engine inputs / IB-sourced
  // estimates with engineInputs.services.pest shape). Runs generateEstimate
  // 3x with varied pest frequency.
  const engineInputs = extractEngineInputs(estData);

  // No engine inputs saved → fall back to the single-frequency view using
  // stored totals. Not ideal but safer than fabricating a multi-frequency
  // ladder from nothing. React renders a simplified PriceCard.
  if (!engineInputs) {
    const storedChoiceOneTimePrice = (estimate.show_one_time_option || estimate.showOneTimeOption)
      ? oneTimeChoiceAmountForEstimate(estimate, estData, { oneTimeBreakdown: storedOneTimeBreakdown })
      : null;
    const manualDiscount = normalizeManualDiscountSummary(estData);
    const payload = finalizePricingBundle(withManualDiscount({
      frequencies: [{
        key: 'quarterly',
        label: 'Quarterly',
        monthly: Number(estimate.monthly_total || 0) || null,
        annual: Number(estimate.annual_total || 0) || null,
        perVisit: null,
        oneTimeTotal: Number(estimate.onetime_total || 0) || null,
        manualDiscount,
        included: [],
        addOns: [],
      }],
      waveGuardTier: estimate.waveguard_tier || 'Bronze',
      anchorOneTimePrice: storedChoiceOneTimePrice ?? (Number(estimate.onetime_total || 0) || null),
      oneTimeBreakdown: storedOneTimeBreakdown,
      fallback: 'no_engine_inputs',
    }), estimate, estData);
    setEstimatePricingCache(estimate, payload);
    return payload;
  }

  const frequencies = [];
  let anchorEngineResult = null;
  if (canVaryPestFrequency(engineInputs)) {
    // Run the engine 3x with different pest frequencies. Each call is
    // pure JS; no external I/O beyond the engine's own DB constants
    // sync which is cached internally.
    for (const ladder of FREQUENCY_LADDER) {
      const inputsForFrequency = JSON.parse(JSON.stringify(engineInputs));
      inputsForFrequency.services = inputsForFrequency.services || {};
      inputsForFrequency.services.pest = {
        ...(inputsForFrequency.services.pest || {}),
        frequency: ladder.engineFrequency,
      };
      try {
        const engineResult = generateEstimate(inputsForFrequency);
        if (!anchorEngineResult) anchorEngineResult = engineResult;
        frequencies.push(shapeFrequencyEntry(ladder, engineResult, engineInputs));
      } catch (err) {
        logger.error(`[estimate-data] engine failed at ${ladder.key}: ${err.message}`);
      }
    }
  } else {
    // No pest in the estimate — the pest cadence slider is meaningless. Run
    // the engine once at whatever was stored.
    try {
      const engineResult = generateEstimate(engineInputs);
      anchorEngineResult = engineResult;
      // Lawn-only estimates expose the 4/6/9/12 application ladder
      // (Basic/Standard/Enhanced/Premium) off the live lawn line item, mirroring
      // the v1 result.results.lawn path. Mixed bundles and other single-service
      // estimates keep the existing single-entry view.
      const lawnFreqs = lawnFrequenciesFromEngineResult(engineResult, estData);
      // The foam-specific frequency prices ONLY the foam line, so use it just for
      // a foam-only recurring mix. With another recurring service present (foam +
      // lawn/tree/mosquito), fall through to the full-summary shapeFrequencyEntry
      // so the price lock / annual prepay don't drop the other service.
      const recurringKeys = recurringServicesWithSupplements(engineResult)
        .map(recurringServiceKey)
        .filter(Boolean);
      const foamOnlyRecurring = recurringKeys.length > 0
        && recurringKeys.every((k) => k === 'foam_recurring');
      const foamFreqs = (lawnFreqs.length || !foamOnlyRecurring)
        ? []
        : foamFrequenciesFromEngineResult(engineResult);
      if (lawnFreqs.length) {
        frequencies.push(...lawnFreqs);
      } else if (foamFreqs.length) {
        frequencies.push(...foamFreqs);
      } else {
        frequencies.push(shapeFrequencyEntry(FREQUENCY_LADDER[0], engineResult, engineInputs));
      }
    } catch (err) {
      logger.error(`[estimate-data] engine failed (no-pest path): ${err.message}`);
    }
  }

  const generatedOneTimeBreakdown = anchorEngineResult
    ? normalizeOneTimeBreakdown({ engineResult: anchorEngineResult })
    : { items: [], total: 0 };
  const oneTimeBreakdown = generatedOneTimeBreakdown.items.length
    ? generatedOneTimeBreakdown
    : storedOneTimeBreakdown;
  const choiceOneTimePrice = (estimate.show_one_time_option || estimate.showOneTimeOption)
    ? oneTimeChoiceAmountForEstimate(estimate, estData, { frequencies, oneTimeBreakdown })
    : null;
  const oneTimeOnly = isStructuralOneTimeOnlyEstimate(estData, estimate);
  const anchorOneTimePrice = choiceOneTimePrice
    ?? firstPositiveNumber(
      oneTimeOnly ? oneTimeBreakdown.total : null,
      frequencies[0]?.oneTimeTotal,
      oneTimeBreakdown.total,
      estimate.onetime_total,
    );

  const payload = finalizePricingBundle(withManualDiscount({
    frequencies,
    waveGuardTier: estimate.waveguard_tier || 'Bronze',
    anchorOneTimePrice,
    defaultServiceMode: oneTimeOnly ? 'one_time' : 'recurring',
    oneTimeBreakdown,
    source: 'engine_invocation',
  }), estimate, estData);
  setEstimatePricingCache(estimate, payload);
  return payload;
}

const dataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

router.get('/:token/data', dataLimiter, async (req, res, next) => {
  try {
    // This JSON carries the customer's address, phone/email, notes, pricing,
    // and a bearer askToken. With React as the default estimate view it's the
    // primary payload, so it must be as uncacheable as the legacy server-HTML
    // page (which sets the same on sendEstimatePage) — no shared-browser or
    // intermediary retention of a tokenized estimate. Set on every response
    // path (incl. 404s) by stamping before any branch.
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Referrer-Policy', 'no-referrer');

    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    await reconcileFrozenMembershipSnapshot(estimate);

    const ip = extractRequestIp(req);

    // Security gate: the React SPA fetches this for ANY token, so an expired
    // link, an unpublished draft/scheduled-send, or a send-failed estimate must
    // NOT return the full quote + customer phone/email/address/notes. The legacy
    // server-HTML page short-circuited these to the expired/not-found shell
    // before building any payload; the data endpoint owns that guard for the
    // React path. Non-viewable → 404 (the SPA renders its "this link may have
    // expired or isn't valid" screen). No admin bypass: this fetch carries no
    // current-session credential (the public page sends no admin Bearer token),
    // and the `waves_admin` marker cookie is a 2-year, logout-persistent
    // view-count signal — not authorization — so previewing a draft/expired
    // estimate goes through an authenticated admin surface, never this endpoint.
    if (!isEstimateCustomerViewable(estimate)) {
      return res.status(404).json({ error: 'Estimate not found' });
    }

    // View signals fire on every 200 EXCEPT bot UAs and admin-IP previews
    // (filtered by shouldCountView). Defensive try/catch because schema
    // drift on estimate_views or a locked row shouldn't break the
    // customer-facing endpoint. The React page re-fetches /data after
    // preference/slot/accept actions (and tags those `?refresh=1`); only the
    // initial open counts, so internal refreshes don't inflate view_count the
    // way the single legacy HTML page load never did. `refresh` is a public
    // query param, so honor it ONLY once a first view is already recorded
    // (`viewed_at` set) — otherwise a caller could hit `?refresh=1` first to
    // suppress the very first "viewed" count + admin notification.
    const isInternalRefresh = req.query.refresh === '1' && Boolean(estimate.viewed_at);
    if (!isInternalRefresh && shouldCountView(req, ip, estimate)) {
      try {
        await db('estimates').where({ id: estimate.id }).update({
          view_count: db.raw('COALESCE(view_count, 0) + 1'),
          last_viewed_at: db.fn.now(),
        });
      } catch (e) { logger.error(`[estimate-data] view tracking failed: ${e.message}`); }

      try {
        const ua = (req.get('user-agent') || '').slice(0, 1000);
        await db('estimate_views').insert({
          estimate_id: estimate.id,
          viewed_at: db.fn.now(),
          ip: ip || null,
          user_agent: ua || null,
        });
      } catch (e) { logger.warn(`[estimate-data] estimate_views insert skipped: ${e.message}`); }
    }

    // First-view transition — keep admin preview clicks from making the
    // estimate look customer-opened. Internal React refreshes (?refresh=1) are
    // never the first view, so they must not flip status or notify admin twice.
    if (!isInternalRefresh && !estimate.viewed_at && shouldApplyFirstViewSideEffects(req, ip, estimate) && !['accepted', 'declined', 'expired'].includes(estimate.status)) {
      // Don't break an in-flight send's `sending` claim (which also gates
      // PUT /:id/proposal): stamp viewed_at but leave status='sending' alone —
      // the send's final write reconciles to `viewed` via viewed_at.
      await db('estimates').where({ id: estimate.id }).update({
        viewed_at: db.fn.now(),
        status: db.raw("CASE WHEN status = 'sending' THEN status ELSE 'viewed' END"),
      }).catch((e) => logger.error(`[estimate-data] first-view flip failed: ${e.message}`));
      try {
        await markLinkedLeadEstimateViewed({ estimateId: estimate.id });
      } catch (e) {
        logger.warn(`[estimate-data] linked lead view status update failed: ${e.message}`);
      }

      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyAdmin(
          'estimate',
          `Estimate viewed: ${estimate.customer_name}`,
          `${estimate.address || 'no address'} — $${estimate.monthly_total || 0}/mo`,
          { icon: '\u{1F4CB}', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } }
        );
      } catch (e) { logger.error(`[notifications] Estimate viewed notification failed: ${e.message}`); }
    }

    let estimateDataForIntelligence = {};
    try {
      estimateDataForIntelligence = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : (estimate.estimate_data || {});
    } catch {
      estimateDataForIntelligence = {};
    }

    const pricingBundle = await buildPricingBundle(estimate);
    const defaultServiceMode = defaultServiceModeForEstimate(estimateDataForIntelligence, estimate);
    const quoteRequirement = resolveEstimateQuoteRequirement(pricingBundle);
    const linkedAppointment = await findLinkedUpcomingAppointment(estimate, estimateDataForIntelligence);
    const recurringServicesForIntelligence = recurringServicesWithSupplements(
      estimateDataForIntelligence?.result || estimateDataForIntelligence?.engineResult || estimateDataForIntelligence || {}
    );
    const serviceCategory = deriveServiceCategory(
      estimateDataForIntelligence,
      recurringServicesForIntelligence,
      pricingBundle?.oneTimeBreakdown?.items || []
    );
    const acceptance = buildEstimateAcceptanceContract({ quoteRequirement, existingAppointment: linkedAppointment });
    const intelligence = buildWaveGuardIntelligencePayload(
      {
        ...estimate,
        satelliteUrl: estimate.satellite_url || null,
        tier: estimate.waveguard_tier || null,
      },
      estimateDataForIntelligence,
      { pricingBundle, recurringServices: recurringServicesForIntelligence },
    );
    try {
      const assistantContext = buildEstimateAssistantContext({
        estimate,
        estData: estimateDataForIntelligence,
        pricingBundle,
        selectedFrequency: '',
        serviceMode: defaultServiceMode,
      });
      intelligence.supportSources = loadPublicEstimateSupportSources({
        question: 'What is included in this WaveGuard estimate?',
        context: assistantContext,
      });
    } catch (err) {
      logger.warn(`[estimate-data] intelligence support context skipped: ${err.message}`);
    }

    const terminalState = (() => {
      if (['accepted', 'declined', 'expired'].includes(estimate.status)) return estimate.status;
      if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) return 'expired';
      return null;
    })();
    const ctaTerminalState = terminalState || (quoteRequirement.quoteRequired ? 'quote_required' : null);

    const membership = await buildEstimateMembershipContext(estimate);

    // Acceptance-deposit policy for the payment step: preference is unchosen
    // at data-fetch time, so this reflects the non-prepay path (prepay-annual
    // is exempt at accept regardless). The amount is the flat class amount —
    // structurally one-time estimates advertise the heavier figure; mixed
    // estimates advertise the recurring figure and the deposit-intent call
    // re-resolves with the customer's actual serviceMode.
    const depositEstData = (() => {
      try {
        return typeof estimate.estimate_data === 'string'
          ? JSON.parse(estimate.estimate_data)
          : (estimate.estimate_data || {});
      } catch { return {}; }
    })();
    const depositStructuralOneTime = isStructuralOneTimeOnlyEstimate(depositEstData, estimate);
    const depositPolicy = await resolveDepositPolicyForEstimate({
      estimate,
      paymentMethodPreference: null,
      membership,
      oneTime: depositStructuralOneTime,
      oneTimeUninvoiced: depositStructuralOneTime && estimate.bill_by_invoice !== true,
    });
    // One-time card-on-file hold policy ("as if one-time") for the React
    // capture UI — the page only enforces it once serviceMode is one_time.
    // Inert ({enforced:false}) while ONE_TIME_CARD_HOLD is off.
    const cardHoldOneTimePolicyForData = CardHolds.resolveCardHoldPolicy({
      treatAsOneTime: true,
      billByInvoice: estimate.bill_by_invoice === true,
      paymentMethodPreference: null,
    });

    // "Show your work" trust payload for the React estimate view. The key
    // only exists while the estimateShowYourWork gate is on, so gate-off
    // responses stay byte-identical; null means no enriched lookup data.
    const showYourWorkEnabled = featureGates.isEnabled('estimateShowYourWork');
    const showYourWork = showYourWorkEnabled
      ? await buildShowYourWork(estimate, estimateDataForIntelligence)
      : null;

    res.json({
      ...(showYourWorkEnabled ? { showYourWork } : {}),
      depositPolicy: {
        enforced: depositPolicy.enforced,
        required: depositPolicy.required,
        slotRequired: depositPolicy.slotRequired,
        exemptReason: depositPolicy.exemptReason || null,
        amount: depositPolicy.amount || null,
        // Class amounts for the recurring/one-time toggle copy — the
        // deposit-intent call re-resolves the authoritative charge.
        recurringAmount: depositPolicy.enforced ? computeDepositAmount({ oneTime: false }) : null,
        oneTimeAmount: depositPolicy.enforced ? computeDepositAmount({ oneTime: true }) : null,
      },
      cardHoldPolicy: cardHoldOneTimePolicyForData.enforced ? {
        enforced: true,
        requiredForOneTime: cardHoldOneTimePolicyForData.required,
        noShowFeeAmount: cardHoldOneTimePolicyForData.noShowFeeAmount || CardHolds.cardHoldNoShowFee(),
        cancelWindowHours: cardHoldOneTimePolicyForData.cancelWindowHours || CardHolds.cardHoldCancelWindowHours(),
      } : { enforced: false, requiredForOneTime: false },
      estimate: {
        id: estimate.id,
        token: estimate.token,
        slug: estimate.estimate_slug || null,
        customerFirstName: (estimate.customer_name || '').split(' ')[0] || null,
        customerName: estimate.customer_name || null,
        customerPhone: estimate.customer_phone || null,
        customerEmail: estimate.customer_email || null,
        address: estimate.address || null,
        askToken: signEstimateAskToken(estimate),
        category: estimate.category || 'RESIDENTIAL',
        createdAt: estimate.created_at,
        expiresAt: estimate.expires_at,
        status: estimate.status,
        satelliteUrl: estimate.satellite_url || null,
        intelligence,
        notes: estimate.notes || null,
        licenseNumber: process.env.WAVES_FDACS_LICENSE || null,
        showOneTimeOption: !!estimate.show_one_time_option,
        isOneTimeOnly: defaultServiceMode === 'one_time',
        defaultServiceMode,
        // What the customer booked (set at accept). Null for legacy accepts +
        // any non-accepted estimate; the accepted recap falls back to the
        // derived mode/frequency when null.
        acceptedServiceMode: estimate.accepted_service_mode || null,
        acceptedFrequencyKey: estimate.accepted_frequency_key || null,
        billByInvoice: !!estimate.bill_by_invoice,
        serviceCategory,
        acceptance,
        membership,
      },
      pricing: {
        ...pricingBundle,
        defaultServiceMode: pricingBundle.defaultServiceMode || defaultServiceMode,
      },
      cta: {
        canAccept: terminalState === null && !quoteRequirement.quoteRequired,
        terminalState: ctaTerminalState,
        quoteRequired: quoteRequirement.quoteRequired,
        quoteRequiredReason: quoteRequirement.reason || null,
        // Proposal-aware fields so the React view renders the formal-proposal
        // state (PDF + account-manager follow-up), not the generic
        // "inspection required" quote-required copy — and is channel-aware
        // about whether the PDF was actually emailed.
        commercialProposal: quoteRequirement.reason === 'commercial_proposal',
        proposalPdfEmailed: estimateDataForIntelligence?.proposalDelivery?.pdfEmailed === true,
      },
      meta: {
        generatedAt: new Date().toISOString(),
        engineVersion: estimate.pricing_version || null,
        cacheHit: !!pricingBundle.cacheHit,
      },
    });
  } catch (err) { next(err); }
});

async function handleEstimateAsk(req, res, next) {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question_required' });
    if (question.length > 500) return res.status(400).json({ error: 'question_too_long' });
    const selectedFrequency = typeof req.body?.selectedFrequency === 'string'
      ? req.body.selectedFrequency.trim()
      : '';
    const serviceMode = req.body?.serviceMode === 'one_time' ? 'one_time' : 'recurring';

    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!verifyEstimateAskToken(req, estimate)) {
      return res.status(403).json({ error: 'estimate_ask_forbidden' });
    }
    if (!isEstimateAskAnswerable(estimate)) {
      return res.status(409).json({ error: 'estimate_expired' });
    }

    // Self-heal a stale "existing customer" classification before the assistant
    // reads estimate_data / pricing, so a misclassified No-Plan lead isn't told
    // the setup is waived or annual prepay is unavailable while the page and
    // accept flow self-correct.
    await reconcileFrozenMembershipSnapshot(estimate);

    let estData = {};
    try {
      estData = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : (estimate.estimate_data || {});
    } catch {
      estData = {};
    }

    let pricingBundle = {};
    try {
      pricingBundle = await buildPricingBundle(estimate);
    } catch (err) {
      logger.warn(`[estimate-ask] pricing bundle failed: ${err.message}`);
    }

    const result = await answerEstimateQuestion({
      question,
      estimate,
      estData,
      pricingBundle,
      selectedFrequency,
      serviceMode,
    });

    await db('intelligence_bar_queries').insert(buildEstimateAskQueryLog({
      estimateId: estimate.id,
      question,
      result,
    })).catch((err) => {
      logger.warn(`[estimate-ask] query log skipped: ${err.message}`);
    });

    return res.json({
      answer: result.answer,
      source: result.source,
    });
  } catch (err) { next(err); }
}

module.exports = router;
module.exports.handleEstimateAsk = handleEstimateAsk;
module.exports.handleEstimateView = handleEstimateView;
module.exports.verifyEstimateAskToken = verifyEstimateAskToken;
module.exports.buildPricingBundle = buildPricingBundle;
module.exports.buildWaveGuardIntelligencePayload = buildWaveGuardIntelligencePayload;
module.exports.buildShowYourWork = buildShowYourWork;
module.exports.deriveServiceCategory = deriveServiceCategory;
module.exports.detectPestRecurring = detectPestRecurring;
module.exports.buildEstimateAcceptanceContract = buildEstimateAcceptanceContract;
module.exports.normalizeOneTimeBreakdown = normalizeOneTimeBreakdown;
module.exports.monthlyForRecurringParts = monthlyForRecurringParts;
module.exports.resolveRecurringMonthlyParts = resolveRecurringMonthlyParts;
module.exports.normalizeManualDiscountSummary = normalizeManualDiscountSummary;
module.exports.manualDiscountForRecurringBase = manualDiscountForRecurringBase;
module.exports.applyManualOneTimeDiscountToChoiceRows = applyManualOneTimeDiscountToChoiceRows;
module.exports.sameDayVisitTotalForPricingFrequency = sameDayVisitTotalForPricingFrequency;
module.exports.isGeneralPestOneTimeItem = isGeneralPestOneTimeItem;
module.exports.detectPestOneTime = detectPestOneTime;
module.exports.isGermanRoachCleanoutOneTimeItem = isGermanRoachCleanoutOneTimeItem;
module.exports.germanRoachVisitPhrase = germanRoachVisitPhrase;
module.exports.buildEstimateAskPrompts = buildEstimateAskPrompts;
module.exports.resolveAnnualPrepayInvoiceAmount = resolveAnnualPrepayInvoiceAmount;
module.exports.resolveEstimateQuoteRequirement = resolveEstimateQuoteRequirement;
module.exports.renderPage = renderPage;
module.exports.isStructuralOneTimeOnlyEstimate = isStructuralOneTimeOnlyEstimate;
module.exports.reconcileFrozenMembershipSnapshot = reconcileFrozenMembershipSnapshot;
module.exports.defaultServiceModeForEstimate = defaultServiceModeForEstimate;
module.exports.shouldPersistPestOnlyRecurringChoice = shouldPersistPestOnlyRecurringChoice;
module.exports.resolveAcceptOneTimeTotal = resolveAcceptOneTimeTotal;
module.exports.oneTimeChoiceAmountForEstimate = oneTimeChoiceAmountForEstimate;
module.exports.acceptedOneTimeChoiceListForEstimate = acceptedOneTimeChoiceListForEstimate;
module.exports.isAnnualPrepayEligibleServiceMix = isAnnualPrepayEligibleServiceMix;
module.exports.normalizeAcceptPaymentMethodPreference = normalizeAcceptPaymentMethodPreference;
module.exports.validateRecurringSlotPaymentPreference = validateRecurringSlotPaymentPreference;
module.exports.isReservationHeldAppointment = isReservationHeldAppointment;
module.exports.findLinkedUpcomingAppointment = findLinkedUpcomingAppointment;
module.exports.assertExistingAppointmentUpdateApplied = assertExistingAppointmentUpdateApplied;
module.exports.isEstimateAcceptActive = isEstimateAcceptActive;
module.exports.isEstimateCustomerViewable = isEstimateCustomerViewable;
module.exports.resolveEstimateDeclineGuard = resolveEstimateDeclineGuard;
module.exports.isEstimateAskAnswerable = isEstimateAskAnswerable;
module.exports.buildEstimateAskQueryLog = buildEstimateAskQueryLog;
module.exports.resolveRecurringFirstVisitAmount = resolveRecurringFirstVisitAmount;
module.exports.resolveRecurringFirstVisitAmountFromFrequency = resolveRecurringFirstVisitAmountFromFrequency;
module.exports.resolveRecurringInvoiceFirstVisitAmount = resolveRecurringInvoiceFirstVisitAmount;
module.exports.buildEstimateInvoiceModeDraft = buildEstimateInvoiceModeDraft;
module.exports.buildOneTimeInvoiceServiceLabel = buildOneTimeInvoiceServiceLabel;
module.exports.estimateInvoicePayUrlParams = estimateInvoicePayUrlParams;
module.exports.preferenceMonthlyOffForPestVisits = preferenceMonthlyOffForPestVisits;
module.exports.pestMonthlyBaseForFrequency = pestMonthlyBaseForFrequency;
module.exports.buildAcceptSuccessPayload = buildAcceptSuccessPayload;
module.exports.acceptanceServiceLists = acceptanceServiceLists;
module.exports.withSupplementedRecurringServices = withSupplementedRecurringServices;
module.exports.foamFrequenciesFromEngineResult = foamFrequenciesFromEngineResult;
module.exports.applySelectedTreeShrubTierToEstimateData = applySelectedTreeShrubTierToEstimateData;
module.exports.bookingServiceFor = bookingServiceFor;
module.exports.attachPublicPricingContract = attachPublicPricingContract;
module.exports.serviceCategoryForOneTimeChoice = serviceCategoryForOneTimeChoice;
module.exports.serviceCategoryForOneTimeItem = serviceCategoryForOneTimeItem;
module.exports.oneTimeInvoiceLabelForCategory = oneTimeInvoiceLabelForCategory;
module.exports.confirmationServiceLabel = confirmationServiceLabel;
module.exports.buildAcceptOfficeFallback = buildAcceptOfficeFallback;
module.exports.buildAcceptNotificationPayload = buildAcceptNotificationPayload;
module.exports.buildStandardPayPerApplicationInvoiceCopy = buildStandardPayPerApplicationInvoiceCopy;
module.exports.fireBundleQuoteRequestedNotification = fireBundleQuoteRequestedNotification;
module.exports.estimateHasBeenSent = estimateHasBeenSent;
module.exports.shouldApplyFirstViewSideEffects = shouldApplyFirstViewSideEffects;
module.exports.renderEditableSmsTemplate = renderEditableSmsTemplate;
module.exports.registerAcceptedEstimateAppointmentReminder = registerAcceptedEstimateAppointmentReminder;
module.exports.isRodentServiceName = isRodentServiceName;
module.exports.isTreeShrubServiceName = isTreeShrubServiceName;
module.exports.isMosquitoServiceName = isMosquitoServiceName;
module.exports.isLawnServiceName = isLawnServiceName;
module.exports.nonPestTierBaseMap = nonPestTierBaseMap;
module.exports.comboPricingEntry = comboPricingEntry;
module.exports.serviceCadenceComboKey = serviceCadenceComboKey;
module.exports.buildServiceCadenceCombos = buildServiceCadenceCombos;
module.exports.bundleSectionLadderForService = bundleSectionLadderForService;
module.exports.lawnFrequenciesFromResultStats = lawnFrequenciesFromResultStats;
module.exports.lawnFrequenciesFromEngineResult = lawnFrequenciesFromEngineResult;
module.exports.applySelectedLawnTierToEstimateData = applySelectedLawnTierToEstimateData;
module.exports.applySelectedMosquitoTierToEstimateData = applySelectedMosquitoTierToEstimateData;
module.exports.buildRenderFlags = buildRenderFlags;
module.exports.sectionTierEligibleFromKeys = sectionTierEligibleFromKeys;
module.exports.isTermiteTrenchingServiceName = isTermiteTrenchingServiceName;
module.exports.recurringServiceKey = recurringServiceKey;
module.exports.recurringServiceReceivesTierDiscount = recurringServiceReceivesTierDiscount;
module.exports.recurringServiceCountsTowardTier = recurringServiceCountsTowardTier;
