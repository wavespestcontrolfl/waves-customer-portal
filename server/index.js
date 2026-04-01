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

const app = express();

// =========================================================================
// MIDDLEWARE
// =========================================================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'waves-customer-portal',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
  });
});

// =========================================================================
// SERVE FRONTEND (Production)
// =========================================================================

if (config.nodeEnv === 'production') {
  const clientBuild = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientBuild));

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(clientBuild, 'index.html'));
    }
  });
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

app.listen(PORT, () => {
  logger.info(`🌊 Waves Customer Portal API running on port ${PORT}`);
  logger.info(`   Environment: ${config.nodeEnv}`);
  logger.info(`   Client URL: ${config.clientUrl}`);

  // Initialize cron jobs (service reminders, billing, etc.)
  if (config.nodeEnv !== 'test') {
    initScheduledJobs();
  }
});

module.exports = app;
