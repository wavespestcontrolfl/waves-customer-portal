/**
 * Square History Sync — pulls orders/payments from Square into
 * service_records, payments, and sms_log tables for customer detail views.
 *
 * Called manually from admin or on customer expand.
 */

const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');

let squareClient, ordersApi, paymentsApi, customersApi;
try {
  const { Client, Environment } = require('square');
  if (config.square?.accessToken) {
    squareClient = new Client({
      accessToken: config.square.accessToken,
      environment: config.square.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });
    ordersApi = squareClient.ordersApi;
    paymentsApi = squareClient.paymentsApi;
    customersApi = squareClient.customersApi;
  }
} catch { /* square not available */ }

const SquareHistorySync = {
  /**
   * Sync a single customer's Square history into portal DB.
   * Pulls orders → service_records + payments.
   */
  async syncCustomer(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');
    if (!customer.square_customer_id) return { services: 0, payments: 0, message: 'No Square customer ID linked' };
    if (!ordersApi) throw new Error('Square not configured');

    const locationId = config.square?.locationId || process.env.SQUARE_LOCATION_ID;
    const allLocationIds = locationId ? [locationId] : [];

    // If no location, try to get all locations
    if (!allLocationIds.length) {
      try {
        const locRes = await squareClient.locationsApi.listLocations();
        (locRes.result?.locations || []).forEach(l => allLocationIds.push(l.id));
      } catch { /* use empty */ }
    }

    if (!allLocationIds.length) return { services: 0, payments: 0, message: 'No Square location found' };

    let servicesCreated = 0, paymentsCreated = 0;

    // Fetch orders for this customer
    try {
      const response = await ordersApi.searchOrders({
        locationIds: allLocationIds,
        query: {
          filter: {
            customerFilter: { customerIds: [customer.square_customer_id] },
          },
          sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
        },
        limit: 50,
      });

      const orders = response.result?.orders || [];

      for (const order of orders) {
        const orderId = order.id;
        const orderDate = order.createdAt ? new Date(order.createdAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

        const lineItems = (order.lineItems || []).map(li => li.name).join(', ') || 'Service';
        const totalMoney = order.totalMoney?.amount ? (Number(order.totalMoney.amount) / 100) : 0;

        // Check if already synced (by customer + date + service type)
        const existingSvc = await db('service_records')
          .where({ customer_id: customerId, service_date: orderDate })
          .whereILike('service_type', `%${lineItems.substring(0, 30)}%`)
          .first();

        if (!existingSvc) {
          try {
            await db('service_records').insert({
              customer_id: customerId,
              service_type: lineItems.substring(0, 100),
              service_date: orderDate,
            });
            servicesCreated++;
          } catch (e) {
            try {
              await db('service_records').insert({
                customer_id: customerId,
                service_type: lineItems.substring(0, 100),
                service_date: orderDate,
              });
              servicesCreated++;
            } catch { /* skip */ }
          }
        }

        // Sync payment from order tenders
        if (order.tenders?.length) {
          for (const tender of order.tenders) {
            const amount = tender.amountMoney?.amount ? Number(tender.amountMoney.amount) / 100 : 0;
            if (amount <= 0) continue;

            const existingPmt = await db('payments')
              .where({ customer_id: customerId })
              .where('payment_date', orderDate)
              .where('amount', amount)
              .first();

            if (!existingPmt) {
              try {
                await db('payments').insert({
                  customer_id: customerId,
                  amount,
                  status: 'paid',
                  payment_date: orderDate,
                  description: `Square: ${lineItems?.substring(0, 100) || 'Payment'}`,
                });
                paymentsCreated++;
              } catch { /* skip */ }
            }
          }
        }
      }
    } catch (err) {
      logger.error(`[sq-history] Orders sync failed for ${customerId}: ${err.message}`);
    }

    // Update customer lifetime revenue
    try {
      const [{ total }] = await db('payments').where({ customer_id: customerId, status: 'paid' }).sum('amount as total');
      if (total) {
        await db('customers').where({ id: customerId }).update({ lifetime_revenue: total, total_services: servicesCreated > 0 ? db.raw(`COALESCE(total_services, 0) + ${servicesCreated}`) : undefined });
      }
    } catch { /* skip */ }

    logger.info(`[sq-history] Synced customer ${customerId}: ${servicesCreated} services, ${paymentsCreated} payments`);
    return { services: servicesCreated, payments: paymentsCreated };
  },
};

module.exports = SquareHistorySync;
