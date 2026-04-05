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
const billingRoutes = require('./routes/billing');
const notificationRoutes = require('./routes/notifications');
const requestRoutes = require('./routes/requests');
const bouncieRoutes = require('./routes/bouncie');
const lawnHealthRoutes = require('./routes/lawn-health');
const feedRoutes = require('./routes/feed');
const satisfactionRoutes = require('./routes/satisfaction');
const propertyRoutes = require('./routes/property');
const referralRoutes = require('./routes/referrals');
const promotionRoutes = require('./routes/promotions');
const documentRoutes = require('./routes/documents');
const badgeRoutes = require('./routes/badges');
const trackingRoutes = require('./routes/tracking');
const onboardingRoutes = require('./routes/onboarding');
const adminAuthRoutes = require('./routes/admin-auth');
const adminCustomerRoutes = require('./routes/admin-customers');
const adminDashboardRoutes = require('./routes/admin-dashboard');
const adminEstimateRoutes = require('./routes/admin-estimates');
const adminPropertyLookupRoutes = require('./routes/admin-property-lookup');
const estimatePublicRoutes = require('./routes/estimate-public');
const adminReviewRoutes = require('./routes/admin-reviews');
const adminSettingsRoutes = require('./routes/admin-settings');
const adminBacklinkAgentRoutes = require('./routes/admin-backlink-agent');
const adminImportRoutes = require('./routes/admin-import-sheets');
const propertyLookupV2Routes = require('./routes/property-lookup-v2');
const adminReferralRoutes = require('./routes/admin-referrals');
const reviewsPublicRoutes = require('./routes/reviews-public');
const adminDispatchRoutes = require('./routes/admin-dispatch');
const adminCommsRoutes = require('./routes/admin-communications');
const twilioWebhookRoutes = require('./routes/twilio-webhook');
const reportsPublicRoutes = require('./routes/reports-public');
const adminInventoryRoutes = require('./routes/admin-inventory');
const adminComplianceRoutes = require('./routes/admin-compliance');
const adminWorkflowRoutes = require('./routes/admin-workflows');
const adminAdsRoutes = require('./routes/admin-ads');
const adminSeoRoutes = require('./routes/admin-seo');
const adminContentRoutes = require('./routes/admin-content');
const adminKnowledgeRoutes = require('./routes/admin-knowledge');
const adminCsrRoutes = require('./routes/admin-csr');
const adminCustomerIntelRoutes = require('./routes/admin-customer-intel');
const techKnowledgeRoutes = require('./routes/tech-knowledge');
const dispatchRoutes = require('./routes/dispatch');
const dispatchKnowledgeRoutes = require('./routes/knowledge');
const aiAssistantRoutes = require('./routes/ai-assistant');
const twilioVoiceWebhookRoutes = require('./routes/twilio-voice-webhook');

const app = express();

// =========================================================================
// MIDDLEWARE
// =========================================================================

// Security headers — CSP allows Google Fonts, APIs, and inline styles
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://maps.googleapis.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "https:", "data:", "blob:"],
      connectSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://maps.googleapis.com", "https://api.dataforseo.com", "https://fawn.ifas.ufl.edu", "https://api.rentcast.io", "https://generativelanguage.googleapis.com", "https://www.googleapis.com"],
      frameSrc: ["'self'", "https://www.google.com"],
      mediaSrc: ["'self'", "https:"],
    },
  },
}));

// CORS — allow frontend dev server and production domain
app.use(cors({
  origin: [
    config.clientUrl,
    'https://portal.wavespestcontrol.com',
    'https://wavespestcontrol.com',
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
app.use('/api/promotions', promotionRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/badges', badgeRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/customers', adminCustomerRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/estimates', adminEstimateRoutes);
app.use('/api/admin/lookup', adminPropertyLookupRoutes);
app.use('/api/estimates', estimatePublicRoutes);
app.use('/api/admin/reviews', adminReviewRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/backlink-agent', adminBacklinkAgentRoutes);
app.use('/api/admin/import', adminImportRoutes);
app.use('/api/admin/estimator', propertyLookupV2Routes);
app.use('/api/admin/referrals', adminReferralRoutes);
app.use('/api/reviews', reviewsPublicRoutes);
app.use('/api/admin/dispatch', adminDispatchRoutes);
app.use('/api/admin/communications', adminCommsRoutes);
app.use('/api/webhooks/twilio', twilioWebhookRoutes);
app.use('/api/webhooks/lead', require('./routes/lead-webhook'));
app.use('/api/reports', reportsPublicRoutes);
app.use('/api/admin/inventory', adminInventoryRoutes);
app.use('/api/admin/compliance', adminComplianceRoutes);
app.use('/api/admin/workflows', adminWorkflowRoutes);
app.use('/api/admin/ads', adminAdsRoutes);
app.use('/api/admin/seo', adminSeoRoutes);
app.use('/api/admin/content', adminContentRoutes);
app.use('/api/admin/knowledge', adminKnowledgeRoutes);
app.use('/api/admin/csr', adminCsrRoutes);
app.use('/api/admin/customers/intelligence', adminCustomerIntelRoutes);
app.use('/api/tech/knowledge', techKnowledgeRoutes);
app.use('/api/dispatch', require('./middleware/admin-auth').adminAuthenticate, require('./middleware/admin-auth').requireTechOrAdmin, dispatchRoutes);
app.use('/api/knowledge', require('./middleware/admin-auth').adminAuthenticate, require('./middleware/admin-auth').requireTechOrAdmin, dispatchKnowledgeRoutes);
app.use('/api/booking', require('./routes/booking'));
app.use('/api/ai', aiAssistantRoutes);
app.use('/api/webhooks/twilio', twilioVoiceWebhookRoutes);
app.use('/api/webhooks/square', require('./routes/square-webhook'));
app.use('/api/admin/protocols', require('./routes/admin-protocols'));
app.use('/api/admin/revenue', require('./routes/admin-revenue'));
app.use('/api/admin/schedule', require('./routes/admin-schedule'));
app.use('/api/admin/drafts', require('./routes/admin-drafts'));
app.use('/api/admin/gbp', require('./routes/admin-gbp'));

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
  logger.info(`🌊 Waves Customer Portal API running on port ${PORT}`);
  logger.info(`   Environment: ${config.nodeEnv}`);
  logger.info(`   Client URL: ${config.clientUrl}`);

  // Run migrations in the background after the server is accepting requests
  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || process.env.POSTGRES_URL;
  logger.info(`Database: ${dbUrl ? dbUrl.replace(/:[^:@]+@/, ':***@').substring(0, 60) + '...' : 'NOT SET'}`);

  (async () => {
    try {
      const knex = require('./models/db');
      logger.info('Running database migrations...');
      await knex.migrate.latest({ directory: path.join(__dirname, 'models', 'migrations') });
      logger.info('Migrations complete');
    } catch (err) {
      logger.error(`Migration failed: ${err.message}`);
    }

    if (config.nodeEnv !== 'test') {
      initScheduledJobs();
    }
  })();
});

module.exports = app;
