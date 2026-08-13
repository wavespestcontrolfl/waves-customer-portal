const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getPrimaryContact, getInvoiceEmailRecipients } = require('./customer-contact');
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
      // resolveBillingLane inputs (sendMembershipUpdated gates its
      // "Monthly rate" line on the resolved lane): without billing_mode the
      // resolver falls to NULL-mode inference, and a per-application customer
      // with a lingering tier+rate would be told their monthly rate changed —
      // the exact audience the gate exists for.
      'billing_mode',
      // sendMembershipStarted's per-application fallback fee — the
      // acceptance-stamped per-visit charge, never monthly_rate.
      'per_application_fee',
      'pipeline_stage',
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
  contactOverride = null,
}) {
  const recipientCustomer = await loadCustomer(recipientCustomerId);
  if (!recipientCustomer) return { ok: false, skipped: true, reason: 'customer_not_found' };

  const contact = contactOverride || getPrimaryContact(recipientCustomer);
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

// Cancellation-request confirmation — the fallback when the dedicated
// cancellation SMS could not be delivered. By the time this sends the
// auto-processor has churned the account (active=false blocks portal auth),
// so the template deliberately carries NO portal CTAs (seeded by migration
// 20260701000003); copy mirrors the service_cancellation_confirmation SMS.
async function sendCancellationReceived({
  customerId,
  request,
  idempotencyKey,
} = {}) {
  if (!request?.id) return { ok: false, skipped: true, reason: 'missing_request' };
  const submittedAt = request.created_at || request.createdAt || new Date();
  return sendTemplate({
    customerId,
    templateKey: 'account.cancellation_received',
    eventType: 'account.cancellation_received',
    payload: {
      request_id: request.id,
      request_subject: clean(request.subject) || 'Cancellation request',
      submitted_at: displayDate(submittedAt),
    },
    idempotencyKey: idempotencyKey || `account.cancellation_received:${request.id}`,
    categories: ['cancellation_received'],
    metadata: {
      service_request_id: request.id,
      request_category: request.category,
    },
  });
}

// Pre-visit late-balance reminder (owner directive 2026-07-17) — the email
// half of the previsit-balance-reminder sweep. Eligibility (recurring visit
// + recurring-lane late balance only) lives entirely in that service; this
// just renders and sends.
// A BILLING email follows the billing recipient and the billing prefs, not
// the primary contact (Codex r10 P1): notification_prefs.billing_email
// routes AR mail to the payer's bookkeeper and email_enabled=false kills
// the channel. (billing_reminder is RETIRED — owner ruling 2026-08-01:
// billing notices carry no per-purpose opt-out.) The SMS leg's prefs are enforced inside send-customer-message —
// this is the email leg's equivalent, shared with the sweep so hasEmailLeg
// is only declared when the email can actually send.
async function resolvePrevisitBalanceEmailRecipient(customerId) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { recipient: null, reason: 'customer_not_found' };
  let prefs = {};
  try {
    prefs = await db('notification_prefs').where({ customer_id: customerId }).first() || {};
  } catch { prefs = {}; }
  if (prefs.email_enabled === false) return { recipient: null, reason: 'email_disabled' };
  const [recipient] = getInvoiceEmailRecipients(customer, prefs).filter((r) => isEmailLike(r.email));
  if (!recipient?.email) return { recipient: null, reason: 'missing_email' };
  return { recipient, reason: null };
}

async function sendPrevisitBalanceReminder({
  customerId,
  amount,
  serviceType,
  visitDate,
  billingUrl,
  idempotencyKey,
} = {}) {
  const { recipient, reason } = await resolvePrevisitBalanceEmailRecipient(customerId);
  if (!recipient) return { ok: false, skipped: true, reason };
  return sendTemplate({
    contactOverride: recipient,
    customerId,
    templateKey: 'billing.previsit_balance',
    eventType: 'billing.previsit_balance',
    payload: {
      amount: clean(amount),
      service_type: clean(serviceType) || 'service',
      visit_date: clean(visitDate),
      billing_url: clean(billingUrl),
    },
    idempotencyKey,
    categories: ['previsit_balance_reminder'],
    metadata: { amount: clean(amount), visit_date: clean(visitDate) },
  });
}

