/**
 * Notification Triggers — central dispatcher for admin-side notification events.
 *
 * Existing routes/services call `triggerNotification(triggerKey, payload)` when
 * something happens. This module:
 *   1. Loads each admin user's per-trigger preferences
 *   2. Persists a bell entry via NotificationService (if bell_enabled)
 *   3. Pushes a Web Push notification via PushNotificationService (if push_enabled)
 *
 * Adding a new trigger:
 *   1. Add to TRIGGER_REGISTRY below (key, label, category, priority, build())
 *   2. Add to the seed list in the notification_preferences migration
 *   3. Call `triggerNotification('your_key', { ... })` from the route that fires it
 */
const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const PushService = require('./push-notifications');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const STREET_ADDRESS_RE = /\b\d{1,6}\s+[A-Za-z0-9 .'-]+?\s(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Circle|Cir|Boulevard|Blvd|Trail|Trl|Terrace|Ter|Place|Pl|Parkway|Pkwy|Way)\b/gi;
const SENSITIVE_TEXT_KEY_RE = /(message|body|note|reason|summary|text|description|title)/i;

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return 'unknown';
  return `***${digits.slice(-4)}`;
}

function maskEmail(value) {
  const text = String(value || '').trim();
  const [local, domain] = text.split('@');
  if (!local || !domain) return '[email]';
  return `${local.slice(0, 1)}***@${domain.toLowerCase()}`;
}

function redactPhoneCandidate(match) {
  const digits = String(match || '').replace(/\D/g, '');
  return digits.length >= 10 ? maskPhone(match) : match;
}

function redactSensitiveText(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(EMAIL_RE, (match) => maskEmail(match))
    .replace(STREET_ADDRESS_RE, '[address]')
    .replace(PHONE_CANDIDATE_RE, redactPhoneCandidate);
}

function sanitizeNotificationValue(value, key = '') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeNotificationValue(item, key));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeNotificationValue(entryValue, entryKey),
      ])
    );
  }
  if (typeof value !== 'string') return value;

  if (/phone/i.test(key)) return maskPhone(value);
  if (/email/i.test(key)) return maskEmail(value);
  if (/address/i.test(key)) return '[address]';
  if (SENSITIVE_TEXT_KEY_RE.test(key)) return redactSensitiveText(value).slice(0, 1500);
  return redactSensitiveText(value);
}

function sanitizeNotificationPayload(_triggerKey, payload = {}) {
  return sanitizeNotificationValue(payload);
}

function sanitizeBuiltNotification(built = {}) {
  return {
    ...built,
    title: redactSensitiveText(built.title || 'Notification'),
    body: built.body === null || built.body === undefined ? built.body : redactSensitiveText(built.body),
  };
}

