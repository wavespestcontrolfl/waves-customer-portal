const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const db = require('../models/db');
const logger = require('../services/logger');
const { formatAddress } = require('../utils/address-normalizer');
const { stampedDivergesSql, stampedLine2Sql } = require('../services/stamped-address');
const { FULL_TOKEN_RE, extractProjectReportTokenLookup } = require('../services/project-report-links');
const { answerProjectReportQuestion } = require('../services/project-report-assistant');
const {
  stripInternalFindingKeys,
  redactInspectionFeeCues,
  redactInspectionFeeCuesForType,
  redactSpecificAmounts,
  projectRecordedFeeValues,
  projectTypeFreeTextKeys,
  projectTypeHasInternalFindingKeys,
  // A legacy archived FDACS PDF was rendered from RAW findings AND raw photo
  // captions — if either carries a fee disclosure, the S3 binary discloses
  // it and cannot be sanitized in place. Those filings are GATED here (the
  // /data payload stops advertising the PDF; /fdacs-pdf 404s) while the
  // report page still renders the scrubbed findings and the legal archive
  // stays intact in S3. Filings stamped pdf_renderer were rendered through
  // the scrub and always serve. Shared with the admin detail serializer so
  // the staff preview matches (codex #2817).
  filingBinaryMayDiscloseFee,
} = require('../services/project-types');
const { findReportFollowupAppointment } = require('../services/report-followup-appointment');
const { buildReportV1Data, stripLiveOnlyScheduleFields, PIN_NO_ASSESSMENT, lawnAssessmentPdfSignature, resolveCanonicalLawnRender } = require('../services/service-report/report-data');

// lawn_assessments.id is a Postgres uuid — anything else must be refused
// before it reaches a query (#3168).
const ASSESSMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { verifyAssessmentPin } = require('../services/service-report/assessment-pin');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { isStaffAccessToken, staffTokenVersionMatches } = require('../middleware/admin-auth');

// internal_only / disabled typed completions (Phase-1b shadow, kill switch)
// store a report for STAFF review only. These public token routes serve them
// solely when the request carries a valid staff JWT — the report page
// attaches one when the browser is logged into the admin/tech portal — and
// 404 for everyone else. The token alone is not enough for suppressed
// reports: it appears in completion responses and staff UIs, so a copied
// URL must not open a report the customer was never sent.
function suppressedTypedReport(record) {
  let notes = record?.structured_notes;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch { notes = null; }
  }
  const mode = notes && typeof notes === 'object' ? notes.typedReportDelivery : null;
  return Boolean(mode) && mode !== 'auto_send';
}

// Seasonal pest forecast for the V2 report dashboards (pest + mosquito).
// Best-effort with a hard 4s cap — a forecast/network hiccup must never
// block or slow a report render.
async function fetchSeasonalForecastSafe(zip) {
  try {
    const { getForecast } = require('../services/pest-forecast/forecast');
    const timer = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 4000);
      if (t.unref) t.unref();
    });
    return await Promise.race([getForecast({ zip }), timer]);
  } catch {
    return null;
  }
}

async function staffCanViewSuppressed(req) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return false;
    const decoded = jwt.verify(header.slice(7), config.jwt.secret);
    if (!isStaffAccessToken(decoded) || !decoded.technicianId || decoded.scope === 'terminal') return false;
    const tech = await db('technicians')
      .where({ id: decoded.technicianId })
      .first('id', 'active', 'role', 'auth_token_version', 'must_change_password');
    return Boolean(
      tech
      && tech.active
      && ['admin', 'technician'].includes(tech.role)
      && !tech.must_change_password
      && staffTokenVersionMatches(decoded, tech)
    );
  } catch {
    return false;
  }
}

// Centralized gate: runs for EVERY route in this router with a :token param
// (data, PDF, preview, map.svg, ask, …) so no content-bearing subroute can
// be added and forgotten. Project-report tokens and unknown tokens pass
// through — each route resolves/404s on its own; this gate owns exactly one
// concern: suppressed service reports are staff-READ-only.
const RATE_LIMITED_WRITE_RE = /^\/[a-f0-9]{32}\/(events|pest-pressure\/client-rating)$/i;
router.param('token', async (req, res, next, token) => {
  try {
    if (!FULL_TOKEN_RE.test(String(token || ''))) return next();
    // These POST routes carry their own rate limiter, which must run before
    // any DB work (the general limiter deliberately skips /events). Their
    // handlers enforce suppression themselves, post-limiter.
    if (req.method === 'POST' && RATE_LIMITED_WRITE_RE.test(req.path || '')) return next();
    const record = await db('service_records')
      .where({ report_view_token: token })
      .first('id', 'structured_notes');
    if (!record || !suppressedTypedReport(record)) return next();
    // Staff bypass is READ-only review access. Writes on suppressed reports
    // mirror customer read eligibility and are rejected for everyone — a
    // staff token must not store customer state (ratings, events, questions)
    // on a report the customer cannot see.
    if ((req.method === 'GET' || req.method === 'HEAD') && await staffCanViewSuppressed(req)) {
      return next();
    }
    return res.status(404).json({ error: 'Report not found' });
  } catch (err) {
    return next(err);
  }
});
const { detectServiceLine } = require('../services/service-report/service-line-configs');
const {
  runAndSwallowErrors: runPestPressureForServiceRecord,
  calculateAndPersistForServiceRecord,
} = require('../services/pest-pressure/orchestrate');
const {
  loadActiveConfig,
  loadScoreForServiceRecord,
  loadHistoryForCustomer,
  pestPressureVisibilitySignature,
} = require('../services/pest-pressure/store');
const { buildPestPressureCustomerView } = require('../services/pest-pressure/customer-view');
const { isOneTimePressureExcludedRecord } = require('../services/pest-pressure/one-time-exclusion');
const { renderServiceReportV1Pdf, countUnreachableReportPhotos } = require('../services/service-report/pdf');
const { stripFixedReentryTiming, sanitizeProductTargets } = require('../services/social-media');
const { publicOriginPdfSignature } = require('../utils/portal-url');
// The approved idiom that replaces a stripped fixed-timing clause.
const REENTRY_SAFE_COPY = 'Ready once dry — your technician confirms timing.';
const { dateOnlyStamp } = require('../services/service-report/time-format');
const {
  getHealthyStoredReportPdf,
  putReportPdf,
  reportPdfStorageKey,
  timeOnSiteAdjustedPdfSignature,
  reentryAdjustedPdfSignature,
} = require('../services/service-report/pdf-storage');
const { summaryCopySignature, technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');
const {
  mosquitoReportV2PdfSignature,
  buildMosquitoReportV2,
  isRecurringMosquitoServiceType,
} = require('../services/service-report/mosquito-report-v2');
const { pestReportV2PdfSignature } = require('../services/service-report/pest-report-v2');
const { treatmentZonePdfSignature } = require('../services/treatment-zone-maps');
const { photoMarksPdfSignature } = require('../services/service-report/photo-marks');
const { stationMapPdfSignature } = require('../services/termite-stations');
const { treatmentNarrativePdfSignature } = require('../services/service-report/treatment-narrative');
const { enqueuePdfRenderRetry } = require('../services/service-report/pdf-queue');
const { safePdfRenderError } = require('../services/service-report/pdf-events');
const { buildServiceReportDynamicContext } = require('../services/service-report/dynamic-context');
const {
  answerServiceReportQuestion,
  loadReportAssistantProductContext,
} = require('../services/service-report/report-assistant');
const {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
} = require('../constants/business');

const PDF_NAVY = '#1B2C5B';
const PDF_BLUE = '#009CDE';
const PDF_BODY = '#3F4A65';
const PDF_MUTED = '#6B7280';
const PDF_RULE = '#E7E2D7';

// Rate-limit public report access to deter token brute-forcing. Two surfaces are
// exempt: report-interaction event posts, and recap-video playback (Safari/iOS issues
// many byte-range sub-requests when the customer scrubs the MP4, which would otherwise
// trip the 20/min limit). Both still require a valid 32-hex token.
function isReportLimiterExempt(req) {
  const path = req.path || '';
  if (req.method === 'POST' && /^\/[a-f0-9]{32}\/events$/i.test(path)) return true;
  if (req.method === 'GET' && /^\/[a-f0-9]{32}\/recap\/video\/?$/i.test(path)) return true;
  return false;
}

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isReportLimiterExempt,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

router.use(reportLimiter);

const reportEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many report events. Please try again in a minute.' },
});

// cross_sell_requested is not analytics: it recomputes the full offer
// (pricing engine + many reads) and writes durable rows, so it gets its own
// LOW per-token limiter ahead of any recomputation (local codex r15 P1) —
// a long-lived report token must not be able to drive expensive pricing
// work at the 120/min analytics rate. Keyed per token: the token is the
// capability under abuse, and per-token capping bounds each leaked link
// regardless of the caller's IP pool.
const crossSellActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `xsell:${req.params.token || 'anon'}`,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

const ALLOWED_REPORT_EVENTS = new Set([
  'service_report_viewed',
  'ai_summary_viewed',
  'ai_summary_personality_viewed',
  'ai_summary_personality_changed',
  'unfiltered_summary_opened',
  'pressure_trend_viewed',
  'pressure_trend_expanded',
  'lawn_assessment_viewed',
  'service_report_linked_to_outline',
  'property_defense_status_viewed',
  'bug_file_viewed',
  'why_activity_viewed',
  'the_one_thing_viewed',
  'weather_call_viewed',
  'report_view_mode_changed',
  'reentry_timer_viewed',
  'reentry_timer_completed',
  'report_question_asked',
  'sms_sent',
  'mms_sent',
  'mms_fallback_to_sms',
  'sms_preview_generated',
  'sms_preview_failed',
  'pdf_downloaded',
  'share_link_copied',
  'map_interacted',
  'photo_opened',
  'followup_requested',
  'review_request_clicked',
  'cross_sell_requested',
  'referral_cta_clicked',
]);
const ALLOWED_REPORT_EVENT_CHANNELS = new Set(['public_report', 'portal', 'email', 'sms', 'wallet']);

async function trackServiceReportView(service) {
  if (!service?.id || service.report_viewed_at) return;
  await db('service_records').where({ id: service.id }).update({ report_viewed_at: db.fn.now() });
  await db('activity_log').insert({
    customer_id: service.customer_id,
    action: 'report_viewed',
    description: `${service.first_name} ${service.last_name} viewed service report for ${service.service_type}`,
  }).catch(() => {});
}

function hashPublicIp(value) {
  const ip = String(value || '').trim();
  if (!ip) return null;
  const secret = process.env.SERVICE_REPORT_EVENT_SECRET
    || process.env.SERVICE_REPORT_TOKEN_SECRET
    || process.env.SESSION_SECRET
    || 'waves-service-report-events';
  return crypto.createHmac('sha256', secret).update(ip).digest('hex');
}

