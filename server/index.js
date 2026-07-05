// Sentry must be initialized before all other imports
require("./instrument.js");
const Sentry = require("@sentry/node");

// Prevent unhandled promise rejections from crashing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason?.message || reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  Sentry.captureException(err);
  // Don't exit — let the process recover
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const config = require('./config');
const logger = require('./services/logger');
const { errorHandler, notFound } = require('./middleware/errors');
const { initScheduledJobs, initBankingSync } = require('./services/scheduler');
const { applySensitiveSpaHeaders } = require('./utils/sensitive-spa-headers');

// Fail closed on missing critical secrets in production. A missing JWT_SECRET
// would otherwise let the app boot and then break auth at runtime — jwt.sign
// throws on every request — instead of refusing to start. DATABASE_URL gets the
// same treatment so a misconfigured deploy fails loudly at boot, not on the
// first query. Non-production only warns so local dev/tests run without a full
// .env.
function assertRequiredSecrets() {
  // knexfile resolves Railway's alternate DB env shapes (DATABASE_PRIVATE_URL,
  // DATABASE_PUBLIC_URL, POSTGRES_URL, PG* vars) and backfills
  // process.env.DATABASE_URL as a require-time side effect — models/db pulls
  // it in moments later anyway. Trigger that resolution BEFORE deciding the
  // URL is missing, and check the post-resolution env var rather than the
  // config snapshot (which may have been cached before the backfill).
  require('./knexfile');
  const required = {
    JWT_SECRET: config.jwt.secret,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value || !String(value).trim())
    .map(([name]) => name);
  if (!missing.length) return;
  const message = `Missing required environment variable(s): ${missing.join(', ')}`;
  if (config.nodeEnv === 'production') {
    // The global uncaughtException handler above deliberately never exits, so
    // a top-level throw here would be swallowed — leaving a zombie process
    // that logs once and never binds the port. Exit explicitly instead.
    console.error(`[startup] ${message} — refusing to start.`);
    logger.error(`[startup] ${message} — refusing to start.`);
    process.exit(1);
  }
  logger.warn(`[startup] ${message} — continuing (non-production).`);
}
assertRequiredSecrets();

// Route imports
const authRoutes = require('./routes/auth');
const serviceRoutes = require('./routes/services');
const scheduleRoutes = require('./routes/schedule');
const billingRoutes = require('./routes/billing-v2');
const notificationRoutes = require('./routes/notifications');
const requestRoutes = require('./routes/requests');
const bouncieRoutes = require('./routes/bouncie');
const lawnHealthRoutes = require('./routes/lawn-health');
const feedRoutes = require('./routes/feed');
const satisfactionRoutes = require('./routes/satisfaction');
const propertyRoutes = require('./routes/property');
const customerPricingAiRoutes = require('./routes/customer-pricing-ai');
const referralRoutes = require('./routes/referrals-v2');
const promotionRoutes = require('./routes/promotions');
const documentRoutes = require('./routes/documents');
const badgeRoutes = require('./routes/badges');
const trackingRoutes = require('./routes/tracking');
const adminAuthRoutes = require('./routes/admin-auth');
const adminPushRoutes = require('./routes/admin-push');
const adminCustomerRoutes = require('./routes/admin-customers');
const adminDashboardRoutes = require('./routes/admin-dashboard');
const adminEstimateRoutes = require('./routes/admin-estimates');
const adminServiceOutlineRoutes = require('./routes/admin-service-outlines');
const adminPropertyLookupRoutes = require('./routes/admin-property-lookup');
const estimatePublicRoutes = require('./routes/estimate-public');
const serviceOutlinePublicRoutes = require('./routes/service-outlines-public');
const publicQuoteRoutes = require('./routes/public-quote');
const publicPropertyLookupRoutes = require('./routes/public-property-lookup');
const adminReviewRoutes = require('./routes/admin-reviews');
const adminSettingsRoutes = require('./routes/admin-settings');
const adminBacklinkAgentRoutes = require('./routes/admin-backlink-agent-v2');
const adminImportRoutes = require('./routes/admin-import-sheets');
const propertyLookupV2Routes = require('./routes/property-lookup-v2');
const adminReferralRoutes = require('./routes/admin-referrals-v2');
const reviewsPublicRoutes = require('./routes/reviews-public');
const adminDispatchRoutes = require('./routes/admin-dispatch');
const adminCommsRoutes = require('./routes/admin-communications');
const adminCommsAttachRoutes = require('./routes/admin-communications-attach');
const twilioWebhookRoutes = require('./routes/twilio-webhook');
const reportsPublicRoutes = require('./routes/reports-public');
const adminInventoryRoutes = require('./routes/admin-inventory');
const adminPriceMatchRoutes = require('./routes/admin-price-match');
const adminComplianceRoutes = require('./routes/admin-compliance');
const adminWorkflowRoutes = require('./routes/admin-workflows');
const adminAdsRoutes = require('./routes/admin-ads');
const adminSeoRoutes = require('./routes/admin-seo-v2');
const adminContentRoutes = require('./routes/admin-content-v2');
const adminKnowledgeRoutes = require('./routes/admin-knowledge');
const adminCsrRoutes = require('./routes/admin-csr');
const adminCustomerIntelRoutes = require('./routes/admin-customer-intel');
const techKnowledgeRoutes = require('./routes/tech-knowledge');
const dispatchRoutes = require('./routes/dispatch');
const dispatchKnowledgeRoutes = require('./routes/knowledge');
const aiAssistantRoutes = require('./routes/ai-assistant');
const twilioVoiceWebhookRoutes = require('./routes/twilio-voice-webhook');
const adminReviewRequestRoutes = require('./routes/admin-review-requests');
const reviewPublicRoutes = require('./routes/review-public');
const adminIntelligenceBarRoutes = require('./routes/admin-intelligence-bar');
const toolHealthRoutes = require('./routes/tool-health');

