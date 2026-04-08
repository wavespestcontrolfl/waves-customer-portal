const db = require('../models/db');
const logger = require('./logger');
const stripeConfig = require('../config/stripe-config');

/**
 * Payment Router — Routes payment calls to the correct processor
 * based on PAYMENT_PROCESSOR env var and customer payment methods.
 *
 * Modes:
 *   'stripe' — always use Stripe
 *   'square' — always use Square
 *   'both'   — check customer's payment_methods:
 *              has Stripe PM → Stripe
 *              has only Square → Square
 *              new customer (no PM) → Stripe (default for new signups)
 */

// Lazy-load services to avoid circular deps
let _stripeService, _squareService;

function getStripeService() {
  if (!_stripeService) _stripeService = require('./stripe');
  return _stripeService;
}

function getSquareService() {
  if (!_squareService) _squareService = require('./square');
  return _squareService;
}

const PaymentRouter = {
  /**
   * Determine the processor name for a customer.
   * @param {string} customerId — Waves customer UUID
   * @returns {Promise<'stripe'|'square'>}
   */
  async getProcessorName(customerId) {
    const mode = stripeConfig.paymentProcessor || 'both';

    if (mode === 'stripe') return 'stripe';
    if (mode === 'square') return 'square';

    // mode === 'both' — check customer's existing payment methods
    if (customerId) {
      const stripePM = await db('payment_methods')
        .where({ customer_id: customerId, processor: 'stripe' })
        .first();
      if (stripePM) return 'stripe';

      const squarePM = await db('payment_methods')
        .where({ customer_id: customerId, processor: 'square' })
        .first();
      if (squarePM) return 'square';
    }

    // New customer or no PMs — default to Stripe
    return 'stripe';
  },

  /**
   * Get the payment service instance for a customer.
   * @param {string} customerId — Waves customer UUID
   * @returns {Promise<object>} — StripeService or SquareService
   */
  async getServiceForCustomer(customerId) {
    const processor = await this.getProcessorName(customerId);

    if (processor === 'stripe') {
      const stripe = getStripeService();
      if (!stripe.isAvailable()) {
        logger.warn('[payment-router] Stripe selected but not available, falling back to Square');
        return getSquareService();
      }
      return stripe;
    }

    return getSquareService();
  },
};

module.exports = PaymentRouter;