// Returns true only when the event row durably persisted. Analytics callers
// ignore the return (fire-and-forget as ever); the cross-sell request path
// MUST check it — its UI contract is "confirmed means recorded" (codex
// #3367 r5).
async function recordServiceReportEvent(service, eventName, channel, req, metadata = {}, dbConn = db) {
  if (!service?.id || !ALLOWED_REPORT_EVENTS.has(eventName) || !ALLOWED_REPORT_EVENT_CHANNELS.has(channel)) return false;
  try {
    await dbConn('service_report_events').insert({
      service_record_id: service.id,
      customer_id: service.customer_id || null,
      event_name: eventName,
      channel,
      metadata: JSON.stringify(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      user_agent: String(req.get('user-agent') || '').slice(0, 1000) || null,
      ip_hash: hashPublicIp(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress),
    });
    return true;
  } catch (err) {
    logger.warn(`[reports-public] service_report_event insert failed: ${err.message}`);
    return false;
  }
}

async function buildServiceReportV1ResponseData(service, token, {
  mode = 'live',
  pestPressureConfig,
  staffViewer = false,
  pinnedLawnAssessmentId = null,
} = {}) {
  // staffViewer gates internal_only companion sections (combined-service
  // completions): report-data omits them from customer payloads entirely.
  // Only the /data route resolves it (staffCanViewSuppressed — the same
  // staff-JWT signal as the Phase-1b suppressed-report gate); PDF, ask, and
  // every other caller stays a customer view.
  // mode rides into the builder so mode-sensitive copy (the pest Visit
  // Summary narrative) can exclude the live-only next appointment from
  // pdf/static text — the field-level strip below can't reach prose.
  const data = await buildReportV1Data(service, token, db, {
    pestPressureConfig, staffViewer, mode, pinnedLawnAssessmentId,
  });
  if (service?.report_template_version !== 'service_report_v1') return data;

  // nextAppointment + the V2 snapshot's nextVisit are LIVE-VIEW ONLY — the
  // shared helper documents why and also covers the queued PDF renderer,
  // which builds its payload outside this function (audit 2026-07-18 P2 +
  // codex r2).
  if (mode !== 'live') stripLiveOnlyScheduleFields(data);

  // The tech photo card is LIVE-VIEW ONLY for the same reason (Codex P2 on
  // #2614): the PDF cache key doesn't vary on GATE_REPORT_TECH_PHOTO, so a
  // gate flip would leave already-rendered PDFs stale in either direction.
  // PDFs keep the plain-text Technician cell, matching the pest-narrative
  // precedent of PDFs keeping the plain recap.
  if (mode !== 'live') data.techVisitCard = false;

  // COMPLIANCE, applied ONCE at the payload boundary for the printed record.
  // AGENTS.md bans fixed drying/re-entry figures on customer surfaces, and
  // label-derived catalog copy is unconstrained free text that can carry
  // them. Reuses stripFixedReentryTiming — the SAME clause-level rule (and
  // regression matrix) validateContent enforces for social copy — so this
  // has one definition instead of a second, weaker one per renderer. It is
  // clause-level on purpose: "keep pets off treated areas for 30 minutes and
  // avoid watering for 24 hours" loses the re-entry clause and KEEPS the
  // agronomic one.
  //
  // Scoped to non-live modes deliberately: the interactive report's own
  // re-entry copy is a separate remediation item for the owner to rule on,
  // and changing shipped customer-facing copy is not this PR's call.
  if (mode !== 'live') {
    const strip = (value) => stripFixedReentryTiming(value, REENTRY_SAFE_COPY).text;
    (data.applications || []).forEach((app) => {
      if (!app?.product) return;
      if (app.product.precaution_summary) app.product.precaution_summary = strip(app.product.precaution_summary);
      if (app.product.reentry_summary) app.product.reentry_summary = strip(app.product.reentry_summary);
    });
    if (data.reportV2?.aftercare?.reentry) {
      data.reportV2.aftercare.reentry = strip(data.reportV2.aftercare.reentry);
    }
    if (data.advisory?.pet_advisory) data.advisory.pet_advisory = strip(data.advisory.pet_advisory);
  }

  // buildPestPressureCustomerView returns null only when Pest Pressure
  // is hidden from the customer (feature disabled, showOnCustomerReport
  // off, service_line outside allow list, or requireRecurringFrequency
  // excludes this report). buildServiceReportDynamicContext computes the
  // same decision internally when omitPestPressureContext is undefined,
  // but we pass the resolved value to avoid a redundant DB roundtrip
  // (the visibility check loads config + score row).
  const omitPestPressureContext = data.pestPressure === null;
  const dynamicContext = await buildServiceReportDynamicContext({
    recordId: service.id,
    mode,
    omitPestPressureContext,
    pestPressureConfig,
  });
  // Suppressed typed reports (internal_only shadow / disabled kill switch)
  // reach this builder only for staff viewers — the param gate 404s everyone
  // else. No PDF exists for these records (renders are deferred until
  // auto_send) and the plain <a> download can't carry the staff JWT anyway,
  // so null the pdfUrl and flag the payload: the viewer swaps the
  // download/share bar for an internal-review notice instead of dead controls.
  // staffViewer is echoed to the client so ReportViewPage suppresses ALL
  // report-interaction event posts for the session (Codex P2): the /events
  // endpoint is unauthenticated (the client's POST carries no JWT — only the
  // /data fetch does), so the staff signal can't be re-derived server-side
  // and the analytics gate has to ride the payload. Flag only when true —
  // customer payloads stay byte-identical.
  // Lawn Report V2 — consistency pass: reconcile cross-section contradictions now
  // that dynamicContext (re-entry) is available. Attaches reconciled values to
  // reportV2 (todaysResult / followUp / reentry / warnings) and rewrites the legacy
  // re-entry pet advisory in place so "Ready now" never sits next to "until dry".
  // serviceLine drives which reconciliations apply — the reportV2 slot
  // carries lawn AND tree & shrub payloads, and the lawn-worded re-entry
  // rewrite ("treated turf") must never land on a tree & shrub report
  // (T&S audit 2026-07-18 P1). Shared with the queued PDF renderer so a
  // queue render never bakes pre-reconciliation copy into the PDF cache.
  {
    const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
    applyLawnReportReconciliation(data, dynamicContext);
  }

  // Pest Report V2 — protection-first dashboard (flag-gated). Surfaces the
  // already-built premium-experience intelligence (defense status, primary move,
  // bug files, pressure receipt, AI summary) that was computed but never rendered,
  // plus a seasonal "what to expect" forecast resolved from the property zip.
  // Pest service line only; best-effort so a forecast/network hiccup never blocks
  // the report. Flows to the client via the `...data` spread below.
  // Cockroach-FAMILY typed reports (generic cockroach + the roach
  // knockdown cleanouts) opt OUT of the V2 dashboard entirely (owner
  // 2026-07-27): its perimeter-protection story — "Where we protected",
  // entry/lanai/pool-pad rows, "no perimeter application was logged" — is
  // wrong for an interior cleanout and read as filler. Without the V2
  // shell the report composes from the typed record instead: Visit
  // Summary (narrative slot), the What-we-found tiles, and the activity
  // gauge, all of which the dashboard would otherwise suppress. The same
  // classifier drives the PDF cache suffix (pest-report-v2.js).
  const { buildPestReportV2, buildCustomerConcernCard, isCockroachTypedReportType } = require('../services/service-report/pest-report-v2');
  if (
    process.env.PEST_REPORT_V2 === 'true'
    && data.serviceLine === 'pest'
    && !isCockroachTypedReportType(data.typedReport?.type)
    && dynamicContext.premiumExperience
  ) {
    try {
      const forecast = await fetchSeasonalForecastSafe(service.zip);
      const pestReportV2 = buildPestReportV2({
        premiumExperience: dynamicContext.premiumExperience,
        pestPressure: data.pestPressure,
        // Typed pest reports render the FULL ActivityCard (gauge + score
        // history + progress chip) ALONGSIDE the dashboard (owner ruling
        // 2026-07-14 — the dashboard used to suppress the card, which
        // silently hid the chart and the knockdown progress chip on exactly
        // the bed bug / roach reports they target). Withholding activity
        // here drops the hero's compact pill on typed visits so the reading
        // shows once; recurring reports keep the hero metric as before.
        activity: data.typedReport ? null : data.activity,
        forecast,
        // Tech-reviewed AI report copy. Typed reports are gated out here —
        // their Today's Result card already renders the same copy, so the
        // hero showing it too would print the text twice on one page.
        technicianReport: !data.typedReport && data.summarySource === 'technician_report'
          ? data.summary
          : null,
        // Homeowner-reported concern → the "We looked into what you flagged"
        // card, so what the customer told the tech never disappears into a
        // summary clause (John Kelleher audit 2026-07-29).
        customerConcern: data.customerConcern || null,
      });
      if (pestReportV2) data.pestReportV2 = pestReportV2;
    } catch { /* best-effort — never block the report */ }
  }

  // Cockroach-family typed reports skip the V2 dashboard entirely, but the
  // homeowner's reported concern deserves the same acknowledgment card there —
  // the client renders data.customerConcernCard standalone without re-enabling
  // the perimeter dashboard (codex P2 #3043).
  if (
    process.env.PEST_REPORT_V2 === 'true'
    && data.serviceLine === 'pest'
    && !data.pestReportV2
    && data.customerConcern
  ) {
    try {
      const card = buildCustomerConcernCard(data.customerConcern);
      if (card) data.customerConcernCard = card;
    } catch { /* best-effort */ }
  }

  // Mosquito Report V2 — yard-usability dashboard for RECURRING mosquito visits
  // (flag-gated), same family as Pest V2 but with habitat semantics instead of
  // entry points (mosquito-report-v2.js explains the reframe). Mutually
  // exclusive with pestReportV2 by service line. One-time reports are
  // excluded two ways (codex P2 ×2): typed snapshots (mosquito_event) own
  // the purpose-built activity gauge the dashboard would suppress, and
  // legacy pre-typed-cutover one-time labels must not get recurring
  // "between visits" copy. Best-effort, never blocks.
  if (
    process.env.MOSQUITO_REPORT_V2 === 'true'
    && data.serviceLine === 'mosquito'
    && !data.typedReport
    && isRecurringMosquitoServiceType(service.service_type)
    && dynamicContext.premiumExperience
  ) {
    try {
      const forecast = await fetchSeasonalForecastSafe(service.zip);
      const mosquitoReportV2 = buildMosquitoReportV2({
        premiumExperience: dynamicContext.premiumExperience,
        pestPressure: data.pestPressure,
        activity: data.activity,
        findings: data.findings || [],
        applications: data.applications || [],
        forecast,
        // Same typed-report double-print guard as the pest hero.
        technicianReport: !data.typedReport && data.summarySource === 'technician_report'
          ? data.summary
          : null,
      });
      if (mosquitoReportV2) data.mosquitoReportV2 = mosquitoReportV2;
    } catch { /* best-effort — never block the report */ }
  }

  // Product TARGETS are free text from the tech's picker, so a chip can carry
  // a compliance claim the permanent PDF would print verbatim (codex P1
  // #3176 r24). Sanitized at the SAME payload boundary as the re-entry copy —
  // one enforcement point, not a per-render-site guard.
  if (mode !== 'live' && Array.isArray(data.applications)) {
    data.applications = data.applications.map((app) => {
      const result = sanitizeProductTargets(app?.targets);
      return result.changed ? { ...app, targets: result.targets } : app;
    });
  }

  // The re-entry context is assembled after the block above, so its
  // persisted free text (customerSummary, petAdvisory) gets the same
  // clause-level compliance pass here — same rule, one definition.
  if (mode !== 'live' && dynamicContext?.reentry) {
    const strip = (value) => stripFixedReentryTiming(value, REENTRY_SAFE_COPY).text;
    if (dynamicContext.reentry.customerSummary) {
      dynamicContext.reentry.customerSummary = strip(dynamicContext.reentry.customerSummary);
    }
    if (dynamicContext.reentry.petAdvisory) {
      dynamicContext.reentry.petAdvisory = strip(dynamicContext.reentry.petAdvisory);
    }
  }

  if (suppressedTypedReport(service)) {
    return { ...data, dynamicContext, pdfUrl: null, internalOnly: true, ...(staffViewer ? { staffViewer: true } : {}) };
  }

  // Cross-sell offer card (owner-approved 2026-08-11, GATE_REPORT_CROSS_SELL)
  // — LIVE VIEWS ONLY by ruling: the PDF is a pricing-free permanent record
  // (ServiceReportDocument header rule) and the S3 PDF cache key does not
  // vary on this gate, so a non-live render must never carry it in either
  // gate direction. Best-effort by contract: the builder returns null on any
  // failure/suppression and the report renders exactly as today.
  let crossSell = null;
  let referral = null;
  if (mode === 'live') {
    const { isEnabled } = require('../config/feature-gates');
    if (isEnabled('reportCrossSell')) {
      const { buildReportCrossSell } = require('../services/service-report/cross-sell');
      crossSell = await buildReportCrossSell(service, db);
      // The referral card rides the SAME gate + payload (codex #3367 r5),
      // and its copy is composed from the LIVE referral program settings
      // (codex PR r1): a disabled program suppresses the card entirely, and
      // the reward promise softens to match what the settings actually
      // grant — template copy must never advertise a benefit the referee
      // won't receive. Best-effort: unreadable settings suppress the card.
      // STRICT read (codex #3367 PR r2): getSettings() falls back to
      // program-active $25/$25 defaults on a failed or absent row, which
      // would advertise rewards a broken or unconfigured environment
      // cannot honor — no live row, no card.
      try {
        const referralEngine = require('../services/referral-engine');
        const settings = await referralEngine.getLiveSettings();
        if (settings?.program_active) {
          const referrerCents = Number(settings.referrer_reward_cents || 0);
          const refereeCents = Number(settings.referee_discount_cents || 0);
          referral = {
            line: referrerCents > 0 && refereeCents > 0
              ? 'Refer a friend — you both get rewarded when they start service.'
              : referrerCents > 0
                ? 'Refer a friend — you get rewarded when they start service.'
                : 'Refer a friend — we’ll take just as good care of them.',
          };
        }
      } catch (err) {
        logger.warn(`[reports-public] referral card suppressed: ${err.message}`);
      }
    }
  }

  return {
    ...data,
    dynamicContext,
    ...(crossSell ? { crossSell } : {}),
    ...(referral ? { referral } : {}),
    ...(staffViewer ? { staffViewer: true } : {}),
  };
}

async function findProjectByReportSegment(segment) {
  const lookup = extractProjectReportTokenLookup(segment);
  if (!lookup) return null;
  const query = db('projects as p')
    .leftJoin('customers as c', 'p.customer_id', 'c.id')
    .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
    .select(
      'p.*',
      'c.first_name', 'c.last_name', 'c.email as customer_email', 'c.phone as customer_phone',
      'c.has_left_google_review',
      'c.address_line1', 'c.address_line2', 'c.city', 'c.state', 'c.zip',
      // Feed the canonical review resolver for the payload's reviewLocation.
      'c.latitude as customer_latitude', 'c.longitude as customer_longitude',
      'c.nearest_location_id',
      't.name as technician_name',
    );
  if (lookup.type === 'full') {
    return query.where({ 'p.report_token': lookup.value }).first();
  }
  const rows = await query.where('p.report_token', 'like', `${lookup.value}%`).limit(2);
  return rows.length === 1 ? rows[0] : null;
}

// WDO report payment hold: while a report is held ('held'/'releasing'), its
// public token serves a 402 payment-required payload instead of any report
// content. The token itself is not proof of entitlement here — the hold flow
// never emails the report link, but admin previews, the portal, or a
// forwarded pay page could surface the URL early. payUrl rides along so the
// viewer can render a "pay to receive your report" card; exposing it to a
// token holder is intended — they are the party the pay link was sent to.
async function heldReportPaymentContext(project) {
  if (!['held', 'releasing'].includes(String(project?.report_hold_status || ''))) return null;
  let payUrl = null;
  let invoiceNumber = null;
  let paymentProcessing = false;
  let payerBilled = false;
  if (project.invoice_id) {
    const invoice = await db('invoices')
      .where({ id: project.invoice_id })
      .first('id', 'token', 'invoice_number', 'status', 'payer_id')
      .catch(() => null);
    const invoiceStatus = String(invoice?.status || '').toLowerCase();
    // Third-party Bill-To isolation (Codex P1 on #2753): a payer-billed
    // invoice's pay link belongs to the payer's AP inbox ONLY — the send
    // paths never hand it to the homeowner, and this token page is opened by
    // homeowners AND the third parties a WDO link is forwarded to. No pay
    // CTA, no billing metadata; just "billed to the requesting party".
    payerBilled = Boolean(invoice?.payer_id);
    // ACH clearing window: pay-v2 rejects 'processing' invoices (an in-flight
    // bank payment), so a pay CTA here would dead-end — tell the customer the
    // payment is processing instead of asking them to pay again.
    paymentProcessing = !payerBilled && invoiceStatus === 'processing';
    // Only offer the pay CTA while the invoice is actually collectible:
    // settled-but-not-yet-swept rows still 402 (the sweep delivers within a
    // minute), and non-collectible statuses (void/refunded/cancelled — pay-v2
    // rejects them all) must not render a button that errors on the pay page.
    if (
      !payerBilled
      && invoice?.token
      && !['paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled', 'sending'].includes(invoiceStatus)
    ) {
      const { publicPortalUrl } = require('../utils/portal-url');
      payUrl = `${publicPortalUrl()}/pay/${invoice.token}`;
    }
    invoiceNumber = payerBilled ? null : (invoice?.invoice_number || null);
  }
  return { payUrl, invoiceNumber, paymentProcessing, payerBilled };
}

// GET /api/reports/project/:token/data — project report JSON for the viewer page
router.get('/project/:token/data', async (req, res, next) => {
  // Same privacy headers as the sibling /fdacs-pdf route, set before ANY
  // response leaves — the payment-held 402 carries the invoice number and a
  // bearer pay URL, so it needs the no-store/noindex/no-referrer protection
  // just as much as the successful report payload (codex #2817).
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!extractProjectReportTokenLookup(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const project = await findProjectByReportSegment(req.params.token);
    if (!project) return res.status(404).json({ error: 'Report not found' });

    const heldContext = await heldReportPaymentContext(project);
    if (heldContext) {
      const typeCfg = require('../services/project-types').getProjectType(project.project_type);
      return res.status(402).json({
        error: 'Report pending payment',
        code: 'report_payment_required',
        projectType: project.project_type,
        reportTypeLabel: typeCfg?.label || 'Inspection',
        payUrl: heldContext.payUrl,
        invoiceNumber: heldContext.invoiceNumber,
        paymentProcessing: heldContext.paymentProcessing,
        payerBilled: heldContext.payerBilled,
      });
    }

    if (!project.report_viewed_at) {
      await db('projects').where({ id: project.id }).update({ report_viewed_at: db.fn.now() });
      try {
        const customerName = `${project.first_name || ''} ${project.last_name || ''}`.trim();
        await db('activity_log').insert({
          customer_id: project.customer_id,
          action: 'project_report_viewed',
          description: customerName
            ? `${customerName} viewed project report for ${project.project_type}`
            : `Project report viewed for ${project.project_type}`,
          metadata: {
            project_id: project.id,
            project_type: project.project_type,
          },
        });
      } catch (err) {
        logger.warn(`[reports-public] project activity_log insert failed: ${err.message}`);
      }
    }

    // Computed early: gates every free-text scrub on this route (finding
    // values, recommendations, photo captions). Only a type carrying the
    // internal fee field (WDO) gets text redacted. feeValues powers the
    // VALUE pass — a paraphrase without the literal cue ("the $250 charge")
    // is caught on every one of these surfaces (codex #2817).
    const typeCarriesFee = projectTypeHasInternalFindingKeys(project.project_type);
    const feeValues = typeCarriesFee ? projectRecordedFeeValues(project) : [];
    const freeTextKeys = projectTypeFreeTextKeys(project.project_type);
    const scrubText = (text) => {
      if (!typeCarriesFee || !text) return text;
      let safe = redactInspectionFeeCues(text);
      if (feeValues.length) safe = redactSpecificAmounts(safe, feeValues);
      return safe;
    };

    const photos = await db('project_photos')
      .where({ project_id: project.id })
      .orderBy(['visit', 'sort_order', 'created_at']);

    // Build presigned URLs — tokens already gate access, but the S3 objects
    // themselves are private so the viewer needs signed links.
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const config = require('../config');
    const s3 = new S3Client({
      region: config.s3?.region,
      credentials: config.s3?.accessKeyId
        ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
        : undefined,
    });
    const { CUSTOMER_DWELL_TTL_SECONDS } = require('../services/photos');
    const photosWithUrls = await Promise.all(photos.map(async (ph) => {
      let url = null;
      if (config.s3?.bucket && ph.s3_key) {
        try {
          url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: ph.s3_key }), { expiresIn: CUSTOMER_DWELL_TTL_SECONDS });
        } catch { /* fall through — photo will render as missing */ }
      }
      // Captions are technician free text — same cue+value scrub as finding
      // values (codex #2817: a caption quoting the fee rode the public JSON
      // verbatim; a paraphrased amount would too).
      const caption = scrubText(ph.caption);
      return { id: ph.id, category: ph.category, caption, visit: ph.visit, url };
    }));

    // The report labels this "Follow-up" / "your next visit", so it must be
    // the documented visit's own continuation — never the visit the report
    // documents (the old bug: on the service day the linked appointment is
    // the just-treated visit itself, so the report printed today's service
    // as its own follow-up), and never an unrelated appointment on the
    // customer's calendar (a shareable report token must not disclose the
    // routine schedule). Scoping rules live in the shared helper, which the
    // admin project detail endpoint also uses so the staff preview matches
    // this page.
    const upcomingAppointment = await findReportFollowupAppointment({
      customerId: project.customer_id,
      scheduledServiceId: project.scheduled_service_id,
    });

    // WDO: serve the as-sent findings snapshot archived at send time, so the
    // public link always matches the emailed signed FDACS-13645 PDF even if
    // findings are edited afterward (a re-signed resend refreshes the
    // snapshot). Pre-archive sends have no snapshot and fall back to live.
    let viewerFindings = project.findings;
    let viewerProjectDate = project.project_date || project.created_at;
    // Whether the filled FDACS-13645 PDF can be served (a filing was archived
    // to S3 at send time) — the viewer gates its "View FDACS-13645" link on this
    // so it never opens a 404 for a pre-archive/legacy report.
    let fdacsPdfAvailable = false;
    if (project.project_type === 'wdo_inspection') {
      let filings = project.wdo_sent_filings;
      if (typeof filings === 'string') { try { filings = JSON.parse(filings); } catch { filings = null; } }
      const lastFiling = Array.isArray(filings) && filings.length ? filings[filings.length - 1] : null;
      if (lastFiling?.findings) {
        viewerFindings = lastFiling.findings;
        if (lastFiling.project_date) viewerProjectDate = lastFiling.project_date;
      }
      fdacsPdfAvailable = Boolean(lastFiling?.s3_key && config.s3?.bucket)
        // unmarked legacy binary — may print a raw fee, gated; see
        // filingBinaryMayDiscloseFee
        && !filingBinaryMayDiscloseFee(lastFiling);
    }

    // Internal/office-only finding keys must never ride the public JSON — the
    // client registry hides them visually, but any token holder can read the
    // raw payload, so the strip is enforced at the egress point too (audit
    // 2026-07-16). The narrative fee (an inspection fee an old draft may have
    // baked into prose) is handled by the redactInspectionFeeCues guard on
    // `recommendations` below. The value scrub is type-gated via
    // typeCarriesFee (computed above the photos block).
    viewerFindings = stripInternalFindingKeys(viewerFindings, { redactValues: typeCarriesFee, feeValues, freeTextKeys });

    res.json({
      projectType: project.project_type,
      fdacsPdfAvailable,
      status: project.status,
      // The title is the report's customer-facing headline — free prose with
      // the same cue+value scrub as every other free-text field (codex #2817).
      title: scrubText(project.title),
      customerName: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
      // Customer email/phone for the hero contact lines — the report hero
      // mirrors the customer estimate, which prints the recipient's own
      // contact block under the headline. Owner EXPLICIT ruling 2026-07-16:
      // every report shows name/email/phone/address, WDO included — decided
      // with the trade-off in view (sendWdoReportCopies emails this link to
      // the realtor/title company on the FDACS form, so those third parties
      // can now see the homeowner's contact lines). Supersedes the earlier
      // WDO-only withholding.
      customerEmail: project.customer_email || null,
      customerPhone: project.customer_phone || null,
      // gates the "How did today's visit go?" ask (owner 2026-07-16) — same
      // self-suppression as the service report once a review is recorded
      hasLeftGoogleReview: !!project.has_left_google_review,
      // Canonical review office resolved SERVER-side — the client's own
      // substring matcher was incomplete (no Port Charlotte / 33948) and fell
      // through to Bradenton for addresses the resolver routes to Venice
      // (codex #3285 r5). Client keeps its table only for cached payloads.
      reviewLocation: (() => {
        const { resolveReviewLocation } = require('../config/locations');
        const loc = resolveReviewLocation({
          city: project.city,
          zip: project.zip,
          latitude: project.customer_latitude,
          longitude: project.customer_longitude,
          nearest_location_id: project.nearest_location_id,
        }, { storedLocationId: project.nearest_location_id || null });
        return loc ? { id: loc.id, name: loc.name, reviewUrl: loc.googleReviewUrl } : null;
      })(),
      cityState: `${project.city || ''}${project.state ? ', ' + project.state : ''}`.trim().replace(/^,\s*/, ''),
      // Full service address for the hero — the report page mirrors the
      // customer estimate, which shows the street address under the headline.
      customerAddress: [
        [project.address_line1, project.address_line2].filter(Boolean).join(' ').trim(),
        [project.city, [project.state, project.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ].filter(Boolean).join(', '),
      technicianName: project.technician_name,
      projectDate: viewerProjectDate,
      sentAt: project.sent_at,
      findings: viewerFindings,
      // Serve-time inspection-fee guard: covers legacy narratives and any
      // written by an old instance during the deploy window. Two passes —
      // the literal-cue scrub plus the VALUE scrub with the fee this project
      // recorded, so a paraphrase ("the quoted $250 charge") can't ride the
      // public payload either (codex #2817).
      recommendations: scrubText(project.recommendations),
      followupDate: project.followup_date,
      // Follow-up findings are findings-shaped jsonb rendered key→value on
      // the page — same internal-key strip + fee scrub as the main findings.
      followupFindings: stripInternalFindingKeys(project.followup_findings, { redactValues: typeCarriesFee, feeValues, freeTextKeys }),
      followupCompletedAt: project.followup_completed_at,
      upcomingAppointment: upcomingAppointment ? {
        serviceType: upcomingAppointment.service_type,
        scheduledDate: upcomingAppointment.scheduled_date,
        windowStart: upcomingAppointment.window_start,
        // NO window_end: it is the internal job-duration block — the customer
        // arrival window is always window_start + 2h, computed client-side
        // (owner rule; the client already ignored this field).
        technicianName: upcomingAppointment.technician_name,
        status: upcomingAppointment.status,
      } : null,
      photos: photosWithUrls,
    });
  } catch (err) { next(err); }
});

