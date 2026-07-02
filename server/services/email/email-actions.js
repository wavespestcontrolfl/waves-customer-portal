const db = require('../../models/db');
const gmailClient = require('./gmail-client');
const logger = require('../logger');
const { isOperationalDomain, domainFromAddress, domainMatches, normalizeAddress } = require('./spam-blocker');
const { whereLiveCustomer } = require('../customer-stages');

/**
 * Destructive auto-actions (trash, archive, one-click UNSUBSCRIBE) must
 * never fire on mail from Waves-owned or operational domains. Our own
 * newsletter test sends land in the shared inbox, get classified as
 * marketing_newsletter, and the agent was archiving them AND one-click
 * unsubscribing — which silently enrolled contact@ in SendGrid's
 * newsletter suppression group (twice). The same guard protects Google
 * security notices etc. from a spam/newsletter misclassification.
 * Non-destructive handlers (leads, vendor invoices) are unaffected.
 */
const DESTRUCTIVE_CATEGORIES = new Set(['spam', 'marketing_newsletter']);
function shouldSkipAutoAction(category, fromAddress) {
  return DESTRUCTIVE_CATEGORIES.has(category)
    && isOperationalDomain(domainFromAddress(fromAddress));
}

async function executeAutoAction(email, classification) {
  try {
    if (shouldSkipAutoAction(classification.category, email.from_address)) {
      await db('emails').where({ id: email.id }).update({
        auto_action: 'operational_sender_skipped',
        updated_at: new Date(),
      });
      logger.info(`[email-actions] Skipped ${classification.category} auto-action for operational sender ${email.from_address} ("${email.subject}")`);
      return;
    }
    switch (classification.category) {
      case 'spam':
        await handleSpam(email);
        break;
      case 'marketing_newsletter':
        await handleNewsletter(email);
        break;
      case 'lead_inquiry':
        await handleLeadInquiry(email, classification);
        break;
      case 'customer_request':
      case 'scheduling':
        await handleCustomerRequest(email, classification);
        break;
      case 'complaint':
        await handleComplaint(email, classification);
        break;
      case 'vendor_invoice':
        await handleVendorInvoice(email, classification);
        break;
      case 'vendor_communication':
        await handleVendorComm(email);
        break;
      default:
        // No auto-action for other categories
        break;
    }
  } catch (err) {
    logger.error(`[email-actions] Auto-action failed for ${email.id} (${classification.category}): ${err.message}`);
  }
}

async function handleSpam(email) {
  // 1. Trash in Gmail
  try { await gmailClient.trashMessage(email.gmail_id); } catch (e) { /* non-critical */ }

  // 2. Block future emails from this sender
  const { blockSpamSender } = require('./spam-blocker');
  await blockSpamSender(email);

  // 3. Mark in DB
  await db('emails').where({ id: email.id }).update({
    is_archived: true,
    auto_action: 'spam_blocked',
    updated_at: new Date(),
  });
  logger.info(`[email-actions] Spam blocked: "${email.subject}" from ${email.from_address}`);
}

async function handleNewsletter(email) {
  // 1. Archive in Gmail
  try { await gmailClient.archiveMessage(email.gmail_id); } catch (e) { /* non-critical */ }

  // 2. Try to unsubscribe
  let unsubMethod = 'none';
  try {
    const { autoUnsubscribe } = require('./auto-unsubscribe');
    const result = await autoUnsubscribe(email);
    unsubMethod = result.method;
  } catch (e) {
    logger.warn(`[email-actions] Unsubscribe failed for ${email.from_address}: ${e.message}`);
  }

  // 3. Mark in DB
  await db('emails').where({ id: email.id }).update({
    is_archived: true,
    auto_action: unsubMethod !== 'none' ? `newsletter_unsubscribed:${unsubMethod}` : 'newsletter_archived',
    updated_at: new Date(),
  });
}

