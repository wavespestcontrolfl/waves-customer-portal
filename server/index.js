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
const { initScheduledJobs } = require('./services/scheduler');

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
const referralRoutes = require('./routes/referrals-v2');
const promotionRoutes = require('./routes/promotions');
const documentRoutes = require('./routes/documents');
const badgeRoutes = require('./routes/badges');
const trackingRoutes = require('./routes/tracking');
const onboardingRoutes = require('./routes/onboarding');
const adminAuthRoutes = require('./routes/admin-auth');
const adminPushRoutes = require('./routes/admin-push');
const adminCustomerRoutes = require('./routes/admin-customers');
const adminDashboardRoutes = require('./routes/admin-dashboard');
const adminEstimateRoutes = require('./routes/admin-estimates');
const adminPropertyLookupRoutes = require('./routes/admin-property-lookup');
const estimatePublicRoutes = require('./routes/estimate-public');
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
const twilioWebhookRoutes = require('./routes/twilio-webhook');
const reportsPublicRoutes = require('./routes/reports-public');
const adminInventoryRoutes = require('./routes/admin-inventory');
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
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://maps.googleapis.com", "https://js.stripe.com"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: ["'self'", "https:", "data:", "blob:"],
  connectSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://maps.googleapis.com", "https://api.dataforseo.com", "https://fawn.ifas.ufl.edu", "https://api.rentcast.io", "https://generativelanguage.googleapis.com", "https://www.googleapis.com", "https://api.stripe.com"],
  frameSrc: ["'self'", "https://www.google.com", "https://js.stripe.com", "https://hooks.stripe.com"],
  mediaSrc: ["'self'", "https:"],
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