// GET /api/reports/project/:token/fdacs-pdf — the filled, signed FDACS-13645
// PDF for a WDO report, so the public report page can show the official form
// instead of a blank template. Serves the exact archived filing that was
// emailed (same source the /data viewer reads its as-sent snapshot from), so
// the downloadable form can never diverge from what was filed. The token gates
// access; the S3 object itself is private and streamed through the server.
// POST /api/reports/project/:token/ask — deterministic Waves AI for project
// reports (owner ask 2026-07-16). Paper compliance documents (WDO +
// pre-construction certificate) are exempt and 404 here — their pages never
// mount the bar. The payment hold gates BEFORE any content-derived answer.
router.post('/project/:token/ask', async (req, res, next) => {
  if (!extractProjectReportTokenLookup(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question_required' });
    if (question.length > 500) return res.status(400).json({ error: 'question_too_long' });

    const project = await findProjectByReportSegment(req.params.token);
    if (!project) return res.status(404).json({ error: 'Report not found' });
    if (project.project_type === 'wdo_inspection' || project.project_type === 'pre_treatment_termite_certificate') {
      return res.status(404).json({ error: 'Report not found' });
    }
    const heldContext = await heldReportPaymentContext(project);
    if (heldContext) {
      return res.status(402).json({ error: 'Report pending payment', code: 'report_payment_required' });
    }

    const upcomingAppointment = await findReportFollowupAppointment({
      customerId: project.customer_id,
      scheduledServiceId: project.scheduled_service_id,
    }).catch(() => null);

    const answer = answerProjectReportQuestion({
      question,
      project,
      payload: {
        upcomingAppointment: upcomingAppointment
          ? { serviceType: upcomingAppointment.service_type, scheduledDate: upcomingAppointment.scheduled_date }
          : null,
        followupDate: project.followup_date || null,
        followupCompletedAt: project.followup_completed_at || null,
      },
    });
    try {
      await db('activity_log').insert({
        customer_id: project.customer_id,
        action: 'project_report_question_asked',
        description: `Project report question asked (${project.project_type})`,
        metadata: { project_id: project.id, project_type: project.project_type, question_length: question.length },
      });
    } catch (err) {
      logger.warn(`[reports-public] project ask activity_log insert failed: ${err.message}`);
    }
    return res.json({ answer });
  } catch (err) { next(err); }
});

router.get('/project/:token/fdacs-pdf', async (req, res, next) => {
  // Signed legal filing behind a long-lived token — never cache, index, or
  // leak the URL. Set before ANY return so the 402/404/NoSuchKey early paths
  // carry the same protection as the PDF itself, matching /project/:token/data
  // (codex #2817).
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!extractProjectReportTokenLookup(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const project = await findProjectByReportSegment(req.params.token);
    if (!project || project.project_type !== 'wdo_inspection') {
      return res.status(404).json({ error: 'Report not found' });
    }
    // Payment-held report: no filing has been emailed yet (the natural state
    // is an empty filings index), but belt-and-braces 402 here too so a prior
    // filing can never leak through a held resend edge case.
    if (await heldReportPaymentContext(project)) {
      return res.status(402).json({ error: 'Report pending payment', code: 'report_payment_required' });
    }
    let filings = project.wdo_sent_filings;
    if (typeof filings === 'string') { try { filings = JSON.parse(filings); } catch { filings = null; } }
    const lastFiling = Array.isArray(filings) && filings.length ? filings[filings.length - 1] : null;
    if (!lastFiling?.s3_key || !config.s3?.bucket) {
      return res.status(404).json({ error: 'Report not found' });
    }
    // Same generic 404 as a missing archive: an unmarked LEGACY binary may
    // print a raw fee and is never served; the /data payload also stops
    // advertising it — see filingBinaryMayDiscloseFee.
    if (filingBinaryMayDiscloseFee(lastFiling)) {
      return res.status(404).json({ error: 'Report not found' });
    }
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: config.s3?.region,
      credentials: config.s3?.accessKeyId
        ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
        : undefined,
    });
    let object;
    try {
      object = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: lastFiling.s3_key }));
    } catch (err) {
      // The /data viewer already advertised the PDF as available; if the private
      // object is missing/purged, return the same generic 404 (not a 500) so a
      // stale archive reads as "not found" rather than an internal error.
      if (err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: 'Report not found' });
      }
      throw err;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="FDACS-13645.pdf"');
    object.Body.on('error', (err) => {
      logger.warn(`[reports-public] FDACS filing stream failed for ${project.id}: ${err.message}`);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(err);
    });
    object.Body.pipe(res);
  } catch (err) { next(err); }
});

