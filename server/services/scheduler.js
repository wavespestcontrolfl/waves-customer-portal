const cron = require('node-cron');
const db = require('../models/db');
const TwilioService = require('./twilio');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

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

  // WEEKLY MONDAY 5:00AM — BI Briefing Agent (Monday morning SMS to Adam)
  cron.schedule('0 5 * * 1', async () => {
    logger.info('Running: Weekly BI Briefing Agent');
    try {
      const BIAgent = require('./bi-agent');
      await BIAgent.run();
    } catch (err) {
      logger.error(`BI Briefing Agent failed: ${err.message}`);
    }
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
  // DAILY 4AM — Newsletter event ingestion (P3a). Pulls every enabled
  // RSS source from event_sources, upserts into events_raw. Daily cadence
  // (vs weekly with the newsletter draft) so events added 6 days before
  // a Friday send still make it into the dashboard tiles.
  // =========================================================================
  cron.schedule('0 4 * * *', async () => {
    logger.info('Running: Newsletter event ingestion');
    try {
      const EventIngestion = require('./event-ingestion');
      await EventIngestion.ingestAllEnabledSources();
    } catch (err) {
      logger.error(`Event ingestion failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5AM — Newsletter event normalization (P3b leg 3). One hour
  // after ingestion so newly-pulled rows get Claude venue extraction +
  // Google geocoding in the same day. Capped at 50 rows per run so the
  // Claude API spend is bounded (~$1/day).
  // =========================================================================
  cron.schedule('0 5 * * *', async () => {
    logger.info('Running: Newsletter event normalization');
    try {
      const EventNormalizer = require('./event-normalizer');
      await EventNormalizer.normalizeBatch();
    } catch (err) {
      logger.error(`Event normalization failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Newsletter scheduled sends (dispatches any whose scheduled_for
  // has passed). Intentionally high-frequency so "send at 8:00am" fires close
  // to the minute. Per-tick work is a single indexed query on newsletter_sends.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      const NewsletterSender = require('./newsletter-sender');
      await NewsletterSender.processScheduledSends();
    } catch (err) {
      logger.error(`Newsletter scheduler tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Automation runner. Fires the next step of any enrollment
  // whose next_send_at has passed. Indexed query on automation_enrollments.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      const AutomationRunner = require('./automation-runner');
      await AutomationRunner.processDueSteps();
    } catch (err) {
      logger.error(`Automation runner tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Appointment reminders (72h, 24h) from appointment_reminders table
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      const reminders = require('./appointment-reminders');
      await reminders.checkAndSendReminders();
    } catch (err) {
      logger.error(`Reminder check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 MIN — Cloudflare Pages build status for open blog-publish PRs.
  // Updates astro_preview_url once the preview deploy succeeds, or flips
  // the post to build_failed if it blows up.
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      const PagesPoll = require('./content-astro/pages-poll');
      await PagesPoll.pollPending();
    } catch (err) {
      logger.error(`Pages poll failed: ${err.message}`);
    }
  });

  // =========================================================================
  // DAILY 10AM (weekdays) — 7-Day Late Payment SMS
  // Checks invoices 7+ days overdue, sends tiered reminder SMS
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
  // DAILY 10AM (Tue–Fri) — Per-invoice follow-up sequences
  // Fires the next due touch for each unpaid invoice's automated chain.
  // =========================================================================
  cron.schedule('0 10 * * 2-5', async () => {
    logger.info('Running: invoice follow-up sequences');
    try {
      const InvoiceFollowUps = require('./invoice-followups');
      const result = await InvoiceFollowUps.runPending();
      logger.info(`Invoice follow-ups done: ${result.sent} sent, ${result.skipped} skipped`);
    } catch (err) {
      logger.error(`Invoice follow-ups failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Process scheduled SMS sends
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      let scheduled = [];
      try {
        scheduled = await db('sms_log')
          .where({ status: 'scheduled' })
          .where('scheduled_for', '<=', now.toISOString())
          .limit(20);
      } catch { return; /* scheduled_for column may not exist yet */ }

      for (const msg of scheduled) {
        try {
          await TwilioService.sendSMS(msg.to_phone, msg.message_body, {
            customerId: msg.customer_id, messageType: 'scheduled',
          });
          await db('sms_log').where({ id: msg.id }).update({ status: 'sent', created_at: new Date() });
          logger.info(`[scheduled-sms] Sent scheduled SMS to ${msg.to_phone}`);
        } catch (err) {
          await db('sms_log').where({ id: msg.id }).update({ status: 'failed' });
          logger.error(`[scheduled-sms] Failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Scheduled SMS processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MINUTES — Send scheduled estimates whose time has arrived
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const scheduled = await db('estimates')
        .where({ status: 'scheduled' })
        .where('scheduled_at', '<=', new Date())
        .whereNotNull('scheduled_at');

      if (scheduled.length === 0) return;

      const { sendEstimateNow } = require('../routes/admin-estimates');
      for (const est of scheduled) {
        try {
          await sendEstimateNow(est, est.send_method || 'both');
          logger.info(`Scheduled estimate ${est.id} sent to ${est.customer_name}`);
        } catch (e) {
          logger.error(`Scheduled estimate ${est.id} failed: ${e.message}`);
        }
      }
      logger.info(`Scheduled estimates: ${scheduled.length} sent`);
    } catch (err) {
      logger.error(`Scheduled estimate cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 MINUTES — Email sync (Gmail → PostgreSQL)
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      const { syncEmails } = require('./email/email-sync');
      const result = await syncEmails();
      if (result.newEmails > 0) {
        logger.info(`[email-sync] Synced ${result.newEmails} new emails`);
      }
    } catch (err) {
      logger.error(`[email-sync] Cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 7:30 AM — Morning email digest notification
  // =========================================================================
  cron.schedule('30 7 * * *', async () => {
    try {
      const yesterday = new Date(Date.now() - 24 * 3600000);
      yesterday.setHours(0, 0, 0, 0);

      const emails = await db('emails').where('received_at', '>=', yesterday);
      const unread = await db('emails')
        .where({ is_read: false, is_archived: false })
        .count('* as c').first();

      const leads = emails.filter(e => e.auto_action && e.auto_action.includes('lead_created')).length;
      const invoices = emails.filter(e => e.classification === 'vendor_invoice').length;
      const spam = emails.filter(e => e.classification === 'spam').length;
      const invoiceAmounts = emails
        .filter(e => e.classification === 'vendor_invoice' && e.extracted_data)
        .reduce((sum, e) => {
          const data = typeof e.extracted_data === 'string' ? JSON.parse(e.extracted_data) : e.extracted_data;
          return sum + (parseFloat(data.invoice_amount) || 0);
        }, 0);

      const parts = [`${parseInt(unread?.c || 0)} unread`];
      if (leads > 0) parts.push(`${leads} leads created`);
      if (invoices > 0) parts.push(`${invoices} invoice${invoices > 1 ? 's' : ''} ($${invoiceAmounts.toFixed(2)} logged)`);
      if (spam > 0) parts.push(`${spam} spam blocked`);

      await db('notifications').insert({
        recipient_type: 'admin',
        category: 'email_digest',
        title: 'Morning Email Digest',
        body: `${emails.length} emails overnight. ${parts.join(', ')}. Check /admin/email for details.`,
        icon: '\uD83D\uDCE7',
        link: '/admin/email',
        metadata: JSON.stringify({ severity: parseInt(unread?.c || 0) > 10 ? 'high' : 'low' }),
        created_at: new Date(),
      }).catch(() => {});

      logger.info(`[email-digest] Morning digest: ${emails.length} emails, ${leads} leads, ${spam} spam`);
    } catch (err) {
      logger.error(`[email-digest] Cron failed: ${err.message}`);
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
  // EVERY 2 HOURS — Onboarding abandonment SMS (24h / 72h / expiring)
  // =========================================================================
  cron.schedule('15 */2 * * *', async () => {
    try {
      const OnboardingFollowUp = require('./onboarding-follow-up');
      const result = await OnboardingFollowUp.checkAll();
      if (result.sent > 0) logger.info(`Onboarding follow-ups: ${result.sent} sent`);
    } catch (err) {
      logger.error(`Onboarding follow-up job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 9AM — Auto-renew expired estimates once (+7 days)
  // =========================================================================
  cron.schedule('0 9 * * *', async () => {
    try {
      const EstimateAutoRenew = require('./estimate-auto-renew');
      const result = await EstimateAutoRenew.checkAll();
      if (result.renewed > 0) logger.info(`Estimate auto-renew: ${result.renewed} renewed`);
    } catch (err) {
      logger.error(`Estimate auto-renew job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Dashboard alerts — every 5 minutes, detect transitions in operational
  // alerts and fan out Web Push (always) + SMS to owner (critical only).
  // See server/services/dashboard-alerts-cron.js for the diff logic.
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runDashboardAlertsCheck } = require('./dashboard-alerts-cron');
      const result = await runDashboardAlertsCheck();
      if (result.fired > 0 || result.cleared > 0) {
        logger.info(`[dashboard-alerts] fired=${result.fired} cleared=${result.cleared} active=${result.current}`);
      }
    } catch (err) {
      logger.error(`Dashboard alerts cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 8AM — Tax Deadline Alerting (SMS reminders for upcoming filings)
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: tax deadline alert check');
    try {
      const now = new Date();
      const today = etDateString(now);
      const futureDate = etDateString(addETDays(now, 14));

      // Find filings due in the next 14 days that haven't been reminded yet
      const upcomingFilings = await db('tax_filing_calendar')
        .where('due_date', '>=', today)
        .where('due_date', '<=', futureDate)
        .whereNot('status', 'filed')
        .whereNot('status', 'paid')
        .where(function () {
          this.whereNull('reminder_sent_at')
            .orWhere('reminder_sent', false);
        })
        .orderBy('due_date');

      if (upcomingFilings.length === 0) {
        return;
      }

      // Build reminder message
      const lines = upcomingFilings.map(f => {
        const dueDate = new Date(f.due_date);
        const daysUntil = Math.ceil((dueDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        const amountStr = f.amount_due ? ` ($${parseFloat(f.amount_due).toLocaleString()})` : '';
        return `- ${f.title}${amountStr} — due ${dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })} (${daysUntil} day${daysUntil !== 1 ? 's' : ''})`;
      });

      const message = `Tax Deadline Alert:\n\n${lines.join('\n')}\n\nReview in the admin portal.`;

      // Send SMS to admin
      if (process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE, message, { messageType: 'internal_alert' });
        logger.info(`[tax-alerts] Sent ${upcomingFilings.length} deadline reminder(s) via SMS`);
      }

      // Mark reminders as sent
      const ids = upcomingFilings.map(f => f.id);
      await db('tax_filing_calendar')
        .whereIn('id', ids)
        .update({ reminder_sent: true, reminder_sent_at: new Date() });

    } catch (err) {
      logger.error(`Tax deadline alert failed: ${err.message}`);
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
        const chargeDate = `${nextMonth.toLocaleDateString('en-US', { month: 'long', timeZone: 'America/New_York' })} 1`;

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
      const today = etDateString();
      const atRisk = await db('customer_health_scores')
        .where('scored_at', today)
        .whereIn('churn_risk', ['at_risk', 'critical'])
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
  // DAILY 6AM — Google Ads sync (campaigns, performance, search terms)
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    try {
      const googleAds = require('./ads/google-ads');
      if (!googleAds.isConfigured()) return;
      logger.info('Running: Google Ads daily sync');
      await googleAds.syncCampaigns();
      await googleAds.syncDailyPerformance(7);
      await googleAds.syncSearchTerms(30);
      logger.info('Google Ads daily sync complete');
    } catch (err) {
      logger.error(`Google Ads sync failed: ${err.message}`);
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
      try {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GSC', reason: err.message });
      } catch { /* notify best-effort */ }
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Estimate expiration (Estimates v2 spec §5)
  // Flips sent/viewed estimates past ESTIMATE_EXPIRATION_DAYS (default 7) to
  // expired; also flips anything past explicit expires_at.
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    logger.info('Running: Estimate expiration sweep');
    try {
      const { runEstimateExpiration } = require('./estimate-expiration');
      await runEstimateExpiration();
    } catch (err) {
      logger.error(`Estimate expiration sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Credential expiry check (credentials v1 §7)
  // Scans business_credentials for anything expiring within 60 days; fires a
  // `credential_expiring_soon` notification per credential (deduped 7d).
  // =========================================================================
  cron.schedule('5 6 * * *', async () => {
    logger.info('Running: Credential expiry check');
    try {
      const { runCredentialExpiryCheck } = require('./credential-expiry-checker');
      await runCredentialExpiryCheck();
    } catch (err) {
      logger.error(`Credential expiry check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:30AM — Sync Google Business Profile performance metrics
  // =========================================================================
  cron.schedule('30 6 * * *', async () => {
    logger.info('Running: GBP performance sync');
    try {
      const GoogleBusiness = require('./google-business');
      await GoogleBusiness.syncPerformanceDaily(3);
    } catch (err) {
      logger.error(`GBP performance sync failed: ${err.message}`);
      try {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GBP', reason: err.message });
      } catch { /* notify best-effort */ }
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

  // =========================================================================
  // DAILY 7AM — Token / Credential Health Check + SMS alert on failures
  // =========================================================================
  cron.schedule('0 7 * * *', async () => {
    logger.info('Running: token credential health check');
    try {
      const tokenHealth = require('./token-health');
      const results = await tokenHealth.checkAll();
      const failures = results.filter(r => r.status === 'expired' || r.status === 'error');
      if (failures.length > 0) {
        const msg = `⚠️ Token Alert: ${failures.length} credential(s) need attention:\n` +
          failures.map(f => `- ${f.platform}: ${f.status} — ${f.lastError || 'check dashboard'}`).join('\n');
        await TwilioService.sendSMS(process.env.ADAM_PHONE || '+19415993489', msg, { messageType: 'internal_alert', skipLogo: true });
      }
      logger.info(`Token health check done: ${failures.length} failure(s) out of ${results.length}`);
    } catch (err) {
      logger.error(`Token health check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:30AM — Auto-sync Knowledge Base from live data (products, protocols, pricing, COGS)
  // =========================================================================
  cron.schedule('30 3 * * *', async () => {
    logger.info('Running: Knowledge Base auto-sync');
    try {
      const KBService = require('./knowledge-base');
      const result = await KBService.autoSync();
      logger.info(`KB auto-sync done: ${result.created} created, ${result.updated} updated, ${result.skipped} unchanged`);
    } catch (err) {
      logger.error(`KB auto-sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY FRIDAY 7 AM — AI Knowledge Base Audit ("Question Your Assumptions")
  // Reviews stale and low-confidence entries via Claude, flags anything outdated.
  // =========================================================================
  cron.schedule('0 7 * * 5', async () => {
    logger.info('Running: Knowledge Base AI audit');
    try {
      const KBService = require('./knowledge-base');
      const result = await KBService.runAIAudit({ maxEntries: 15 });
      logger.info(`KB AI audit done: ${result.audited} reviewed, ${result.flagged} flagged`);

      // SMS summary if anything was flagged
      if (result.flagged > 0) {
        try {
          const ownerPhone = process.env.OWNER_PHONE || '+19413187612';
          const flaggedTitles = result.results
            .filter(r => r.status === 'flag' || r.status === 'update-needed')
            .map(r => `- ${r.title}: ${r.summary}`)
            .join('\n');
          await TwilioService.sendSMS(ownerPhone,
            `KB Audit: ${result.flagged} entries flagged for review:\n${flaggedTitles}`,
            { messageType: 'internal_alert' }
          );
        } catch { /* Twilio not available */ }
      }
    } catch (err) {
      logger.error(`KB AI audit failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Process any pending call recordings
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const processor = require('./call-recording-processor');
      if (processor.processAllPending) await processor.processAllPending();
    } catch (e) { logger.error(`Recording batch process failed: ${e.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Send scheduled review request SMS
  // Picks up review requests whose scheduled_for has passed.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      const ReviewService = require('./review-request');
      const result = await ReviewService.processScheduled();
      if (result.sent > 0) logger.info(`Review requests processed: ${result.sent} sent`);
    } catch (err) {
      logger.error(`Review request processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:00AM — Review follow-up reminders (Day 3 after initial request)
  // Lands the followup on the 3rd ET-calendar-day after the original review
  // SMS was sent. Eligibility logic is in processFollowups().
  // =========================================================================
  cron.schedule('0 10 * * *', async () => {
    logger.info('Running: review follow-up reminders');
    try {
      const ReviewService = require('./review-request');
      const result = await ReviewService.processFollowups();
      logger.info(`Review follow-ups done: ${result.sent} sent`);
    } catch (err) {
      logger.error(`Review follow-up failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 6AM — Agronomic Wiki refresh (stale pages + seasonal)
  // =========================================================================
  cron.schedule('0 6 * * 0', async () => {
    logger.info('Running: agronomic wiki weekly refresh');
    try {
      const wiki = require('./agronomic-wiki');
      const result = await wiki.weeklyRefresh();
      logger.info(`Agronomic wiki refresh done: ${result.refreshed} pages refreshed`);
    } catch (err) {
      logger.error(`Agronomic wiki refresh failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 2:15AM — Customer Health Scoring v3 (churn prediction engine)
  // =========================================================================
  cron.schedule('15 2 * * *', async () => {
    logger.info('Running: customer health scoring v3');
    try {
      const { scoreAllCustomers } = require('./customer-health');
      const result = await scoreAllCustomers();
      logger.info(`Health scoring v3 complete: ${result.scored} scored, ${result.failed} failed`);
    } catch (err) {
      logger.error(`Health scoring v3 failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY — Process save sequences (churn_save, win_back step advancement)
  // =========================================================================
  cron.schedule('45 * * * *', async () => {
    try {
      const { processSequences } = require('./save-sequences');
      const result = await processSequences();
      if (result.processed > 0) {
        logger.info(`Save sequences processed: ${result.processed} steps, ${result.errors} errors`);
      }
    } catch (err) {
      logger.error(`Save sequence processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 4AM — Cleanup health history older than 365 days
  // =========================================================================
  cron.schedule('0 4 * * 0', async () => {
    logger.info('Running: health history cleanup');
    try {
      const cutoff = etDateString(addETDays(new Date(), -365));
      const deleted = await db('customer_health_history').where('scored_at', '<', cutoff).del();
      logger.info(`Health history cleanup: ${deleted} old records deleted`);
    } catch (err) {
      logger.error(`Health history cleanup failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // TIME TRACKING CRONS (daily summaries, weekly summaries, auto clock-out)
  // =========================================================================
  try {
    const { initTimeTrackingCrons } = require('./time-tracking-crons');
    initTimeTrackingCrons();
    logger.info('Time tracking crons initialized');
  } catch (err) {
    logger.error(`Time tracking crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // EQUIPMENT MAINTENANCE CRONS (nightly checks, warranty alerts)
  // =========================================================================
  try {
    const { initEquipmentCrons } = require('./equipment-crons');
    initEquipmentCrons();
    logger.info('Equipment maintenance crons initialized');
  } catch (err) {
    logger.error(`Equipment crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // STRIPE BILLING — Monthly autopay + payment retries
  // =========================================================================
  cron.schedule('0 8 1 * *', async () => {
    logger.info('Running: monthly billing (Stripe)');
    try {
      const BillingCron = require('./billing-cron');
      const result = await BillingCron.processMonthlyBilling();
      logger.info(`Monthly billing done: ${result.charged} charged, ${result.failed} failed, ${result.skipped} skipped`);
    } catch (err) {
      logger.error(`Monthly billing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  cron.schedule('0 10 * * *', async () => {
    try {
      const BillingCron = require('./billing-cron');
      const result = await BillingCron.processPaymentRetries();
      if (result.retried > 0) logger.info(`Payment retries: ${result.retried} retried, ${result.succeeded} succeeded`);
    } catch (err) {
      logger.error(`Payment retry failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Autopay pre-charge reminders — daily 9 AM, 3 days before scheduled charge
  cron.schedule('0 9 * * *', async () => {
    try {
      const { sendPreChargeReminders } = require('./autopay-notifications');
      const r = await sendPreChargeReminders();
      if (r.sent > 0) logger.info(`Autopay reminders: ${r.sent} sent`);
    } catch (err) {
      logger.error(`Autopay pre-charge reminder failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Card-expiry warnings — Monday 9 AM, cards expiring within 60 days
  cron.schedule('0 9 * * 1', async () => {
    try {
      const { sendCardExpiryWarnings } = require('./autopay-notifications');
      const r = await sendCardExpiryWarnings();
      if (r.sent > 0) logger.info(`Card-expiry warnings: ${r.sent} sent`);
    } catch (err) {
      logger.error(`Card-expiry warnings failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // BOUNCIE MILEAGE CRONS (daily sync, monthly summary, trip re-matching)
  // =========================================================================
  try {
    const { initBouncieMileageCrons } = require('./bouncie-mileage-crons');
    initBouncieMileageCrons();
    logger.info('Bouncie mileage crons initialized');
  } catch (err) {
    logger.error(`Bouncie mileage crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // DAILY 9AM — Payment expiry check (cards expiring this/next month)
  // =========================================================================
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running: payment expiry check');
    try {
      const paymentExpiry = require('./workflows/payment-expiry');
      if (paymentExpiry.checkExpiringCards) {
        const result = await paymentExpiry.checkExpiringCards();
        logger.info(`Payment expiry check done: ${result.notified} notified, ${result.totalExpiring} expiring`);
      }
    } catch (err) {
      logger.error(`Payment expiry check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6PM — Missed appointment check
  // =========================================================================
  cron.schedule('0 18 * * *', async () => {
    logger.info('Running: missed appointment check');
    try {
      const missedAppointment = require('./workflows/missed-appointment');
      if (missedAppointment.onSkip) {
        // Find today's services that were scheduled but not completed
        const today = etDateString();
        const missedServices = await db('scheduled_services')
          .where({ scheduled_date: today })
          .whereIn('status', ['pending', 'confirmed'])
          .select('id');
        for (const svc of missedServices) {
          try {
            await missedAppointment.onSkip(svc.id, 'no_show');
          } catch (skipErr) {
            logger.error(`Missed appointment onSkip failed for ${svc.id}: ${skipErr.message}`);
          }
        }
        logger.info(`Missed appointment check done: ${missedServices.length} services checked`);
      }
    } catch (err) {
      logger.error(`Missed appointment check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10AM — Renewal reminders (termite bond, mosquito season, WaveGuard)
  // =========================================================================
  cron.schedule('0 10 * * *', async () => {
    logger.info('Running: renewal reminders');
    try {
      const renewalReminder = require('./workflows/renewal-reminder');
      if (renewalReminder.checkAndSend) {
        const result = await renewalReminder.checkAndSend();
        logger.info(`Renewal reminders done: ${result.sent} sent`);
      }
    } catch (err) {
      logger.error(`Renewal reminders failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 10AM — Seasonal reactivation campaign
  // =========================================================================
  cron.schedule('0 10 * * 1', async () => {
    logger.info('Running: seasonal reactivation campaign');
    try {
      const seasonalReactivation = require('./workflows/seasonal-reactivation');
      if (seasonalReactivation.run) {
        const result = await seasonalReactivation.run();
        logger.info(`Seasonal reactivation done: ${result.sent} sent (month ${result.month}, type: ${result.hookType})`);
      }
    } catch (err) {
      logger.error(`Seasonal reactivation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 11AM — Balance reminders (upcoming services with outstanding balance)
  // =========================================================================
  cron.schedule('0 11 * * *', async () => {
    logger.info('Running: balance reminders');
    try {
      const balanceReminder = require('./workflows/balance-reminder');
      if (balanceReminder.dailyCheck) {
        await balanceReminder.dailyCheck();
      }
      if (balanceReminder.latePaymentCheck) {
        await balanceReminder.latePaymentCheck();
      }
    } catch (err) {
      logger.error(`Balance reminders failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // GA4 ANALYTICS CRONS (daily sync)
  // =========================================================================
  try {
    const { initGA4Crons } = require('./analytics/ga4-crons');
    initGA4Crons();
    logger.info('GA4 analytics crons initialized');
  } catch (err) {
    logger.error(`GA4 crons failed to init: ${err.message}`);
  }

  // DAILY 1AM — Terminal handoff tokens cleanup
  //
  // Rows expire after 60s of mint. The 1-hour post-expiry buffer is
  // intentional: if a tech reports "the charge didn't go through" within the
  // next hour, support can still inspect whether the token was minted /
  // validated / never used. Anything beyond 1h is forensics we'd read from
  // audit_log anyway.
  //
  // Multi-instance safety: DELETE is idempotent — concurrent runs on
  // Railway replicas just race and one wins. If we ever add a non-idempotent
  // daily job, introduce a cron_leases table with SELECT ... FOR UPDATE
  // SKIP LOCKED first. Don't copy this pattern blindly.
  cron.schedule('0 1 * * *', async () => {
    const started = Date.now();
    try {
      const deleted = await db('terminal_handoff_tokens')
        .where('expires_at', '<', db.raw("NOW() - INTERVAL '1 hour'"))
        .del();
      logger.info(`[terminal-cleanup] ok — deleted ${deleted} expired handoff token(s) in ${Date.now() - started}ms`);
    } catch (err) {
      logger.error(`[terminal-cleanup] failed after ${Date.now() - started}ms: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Orphaned-validated handoff sweeper
  //
  // Targets rows where /validate-handoff burned the jti but /payment-intent
  // was never called (tech's iOS app crashed post-validate, user backed out
  // of the charge screen, network dropped between apps, etc.). 15-minute
  // threshold is deliberately longer than a realistic Tap to Pay flow
  // (20-60s of tech-customer interaction + charge) but short enough that
  // these rows don't accumulate and silently chew the per-tech rate-limit
  // budget.
  //
  // The partial index terminal_handoff_tokens_orphaned_validated_idx covers
  // exactly this WHERE clause — it's a direct index scan, not a table scan.
  // Cheap enough to run every 5 minutes on Railway's shared Postgres.
  //
  // Note: the daily 1AM cleanup above catches these rows eventually (via
  // expires_at), but only after 1h of post-expiry buffer. The 5-min sweeper
  // is specifically for the rate-limit-budget case.
  cron.schedule('*/5 * * * *', async () => {
    const started = Date.now();
    try {
      const deleted = await db('terminal_handoff_tokens')
        .whereNotNull('used_at')
        .whereNull('stripe_payment_intent_id')
        .where('used_at', '<', db.raw("NOW() - INTERVAL '15 minutes'"))
        .del();
      if (deleted > 0) {
        logger.info(`[terminal-sweeper] ok — deleted ${deleted} orphaned-validated handoff(s) in ${Date.now() - started}ms`);
      }
    } catch (err) {
      logger.error(`[terminal-sweeper] failed after ${Date.now() - started}ms: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Tech-late detector (first dispatch alert generator)
  //
  // Reads scheduled_services for jobs whose ET window_start has passed
  // by ≥ 15 min while the tech hasn't moved to on_site / completed /
  // cancelled / skipped, and inserts a tech_late dispatch_alert via
  // createAlert (which fans out the dispatch:alert socket broadcast
  // post-commit so the Action Queue right pane updates in real time).
  //
  // Idempotent: skips jobs that already have an unresolved tech_late
  // alert. After the dispatcher resolves a warn, the next tick fires
  // a fresh critical if the job is still late — natural escalation
  // without in-place row mutation.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runTechLateCheck } = require('./tech-late-detector');
      await runTechLateCheck();
    } catch (err) {
      logger.error(`[tech-late-detector] tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Unassigned-overdue detector (second alert generator)
  //
  // Same shape as tech-late-detector but scopes to jobs with
  // technician_id IS NULL. Fires unassigned_overdue alerts when an
  // unassigned job's window_start (in ET) has passed by ≥ 15 min
  // and the job is still pre-terminal. Severity bands: 15–29 → warn,
  // ≥ 30 → critical. Partial unique index closes the cross-process
  // race (migration 20260427000003).
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runUnassignedOverdueCheck } = require('./unassigned-overdue-detector');
      await runUnassignedOverdueCheck();
    } catch (err) {
      logger.error(`[unassigned-overdue-detector] tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  logger.info('Scheduled jobs initialized');
}

// Banking sync is a passive Stripe→DB mirror with no customer-facing side
// effects (webhooks already handle real-time updates; this is the catch-up
// safety net). It runs UNGATED so missed payout.* events still get backfilled
// even when GATE_CRON_JOBS is off — matching the behavior of the legacy
// 15-min setInterval that previously lived in server/index.js.
function initBankingSync() {
  cron.schedule('0 8,20 * * *', async () => {
    try {
      const StripeBanking = require('./stripe-banking');
      const result = await StripeBanking.syncPayouts(50);
      logger.info(`[stripe-banking] Scheduled sync: ${result.synced} payouts`);
    } catch (err) {
      logger.error(`[stripe-banking] Scheduled sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });
  logger.info('[stripe-banking] Twice-daily payout sync scheduled (8 AM / 8 PM ET)');
}

module.exports = { initScheduledJobs, initBankingSync };
