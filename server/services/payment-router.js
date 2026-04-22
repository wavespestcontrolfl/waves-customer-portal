const db = require('../models/db');
const logger = require('./logger');
const stripeConfig = require('../config/stripe-config');

/**
 * Payment Router — all payments go through Stripe.
 */

let _stripeService;

function getStripeService() {
  if (!_stripeService) _stripeService = require('./stripe');
  return _stripeService;
}

const PaymentRouter = {
  async getProcessorName() {
    return 'stripe';
  },

  async getServiceForCustomer() {
    return getStripeService();
  },
};

module.exports = PaymentRouter;