// POST /api/reports/:token/events — token-scoped report interaction events.
router.post('/:token/events', reportEventLimiter, async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .select('id', 'customer_id', 'report_template_version', 'structured_notes')
      .first();
    if (!service || service.report_template_version !== 'service_report_v1') {
      return res.status(404).json({ error: 'Report not found' });
    }
    // Suppressed reports take no event writes from anyone — this route is
    // skipped by the central param gate so its limiter runs before DB work.
    if (suppressedTypedReport(service)) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const eventName = String(req.body?.eventName || '').trim();
    const channel = String(req.body?.channel || 'public_report').trim();
    if (!ALLOWED_REPORT_EVENTS.has(eventName)) {
      return res.status(400).json({ error: 'Unknown report event' });
    }
    // Cross-sell events exist only while the feature does (codex #3367 r4:
    // a token holder must not mint events/notifications for a dark gate).
    // Same copy as an unknown event — the gate state is not probeable.
    if ((eventName === 'cross_sell_requested' || eventName === 'referral_cta_clicked')
      && !require('../config/feature-gates').isEnabled('reportCrossSell')) {
      return res.status(400).json({ error: 'Unknown report event' });
    }
    if (!ALLOWED_REPORT_EVENT_CHANNELS.has(channel)) {
      return res.status(400).json({ error: 'Unknown report event channel' });
    }
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
      ? req.body.metadata
      : {};
    // Metadata persists per event at 120/min — bound it, or a token holder
    // can stream arbitrary JSON into durable storage under the event cap.
    if (JSON.stringify(metadata).length > 8192) {
      return res.status(400).json({ error: 'Event metadata too large' });
    }

    // Every event except the cross-sell request keeps its fire-and-forget
    // analytics contract. cross_sell_requested is handled below with
    // validate-first + a single transaction, so an event row can never
    // exist without its actionable service_requests row (codex #3367 r7).
    if (eventName !== 'cross_sell_requested') {
      // Write mirrors read (AGENTS.md report-token rule; local codex r11):
      // the referral card only renders when LIVE settings exist and the
      // program is active, so a crafted referral click against a dark or
      // unconfigured program must not pollute referral analytics. Same
      // strict read as the card composer; an unreadable settings row
      // rejects rather than records.
      if (eventName === 'referral_cta_clicked') {
        try {
          const settings = await require('../services/referral-engine').getLiveSettings();
          if (!settings?.program_active) {
            return res.status(409).json({ error: 'Referral program is not active' });
          }
        } catch {
          return res.status(503).json({ error: 'Could not record the event — please try again' });
        }
      }
      await recordServiceReportEvent(service, eventName, channel, req, metadata);
      return res.json({ ok: true });
    }

    // Cross-sell CTA → durable service_requests row + office bell (codex
    // #3367 r6: the bell's Customer-360 deep link points at the requests
    // panel, so the actionable row must exist there — an analytics event
    // alone is not a workflow). Same shape/vocabulary as the estimate
    // add-service flow, WITHOUT its customer confirmations (owner sends all
    // customer comms; the card's own confirmation copy is the only customer
    // feedback). Abuse posture: the offer is RECOMPUTED server-side (client
    // metadata never reaches the row or bell; no offer → no row), and the
    // customer-row lock + open-row check make the request idempotent — a
    // repeat tap resolves to the existing open request. Creation failure is
    // a 503 so the card can only confirm a durably recorded request.
    if (eventName === 'cross_sell_requested') {
      // Dedicated limiter runs BEFORE any recompute/DB work; it sends its
      // own 429 when tripped.
      await new Promise((resolve, reject) => crossSellActionLimiter(req, res, (err) => (err ? reject(err) : resolve())));
      if (res.headersSent) return undefined;
      try {
        const joined = await db('service_records as sr')
          .leftJoin('customers as c', 'sr.customer_id', 'c.id')
          .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
          .where('sr.id', service.id)
          .select(
            // scheduled_service_id rides along so the click-path recompute
            // classifies the report by its catalog identity exactly like
            // the read path (codex #3367 PR r4) — omitting it made every
            // valid click 409 whenever the catalog reclassified stale text.
            'sr.id', 'sr.customer_id', 'sr.service_type', 'sr.scheduled_service_id', 'sr.is_callback',
            // service_date/created_at feed the historical-report recency
            // gate (PR r9) — the click path must classify identically.
            'sr.service_date', 'sr.created_at',
            db.raw('COALESCE(ss.service_address_line1, c.address_line1) as address_line1'),
            db.raw(`${stampedLine2Sql('ss', 'c')} as address_line2`),
            db.raw('COALESCE(ss.service_address_city, c.city) as city'),
            db.raw('COALESCE(ss.service_address_zip, c.zip) as zip'),
            'c.first_name', 'c.last_name',
          )
          .first();
        const { buildReportCrossSell } = require('../services/service-report/cross-sell');
        const crossSell = joined?.customer_id ? await buildReportCrossSell(joined, db) : null;
        // The recomputed offer must MATCH what the customer clicked (codex
        // #3367 r6 P1): a vanished offer, a different target family, or a
        // shown per-application price that no longer holds (>1% drift) all
        // reject — the card fails visibly instead of confirming a request
        // for something the customer never saw. Client metadata is only
        // COMPARED against server truth here, never persisted as the offer.
        const clickedKey = String(metadata.serviceKey || '').trim();
        const clickedMode = String(metadata.offerMode || '').trim();
        // STRICT type check before any numeric handling (AGENTS.md
        // report-token rule; local codex r11): Number() coerces '', null,
        // false, and [] to 0, which slipped malformed bodies through the
        // quote-mode branch. A priced click must carry an actual finite
        // positive number; a quote click must carry null/absent — the
        // exact shapes the card emits.
        const rawPer = metadata.perApplication;
        const clickedPer = typeof rawPer === 'number' && Number.isFinite(rawPer) ? rawPer : null;
        const serverPer = Number(crossSell?.option?.perVisit);
        // Key AND mode must match, and a priced offer must match to the
        // cent (codex #3367 r8: a quote-only card that became priced before
        // the click must not record "shown $X" the customer never saw; a
        // priced card whose price moved must re-render first).
        const offerMismatch = !crossSell
          || !clickedKey || clickedKey !== crossSell.serviceKey
          || !clickedMode || clickedMode !== crossSell.mode
          || (crossSell.mode === 'priced'
            ? !(clickedPer !== null && clickedPer > 0
              && Number.isFinite(serverPer) && Math.abs(clickedPer - serverPer) < 0.005
              // The clicked OPTION must be the recomputed option too
              // (pre-push codex r11 P1): a preferred-variant change that
              // happens to keep the same per-application price must not
              // snapshot a different cadence/tier than the customer saw.
              && String(metadata.optionId || '') === String(crossSell.option?.id || ''))
            : !(rawPer === null || rawPer === undefined));
        if (offerMismatch) {
          return res.status(409).json({ error: 'This offer is no longer available — please refresh the report' });
        }
        {
          const { normalizeRequestedServiceKey, OPEN_REQUEST_TERMINAL_STATUSES } = require('../services/estimate-add-service-request');
          const requestedService = normalizeRequestedServiceKey(crossSell.serviceKey) || crossSell.serviceKey;
          const perApplication = Number(crossSell.option?.perVisit);
          const priceText = Number.isFinite(perApplication) && perApplication > 0
            ? `(shown $${perApplication.toFixed(2)} per application on report)`
            : '(quote requested from report)';
          // One server-computed subject for insert AND dedupe refresh
          // (codex #3367 PR r3): if ownership changed since the original
          // request (start → add) while the ladder target held, the reused
          // row's subject must match the newly validated snapshot too.
          const requestSubject = `${crossSell.relationship === 'start' ? 'Start' : 'Add'} ${crossSell.label} — requested from service report`;
          const outcome = await db.transaction(async (trx) => {
            // Serialize per customer: the row lock makes check-then-insert
            // idempotent (the estimate flow's partial-unique index only
            // covers estimate-linked rows; this path has estimate_id NULL).
            await trx('customers').where({ id: joined.customer_id }).forUpdate().first('id');
            // The event row commits WITH the request row (or with the
            // dedupe resolution to the existing open row) — one
            // transaction, so analytics can never claim a request that has
            // no actionable record.
            const recordEvent = async () => {
              const recorded = await recordServiceReportEvent(service, eventName, channel, req, metadata, trx);
              if (!recorded) throw new Error('event insert failed');
            };
            const existing = await trx('service_requests')
              .where({ customer_id: joined.customer_id, requested_service: requestedService, source: 'service_report' })
              .whereNotIn('status', OPEN_REQUEST_TERMINAL_STATUSES)
              .first();
            if (existing) {
              // An IDENTICAL resubmission (same validated snapshot and
              // subject) is a pure no-op (local codex r15 P1): no row
              // churn, no extra event row — the card simply re-confirms.
              const nextRevision = JSON.stringify({ source: 'service_report', serviceRecordId: service.id, crossSell });
              const priorRevision = typeof existing.pricing_revision === 'string'
                ? existing.pricing_revision
                : JSON.stringify(existing.pricing_revision ?? null);
              if (priorRevision === nextRevision && existing.subject === requestSubject) {
                return { deduped: true };
              }
              // Refresh the stored snapshot to THIS click's validated offer
              // (codex #3367 PR r1): the shown-price lock must reflect what
              // the customer just saw — an older revision (or a quote-mode
              // row that has since become priced) must not stand as the
              // recorded quote while the card confirms the new one.
              await trx('service_requests').where({ id: existing.id }).update({
                subject: requestSubject,
                description: `Customer tapped "${crossSell.label}" on their service report ${priceText}. Review and follow up — no customer message has been sent.`,
                pricing_revision: JSON.stringify({ source: 'service_report', serviceRecordId: service.id, crossSell }),
              });
              await recordEvent();
              return { deduped: true };
            }
            const [request] = await trx('service_requests').insert({
              customer_id: joined.customer_id,
              requested_service: requestedService,
              source: 'service_report',
              category: 'add_service',
              subject: requestSubject,
              description: `Customer tapped "${crossSell.label}" on their service report ${priceText}. Review and follow up — no customer message has been sent.`,
              urgency: 'routine',
              status: 'new',
              // The server-computed offer snapshot — the shown price is the
              // honored price (sent-quote price-lock doctrine).
              pricing_revision: JSON.stringify({ source: 'service_report', serviceRecordId: service.id, crossSell }),
            }).returning('*');
            await recordEvent();
            return { request };
          });
          if (!outcome.deduped) {
            // Bell AFTER the durable row exists; a bell failure leaves the
            // row actionable in the Customer 360 requests panel either way.
            const { triggerNotification } = require('../services/notification-triggers');
            await triggerNotification('bundle_quote_requested', {
              bundled: false,
              customerId: joined.customer_id,
              customerName: `${joined.first_name || ''} ${joined.last_name || ''}`.trim() || null,
              suggestedService: [crossSell.label, priceText].join(' '),
              // Start-vs-add rides to the bell too (codex #3367 PR r3): the
              // builder's add-to-plan copy contradicts a start-plan request.
              relationship: crossSell.relationship,
            }).catch((err) => {
              logger.warn(`[reports-public] cross-sell bell failed (request ${outcome.request?.id} stands): ${err.message}`);
            });
          }
        }
      } catch (err) {
        logger.warn(`[reports-public] cross-sell request creation failed: ${err.message}`);
        return res.status(503).json({ error: 'Could not record the request — please try again' });
      }
    }

    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// Cockroach-family typed reports retired the V2 perimeter story — an
// approved recap video telling it must not serve from ANY public endpoint,
// including permanent-token URLs hit by old clients (codex P2 #3007 r12).
function cockroachRecapRetired(service) {
  try {
    const data = typeof service.service_data === 'string'
      ? JSON.parse(service.service_data)
      : service.service_data;
    const { isCockroachTypedReportType } = require('../services/service-report/pest-report-v2');
    return isCockroachTypedReportType(data?.typedReportSnapshot?.type);
  } catch { return false; }
}

// GET /api/reports/:token/recap — customer-facing recap status. Only exposes a
// recap the tech has APPROVED (ready-but-unapproved stays private).
router.get('/:token/recap', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) return res.status(404).json({ error: 'Not found' });
  try {
    const service = await db('service_records').where({ report_view_token: req.params.token }).select('id', 'scheduled_service_id', 'service_data').first();
    if (!service || !service.scheduled_service_id) return res.status(404).json({ error: 'Not found' });
    if (cockroachRecapRetired(service)) return res.json({ ready: false, durationMs: null });
    const { getRecap } = require('../services/service-report/recap-pipeline');
    const recap = await getRecap(service.scheduled_service_id);
    const ready = Boolean(recap && recap.status === 'approved' && recap.s3_key);
    return res.json({ ready, durationMs: ready ? recap.duration_ms : null });
  } catch (err) { return next(err); }
});