/**
 * Lead-creation guards. Prod incidents: a lead was auto-created from a reply
 * to Waves' own auto-acknowledgment ("Re: Thanks for reaching out to Waves,
 * Santos"), and junk leads were minted with automated SENDER addresses stored
 * as the lead's contact email (voicemail@twimlets.com,
 * do-not-reply@thumbtack.com, a retired payment processor's messenger bot).
 *
 * Design principle: guards must not silently eat a real inquiry. Anything
 * blocked by the confidence floor, vendor skip, or reply-thread guards
 * surfaces as a needs-review notification; only the hard-skip sender list
 * (pure machine noise) and the existing-customer match skip silently
 * (log-only).
 */

// Pure machine noise — never a lead, no matter what the classifier says.
// Entries starting with '@' match the sender domain; others match the full
// address. Keep this list to LIVE infrastructure senders only (Twilio is a
// core dependency). One-off junk senders — retired-processor bots and the
// like — belong in the admin-managed blocked_email_senders denylist instead,
// which email-sync honors (auto-trash) before an email is ever classified.
const LEAD_HARD_SKIP_SENDERS = [
  '@twimlets.com', // Twilio voicemail relay robots
];

// Automated/no-reply senders and relay domains (e.g. Thumbtack lead
// notifications). These CAN carry a real prospect, so a lead is still created
// when the classifier extracted a real contact — but the automated
// from_address must never be stored as the lead's email.
const AUTOMATED_SENDER_LOCAL_PARTS = ['do-not-reply', 'no-reply', 'noreply', 'donotreply', 'notifications'];
const AUTOMATED_RELAY_DOMAINS = ['thumbtack.com'];

// Subject of the Waves auto-acknowledgment automation email
// ("Thanks for reaching out to Waves, {{first_name}}" — seeded in
// 20260424000007_seed_automation_default_steps.js). A reply to our own
// auto-ack is an existing conversation, not a brand-new inquiry.
const WAVES_AUTO_ACK_SUBJECT_PREFIX = 'thanks for reaching out to waves';
const REPLY_SUBJECT_RE = /^\s*((re|fw|fwd)\s*:\s*)+/i;

// Classifier confidence is 0.0-1.0 (see email-classifier.js prompt).
const DEFAULT_LEAD_MIN_CONFIDENCE = 0.7;

function leadMinConfidence() {
  const raw = process.env.EMAIL_LEAD_MIN_CONFIDENCE;
  if (raw === undefined || raw === '') return DEFAULT_LEAD_MIN_CONFIDENCE;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_LEAD_MIN_CONFIDENCE;
}

function isHardSkippedLeadSender(fromAddress) {
  const normalized = normalizeAddress(fromAddress);
  if (!normalized) return false;
  return LEAD_HARD_SKIP_SENDERS.some((entry) => (
    entry.startsWith('@') ? normalized.endsWith(entry) : normalized === entry
  ));
}

function isAutomatedSender(fromAddress) {
  const normalized = normalizeAddress(fromAddress);
  const at = normalized.lastIndexOf('@');
  if (at < 1) return false;
  const localPart = normalized.slice(0, at);
  if (AUTOMATED_SENDER_LOCAL_PARTS.includes(localPart)) return true;
  return domainMatches(normalized.slice(at + 1), AUTOMATED_RELAY_DOMAINS);
}

function isWavesAutoAckReply(subject) {
  const s = String(subject || '');
  if (!REPLY_SUBJECT_RE.test(s)) return false;
  return s.replace(REPLY_SUBJECT_RE, '').trim().toLowerCase().startsWith(WAVES_AUTO_ACK_SUBJECT_PREFIX);
}

