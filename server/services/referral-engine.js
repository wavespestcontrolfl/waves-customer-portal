/**
 * Referral Engine — unified referral program logic
 * Bridges the 007 referrals table with 054 referral_promoters table.
 */
const db = require('../models/db');
const logger = require('./logger');
const crypto = require('crypto');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('./sms-template-renderer');
const { postCreditMovement, round2 } = require('./customer-credit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${digits}`;
}

function generateCode(len = 8) {
  // Crypto-strong, unambiguous alphabet (no I/O/0/1).
  // 32^8 ≈ 1.1 trillion — infeasible to brute-force.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(len);
  let code = '';
  for (let i = 0; i < len; i++) code += chars[buf[i] % chars.length];
  return code;
}

const FALLBACK_REFERRAL_BASE_URL = 'https://portal.wavespestcontrol.com/r/';
const FALLBACK_PORTAL_HOME_URL = 'https://portal.wavespestcontrol.com';
const DEFAULT_REFERRAL_BASE_URL = process.env.REFERRAL_BASE_URL
  || process.env.PORTAL_REFERRAL_BASE_URL
  || FALLBACK_REFERRAL_BASE_URL;

function normalizeReferralBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim() || DEFAULT_REFERRAL_BASE_URL;
  try {
    const url = new URL(raw.endsWith('/') ? raw : `${raw}/`);
    if (url.hostname === 'wavespestcontrol.com' || url.hostname === 'www.wavespestcontrol.com') {
      url.hostname = 'portal.wavespestcontrol.com';
      url.protocol = 'https:';
    }
    if (!url.pathname.startsWith('/r/')) url.pathname = '/r/';
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return FALLBACK_REFERRAL_BASE_URL;
  }
}

function referralLinkForCode(code, baseUrl) {
  return `${normalizeReferralBaseUrl(baseUrl)}${code}`;
}

