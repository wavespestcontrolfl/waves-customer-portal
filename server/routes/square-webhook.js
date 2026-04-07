const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TwilioService = require('../services/twilio');
const { normalizeServiceType, cleanSquareNotes, detectServiceCategory } = require('../utils/service-normalizer');

const WAVES_FROM = '+19413187612';

// ─── TIER COMPUTATION ────────────────────────────────────────────

/**
 * Compute WaveGuard tier from active Square subscriptions.
 * 1 service = Bronze, 2 = Silver, 3 = Gold, 4+ = Platinum
 */
async function computeWaveGuardTier(customerId) {
  try {
    const subs = await db('customer_subscriptions')
      .where({ customer_id: customerId, status: 'active' })
      .count('id as cnt')
      .first();

    const count = parseInt(subs?.cnt || 0);
    if (count >= 4) return 'Platinum';
    if (count >= 3) return 'Gold';
    if (count >= 2) return 'Silver';
    return 'Bronze';
  } catch { return 'Bronze'; }
}

/**
 * Sync a subscription event to the customer_subscriptions table,
 * then recompute the customer's WaveGuard tier.
 */
async function syncSubscription(squareSubscription, eventType) {
  const sub = squareSubscription;
  if (!sub || !sub.customer_id) return;

  const customer = await db('customers')
    .where({ square_customer_id: sub.customer_id })
    .first();
  if (!customer) {
    logger.warn(`[square-webhook] Subscription event for unknown customer: ${sub.customer_id}`);
    return;
  }

  let status = 'active';
  if (sub.status === 'CANCELED' || sub.status === 'DEACTIVATED') status = 'cancelled';
  if (sub.status === 'PAUSED') status = 'paused';

  const planName = sub.plan_variation_id || sub.source?.name || '';
  const serviceType = normalizeServiceType(planName);

  const existing = await db('customer_subscriptions')
    .where({ square_subscription_id: sub.id })
    .first();

  const subData = {
    customer_id: customer.id,
    square_subscription_id: sub.id,
    square_customer_id: sub.customer_id,
    service_type: serviceType,
    status,
    start_date: sub.start_date || sub.created_at,
    monthly_amount: sub.price_override_money
      ? sub.price_override_money.amount / 100
      : null,
    updated_at: new Date(),
  };

  if (existing) {
    await db('customer_subscriptions').where({ id: existing.id }).update(subData);
  } else {
    await db('customer_subscriptions').insert({
      ...subData,
      created_at: new Date(),
    });
  }

  const newTier = await computeWaveGuardTier(customer.id);
  const oldTier = customer.waveguard_tier;

  await db('customers').where({ id: customer.id }).update({
    waveguard_tier: newTier,
    updated_at: new Date(),
  });

  if (newTier !== oldTier) {
    logger.info(`[square-webhook] Tier change: ${customer.first_name} ${customer.last_name} ${oldTier} → ${newTier}`);
    await db('activity_log').insert({
      customer_id: customer.id,
      action: 'tier_change',
      description: `WaveGuard tier changed: ${oldTier || 'None'} → ${newTier}`,
      metadata: JSON.stringify({ oldTier, newTier, triggerEvent: eventType }),
    }).catch(() => {});
  }

  return { customer, newTier, oldTier, status };
}

// ─── EMAIL AUTOMATION TRIGGERS ───────────────────────────────────

/**
 * Check and fire email automation triggers based on events.
 */
async function triggerAutomation(automationKey, customerId, metadata = {}) {
  try {
    const alreadySent = await db('email_automation_sends')
      .where({ customer_id: customerId, automation_key: automationKey })
      .first();

    if (alreadySent) {
      logger.info(`[automation] ${automationKey} already sent to customer ${customerId}, skipping`);
      return false;
    }

    await db('email_automation_sends').insert({
      customer_id: customerId,
      automation_key: automationKey,
      status: 'queued',
      metadata: JSON.stringify(metadata),
      queued_at: new Date(),
    });

    logger.info(`[automation] Queued ${automationKey} for customer ${customerId}`);

    try {
      const EmailAutomations = require('../services/email-automations');
      await EmailAutomations.processQueuedSend(customerId, automationKey);
    } catch (e) {
      logger.error(`[automation] Failed to process ${automationKey}: ${e.message}`);
    }

    return true;
  } catch (e) {
    logger.error(`[automation] Trigger failed for ${automationKey}: ${e.message}`);
    return false;
  }
}