function phoneLast10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Vendor-tagged at sync time (email-sync upsertEmail stamps
// classification='vendor' + vendor extracted_data) or a live
// vendor_email_domains match — vendor mail is never a lead.
async function isVendorEmail(email) {
  if (email.classification === 'vendor') return true;
  try {
    const data = typeof email.extracted_data === 'string'
      ? JSON.parse(email.extracted_data)
      : (email.extracted_data || {});
    if (data && (data.vendor_name || data.vendor_domain)) return true;
  } catch (e) { /* fall through to domain lookup */ }
  const domain = domainFromAddress(email.from_address);
  if (!domain) return false;
  const vendor = await db('vendor_email_domains').where('domain', domain).first();
  return !!vendor;
}

// Existing-customer match by email (extracted + sender) and by phone (last
// 10 digits). A LIVE customer — the canonical whereLiveCustomer predicate
// (active, not soft-deleted, pipeline_stage active_customer/won/at_risk) —
// must not come back as a brand-new lead. A non-deleted CRM row that is NOT
// live (new_lead / lost / churned / dormant) is returned separately: that
// inquiry surfaces to a human instead of being silently skipped, because a
// churned or lost contact emailing again is a re-engagement signal.
async function findExistingCustomerForLead(email, extracted) {
  const emailCandidates = [...new Set(
    [extracted.email, email.from_address].map(normalizeAddress).filter(Boolean)
  )];
  const last10 = phoneLast10(extracted.phone);

  const matchByContact = async (applyLiveness) => {
    if (emailCandidates.length) {
      const byEmail = await applyLiveness(db('customers'))
        .where(function () {
          emailCandidates.forEach((candidate, idx) => {
            idx === 0
              ? this.whereRaw('LOWER(email) = ?', [candidate])
              : this.orWhereRaw('LOWER(email) = ?', [candidate]);
          });
        })
        .first();
      if (byEmail) return byEmail;
    }
    if (last10) {
      const byPhone = await applyLiveness(db('customers'))
        .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
        .first();
      if (byPhone) return byPhone;
    }
    return null;
  };

  const live = await matchByContact((qb) => whereLiveCustomer(qb));
  if (live) return { live, inactive: null };
  const inactive = await matchByContact((qb) => qb.whereNull('deleted_at'));
  return { live: null, inactive };
}

// Blocked-but-maybe-real inquiries surface to a human instead of silently
// dropping — same admin notification path as new leads, as a review notice.
async function flagLeadNeedsReview(email, classification, reason) {
  await db('emails').where({ id: email.id }).update({
    auto_action: `lead_needs_review:${reason}`,
    updated_at: new Date(),
  });

  try {
    await db('notifications').insert({
      recipient_type: 'admin',
      category: 'email_alert',
      title: `Possible lead needs review: ${email.from_name || email.from_address}`,
      body: classification.summary || email.subject,
      icon: '\uD83D\uDCE7',
      link: '/admin/email',
      metadata: JSON.stringify({ emailId: email.id, reason }),
    });
  } catch (e) { /* non-critical */ }

  // Ids only in logs — sender addresses and subjects are PII (subjects can
  // carry names/phones/addresses); the needs-review notification has detail.
  logger.info(`[email-actions] Lead auto-create blocked (${reason}): email ${email.id} flagged for review`);
  return { action: 'lead_needs_review', reason };
}

async function handleLeadInquiry(email, classification) {
  const extracted = classification.extracted || {};

  // Guard: hard-skip senders are pure machine noise — never a lead (silent).
  if (isHardSkippedLeadSender(email.from_address)) {
    await db('emails').where({ id: email.id }).update({
      auto_action: 'lead_skipped_automated_sender',
      updated_at: new Date(),
    });
    logger.info(`[email-actions] Lead skipped — hard-skip automated sender (email ${email.id})`);
    return { action: 'skipped_automated_sender' };
  }

  const automatedSender = isAutomatedSender(email.from_address);

  // A "real" extracted contact email is one that differs from the sender
  // address — automated senders (Thumbtack, no-reply relays) echo their own
  // from_address into the extraction, and that must never identify a lead.
  const extractedEmailNormalized = normalizeAddress(extracted.email);
  const extractedRealEmail = extractedEmailNormalized
    && extractedEmailNormalized !== normalizeAddress(email.from_address)
    ? extracted.email
    : null;
  const dedupEmail = automatedSender ? extractedRealEmail : extracted.email;

  // Check if lead already exists
  let existingLead = null;
  if (dedupEmail || extracted.phone) {
    existingLead = await db('leads')
      .where(function () {
        let first = true;
        if (dedupEmail) {
          first ? this.where('email', dedupEmail) : this.orWhere('email', dedupEmail);
          first = false;
        }
        if (extracted.phone) {
          first ? this.where('phone', extracted.phone) : this.orWhere('phone', extracted.phone);
          first = false;
        }
      })
      .whereNotIn('status', ['won', 'lost'])
      .first();
  }
  // Skip the from_address fallback for automated senders — every
  // Thumbtack/no-reply notification shares one from_address, so matching on
  // it would glue unrelated prospects onto a single lead.
  if (!existingLead && email.from_address && !automatedSender) {
    existingLead = await db('leads').where('email', email.from_address)
      .whereNotIn('status', ['won', 'lost']).first();
  }

  if (existingLead) {
    await db('emails').where({ id: email.id }).update({
      lead_id: existingLead.id,
      auto_action: 'linked_to_existing_lead',
      updated_at: new Date(),
    });
    return { action: 'linked_to_existing_lead', leadId: existingLead.id };
  }

  // Guard: an existing LIVE customer must not come back as a lead (silent
  // skip); a match on a non-live CRM row (new_lead/lost/churned/dormant)
  // surfaces for review instead — silently skipping those would eat a real
  // re-engagement inquiry.
  const customerMatch = await findExistingCustomerForLead(email, extracted);
  if (customerMatch.live) {
    await db('emails').where({ id: email.id }).update({
      customer_id: customerMatch.live.id,
      auto_action: 'lead_skipped_existing_customer',
      updated_at: new Date(),
    });
    logger.info(`[email-actions] Lead skipped — email ${email.id} matches existing customer ${customerMatch.live.id}`);
    return { action: 'skipped_existing_customer', customerId: customerMatch.live.id };
  }
  if (customerMatch.inactive) {
    await db('emails').where({ id: email.id }).update({
      customer_id: customerMatch.inactive.id,
      updated_at: new Date(),
    });
    return flagLeadNeedsReview(email, classification, 'inactive_customer_match');
  }

  // Guard: vendor mail is never a lead, regardless of classification.
  if (await isVendorEmail(email)) {
    return flagLeadNeedsReview(email, classification, 'vendor_sender');
  }

  // Guard: a reply to Waves' own auto-acknowledgment is an existing
  // conversation, not a new inquiry (Santos incident).
  if (isWavesAutoAckReply(email.subject)) {
    return flagLeadNeedsReview(email, classification, 'waves_auto_ack_reply');
  }

  // Guard: a reply on a thread we already processed without producing a
  // lead should not mint one now.
  if (email.gmail_thread_id) {
    const priorProcessed = await db('emails')
      .where('gmail_thread_id', email.gmail_thread_id)
      .whereNot('id', email.id)
      .whereNotNull('classification')
      .first();
    if (priorProcessed) {
      const priorLead = await db('emails')
        .where('gmail_thread_id', email.gmail_thread_id)
        .whereNot('id', email.id)
        .whereNotNull('lead_id')
        .first();
      if (!priorLead) {
        return flagLeadNeedsReview(email, classification, 'reply_thread_no_prior_lead');
      }
    }
  }

  // Guard: confidence floor (missing/garbled confidence counts as below).
  const confidence = Number(classification.confidence);
  if (!Number.isFinite(confidence) || confidence < leadMinConfidence()) {
    return flagLeadNeedsReview(email, classification, 'low_confidence');
  }

  // Guard: an automated sender only becomes a lead when the classifier
  // extracted a real contact (an email different from the automated
  // from_address, or a phone number).
  if (automatedSender && !extractedRealEmail && !phoneLast10(extracted.phone)) {
    return flagLeadNeedsReview(email, classification, 'automated_sender_no_contact');
  }

  const nameParts = (extracted.person_name || email.from_name || '').split(' ');
  const firstName = nameParts[0] || 'Unknown';
  const lastName = nameParts.slice(1).join(' ') || '';

  const [lead] = await db('leads').insert({
    first_name: firstName,
    last_name: lastName,
    // Never store an automated from_address as the lead's contact email.
    email: automatedSender ? extractedRealEmail : (extracted.email || email.from_address),
    phone: extracted.phone || null,
    address: extracted.address || null,
    service_interest: extracted.service_interest || 'General inquiry',
    lead_type: 'email_inquiry',
    status: 'new',
    first_contact_at: email.received_at,
    first_contact_channel: 'email',
  }).returning('*');

  await db('emails').where({ id: email.id }).update({
    lead_id: lead.id,
    auto_action: 'lead_created',
    updated_at: new Date(),
  });

  await db('lead_activities').insert({
    lead_id: lead.id,
    activity_type: 'created',
    description: `Lead auto-created from email: "${email.subject}"`,
    performed_by: 'Email Classifier',
  });

  // Notification
  try {
    await db('notifications').insert({
      recipient_type: 'admin',
      category: 'new_lead',
      title: `New lead from email: ${firstName} ${lastName}`,
      body: classification.summary || email.subject,
      icon: '\uD83D\uDCE7',
      link: '/admin/email',
      metadata: JSON.stringify({ emailId: email.id, leadId: lead.id }),
    });
  } catch (e) { /* non-critical */ }

  logger.info(`[email-actions] Lead created: ${lead.id} — ${extracted.service_interest || 'general'}`);
  return { action: 'lead_created', leadId: lead.id };
}

async function handleCustomerRequest(email, classification) {
  let customer = await db('customers').where('email', email.from_address).first();

  if (!customer && email.from_name) {
    const parts = email.from_name.split(' ');
    if (parts.length >= 2) {
      customer = await db('customers').where(function () {
        this.whereILike('first_name', `%${parts[0]}%`)
          .andWhereILike('last_name', `%${parts[parts.length - 1]}%`);
      }).first();
    }
  }

  if (customer) {
    await db('emails').where({ id: email.id }).update({
      customer_id: customer.id,
      auto_action: 'matched_to_customer',
      updated_at: new Date(),
    });
  }
}

async function handleComplaint(email, classification) {
  // Match customer
  let customer = await db('customers').where('email', email.from_address).first();
  if (!customer && email.from_name) {
    const parts = email.from_name.split(' ');
    if (parts.length >= 2) {
      customer = await db('customers').where(function () {
        this.whereILike('first_name', `%${parts[0]}%`)
          .andWhereILike('last_name', `%${parts[parts.length - 1]}%`);
      }).first();
    }
  }

  await db('emails').where({ id: email.id }).update({
    customer_id: customer?.id || null,
    is_starred: true,
    auto_action: 'complaint_flagged',
    updated_at: new Date(),
  });

  try { await gmailClient.modifyLabels(email.gmail_id, ['STARRED'], []); } catch (e) { /* non-critical */ }

  // Urgent notification
  try {
    await db('notifications').insert({
      recipient_type: 'admin',
      category: 'email_alert',
      title: `Complaint from ${email.from_name || email.from_address}`,
      body: classification.summary || email.subject,
      icon: '\u26A0\uFE0F',
      link: '/admin/email',
      metadata: JSON.stringify({ emailId: email.id, customerId: customer?.id }),
    });
  } catch (e) { /* non-critical */ }

  logger.warn(`[email-actions] COMPLAINT: ${email.from_address} — "${email.subject}"`);
}

async function handleVendorInvoice(email, classification) {
  const { processVendorInvoice } = require('./invoice-processor');
  await processVendorInvoice(email, classification);
}

async function handleVendorComm(email) {
  const domain = email.from_address?.split('@')[1];
  const vendor = domain ? await db('vendor_email_domains').where('domain', domain).first() : null;
  await db('emails').where({ id: email.id }).update({
    auto_action: vendor ? `vendor_tagged:${vendor.vendor_name}` : 'vendor_unmatched',
    updated_at: new Date(),
  });
}

module.exports = {
  executeAutoAction,
  // Exported for unit testing the operational-sender guard
  shouldSkipAutoAction,
  // Exported for unit testing the lead-creation guards
  handleLeadInquiry,
  isHardSkippedLeadSender,
  isAutomatedSender,
  isWavesAutoAckReply,
  LEAD_HARD_SKIP_SENDERS,
  DEFAULT_LEAD_MIN_CONFIDENCE,
};
