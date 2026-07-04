const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const db = require('../models/db');
const logger = require('../services/logger');
const { formatAddress } = require('../utils/address-normalizer');
const { etDateString } = require('../utils/datetime-et');
const { FULL_TOKEN_RE, extractProjectReportTokenLookup } = require('../services/project-report-links');
const { findReportFollowupAppointment } = require('../services/report-followup-appointment');
const { buildReportV1Data } = require('../services/service-report/report-data');
const jwt = require('jsonwebtoken');
const config = require('../config');

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

async function staffCanViewSuppressed(req) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return false;
    const decoded = jwt.verify(header.slice(7), config.jwt.secret);
    if (!decoded.technicianId || decoded.scope === 'terminal') return false;
    const tech = await db('technicians').where({ id: decoded.technicianId }).first('id', 'active');
    return Boolean(tech && tech.active);
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
const { renderServiceReportV1Pdf } = require('../services/service-report/pdf');
const {
  getHealthyStoredReportPdf,
  putReportPdf,
  reportPdfStorageKey,
} = require('../services/service-report/pdf-storage');
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

async function recordServiceReportEvent(service, eventName, channel, req, metadata = {}) {
  if (!service?.id || !ALLOWED_REPORT_EVENTS.has(eventName) || !ALLOWED_REPORT_EVENT_CHANNELS.has(channel)) return;
  await db('service_report_events').insert({
    service_record_id: service.id,
    customer_id: service.customer_id || null,
    event_name: eventName,
    channel,
    metadata: JSON.stringify(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    user_agent: String(req.get('user-agent') || '').slice(0, 1000) || null,
    ip_hash: hashPublicIp(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress),
  }).catch((err) => {
    logger.warn(`[reports-public] service_report_event insert failed: ${err.message}`);
  });
}

async function buildServiceReportV1ResponseData(service, token, { mode = 'live', pestPressureConfig, staffViewer = false } = {}) {
  // staffViewer gates internal_only companion sections (combined-service
  // completions): report-data omits them from customer payloads entirely.
  // Only the /data route resolves it (staffCanViewSuppressed — the same
  // staff-JWT signal as the Phase-1b suppressed-report gate); PDF, ask, and
  // every other caller stays a customer view.
  const data = await buildReportV1Data(service, token, db, { pestPressureConfig, staffViewer });
  if (service?.report_template_version !== 'service_report_v1') return data;

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
  if (data.reportV2) {
    try {
      const { reconcileLawnReport } = require('../services/service-report/report-consistency');
      const fix = reconcileLawnReport({ data: { ...data, dynamicContext }, reportV2: data.reportV2 });
      if (fix) {
        data.reportV2 = {
          ...data.reportV2,
          todaysResult: fix.todaysResult || data.reportV2.todaysResult || null,
          followUp: fix.followUp || data.reportV2.followUp || null,
          consistencyWarnings: fix.warnings || [],
        };
        if (fix.reentry && dynamicContext && dynamicContext.reentry) {
          dynamicContext.reentry = { ...dynamicContext.reentry, petAdvisory: fix.reentry.petAdvisory };
        }
      }
    } catch { /* reconciliation is best-effort — never block the report */ }
  }

  // Pest Report V2 — protection-first dashboard (flag-gated). Surfaces the
  // already-built premium-experience intelligence (defense status, primary move,
  // bug files, pressure receipt, AI summary) that was computed but never rendered,
  // plus a seasonal "what to expect" forecast resolved from the property zip.
  // Pest service line only; best-effort so a forecast/network hiccup never blocks
  // the report. Flows to the client via the `...data` spread below.
  if (
    process.env.PEST_REPORT_V2 === 'true'
    && data.serviceLine === 'pest'
    && dynamicContext.premiumExperience
  ) {
    try {
      const { buildPestReportV2 } = require('../services/service-report/pest-report-v2');
      let forecast = null;
      try {
        const { getForecast } = require('../services/pest-forecast/forecast');
        const timer = new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 4000);
          if (t.unref) t.unref();
        });
        forecast = await Promise.race([getForecast({ zip: service.zip }), timer]);
      } catch { forecast = null; }
      const pestReportV2 = buildPestReportV2({
        premiumExperience: dynamicContext.premiumExperience,
        pestPressure: data.pestPressure,
        activity: data.activity,
        forecast,
      });
      if (pestReportV2) data.pestReportV2 = pestReportV2;
    } catch { /* best-effort — never block the report */ }
  }

  if (suppressedTypedReport(service)) {
    return { ...data, dynamicContext, pdfUrl: null, internalOnly: true, ...(staffViewer ? { staffViewer: true } : {}) };
  }
  return { ...data, dynamicContext, ...(staffViewer ? { staffViewer: true } : {}) };
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
      'c.address_line1', 'c.address_line2', 'c.city', 'c.state', 'c.zip',
      't.name as technician_name',
    );
  if (lookup.type === 'full') {
    return query.where({ 'p.report_token': lookup.value }).first();
  }
  const rows = await query.where('p.report_token', 'like', `${lookup.value}%`).limit(2);
  return rows.length === 1 ? rows[0] : null;
}

