const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getPrimaryContact } = require('./customer-contact');
const { portalUrl: buildPortalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { currency } = require('./email-template');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const TRANSACTIONAL_GROUP = 'transactional_required';

function clean(value) {
  return String(value || '').trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function displayDate(value) {
  if (!value) return '';
  return formatDisplayDate(value, { fallback: '' });
}

function money(value) {
  if (value == null || value === '') return '';
  return currency(value);
}

function portalTabUrl(tab = 'dashboard') {
  return buildPortalUrl(`/?tab=${encodeURIComponent(tab || 'dashboard')}`);
}

function stableEventKey(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime()) && String(value).includes('T')) return parsed.toISOString();
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value || {}))
    .digest('hex')
    .slice(0, 16);
}

function fullName(customer = {}) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || clean(customer.company_name)
    || clean(customer.first_name)
    || 'Waves customer';
}

async function loadCustomer(customerId) {
  if (!customerId) return null;
  return db('customers')
    .where({ id: customerId })
    .select(
      'id',
      'first_name',
      'last_name',
      'company_name',
      'email',
      'phone',
      'address_line1',
      'city',
      'state',
      'zip',
      'profile_label',
      'waveguard_tier',
      'monthly_rate',
      'member_since',
      'active',
      'service_paused_at',
      'service_pause_reason'
    )
    .first();
}

function propertyLabel(customer = {}) {
  const label = clean(customer.profile_label);
  if (label) return label;
  const address = [customer.address_line1, customer.city].filter(Boolean).join(', ');
  return address || 'Service property';
}

async function logLifecycleEmailAttempt({
  customerId,
  templateKey,
  eventType,
  status,
  providerMessageId = null,
  sentAt = null,
  failureReason = null,
  metadata = {},
}) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'email_outbound',
      subject: `${eventType} email ${status}`,
      body: failureReason
        ? `${eventType} email ${status}: ${failureReason}`
        : `${eventType} email ${status}.`,
      metadata: JSON.stringify({
        customer_id: customerId,
        template_key: templateKey,
        channel: 'email',
        event_type: eventType,
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
        ...metadata,
      }),
    });
  } catch (err) {
    logger.warn(`[account-membership-email] audit log failed for ${eventType}/${customerId}: ${err.message}`);
  }
}