// priority: 'urgent' (red, double vibrate), 'high' (amber), 'normal' (teal), 'low' (gray)
const TRIGGER_REGISTRY = {
  new_lead: {
    label: 'New lead submitted',
    category: 'new_lead',
    priority: 'high',
    group: 'Leads & Sales',
    build: (p) => {
      const bodyParts = [
        `${p.name || 'A prospect'}${p.source ? ' via ' + p.source : ''}${p.area ? ' (' + p.area + ')' : p.zip ? ' (' + p.zip + ')' : ''}`,
      ];
      if (p.service) bodyParts.push(`Wants ${p.service}`);
      if (p.phone) bodyParts.push(`Phone: ${maskPhone(p.phone)}`);
      if (p.message) bodyParts.push('Message included on lead record');
      return {
        title: p.title || 'New lead',
        body: bodyParts.join(' - '),
        link: p.leadId ? `/admin/leads/${p.leadId}` : '/admin/leads',
      };
    },
  },
  sms_reply: {
    label: 'SMS reply received',
    category: 'inbound_sms',
    priority: 'high',
    group: 'Communication',
    build: (p) => ({
      title: `SMS from ${p.fromName || (p.fromPhone ? maskPhone(p.fromPhone) : 'unknown')}`,
      body: redactSensitiveText(p.message || '').slice(0, 140),
      link: p.threadId ? `/admin/communications?thread=${p.threadId}` : '/admin/communications',
    }),
  },
  // Fired by estimate-converter when a paid acceptance deposit could not be
  // credited to the first invoice — the money sits on the deposit ledger
  // until someone reconciles it manually.
  estimate_deposit_reconcile_needed: {
    label: 'Estimate deposit needs manual reconciliation',
    category: 'system',
    priority: 'high',
    group: 'Alerts',
    build: (p) => ({
      title: 'Deposit paid but not credited',
      body: `Estimate ${String(p.estimateId || 'unknown').slice(0, 40)}: deposit is on the ledger but the first-invoice credit failed — reconcile manually`,
      link: '/admin/estimates',
    }),
  },
  twilio_failure: {
    label: 'Twilio call/SMS failure',
    category: 'system',
    priority: 'urgent',
    group: 'Communication',
    build: (p) => {
      const channel = String(p.channel || 'message').toUpperCase();
      const direction = p.direction ? `${p.direction} ` : '';
      const phase = p.phase ? ` (${p.phase})` : '';
      const status = p.status || 'failed';
      const code = p.errorCode ? ` error ${p.errorCode}` : '';
      return {
        title: `Twilio ${channel} ${status}`,
        body: `${direction}${channel}${phase}${code}: ${p.errorMessage || `from ${p.fromMasked || 'unknown'} to ${p.toMasked || 'unknown'}`} — ${p.sidMasked || 'no SID'}`,
        link: p.link || '/admin/communications',
      };
    },
  },
  payment_succeeded: {
    label: 'Payment received',
    category: 'payment',
    priority: 'low',
    group: 'Payments',
    build: (p) => ({
      title: 'Payment received',
      body: `$${Number(p.amount || 0).toFixed(2)} from ${p.customerName || 'customer'}`,
      link: p.invoiceId ? `/admin/invoices/${p.invoiceId}` : '/admin/revenue',
    }),
  },
  payment_failed: {
    label: 'Payment failed',
    category: 'payment',
    priority: 'urgent',
    group: 'Payments',
    build: (p) => ({
      title: 'Payment failed',
      body: `$${Number(p.amount || 0).toFixed(2)} — ${p.customerName || 'customer'}${p.reason ? ' — ' + p.reason : ''}`,
      link: p.invoiceId ? `/admin/invoices/${p.invoiceId}` : '/admin/revenue',
    }),
  },
  bill_payment_error: {
    label: 'Bill payment checkout error',
    category: 'payment',
    priority: 'high',
    group: 'Payments',
    build: (p) => {
      const invoiceLabel = p.invoiceNumber ? `Invoice ${p.invoiceNumber}` : 'Invoice payment';
      const method = p.methodLabel || 'Payment method';
      const phase = p.phaseLabel || p.phase || 'checkout';
      return {
        title: method === 'Bank account' ? 'Bank payment error' : 'Bill payment error',
        body: `${invoiceLabel} - ${p.customerName || 'customer'} - ${method} during ${phase}${p.reason ? ': ' + p.reason : ''}`,
        link: p.invoiceId ? `/admin/invoices/${p.invoiceId}` : '/admin/invoices',
      };
    },
  },
  payment_refunded: {
    label: 'Refund issued',
    category: 'payment',
    priority: 'normal',
    group: 'Payments',
    build: (p) => ({
      title: p.isFullRefund ? 'Full refund issued' : 'Partial refund issued',
      body: `$${Number(p.amount || 0).toFixed(2)} — ${p.customerName || 'customer'}`,
      link: p.invoiceId ? `/admin/invoices/${p.invoiceId}` : '/admin/revenue',
    }),
  },
  appointment_cancelled: {
    label: 'Appointment cancelled',
    category: 'schedule',
    priority: 'high',
    group: 'Field Operations',
    build: (p) => ({
      title: 'Appointment cancelled',
      body: `${p.customerName || 'Customer'} — ${p.scheduledDate || ''}${p.cancelledBy ? ' (by ' + p.cancelledBy + ')' : ''}`,
      link: '/admin/schedule',
    }),
  },
  review_received: {
    label: 'New review (4–5 star)',
    category: 'review',
    priority: 'normal',
    group: 'Reviews',
    build: (p) => ({
      title: `New ${p.stars || 5}-star review`,
      body: `${p.author || 'Anonymous'}: ${(p.text || '').slice(0, 120)}`,
      link: '/admin/reviews',
    }),
  },
  low_review: {
    label: 'Low review (1–3 star)',
    category: 'review',
    priority: 'urgent',
    group: 'Reviews',
    build: (p) => ({
      title: `${p.stars || 1}-star review — needs response`,
      body: `${p.author || 'Anonymous'}: ${(p.text || '').slice(0, 120)}`,
      link: '/admin/reviews',
    }),
  },
  job_complete: {
    label: 'Tech marked job complete',
    category: 'service',
    priority: 'low',
    group: 'Field Operations',
    build: (p) => ({
      title: 'Job complete',
      body: `${p.techName || 'Tech'} finished ${p.serviceName || 'service'} at ${p.customerName || 'customer'}`,
      link: p.serviceId ? `/admin/schedule?service=${p.serviceId}` : '/admin/schedule',
    }),
  },
  low_inventory: {
    label: 'Low inventory alert',
    category: 'system',
    priority: 'high',
    group: 'Inventory',
    build: (p) => ({
      title: 'Low inventory',
      body: `${p.productName || 'Product'} — ${p.remaining || 0} ${p.unit || 'left'}`,
      link: '/admin/inventory',
    }),
  },
  churn_risk: {
    label: 'Customer churn risk detected',
    category: 'churn_risk',
    priority: 'high',
    group: 'Customer Success',
    build: (p) => ({
      title: 'Churn risk detected',
      body: `${p.customerName || 'Customer'} — ${p.reason || 'risk score elevated'}`,
      link: p.customerId ? `/admin/customers/${p.customerId}` : '/admin/health',
    }),
  },
  estimate_expired: {
    label: 'Estimate(s) expired',
    category: 'estimate',
    priority: 'normal',
    group: 'Leads & Sales',
    build: (p) => ({
      title: p.count && p.count > 1
        ? `${p.count} estimates expired`
        : `Estimate expired — ${p.customerName || 'customer'}`,
      body: p.count && p.count > 1
        ? `${p.count} estimates aged out today. Review the pipeline for follow-up opportunities.`
        : `${p.customerName || 'Customer'}${p.monthlyTotal ? ' — $' + p.monthlyTotal + '/mo' : ''} expired without a decision.`,
      link: p.estimateId ? `/admin/estimates/${p.estimateId}` : '/admin/estimates',
    }),
  },
  bundle_quote_requested: {
    label: 'Bundle quote requested',
    category: 'estimate',
    priority: 'high',
    group: 'Leads & Sales',
    build: (p) => ({
      title: p.bundled
        ? `Bundle self-applied: ${p.customerName || 'Customer'}`
        : `Bundle inquiry: ${p.customerName || 'Customer'}`,
      body: p.bundled
        ? `Added ${p.suggestedService || 'service'} → ${p.newTier || p.tier || 'new tier'} @ $${Number(p.newMonthly || 0).toFixed(2)}/mo`
        : `Interested in adding ${p.suggestedService || 'a service'} to ${p.previousTier || p.tier || 'current'} plan`,
      link: p.estimateId ? `/admin/estimates?estimateId=${encodeURIComponent(p.estimateId)}` : '/admin/estimates',
    }),
  },
  credential_expiring_soon: {
    label: 'Credential expiring within 60 days',
    category: 'credential',
    priority: 'high',
    group: 'Compliance',
    build: (p) => ({
      title: `${p.displayName || 'Credential'} expires in ${p.daysUntil || '?'}d`,
      body: `${p.credentialNumber ? '#' + p.credentialNumber + ' — ' : ''}${p.issuingAuthority || 'Issuer'}. Renew before ${p.expirationDate || 'expiry'} to avoid service interruption.`,
      link: '/admin/credentials',
    }),
  },
  seo_sync_failed: {
    label: 'SEO sync failure (GSC / GBP)',
    category: 'system',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: `${p.source || 'SEO'} sync failed`,
      body: `${p.locationName ? p.locationName + ': ' : ''}${p.reason || 'unknown error'}. Check the Sync Health card on the SEO Advisor tab.`,
      link: '/admin/seo?tab=advisor',
    }),
  },
  // Fired by server/services/dashboard-alerts-cron.js when an
  // operational alert NEWLY appears or escalates (count grows). The
  // cron computes alerts via dashboard-alerts.js and diffs against
  // dashboard_alert_state. Payload echoes the alert shape so the bell,
  // push banner, and SMS all carry the same label.
  dashboard_alert: {
    label: 'Dashboard alert',
    category: 'alert',
    priority: 'urgent',
    group: 'Alerts',
    build: (p) => ({
      title: p.title || 'Dashboard alert',
      body: p.body || null,
      link: p.link || '/admin/dashboard',
    }),
  },
  internal_admin_alert: {
    label: 'Internal admin alert',
    category: 'alert',
    priority: 'high',
    group: 'Alerts',
    build: (p) => ({
      title: p.title || 'Internal admin alert',
      body: p.body || null,
      link: p.link || '/admin/dashboard',
    }),
  },
  newsletter_autopilot_draft: {
    label: 'Newsletter autopilot draft ready',
    category: 'newsletter',
    priority: 'normal',
    group: 'Marketing',
    build: (p) => {
      const warn = Array.isArray(p.preflightWarnings) && p.preflightWarnings.length
        ? ` Heads up: ${p.preflightWarnings.join('; ')}.`
        : '';
      return {
        title: 'Weekly newsletter draft ready',
        body: `Autopilot drafted "${p.subject || 'Untitled'}" from ${p.eventCount || 0} events.${warn} Review and send when ready.`,
        link: '/admin/newsletter?tab=compose',
      };
    },
  },
  newsletter_autopilot_skipped: {
    label: 'Newsletter autopilot skipped (not enough events)',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: 'Newsletter autopilot skipped',
      // p.report is the actionable preflight breakdown (counts + next
      // actions); fall back to the terse reason for legacy callers.
      body: p.report || `${p.reason || 'Not enough approved events'}. Approve more events in the Event Inbox to enable next week's auto-draft.`,
      link: '/admin/newsletter?tab=dashboard',
    }),
  },
  pest_insider_draft: {
    label: 'Pest Insider monthly draft ready',
    category: 'newsletter',
    priority: 'normal',
    group: 'Marketing',
    build: (p) => ({
      title: 'Pest Insider draft ready',
      body: `Autopilot drafted the ${p.month || 'monthly'} Pest Insider: "${p.subject || 'Untitled'}". Review and send when ready.`,
      // autopilotType deep-links Compose to the Pest Insider lane —
      // without it, hydration defaults to the weekly flagship draft.
      link: '/admin/newsletter?tab=compose&autopilotType=pest-insider-monthly',
    }),
  },
  event_sources_unhealthy: {
    label: 'Event ingestion sources unhealthy',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: 'Event sources unhealthy',
      // p.summary lists each failing / zero-yield source with its streak;
      // built by event-source-health.formatSourceHealthLines().
      body: p.summary
        ? `${p.summary}\n\nFix or disable these sources — they feed the weekly newsletter digest.`
        : 'One or more event ingestion sources are failing or yielding zero events.',
      link: '/admin/newsletter?tab=events',
    }),
  },
  kb_audit_flagged: {
    label: 'Knowledge base audit flagged entries',
    category: 'knowledge',
    priority: 'high',
    group: 'Knowledge Base',
    build: (p) => {
      const count = Number(p.count || p.flagged || 0);
      const entries = Array.isArray(p.entries) ? p.entries : [];
      const visible = entries.slice(0, 4).map((entry) => {
        const title = entry.title || 'Untitled entry';
        const summary = entry.summary || 'Needs review';
        return `${title}: ${String(summary).slice(0, 180)}`;
      });
      if (count > visible.length) visible.push(`${count - visible.length} more flagged entr${count - visible.length === 1 ? 'y' : 'ies'}`);
      return {
        title: count === 1 ? 'KB audit flagged 1 entry' : `KB audit flagged ${count} entries`,
        body: visible.join('\n') || 'Review flagged knowledge base entries.',
        link: '/admin/kb',
      };
    },
  },
};