// GET /api/reports/:token/recap/video — streams the approved recap MP4 (token-gated).
router.get('/:token/recap/video', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) return res.status(404).end();
  try {
    const service = await db('service_records').where({ report_view_token: req.params.token }).select('id', 'scheduled_service_id', 'service_data').first();
    if (!service || !service.scheduled_service_id) return res.status(404).end();
    if (cockroachRecapRetired(service)) return res.status(404).end();
    const { getRecap } = require('../services/service-report/recap-pipeline');
    const recap = await getRecap(service.scheduled_service_id);
    if (!recap || recap.status !== 'approved' || !recap.s3_key) return res.status(404).end();
    const { getRecapStream } = require('../services/service-report/recap-storage');
    const range = req.headers.range || null;
    const obj = await getRecapStream(recap.s3_key, range);
    if (!obj) return res.status(404).end();
    if (obj.rangeNotSatisfiable) return res.status(416).set('Accept-Ranges', 'bytes').end();
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', obj.contentType || 'video/mp4');
    // no-store (not no-cache): a tokenized recap can show the customer's home — don't
    // let shared-device browsers persist it, matching the other tokenized report assets.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // 206 with Content-Range when the browser asked for a byte range (iOS/Safari MP4
    // seeking); otherwise a full 200. obj.size is the partial length for a range hit.
    if (range && obj.contentRange) {
      res.status(206).setHeader('Content-Range', obj.contentRange);
    }
    if (obj.size) res.setHeader('Content-Length', obj.size);
    obj.body.on('error', (streamErr) => {
      logger.warn(`[recap] public video stream error: ${streamErr.message}`);
      if (!res.headersSent) res.status(502).end(); else res.destroy(streamErr);
    });
    return obj.body.pipe(res);
  } catch (err) { return next(err); }
});