const app = express();

const SERVICE_ESTIMATE_SLUGS = require('./config/service-estimate-slugs');

// Railway terminates TLS upstream and forwards via X-Forwarded-For.
// Trust a single proxy hop so express-rate-limit can key on the real client IP.
app.set('trust proxy', 1);

// =========================================================================
// MIDDLEWARE
// =========================================================================

// Security headers — CSP allows Google Fonts, APIs, and inline styles.
// The /book public booking page is iframe-embeddable on external sites,
// so it gets permissive frame-ancestors via a scoped middleware.
const cspDirectives = {
  defaultSrc: ["'self'"],
  // PostHog (*.posthog.com) is loaded only on the public funnel pages
  // (/book, /estimate, /pay) and only after consent — see the client's
  // PublicFunnelTracking. Listing the host here is harmless when no key is set.
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://maps.googleapis.com", "https://js.stripe.com", "https://static.cloudflareinsights.com", "https://*.posthog.com", "https://challenges.cloudflare.com"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: ["'self'", "https:", "data:", "blob:"],
  // cdn.growthbook.io: the client GrowthBook SDK fetches feature definitions
  // from there once VITE_GROWTHBOOK_CLIENT_KEY is set (harmless while unset;
  // self-hosted deployments must swap in their VITE_GROWTHBOOK_API_HOST).
  connectSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://maps.googleapis.com", "https://api.dataforseo.com", "https://fawn.ifas.ufl.edu", "https://generativelanguage.googleapis.com", "https://www.googleapis.com", "https://api.stripe.com", "https://*.posthog.com", "https://cdn.growthbook.io"],
  frameSrc: ["'self'", "https://www.google.com", "https://js.stripe.com", "https://hooks.stripe.com", "https://challenges.cloudflare.com"],
  mediaSrc: ["'self'", "https:"],
  // PostHog session replay records via a web worker created from a blob URL.
  workerSrc: ["'self'", "blob:"],
};

const strictHelmet = helmet({ contentSecurityPolicy: { directives: cspDirectives } });
const embedHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      ...cspDirectives,
      frameAncestors: ["'self'", "https:", "http://localhost:*"],
    },
  },
  frameguard: false, // disable X-Frame-Options so frame-ancestors governs embedding
});

app.use((req, res, next) => {
  // Only the /book HTML document needs frame-ancestors loosened
  // (query string is not part of req.path; handle trailing slash too)
  if (req.path === '/book' || req.path === '/book/') return embedHelmet(req, res, next);
  return strictHelmet(req, res, next);
});

// Public, embeddable endpoints must be CORS-open to ANY origin and must answer
// their own preflights BEFORE the credentialed allowlist below — the cors()
// middleware terminates OPTIONS for non-allowlisted origins without an
// Access-Control-Allow-Origin header, which would break third-party embeds.
// (Approved public surface — see AGENTS.md.) Keep this above the global cors().
app.use('/api/public/pest-forecast', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// CORS — allow frontend dev server and production domain
const { allowedOrigins } = require('./config/cors-origins');
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Rate limiting — key generator shared with route-level limiters (JWT subject
// when authenticated, /64-collapsed IP otherwise; full rationale in the module).
const { rateLimitKey } = require('./middleware/rate-limit-key');

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV !== 'production',
});
// The disabled payer-statement-pay surface must ALWAYS look like Not Found —
// even ahead of the global /api/ limiter — so an IP that already exhausted the
// app-wide limit can't observe the surface via a 429 (contract: 404 when
// GATE_PAYER_STATEMENTS is off). Runs before the limiter; the route's own
// gate + per-route limiter still apply when the feature is enabled.
app.use('/api/pay/statement', (req, res, next) => {
  // eslint-disable-next-line global-require
  if (!require('./config/feature-gates').isEnabled('payerStatements')) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts, please try again in 15 minutes.' },
});
app.use('/api/auth/send-code', authLimiter);
app.use('/api/auth/verify-code', authLimiter);
app.use('/api/admin/auth/login', authLimiter);