function referralCodeFromLink(link) {
  try {
    const url = new URL(String(link || '').trim());
    const match = url.pathname.match(/^\/r\/([^/]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function linkUsesReferralRoute(link) {
  try {
    const url = new URL(String(link || '').trim());
    return url.pathname === '/r' || url.pathname.startsWith('/r/');
  } catch {
    return false;
  }
}

function getPromoterReferralLink(promoter, settings = {}) {
  const current = String(promoter?.referral_link || '').trim();
  const currentCode = referralCodeFromLink(current);
  const code = String(promoter?.referral_code || currentCode || '').trim();
  if (!code) return FALLBACK_PORTAL_HOME_URL;
  if (current && !/^https?:\/\/(www\.)?wavespestcontrol\.com\/r\//i.test(current)) {
    if (currentCode && currentCode !== code) return referralLinkForCode(code, settings.base_url);
    if (currentCode) return current;
    if (!linkUsesReferralRoute(current)) return current;
  }
  return referralLinkForCode(code, settings.base_url);
}

async function generateUniqueCode() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `WAVES-${generateCode(8)}`;
    const exists = await db('referral_promoters').where({ referral_code: code }).first();
    if (!exists) return code;
  }
  // Fall through with a longer code if (extremely unlikely) we collided 5x
  return `WAVES-${generateCode(12)}`;
}

function templateReplace(template, vars) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
}

async function renderReferralSms(templateKey, vars, legacyTemplate, context = {}) {
  if (legacyTemplate) return templateReplace(legacyTemplate, vars);
  return renderRequiredSmsTemplate(templateKey, vars, context);
}

async function sendSMS(to, body, options = {}) {
  try {
    const result = await sendCustomerMessage({
      to,
      body,
      channel: 'sms',
      audience: options.customerId ? 'customer' : 'lead',
      purpose: 'referral',
      customerId: options.customerId || undefined,
      identityTrustLevel: options.customerId ? 'phone_matches_customer' : 'phone_provided_unverified',
      consentBasis: options.consentBasis,
      entryPoint: options.entryPoint || 'referral_engine',
      metadata: {
        original_message_type: options.messageType || 'referral',
        referral_id: options.referralId,
        promoter_id: options.promoterId,
      },
    });
    if (!result.sent) {
      logger.warn(`[ReferralEngine] SMS blocked/failed (code=${result.code || 'UNKNOWN'} auditLogId=${result.auditLogId || 'n/a'})`);
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`[ReferralEngine] SMS failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. enrollPromoter
// ---------------------------------------------------------------------------
async function enrollPromoter(customerId) {
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) throw new Error('Customer not found');
  const settings = await getSettings();

  // Check if already enrolled
  const existing = await db('referral_promoters').where({ customer_id: customerId }).first();
  if (existing) {
    let code = String(existing.referral_code || customer.referral_code || referralCodeFromLink(existing.referral_link) || '').trim();
    if (!code) {
      code = await generateUniqueCode();
    } else {
      const conflict = await db('referral_promoters')
        .where({ referral_code: code })
        .where('id', '!=', existing.id)
        .first();
      if (conflict) code = await generateUniqueCode();
    }

    const referralLink = getPromoterReferralLink({ ...existing, referral_code: code }, settings);
    const updates = {};
    if (!existing.referral_code || existing.referral_code !== code) updates.referral_code = code;
    if (existing.referral_link !== referralLink) updates.referral_link = referralLink;
    if (Object.keys(updates).length) {
      updates.updated_at = new Date();
      await db('referral_promoters').where({ id: existing.id }).update(updates);
    }
    if (!customer.referral_code) {
      await db('customers').where({ id: customerId }).update({ referral_code: code });
    }

    return { promoter: { ...existing, ...updates, referral_code: code, referral_link: referralLink }, alreadyEnrolled: true };
  }

  const code = customer.referral_code || (await generateUniqueCode());
  const link = referralLinkForCode(code, settings.base_url);

  // Ensure customer has a referral_code
  if (!customer.referral_code) {
    await db('customers').where({ id: customerId }).update({ referral_code: code });
  }

  const [promoter] = await db('referral_promoters').insert({
    customer_phone: customer.phone || '',
    customer_email: customer.email || '',
    first_name: customer.first_name || '',
    last_name: customer.last_name || '',
    customer_id: customerId,
    referral_code: code,
    referral_link: link,
    campaign: 'customer',
    status: 'active',
  }).returning('*');

  logger.info(`[ReferralEngine] Enrolled promoter ${promoter.id} for customer ${customerId}`);
  return { promoter, alreadyEnrolled: false };
}

// ---------------------------------------------------------------------------
// 2. submitReferral
// ---------------------------------------------------------------------------
async function submitReferral(promoterId, { name, phone, email, address, notes, source = 'portal' }) {
  if (!name || !phone) throw new Error('Name and phone are required');

  // Strip control chars + HTML angle brackets so referral data can never carry
  // injected markup into admin views or future SMS/email templates.
  const sanitize = (s, max = 200) => String(s || '').replace(/[<>\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
  name = sanitize(name, 100);
  phone = sanitize(phone, 32);
  email = email ? sanitize(email, 254) : null;
  address = address ? sanitize(address, 300) : null;
  notes = notes ? sanitize(notes, 500) : null;

  if (!name) throw new Error('Name is required');

  const normalizedPhone = normalizePhone(phone);
  const promoter = await db('referral_promoters').where({ id: promoterId }).first();
  if (!promoter) throw new Error('Promoter not found');

  const settings = await getSettings();
  const referralLink = getPromoterReferralLink(promoter, settings);

  // --- Fraud checks ---

  // Monthly cap
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthCount = await db('referrals')
    .where({ promoter_id: promoterId })
    .where('created_at', '>=', monthStart)
    .count('* as c')
    .first();
  if (parseInt(monthCount.c) >= settings.max_referrals_per_month) {
    throw new Error(`Monthly referral limit reached (${settings.max_referrals_per_month})`);
  }

  // Duplicate phone (same promoter)
  const dupCheck = await db('referrals')
    .where({ promoter_id: promoterId })
    .where(function () {
      this.where('referee_phone', normalizedPhone)
        .orWhere('referee_phone', phone.trim());
    })
    .first();
  if (dupCheck) throw new Error('You have already referred this phone number');

  // Self-referral — check phone (any format), email, AND existing customer link
  const promoterCustomer = promoter.customer_id
    ? await db('customers').where({ id: promoter.customer_id }).first()
    : null;
  const promoterPhone = normalizePhone(promoter.customer_phone || promoterCustomer?.phone);
  const promoterEmail = (promoter.customer_email || promoterCustomer?.email || '').toLowerCase().trim();
  const refEmailLc = (email || '').toLowerCase().trim();
  if (promoterPhone && promoterPhone === normalizedPhone) {
    throw new Error('Cannot refer yourself');
  }
  if (promoterEmail && refEmailLc && promoterEmail === refEmailLc) {
    throw new Error('Cannot refer yourself');
  }

  // Already a customer (lookup by phone OR email — either disqualifies)
  const existingCustomer = await db('customers')
    .where(function () {
      this.where('phone', normalizedPhone).orWhere('phone', phone.trim());
      if (refEmailLc) this.orWhereRaw('LOWER(email) = ?', [refEmailLc]);
    })
    .first();
  if (existingCustomer) {
    // Block self-referral via second account (same person, different phone+email)
    if (promoter.customer_id && existingCustomer.id === promoter.customer_id) {
      throw new Error('Cannot refer yourself');
    }
    throw new Error('This person is already a Waves customer');
  }

  // --- Create referral in the 007 referrals table ---
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ');

  const [referral] = await db('referrals').insert({
    referrer_customer_id: promoter.customer_id,
    referee_name: name.trim(),
    referee_phone: normalizedPhone || phone.trim(),
    referee_email: email?.trim() || null,
    referral_code: promoter.referral_code,
    status: 'pending',
    source: source,
    promoter_id: promoterId,
    referrer_reward_amount: settings.referrer_reward_cents / 100,
    referrer_reward_status: 'pending',
  }).returning('*');

  // --- Create lead via lead-attribution ---
  let leadId = null;
  try {
    const [lead] = await db('leads').insert({
      first_name: firstName,
      last_name: lastName || null,
      phone: normalizedPhone || phone.trim(),
      email: email?.trim() || null,
      address: address?.trim() || null,
      lead_type: 'referral',
      service_interest: null,
      first_contact_at: new Date(),
      first_contact_channel: 'referral',
      status: 'new',
    }).returning('*');
    leadId = lead.id;

    await db('referrals').where({ id: referral.id }).update({ lead_id: leadId });

    // Log lead activity
    await db('lead_activities').insert({
      lead_id: leadId,
      activity_type: 'created',
      description: `Referral lead from promoter ${promoter.first_name} ${promoter.last_name}`,
      performed_by: 'system',
    });
  } catch (err) {
    logger.warn(`[ReferralEngine] Lead creation failed: ${err.message}`);
  }

  // --- Update promoter stats ---
  await db('referral_promoters').where({ id: promoterId }).increment({
    total_referrals_sent: 1,
  }).update({
    last_referral_at: new Date(),
    updated_at: new Date(),
  });

  // --- Send invite SMS ---
  const smsBody = await renderReferralSms('referral_invite', {
    referee_name: firstName,
    referrer_name: promoter.first_name || 'your neighbor',
    referral_link: referralLink,
  }, settings.invite_sms_template, {
    workflow: 'referral_invite',
    entity_type: 'referral',
    entity_id: referral.id,
  });
  const smsSent = await sendSMS(normalizedPhone || phone.trim(), smsBody, {
    messageType: 'referral_invite',
    referralId: referral.id,
    promoterId,
    consentBasis: {
      status: 'transactional_allowed',
      source: 'referral_submission',
      capturedAt: new Date().toISOString(),
    },
    entryPoint: 'referral_engine_invite',
  });

  if (smsSent) {
    await db('referrals').where({ id: referral.id }).update({ status: 'contacted' });
  } else {
    // Don't silently leave as "pending" — surface the failure so admin can retry.
    await db('referrals').where({ id: referral.id }).update({ status: 'sms_failed' }).catch(() => {});
  }

  logger.info(`[ReferralEngine] Referral ${referral.id} submitted by promoter ${promoterId}`);
  return { ...referral, lead_id: leadId, status: smsSent ? 'contacted' : 'sms_failed', sms_sent: smsSent };
}

// ---------------------------------------------------------------------------
// 3. convertReferral
// ---------------------------------------------------------------------------
async function convertReferral(referralId, { customerId, tier, monthlyValue }) {
  const settings = await getSettings();

  // Calculate reward (base + tier bonus)
  let rewardCents = settings.referrer_reward_cents;
  if (tier) {
    const tierKey = `bonus_${tier.toLowerCase()}_cents`;
    if (settings[tierKey]) rewardCents += settings[tierKey];
  }
  const rewardDollars = rewardCents / 100;

  // Money-critical section. Lock the referral row and only credit when it is still in a
  // pre-conversion state, so a double-click / retry that hits convert twice can no longer
  // credit the promoter balance twice. The referral flip + balance increment commit together.
  const CONVERTIBLE_STATUSES = ['pending', 'contacted', 'sms_failed', 'estimated'];
  const outcome = await db.transaction(async (trx) => {
    const referral = await trx('referrals').where({ id: referralId }).forUpdate().first();
    if (!referral) throw new Error('Referral not found');

    // Idempotency guard: anything already converted/rejected/lost is a no-op (no re-credit).
    if (!CONVERTIBLE_STATUSES.includes(referral.status)) {
      return { referral, alreadyConverted: true };
    }

    const updates = {
      status: 'signed_up',
      converted_at: new Date(),
      referrer_reward_amount: rewardDollars,
      converted_tier: tier || null,
      converted_monthly_value: monthlyValue || null,
      referrer_reward_status: settings.require_service_completion ? 'pending_service' : 'earned',
      updated_at: new Date(),
    };
    await trx('referrals').where({ id: referralId }).update(updates);

    let milestoneAward = null;
    if (referral.promoter_id) {
      const promoterUpdates = { total_referrals_converted: 1 };
      if (settings.require_service_completion) {
        // Goes to pending earnings until first service
        await trx('referral_promoters').where({ id: referral.promoter_id })
          .increment({ ...promoterUpdates, pending_earnings_cents: rewardCents, total_earned_cents: rewardCents });
      } else {
        // Credit immediately
        await trx('referral_promoters').where({ id: referral.promoter_id })
          .increment({ ...promoterUpdates, available_balance_cents: rewardCents, total_earned_cents: rewardCents, referral_balance_cents: rewardCents });
      }
      // Award any milestone bonus inside the SAME transaction, serialized by the
      // promoter row lock — atomic with the conversion, so it can't be double-paid
      // by a concurrent conversion and can't be skipped by a post-commit retry.
      milestoneAward = await applyMilestone(trx, referral.promoter_id, settings);
    }

    return { referral, alreadyConverted: false, milestoneAward };
  });

  if (outcome.alreadyConverted) {
    logger.info(`[ReferralEngine] Referral ${referralId} already converted (status=${outcome.referral.status}); skipping re-credit.`);
    return {
      referralId,
      alreadyConverted: true,
      status: outcome.referral.status,
      rewardCents: 0,
      rewardDollars: 0,
      tier,
      requiresServiceCompletion: settings.require_service_completion,
    };
  }

  const referral = outcome.referral;

  // Post-commit side effects — NON money-critical (the milestone award already
  // committed in the transaction above). Wrapped so a transient failure here can't
  // bubble a 500: on retry the admin would hit the alreadyConverted no-op and these
  // would be skipped for good.
  //
  // Reward SMS routing depends on WHEN the reward is earned:
  //  - require_service_completion ON  → deferred: the referrer's reward SMS + the
  //    real money are issued when the referee completes their first recurring
  //    service (see creditReferralOnFirstService).
  //  - require_service_completion OFF → immediate: the promoter was already
  //    credited in the transaction above and never reaches that helper, so the
  //    reward SMS must be sent here or the immediate-earned referrer is paid silently.
  if (referral.promoter_id && (outcome.milestoneAward || !settings.require_service_completion)) {
    try {
      const promoter = await db('referral_promoters').where({ id: referral.promoter_id }).first();
      if (promoter) {
        if (!settings.require_service_completion && promoter.customer_phone) {
          const rewardSms = await renderReferralSms('referral_reward', {
            referrer_name: promoter.first_name,
            referee_name: referral.referee_name || referral.referral_first_name || 'your friend',
            reward_amount: `$${Math.round(rewardDollars)}`,
          }, settings.reward_sms_template, {
            workflow: 'referral_reward',
            entity_type: 'referral',
            entity_id: referral.id,
          });
          await sendSMS(promoter.customer_phone, rewardSms, {
            customerId: promoter.customer_id,
            messageType: 'referral_reward',
            referralId: referral.id,
            promoterId: promoter.id,
            entryPoint: 'referral_engine_convert',
          });
        }
        if (outcome.milestoneAward) {
          await sendMilestoneSms(promoter, outcome.milestoneAward, settings);
        }
      }
    } catch (sideErr) {
      logger.warn(`[ReferralEngine] convert post-commit notify failed for referral ${referral.id}: ${sideErr.message}`);
    }
  }

  // Mark lead as converted if lead_id exists (best-effort; idempotent).
  if (referral.lead_id) {
    try {
      const leadAttribution = require('./lead-attribution');
      await leadAttribution.markConverted(referral.lead_id, {
        customerId,
        monthlyValue,
        waveguardTier: tier,
      });
    } catch (err) {
      logger.warn(`[ReferralEngine] Lead conversion update failed: ${err.message}`);
    }
  }

  logger.info(`[ReferralEngine] Referral ${referralId} converted. Reward: $${rewardDollars}`);
  return { referralId, rewardCents, rewardDollars, tier, requiresServiceCompletion: settings.require_service_completion };
}

// ---------------------------------------------------------------------------
// 4. confirmFirstService
// ---------------------------------------------------------------------------
async function confirmFirstService(customerId) {
  // Find referral where the converted customer matches
  const referral = await db('referrals')
    .where(function () {
      this.where('referee_phone', '!=', '').whereIn('status', ['signed_up']);
    })
    .where('first_service_completed', false)
    .first();

  // Try by customer lookup
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return null;

  const normalizedPhone = normalizePhone(customer.phone);
  const matchedReferral = await db('referrals')
    .whereIn('status', ['signed_up'])
    .where('first_service_completed', false)
    .where(function () {
      this.where('referee_phone', customer.phone)
        .orWhere('referee_phone', normalizedPhone);
    })
    .first();

  if (!matchedReferral) return null;

  const settings = await getSettings();
  const rewardCents = Math.round((matchedReferral.referrer_reward_amount || 50) * 100);

  // Update referral
  await db('referrals').where({ id: matchedReferral.id }).update({
    first_service_completed: true,
    referrer_reward_status: 'earned',
    status: 'credited',
    updated_at: new Date(),
  });

  // Move pending to available for promoter
  if (matchedReferral.promoter_id) {
    await db('referral_promoters').where({ id: matchedReferral.promoter_id }).update({
      available_balance_cents: db.raw('available_balance_cents + ?', [rewardCents]),
      pending_earnings_cents: db.raw('GREATEST(pending_earnings_cents - ?, 0)', [rewardCents]),
      referral_balance_cents: db.raw('referral_balance_cents + ?', [rewardCents]),
      updated_at: new Date(),
    });

    // Auto-credit if enabled
    if (settings.auto_credit_enabled) {
      logger.info(`[ReferralEngine] Auto-credited $${(rewardCents / 100).toFixed(2)} to promoter ${matchedReferral.promoter_id}`);
    }
  }

  logger.info(`[ReferralEngine] First service confirmed for referral ${matchedReferral.id}`);
  return { referralId: matchedReferral.id, promoterId: matchedReferral.promoter_id, rewardCents };
}

// ---------------------------------------------------------------------------
// 4b. creditReferralOnFirstService — issue the real $25-each account credits
// ---------------------------------------------------------------------------
// Called from the service-completion flow. When a referred customer who signed
// up for a RECURRING plan completes their first service, BOTH the referrer and
// the referee get a $25 account credit via the customer-credit ledger (the real
// reward — the promoter balance / payout columns are tracking only). A one-time
// service never qualifies. Idempotent: the referral's first_service_completed
// flag is the single-use guard, re-checked under a row lock.
async function creditReferralOnFirstService({ customerId, serviceId }) {
  if (!customerId || !serviceId) return null;

  const customer = await db('customers').where({ id: customerId }).first('id', 'phone', 'first_name');
  if (!customer || !customer.phone) return null;

  // Qualify on the EXACT visit that just completed — not customer-level
  // membership. The reward is for completing a *recurring* service, so a
  // one-time visit (or a customer who merely also holds a recurring plan) must
  // never earn it or burn the single-use guard. Callers only invoke this for a
  // genuinely performed completion (not an inspection/decline/incomplete), so
  // here we only need to confirm THIS visit belongs to the customer + recurs.
  const visit = await db('scheduled_services')
    .where({ id: serviceId, customer_id: customerId })
    .first('id', 'is_recurring', 'recurring_pattern');
  if (!visit || !(visit.is_recurring || visit.recurring_pattern)) return null;

  const normalizedPhone = normalizePhone(customer.phone);
  // Phone predicate reused for the match and the sibling-dedupe sweep.
  const matchesPhone = function () {
    this.where('referee_phone', customer.phone).orWhere('referee_phone', normalizedPhone);
  };

  // Map the completing customer back to the referral that brought them in (by
  // phone — the referee's customer_id is not persisted on the referral row).
  // Only referrals still awaiting service completion ('pending_service') qualify:
  // immediately-earned referrals (require_service_completion=off) were already
  // paid to the promoter balance at conversion and must not double-pay here.
  const candidate = await db('referrals')
    .where('status', 'signed_up')
    .where('first_service_completed', false)
    .where('referrer_reward_status', 'pending_service')
    .where(matchesPhone)
    .orderBy('created_at', 'asc')
    .first('id');
  if (!candidate) return null;

  const settings = await getSettings();
  const refereeCents = Number(settings.referee_discount_cents) || 0;
  const refereeDollars = round2(refereeCents / 100);

  const outcome = await db.transaction(async (trx) => {
    // Re-read under lock; these guards are the single-use protection.
    const referral = await trx('referrals').where({ id: candidate.id }).forUpdate().first();
    if (!referral
      || referral.first_service_completed
      || referral.status !== 'signed_up'
      || referral.referrer_reward_status !== 'pending_service') {
      return { skipped: true };
    }

    // Use the reward amount FROZEN on the referral at conversion (base + any tier
    // bonus) — not the current setting — so a settings change between signup and
    // first service can't over/under-credit, and the pending drain matches exactly.
    // Finite-check (not `||`) so an intentional $0.00 frozen reward stays $0,
    // rather than falling through to the current setting.
    const frozenReward = Number(referral.referrer_reward_amount);
    const referrerDollars = round2(Number.isFinite(frozenReward)
      ? frozenReward
      : ((Number(settings.referrer_reward_cents) / 100) || 0));
    const referrerCents = Math.round(referrerDollars * 100);

    // Referee — the customer who just completed their first recurring service.
    if (refereeDollars > 0) {
      await postCreditMovement({
        customerId,
        delta: refereeDollars,
        source: 'referral',
        referralId: referral.id,
        note: 'Referral welcome credit — first recurring service completed',
        createdBy: 'referral_engine',
      }, trx);
    }

    // Referrer — the customer whose share link brought them in.
    if (referrerDollars > 0 && referral.referrer_customer_id) {
      await postCreditMovement({
        customerId: referral.referrer_customer_id,
        delta: referrerDollars,
        source: 'referral',
        referralId: referral.id,
        note: `Referral reward — ${customer.first_name || 'your referral'} completed their first service`,
        createdBy: 'referral_engine',
      }, trx);
    }

    // Mark the matched referral rewarded (single-use) + legacy credited flags.
    await trx('referrals').where({ id: referral.id }).update({
      first_service_completed: true,
      referrer_reward_status: 'earned',
      referee_credited: true,
      referrer_credited: true,
      status: 'credited',
      updated_at: new Date(),
    });

    // De-dupe: a referee phone can carry multiple signed_up referrals
    // (submitReferral only dedupes per promoter). Reward exactly once per
    // referee — retire the other uncredited signed_up referrals for this phone
    // so a later completion can't pay the referee (or a second referrer) again.
    // Scope to 'pending_service' ONLY: an immediately-earned referral
    // (require_service_completion off) is also status='signed_up' +
    // first_service_completed=false but was already paid at conversion — it must
    // not be clobbered to 'superseded', which would corrupt reward history.
    const supersededSiblings = await trx('referrals')
      .whereNot('id', referral.id)
      .where('status', 'signed_up')
      .where('first_service_completed', false)
      .where('referrer_reward_status', 'pending_service')
      .where(matchesPhone)
      .select('id', 'promoter_id', 'referrer_reward_amount');

    if (supersededSiblings.length) {
      await trx('referrals')
        .whereIn('id', supersededSiblings.map((s) => s.id))
        .update({
          first_service_completed: true,
          referrer_reward_status: 'superseded',
          updated_at: new Date(),
        });

      // Each sibling's promoter had pending_earnings_cents AND total_earned_cents
      // staged at conversion (convertReferral, require_service_completion path).
      // A superseded reward can never pay, so unwind BOTH staked counters or the
      // promoter keeps stale pending/earned for money they'll never receive.
      // (submitReferral dedupes per promoter, so siblings have distinct promoters
      // and never collide with the winning referral's promoter; group defensively.)
      const drainByPromoter = new Map();
      for (const s of supersededSiblings) {
        if (!s.promoter_id) continue;
        const cents = Math.round((Number(s.referrer_reward_amount) || 0) * 100);
        if (cents <= 0) continue;
        drainByPromoter.set(s.promoter_id, (drainByPromoter.get(s.promoter_id) || 0) + cents);
      }
      for (const [promoterId, cents] of drainByPromoter) {
        await trx('referral_promoters').where({ id: promoterId }).update({
          pending_earnings_cents: db.raw('GREATEST(pending_earnings_cents - ?, 0)', [cents]),
          total_earned_cents: db.raw('GREATEST(total_earned_cents - ?, 0)', [cents]),
          updated_at: new Date(),
        });
      }
    }

    // Promoter bookkeeping: drain the exact pending amount staged at conversion.
    if (referral.promoter_id) {
      await trx('referral_promoters').where({ id: referral.promoter_id }).update({
        pending_earnings_cents: db.raw('GREATEST(pending_earnings_cents - ?, 0)', [referrerCents]),
        updated_at: new Date(),
      });
    }

    return { skipped: false, referral, referrerDollars };
  });

  if (outcome.skipped) return null;

  // Post-commit: notify the referrer their reward landed (non-critical).
  if (outcome.referral.promoter_id) {
    try {
      const promoter = await db('referral_promoters').where({ id: outcome.referral.promoter_id }).first();
      if (promoter && promoter.customer_phone) {
        const rewardSms = await renderReferralSms('referral_reward', {
          referrer_name: promoter.first_name,
          referee_name: outcome.referral.referee_name || outcome.referral.referral_first_name || 'your friend',
          reward_amount: `$${Math.round(outcome.referrerDollars)}`,
        }, settings.reward_sms_template, {
          workflow: 'referral_reward',
          entity_type: 'referral',
          entity_id: outcome.referral.id,
        });
        await sendSMS(promoter.customer_phone, rewardSms, {
          customerId: promoter.customer_id,
          messageType: 'referral_reward',
          referralId: outcome.referral.id,
          promoterId: promoter.id,
          entryPoint: 'referral_engine_first_service',
        });
      }
    } catch (smsErr) {
      logger.warn(`[ReferralEngine] reward SMS failed for referral ${outcome.referral.id}: ${smsErr.message}`);
    }
  }

  logger.info(`[ReferralEngine] First recurring service for customer ${customerId} → credited referral ${outcome.referral.id}: referrer $${outcome.referrerDollars}, referee $${refereeDollars}`);
  return { referralId: outcome.referral.id, referrerDollars: outcome.referrerDollars, refereeDollars };
}

// ---------------------------------------------------------------------------
// 5. checkMilestones
// ---------------------------------------------------------------------------
// Award a milestone bonus inside an EXISTING transaction. Locks the promoter
// row with forUpdate() and re-reads the level under the lock, so concurrent
// conversions for the same promoter serialize and a threshold can't be crossed
// (and paid) twice. Money-critical — never run this outside a transaction.
// Returns the award { promoter, newLevel, bonusCents, converted } or null. No SMS.
async function applyMilestone(trx, promoterId, settings) {
  const promoter = await trx('referral_promoters').where({ id: promoterId }).forUpdate().first();
  if (!promoter) return null;

  const converted = promoter.total_referrals_converted;
  const currentLevel = promoter.milestone_level || 'none';

  let newLevel = currentLevel;
  let bonusCents = 0;

  if (converted >= 10 && currentLevel !== 'champion') {
    newLevel = 'champion';
    bonusCents = settings.milestone_10_bonus_cents;
  } else if (converted >= 5 && !['champion', 'ambassador'].includes(currentLevel)) {
    newLevel = 'ambassador';
    bonusCents = settings.milestone_5_bonus_cents;
  } else if (converted >= 3 && !['champion', 'ambassador', 'advocate'].includes(currentLevel)) {
    newLevel = 'advocate';
    bonusCents = settings.milestone_3_bonus_cents;
  }

  if (newLevel === currentLevel) return null;

  await trx('referral_promoters').where({ id: promoterId }).update({
    milestone_level: newLevel,
    milestone_earned_at: new Date(),
    available_balance_cents: trx.raw('available_balance_cents + ?', [bonusCents]),
    total_earned_cents: trx.raw('total_earned_cents + ?', [bonusCents]),
    referral_balance_cents: trx.raw('referral_balance_cents + ?', [bonusCents]),
    updated_at: new Date(),
  });

  return { promoter, newLevel, bonusCents, converted };
}

// Best-effort milestone SMS (post-commit; never throws into a caller).
async function sendMilestoneSms(promoter, award, settings) {
  const milestoneSms = await renderReferralSms('referral_milestone', {
    referrer_name: promoter.first_name,
    milestone_level: award.newLevel,
    count: String(award.converted),
    bonus_amount: 'a bonus reward',
  }, settings.milestone_sms_template, {
    workflow: 'referral_milestone',
    entity_type: 'referral_promoter',
    entity_id: promoter.id,
  });
  await sendSMS(promoter.customer_phone, milestoneSms, {
    customerId: promoter.customer_id,
    messageType: 'referral_milestone',
    promoterId: promoter.id,
    entryPoint: 'referral_engine_milestone',
  });
}

async function checkMilestones(promoterId) {
  const settings = await getSettings();
  const award = await db.transaction((trx) => applyMilestone(trx, promoterId, settings));
  if (!award) return null;

  try {
    await sendMilestoneSms(award.promoter, award, settings);
  } catch (smsErr) {
    logger.warn(`[ReferralEngine] milestone SMS failed for promoter ${promoterId}: ${smsErr.message}`);
  }

  logger.info(`[ReferralEngine] Promoter ${promoterId} reached ${award.newLevel} milestone. Bonus: $${(award.bonusCents / 100).toFixed(2)}`);
  return { promoterId, newLevel: award.newLevel, bonusCents: award.bonusCents };
}

// ---------------------------------------------------------------------------
// 6. getSettings
// ---------------------------------------------------------------------------
async function getSettings() {
  try {
    const row = await db('referral_program_settings').where({ id: 1 }).first();
    if (row) return { ...row, base_url: normalizeReferralBaseUrl(row.base_url) };
  } catch { /* table may not exist yet */ }

  // Defaults
  return {
    program_active: true,
    base_url: normalizeReferralBaseUrl(DEFAULT_REFERRAL_BASE_URL),
    referrer_reward_cents: 5000,
    referee_discount_cents: 2500,
    bonus_silver_cents: 5000,
    bonus_gold_cents: 7500,
    bonus_platinum_cents: 10000,
    milestone_3_bonus_cents: 2500,
    milestone_5_bonus_cents: 5000,
    milestone_10_bonus_cents: 10000,
    min_payout_cents: 1000,
    auto_credit_enabled: true,
    require_service_completion: true,
    max_referrals_per_month: 20,
    cooldown_days: 30,
    invite_sms_template: null,
    reward_sms_template: null,
    milestone_sms_template: null,
  };
}

// ---------------------------------------------------------------------------
// 7. updateSettings
// ---------------------------------------------------------------------------
async function updateSettings(updates) {
  const allowed = [
    'program_active', 'base_url', 'referrer_reward_cents', 'referee_discount_cents',
    'bonus_silver_cents', 'bonus_gold_cents', 'bonus_platinum_cents',
    'milestone_3_bonus_cents', 'milestone_5_bonus_cents', 'milestone_10_bonus_cents',
    'min_payout_cents', 'auto_credit_enabled', 'require_service_completion',
    'max_referrals_per_month', 'cooldown_days',
    'invite_sms_template', 'reward_sms_template', 'milestone_sms_template',
  ];

  const filtered = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) filtered[key] = updates[key];
  }
  filtered.updated_at = new Date();

  await db('referral_program_settings').where({ id: 1 }).update(filtered);
  logger.info(`[ReferralEngine] Settings updated: ${Object.keys(filtered).join(', ')}`);
  return getSettings();
}

// ---------------------------------------------------------------------------
// 8. getPromoterStats
// ---------------------------------------------------------------------------
async function getPromoterStats(promoterId) {
  const promoter = await db('referral_promoters').where({ id: promoterId }).first();
  if (!promoter) throw new Error('Promoter not found');

  const referrals = await db('referrals')
    .where({ promoter_id: promoterId })
    .orderBy('created_at', 'desc');

  const clicks = await db('referral_clicks')
    .where({ promoter_id: promoterId })
    .count('* as total')
    .first();

  const thisMonth = new Date();
  thisMonth.setDate(1);
  thisMonth.setHours(0, 0, 0, 0);

  const monthlyReferrals = referrals.filter(r => new Date(r.created_at) >= thisMonth).length;
  const conversionRate = promoter.total_referrals_sent > 0
    ? Math.round((promoter.total_referrals_converted / promoter.total_referrals_sent) * 100)
    : 0;

  return {
    promoter,
    referrals: referrals.map(r => ({
      id: r.id,
      name: r.referee_name || `${r.referral_first_name || ''} ${r.referral_last_name || ''}`.trim(),
      status: r.status,
      rewardAmount: parseFloat(r.referrer_reward_amount || r.credit_amount || 0),
      rewardStatus: r.referrer_reward_status || (r.referrer_credited ? 'earned' : 'pending'),
      createdAt: r.created_at,
      convertedAt: r.converted_at,
    })),
    stats: {
      totalClicks: parseInt(clicks?.total || 0),
      totalReferrals: promoter.total_referrals_sent,
      totalConverted: promoter.total_referrals_converted,
      conversionRate,
      monthlyReferrals,
      totalEarned: promoter.total_earned_cents,
      availableBalance: promoter.available_balance_cents || 0,
      pendingEarnings: promoter.pending_earnings_cents || 0,
      totalPaidOut: promoter.total_paid_out_cents,
      milestoneLevel: promoter.milestone_level || 'none',
    },
  };
}

// ---------------------------------------------------------------------------
// 9. getProgramAnalytics
// ---------------------------------------------------------------------------
async function getProgramAnalytics(startDate, endDate) {
  const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate || new Date();

  const [promoterStats, referralStats, clickStats, payoutStats, topPromoters] = await Promise.all([
    db('referral_promoters')
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'active') as active"),
      ).first(),
    db('referrals')
      .where('created_at', '>=', start)
      .where('created_at', '<=', end)
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status IN ('pending','contacted','estimated','sms_failed')) as pending"),
        db.raw("COUNT(*) FILTER (WHERE status = 'signed_up' OR status = 'credited') as converted"),
        db.raw("COUNT(*) FILTER (WHERE status = 'rejected' OR lost_reason IS NOT NULL) as lost"),
        db.raw("COALESCE(SUM(CASE WHEN status IN ('signed_up','credited') THEN referrer_reward_amount ELSE 0 END), 0) as total_rewards_dollars"),
        db.raw("COALESCE(SUM(CASE WHEN status IN ('signed_up','credited') THEN converted_monthly_value ELSE 0 END), 0) as total_monthly_value"),
      ).first(),
    db('referral_clicks')
      .where('created_at', '>=', start)
      .where('created_at', '<=', end)
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE is_unique = true) as unique_clicks"),
        db.raw("COUNT(*) FILTER (WHERE converted_to_lead = true) as converted_to_lead"),
      ).first(),
    db('referral_payouts')
      .select(
        db.raw("COUNT(*) FILTER (WHERE status = 'pending') as pending"),
        db.raw("COALESCE(SUM(CASE WHEN status = 'applied' THEN amount_cents ELSE 0 END), 0) as total_paid_cents"),
      ).first(),
    db('referral_promoters')
      .where('total_referrals_converted', '>', 0)
      .orderBy('total_referrals_converted', 'desc')
      .limit(10)
      .select('id', 'first_name', 'last_name', 'total_referrals_sent', 'total_referrals_converted', 'total_earned_cents', 'milestone_level'),
  ]);

  const totalReferrals = parseInt(referralStats.total) || 0;
  const converted = parseInt(referralStats.converted) || 0;
  const totalClicks = parseInt(clickStats.total) || 0;
  const uniqueClicks = parseInt(clickStats.unique_clicks) || 0;
  const conversionRate = totalReferrals > 0 ? Math.round((converted / totalReferrals) * 100) : 0;
  const clickToReferral = uniqueClicks > 0 ? Math.round((totalReferrals / uniqueClicks) * 100) : 0;

  const totalRewardsDollars = parseFloat(referralStats.total_rewards_dollars) || 0;
  const totalMonthlyValue = parseFloat(referralStats.total_monthly_value) || 0;
  const estimatedAnnualRevenue = totalMonthlyValue * 12;
  const roi = totalRewardsDollars > 0
    ? Math.round(((estimatedAnnualRevenue - totalRewardsDollars) / totalRewardsDollars) * 100)
    : 0;

  return {
    period: { start, end },
    promoters: {
      total: parseInt(promoterStats.total),
      active: parseInt(promoterStats.active),
    },
    funnel: {
      clicks: totalClicks,
      uniqueClicks,
      referrals: totalReferrals,
      pending: parseInt(referralStats.pending) || 0,
      converted,
      lost: parseInt(referralStats.lost) || 0,
      conversionRate,
      clickToReferralRate: clickToReferral,
    },
    financial: {
      totalRewardsDollars,
      totalPaidOutCents: parseInt(payoutStats.total_paid_cents) || 0,
      pendingPayouts: parseInt(payoutStats.pending) || 0,
      totalMonthlyValue,
      estimatedAnnualRevenue,
      roi,
    },
    topPromoters: topPromoters.map(p => ({
      id: p.id,
      name: `${p.first_name} ${p.last_name}`,
      referrals: p.total_referrals_sent,
      conversions: p.total_referrals_converted,
      earned: p.total_earned_cents,
      milestone: p.milestone_level,
    })),
  };
}

module.exports = {
  enrollPromoter,
  submitReferral,
  convertReferral,
  confirmFirstService,
  creditReferralOnFirstService,
  checkMilestones,
  getSettings,
  updateSettings,
  getPromoterStats,
  getProgramAnalytics,
  getPromoterReferralLink,
  _internals: {
    normalizeReferralBaseUrl,
    referralLinkForCode,
  },
};
