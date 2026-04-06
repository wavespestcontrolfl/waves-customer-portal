const cron = require('node-cron');
const db = require('../models/db');
const TwilioService = require('./twilio');
const SquareService = require('./square');
const logger = require('./logger');

function initScheduledJobs() {
  const { isEnabled, logGateStatus } = require('../config/feature-gates');
  logGateStatus();

  if (!isEnabled('cronJobs')) {
    logger.info('[feature-gates] Cron jobs DISABLED — skipping all scheduled tasks');
    return;
  }
  // =========================================================================
  // SEO COMMAND CENTER CRONS (gated behind GATE_SEO_INTELLIGENCE)
  // =========================================================================

  // DAILY 2AM — Rank tracking (priority 1 daily, all on Sunday)
  cron.schedule('0 2 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: SEO rank tracking');
    try {
      const RankTracker = require('./seo/rank-tracker');
      await RankTracker.trackRanks();
    } catch (err) { logger.error(`Rank tracking failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 2:30AM — AI Overview check (top 20 keywords)
  cron.schedule('30 2 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: AI Overview tracking');
    try {
      const AIOverviewTracker = require('./seo/ai-overview-tracker');
      await AIOverviewTracker.trackDaily();
    } catch (err) { logger.error(`AI Overview tracking failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY SUNDAY 3:30AM — Backlink scan
  cron.schedule('30 3 * * 0', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Backlink scan');
    try {
      const BacklinkMonitor = require('./seo/backlink-monitor');
      await BacklinkMonitor.scan();
    } catch (err) { logger.error(`Backlink scan failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 1:30AM — Full site technical audit
  cron.schedule('30 1 * * 1', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Site-wide technical audit');
    try {
      const SiteAuditor = require('./seo/site-auditor');
      await SiteAuditor.runSiteAudit();
    } catch (err) { logger.error(`Site audit failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 5:30AM — Content decay check
  cron.schedule('30 5 * * 1', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Content decay detection');
    try {
      const ContentDecay = require('./seo/content-decay');
      await ContentDecay.detect();
      const Cannibalization = require('./seo/cannibalization');
      await Cannibalization.detect();
    } catch (err) { logger.error(`Content decay/cannibalization failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 30 MIN — Appointment reminders (72h, 24h, 1h) from DB + Google Calendar
  // Replaces Zapier zaps #12, #13, #20
  // =========================================================================
  cron.schedule('*/30 * * * *', async () => {
    logger.info('Running: appointment reminder check');
    try {
      const AppointmentReminders = require('./appointment-reminders');
      const result = await AppointmentReminders.checkAll();
      if (result.sent > 0) logger.info(`Appointment reminders: ${result.sent} sent, ${result.skipped} skipped`);
    } catch (err) {
      logger.error(`Appointment reminder check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY HOUR — Sync Square + Google Calendar into Schedule & Dispatch
  // =========================================================================
  cron.schedule('0 * * * *', async () => {
    try {
      const CalendarSync = require('./calendar-sync');
      const result = await CalendarSync.syncAll(14);
      const sq = result.square, gc = result.google;
      if (sq.created > 0 || gc.created > 0) {
        logger.info(`Calendar sync: Square ${sq.created} new, Google ${gc.created} new`);
      }
    } catch (err) {
      logger.error(`Calendar sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Check for new appointments + WDO inspections
  // Replaces Zapier zaps #21, #22
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      const AppointmentReminders = require('./appointment-reminders');
      const result = await AppointmentReminders.checkNewAppointments();
      if (result.confirmations > 0 || result.wdoPreps > 0) {
        logger.info(`New appointments: ${result.confirmations} confirmations, ${result.wdoPreps} WDO preps`);
      }
    } catch (err) {
      logger.error(`New appointment check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10AM (weekdays) — 7-Day Late Payment SMS (#24)
  // Checks Square for unpaid invoices 7+ days overdue, sends reminder SMS
  // =========================================================================
  cron.schedule('0 10 * * 1-5', async () => {
    logger.info('Running: late payment check');
    try {
      const LatePaymentService = require('./late-payment-checker');
      const result = await LatePaymentService.checkAndNotify();
      logger.info(`Late payment check done: ${result.notified} reminder(s) sent, ${result.skipped} skipped`);
    } catch (err) {
      logger.error(`Late payment check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // 1ST OF MONTH 6AM — Process monthly autopay charges
  // =========================================================================
  cron.schedule('0 6 1 * *', async () => {
    logger.info('Running: monthly billing job');
    try {
      const activeCustomers = await db('customers')
        .where({ active: true })
        .whereNotNull('monthly_rate')
        .where('monthly_rate', '>', 0)
        .select('id', 'first_name', 'last_name', 'waveguard_tier');

      let successCount = 0;
      let failCount = 0;

      for (const customer of activeCustomers) {
        try {
          await SquareService.chargeMonthly(customer.id);
          successCount++;
        } catch (err) {
          failCount++;
          logger.error(`Monthly charge failed for ${customer.first_name} ${customer.last_name}: ${err.message}`);
          // TODO: Send failed payment notification, retry logic
        }
      }

      logger.info(`Monthly billing complete: ${successCount} succeeded, ${failCount} failed`);
    } catch (err) {
      logger.error(`Monthly billing job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 HOURS — Estimate follow-up SMS (unviewed, viewed-not-accepted, expiring)
  // =========================================================================
  cron.schedule('0 */2 * * *', async () => {
    try {
      const EstimateFollowUp = require('./estimate-follow-up');
      const result = await EstimateFollowUp.checkAll();
      if (result.sent > 0) logger.info(`Estimate follow-ups: ${result.sent} sent`);
    } catch (err) {
      logger.error(`Estimate follow-up job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // SUNDAY 7AM — Weekly Tax Advisor report
  // =========================================================================
  cron.schedule('0 7 * * 0', async () => {
    try {
      const TaxAdvisor = require('./tax-advisor');
      const advisor = new TaxAdvisor();
      await advisor.generateWeeklyReport();
      logger.info('Tax Advisor weekly report generated');
    } catch (err) {
      logger.error(`Tax Advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 2AM — Recalculate customer health scores
  // =========================================================================
  cron.schedule('0 2 * * *', async () => {
    try {
      const { calculateAllHealthScores } = require('./customer-health-v2');
      const result = await calculateAllHealthScores();
      logger.info(`Health scores updated: ${result.updated} customers`);
    } catch (err) {
      logger.error(`Health score update failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // 28TH OF MONTH 10AM — Send billing reminders (for customers who opted in)
  // =========================================================================
  cron.schedule('0 10 28 * *', async () => {
    logger.info('Running: billing reminder job');
    try {
      const customers = await db('customers')
        .join('notification_prefs', 'customers.id', 'notification_prefs.customer_id')
        .where({ 'customers.active': true, 'notification_prefs.billing_reminder': true })
        .whereNotNull('customers.monthly_rate')
        .select('customers.id', 'customers.monthly_rate', 'customers.first_name');

      for (const cust of customers) {
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        const chargeDate = `${nextMonth.toLocaleDateString('en-US', { month: 'long' })} 1`;

        try {
          await TwilioService.sendBillingReminder(cust.id, cust.monthly_rate, chargeDate);
        } catch (err) {
          logger.error(`Billing reminder failed for ${cust.id}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Billing reminder job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Process scheduled content (blog + social auto-publish)
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      const ContentScheduler = require('./content-scheduler');
      const result = await ContentScheduler.processScheduledPosts();
      if (result.blogCount > 0 || result.socialCount > 0) {
        logger.info(`Content scheduler: ${result.blogCount} blog(s), ${result.socialCount} social post(s) published`);
      }
    } catch (err) {
      logger.error(`Content scheduler failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 4 HOURS — Check RSS feed for new blog posts → auto-post to social
  // =========================================================================
  cron.schedule('0 */4 * * *', async () => {
    logger.info('Running: RSS social media check');
    try {
      const SocialMediaService = require('./social-media');
      const result = await SocialMediaService.checkAndPublish();
      logger.info(`RSS social media check done: ${result.processed} new post(s) published`);
    } catch (err) {
      logger.error(`RSS social media check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 HOURS — Adjust ad budgets based on capacity
  // =========================================================================
  cron.schedule('0 */2 * * *', async () => {
    logger.info('Running: ad budget adjustment');
    try {
      const BudgetManager = require('./ads/budget-manager');
      await BudgetManager.adjustBudgets();
    } catch (err) {
      logger.error(`Ad budget adjustment failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 3AM — Customer Intelligence Pipeline
  // =========================================================================
  cron.schedule('0 3 * * *', async () => {
    logger.info('Running: customer intelligence pipeline');
    try {
      const SignalDetector = require('./customer-intelligence/signal-detector');
      const HealthScorer = require('./customer-intelligence/health-scorer');
      const RetentionEngine = require('./customer-intelligence/retention-engine');

      // Step 1: Detect signals
      const signalResult = await SignalDetector.detectAllSignals();
      logger.info(`Signals: ${signalResult.newSignals} new from ${signalResult.customersScanned} customers`);

      // Step 2: Score health
      const healthResult = await HealthScorer.calculateAllHealthScores();
      logger.info(`Health: ${healthResult.atRisk} at-risk, ${healthResult.critical} critical`);

      // Step 3: Generate retention outreach for at-risk customers
      const today = new Date().toISOString().split('T')[0];
      const atRisk = await db('customer_health_scores')
        .where('score_date', today)
        .whereIn('churn_risk_level', ['at_risk', 'critical'])
        .select('customer_id');

      let outreachGenerated = 0;
      for (const c of atRisk) {
        const result = await RetentionEngine.generateRetentionOutreach(c.customer_id);
        if (result) outreachGenerated++;
      }

      logger.info(`Customer intelligence complete: ${outreachGenerated} outreach generated`);
    } catch (err) {
      logger.error(`Customer intelligence pipeline failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY — Verify CSR follow-up tasks
  // =========================================================================
  cron.schedule('30 * * * *', async () => {
    logger.info('Running: follow-up task verification');
    try {
      const CSRCoach = require('./csr/csr-coach');
      await CSRCoach.verifyFollowUps();
    } catch (err) {
      logger.error(`Follow-up verification failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // FRIDAY 8AM — Weekly CSR team recommendation
  // =========================================================================
  cron.schedule('0 8 * * 5', async () => {
    logger.info('Running: weekly CSR recommendation');
    try {
      const CSRCoach = require('./csr/csr-coach');
      const rec = await CSRCoach.generateWeeklyTeamRecommendation();
      if (rec.recommendation && TwilioService && process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📊 Weekly CSR Tip:\n\n${rec.recommendation}\n\n${rec.dataPoint}\n${rec.estimatedImpact}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.error(`Weekly CSR rec failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4AM — Sync WordPress posts
  // =========================================================================
  cron.schedule('0 4 * * *', async () => {
    logger.info('Running: WordPress sync');
    try {
      const WordPressSync = require('./content/wordpress-sync');
      await WordPressSync.syncAllPosts();
    } catch (err) {
      logger.error(`WordPress sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5AM — Auto-generate next blog post content
  // =========================================================================
  cron.schedule('0 5 * * *', async () => {
    logger.info('Running: blog post auto-generation');
    try {
      const BlogWriter = require('./content/blog-writer');
      const nextPost = await db('blog_posts')
        .where('status', 'queued')
        .whereNull('content')
        .orderBy('publish_date', 'asc')
        .first();

      if (nextPost) {
        await BlogWriter.generatePost(nextPost.id);
        logger.info(`Blog auto-generated: "${nextPost.title}"`);
      }
    } catch (err) {
      logger.error(`Blog auto-generation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 6AM — Full blog content audit
  // =========================================================================
  cron.schedule('0 6 * * 0', async () => {
    logger.info('Running: blog content audit');
    try {
      const BlogAuditor = require('./content/blog-auditor');
      const audit = await BlogAuditor.runFullAudit();
      await db('ai_audits').insert({
        audit_type: 'blog_content',
        audit_date: new Date(),
        report_data: JSON.stringify(audit),
        recommendation_count: audit.recommendations?.length || 0,
        critical_issues: audit.duplicates?.length || 0,
        status: 'completed',
      });
    } catch (err) {
      logger.error(`Blog audit failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // MONTHLY 1ST 6AM — Generate 20 new blog post ideas
  // =========================================================================
  cron.schedule('0 6 1 * *', async () => {
    logger.info('Running: blog idea generation');
    try {
      const BlogWriter = require('./content/blog-writer');
      const ideas = await BlogWriter.generateNewIdeas(20);
      logger.info(`Generated ${ideas.length} new blog post ideas`);
    } catch (err) {
      logger.error(`Blog idea generation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM — Sync Google Search Console data
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    logger.info('Running: GSC data sync');
    try {
      const SearchConsole = require('./seo/search-console');
      await SearchConsole.syncDailyData(3);
    } catch (err) {
      logger.error(`GSC sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 8AM — AI Campaign Advisor (includes paid + organic)
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: AI campaign advisor');
    try {
      const CampaignAdvisor = require('./ads/campaign-advisor');
      await CampaignAdvisor.generateDailyAdvice();
    } catch (err) {
      logger.error(`AI campaign advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 7AM — SEO Advisor (deep GSC + GBP analysis)
  // =========================================================================
  cron.schedule('0 7 * * 1', async () => {
    logger.info('Running: Weekly SEO Advisor');
    try {
      const SEOAdvisor = require('./seo/seo-advisor');
      await SEOAdvisor.generateWeeklyReport();
    } catch (err) {
      logger.error(`SEO Advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  logger.info('Scheduled jobs initialized');
}

module.exports = { initScheduledJobs };