async function sendRequestUpdated({
  customerId,
  request,
  statusLabel,
  idempotencyKey,
} = {}) {
  if (!request?.id) return { ok: false, skipped: true, reason: 'missing_request' };
  // CTA-sourced requests (report cross-sell card, portal home
  // recommendations) are OWNER-FOLLOW-UP ONLY (codex #3367 PR r19; extended
  // to every shared CTA source on the portal-recommendations lane). The
  // card tells the customer their request was recorded and that no message
  // has been sent; the offer then belongs to the owner to price and pitch
  // by hand. A lifecycle email fired by a staff triage click would
  // contradict that copy and put an automated message in front of the
  // customer that nobody chose to send. Guarded in the SENDER, not the one
  // route that calls it, so a future caller cannot reintroduce it — and
  // keyed to the shared writer's source list so a new CTA surface inherits
  // the suppression automatically.
  const { CTA_REQUEST_SOURCES } = require('./cta-service-request');
  if (CTA_REQUEST_SOURCES.includes(clean(request.source))) {
    return { ok: false, skipped: true, reason: 'cta_owner_follow_up' };
  }
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
  // Lane gate (#3140 resolution): only a monthly_membership lane is billed
  // the stored monthly_rate — per-application/prepaid customers were being
  // welcomed with a monthly figure they are never charged ("$30.33 /
  // quarter" for a real $91-per-application plan). The estimate converter
  // passes the lane EXPLICITLY because this send is fire-and-forget and can
  // race the still-uncommitted accept transaction — loadCustomer reads
  // through the global pool and may see the PRE-accept row, so resolving
  // from the row alone would gate on stale state. Callers that fire after
  // commit may omit both and ride the resolveBillingLane fallback.
  billingLane = null,
  perApplicationAmount,
  idempotencyKey,
} = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  const { BILLING_MODES, resolveBillingLane } = require('./billing-lane');
  const lane = (billingLane && BILLING_MODES.includes(billingLane))
    ? billingLane
    : resolveBillingLane(customer).mode;
  // A one_time lane means NO recurring billing relationship — "your Waves
  // membership is active" is false no matter what tier value rides the row
  // (codex #3271 r2: an admin create with billingMode 'one_time' plus a real
  // tier passed the tier-only hasMembership check and welcomed the customer
  // to a membership that doesn't exist). Suppress HERE, in the lane gate all
  // callers already flow through, so the create route, the profile editor,
  // and any future caller inherit one decision. per_visit deliberately still
  // sends: a real tier + invoice-on-complete billing IS an ongoing plan.
  if (lane === 'one_time') {
    await logLifecycleEmailAttempt({
      customerId: customer.id,
      templateKey: 'membership.started',
      eventType: 'membership.started',
      status: 'skipped',
      failureReason: 'one_time_lane',
      metadata: { source_id: sourceId, billing_lane: lane },
    });
    return { ok: false, skipped: true, reason: 'one_time_lane' };
  }
  const payload = membershipPayload(customer, {
    membershipTier,
    monthlyRate,
    billingCadence,
    includedServices,
    effectiveDate,
    membershipStatus: 'Active',
  });
  // Non-monthly lanes override the rate/cadence rows. Blank values ride the
  // details renderer's empty-row dropping — the same mechanism the
  // sendMembershipUpdated gate uses (codex #3128 r2); the migration
  // 20260807220000 contract change makes a blank rate legal for this
  // template.
  if (lane === 'per_application') {
    // The acceptance-stamped per-visit charge. A multi-service accept
    // intentionally carries NO customer-level fee (whole-plan fee on every
    // row's completion = overbill) — the converter passes an EXPLICIT null,
    // which must stay blank: this fire-and-forget send can race the accept
    // transaction, so falling back to customer.per_application_fee could
    // resurrect a stale pre-accept fee the conversion is clearing. Only a
    // genuinely OMITTED argument (undefined — the admin-route callers)
    // rides the row fallback.
    const fee = perApplicationAmount === undefined
      ? customer.per_application_fee
      : perApplicationAmount;
    payload.monthly_rate = money(fee);
    // HARD RULE: "per application", never "per visit".
    payload.billing_cadence = 'per application';
  } else if (lane === 'annual_prepay') {
    payload.monthly_rate = '';
    payload.billing_cadence = '12 months prepaid';
  } else if (lane === 'per_visit') {
    // Invoice-on-complete lane: the stored monthly_rate is not a charge.
    // (one_time never reaches here — suppressed at the lane gate above.)
    payload.monthly_rate = '';
    payload.billing_cadence = 'billed after each service';
  }
  return sendTemplate({
    customerId,
    templateKey: 'membership.started',
    eventType: 'membership.started',
    payload,
    idempotencyKey: idempotencyKey || `membership.started:${customerId}:${sourceId || stableEventKey(effectiveDate)}`,
    categories: ['membership_started'],
    metadata: { source_id: sourceId, billing_lane: lane },
  });
}