// Public, unauthenticated surfaces that hit paid third-party APIs get tight
// per-IP caps on top of the global limiter so a bot flood can't run up spend.
// Lead intake fires Twilio SMS (new-lead alerts + customer confirmations); the
// estimators call Google Maps + AI per lookup. Keyed like the global limiter
// (IP fallback for no-auth traffic) and skipped outside production so local
// dev and tests aren't throttled.
const leadIntakeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15,
  message: { error: 'Too many submissions, please try again later.' },
  keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV !== 'production',
});
const paidEstimatorDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 60,
  message: { error: 'Daily limit reached, please try again tomorrow.' },
  keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV !== 'production',
});
// Ask Waves chat: every accepted /message turn is a paid LLM call (OpenAI,
// then Anthropic fallback), so the 30/15min in-route limiter gets a daily
// ceiling on top — same spend rationale as paidEstimatorDailyLimiter, higher
// cap because a real quote conversation is many turns while an estimator
// session is one lookup. Counts ONLY requests that can actually reach the
// model: a plausible POST /message body with the gate on. GET /status
// (page-view gate check), non-POST scanner probes, dark-launch probes while
// GATE_ASK_WAVES is off, and empty/oversized bodies (the route 400s them
// before any model call — shared isPlausibleMessageBody check) all resolve
// without an LLM call, so none of them may burn the paid budget for a
// shared/NAT'd IP and 429 later real turns.
const askWavesDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 120,
  message: { error: 'Daily limit reached — call (941) 297-5749 and a real person will help right away.' },
  keyGenerator: rateLimitKey,
  skip: (req) => process.env.NODE_ENV !== 'production'
    || req.method !== 'POST'
    || !/^\/message\/?$/.test(req.path)
    || !require('./config/feature-gates').isEnabled('askWaves')
    || !require('./routes/public-ai-intake').isPlausibleMessageBody(req.body),
});