// CORS — allow frontend dev server and production domain
app.use(cors({
  origin: [
    config.clientUrl,
    'https://portal.wavespestcontrol.com',
    'https://wavespestcontrol.com',
    'https://www.wavespestcontrol.com',
  ],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { error: 'Too many requests, please try again later.' },
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

// Body parsing
// Stripe webhook must use raw body for signature verification — mount BEFORE json parser
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripe-webhook'));
// SendGrid event webhook verifies an ECDSA signature over the raw body — same reason, mount BEFORE json parser.
// The route attaches its own express.raw() so it only consumes the raw body for its own path.
app.use('/api/webhooks/sendgrid', require('./routes/webhooks-sendgrid'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// =========================================================================
// API ROUTES
// =========================================================================

app.use('/api/auth', authRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/bouncie', bouncieRoutes);
app.use('/api/lawn-health', lawnHealthRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/satisfaction', satisfactionRoutes);
app.use('/api/property', propertyRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/r', require('./routes/referral-links'));
app.use('/l', require('./routes/public-shortlinks'));
app.use('/api/promotions', promotionRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/badges', badgeRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/push', adminPushRoutes);
app.use('/api/admin/intelligence-bar', adminIntelligenceBarRoutes);
app.use('/api/admin/tool-health', toolHealthRoutes);
app.use('/api/admin/customers/intelligence', adminCustomerIntelRoutes);
app.use('/api/admin/customers', adminCustomerRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/feature-flags', require('./routes/admin-feature-flags'));
app.use('/api/admin/estimates', adminEstimateRoutes);
app.use('/api/admin/lookup', adminPropertyLookupRoutes);
app.use('/api/estimates', estimatePublicRoutes);
app.use('/api/public/quote', publicQuoteRoutes);
app.use('/api/public/estimator', publicPropertyLookupRoutes);
app.use('/api/admin/reviews', adminReviewRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/backlink-agent', adminBacklinkAgentRoutes);
app.use('/api/admin/import', adminImportRoutes);
app.use('/api/admin/estimator', propertyLookupV2Routes);
app.use('/api/admin/referrals', adminReferralRoutes);
app.use('/api/reviews', reviewsPublicRoutes);
app.use('/api/admin/dispatch', adminDispatchRoutes);
app.use('/api/stripe/terminal', require('./routes/stripe-terminal'));
app.use('/api/admin/communications', adminCommsRoutes);
app.use('/api/admin/newsletter', require('./routes/admin-newsletter'));
app.use('/api/public/newsletter', require('./routes/public-newsletter'));
app.use('/api/public/service-areas', require('./routes/public-service-areas'));
// twilio-webhook.js handles /sms + /status; twilio-voice-webhook.js handles /voice, /call-complete,
// /recording-status, /transcription, /outbound-admin-prompt — no path conflicts under same mount.
app.use('/api/webhooks/twilio', twilioWebhookRoutes);
app.use('/api/webhooks/lead', require('./routes/lead-webhook'));
app.use('/api/leads', require('./routes/lead-webhook'));
app.use('/api/reports', reportsPublicRoutes);
app.use('/api/admin/inventory', adminInventoryRoutes);
app.use('/api/admin/compliance', adminComplianceRoutes);
app.use('/api/admin/workflows', adminWorkflowRoutes);
app.use('/api/admin/ads', adminAdsRoutes);
app.use('/api/admin/seo', adminSeoRoutes);
app.use('/api/admin/content', adminContentRoutes);
app.use('/api/admin/knowledge', adminKnowledgeRoutes);
app.use('/api/admin/csr', adminCsrRoutes);
app.use('/api/tech/knowledge', techKnowledgeRoutes);
app.use('/api/dispatch', require('./middleware/admin-auth').adminAuthenticate, require('./middleware/admin-auth').requireTechOrAdmin, dispatchRoutes);
app.use('/api/knowledge', require('./middleware/admin-auth').adminAuthenticate, require('./middleware/admin-auth').requireTechOrAdmin, dispatchKnowledgeRoutes);
app.use('/api/booking', require('./routes/booking'));
app.use('/api/ai', aiAssistantRoutes);
app.use('/api/webhooks/twilio', twilioVoiceWebhookRoutes);
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
app.use('/api/admin/drafts', require('./routes/admin-drafts'));
app.use('/api/admin/gbp', require('./routes/admin-gbp'));
app.use('/api/admin/email-automations', require('./routes/admin-email-automations'));
app.use('/api/admin/social-media', require('./routes/admin-social-media'));
app.use('/api/admin/call-recordings', require('./routes/admin-call-recordings'));

app.use('/api/admin/invoices', require('./routes/admin-invoices'));
app.use('/api/admin/job-forms', require('./routes/admin-job-forms'));
app.use('/api/admin/job-costs', require('./routes/admin-job-costs'));
app.use('/api/admin/job-expenses', require('./routes/admin-job-expenses'));
app.use('/api/pay', require('./routes/pay-v2'));
app.use('/api/rate', require('./routes/review-gate'));
app.use('/api/admin/tax', require('./routes/admin-tax'));
app.use('/api/admin/pricing', require('./routes/admin-pricing-strategy'));
app.use('/api/admin/lawn-assessment', require('./routes/admin-lawn-assessment'));
app.use('/api/admin/knowledge-bridge', require('./routes/admin-knowledge-bridge'));
app.use('/api/admin/assessment-analytics', require('./routes/admin-assessment-analytics'));
app.use('/api/admin/equipment', require('./routes/admin-equipment'));
// WordPress fleet removed — content now publishes to wavespestcontrol.com Astro site
app.use('/api/admin/analytics', require('./routes/admin-analytics'));
app.use('/api/admin/token-health', require('./routes/admin-token-health'));
app.use('/api/admin/kb', require('./routes/admin-kb'));
app.use('/api/admin/notifications', require('./routes/admin-notifications'));
app.use('/api/customer-notifications', require('./routes/customer-notifications'));
app.use('/api/billing/autopay', require('./routes/customer-autopay'));
app.use('/api/admin', require('./routes/admin-billing-health'));
app.use('/api/admin/payments', require('./routes/admin-payments-reconcile'));
app.use('/api/review', reviewPublicRoutes);
app.use('/api/admin/review-requests', adminReviewRequestRoutes);
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
app.use('/api/admin/pricing-proposals', require('./routes/admin-pricing-proposals'));
app.use('/api/admin/analytics', require('./routes/admin-analytics'));
app.use('/api/tech/field-lead', require('./routes/tech-field-lead'));
app.use('/api/notification-prefs', require('./routes/notification-prefs'));
app.use('/api/bouncie', require('./routes/bouncie-webhook'));
app.use('/api/tech/notifications', require('./routes/tech-notifications'));
app.use('/api/admin/geofence', require('./routes/admin-geofence'));
app.use('/api/newsletter', require('./routes/newsletter'));

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

  // Never cache sw.js or index.html — ensures deploys are picked up immediately
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Service-Worker-Allowed', '/');
    res.sendFile(path.join(clientBuild, 'sw.js'));
  });
  app.get('/', (req, res, next) => {
    if (req.accepts('html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(path.join(clientBuild, 'index.html'));
    }
    next();
  });

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

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(clientBuild, 'index.html'));
    }
  });
}

// =========================================================================
// VOICE AGENT — register Express routes BEFORE error handlers
// (WebSocket setup happens after app.listen below)
// =========================================================================
const voiceAgentModule = (() => {
  try { return require('./routes/voice-agent'); } catch { return null; }
})();
if (voiceAgentModule) {
  // Register just the Express routes (TwiML + admin API) now
  // The WebSocket server is attached after app.listen()
  voiceAgentModule.registerExpressRoutes?.(app) || voiceAgentModule(app, null);
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

// Start listening FIRST (so Railway health check passes), then run migrations
const server = app.listen(PORT, () => {
  // Attach WebSocket server for voice agent (needs HTTP server)
  if (voiceAgentModule) {
    try {
      const { WebSocketServer } = require('ws');
      const { handleVoiceWebSocket, initVoiceAgent } = require('./services/voice-agent/agent');
      const wss = new WebSocketServer({ server, path: '/ws/voice-agent' });
      wss.on('connection', (ws, req) => { console.log('[VoiceAgent] WebSocket connected'); handleVoiceWebSocket(ws, req); });
      initVoiceAgent();
      logger.info('Voice Agent WebSocket registered');
    } catch (err) {
      logger.warn(`Voice Agent WebSocket setup skipped: ${err.message}`);
    }
  }
  const mem = process.memoryUsage();
  logger.info(`Waves API running on port ${PORT} | RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB`);
  logger.info(`   Environment: ${config.nodeEnv} | Client: ${config.clientUrl}`);

  // Run migrations in the background after the server is accepting requests
  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || process.env.POSTGRES_URL;
  logger.info(`Database: ${dbUrl ? dbUrl.replace(/:[^:@]+@/, ':***@').substring(0, 60) + '...' : 'NOT SET'}`);

  (async () => {
    try {
      const knex = require('./models/db');
      logger.info('Running database migrations...');
      const migConfig = { directory: path.join(__dirname, 'models', 'migrations') };

      // Wrap migrations in a timeout so they don't block startup forever
      const migrationPromise = (async () => {
        let migrationAttempts = 0;
        const maxSkips = 15;
        while (migrationAttempts < maxSkips) {
          try {
            await knex.migrate.latest(migConfig);
            logger.info('Migrations complete');
            return;
          } catch (migErr) {
            migrationAttempts++;
            const msg = migErr.message || '';
            if (msg.includes('already exists') || msg.includes('duplicate key') || msg.includes('current transaction is aborted')) {
              logger.warn(`Migration ${migrationAttempts} skip: ${msg.substring(0, 100)}`);
              try {
                const [, pending] = await knex.migrate.list(migConfig);
                if (!pending.length) { logger.info('No more pending migrations'); return; }
                const f = pending[0]; const migName = typeof f === 'string' ? f : (f.file || f.name);
                await knex('knex_migrations').insert({
                  name: migName,
                  batch: ((await knex('knex_migrations').max('batch as b').first())?.b || 0) + 1,
                  migration_time: new Date(),
                }).catch(() => {});
              } catch (e) { logger.error(`Skip failed: ${e.message?.substring(0, 80)}`); return; }
            } else {
              logger.error(`Migration failed: ${msg.substring(0, 150)}`);
              return;
            }
          }
        }
      })();

      // Don't let migrations block startup for more than 30s
      await Promise.race([
        migrationPromise,
        new Promise(resolve => setTimeout(() => { logger.warn('Migration timeout (30s) — continuing startup'); resolve(); }, 30000)),
      ]);
    } catch (err) {
      logger.error(`Migration setup failed: ${err.message}`);
    }

    if (config.nodeEnv !== 'test') {
      initScheduledJobs();
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

    // Sync Stripe payouts every 15 minutes
    setInterval(async () => {
      try {
        const StripeBanking = require('./services/stripe-banking');
        const result = await StripeBanking.syncPayouts(20);
        if (result.synced > 0) {
          logger.info(`[stripe-banking] Synced ${result.synced} new payouts`);
        }
      } catch (err) {
        logger.error(`[stripe-banking] Sync failed: ${err.message}`);
      }
    }, 15 * 60 * 1000);

    // Process unprocessed call recordings every 10 minutes (safety net)
    setInterval(async () => {
      try {
        const processor = require('./services/call-recording-processor');
        const result = await processor.processAllPending();
        if (result.processed > 0) {
          logger.info(`[call-proc-cron] Processed ${result.processed} pending recording(s)`);
        }
      } catch (err) {
        logger.error(`[call-proc-cron] Failed: ${err.message}`);
      }
    }, 10 * 60 * 1000);

    // Log memory every 5 minutes to catch leaks / OOM before SIGTERM
    setInterval(() => {
      const m = process.memoryUsage();
      logger.info(`[mem] RSS: ${Math.round(m.rss/1024/1024)}MB | Heap: ${Math.round(m.heapUsed/1024/1024)}/${Math.round(m.heapTotal/1024/1024)}MB`);
    }, 5 * 60 * 1000);

    // Weekly: recompute all assessment analytics (product efficacy, protocol performance, benchmarks, contradictions)
    setInterval(async () => {
      try {
        const analytics = require('./services/assessment-analytics');
        const results = await analytics.runAll();
        logger.info(`[cron] Weekly assessment analytics complete: ${JSON.stringify(results)}`);
      } catch (err) {
        logger.error(`[cron] Weekly assessment analytics failed: ${err.message}`);
      }
    }, 7 * 24 * 60 * 60 * 1000); // 7 days
  })();
});

module.exports = app;
