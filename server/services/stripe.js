const Stripe = require('stripe');
const config = require('../config');
const stripeConfig = require('../config/stripe-config');
const db = require('../models/db');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');

// ═══════════════════════════════════════════════════════════════
// Lazy-init Stripe client — don't crash if key is missing
// ═══════════════════════════════════════════════════════════════
let _stripe;
function getStripe() {
  if (_stripe) return _stripe;
  if (!stripeConfig.secretKey) {
    logger.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe features disabled');
    return null;
  }
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia' });
  return _stripe;
}

const StripeService = {
  // =========================================================================
  // AVAILABILITY
  // =========================================================================

  /**
   * Returns true if Stripe is configured and available
   */
  isAvailable() {
    return !!stripeConfig.secretKey;
  },

  // =========================================================================
  // CUSTOMER MANAGEMENT
  // =========================================================================

  /**
   * Create or retrieve a Stripe customer, store stripe_customer_id on customers table.
   * Returns the Stripe customer ID.
   */
  async ensureStripeCustomer(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    // Already linked
    if (customer.stripe_customer_id) {
      return customer.stripe_customer_id;
    }

    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    try {
      const stripeCustomer = await stripe.customers.create({
        name: `${customer.first_name} ${customer.last_name}`,
        email: customer.email || undefined,
        phone: customer.phone || undefined,
        address: {
          line1: customer.address_line1,
          line2: customer.address_line2 || undefined,
          city: customer.city,
          state: customer.state,
          postal_code: customer.zip,
          country: 'US',
        },
        metadata: {
          waves_customer_id: customerId,
          waveguard_tier: customer.waveguard_tier || '',
        },
      }, {
        idempotencyKey: `cust-create-${customerId}`,
      });

      const stripeCustomerId = stripeCustomer.id;

      await db('customers')
        .where({ id: customerId })
        .update({ stripe_customer_id: stripeCustomerId });

      logger.info(`[stripe] Customer created: ${stripeCustomerId} for ${customerId}`);
      return stripeCustomerId;
    } catch (err) {
      logger.error(`[stripe] Customer creation failed: ${err.message}`);
      throw new Error('Failed to create Stripe customer');
    }
  },

  // =========================================================================
  // SETUP INTENT (Card / ACH Save)
  // =========================================================================

  /**
   * Create a SetupIntent for saving a card or bank account.
   * The frontend uses this clientSecret to confirm via Stripe.js.
   * @param {string} customerId — Waves customer UUID
   * @param {string} [paymentMethodType] — 'card' or 'us_bank_account'
   * @returns {{ clientSecret: string, setupIntentId: string }}
   */
  async createSetupIntent(customerId, paymentMethodType = 'card') {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

    const paymentMethodTypes = paymentMethodType === 'us_bank_account'
      ? ['us_bank_account']
      : ['card'];

    try {
      const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: paymentMethodTypes,
        metadata: {
          waves_customer_id: customerId,
        },
      });

      logger.info(`[stripe] SetupIntent created: ${setupIntent.id} for ${customerId}`);
      return {
        clientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id,
      };
    } catch (err) {
      logger.error(`[stripe] SetupIntent creation failed: ${err.message}`);
      throw new Error('Failed to create setup intent');
    }
  },

  // =========================================================================
  // SAVE PAYMENT METHOD
  // =========================================================================

  /**
   * After the frontend confirms a SetupIntent, call this to persist
   * the payment method in our DB. Supports card + us_bank_account.
   * @param {string} customerId — Waves customer UUID
   * @param {string} paymentMethodId — Stripe pm_xxx ID
   * @returns {object} payment_methods row
   */
  async savePaymentMethod(customerId, paymentMethodId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

    try {
      // Attach PM to the Stripe customer (may already be attached via SetupIntent)
      try {
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: stripeCustomerId,
        });
      } catch (attachErr) {
        // Already attached — that's fine
        if (!attachErr.message.includes('already been attached')) {
          throw attachErr;
        }
      }

      // Retrieve full PM details
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

      // Build DB record
      const record = {
        customer_id: customerId,
        processor: 'stripe',
        stripe_payment_method_id: paymentMethodId,
        stripe_customer_id: stripeCustomerId,
        is_default: true,
        autopay_enabled: true,
      };

      if (pm.type === 'card' && pm.card) {
        record.method_type = 'card';
        record.card_brand = pm.card.brand ? pm.card.brand.toUpperCase() : null;
        record.last_four = pm.card.last4;
        record.exp_month = String(pm.card.exp_month).padStart(2, '0');
        record.exp_year = String(pm.card.exp_year);
      } else if (pm.type === 'us_bank_account' && pm.us_bank_account) {
        record.method_type = 'ach';
        record.bank_name = pm.us_bank_account.bank_name;
        record.bank_last_four = pm.us_bank_account.last4;
        record.last_four = pm.us_bank_account.last4;
        record.ach_status = pm.us_bank_account.status || 'verified';
      }

      const [saved] = await db('payment_methods').insert(record).returning('*');

      // Set all other PMs for this customer as non-default
      await db('payment_methods')
        .where({ customer_id: customerId })
        .whereNot({ id: saved.id })
        .update({ is_default: false });

      logger.info(`[stripe] Payment method saved for ${customerId}: ${pm.type} ****${record.last_four}`);
      return saved;
    } catch (err) {
      logger.error(`[stripe] Save payment method failed: ${err.message}`);
      throw new Error('Failed to save payment method');
    }
  },

  // =========================================================================
  // GET CARDS (All payment methods — both processors)
  // =========================================================================

  /**
   * Return all payment_methods for a customer (Stripe + Square)
   */
  async getCards(customerId) {
    return db('payment_methods')
      .where({ customer_id: customerId })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');
  },

  // =========================================================================
  // REMOVE CARD
  // =========================================================================

  /**
   * Detach a payment method. Routes to Stripe or Square based on processor.
   */
  async removeCard(customerId, cardId) {
    const card = await db('payment_methods')
      .where({ id: cardId, customer_id: customerId })
      .first();

    if (!card) throw new Error('Payment method not found');

    if (card.processor === 'stripe' && card.stripe_payment_method_id) {
      const stripe = getStripe();
      if (!stripe) throw new Error('Stripe not configured');

      try {
        await stripe.paymentMethods.detach(card.stripe_payment_method_id);
      } catch (err) {
        // If already detached in Stripe, just remove from DB
        logger.warn(`[stripe] Detach warning (proceeding with DB removal): ${err.message}`);
      }
      await db('payment_methods').where({ id: cardId }).del();
      logger.info(`[stripe] Payment method removed for ${customerId}: ${cardId}`);
      return { success: true };
    }

    if (card.processor === 'square' && card.square_card_id) {
      // Delegate to Square service
      const SquareService = require('./square');
      return SquareService.removeCard(customerId, cardId);
    }

    // Fallback — just remove from DB
    await db('payment_methods').where({ id: cardId }).del();
    logger.info(`[stripe] Payment method removed (DB only) for ${customerId}: ${cardId}`);
    return { success: true };
  },

  // =========================================================================
  // CHARGE — Off-session PaymentIntent
  // =========================================================================

  /**
   * Charge a customer's default Stripe payment method.
   * @param {string} customerId — Waves customer UUID
   * @param {number} amountDollars — charge amount in dollars
   * @param {string} description — charge description
   * @param {object} [metadata] — extra Stripe metadata
   * @returns {object} payments table row
   */
  async charge(customerId, amountDollars, description, metadata = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const card = await db('payment_methods')
      .where({ customer_id: customerId, processor: 'stripe', is_default: true, autopay_enabled: true })
      .first();

    if (!card || !card.stripe_payment_method_id) {
      throw new Error('No Stripe autopay payment method on file');
    }

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);
    const amountCents = Math.round(amountDollars * 100);

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: card.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        description,
        metadata: {
          waves_customer_id: customerId,
          ...metadata,
        },
      });

      const status = paymentIntent.status === 'succeeded' ? 'paid' : 'processing';

      const [paymentRecord] = await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        processor: 'stripe',
        stripe_payment_intent_id: paymentIntent.id,
        stripe_charge_id: paymentIntent.latest_charge || null,
        payment_date: new Date().toISOString().split('T')[0],
        amount: amountDollars,
        status,
        description,
        metadata: JSON.stringify({
          stripe_receipt_url: paymentIntent.charges?.data?.[0]?.receipt_url || null,
        }),
      }).returning('*');

      logger.info(`[stripe] Charge processed: $${amountDollars} for ${customerId}, PI: ${paymentIntent.id}`);
      return paymentRecord;
    } catch (err) {
      logger.error(`[stripe] Charge failed for ${customerId}: ${err.message}`);

      // Record failed payment
      const [failedRecord] = await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        processor: 'stripe',
        payment_date: new Date().toISOString().split('T')[0],
        amount: amountDollars,
        status: 'failed',
        description: `${description} — FAILED`,
        failure_reason: err.message,
        metadata: JSON.stringify({ error: err.message, code: err.code }),
      }).returning('*');

      throw Object.assign(new Error('Payment processing failed'), { paymentRecord: failedRecord });
    }
  },

  // =========================================================================
  // CHARGE MONTHLY
  // =========================================================================

  /**
   * Charge monthly_rate from the customers table (autopay)
   */
  async chargeMonthly(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const description = `${customer.waveguard_tier || 'WaveGuard'} WaveGuard Monthly — ${customer.first_name} ${customer.last_name}`;
    return this.charge(customerId, customer.monthly_rate, description, {
      type: 'monthly_autopay',
      tier: customer.waveguard_tier || '',
    });
  },

  // =========================================================================
  // CHARGE ONE-TIME
  // =========================================================================

  /**
   * Process a one-time charge (add-on service, event, etc.)
   */
  async chargeOneTime(customerId, amount, description) {
    return this.charge(customerId, amount, description, { type: 'one_time' });
  },

  // =========================================================================
  // PAYMENT HISTORY
  // =========================================================================

  /**
   * Get payment history with payment method details (both processors)
   */
  async getPaymentHistory(customerId, limit = 20) {
    return db('payments')
      .where({ 'payments.customer_id': customerId })
      .leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id')
      .select(
        'payments.*',
        'payment_methods.card_brand',
        'payment_methods.last_four',
        'payment_methods.processor as pm_processor',
        'payment_methods.method_type',
        'payment_methods.bank_name'
      )
      .orderBy('payments.payment_date', 'desc')
      .limit(limit);
  },

  // =========================================================================
  // REFUND
  // =========================================================================

  /**
   * Full or partial refund via Stripe.
   * @param {string} paymentId — Waves payment UUID
   * @param {{ amount?: number, reason?: string }} options
   * @returns {object} updated payment row
   */
  async refund(paymentId, { amount, reason } = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const payment = await db('payments').where({ id: paymentId }).first();
    if (!payment) throw new Error('Payment not found');

    if (payment.processor !== 'stripe' || !payment.stripe_payment_intent_id) {
      throw new Error('Payment is not a Stripe payment — cannot refund via Stripe');
    }

    try {
      const refundParams = {
        payment_intent: payment.stripe_payment_intent_id,
        reason: reason || 'requested_by_customer',
      };

      if (amount) {
        refundParams.amount = Math.round(amount * 100);
      }

      const refund = await stripe.refunds.create(refundParams);

      const refundAmountDollars = amount || parseFloat(payment.amount);
      const isFullRefund = refundAmountDollars >= parseFloat(payment.amount);

      await db('payments')
        .where({ id: paymentId })
        .update({
          status: isFullRefund ? 'refunded' : 'paid',
          refund_amount: refundAmountDollars,
          refund_status: refund.status,
          stripe_refund_id: refund.id,
        });

      const updated = await db('payments').where({ id: paymentId }).first();
      logger.info(`[stripe] Refund processed: $${refundAmountDollars} for payment ${paymentId}, refund ${refund.id}`);
      return updated;
    } catch (err) {
      logger.error(`[stripe] Refund failed for payment ${paymentId}: ${err.message}`);
      throw new Error('Refund processing failed');
    }
  },

  // =========================================================================
  // INVOICE PAYMENT — PaymentIntent for /pay/:token page
  // =========================================================================

  /**
   * Create a PaymentIntent for an invoice amount (public pay page).
   * @param {string} invoiceId — Waves invoice UUID
   * @returns {{ clientSecret: string, paymentIntentId: string, amount: number }}
   */
  async createInvoicePaymentIntent(invoiceId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    const customer = await db('customers').where({ id: invoice.customer_id }).first();
    const amountCents = Math.round(parseFloat(invoice.total) * 100);

    // Optionally link to Stripe customer if they exist
    let stripeCustomerId = customer?.stripe_customer_id || null;

    const piParams = {
      amount: amountCents,
      currency: 'usd',
      payment_method_types: ['card'],
      description: `Invoice ${invoice.invoice_number} — ${invoice.title || 'Waves Pest Control'}`,
      metadata: {
        waves_invoice_id: invoiceId,
        invoice_number: invoice.invoice_number,
        waves_customer_id: invoice.customer_id,
      },
    };

    if (stripeCustomerId) {
      piParams.customer = stripeCustomerId;
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create(piParams);

      // Store PI reference on invoice
      await db('invoices')
        .where({ id: invoiceId })
        .update({
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
        });

      logger.info(`[stripe] Invoice PaymentIntent created: ${paymentIntent.id} for invoice ${invoice.invoice_number}`);
      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: parseFloat(invoice.total),
      };
    } catch (err) {
      logger.error(`[stripe] Invoice PaymentIntent failed: ${err.message}`);
      throw new Error('Failed to create payment intent for invoice');
    }
  },

  // =========================================================================
  // CONFIRM INVOICE PAYMENT
  // =========================================================================

  /**
   * After the frontend confirms a PaymentIntent on the pay page,
   * call this to mark the invoice as paid and record the payment.
   * @param {string} invoiceId — Waves invoice UUID
   * @param {string} paymentIntentId — Stripe pi_xxx ID
   * @returns {object} payment record
   */
  async confirmInvoicePayment(invoiceId, paymentIntentId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    try {
      // Retrieve the PI to verify it succeeded
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.status !== 'succeeded') {
        throw new Error(`PaymentIntent status is "${pi.status}", expected "succeeded"`);
      }

      const charge = pi.latest_charge;
      let receiptUrl = null;
      let cardBrand = null;
      let cardLastFour = null;

      // Get receipt and card info from the charge
      if (charge) {
        try {
          const chargeObj = typeof charge === 'string'
            ? await stripe.charges.retrieve(charge)
            : charge;
          receiptUrl = chargeObj.receipt_url || null;
          if (chargeObj.payment_method_details?.card) {
            cardBrand = chargeObj.payment_method_details.card.brand?.toUpperCase();
            cardLastFour = chargeObj.payment_method_details.card.last4;
          }
        } catch {
          // Non-critical — continue without receipt details
        }
      }

      // Update invoice
      await db('invoices')
        .where({ id: invoiceId })
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntentId,
          stripe_charge_id: typeof charge === 'string' ? charge : null,
          payment_method: 'card',
          card_brand: cardBrand,
          card_last_four: cardLastFour,
          receipt_url: receiptUrl,
        });

      // Record payment
      const [paymentRecord] = await db('payments').insert({
        customer_id: invoice.customer_id,
        processor: 'stripe',
        stripe_payment_intent_id: paymentIntentId,
        stripe_charge_id: typeof charge === 'string' ? charge : null,
        payment_date: new Date().toISOString().split('T')[0],
        amount: parseFloat(invoice.total),
        status: 'paid',
        description: `Invoice ${invoice.invoice_number}`,
        metadata: JSON.stringify({
          invoice_id: invoiceId,
          stripe_receipt_url: receiptUrl,
        }),
      }).returning('*');

      logger.info(`[stripe] Invoice ${invoice.invoice_number} paid via Stripe PI: ${paymentIntentId}`);
      return paymentRecord;
    } catch (err) {
      logger.error(`[stripe] Confirm invoice payment failed: ${err.message}`);
      throw new Error(`Invoice payment confirmation failed: ${err.message}`);
    }
  },
};

module.exports = StripeService;