// Body parsing
// Stripe webhook must use raw body for signature verification — mount BEFORE json parser
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripe-webhook'));
// SendGrid event webhook verifies an ECDSA signature over the raw body — same reason, mount BEFORE json parser.
// The route attaches its own express.raw() so it only consumes the raw body for its own path.
app.use('/api/webhooks/sendgrid', require('./routes/webhooks-sendgrid'));
// Resend event webhook (placeholder — wired for migration). Same raw-body
// reason as SendGrid; verifies a Svix HMAC-SHA256 signature.
app.use('/api/webhooks/resend', require('./routes/webhooks-resend'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Public assets used by server-rendered customer pages. In production Vite
// copies these into client/dist; in local API-only dev they still need to be
// served from client/public so SSR pages can render shared brand artwork.
app.use(express.static(path.join(__dirname, '..', 'client', 'public'), {
  index: false,
  maxAge: config.nodeEnv === 'production' ? '1h' : 0,
}));

// Request logging
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// =========================================================================
// API ROUTES
// =========================================================================

app.use('/api/auth', authRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/service/records', require('./routes/service-records'));
app.use('/api/schedule', scheduleRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/bouncie', bouncieRoutes);
app.use('/api/lawn-health', lawnHealthRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/satisfaction', satisfactionRoutes);
app.use('/api/property', propertyRoutes);
app.use('/api/customer-pricing', customerPricingAiRoutes);
app.use('/api/service-preferences', require('./routes/service-preferences'));
app.use('/api/referrals', referralRoutes);
app.use('/r', require('./routes/referral-links'));
app.use('/l', require('./routes/public-shortlinks'));
app.use('/api/promotions', promotionRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/badges', badgeRoutes);
app.use('/api/push', require('./routes/push'));
app.use('/api/tracking', trackingRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/push', adminPushRoutes);
app.use('/api/admin/intelligence-bar', adminIntelligenceBarRoutes);
app.use('/api/admin/tool-health', toolHealthRoutes);
app.use('/api/admin/customers/intelligence', adminCustomerIntelRoutes);
// Mounted before adminCustomerRoutes so the customer router doesn't
// shadow the turf-profile sub-routes. Both routers share the
// /api/admin/customers prefix; Express tries them in mount order.
app.use('/api/admin/customers', require('./routes/admin-customer-turf-profile'));
app.use('/api/admin/customers', adminCustomerRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/kpi-targets', require('./routes/admin-kpi-targets'));
app.use('/api/admin/command-center', require('./routes/admin-command-center'));
app.use('/api/admin/feature-flags', require('./routes/admin-feature-flags'));
app.use('/api/admin/turf-height', require('./routes/admin-turf-height'));
app.use('/api/admin/estimates', adminEstimateRoutes);
app.use('/api/admin/service-outlines', adminServiceOutlineRoutes);
app.use('/api/admin/estimates', require('./routes/admin-estimate-slots'));
app.use('/api/admin/pipeline', require('./routes/admin-pipeline'));
app.use('/api/admin/lookup', adminPropertyLookupRoutes);
app.use('/api/estimates', estimatePublicRoutes);
app.use('/api/service-outlines', serviceOutlinePublicRoutes);
// Customer-facing estimate URL. Service slugs render the SPA quote wizard;
// everything else remains a server-rendered accepted-estimate token.
app.get('/estimate/:token', (req, res, next) => {
  const slug = String(req.params.token || '').toLowerCase();
  if (SERVICE_ESTIMATE_SLUGS.has(slug)) return next();
  return estimatePublicRoutes.handleEstimateView(req, res, next);
});
app.use('/api/public/quote', paidEstimatorDailyLimiter, publicQuoteRoutes);
app.use('/api/public/estimator', paidEstimatorDailyLimiter, publicPropertyLookupRoutes);
app.use('/api/admin/reviews', adminReviewRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/backlink-agent', adminBacklinkAgentRoutes);
app.use('/api/admin/import', adminImportRoutes);
app.use('/api/admin/estimator', propertyLookupV2Routes);
app.use('/api/admin/referrals', adminReferralRoutes);
app.use('/api/reviews', reviewsPublicRoutes);
app.use('/api/admin/dispatch', adminDispatchRoutes);
app.use('/api/admin/auto-dispatch', require('./routes/admin-auto-dispatch'));
app.use('/api', require('./routes/visual-service-moments'));
app.use('/api/admin/dev', require('./routes/admin-dev-tech-status'));
app.use('/api/admin/dev', require('./routes/admin-dev-job-status'));
app.use('/api/admin/dev', require('./routes/admin-dev-dispatch-alert'));
app.use('/api/stripe/terminal', require('./routes/stripe-terminal'));
app.use('/api/admin/communications', adminCommsRoutes);
app.use('/api/admin/communications', adminCommsAttachRoutes);
app.use('/api/admin/email-templates', require('./routes/admin-email-templates'));
app.use('/api/admin/notification-events', require('./routes/admin-notification-events'));
app.use('/api/admin/newsletter', require('./routes/admin-newsletter'));
app.use('/api/public/newsletter', require('./routes/public-newsletter'));
app.use('/api/public/social-feed', require('./routes/social-feed-public'));
app.use('/api/public/automation-preview', require('./routes/public-automation-preview'));
app.use('/api/public/service-areas', require('./routes/public-service-areas'));
app.use('/api/public/credentials', require('./routes/public-credentials'));
app.use('/api/public/track', require('./routes/track-public'));
// Client-side GrowthBook exposure intake (experimentation Phase 2) — gated by
// GATE_GROWTHBOOK inside the route (404 when off), own per-route rate limit.
app.use('/api/public/experiments', require('./routes/experiments-public'));
app.use('/api/public/reschedule', require('./routes/reschedule-public'));
app.use('/api/public/prep', require('./routes/prep-public'));
app.use('/api/public/lawn-diagnostic', require('./routes/public-lawn-diagnostic'));
app.use('/api/public/estimates', require('./routes/estimate-slots-public'));
app.use('/api/public/products', require('./routes/public-products'));
app.use('/api/public/pest-forecast', require('./routes/public-pest-forecast'));
app.use('/api/public/ai-intake', askWavesDailyLimiter, require('./routes/public-ai-intake'));
app.use('/api/admin/credentials', require('./routes/admin-credentials'));
app.use('/api/admin/seo-diagnosis', require('./routes/admin-seo-diagnosis'));
// Twilio webhook signature validation. Runs before BOTH Twilio routers
// so /sms /status (twilio-webhook.js) and /voice /call-complete /recording-status
// /transcription /call-status /outbound-* (twilio-voice-webhook.js) all
// authenticate inbound requests against X-Twilio-Signature.
//
// Defaults to TWILIO_SIGNATURE_VALIDATION=enforce so public Twilio callbacks
// fail closed unless an operator explicitly opts into log/disabled mode.
//
// See server/middleware/twilio-signature.js + docs/call-triage-discovery.md §14.
const { validateTwilioSignature } = require('./middleware/twilio-signature');

// twilio-webhook.js handles /sms + /status; twilio-voice-webhook.js handles /voice, /call-complete,
// /recording-status, /transcription, /outbound-admin-prompt — no path conflicts under same mount.
app.use('/api/webhooks/twilio', validateTwilioSignature, twilioWebhookRoutes);
app.use('/api/webhooks/lead', leadIntakeLimiter, require('./routes/lead-webhook'));
app.use('/api/leads', leadIntakeLimiter, require('./routes/lead-webhook'));
// Bilingual AI voice agent posts captured leads here (fail-closed shared-secret
// auth inside the route). JSON body — mounted after express.json above.
app.use('/api/webhooks/voice-agent', require('./routes/webhooks-voice-agent'));
app.use('/api/reports', reportsPublicRoutes);
app.use('/api/admin/inventory', adminInventoryRoutes);
app.use('/api/admin/price-match', adminPriceMatchRoutes);
app.use('/api/admin/compliance', adminComplianceRoutes);
app.use('/api/admin/workflows', adminWorkflowRoutes);
app.use('/api/admin/ads', adminAdsRoutes);
app.use('/api/admin/seo/actions', require('./routes/admin-seo-actions'));
app.use('/api/admin/seo/url-intelligence', require('./routes/admin-seo-url-intelligence'));
app.use('/api/admin/seo', adminSeoRoutes);
app.use('/api/admin/content-registry', require('./routes/admin-content-registry'));
app.use('/api/admin/content', adminContentRoutes);
app.use('/api/admin/knowledge', adminKnowledgeRoutes);
app.use('/api/admin/csr', adminCsrRoutes);
app.use('/api/tech/knowledge', techKnowledgeRoutes);
app.use('/api/dispatch', require('./middleware/admin-auth').adminAuthenticate, require('./middleware/admin-auth').requireTechOrAdmin, dispatchRoutes);
app.use('/api/knowledge', require('./middleware/admin-auth').adminAuthenticate, require('./middleware/admin-auth').requireTechOrAdmin, dispatchKnowledgeRoutes);
app.use('/api/booking', require('./routes/booking'));
app.use('/api/ai', aiAssistantRoutes);
app.use('/api/webhooks/twilio', validateTwilioSignature, twilioVoiceWebhookRoutes);
// Facebook Messenger / Instagram channel-sender inbound (POST /messenger) —
// same mount + signature validation as the SMS/voice webhooks; no path conflict.
app.use('/api/webhooks/twilio', validateTwilioSignature, require('./routes/twilio-messenger-webhook'));
app.use('/api/admin/protocols', require('./routes/admin-protocols'));
app.use('/api/admin/revenue', require('./routes/admin-revenue'));
app.use('/api/admin/schedule/find-time', require('./routes/admin-schedule-find-time'));
app.use('/api/admin/schedule', require('./routes/admin-schedule'));
// Standalone technicians list — used by CreateAppointmentModal and other components
app.get('/api/admin/technicians', require('./middleware/admin-auth').adminAuthenticate, require('./middleware/admin-auth').requireTechOrAdmin, async (req, res, next) => {
  try {
    const techs = await require('./models/db')('technicians').select('id', 'name', 'role', 'phone', 'active').where({ active: true }).orderBy('name');
    res.json({ technicians: techs });
  } catch (err) { next(err); }
});
app.use('/api/admin/data-hygiene', require('./routes/admin-data-hygiene'));
app.use('/api/admin/agents', require('./routes/admin-agents'));
app.use('/api/admin/agent-decisions', require('./routes/admin-agent-decisions'));
app.use('/api/admin/drafts', require('./routes/admin-drafts'));
app.use('/api/admin/gbp', require('./routes/admin-gbp'));
app.use('/api/admin/automations', require('./routes/admin-automations'));
app.use('/api/admin/social-media', require('./routes/admin-social-media'));
app.use('/api/admin/call-recordings', require('./routes/admin-call-recordings'));
app.use('/api/admin/triage', require('./routes/admin-triage'));

app.use('/api/admin/contracts', require('./routes/admin-contracts'));
app.use('/api/admin/document-templates', require('./routes/admin-document-templates'));
app.use('/api/admin/invoices', require('./routes/admin-invoices'));
app.use('/api/admin/billing-recovery', require('./routes/admin-billing-recovery'));
app.use('/api/admin/payers', require('./routes/admin-payers'));
app.use('/api/admin/job-forms', require('./routes/admin-job-forms'));
app.use('/api/admin/job-costs', require('./routes/admin-job-costs'));
app.use('/api/admin/job-expenses', require('./routes/admin-job-expenses'));
app.use('/api/admin/projects', require('./routes/admin-projects'));
// Statement pay (P3) mounts BEFORE /api/pay so its two-segment paths aren't
// shadowed by the invoice router's `/:token`. Gated behind GATE_PAYER_STATEMENTS.
app.use('/api/pay/statement', require('./routes/pay-statement'));
app.use('/api/pay', require('./routes/pay-v2'));
app.use('/api/receipt', require('./routes/receipt-v2'));
app.use('/api/contracts', require('./routes/contracts-public'));
app.use('/api/rate', require('./routes/review-gate'));
app.use('/api/admin/tax', require('./routes/admin-tax'));
app.use('/api/admin/pricing', require('./routes/admin-pricing-strategy'));
app.use('/api/admin/lawn-assessment', require('./routes/admin-lawn-assessment'));
app.use('/api/admin/knowledge-bridge', require('./routes/admin-knowledge-bridge'));
app.use('/api/admin/assessment-analytics', require('./routes/admin-assessment-analytics'));
app.use('/api/admin/treatment-plans', require('./routes/admin-treatment-plans'));
app.use('/api/admin/equipment', require('./routes/admin-equipment'));
app.use('/api/admin/equipment-systems', require('./routes/admin-equipment-systems'));
app.use('/api/admin/analytics', require('./routes/admin-analytics'));
app.use('/api/admin/token-health', require('./routes/admin-token-health'));
app.use('/api/admin/integrations', require('./routes/admin-integrations'));
app.use('/api/integrations/backlink-worker', require('./routes/integrations-backlink-worker'));
app.use('/api/integrations/vendor-login-worker', require('./routes/integrations-vendor-login-worker'));
app.use('/api/integrations/vendor-price-worker', require('./routes/integrations-vendor-price-worker'));
app.use('/api/admin/kb', require('./routes/admin-kb'));
app.use('/api/admin/notifications', require('./routes/admin-notifications'));
app.use('/api/customer-notifications', require('./routes/customer-notifications'));
app.use('/api/billing/autopay', require('./routes/customer-autopay'));
app.use('/api/admin/payments', require('./routes/admin-payments-reconcile'));
app.use('/api/review', reviewPublicRoutes);
app.use('/api/admin/review-requests', adminReviewRequestRoutes);
app.use('/api/admin/requests', require('./routes/admin-requests'));
app.use('/api/admin/wiki', require('./routes/admin-wiki'));
app.use('/api/admin/health', require('./routes/admin-health'));
app.use('/api/admin/timetracking', require('./routes/admin-timetracking'));
app.use('/api/admin/timesheets', require('./routes/admin-timesheet-approval'));
app.use('/api/tech/timetracking', require('./routes/tech-timetracking'));
app.use('/api/admin/leads', require('./routes/admin-leads'));
app.use('/api/admin/equipment-maintenance', require('./routes/admin-equipment-maintenance'));
app.use('/api/admin/ical-history', require('./routes/admin-ical-history'));
app.use('/api/admin/mileage', require('./routes/admin-mileage'));
app.use('/api/admin/compliance-v2', require('./routes/admin-compliance-v2'));
app.use('/api/admin/services', require('./routes/admin-services'));
app.use('/api/admin/discounts', require('./routes/admin-discounts'));
app.use('/api/admin/banking', require('./routes/admin-banking'));
app.use('/api/admin/dashboard-ops', require('./routes/admin-dashboard-ops'));
app.use('/api/admin/sms-templates', require('./routes/admin-sms-templates'));
app.use('/api/admin/email', require('./routes/admin-email'));
app.use('/api/admin/pricing-config', require('./routes/admin-pricing-config'));
app.use('/api/admin/pest-pressure', require('./routes/admin-pest-pressure'));
app.use('/api/admin/pricing-proposals', require('./routes/admin-pricing-proposals'));
app.use('/api/admin/pricing-reality-check', require('./routes/admin-pricing-reality-check'));
app.use('/api/tech/field-lead', require('./routes/tech-field-lead'));
app.use('/api/tech/lawn-diagnostic', require('./routes/tech-lawn-diagnostic'));
app.use('/api/tech/social', require('./routes/tech-social'));
app.use('/api/notification-prefs', require('./routes/notification-prefs'));
app.use('/api/bouncie', require('./routes/bouncie-webhook'));
app.use('/api/webhooks/bouncie', require('./routes/webhooks-bouncie'));
app.use('/api/tech/notifications', require('./routes/tech-notifications'));
app.use('/api/tech/services', require('./routes/tech-track'));
app.use('/api/admin/geofence', require('./routes/admin-geofence'));
app.use('/api/admin', require('./routes/admin-billing-health'));

// Health check
app.get('/api/health', (req, res) => {
  const { gates } = require('./config/feature-gates');
  res.json({
    status: 'ok',
    service: 'waves-customer-portal',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    gates,
  });
});

// =========================================================================
// SERVE FRONTEND (Production)
// =========================================================================

if (config.nodeEnv === 'production') {
  const clientBuild = path.join(__dirname, '..', 'client', 'dist');
  const fs = require('fs');
  const {
    applyHtmlMetadata,
    loadServiceReportPageMetadata,
    redactReportPath,
  } = require('./services/report-page-metadata');

  // Per-section PWA shape. /admin and /tech each install as their own
  // home-screen icon with their own name/manifest/start_url, instead of
  // every install path inheriting the customer-portal label. iOS reads
  // <link rel="manifest"> + <title> + apple-mobile-web-app-title at
  // install time, so swapping all three based on URL prefix is enough.
  //
  // Add new sections here if a future surface needs its own PWA.
  const SECTIONS = [
    {
      prefix: '/admin',
      manifest: '/admin-manifest.json',
      title: 'Waves Admin',
      appleTitle: 'Waves Admin',
      themeColor: '#18181B',
    },
    {
      prefix: '/tech',
      manifest: '/tech-manifest.json',
      title: 'Waves Tech',
      appleTitle: 'Waves Tech',
      themeColor: '#111111',
    },
  ];
  function pickSection(reqPath) {
    return SECTIONS.find((s) => reqPath === s.prefix || reqPath.startsWith(s.prefix + '/')) || null;
  }
  async function renderHTML(reqPath) {
    // Read fresh each call — index.html is small (~3KB) and the
    // surrounding handlers are already no-cache, so fresh reads keep
    // deploys snappy without a stale-cache footgun.
    let html = fs.readFileSync(path.join(clientBuild, 'index.html'), 'utf8');
    const section = pickSection(reqPath);
    if (section) {
      html = html.replace(/href="\/manifest\.json"/, `href="${section.manifest}"`);
      html = applyHtmlMetadata(html, {
        title: section.title,
        appleTitle: section.appleTitle,
        themeColor: section.themeColor,
      });
    }
    try {
      const reportMetadata = await loadServiceReportPageMetadata(reqPath);
      if (reportMetadata) html = applyHtmlMetadata(html, reportMetadata);
    } catch (err) {
      logger.warn(`[report-meta] Failed to render report metadata for ${redactReportPath(reqPath)}: ${err.message}`);
    }
    return html;
  }

  async function sendSpaHtml(req, res, next) {
    try {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Content-Type', 'text/html; charset=utf-8');
      applySensitiveSpaHeaders(req.path, res);
      return res.send(await renderHTML(req.path));
    } catch (err) {
      return next(err);
    }
  }

  function isMissingStaticAssetRequest(reqPath) {
    const lastSegment = path.basename(reqPath || '');
    return /\.[A-Za-z0-9]{1,12}$/.test(lastSegment);
  }

  // Never cache sw.js or index.html — ensures deploys are picked up immediately
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Service-Worker-Allowed', '/');
    res.sendFile(path.join(clientBuild, 'sw.js'));
  });
  app.get('/', (req, res, next) => {
    if (req.accepts('html')) {
      return sendSpaHtml(req, res, next);
    }
    next();
  });
  app.get(/^\/report\/[a-f0-9]{32}\/?$/i, reportsPublicRoutes.reportLimiter, sendSpaHtml);
  app.get(/^\/recap\/[a-f0-9]{32}\/?$/i, reportsPublicRoutes.reportLimiter, sendSpaHtml);

  app.use(express.static(clientBuild, {
    maxAge: '1y',       // Cache hashed assets (/assets/*) for 1 year
    immutable: true,
    setHeaders: (res, filePath) => {
      // But never cache index.html or sw.js
      if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));

  // SPA fallback — serve index.html for all non-API routes, with the
  // per-section title/manifest swap so /admin and /tech install as
  // their own PWAs.
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api')) {
      if (isMissingStaticAssetRequest(req.path)) return next();
      return sendSpaHtml(req, res, next);
    }
    return next();
  });
}

// =========================================================================
// ERROR HANDLING
// =========================================================================

// Sentry debug/test route
app.get("/debug-sentry", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});

// Sentry error handler — must be before other error middleware
Sentry.setupExpressErrorHandler(app);

app.use(notFound);
app.use(errorHandler);

// =========================================================================
// START SERVER
// =========================================================================

const PORT = config.port;

// Wrap Express in an http.Server so Socket.io can attach to the same
// listener. Express's app.listen() returns an http.Server too, but
// constructing it explicitly makes the io attach point obvious and
// gives us a handle for graceful shutdown.
const http = require('http');
const httpServer = http.createServer(app);

const { attachSockets } = require('./sockets');
const io = attachSockets(httpServer);

// Voice-AI relay (Twilio ConversationRelay → Claude), Phase 0. Fail-closed:
// a no-op unless VOICE_RELAY_ENABLED=true, in which case it registers a
// path-scoped ws upgrade handler (/ws/voice-agent) that coexists with the
// Socket.io dispatch server above without touching its upgrade path. Wrapped so
// any failure here can never block API boot.
try {
  require('./services/voice-agent/relay-server').attachVoiceRelay(httpServer);
} catch (e) {
  logger.error(`[voice-relay] attach failed (continuing without it): ${e.message}`);
}

// Migrations are NOT run from this process. They run as Railway's
// pre-deploy command (railway.toml:
//   preDeployCommand = ["npm run db:migrate"]
// ) — once per deploy, fail-fast: if migrate:latest exits non-zero,
// Railway rejects the deploy and the previous version stays live.
// Per-boot in-process migration was the old pattern (issue #286);
// it ran every container start, raced concurrent boots, and the
// retry loop's swallow list (`already exists`, `duplicate key`,
// `current transaction is aborted`) could mask real schema drift
// without anyone noticing. If you're seeing migration failures, look
// at the Railway deploy log, not the boot log.
//
// Local dev: root package.json has `predev = npm run db:migrate`,
// so `npm run dev` still auto-migrates against the local DB. Run
// `npm run db:migrate` manually if you want to migrate without
// starting the dev server.
httpServer.listen(PORT, () => {
  const mem = process.memoryUsage();
  logger.info(`Waves API running on port ${PORT} | RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB`);
  logger.info(`   Environment: ${config.nodeEnv} | Client: ${config.clientUrl}`);

  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || process.env.POSTGRES_URL;
  logger.info(`Database: ${dbUrl ? dbUrl.replace(/:[^:@]+@/, ':***@').substring(0, 60) + '...' : 'NOT SET'}`);

  (async () => {
    if (config.nodeEnv !== 'test') {
      initScheduledJobs();
      // Banking sync runs ungated (passive Stripe→DB mirror, no customer
      // side effects) so payout backfill keeps working when GATE_CRON_JOBS
      // is off. See scheduler.js for the full rationale.
      initBankingSync();
    }

    // Terminal Tap to Pay: surface missing/short TERMINAL_HANDOFF_SECRET in
    // the deploy log immediately. Not a hard boot failure — the portal is
    // designed to tolerate partial config, and taking down 90 unrelated
    // routes because one feature's secret is missing would be wrong blast
    // radius. The endpoint still refuses to mint at runtime, but this log
    // line means ops sees the problem when they look at the deploy, not
    // when a tech on-site gets a 500.
    {
      const s = process.env.TERMINAL_HANDOFF_SECRET;
      if (!s || s.length < 32) {
        const msg = s
          ? '[stripe-terminal] TERMINAL_HANDOFF_SECRET is set but shorter than 32 chars — handoff minting DISABLED. Regenerate with: openssl rand -hex 32'
          : '[stripe-terminal] TERMINAL_HANDOFF_SECRET is NOT SET — handoff minting DISABLED. Generate with: openssl rand -hex 32 and set in Railway env.';
        if (config.nodeEnv === 'production') logger.error(msg); else logger.warn(msg);
      }
    }

    // Sync pricing engine constants from admin-edited DB values
    try {
      const { syncConstantsFromDB } = require('./services/pricing-engine');
      await syncConstantsFromDB();
    } catch (err) {
      logger.warn(`[pricing-engine] Initial DB sync skipped: ${err.message}`);
    }

    // Stripe payout sync runs twice daily at 8 AM and 8 PM ET via
    // initBankingSync() — registered above outside the cron-gate so the
    // catch-up still runs in prod when GATE_CRON_JOBS is off. Real-time
    // updates arrive via the payout.* webhook in stripe-webhook.js.

    // Service report PDF jobs are best-effort customer-document work. Keep
    // the worker in-process so the single Railway web dyno drains retry jobs
    // created by completion, email, or public PDF requests.
    {
      const runPdfQueue = async () => {
        try {
          const { processDuePdfRenderJobs } = require('./services/service-report/pdf-queue');
          const summary = await processDuePdfRenderJobs();
          if (summary.claimed || summary.recovered) {
            logger.info(`[service-report-pdf-queue] processed ${summary.claimed} job(s): ${summary.succeeded} succeeded, ${summary.requeued} requeued, ${summary.failed} failed, ${summary.recovered} recovered`);
          }
        } catch (err) {
          logger.error(`[service-report-pdf-queue] processor failed: ${err.message}`);
        }
      };
      setTimeout(runPdfQueue, 30 * 1000).unref();
      setInterval(runPdfQueue, 60 * 1000).unref();
    }

    {
      const runReceiptDeliveryQueue = async () => {
        try {
          const { processDueReceiptDeliveryJobs } = require('./services/receipt-delivery-queue');
          const summary = await processDueReceiptDeliveryJobs({ limit: 10 });
          if (summary.claimed || summary.recovered) {
            logger.info(`[receipt-delivery-queue] processed ${summary.claimed} job(s): ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.recovered} recovered`);
          }
        } catch (err) {
          logger.error(`[receipt-delivery-queue] processor failed: ${err.message}`);
        }
      };
      setTimeout(runReceiptDeliveryQueue, 30 * 1000).unref();
      setInterval(runReceiptDeliveryQueue, 60 * 1000).unref();
    }

    // Call recordings are processed by the every-5-minute scheduler.js
    // cron (recoverMissingRecentRecordings + processAllPending). Running
    // this interval alongside it duplicated the work (harmless only
    // thanks to the processor's token-fenced claims), so it now runs
    // ONLY as the fallback when the cron fleet is gated off — recordings
    // must still get processed in environments without GATE_CRON_JOBS.
    {
      const { isEnabled } = require('./config/feature-gates');
      if (config.nodeEnv !== 'test' && !isEnabled('cronJobs')) {
        setInterval(async () => {
          try {
            const processor = require('./services/call-recording-processor');
            if (processor.recoverMissingRecentRecordings) await processor.recoverMissingRecentRecordings();
            const result = await processor.processAllPending();
            if (result.processed > 0) {
              logger.info(`[call-proc-cron] Processed ${result.processed} pending recording(s)`);
            }
          } catch (err) {
            logger.error(`[call-proc-cron] Failed: ${err.message}`);
          }
        }, 10 * 60 * 1000).unref();
      }
    }

    // Log memory every 5 minutes to catch leaks / OOM before SIGTERM
    setInterval(() => {
      const m = process.memoryUsage();
      logger.info(`[mem] RSS: ${Math.round(m.rss/1024/1024)}MB | Heap: ${Math.round(m.heapUsed/1024/1024)}/${Math.round(m.heapTotal/1024/1024)}MB`);
    }, 5 * 60 * 1000);

    // Weekly: recompute all assessment analytics (product efficacy, protocol
    // performance, benchmarks, contradictions). Sunday 4 AM ET via node-cron —
    // the old setInterval(7 days) reset on every boot, and Railway redeploys
    // multiple times daily, so it effectively never fired. Gated like the
    // other automated jobs (GATE_CRON_JOBS) and wrapped in runExclusive so
    // overlapping deploy instances don't double-run.
    {
      const { isEnabled } = require('./config/feature-gates');
      if (config.nodeEnv !== 'test' && isEnabled('cronJobs')) {
        const cron = require('node-cron');
        const { runExclusive } = require('./utils/cron-lock');
        cron.schedule('0 4 * * 0', async () => {
          try {
            await runExclusive('assessment-analytics-weekly', async () => {
              const analytics = require('./services/assessment-analytics');
              const results = await analytics.runAll();
              logger.info(`[cron] Weekly assessment analytics complete: ${JSON.stringify(results)}`);
            });
          } catch (err) {
            logger.error(`[cron] Weekly assessment analytics failed: ${err.message}`);
          }
        }, { timezone: 'America/New_York' });
      }
    }
  })();
});

// Graceful shutdown — Railway sends SIGTERM ~30s before forced kill on
// deploy. Drain Socket.io connections first (clients see a clean
// disconnect with reason='server shutting down' rather than a transport
// error), then close the HTTP listener so in-flight requests finish.
function shutdown(signal) {
  logger.info(`[shutdown] ${signal} received, draining sockets + closing server`);
  io.close(() => {
    logger.info('[shutdown] Socket.io closed');
    httpServer.close(async () => {
      logger.info('[shutdown] HTTP server closed, exiting');
      try {
        const db = require('./models/db');
        await Promise.race([
          db.destroy(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        logger.info('[shutdown] DB pool closed');
      } catch (err) {
        logger.warn(`[shutdown] DB pool close skipped/failed: ${err.message}`);
      }
      process.exit(0);
    });
  });
  // Hard exit safety net if close() hangs (Railway will kill us at 30s
  // anyway; this just makes the exit reason cleaner).
  setTimeout(() => {
    logger.warn('[shutdown] forced exit after 25s');
    process.exit(1);
  }, 25000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