// GET /api/reports/project/:token/data — project report JSON for the viewer page
router.get('/project/:token/data', async (req, res, next) => {
  if (!extractProjectReportTokenLookup(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const project = await findProjectByReportSegment(req.params.token);
    if (!project) return res.status(404).json({ error: 'Report not found' });

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
    const photosWithUrls = await Promise.all(photos.map(async (ph) => {
      let url = null;
      if (config.s3?.bucket && ph.s3_key) {
        try {
          url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: ph.s3_key }), { expiresIn: 3600 });
        } catch { /* fall through — photo will render as missing */ }
      }
      return { id: ph.id, category: ph.category, caption: ph.caption, visit: ph.visit, url };
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
      fdacsPdfAvailable = Boolean(lastFiling?.s3_key && config.s3?.bucket);
    }

    res.json({
      projectType: project.project_type,
      fdacsPdfAvailable,
      status: project.status,
      title: project.title,
      customerName: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
      // Customer email/phone for the hero contact lines — the report hero
      // mirrors the customer estimate, which prints the recipient's own
      // contact block under the headline. NEVER on a WDO: sendWdoReportCopies
      // emails this same public link to the third parties named on the FDACS
      // form (realtor/title company), and a link the system itself hands to
      // outsiders must not carry the homeowner's direct contact details.
      // Every other project type's link is sent to the customer only.
      customerEmail: project.project_type === 'wdo_inspection' ? null : (project.customer_email || null),
      customerPhone: project.project_type === 'wdo_inspection' ? null : (project.customer_phone || null),
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
      recommendations: project.recommendations,
      followupDate: project.followup_date,
      followupFindings: project.followup_findings,
      followupCompletedAt: project.followup_completed_at,
      upcomingAppointment: upcomingAppointment ? {
        serviceType: upcomingAppointment.service_type,
        scheduledDate: upcomingAppointment.scheduled_date,
        windowStart: upcomingAppointment.window_start,
        windowEnd: upcomingAppointment.window_end,
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
router.get('/project/:token/fdacs-pdf', async (req, res, next) => {
  if (!extractProjectReportTokenLookup(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const project = await findProjectByReportSegment(req.params.token);
    if (!project || project.project_type !== 'wdo_inspection') {
      return res.status(404).json({ error: 'Report not found' });
    }
    let filings = project.wdo_sent_filings;
    if (typeof filings === 'string') { try { filings = JSON.parse(filings); } catch { filings = null; } }
    const lastFiling = Array.isArray(filings) && filings.length ? filings[filings.length - 1] : null;
    if (!lastFiling?.s3_key || !config.s3?.bucket) {
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
    // Signed legal filing behind a long-lived token — never cache, index, or leak the URL.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Referrer-Policy', 'no-referrer');
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
    if (!ALLOWED_REPORT_EVENT_CHANNELS.has(channel)) {
      return res.status(400).json({ error: 'Unknown report event channel' });
    }
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
      ? req.body.metadata
      : {};

    await recordServiceReportEvent(service, eventName, channel, req, metadata);

    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/reports/:token/recap — customer-facing recap status. Only exposes a
// recap the tech has APPROVED (ready-but-unapproved stays private).
router.get('/:token/recap', async (req, res, next) => {
  if (!FULL_TOKEN_RE.test(req.params.token || '')) return res.status(404).json({ error: 'Not found' });
  try {
    const service = await db('service_records').where({ report_view_token: req.params.token }).select('id', 'scheduled_service_id').first();
    if (!service || !service.scheduled_service_id) return res.status(404).json({ error: 'Not found' });
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
    const service = await db('service_records').where({ report_view_token: req.params.token }).select('id', 'scheduled_service_id').first();
    if (!service || !service.scheduled_service_id) return res.status(404).end();
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
      .first('id', 'customer_id', 'service_type', 'service_line', 'service_date', 'status', 'report_template_version', 'client_pest_rating', 'structured_notes');
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
    const eligibilityView = buildPestPressureCustomerView({
      config,
      scoreRow: null,
      serviceRecord: service,
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
        }).catch(() => [])
      : [];

    const pestPressure = buildPestPressureCustomerView({
      config,
      scoreRow: updatedScore,
      serviceRecord: updatedService,
      historyRows,
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
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        'customers.address_line1', 'customers.address_line2',
        'customers.city', 'customers.state', 'customers.zip',
        'customers.has_left_google_review',
        'customers.latitude as customer_latitude', 'customers.longitude as customer_longitude',
        'technicians.name as technician_name',
        'technicians.photo_url as technician_photo_url',
        'technicians.avatar_url as technician_avatar_url',
        'technicians.photo_s3_key as technician_photo_s3_key')
      .first();

    if (!service || service.report_template_version !== 'service_report_v1') {
      return res.status(404).json({ error: 'Report not found' });
    }

    const [data, nextAppointment] = await Promise.all([
      buildServiceReportV1ResponseData(service, req.params.token, { mode: 'live' }),
      db('scheduled_services')
        .where({ customer_id: service.customer_id })
        .where('scheduled_date', '>=', etDateString())
        .whereNotIn('status', ['cancelled', 'completed', 'complete'])
        .orderBy('scheduled_date')
        .orderBy('window_start')
        .first('id', 'service_type', 'scheduled_date', 'window_start', 'window_end', 'status')
        .catch(() => null),
    ]);

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
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
        'customers.has_left_google_review',
        'customers.latitude as customer_latitude', 'customers.longitude as customer_longitude',
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
      const expectedPdfStorageKey = reportPdfStorageKey(service.id, { visibilitySignature });
      const storedPdf = service.pdf_storage_key === expectedPdfStorageKey
        ? await getHealthyStoredReportPdf(service.pdf_storage_key)
        : null;
      if (storedPdf) {
        await recordServiceReportEvent(service, 'pdf_downloaded', 'public_report', req, { source: 'direct_pdf_route' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Waves-Service-Report-${service.service_date}.pdf"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(storedPdf);
      }

      let pdf;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const renderSignature = visibilitySignature;
          const data = await buildServiceReportV1ResponseData(service, req.params.token, { mode: 'pdf', pestPressureConfig });
          pdf = await renderServiceReportV1Pdf(data, {
            token: req.params.token,
            req,
            logger,
            serviceRecordId: service.id,
          });

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
        const key = await putReportPdf(service.id, pdf, { visibilitySignature });
        await db('service_records').where({ id: service.id }).update({ pdf_storage_key: key });
      } catch (storageErr) {
        logger.warn(`[reports-public] PDF storage skipped for ${service.id}: ${storageErr.message}`);
      }
      await recordServiceReportEvent(service, 'pdf_downloaded', 'public_report', req, { source: 'direct_pdf_route' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Waves-Service-Report-${service.service_date}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(pdf);
    }

    // Check if pre-generated PDF exists
    if (service.report_pdf_path) {
      const fullPath = path.join(__dirname, '..', '..', service.report_pdf_path);
      if (fs.existsSync(fullPath)) {
        await recordServiceReportEvent(service, 'pdf_downloaded', 'public_report', req, { source: 'direct_pdf_route' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Waves-Report-${service.service_date}.pdf"`);
        return fs.createReadStream(fullPath).pipe(res);
      }
    }

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
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        'customers.address_line1', 'customers.address_line2',
        'customers.city', 'customers.state', 'customers.zip',
        'customers.has_left_google_review',
        'customers.latitude as customer_latitude', 'customers.longitude as customer_longitude',
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
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.email',
        'customers.address_line1', 'customers.address_line2',
        'customers.city', 'customers.state', 'customers.zip',
        'customers.has_left_google_review',
        'customers.waveguard_tier',
        'customers.latitude as customer_latitude', 'customers.longitude as customer_longitude',
        'technicians.name as technician_name',
        'technicians.photo_url as technician_photo_url',
        'technicians.avatar_url as technician_avatar_url',
        'technicians.photo_s3_key as technician_photo_s3_key')
      .first();

    if (!service) return res.status(404).json({ error: 'Report not found' });

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
      return res.json(await buildServiceReportV1ResponseData(service, req.params.token, { mode, staffViewer }));
    }

    res.json({
      serviceType: service.service_type,
      serviceDate: service.service_date,
      technicianName: service.technician_name,
      customerName: `${service.first_name} ${service.last_name}`,
      cityState: `${service.city || ''}${service.state ? ', ' + service.state : ''}`.trim().replace(/^,\s*/, ''),
      notes: service.technician_notes,
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
  } catch (err) { next(err); }
});

function generateReportPDF(service, products, weather, dryTimes, irrigation, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Waves-Report-${service.service_date}.pdf"`);
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

  // Tech notes
  if (service.technician_notes) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_NAVY).text('TECHNICIAN NOTES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor(PDF_BODY).text(service.technician_notes, { width: 512, lineGap: 3 });
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