// POST /api/reports/:token/pest-pressure/client-rating — customer-facing,
// token-scoped capture of the "how much pest activity have you noticed?"
// rating. Updates service_records.client_pest_rating (source='customer'),
// re-runs the pest-pressure orchestrator to incorporate the new signal,
// and returns the updated pestPressure object so the page can re-render
// without a full reload.
//
// One rating per report (409 on re-submit). Feature flag is config.enabled;
// 404 covers disabled / non-v1 / unknown-token uniformly so the existence
// of any specific report token isn't leaked.
router.post('/:token/pest-pressure/client-rating', reportEventLimiter, async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    // Strict validation — one-shot write, no rounding. `Number.isInteger`
    // covers all the typeof + finite checks AND rejects fractional inputs
    // like 0.4 or 2.7 (those previously rounded silently, burning the
    // customer's one rating on an unintended value). AGENTS.md requires
    // strict pre-`Number()` validation for `/api/reports/:token/*` writes.
    const rawRating = req.body && req.body.rating;
    if (!Number.isInteger(rawRating) || rawRating < 0 || rawRating > 5) {
      return res.status(400).json({ error: 'rating_out_of_range' });
    }
    const rounded = rawRating;

    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .first('id', 'customer_id', 'service_type', 'service_line', 'service_date', 'status', 'report_template_version', 'client_pest_rating', 'structured_notes', 'scheduled_service_id', 'is_callback');
    if (!service || service.report_template_version !== 'service_report_v1') {
      return res.status(404).json({ error: 'Report not found' });
    }
    // Suppressed reports take no rating writes from anyone — this route is
    // skipped by the central param gate so its limiter runs before DB work.
    if (suppressedTypedReport(service)) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const config = await loadActiveConfig(db);
    if (!config.enabled) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Eligibility must mirror the customer view exactly — feature flag
    // isn't enough. showOnCustomerReport, enabledServiceLines, and
    // requireRecurringFrequency all gate visibility; a rating must not
    // be storable for a report where the card doesn't render. Reusing
    // buildPestPressureCustomerView keeps the gate logic in one place.
    // Profile-resolved one-time exclusion (codex r6): the label heuristic
    // inside the view misses one-time services whose names carry no cadence
    // word — without this, an untyped Fire Ant / Tick Control report shows
    // the rating picker and the submitted rating recreates the pressure
    // history the completion write already refuses.
    const oneTimeExcluded = await isOneTimePressureExcludedRecord(service, db);
    const eligibilityView = buildPestPressureCustomerView({
      config,
      scoreRow: null,
      serviceRecord: service,
      oneTimeExcluded,
    });
    if (!eligibilityView || !eligibilityView.canCaptureClientRating) {
      // canCaptureClientRating === false also covers the "already rated"
      // case, but we surface the more specific 409 first so the customer
      // UI can show "already submitted".
      if (service.client_pest_rating !== null && service.client_pest_rating !== undefined) {
        return res.status(409).json({ error: 'rating_already_submitted' });
      }
      return res.status(403).json({ error: 'rating_not_allowed' });
    }

    // Wrap the atomic UPDATE + score recalc in a transaction. If recalc
    // throws (config load, component query, persist), the rating UPDATE
    // rolls back too — the customer's one allowed rating isn't burned on
    // a transient failure, future POSTs are still permitted, and the
    // score row stays in a consistent state. Trade-off: an orchestrator
    // hiccup returns 500 to the customer (who can retry) instead of
    // silently leaving the rating set but the score stale.
    //
    // The atomic `whereNull('client_pest_rating').update(...)` also
    // serves as the one-shot guard: if two concurrent POSTs both passed
    // the eligibility check above, only one's UPDATE matches the predicate
    // and the other transaction's rowsAffected===0 throws ALREADY_SUBMITTED.
    try {
      await db.transaction(async (trx) => {
        const rowsAffected = await trx('service_records')
          .where({ id: service.id })
          .whereNull('client_pest_rating')
          .update({
            client_pest_rating: rounded,
            client_pest_rating_source: 'customer',
            client_pest_rating_at: trx.fn.now(),
          });
        if (rowsAffected === 0) {
          const dupErr = new Error('rating_already_submitted');
          dupErr.code = 'ALREADY_SUBMITTED';
          throw dupErr;
        }
        // Non-swallowing recalc inside the transaction. If this throws
        // the rating UPDATE rolls back via the surrounding transaction.
        await calculateAndPersistForServiceRecord(service.id, trx);
      });
    } catch (txErr) {
      if (txErr && txErr.code === 'ALREADY_SUBMITTED') {
        return res.status(409).json({ error: 'rating_already_submitted' });
      }
      throw txErr;
    }

    // Build the response view from the original service row plus the new
    // rating — re-querying with .first('id', 'customer_id', 'service_type',
    // 'client_pest_rating') would drop service_line, and
    // buildPestPressureCustomerView's isServiceLineEnabled relies on
    // service_line before falling back to detectServiceLine(service_type).
    // For generic service labels that fallback can fail and the view
    // returns null — the client would re-show the picker even though the
    // rating was consumed.
    const updatedScore = await loadScoreForServiceRecord(db, service.id);
    const updatedService = {
      id: service.id,
      customer_id: service.customer_id,
      service_type: service.service_type,
      service_line: service.service_line,
      service_date: service.service_date,
      client_pest_rating: rounded,
    };

    // Pull history with the same token-scoped service_date ceiling
    // buildReportV1Data uses, so the rating-submit response preserves
    // the chart + cadence the customer was just looking at instead of
    // dropping them. Resolve service_line the same way buildReportV1Data
    // does — for legacy rows where the column is null, falling back to
    // detectServiceLine(service_type) keeps history scoped to one line
    // instead of pulling mixed lawn+pest visits.
    const resolvedServiceLine = service.service_line || detectServiceLine(service.service_type);
    const historyRows = service.customer_id
      ? await loadHistoryForCustomer(db, service.customer_id, {
          serviceLine: resolvedServiceLine || null,
          limit: 8,
          beforeOrOnServiceDate: service.service_date || null,
          // Same-day trim, same as buildReportV1Data: without it this
          // response replaces the page's trimmed history client-side and
          // leaks a later same-day sibling the moment a rating is submitted
          // (codex P2 #2824 r2).
          currentServiceRecordId: service.id || null,
        }).catch(() => [])
      : [];

    const pestPressure = buildPestPressureCustomerView({
      config,
      scoreRow: updatedScore,
      serviceRecord: updatedService,
      historyRows,
      oneTimeExcluded,
    });

    return res.json({ pestPressure, submittedRating: rounded });
  } catch (err) { next(err); }
});

// POST /api/reports/:token/ask — customer-facing, token-scoped report Q&A.
router.post('/:token/ask', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question_required' });
    if (question.length > 500) return res.status(400).json({ error: 'question_too_long' });

    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('scheduled_services as ss', 'service_records.scheduled_service_id', 'ss.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        // Report address = the visit's stamped service address when present
        // (a phone-booked rental completes at the rental, not the primary
        // home); the customer mirror is the fallback (codex round-9 P2).
        db.raw('COALESCE(ss.service_address_line1, customers.address_line1) as address_line1'),
        db.raw(`${stampedLine2Sql('ss', 'customers')} as address_line2`),
        db.raw('COALESCE(ss.service_address_city, customers.city) as city'),
        db.raw('COALESCE(ss.service_address_state, customers.state) as state'),
        db.raw('COALESCE(ss.service_address_zip, customers.zip) as zip'),
        // Stored office = the review resolver's last resort (tracking-number
        // leads with an area-label city, no mapped ZIP, no coords) — without
        // it the report CTA falls through to the default office (codex r6).
        'customers.nearest_location_id',
        'customers.has_left_google_review',
        // Map center follows the treated parcel: stamped visit coords first,
        // the primary home only for non-divergent stamps (codex round-9 P2).
        db.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.latitude END) as customer_latitude`),
        db.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.longitude END) as customer_longitude`),
        'technicians.name as technician_name',
        'technicians.photo_url as technician_photo_url',
        'technicians.avatar_url as technician_avatar_url',
        'technicians.photo_s3_key as technician_photo_s3_key')
      .first();

    if (!service || service.report_template_version !== 'service_report_v1') {
      return res.status(404).json({ error: 'Report not found' });
    }

    const data = await buildServiceReportV1ResponseData(service, req.params.token, { mode: 'live' });
    // The Q&A answer and the report hero must never disagree about the next
    // visit — reuse the builder's service-line-matched nextAppointment (the
    // old standalone query here was any-line and included stale rows).
    const nextAppointment = data.nextAppointment
      ? {
        service_type: data.nextAppointment.serviceType,
        scheduled_date: data.nextAppointment.scheduledDate,
        window_start: data.nextAppointment.windowStart,
      }
      : null;

    const productContext = await loadReportAssistantProductContext(data).catch(() => ({ byApplicationId: {}, byProductName: {} }));
    const answer = answerServiceReportQuestion({
      question,
      data,
      nextAppointment,
      productContext,
    });
    await recordServiceReportEvent(service, 'report_question_asked', 'public_report', req, {
      question_length: question.length,
    });
    return res.json({ answer });
  } catch (err) { next(err); }
});

// GET /api/reports/:token/preview.jpg — token-gated MMS preview image.
router.get('/:token/preview.jpg', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .select('id', 'report_template_version')
      .first();
    if (!service || service.report_template_version !== 'service_report_v1') {
      return res.status(404).json({ error: 'Report not found' });
    }

    const asset = await db('service_report_notification_assets')
      .where({
        service_record_id: service.id,
        asset_type: 'sms_preview_image',
      })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);
    if (!asset) return res.status(404).json({ error: 'preview_not_found' });

    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const config = require('../config');
    if (!config.s3?.bucket) return res.status(404).json({ error: 'preview_not_found' });
    const s3 = new S3Client({
      region: config.s3?.region,
      credentials: config.s3?.accessKeyId
        ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
        : undefined,
    });
    const object = await s3.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: asset.storage_key,
    }));

    res.setHeader('Content-Type', asset.content_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    if (asset.byte_size) res.setHeader('Content-Length', String(asset.byte_size));
    return object.Body.pipe(res);
  } catch (err) { next(err); }
});

