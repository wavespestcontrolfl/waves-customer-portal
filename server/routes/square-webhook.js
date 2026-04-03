const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');

// POST /api/webhooks/square/payment — Square payment notification
router.post('/payment', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Square webhook: ${event.type}`);

    if (event.type === 'invoice.payment_made' || event.type === 'payment.completed') {
      const squareCustomerId = event.data?.object?.payment?.customerId ||
        event.data?.object?.invoice?.primaryRecipient?.customerId;

      if (squareCustomerId) {
        const customer = await db('customers').where({ square_customer_id: squareCustomerId }).first();

        if (customer) {
          const amount = (event.data?.object?.payment?.amountMoney?.amount || 0) / 100;

          // Record payment
          await db('payments').insert({
            customer_id: customer.id,
            amount,
            status: 'paid',
            payment_date: new Date().toISOString().split('T')[0],
            description: 'Square payment',
          });

          // Trigger balance reminder auto-detect
          try {
            const BalanceReminder = require('../services/workflows/balance-reminder');
            await BalanceReminder.onPaymentReceived(customer.id, amount);
          } catch (e) { logger.error(`Balance auto-detect failed: ${e.message}`); }

          // Log activity
          await db('activity_log').insert({
            customer_id: customer.id,
            action: 'payment_processed',
            description: `Payment received: $${amount.toFixed(2)} from ${customer.first_name} ${customer.last_name}`,
            metadata: JSON.stringify({ amount, squarePaymentId: event.data?.object?.payment?.id }),
          });

          logger.info(`Square payment: $${amount} from ${customer.first_name} ${customer.last_name}`);
        }
      }
    }
  } catch (err) {
    logger.error(`Square webhook error: ${err.message}`);
  }

  res.sendStatus(200);
});

module.exports = router;