async function sendTemplate({
  customerId,
  recipientCustomerId = customerId,
  templateKey,
  eventType,
  payload = {},
  idempotencyKey,
  categories = [],
  triggerEventId,
  metadata = {},
}) {
  const recipientCustomer = await loadCustomer(recipientCustomerId);
  if (!recipientCustomer) return { ok: false, skipped: true, reason: 'customer_not_found' };

  const contact = getPrimaryContact(recipientCustomer);
  if (!isEmailLike(contact.email)) {
    await logLifecycleEmailAttempt({
      customerId: recipientCustomer.id,
      templateKey,
      eventType,
      status: 'skipped',
      failureReason: 'missing_email',
      metadata,
    });
    return { ok: false, skipped: true, reason: 'missing_email' };
  }

  const targetCustomer = String(customerId || '') === String(recipientCustomer.id)
    ? recipientCustomer
    : await loadCustomer(customerId);
  const firstName = firstToken(contact.name) || firstToken(recipientCustomer.first_name) || 'there';
  const finalPayload = {
    first_name: firstName,
    customer_name: fullName(recipientCustomer),
    customer_portal_url: portalTabUrl('dashboard'),
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    company_email: CONTACT_EMAIL,
    property_label: targetCustomer ? propertyLabel(targetCustomer) : '',
    ...payload,
  };

  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: contact.email,
      payload: finalPayload,
      recipientType: 'customer',
      recipientId: recipientCustomer.id,
      triggerEventId: triggerEventId || `${eventType}:${recipientCustomer.id}`,
      idempotencyKey,
      categories: [
        eventType.split('.')[0],
        eventType.replace(/[^a-zA-Z0-9_-]/g, '_'),
        ...categories,
      ],
      suppressionGroupKey: TRANSACTIONAL_GROUP,
    });

    if (result.deduped) {
      return {
        ok: !!result.sent,
        deduped: true,
        blocked: !!result.blocked,
        messageId: result.message?.provider_message_id || null,
      };
    }

    const status = result.sent ? 'sent' : result.blocked ? 'blocked' : 'failed';
    await logLifecycleEmailAttempt({
      customerId: recipientCustomer.id,
      templateKey,
      eventType,
      status,
      providerMessageId: result.message?.provider_message_id || null,
      sentAt: result.message?.sent_at || null,
      failureReason: result.sent ? null : result.reason || result.message?.error_message || 'email_not_sent',
      metadata,
    });

    return result.sent
      ? { ok: true, messageId: result.message?.provider_message_id || null }
      : { ok: false, blocked: !!result.blocked, reason: result.reason || 'email_not_sent' };
  } catch (err) {
    await logLifecycleEmailAttempt({
      customerId: recipientCustomer.id,
      templateKey,
      eventType,
      status: 'failed',
      failureReason: err.message,
      metadata,
    });
    logger.error(`[account-membership-email] ${eventType} failed for ${recipientCustomer.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function itemSummary(items = []) {
  return items
    .map((item) => {
      const label = clean(item.label || item.key || 'Setting');
      const next = clean(item.newValue ?? item.new_value);
      const previous = clean(item.oldValue ?? item.old_value);
      if (previous && next) return `${label}: ${previous} to ${next}`;
      if (next) return `${label}: ${next}`;
      return label;
    })
    .filter(Boolean)
    .join('; ');
}

async function sendAccountUpdated({
  customerId,
  recipientCustomerId = customerId,
  actorCustomerId,
  changedItems = [],
  changeSummary,
  accountSection = 'Account settings',
  propertyLabel: explicitPropertyLabel = '',
  changedAt = new Date(),
  idempotencyKey,
} = {}) {
  // The account.updated template is a security-style "was this you?" notice.
  // Skip it when the recipient is the same person who made the change — a
  // routine self-service portal edit. Without this, one settings session fans
  // out a separate "your settings were updated" email per saved field. The
  // notice is still sent when a different actor (e.g. staff) changed the
  // recipient's settings, or when the actor is unknown (fail toward notifying).
  if (
    actorCustomerId != null &&
    recipientCustomerId != null &&
    String(actorCustomerId) === String(recipientCustomerId)
  ) {
    return { ok: false, skipped: true, reason: 'self_initiated' };
  }
  const summary = clean(changeSummary) || itemSummary(changedItems);
  if (!summary) return { ok: false, skipped: true, reason: 'no_changes' };
  const idHash = hashValue({
    customerId,
    recipientCustomerId,
    accountSection,
    changedItems,
    summary,
    changedAt: stableEventKey(changedAt),
  });
  return sendTemplate({
    customerId,
    recipientCustomerId,
    templateKey: 'account.updated',
    eventType: 'account.updated',
    payload: {
      account_section: accountSection,
      change_summary: summary,
      changed_items_summary: itemSummary(changedItems) || summary,
      changed_at: displayDate(changedAt),
      property_label: explicitPropertyLabel,
      manage_preferences_url: portalTabUrl('visits'),
      customer_portal_url: portalTabUrl('property'),
    },
    idempotencyKey: idempotencyKey || `account.updated:${recipientCustomerId}:${idHash}`,
    categories: ['account_updated'],
    metadata: {
      target_customer_id: customerId,
      changed_items: changedItems,
      account_section: accountSection,
    },
  });
}

async function sendRequestReceived({
  customerId,
  request,
  responseTime,
  idempotencyKey,
} = {}) {
  if (!request?.id) return { ok: false, skipped: true, reason: 'missing_request' };
  const category = clean(request.category).replace(/_/g, ' ') || 'request';
  const submittedAt = request.created_at || request.createdAt || new Date();
  return sendTemplate({
    customerId,
    templateKey: 'account.request_received',
    eventType: 'account.request_received',
    payload: {
      request_id: request.id,
      request_type: category.replace(/\b\w/g, (ch) => ch.toUpperCase()),
      request_subject: clean(request.subject) || 'New request',
      request_summary: clean(request.description),
      request_status: clean(request.status) || 'new',
      submitted_at: displayDate(submittedAt),
      response_time: responseTime || (request.urgency === 'urgent' ? '2 hours' : '24 hours'),
      customer_portal_url: portalTabUrl('dashboard'),
      portal_requests_url: portalTabUrl('request'),
    },
    idempotencyKey: idempotencyKey || `account.request_received:${request.id}`,
    categories: ['request_received'],
    metadata: {
      service_request_id: request.id,
      request_category: request.category,
      urgency: request.urgency,
    },
  });
}

async function sendRequestUpdated({
  customerId,
  request,
  statusLabel,
  idempotencyKey,
} = {}) {
  if (!request?.id) return { ok: false, skipped: true, reason: 'missing_request' };
  const status = statusLabel || clean(request.status) || 'updated';
  return sendTemplate({
    customerId,
    templateKey: 'account.request_updated',
    eventType: 'account.request_updated',
    payload: {
      request_id: request.id,
      request_type: clean(request.category).replace(/_/g, ' ') || 'request',
      request_subject: clean(request.subject) || 'Your request',
      request_summary: clean(request.description),
      request_status: status,
      updated_at: displayDate(request.updated_at || new Date()),
      customer_portal_url: portalTabUrl('dashboard'),
      portal_requests_url: portalTabUrl('request'),
    },
    idempotencyKey: idempotencyKey || `account.request_updated:${request.id}:${stableEventKey(request.updated_at || status)}`,
    categories: ['request_updated'],
    metadata: { service_request_id: request.id, request_status: status },
  });
}

function membershipPayload(customer = {}, extra = {}) {
  return {
    membership_name: extra.membershipName || `WaveGuard ${clean(extra.membershipTier || customer.waveguard_tier || 'Membership')}`,
    membership_tier: clean(extra.membershipTier || customer.waveguard_tier),
    membership_status: clean(extra.membershipStatus),
    effective_date: displayDate(extra.effectiveDate || new Date()),
    renewal_date: displayDate(extra.renewalDate),
    monthly_rate: money(extra.monthlyRate ?? customer.monthly_rate),
    billing_cadence: clean(extra.billingCadence || 'monthly'),
    included_services: clean(extra.includedServices),
    paused_until: displayDate(extra.pausedUntil),
    pause_reason: clean(extra.pauseReason),
    cancellation_effective_date: displayDate(extra.cancellationEffectiveDate),
    reactivated_at: displayDate(extra.reactivatedAt || extra.effectiveDate),
    customer_portal_url: portalTabUrl('plan'),
  };
}

async function sendMembershipStarted({
  customerId,
  effectiveDate = new Date(),
  sourceId = null,
  membershipTier,
  monthlyRate,
  billingCadence,
  includedServices,
  idempotencyKey,
} = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  return sendTemplate({
    customerId,
    templateKey: 'membership.started',
    eventType: 'membership.started',
    payload: membershipPayload(customer, {
      membershipTier,
      monthlyRate,
      billingCadence,
      includedServices,
      effectiveDate,
      membershipStatus: 'Active',
    }),
    idempotencyKey: idempotencyKey || `membership.started:${customerId}:${sourceId || stableEventKey(effectiveDate)}`,
    categories: ['membership_started'],
    metadata: { source_id: sourceId },
  });
}

async function sendMembershipUpdated({
  customerId,
  before = {},
  after = {},
  effectiveDate = new Date(),
  idempotencyKey,
} = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  const changes = [];
  if (before.waveguard_tier !== undefined && after.waveguard_tier !== undefined && before.waveguard_tier !== after.waveguard_tier) {
    changes.push(`Tier: ${before.waveguard_tier || 'None'} to ${after.waveguard_tier || 'None'}`);
  }
  if (before.monthly_rate !== undefined && after.monthly_rate !== undefined && Number(before.monthly_rate || 0) !== Number(after.monthly_rate || 0)) {
    changes.push(`Monthly rate: ${money(before.monthly_rate)} to ${money(after.monthly_rate)}`);
  }
  const summary = changes.join('; ') || 'Your membership details were updated.';
  return sendTemplate({
    customerId,
    templateKey: 'membership.updated',
    eventType: 'membership.updated',
    payload: {
      ...membershipPayload({ ...customer, ...after }, {
        effectiveDate,
        membershipTier: after.waveguard_tier,
        monthlyRate: after.monthly_rate,
        membershipStatus: after.active === false ? 'Inactive' : 'Active',
      }),
      membership_change_summary: summary,
      old_membership_tier: clean(before.waveguard_tier),
      new_membership_tier: clean(after.waveguard_tier),
      old_monthly_rate: money(before.monthly_rate),
      new_monthly_rate: money(after.monthly_rate),
    },
    idempotencyKey: idempotencyKey || `membership.updated:${customerId}:${stableEventKey(effectiveDate)}:${hashValue({ before, after })}`,
    categories: ['membership_updated'],
    metadata: { before, after },
  });
}

async function sendMembershipRenewalReminder({
  customerId,
  renewalDate,
  daysOut,
  termId = null,
  lastServiceDate = null,
  idempotencyKey,
} = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  return sendTemplate({
    customerId,
    templateKey: 'membership.renewal_reminder',
    eventType: 'membership.renewal_reminder',
    payload: {
      ...membershipPayload(customer, {
        renewalDate,
        membershipTier: customer.waveguard_tier,
        monthlyRate: customer.monthly_rate,
        membershipStatus: 'Active',
      }),
      renewal_days_out: clean(daysOut),
      renewal_notice_window: daysOut ? `${daysOut} days` : '',
      last_service_date: displayDate(lastServiceDate),
    },
    idempotencyKey: idempotencyKey || `membership.renewal_reminder:${termId || customerId}:${daysOut || 'notice'}:${stableEventKey(renewalDate)}`,
    categories: ['membership_renewal_reminder'],
    metadata: { annual_prepay_term_id: termId, days_out: daysOut },
  });
}

async function sendMembershipCanceled({
  customerId,
  effectiveDate = new Date(),
  reason = '',
  membershipTier,
  monthlyRate,
  billingCadence,
  includedServices,
  idempotencyKey,
} = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  return sendTemplate({
    customerId,
    templateKey: 'membership.canceled',
    eventType: 'membership.canceled',
    payload: membershipPayload(customer, {
      cancellationEffectiveDate: effectiveDate,
      pauseReason: reason,
      membershipTier,
      monthlyRate,
      billingCadence,
      includedServices,
      membershipStatus: 'Canceled',
    }),
    idempotencyKey: idempotencyKey || `membership.canceled:${customerId}:${stableEventKey(effectiveDate)}`,
    categories: ['membership_canceled'],
    metadata: { reason, membership_tier: membershipTier || null },
  });
}

async function sendMembershipPaused({
  customerId,
  pausedUntil = null,
  reason = '',
  effectiveDate = new Date(),
  idempotencyKey,
} = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  return sendTemplate({
    customerId,
    templateKey: 'membership.paused',
    eventType: 'membership.paused',
    payload: membershipPayload(customer, {
      effectiveDate,
      pausedUntil,
      pauseReason: reason,
      membershipStatus: 'Paused',
    }),
    idempotencyKey: idempotencyKey || `membership.paused:${customerId}:${stableEventKey(effectiveDate)}:${hashValue({ reason, pausedUntil })}`,
    categories: ['membership_paused'],
    metadata: { reason, paused_until: pausedUntil },
  });
}

async function sendMembershipReactivated({
  customerId,
  effectiveDate = new Date(),
  idempotencyKey,
} = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  return sendTemplate({
    customerId,
    templateKey: 'membership.reactivated',
    eventType: 'membership.reactivated',
    payload: membershipPayload(customer, {
      effectiveDate,
      reactivatedAt: effectiveDate,
      membershipStatus: 'Active',
    }),
    idempotencyKey: idempotencyKey || `membership.reactivated:${customerId}:${stableEventKey(effectiveDate)}`,
    categories: ['membership_reactivated'],
  });
}

module.exports = {
  sendAccountUpdated,
  sendRequestReceived,
  sendRequestUpdated,
  sendMembershipStarted,
  sendMembershipUpdated,
  sendMembershipRenewalReminder,
  sendMembershipCanceled,
  sendMembershipPaused,
  sendMembershipReactivated,
  _private: {
    hashValue,
    itemSummary,
    membershipPayload,
    sendTemplate,
    stableEventKey,
  },
};