// =========================================================================
// POST /api/webhooks/square/payment — Square payment/invoice events
//
// Replaces Zapier zaps:
//   #9  Invoice SMS — sends SMS when new unpaid invoice created
//   #14 New Payment Processing SMS — sends thank-you SMS on payment
// =========================================================================
router.post('/payment', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`[square-webhook] Event: ${event.type}`);

    // ── PAYMENT COMPLETED (#14) ──
    if (event.type === 'payment.completed') {
      const payment = event.data?.object?.payment;
      if (!payment) return res.sendStatus(200);

      const squareCustomerId = payment.customer_id;
      const amount = (payment.amount_money?.amount || 0) / 100;
      const receiptUrl = payment.receipt_url || '';

      if (squareCustomerId && amount > 0) {
        const customer = await db('customers').where({ square_customer_id: squareCustomerId }).first();

        if (customer) {
          // Record payment
          await db('payments').insert({
            customer_id: customer.id,
            amount,
            status: 'paid',
            payment_date: new Date().toISOString().split('T')[0],
            description: 'Square payment',
            metadata: JSON.stringify({ square_payment_id: payment.id, receipt_url: receiptUrl }),
          }).catch(() => {});

          // Trigger balance reminder auto-detect
          try {
            const BalanceReminder = require('../services/workflows/balance-reminder');
            await BalanceReminder.onPaymentReceived(customer.id, amount);
          } catch (e) { logger.error(`Balance auto-detect failed: ${e.message}`); }

          // Update customer's total revenue
          try {
            const currentRev = parseFloat(customer.total_revenue || 0);
            await db('customers').where({ id: customer.id }).update({
              total_revenue: currentRev + amount,
              last_payment_at: new Date(),
            });
          } catch { /* column might not exist */ }

          // Send thank-you SMS (#14)
          if (customer.phone) {
            try {
              const body = `Hello ${customer.first_name}! Thank you for your payment — we truly appreciate your business.` +
                (receiptUrl ? ` You can view your receipt here: ${receiptUrl}` : '') +
                `\n\nIf you have any questions or need assistance, simply reply to this message. Thanks again for choosing Waves!`;

              await TwilioService.sendSMS(customer.phone, body, { messageType: 'payment_confirmation' });
              logger.info(`[square-webhook] Payment SMS sent to ${customer.first_name} (${customer.phone}) for $${amount.toFixed(2)}`);
            } catch (smsErr) {
              logger.error(`[square-webhook] Payment SMS failed: ${smsErr.message}`);
            }
          }

          // In-app notifications for payment
          try {
            const NotificationService = require('../services/notification-service');
            await NotificationService.notifyAdmin('payment', `Payment received: $${amount.toFixed(2)}`, `${customer.first_name} ${customer.last_name}`, { icon: '\u{1F4B0}', link: '/admin/customers' });
            await NotificationService.notifyCustomer(customer.id, 'billing', 'Payment processed', `Your payment of $${amount.toFixed(2)} has been received.`, { icon: '\u{1F4B3}' });
          } catch (e) { logger.error(`[notifications] Payment notification failed: ${e.message}`); }

          // Log activity
          await db('activity_log').insert({
            customer_id: customer.id,
            action: 'payment_processed',
            description: `Payment received: $${amount.toFixed(2)} from ${customer.first_name} ${customer.last_name}`,
            metadata: JSON.stringify({ amount, squarePaymentId: payment.id, receiptUrl }),
          }).catch(() => {});

          logger.info(`[square-webhook] Payment processed: $${amount} from ${customer.first_name} ${customer.last_name}`);
        }
      }
    }

    // ── INVOICE CREATED / PUBLISHED (#9) ──
    if (event.type === 'invoice.created' || event.type === 'invoice.published') {
      const invoice = event.data?.object?.invoice;
      if (!invoice) return res.sendStatus(200);

      // Only send SMS for unpaid invoices
      const status = (invoice.status || '').toUpperCase();
      if (status !== 'UNPAID' && status !== 'SENT' && status !== 'SCHEDULED') {
        return res.sendStatus(200);
      }

      const recipient = invoice.primary_recipient;
      if (!recipient) return res.sendStatus(200);

      const squareCustomerId = recipient.customer_id;
      const phone = recipient.phone_number;
      const firstName = recipient.given_name || '';
      const invoiceTitle = invoice.title || 'your service';
      const publicUrl = invoice.public_url || '';
      const totalAmount = (invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0) / 100;
      const serviceDate = invoice.sale_or_service_date || '';

      // Format the service date
      let formattedDate = '';
      if (serviceDate) {
        try {
          formattedDate = new Date(serviceDate + 'T12:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
          });
        } catch { formattedDate = serviceDate; }
      }

      // Find customer in portal DB
      let customer = null;
      if (squareCustomerId) {
        customer = await db('customers').where({ square_customer_id: squareCustomerId }).first();
      }
      if (!customer && phone) {
        customer = await db('customers').where({ phone }).first();
      }

      const customerPhone = customer?.phone || phone;
      const customerName = customer?.first_name || firstName;

      if (customerPhone) {
        try {
          const body = `Hello ${customerName}! Your invoice for ${invoiceTitle}` +
            (formattedDate ? ` completed on ${formattedDate}` : '') +
            ` is ready.` +
            (publicUrl ? `\n\nPlease review it here: ${publicUrl}` : '') +
            `\n\nThank you for choosing Waves!`;

          await TwilioService.sendSMS(customerPhone, body, { messageType: 'invoice' });
          logger.info(`[square-webhook] Invoice SMS sent to ${customerName} (${customerPhone}) for "${invoiceTitle}"`);
        } catch (smsErr) {
          logger.error(`[square-webhook] Invoice SMS failed: ${smsErr.message}`);
        }
      }

      // Log activity
      if (customer) {
        await db('activity_log').insert({
          customer_id: customer.id,
          action: 'invoice_sent',
          description: `Invoice created: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
          metadata: JSON.stringify({ invoiceId: invoice.id, amount: totalAmount, publicUrl }),
        }).catch(() => {});
      }
    }

    // ── INVOICE PAYMENT MADE ──
    if (event.type === 'invoice.payment_made') {
      const invoice = event.data?.object?.invoice;
      if (!invoice) return res.sendStatus(200);

      const squareCustomerId = invoice.primary_recipient?.customer_id;
      if (squareCustomerId) {
        const customer = await db('customers').where({ square_customer_id: squareCustomerId }).first();
        if (customer) {
          const amount = (invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0) / 100;
          await db('payments').insert({
            customer_id: customer.id,
            amount,
            status: 'paid',
            payment_date: new Date().toISOString().split('T')[0],
            description: `Invoice: ${invoice.title || 'service'}`,
          }).catch(() => {});

          await db('activity_log').insert({
            customer_id: customer.id,
            action: 'invoice_paid',
            description: `Invoice paid: ${invoice.title || 'service'} ($${amount.toFixed(2)})`,
          }).catch(() => {});
        }
      }
    }
    // ── BOOKING CREATED ──
    if (event.type === 'booking.created') {
      const booking = event.data?.object?.booking;
      if (booking) {
        try {
          const customerName = booking.customer_note || '';
          const squareCustId = booking.customer_id;
          let customerId = null;

          // Try to find existing customer by Square customer ID
          if (squareCustId) {
            const existing = await db('customers').where({ square_customer_id: squareCustId }).first();
            if (existing) {
              customerId = existing.id;
            }
          }

          // Fallback: create customer via findOrCreateCustomer pattern
          if (!customerId) {
            // Try to get customer details from Square
            let sqCustomer = null;
            if (squareCustId) {
              try {
                const SquareService = require('../services/square');
                const { Client, Environment } = require('square');
                const config = require('../config');
                if (config.square?.accessToken) {
                  const client = new Client({
                    accessToken: config.square.accessToken,
                    environment: config.square.environment === 'production' ? Environment.Production : Environment.Sandbox,
                  });
                  const resp = await client.customersApi.retrieveCustomer(squareCustId);
                  sqCustomer = resp.result?.customer;
                }
              } catch (e) { logger.error(`[square-webhook] Fetch Square customer failed: ${e.message}`); }
            }

            const phone = sqCustomer?.phoneNumber ? sqCustomer.phoneNumber.replace(/\D/g, '') : null;
            const cleanPhone = phone ? (phone.length === 10 ? `+1${phone}` : phone.startsWith('+') ? phone : `+1${phone.slice(-10)}`) : null;
            const email = sqCustomer?.emailAddress || null;
            const firstName = sqCustomer?.givenName || 'Unknown';
            const lastName = sqCustomer?.familyName || '';

            // Check by phone or email
            if (cleanPhone) {
              const c = await db('customers').where({ phone: cleanPhone }).first();
              if (c) customerId = c.id;
            }
            if (!customerId && email) {
              const c = await db('customers').where({ email }).first();
              if (c) customerId = c.id;
            }

            // Create new customer if needed
            if (!customerId && (firstName !== 'Unknown' || cleanPhone)) {
              const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
              const [newCust] = await db('customers').insert({
                first_name: firstName, last_name: lastName,
                phone: cleanPhone, email,
                square_customer_id: squareCustId,
                referral_code: code, pipeline_stage: 'new_lead', pipeline_stage_changed_at: new Date(),
                lead_source: 'square_booking', member_since: new Date().toISOString().split('T')[0],
              }).returning('*');
              customerId = newCust.id;
              await db('property_preferences').insert({ customer_id: customerId }).catch(() => {});
              await db('notification_prefs').insert({ customer_id: customerId }).catch(() => {});
            }
          }

          if (customerId) {
            const start = booking.start_at ? new Date(booking.start_at) : new Date();
            const dateStr = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const startTime = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
            const durationMin = booking.appointment_segments?.[0]?.duration_minutes || 60;
            const endTime = new Date(start.getTime() + durationMin * 60000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
            const serviceName = booking.appointment_segments?.[0]?.service_variation_id || 'Service';

            const ins = {
              customer_id: customerId, scheduled_date: dateStr,
              window_start: startTime, window_end: endTime,
              service_type: serviceName, status: 'pending',
              notes: booking.customer_note || null,
            };
            try {
              await db('scheduled_services').insert({ ...ins, square_booking_id: booking.id, source: 'square' });
            } catch {
              await db('scheduled_services').insert(ins);
            }

            await db('activity_log').insert({
              customer_id: customerId, action: 'booking_created',
              description: `Square booking created for ${dateStr} at ${startTime}`,
              metadata: JSON.stringify({ squareBookingId: booking.id }),
            }).catch(() => {});

            logger.info(`[square-webhook] Booking created: customer ${customerId}, date ${dateStr}`);
          }
        } catch (e) { logger.error(`[square-webhook] booking.created failed: ${e.message}`); }
      }
    }

    // ── CUSTOMER CREATED ──
    if (event.type === 'customer.created') {
      const sqCust = event.data?.object?.customer;
      if (sqCust) {
        try {
          const phone = sqCust.phone_number || sqCust.phoneNumber;
          const cleanedPhone = phone ? phone.replace(/\D/g, '') : null;
          const normalizedPhone = cleanedPhone ? (cleanedPhone.length === 10 ? `+1${cleanedPhone}` : cleanedPhone.length === 11 && cleanedPhone[0] === '1' ? `+${cleanedPhone}` : `+1${cleanedPhone.slice(-10)}`) : null;
          const email = sqCust.email_address || sqCust.emailAddress || null;
          const firstName = sqCust.given_name || sqCust.givenName || '';
          const lastName = sqCust.family_name || sqCust.familyName || '';
          const company = sqCust.company_name || sqCust.companyName || null;
          const addr = sqCust.address || {};

          if (!firstName && !lastName && !company) {
            logger.info(`[square-webhook] customer.created skipped — no name/company`);
          } else {
            // Check if already exists
            let existing = null;
            if (sqCust.id) existing = await db('customers').where({ square_customer_id: sqCust.id }).first();
            if (!existing && normalizedPhone) existing = await db('customers').where({ phone: normalizedPhone }).first();
            if (!existing && email) existing = await db('customers').where({ email }).first();

            if (existing) {
              const upd = {};
              if (!existing.square_customer_id) upd.square_customer_id = sqCust.id;
              if (!existing.email && email) upd.email = email;
              if (!existing.phone && normalizedPhone) upd.phone = normalizedPhone;
              if (Object.keys(upd).length) await db('customers').where({ id: existing.id }).update(upd);
              logger.info(`[square-webhook] customer.created — linked existing customer ${existing.id}`);
            } else {
              const { resolveLocation } = require('../config/locations');
              const city = addr.locality || '';
              const loc = resolveLocation(city);
              const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

              await db('customers').insert({
                first_name: firstName || company || 'Unknown', last_name: lastName || '',
                phone: normalizedPhone, email,
                address_line1: addr.address_line_1 || addr.addressLine1 || '',
                city, state: (addr.administrative_district_level_1 || addr.administrativeDistrictLevel1 || 'FL').substring(0, 2).toUpperCase(),
                zip: addr.postal_code || addr.postalCode || '',
                company_name: company, square_customer_id: sqCust.id,
                referral_code: code, pipeline_stage: 'new_lead', pipeline_stage_changed_at: new Date(),
                lead_source: 'square', nearest_location_id: loc.id,
                member_since: new Date().toISOString().split('T')[0],
              });
              logger.info(`[square-webhook] customer.created — new portal customer: ${firstName} ${lastName}`);
            }
          }
        } catch (e) { logger.error(`[square-webhook] customer.created failed: ${e.message}`); }
      }
    }

    // ── CUSTOMER UPDATED ──
    if (event.type === 'customer.updated') {
      const sqCust = event.data?.object?.customer;
      if (sqCust?.id) {
        try {
          let existing = await db('customers').where({ square_customer_id: sqCust.id }).first();

          // Fallback by phone/email
          if (!existing) {
            const phone = sqCust.phone_number || sqCust.phoneNumber;
            const cleanedPhone = phone ? phone.replace(/\D/g, '') : null;
            const normalizedPhone = cleanedPhone ? (cleanedPhone.length === 10 ? `+1${cleanedPhone}` : `+1${cleanedPhone.slice(-10)}`) : null;
            if (normalizedPhone) existing = await db('customers').where({ phone: normalizedPhone }).first();
            if (!existing) {
              const email = sqCust.email_address || sqCust.emailAddress;
              if (email) existing = await db('customers').where({ email }).first();
            }
          }

          if (existing) {
            const upd = {};
            const phone = sqCust.phone_number || sqCust.phoneNumber;
            const email = sqCust.email_address || sqCust.emailAddress;
            const firstName = sqCust.given_name || sqCust.givenName;
            const lastName = sqCust.family_name || sqCust.familyName;
            const company = sqCust.company_name || sqCust.companyName;
            const addr = sqCust.address || {};

            if (!existing.square_customer_id) upd.square_customer_id = sqCust.id;
            if (email && email !== existing.email) upd.email = email;
            if (firstName && firstName !== existing.first_name) upd.first_name = firstName;
            if (lastName && lastName !== existing.last_name) upd.last_name = lastName;
            if (company && company !== existing.company_name) upd.company_name = company;

            const addrLine = addr.address_line_1 || addr.addressLine1;
            const city = addr.locality;
            const zip = addr.postal_code || addr.postalCode;
            if (addrLine && addrLine !== existing.address_line1) upd.address_line1 = addrLine;
            if (city && city !== existing.city) upd.city = city;
            if (zip && zip !== existing.zip) upd.zip = zip;

            if (Object.keys(upd).length) {
              upd.updated_at = new Date();
              await db('customers').where({ id: existing.id }).update(upd);
              logger.info(`[square-webhook] customer.updated — updated customer ${existing.id}: ${Object.keys(upd).join(', ')}`);
            }
          } else {
            logger.info(`[square-webhook] customer.updated — no matching portal customer for Square ${sqCust.id}`);
          }
        } catch (e) { logger.error(`[square-webhook] customer.updated failed: ${e.message}`); }
      }
    }

    // ── CUSTOMER DELETED ──
    if (event.type === 'customer.deleted') {
      const sqCustomer = event.data?.object?.customer;
      if (sqCustomer) {
        // Don't delete — mark as inactive to preserve history
        await db('customers')
          .where({ square_customer_id: sqCustomer.id })
          .update({ stage: 'inactive', updated_at: new Date() })
          .catch(() => {});

        logger.info(`[square-webhook] Customer deactivated: ${sqCustomer.id}`);
      }
    }

    // ── BOOKING UPDATED ──
    if (event.type === 'booking.updated') {
      const booking = event.data?.object?.booking;
      if (booking) {
        try {
          // Try to find existing scheduled service by square_booking_id
          const existing = await db('scheduled_services')
            .where({ square_booking_id: booking.id })
            .first()
            .catch(() => null);

          if (existing) {
            const start = booking.start_at ? new Date(booking.start_at) : null;
            const updates = {};

            if (start) {
              updates.scheduled_date = start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
              updates.window_start = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
              const durationMin = booking.appointment_segments?.[0]?.duration_minutes || 60;
              const endAt = new Date(start.getTime() + durationMin * 60000);
              updates.window_end = endAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
              updates.estimated_duration_minutes = durationMin;
            }

            if (booking.status === 'CANCELLED_BY_CUSTOMER' || booking.status === 'CANCELLED_BY_SELLER') {
              updates.status = 'cancelled';
            } else if (booking.status === 'ACCEPTED') {
              updates.status = 'confirmed';
            }

            if (booking.customer_note) {
              updates.notes = booking.customer_note;
            }

            updates.updated_at = new Date();
            await db('scheduled_services').where({ id: existing.id }).update(updates);
            logger.info(`[square-webhook] Booking updated: service ${existing.id}`);

            // Log activity
            if (existing.customer_id) {
              await db('activity_log').insert({
                customer_id: existing.customer_id,
                action: 'booking_updated',
                description: `Square booking updated for ${updates.scheduled_date || existing.scheduled_date}`,
                metadata: JSON.stringify({ squareBookingId: booking.id }),
              }).catch(() => {});
            }
          } else {
            logger.info(`[square-webhook] booking.updated — no matching service for booking ${booking.id}`);
          }
        } catch (e) { logger.error(`[square-webhook] booking.updated failed: ${e.message}`); }
      }
    }

    // ── SUBSCRIPTION EVENTS — WaveGuard Tier Auto-Computation ──
    if (event.type === 'subscription.created') {
      const sub = event.data?.object?.subscription;
      if (sub) {
        try {
          const result = await syncSubscription(sub, event.type);

          // Trigger onboarding automation for new recurring customers
          if (result?.customer && result.status === 'active') {
            const serviceType = normalizeServiceType(sub.plan_variation_id || '');
            const svcLower = serviceType.toLowerCase();

            if (svcLower.includes('lawn')) {
              await triggerAutomation('lawn_onboarding', result.customer.id, { tier: result.newTier });
            } else {
              await triggerAutomation('new_recurring', result.customer.id, { tier: result.newTier, serviceType });
            }
          }

          logger.info(`[square-webhook] Subscription created → tier: ${result?.newTier}`);
        } catch (e) { logger.error(`[square-webhook] subscription.created failed: ${e.message}`); }
      }
    }

    if (event.type === 'subscription.updated') {
      const sub = event.data?.object?.subscription;
      if (sub) {
        try {
          const result = await syncSubscription(sub, event.type);
          logger.info(`[square-webhook] Subscription updated → tier: ${result?.newTier} (status: ${result?.status})`);
        } catch (e) { logger.error(`[square-webhook] subscription.updated failed: ${e.message}`); }
      }
    }

    // ── ORDER EVENTS — Revenue Attribution ──
    if (event.type === 'order.created' || event.type === 'order.updated') {
      const order = event.data?.object?.order;
      if (order && order.customer_id && order.state === 'COMPLETED') {
        try {
          const customer = await db('customers')
            .where({ square_customer_id: order.customer_id })
            .first();

          if (customer) {
            const totalAmount = (order.total_money?.amount || 0) / 100;
            await db('activity_log').insert({
              customer_id: customer.id,
              action: 'order_completed',
              description: `Order completed: $${totalAmount.toFixed(2)}`,
              metadata: JSON.stringify({ orderId: order.id, amount: totalAmount }),
            }).catch(() => {});
          }
        } catch (e) { logger.error(`[square-webhook] order event failed: ${e.message}`); }
      }
    }

    // ── TEAM MEMBER EVENTS — Technician Sync ──
    if (event.type === 'team_member.created' || event.type === 'team_member.updated') {
      const member = event.data?.object?.team_member;
      if (member) {
        try {
          const name = `${member.given_name || ''} ${member.family_name || ''}`.trim();
          if (!name) return;

          const existing = await db('technicians')
            .where({ square_team_member_id: member.id })
            .first()
            .catch(() => null);

          if (existing) {
            await db('technicians').where({ id: existing.id }).update({
              name,
              active: member.status === 'ACTIVE',
              updated_at: new Date(),
            });
          } else if (member.status === 'ACTIVE') {
            await db('technicians').insert({
              name,
              square_team_member_id: member.id,
              active: true,
              created_at: new Date(),
              updated_at: new Date(),
            }).catch(() => {}); // Might fail if unique constraint or column missing
          }

          logger.info(`[square-webhook] Team member synced: ${name}`);
        } catch (e) { logger.error(`[square-webhook] team_member event failed: ${e.message}`); }
      }
    }

    // ── Update customer stage on payment if still new_lead ──
    if (event.type === 'payment.completed') {
      try {
        const payment = event.data?.object?.payment;
        if (payment?.customer_id) {
          const customer = await db('customers')
            .where({ square_customer_id: payment.customer_id })
            .first();
          if (customer && customer.stage === 'new_lead') {
            await db('customers').where({ id: customer.id }).update({
              stage: 'active',
              updated_at: new Date(),
            });
          }
        }
      } catch { /* best effort */ }
    }

  } catch (err) {
    logger.error(`[square-webhook] Error: ${err.message}`);
  }

  res.sendStatus(200);
});

module.exports = router;