const PRIORITY_VIBRATE = {
  urgent: [200, 100, 200, 100, 400],
  high:   [200, 100, 200],
  normal: [150],
  low:    [100],
};

function pushTagFor(triggerKey, payload = {}) {
  if (triggerKey === 'sms_reply') {
    const thread = payload.threadId || 'unknown-thread';
    return `waves-sms_reply-${thread}-${crypto.randomUUID()}`;
  }
  return `waves-${triggerKey}`;
}

/**
 * Fire a notification event. Non-blocking — never throws.
 *
 * @param {string} triggerKey — must match a key in TRIGGER_REGISTRY
 * @param {object} payload — trigger-specific data, see each build() for shape
 */
async function triggerNotification(triggerKey, payload = {}) {
  try {
    const trigger = TRIGGER_REGISTRY[triggerKey];
    if (!trigger) {
      logger.warn(`[notification-triggers] Unknown trigger: ${triggerKey}`);
      return;
    }

    const built = sanitizeBuiltNotification(trigger.build(payload));
    const safePayload = sanitizeNotificationPayload(triggerKey, payload);

    // Load per-user preferences (default to enabled if no row exists)
    let prefs = [];
    try {
      prefs = await db('notification_preferences')
        .where({ trigger_key: triggerKey });
    } catch (e) {
      logger.warn(`[notification-triggers] preferences table missing or query failed: ${e.message}`);
    }

    let activeAdmins = [];
    try {
      activeAdmins = await db('technicians').where({ active: true }).select('id');
    } catch (e) {
      logger.warn(`[notification-triggers] technicians query failed: ${e.message}`);
    }

    const prefsByUser = new Map(prefs.map((p) => [p.admin_user_id, p]));
    let bellWritten = false;

    for (const user of activeAdmins) {
      const userPref = prefsByUser.get(user.id) || { bell_enabled: true, push_enabled: true, sound_enabled: true };

      if (userPref.bell_enabled && !bellWritten) {
        // Write a single bell entry for "admin" recipients (existing model is shared)
        try {
          await NotificationService.notifyAdmin(
            trigger.category,
            built.title,
            built.body,
            { link: built.link, metadata: { triggerKey, priority: trigger.priority, payload: safePayload } }
          );
          bellWritten = true;
        } catch (e) {
          logger.error(`[notification-triggers] bell write failed: ${e.message}`);
        }
      }
    }

    const stats = { bellWritten, push: null };

    // Push: send to all admin/technician subscriptions whose user has push enabled.
    try {
      const enabledUserIds = activeAdmins
        .filter((u) => {
          const pref = prefsByUser.get(u.id);
          return !pref || pref.push_enabled !== false;
        })
        .map((u) => u.id);

      if (enabledUserIds.length > 0) {
        const wantsSoundByUser = new Map(
          activeAdmins.map((u) => {
            const pref = prefsByUser.get(u.id);
            return [u.id, !pref || pref.sound_enabled !== false];
          })
        );

        stats.push = await PushService.sendToAdminUsers(
          enabledUserIds,
          (adminUserId) => {
            const wantsSound = wantsSoundByUser.get(adminUserId);
            return {
              title: built.title,
              body: built.body,
              url: built.link || '/admin',
              tag: pushTagFor(triggerKey, payload),
              priority: trigger.priority,
              vibrate: wantsSound ? PRIORITY_VIBRATE[trigger.priority] : [0],
              silent: !wantsSound,
              renotify: triggerKey === 'sms_reply',
            };
          }
        );
      }
    } catch (e) {
      logger.error(`[notification-triggers] push dispatch failed: ${e.message}`);
    }
    return stats;
  } catch (err) {
    logger.error(`[notification-triggers] dispatch failed for ${triggerKey}: ${err.message}`);
    return { bellWritten: false, push: null, error: err.message };
  }
}

function listTriggers() {
  return Object.entries(TRIGGER_REGISTRY).map(([key, t]) => ({
    key, label: t.label, group: t.group, priority: t.priority,
  }));
}

module.exports = {
  triggerNotification,
  listTriggers,
  TRIGGER_REGISTRY,
  __private: {
    maskEmail,
    maskPhone,
    pushTagFor,
    redactSensitiveText,
    sanitizeBuiltNotification,
    sanitizeNotificationPayload,
  },
};