// One-time "introducing the Waves app" onboarding email. The idempotency key is
// scoped to the customer alone, so it sends at most once per customer no matter
// how many times the trigger fires. Store links are passed in payload so the
// app_intro template body stays link-agnostic.
const APP_STORE_URL = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

async function sendAppIntro({ customerId, sourceId = null } = {}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found' };
  return sendTemplate({
    customerId,
    templateKey: 'app_intro',
    eventType: 'app_intro.first_visit',
    payload: {
      app_store_url: APP_STORE_URL,
      play_store_url: PLAY_STORE_URL,
    },
    idempotencyKey: `app_intro:${customerId}`,
    categories: ['app_intro', 'onboarding'],
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
  // BOTH sides of the change, resolved separately (codex #3128 r8). An admin
  // can move a customer between lanes and change the rate in one save; using
  // only the post-update lane then presented `before.monthly_rate` as "your
  // previous monthly rate" for someone who was never billed monthly.
  const { resolveBillingLane } = require('./billing-lane');
  const billingLane = resolveBillingLane({ ...customer, ...after }).mode;
  const billingLaneBefore = resolveBillingLane({ ...customer, ...before }).mode;
  // A monthly figure from the OLD state is only a real past charge when the
  // old lane billed monthly too.
  const monthlyBothSides = billingLane === 'monthly_membership' && billingLaneBefore === 'monthly_membership';
  const changes = [];
  if (before.waveguard_tier !== undefined && after.waveguard_tier !== undefined && before.waveguard_tier !== after.waveguard_tier) {
    changes.push(`Tier: ${before.waveguard_tier || 'None'} to ${after.waveguard_tier || 'None'}`);
  }
  if (before.monthly_rate !== undefined && after.monthly_rate !== undefined && Number(before.monthly_rate || 0) !== Number(after.monthly_rate || 0)) {
    // monthly_rate is stored for almost every recurring customer, but only a
    // monthly-membership lane is actually BILLED monthly — 157 of 159
    // per-application customers carry a rate they are never charged (audit
    // 2026-08-01). Gate the customer-facing line on the resolved lane, the
    // same way card-enrollment-email.js does, and describe each non-monthly
    // lane in its own billing terms (codex #3128 r1: "billed per
    // application" is wrong for prepaid and per-visit customers too).
    if (monthlyBothSides) {
      changes.push(`Monthly rate: ${money(before.monthly_rate)} to ${money(after.monthly_rate)}`);
    } else if (billingLane === 'monthly_membership') {
      // Moved INTO the monthly lane: state the new charge without inventing a
      // previous monthly rate the customer never paid.
      changes.push(`Your plan is now billed monthly at ${money(after.monthly_rate)}.`);
    } else if (billingLane === 'annual_prepay') {
      changes.push('Your plan pricing was updated. Your plan is prepaid for the year, so nothing changes about how you pay.');
    } else if (billingLane === 'per_application') {
      changes.push('Your plan pricing was updated — you are billed per application, and each visit is charged after it is completed.');
    } else {
      // per_visit / one_time: invoice-on-complete lanes.
      changes.push('Your plan pricing was updated — each service is billed after it is completed.');
    }
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
      // The template's "Previous rate"/"New rate" detail rows render from
      // these; the details renderer drops empty-valued rows, so blanking them
      // outside the monthly lane suppresses the rows entirely — a
      // per-application/prepaid/per-visit customer must not see
      // monthly-derived figures the summary above just avoided (codex #3128
      // r2).
      // "Previous rate" needs BOTH lanes monthly (codex #3128 r8) — on a
      // transition into the monthly lane the old stored figure was never a
      // monthly charge, so the row stays blank and the renderer drops it.
      old_monthly_rate: monthlyBothSides ? money(before.monthly_rate) : '',
      new_monthly_rate: billingLane === 'monthly_membership' ? money(after.monthly_rate) : '',
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
  sendCancellationReceived,
  sendRequestUpdated,
  sendMembershipStarted,
  sendAppIntro,
  sendMembershipUpdated,
  sendMembershipRenewalReminder,
  sendMembershipCanceled,
  sendMembershipPaused,
  sendMembershipReactivated,
  sendPrevisitBalanceReminder,
  resolvePrevisitBalanceEmailRecipient,
  _private: {
    hashValue,
    itemSummary,
    membershipPayload,
    sendTemplate,
    stableEventKey,
  },
};