// Attachment filename the customer sees on download/share/email, e.g.
// "Waves-Service-Report-123-Main-St-2026-08-02.pdf". service_date is a
// hydrated pg DATE — naive template interpolation printed the entire
// Date.toString() ("Sun Aug 02 2026 00:00:00 GMT+0000 (Coordinated
// Universal Time)") into the filename (and, via the share sheet, into the
// customer's email subject).
function reportPdfFileName(service, { prefix = 'Waves-Service-Report' } = {}) {
  const datePart = dateOnlyStamp(service.service_date);
  const addressPart = String(service.address_line1 || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${[prefix, addressPart, datePart].filter(Boolean).join('-')}.pdf`;
}

// GET /api/reports/:token — public PDF access (no auth)
router.get('/:token', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    // PDF includes a customer address header, so this query keeps address
    // fields. The token-gated /data view shows the address too (see the
    // /:token/data handler) — it's the customer's own service document.
    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('scheduled_services as ss', 'service_records.scheduled_service_id', 'ss.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        // Stamped-address precedence — see the /:token/data handler note
        // (codex round-9 P2).
        db.raw('COALESCE(ss.service_address_line1, customers.address_line1) as address_line1'),
        db.raw(`${stampedLine2Sql('ss', 'customers')} as address_line2`),
        db.raw('COALESCE(ss.service_address_city, customers.city) as city'),
        db.raw('COALESCE(ss.service_address_state, customers.state) as state'),
        db.raw('COALESCE(ss.service_address_zip, customers.zip) as zip'),
        // Stored office = the review resolver's last resort (tracking-number
        // leads with an area-label city, no mapped ZIP, no coords) — without
        // it the report CTA falls through to the default office (codex r6).
        'customers.nearest_location_id',
        'customers.has_left_google_review',
        // Map center follows the treated parcel: stamped visit coords first,
        // the primary home only for non-divergent stamps (codex round-9 P2).
        db.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.latitude END) as customer_latitude`),
        db.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.longitude END) as customer_longitude`),
        'technicians.name as technician_name',
        'technicians.photo_url as technician_photo_url',
        'technicians.avatar_url as technician_avatar_url',
        'technicians.photo_s3_key as technician_photo_s3_key')
      .first();

    if (!service) return res.status(404).json({ error: 'Report not found' });

    // Suppressed-report access is enforced by the router.param('token')
    // gate; reaching here with a suppressed record means a staff viewer —
    // their shadow reviews aren't customer views.
    if (!suppressedTypedReport(service)) await trackServiceReportView(service);

    if (service.report_template_version === 'service_report_v1') {
      // Embed a hash of Pest Pressure visibility-affecting config in the
      // PDF storage key. When admin flips enabled / showOnCustomerReport /
      // enabledServiceLines / requireRecurringFrequency, the signature
      // changes, the expected key no longer matches the stored key, and
      // the cached PDF is treated as a miss — forcing a re-render with
      // the new visibility decision applied.
      let pestPressureConfig = await loadActiveConfig(db).catch(() => null);
      let visibilitySignature = pestPressureVisibilitySignature(pestPressureConfig);
      // Summary-copy key component: when the technician-report copy drives
      // the rendered summary, the suffix changes the expected key so a PDF
      // cached before this feature (generic summary) re-renders instead of
      // being served stale. Recap-driven records keep their old keys — no
      // mass cache bust. Derived from the immutable record, so no re-check
      // is needed in the render race loop below.
      const summarySignature = summaryCopySignature(service);
      // Mosquito V2 gate flips must invalidate cached mosquito-report PDFs
      // (key change → cache miss → re-render with the dashboard).
      const mosquitoV2Signature = mosquitoReportV2PdfSignature(service);
      // PEST_REPORT_V2 predates this key component — pest PDFs cached before
      // the pest V2 flip re-render once on next view.
      const pestV2Signature = pestReportV2PdfSignature(service);
      // Treatment-zone key component: gate flips and re-traces change the
      // key so cached PDFs re-render with/without the traced map.
      const tzSignature = await treatmentZonePdfSignature(service, db);
      const smSignature = await stationMapPdfSignature(service, db);
      // Narrative key component (audit P2 2026-07-22) — see pdf-queue.js.
      const tnSignature = await treatmentNarrativePdfSignature(service.id, db);
      // Assessment identity + copy version, computed ONCE before the render and
      // reused for both the expected-key check and the store, so the key always
      // describes the same assessment on both sides (#3168).
      // CACHE-LOOKUP side uses the non-throwing entry point: deciding whether a
      // stored object is current must never 500 a report view, and a
      // non-matching value here only costs a re-render. The RENDER side takes
      // the throwing canonical snapshot inside the try below, where a failure
      // reaches the existing 503 + enqueue recovery path (#3172 r2) instead of
      // bypassing it into a generic 500.
      const laSignature = await lawnAssessmentPdfSignature(service, db);
      const expectedPdfStorageKey = reportPdfStorageKey(service.id, {
        visibilitySignature: visibilitySignature + summarySignature + mosquitoV2Signature + pestV2Signature + tzSignature + smSignature + tnSignature + timeOnSiteAdjustedPdfSignature(service) + reentryAdjustedPdfSignature(service) + laSignature + photoMarksPdfSignature() + publicOriginPdfSignature(),
      });
      const storedPdf = service.pdf_storage_key === expectedPdfStorageKey
        ? await getHealthyStoredReportPdf(service.pdf_storage_key)
        : null;
      if (storedPdf) {
        await recordServiceReportEvent(service, 'pdf_downloaded', 'public_report', req, { source: 'direct_pdf_route' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${reportPdfFileName(service)}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(storedPdf);
      }

      let pdf;
      // Same contract as pdf-queue (codex P2 r15): the stored key uses the
      // signature attached to the payload — the narrative state the PDF was
      // rendered FROM — never a DB re-read.
      let tnRenderedSignature = '-tn0';
      // The canonical snapshot the render is pinned to. Declared out here so
      // the storage block below keys the object by what was RENDERED, not by
      // the cache-lookup value; assigned inside the try so an unreadable
      // lookup fails closed through the retry path.
      let laRenderSignature = null;
      // The page's own image-load failure count (null = unknown provider).
      let renderImageFailures = null;
      // The payload the render was produced from — its flags decide whether
      // this output may be cached.
      let renderedData = null;
      try {
        // ONE canonical lookup feeds BOTH the pin and the storage-key component
        // (#3172 r1) — two lookups can straddle a selection change and cache a
        // B-pinned PDF under A's key, which is the race this closes.
        const canonical = await resolveCanonicalLawnRender(service, db);
        const canonicalPin = canonical.pin;
        laRenderSignature = canonical.signature;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const renderSignature = visibilitySignature;
          const data = await buildServiceReportV1ResponseData(service, req.params.token, {
            mode: 'pdf', pestPressureConfig, pinnedLawnAssessmentId: canonicalPin,
          });
          tnRenderedSignature = data?.treatmentNarrativeRenderedSignature || '-tn0';
          renderedData = data;
          const rendered = await renderServiceReportV1Pdf(data, {
            token: req.params.token,
            req,
            logger,
            serviceRecordId: service.id,
            // Pinned to the CANONICAL answer (#3172). Unpinned, the browser
            // resolves its own assessment, so a selection moving away and back
            // during the render defeats the pre/post check below — the same
            // A-to-B-to-A limitation that created #3168. Pinning removes the
            // page's freedom to choose; the key already carries assessment
            // identity, so this render stays cacheable.
            pinnedLawnAssessmentId: canonicalPin,
          });
          pdf = rendered.pdf;
          renderImageFailures = rendered.imageFailures ?? null;

          const latestPestPressureConfig = await loadActiveConfig(db).catch(() => null);
          const latestVisibilitySignature = pestPressureVisibilitySignature(latestPestPressureConfig);
          if (latestVisibilitySignature === renderSignature) break;

          if (attempt === 1) {
            const err = new Error('Pest Pressure config changed during PDF render');
            err.code = 'pest_pressure_config_changed_during_pdf_render';
            throw err;
          }
          pestPressureConfig = latestPestPressureConfig;
          visibilitySignature = latestVisibilitySignature;
        }
      } catch (renderErr) {
        const errorMessage = safePdfRenderError(renderErr);
        logger.warn(`[reports-public] PDF render not ready for ${service.id}: ${errorMessage}`);
        await enqueuePdfRenderRetry({
          serviceRecordId: service.id,
          payload: { source: 'public_pdf_route' },
        }).catch((queueErr) => {
          logger.warn(`[reports-public] PDF retry queue failed for ${service.id}: ${queueErr.message}`);
        });
        res.setHeader('Retry-After', '300');
        return res.status(503).json({
          error: 'PDF is being generated. Please try again shortly.',
          code: 'pdf_not_ready',
        });
      }
      try {
        // Re-read the assessment component AFTER the render and require it to
        // match the pre-render value. The browser fetches its own data, so a
        // selection that moved mid-render would otherwise store the PDF of
        // assessment A under B's key, where it reads as current forever. Same
        // shape as the Pest Pressure config re-check above: if it moved, skip
        // the store and let the next view render cleanly.
        // Compare against what the render was PINNED to, not the cache-lookup
        // value — the object must be keyed by the assessment it contains.
        const laAfter = await lawnAssessmentPdfSignature(service, db);
        // Same rule as pdf-queue: a render whose week could not be FROZEN is
        // not reproducible, so serve it but cache nothing — otherwise a later
        // view freezes different data while this object keeps these numbers.
        // A photo the browser could not load rendered as its placeholder,
        // invisible in the returned bytes. Two signals gate the cache
        // (codex P2 #3176 r18+r20): the page's OWN load-outcome count
        // (authoritative — the browser fetches its own /data), and the
        // server-side URL probe as the floor when the count is unavailable
        // (Cloudflare renderer, mid-deploy bundle). Serve, cache nothing.
        const unreachablePhotos = renderImageFailures
          ?? ((renderedData?.imageResolutionFailures || 0) + await countUnreachableReportPhotos(renderedData));
        if (renderedData?.stationMapTransientlyUnavailable) {
          // Same rule as pdf-queue: the key can't see a transient basemap
          // miss, so caching here would strand a map-less report (r23).
          logger.warn(`[reports-public] station map basemap transiently unavailable for ${service.id} — not caching this render`);
        } else if (renderedData?.lawnAssessment?.weekWeatherUncacheable) {
          logger.warn(`[reports-public] week weather unfrozen for ${service.id} — not caching this render`);
        } else if (laAfter !== laRenderSignature) {
          logger.warn(`[reports-public] lawn assessment changed during PDF render for ${service.id} — not caching this render`);
        } else if (unreachablePhotos > 0) {
          logger.warn(`[reports-public] ${unreachablePhotos} report photo(s) unreachable for ${service.id} — serving without storing`);
        } else {
          const key = await putReportPdf(service.id, pdf, {
            visibilitySignature: visibilitySignature + summarySignature + mosquitoV2Signature + pestV2Signature + tzSignature + smSignature + tnRenderedSignature + timeOnSiteAdjustedPdfSignature(service) + reentryAdjustedPdfSignature(service) + laRenderSignature + photoMarksPdfSignature() + publicOriginPdfSignature(),
          });
          await db('service_records').where({ id: service.id }).update({ pdf_storage_key: key });
        }
      } catch (storageErr) {
        logger.warn(`[reports-public] PDF storage skipped for ${service.id}: ${storageErr.message}`);
      }
      await recordServiceReportEvent(service, 'pdf_downloaded', 'public_report', req, { source: 'direct_pdf_route' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${reportPdfFileName(service)}"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(pdf);
    }

    // Legacy pre-generated PDF files (report_pdf_path) are deliberately NOT
    // served anymore: they were written with raw technician_notes (gate
    // codes, billing notes) before the 2026-07-16 owner ruling and a stored
    // file can't be sanitized in place — regenerate on the fly instead, which
    // routes notes through technicianReportCustomerCopy (codex P1 #2797).

    // Generate PDF on-the-fly
    const products = await db('service_products').where({ service_record_id: service.id });
    const weather = service.weather_data ? (typeof service.weather_data === 'string' ? JSON.parse(service.weather_data) : service.weather_data) : null;
    const dryTimes = service.dry_time_data ? (typeof service.dry_time_data === 'string' ? JSON.parse(service.dry_time_data) : service.dry_time_data) : null;
    const irrigation = service.irrigation_recommendation ? (typeof service.irrigation_recommendation === 'string' ? JSON.parse(service.irrigation_recommendation) : service.irrigation_recommendation) : null;

    await recordServiceReportEvent(service, 'pdf_downloaded', 'public_report', req, { source: 'direct_pdf_route' });
    generateReportPDF(service, products, weather, dryTimes, irrigation, res);
  } catch (err) { next(err); }
});

// GET /api/reports/:token/map.svg — standalone v1 treatment map SVG
router.get('/:token/map.svg', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('scheduled_services as ss', 'service_records.scheduled_service_id', 'ss.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        // Report address = the visit's stamped service address when present
        // (a phone-booked rental completes at the rental, not the primary
        // home); the customer mirror is the fallback (codex round-9 P2).
        db.raw('COALESCE(ss.service_address_line1, customers.address_line1) as address_line1'),
        db.raw(`${stampedLine2Sql('ss', 'customers')} as address_line2`),
        db.raw('COALESCE(ss.service_address_city, customers.city) as city'),
        db.raw('COALESCE(ss.service_address_state, customers.state) as state'),
        db.raw('COALESCE(ss.service_address_zip, customers.zip) as zip'),
        // Stored office = the review resolver's last resort (tracking-number
        // leads with an area-label city, no mapped ZIP, no coords) — without
        // it the report CTA falls through to the default office (codex r6).
        'customers.nearest_location_id',
        'customers.has_left_google_review',
        // Map center follows the treated parcel: stamped visit coords first,
        // the primary home only for non-divergent stamps (codex round-9 P2).
        db.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.latitude END) as customer_latitude`),
        db.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.longitude END) as customer_longitude`),
        'technicians.name as technician_name',
        'technicians.photo_url as technician_photo_url',
        'technicians.avatar_url as technician_avatar_url',
        'technicians.photo_s3_key as technician_photo_s3_key')
      .first();

    if (!service || service.report_template_version !== 'service_report_v1') {
      return res.status(404).json({ error: 'Report not found' });
    }

    const data = await buildReportV1Data(service, req.params.token);
    res.type('image/svg+xml');
    return res.send(data.mapSvg || '');
  } catch (err) { next(err); }
});

// GET /api/reports/:token/data — JSON report data (for the branded viewer page)
router.get('/:token/data', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  res.setHeader('Cache-Control', 'no-store');
  // Hoisted so the catch can identify the visit WITHOUT logging the report
  // token — that token is a bearer credential for a customer-facing report
  // carrying their address (#3168).
  let serviceRecordId = null;
  try {
    const mode = ['pdf', 'static', 'sms_preview'].includes(req.query.mode)
      ? req.query.mode
      : 'live';
    // This is the customer-facing document view. The token gates the report,
    // and the document should mirror other customer documents by showing the
    // service address.
    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('scheduled_services as ss', 'service_records.scheduled_service_id', 'ss.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        // Report address = the visit's stamped service address when present
        // (a phone-booked rental completes at the rental, not the primary
        // home); the customer mirror is the fallback (codex round-9 P2).
        db.raw('COALESCE(ss.service_address_line1, customers.address_line1) as address_line1'),
        db.raw(`${stampedLine2Sql('ss', 'customers')} as address_line2`),
        db.raw('COALESCE(ss.service_address_city, customers.city) as city'),
        db.raw('COALESCE(ss.service_address_state, customers.state) as state'),
        db.raw('COALESCE(ss.service_address_zip, customers.zip) as zip'),
        // Stored office = the review resolver's last resort (tracking-number
        // leads with an area-label city, no mapped ZIP, no coords) — without
        // it the report CTA falls through to the default office (codex r6).
        'customers.nearest_location_id',
        'customers.has_left_google_review',
        'customers.waveguard_tier',
        // Map center follows the treated parcel: stamped visit coords first,
        // the primary home only for non-divergent stamps (codex round-9 P2).
        db.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.latitude END) as customer_latitude`),
        db.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.longitude END) as customer_longitude`),
        'technicians.name as technician_name',
        'technicians.photo_url as technician_photo_url',
        'technicians.avatar_url as technician_avatar_url',
        'technicians.photo_s3_key as technician_photo_s3_key')
      .first();

    if (!service) return res.status(404).json({ error: 'Report not found' });
    serviceRecordId = service.id;

    // Staff browsers attach their portal JWT on this fetch (ReportViewPage)
    // — the same signal that opens suppressed shadow reports also unlocks
    // internal_only companion sections. Resolved BEFORE view tracking: a
    // staff read of a customer-visible report (reviewing a shadowed
    // companion section) must not stamp report_viewed_at or log a customer
    // report_viewed activity (Codex P2).
    const staffViewer = await staffCanViewSuppressed(req);

    // Suppressed-report access is enforced by the router.param('token')
    // gate; a suppressed record here means a staff viewer. Staff reads of
    // customer-visible reports skip tracking the same way.
    if (mode === 'live' && !staffViewer && !suppressedTypedReport(service)) {
      await trackServiceReportView(service);
    }

    const products = await db('service_products').where({ service_record_id: service.id });

    if (service.report_template_version === 'service_report_v1') {
      // ?assessment=<id> pins which lawn assessment this render shows (#3168).
      // The headless PDF render passes it so the attachment provably carries
      // the copy the send fence sealed — the renderer navigates to this page
      // and the page fetches its own data, so pinning is the only way to make
      // that deterministic. Validated in report-data against the assessments
      // this token already exposes (same customer, confirmed, linked to this
      // visit); an id outside that set throws rather than widening what the
      // token can see. Ignored on non-lawn reports.
      // Format-validate BEFORE the builder: lawn_assessments.id is a Postgres
      // uuid, so a junk value like ?assessment=invalid raises an invalid-uuid
      // syntax error and surfaces as a 500 instead of the fixed 409 refusal
      // this route promises. A malformed pin is refused exactly like an
      // unauthorized one — same status, same fixed copy, nothing echoed back.
      const requestedAssessment = typeof req.query.assessment === 'string' && req.query.assessment.trim()
        ? req.query.assessment.trim()
        : null;
      if (requestedAssessment
        && requestedAssessment !== PIN_NO_ASSESSMENT
        && !ASSESSMENT_UUID_RE.test(requestedAssessment)) {
        logger.warn(`[reports-public] malformed assessment pin refused for service_record ${serviceRecordId || 'unknown'}`);
        return res.status(409).json({ error: 'Requested assessment is not available for this report' });
      }
      // A pin must be SIGNED by this server. The pin narrows what the report
      // says — `assessment=none` suppresses the lawn section outright — so an
      // unsigned one would let anyone holding a report token produce an
      // official, share-able portal report with an unfavourable assessment
      // removed. Only the renderer can sign, so only the renderer can pin.
      // Refused exactly like an unauthorized pin: same status, same fixed copy.
      if (requestedAssessment
        && !verifyAssessmentPin(req.params.token, requestedAssessment, req.query.asig, req.query.aexp)) {
        logger.warn(`[reports-public] unsigned assessment pin refused for service_record ${serviceRecordId || 'unknown'}`);
        return res.status(409).json({ error: 'Requested assessment is not available for this report' });
      }
      const pinnedLawnAssessmentId = requestedAssessment;
      const v1Data = await buildServiceReportV1ResponseData(service, req.params.token, {
        mode, staffViewer, pinnedLawnAssessmentId,
      });
      // "Your Visit, in Motion" — surface the tech-approved recap inside the
      // report (owner ask 2026-07-05; the standalone /recap/:token player was
      // retired 2026-07-09 — the report is now the only surface). Pest reports
      // only, and only when an approved rendered video actually exists (owner
      // 2026-07-09). Live views only: the player streams
      // /reports/:token/recap/video, meaningless in pdf/static renders.
      // Best-effort — never blocks.
      if (
        mode === 'live' && service.scheduled_service_id && !v1Data.internalOnly
        && v1Data.serviceLine === 'pest'
        // Cockroach-family typed reports dropped the V2 perimeter story —
        // an ALREADY-approved recap video telling it must not keep serving
        // on permanent links either (codex P1 #3007 r11; the recap builder
        // stopped producing new ones in r10).
        && !require('../services/service-report/pest-report-v2').isCockroachTypedReportType(v1Data.typedReport?.type)
      ) {
        try {
          const { getRecap } = require('../services/service-report/recap-pipeline');
          const recap = await getRecap(service.scheduled_service_id);
          if (recap && recap.status === 'approved' && recap.s3_key) {
            v1Data.recap = { ready: true, durationMs: recap.duration_ms || null };
          }
        } catch { /* best-effort */ }
      }
      // Glass is the unconditional report theme now (GATE_REPORT_GLASS retired).
      // Live views only — pdf/static/sms_preview renders never mount the scene,
      // so the print pipeline stays byte-identical.
      if (mode === 'live') {
        v1Data.glassDefault = true;
      }
      return res.json(v1Data);
    }

    res.json({
      serviceType: service.service_type,
      serviceDate: service.service_date,
      technicianName: service.technician_name,
      customerName: `${service.first_name} ${service.last_name}`,
      cityState: `${service.city || ''}${service.state ? ', ' + service.state : ''}`.trim().replace(/^,\s*/, ''),
      // technician_notes is internal (owner ruling 2026-07-16): only the
      // reviewed WHAT WE DID / WHAT WE FOUND parse may reach the customer.
      notes: technicianReportCustomerCopy(service.technician_notes)?.body || '',
      products: products.map(p => ({
        name: p.product_name, category: p.product_category,
        activeIngredient: p.active_ingredient, moaGroup: p.moa_group,
        rate: p.application_rate, rateUnit: p.rate_unit,
      })),
      measurements: {
        soilTemp: service.soil_temp, thatch: service.thatch_measurement,
        soilPh: service.soil_ph, moisture: service.soil_moisture,
      },
      weather: service.weather_data,
      dryTimes: service.dry_time_data,
      irrigation: service.irrigation_recommendation,
      pdfUrl: `/api/reports/${req.params.token}`,
    });
  } catch (err) {
    // A pin this report cannot legitimately show FAILS the request — never a
    // quiet fallback to normal resolution (#3168). The pin is how a pinned
    // render proves the attachment carries the sealed copy; answering with a
    // different assessment would produce exactly the divergence it prevents,
    // and the caller could not tell. 409 so the render errors and the delivery
    // defers retryably. The message names no ids — the caller supplied it.
    if (err?.code === 'pinned_assessment_unavailable') {
      // NEVER log the report token — it is a bearer credential for a
      // customer-facing report carrying their address, so plain-text logs
      // would become a credential store. The service-record id identifies the
      // visit for debugging and grants nothing.
      logger.warn(`[reports-public] pinned assessment refused for service_record ${serviceRecordId || 'unknown'}`);
      return res.status(409).json({ error: 'Requested assessment is not available for this report' });
    }
    return next(err);
  }
});

function generateReportPDF(service, products, weather, dryTimes, irrigation, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${reportPdfFileName(service, { prefix: 'Waves-Report' })}"`);
  doc.pipe(res);

  // Header — logo (centered) with license + contact lines beneath. Falls
  // back to the wordmark if the logo asset is missing in this deploy.
  const { getLogoBuffer } = require('../services/pdf/brand-logo');
  const logoBuf = getLogoBuffer();
  if (logoBuf) {
    doc.image(logoBuf, 281, doc.y, { width: 50, height: 50 });  // center of 612px letter page, 50px square
    doc.moveDown(3);
  } else {
    doc.fontSize(20).font('Helvetica-Bold').text('WAVES PEST CONTROL', { align: 'center' });
  }
  doc.fontSize(9).font('Helvetica').text(`Licensed & Insured · ${WAVES_FL_LICENSE_LINE}`, { align: 'center' });
  doc.text(`${WAVES_SUPPORT_PHONE_DISPLAY} · wavespestcontrol.com`, { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(PDF_BLUE).lineWidth(2).stroke();
  doc.moveDown(1);

  doc.fontSize(14).font('Helvetica-Bold').fillColor(PDF_NAVY).text('SERVICE REPORT');
  doc.moveDown(0.5);

  // Customer info
  doc.fontSize(10).font('Helvetica-Bold').fillColor(PDF_BODY).text('Customer:');
  doc.font('Helvetica').text(`${service.first_name} ${service.last_name}`);
  doc.text(formatAddress({ line1: service.address_line1, city: service.city, state: service.state, zip: service.zip }));
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').text('Service Details:');
  doc.font('Helvetica');
  doc.text(`Date: ${new Date(typeof service.service_date === 'string' ? service.service_date + 'T12:00:00' : service.service_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`);
  doc.text(`Type: ${service.service_type}`);
  doc.text(`Technician: ${service.technician_name || 'Waves Team'}`);
  doc.moveDown(1);

  // Weather conditions
  if (weather) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_NAVY).text('CONDITIONS AT TIME OF SERVICE');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor(PDF_BODY);
    doc.text(`Air Temp: ${weather.temp || '—'}°F  Humidity: ${weather.humidity || '—'}%  Wind: ${weather.wind || '—'}  Cloud Cover: ${weather.cloudCover || '—'}%`);
    if (service.soil_temp) doc.text(`Soil Temp: ${service.soil_temp}°F  Soil pH: ${service.soil_ph || '—'}  Thatch: ${service.thatch_measurement || '—'}"  Moisture: ${service.soil_moisture || '—'}`);
    doc.moveDown(1);
  }

  // Tech notes — raw technician_notes is internal (owner ruling 2026-07-16);
  // print only the reviewed WHAT WE DID / WHAT WE FOUND parse, or nothing.
  const reviewedNotes = technicianReportCustomerCopy(service.technician_notes)?.body;
  if (reviewedNotes) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_NAVY).text('TECHNICIAN NOTES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor(PDF_BODY).text(reviewedNotes, { width: 512, lineGap: 3 });
    doc.moveDown(1);
  }

  // Products
  if (products.length) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_NAVY).text('PRODUCTS APPLIED');
    doc.moveDown(0.3);
    const tTop = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor(PDF_MUTED);
    doc.text('Product', 50, tTop); doc.text('Active Ingredient', 220, tTop);
    doc.text('MOA Group', 370, tTop); doc.text('Category', 470, tTop);
    doc.moveTo(50, tTop + 14).lineTo(562, tTop + 14).strokeColor(PDF_RULE).lineWidth(0.5).stroke();
    let rY = tTop + 20;
    doc.font('Helvetica').fillColor(PDF_BODY);
    products.forEach(p => {
      if (rY > 700) { doc.addPage(); rY = 50; }
      doc.fontSize(9).text(p.product_name || '', 50, rY, { width: 165 });
      doc.text(p.active_ingredient || '—', 220, rY, { width: 145 });
      doc.text(p.moa_group || '—', 370, rY, { width: 95 });
      doc.text(p.product_category || '—', 470, rY, { width: 90 });
      rY += 16;
    });
    doc.y = rY;
    doc.moveDown(1);
  }

  // Dry times
  if (dryTimes) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_NAVY).text('ESTIMATED DRY TIMES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor(PDF_BODY);
    if (dryTimes.lawn) doc.text(`• Lawn treatment: ${dryTimes.lawn}`);
    if (dryTimes.foundation) doc.text(`• Foundation perimeter: ${dryTimes.foundation}`);
    if (dryTimes.interior) doc.text(`• Interior application: ${dryTimes.interior}`);
    if (dryTimes.rainAdvisory) doc.text(`Rain advisory: ${dryTimes.rainAdvisory}`);
    doc.moveDown(1);
  }

  // Irrigation
  if (irrigation) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_NAVY).text('IRRIGATION RECOMMENDATIONS');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor(PDF_BODY);
    if (irrigation.recommendation) doc.text(irrigation.recommendation, { width: 512, lineGap: 3 });
    if (irrigation.instructions?.length) {
      doc.moveDown(0.5);
      irrigation.instructions.forEach(inst => doc.text(`${inst.allowed ? '✓' : '✗'} ${inst.text}`));
    }
    doc.moveDown(1);
  }

  // Footer
  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(PDF_RULE).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor(PDF_MUTED);
  doc.text(`This report is provided for your records. For questions contact Waves Pest Control at ${WAVES_SUPPORT_PHONE_DISPLAY}.`, { align: 'center' });
  doc.text(`Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`, { align: 'center' });

  doc.end();
}

// Helper: generate a report token for a service record
async function ensureReportToken(serviceRecordId) {
  const service = await db('service_records').where({ id: serviceRecordId }).first();
  if (service.report_view_token) return service.report_view_token;

  const token = crypto.randomBytes(16).toString('hex');
  await db('service_records').where({ id: serviceRecordId }).update({
    report_view_token: token,
    report_generated_at: db.fn.now(),
  });
  return token;
}

module.exports = router;
module.exports.ensureReportToken = ensureReportToken;
module.exports.reportLimiter = reportLimiter;
