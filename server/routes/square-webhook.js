const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TwilioService = require('../services/twilio');

const WAVES_FROM = '+19413187612';

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
              const body = `Hello ${customer.first_name}! Thank you for your payment of $${amount.toFixed(2)} — we truly appreciate your business. 🌊\n\n` +
                (receiptUrl ? `View your receipt: ${receiptUrl}\n\n` : '') +
                `If you have any questions, reply here or call (941) 318-7612.\n\n` +
                `— Waves Pest Control`;

              await TwilioService.sendSMS(customer.phone, body);
              logger.info(`[square-webhook] Payment SMS sent to ${customer.first_name} (${customer.phone}) for $${amount.toFixed(2)}`);
            } catch (smsErr) {
              logger.error(`[square-webhook] Payment SMS failed: ${smsErr.message}`);
            }
          }

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
            ` is ready.\n\n` +
            (totalAmount > 0 ? `Amount due: $${totalAmount.toFixed(2)}\n` : '') +
            (publicUrl ? `\nView & pay here: ${publicUrl}\n` : '') +
            `\nIf you have any questions, reply here or call (941) 318-7612.\n\n` +
            `— Waves Pest Control 🌊`;

          await TwilioService.sendSMS(customerPhone, body);
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
                city, state: addr.administrative_district_level_1 || addr.administrativeDistrictLevel1 || 'FL',
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

  } catch (err) {
    logger.error(`[square-webhook] Error: ${err.message}`);
  }

  res.sendStatus(200);
});

module.exports = router;
