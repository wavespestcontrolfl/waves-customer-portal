const { Client, Environment } = require('square');
const config = require('../config');
const db = require('../models/db');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');

// Initialize Square client — lazy to avoid crash if creds missing
let squareClient, paymentsApi, customersApi, cardsApi, invoicesApi, bookingsApi, teamApi;
if (config.square.accessToken) {
  squareClient = new Client({
    accessToken: config.square.accessToken,
    environment: config.square.environment === 'production'
      ? Environment.Production
      : Environment.Sandbox,
  });
  paymentsApi = squareClient.paymentsApi;
  customersApi = squareClient.customersApi;
  cardsApi = squareClient.cardsApi;
  invoicesApi = squareClient.invoicesApi;
  bookingsApi = squareClient.bookingsApi;
  teamApi = squareClient.teamApi;
} else {
  logger.warn('[square] SQUARE_ACCESS_TOKEN not set — payment features disabled');
}

const SquareService = {
  // =========================================================================
  // CUSTOMER MANAGEMENT
  // =========================================================================

  /**
   * Create or retrieve a Square customer profile
   */
  async ensureSquareCustomer(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    // Already linked
    if (customer.square_customer_id) {
      return customer.square_customer_id;
    }

    try {
      const { result } = await customersApi.createCustomer({
        idempotencyKey: uuidv4(),
        givenName: customer.first_name,
        familyName: customer.last_name,
        emailAddress: customer.email,
        phoneNumber: customer.phone,
        address: {
          addressLine1: customer.address_line1,
          addressLine2: customer.address_line2,
          locality: customer.city,
          administrativeDistrictLevel1: customer.state,
          postalCode: customer.zip,
          country: 'US',
        },
        referenceId: customerId, // link back to our DB
      });

      const squareCustomerId = result.customer.id;

      await db('customers')
        .where({ id: customerId })
        .update({ square_customer_id: squareCustomerId });

      logger.info(`Square customer created: ${squareCustomerId} for ${customerId}`);
      return squareCustomerId;
    } catch (err) {
      logger.error(`Square customer creation failed: ${err.message}`);
      throw new Error('Failed to create Square customer');
    }
  },

  // =========================================================================
  // CARD MANAGEMENT
  // =========================================================================

  /**
   * Save a new card on file using a Square card nonce from the frontend
   * The frontend uses Square Web Payments SDK to tokenize the card
   */
  async saveCard(customerId, cardNonce) {
    const squareCustomerId = await this.ensureSquareCustomer(customerId);

    try {
      const { result } = await cardsApi.createCard({
        idempotencyKey: uuidv4(),
        sourceId: cardNonce,
        card: {
          customerId: squareCustomerId,
        },
      });

      const card = result.card;

      // Store card reference in our DB
      const cardRecord = await db('payment_methods').insert({
        customer_id: customerId,
        square_card_id: card.id,
        card_brand: card.cardBrand,
        last_four: card.last4,
        exp_month: String(card.expMonth).padStart(2, '0'),
        exp_year: String(card.expYear),
        is_default: true,
        autopay_enabled: true,
      }).returning('*');

      // Set all other cards as non-default
      await db('payment_methods')
        .where({ customer_id: customerId })
        .whereNot({ id: cardRecord[0].id })
        .update({ is_default: false });

      logger.info(`Card saved for customer ${customerId}: ${card.cardBrand} ****${card.last4}`);
      return cardRecord[0];
    } catch (err) {
      logger.error(`Square save card failed: ${err.message}`);
      throw new Error('Failed to save payment card');
    }
  },

  /**
   * Get all cards on file for a customer
   */
  async getCards(customerId) {
    return db('payment_methods')
      .where({ customer_id: customerId })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');
  },

  /**
   * Remove a card on file
   */
  async removeCard(customerId, cardId) {
    const card = await db('payment_methods')
      .where({ id: cardId, customer_id: customerId })
      .first();

    if (!card) throw new Error('Card not found');

    try {
      await cardsApi.disableCard(card.square_card_id);
      await db('payment_methods').where({ id: cardId }).del();
      logger.info(`Card removed for customer ${customerId}: ${cardId}`);
      return { success: true };
    } catch (err) {
      logger.error(`Square remove card failed: ${err.message}`);
      throw new Error('Failed to remove card');
    }
  },

  // =========================================================================
  // PAYMENT PROCESSING
  // =========================================================================

  /**
   * Charge a customer's default card (monthly autopay)
   */
  async chargeMonthly(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const card = await db('payment_methods')
      .where({ customer_id: customerId, is_default: true, autopay_enabled: true })
      .first();

    if (!card) throw new Error('No autopay card on file');

    const amountCents = Math.round(customer.monthly_rate * 100);

    try {
      const { result } = await paymentsApi.createPayment({
        idempotencyKey: uuidv4(),
        sourceId: card.square_card_id,
        amountMoney: {
          amount: BigInt(amountCents),
          currency: 'USD',
        },
        customerId: customer.square_customer_id,
        locationId: config.square.locationId,
        note: `${customer.waveguard_tier} WaveGuard Monthly — ${customer.first_name} ${customer.last_name}`,
        referenceId: customerId,
      });

      const payment = result.payment;

      // Record payment in our DB
      const paymentRecord = await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        square_payment_id: payment.id,
        payment_date: new Date().toISOString().split('T')[0],
        amount: customer.monthly_rate,
        status: payment.status === 'COMPLETED' ? 'paid' : 'processing',
        description: `${customer.waveguard_tier} WaveGuard Monthly`,
        metadata: JSON.stringify({
          square_receipt_url: payment.receiptUrl,
          square_order_id: payment.orderId,
        }),
      }).returning('*');

      logger.info(`Monthly charge processed: $${customer.monthly_rate} for ${customerId}, Square ID: ${payment.id}`);
      return paymentRecord[0];
    } catch (err) {
      logger.error(`Square monthly charge failed for ${customerId}: ${err.message}`);

      // Record failed payment
      await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        payment_date: new Date().toISOString().split('T')[0],
        amount: customer.monthly_rate,
        status: 'failed',
        description: `${customer.waveguard_tier} WaveGuard Monthly — FAILED`,
        metadata: JSON.stringify({ error: err.message }),
      });

      throw new Error('Payment processing failed');
    }
  },

  /**
   * Process a one-time charge (e.g., add-on service, one-time mosquito event)
   */
  async chargeOneTime(customerId, amount, description, cardId = null) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    // Use specified card or default
    const card = cardId
      ? await db('payment_methods').where({ id: cardId, customer_id: customerId }).first()
      : await db('payment_methods').where({ customer_id: customerId, is_default: true }).first();

    if (!card) throw new Error('No payment card available');

    const amountCents = Math.round(amount * 100);

    try {
      const { result } = await paymentsApi.createPayment({
        idempotencyKey: uuidv4(),
        sourceId: card.square_card_id,
        amountMoney: {
          amount: BigInt(amountCents),
          currency: 'USD',
        },
        customerId: customer.square_customer_id,
        locationId: config.square.locationId,
        note: `${description} — ${customer.first_name} ${customer.last_name}`,
        referenceId: customerId,
      });

      const paymentRecord = await db('payments').insert({
        customer_id: customerId,
        payment_method_id: card.id,
        square_payment_id: result.payment.id,
        payment_date: new Date().toISOString().split('T')[0],
        amount,
        status: result.payment.status === 'COMPLETED' ? 'paid' : 'processing',
        description,
      }).returning('*');

      logger.info(`One-time charge: $${amount} for ${description}, customer ${customerId}`);
      return paymentRecord[0];
    } catch (err) {
      logger.error(`One-time charge failed: ${err.message}`);
      throw new Error('Payment processing failed');
    }
  },

  /**
   * Get payment history for a customer
   */
  async getPaymentHistory(customerId, limit = 20) {
    return db('payments')
      .where({ 'payments.customer_id': customerId })
      .leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id')
      .select(
        'payments.*',
        'payment_methods.card_brand',
        'payment_methods.last_four'
      )
      .orderBy('payments.payment_date', 'desc')
      .limit(limit);
  },

  // =========================================================================
  // SQUARE BOOKINGS / APPOINTMENTS
  // =========================================================================

  /**
   * Create a booking in Square from a scheduled service
   */
  async createBookingFromSchedule(customerId, scheduledDate, windowStart, windowEnd, serviceType) {
    if (!bookingsApi) {
      logger.warn('[square] Bookings API not available — skipping booking creation');
      return null;
    }
    try {
      const customer = await db('customers').where({ id: customerId }).first();
      if (!customer) return null;

      // Ensure customer exists in Square
      let squareCustomerId = customer.square_customer_id;
      if (!squareCustomerId) {
        try { squareCustomerId = await this.getOrCreateSquareCustomer(customer); } catch { return null; }
      }
      if (!squareCustomerId) return null;

      const locationId = config.square.locationId || process.env.SQUARE_LOCATION_ID;
      const startAt = `${scheduledDate}T${windowStart || '09:00'}:00`;
      const endTime = windowEnd || (() => { const [h] = (windowStart || '09:00').split(':'); return `${String(Number(h) + 1).padStart(2, '0')}:00`; })();

      const { result } = await bookingsApi.createBooking({
        booking: {
          customerId: squareCustomerId,
          locationId,
          startAt: new Date(startAt).toISOString(),
          appointmentSegments: [{
            durationMinutes: (() => {
              const [sh] = (windowStart || '09:00').split(':').map(Number);
              const [eh] = endTime.split(':').map(Number);
              return Math.max(30, (eh - sh) * 60);
            })(),
            serviceVariationId: undefined, // Optional — Square will accept without
          }],
          sellerNote: `${serviceType} — created from Waves Portal`,
        },
        idempotencyKey: uuidv4(),
      });

      const bookingId = result?.booking?.id;
      if (bookingId) {
        logger.info(`[square] Created booking ${bookingId} for ${customer.first_name} ${customer.last_name}`);
      }
      return bookingId;
    } catch (err) {
      logger.error(`[square] createBooking failed (non-blocking): ${err.message}`);
      return null;
    }
  },

  /**
   * Get upcoming appointments from Square Bookings API
   * @param {number} days — how many days ahead to look (default 7)
   */
  async getUpcomingBookings(days = 7) {
    if (!bookingsApi) {
      throw new Error('Square Bookings API not available — check SQUARE_ACCESS_TOKEN');
    }

    const now = new Date();
    // Look back 1 day + forward to catch in-progress bookings
    const start = new Date(now.getTime() - 86400000);
    const end = new Date();
    end.setDate(end.getDate() + days);

    const locationId = config.square.locationId || process.env.SQUARE_LOCATION_ID;
    logger.info(`[square] Fetching bookings: ${start.toISOString()} to ${end.toISOString()}, location=${locationId || 'all'}, env=${config.square.environment}`);

    let response;
    // Try with location ID first
    try {
      response = await bookingsApi.listBookings(
        100, undefined, undefined, undefined, locationId || undefined,
        start.toISOString(), end.toISOString(),
      );
    } catch (locErr) {
      logger.warn(`[square] listBookings with location failed: ${locErr.message}`);
      // Retry without location ID
      try {
        response = await bookingsApi.listBookings(
          100, undefined, undefined, undefined, undefined,
          start.toISOString(), end.toISOString(),
        );
      } catch (err2) {
        // Throw with useful info
        const detail = err2.errors?.[0]?.detail || err2.message;
        throw new Error(`Square Bookings API failed: ${detail} (env=${config.square.environment})`);
      }
    }

    const bookings = response.result?.bookings || [];
    logger.info(`[square] Found ${bookings.length} bookings from Square`);

      // Enrich with customer names from Square
      const customerIds = [...new Set(bookings.map(b => b.customerId).filter(Boolean))];
      const customerMap = {};
      for (const cid of customerIds) {
        try {
          const cr = await customersApi.retrieveCustomer(cid);
          const c = cr.result?.customer;
          if (c) customerMap[cid] = { name: `${c.givenName || ''} ${c.familyName || ''}`.trim(), phone: c.phoneNumber, email: c.emailAddress };
        } catch { /* skip */ }
      }

      // Look up service names from catalog
      const serviceVarIds = [...new Set(bookings.flatMap(b => (b.appointmentSegments || []).map(s => s.serviceVariationId)).filter(Boolean))];
      const serviceNameMap = {};
      if (squareClient && serviceVarIds.length > 0) {
        try {
          const catRes = await squareClient.catalogApi.batchRetrieveCatalogObjects({ objectIds: serviceVarIds, includeRelatedObjects: true });
          const objects = catRes.result?.objects || [];
          const related = catRes.result?.relatedObjects || [];

          // Build parent item name map from related objects
          const parentNameMap = {};
          for (const obj of related) {
            if (obj.type === 'ITEM' && obj.itemData?.name) {
              parentNameMap[obj.id] = obj.itemData.name;
            }
          }

          // Map variation IDs to readable names
          for (const obj of objects) {
            if (obj.type === 'ITEM_VARIATION' && obj.itemVariationData) {
              // Prefer parent item name (e.g. "Pest Control"), fall back to variation name
              const parentId = obj.itemVariationData.itemId;
              const parentName = parentNameMap[parentId];
              const varName = obj.itemVariationData.name;
              // If variation name is generic like "Regular", use parent name
              if (parentName && (!varName || varName === 'Regular' || varName === 'Default')) {
                serviceNameMap[obj.id] = parentName;
              } else if (parentName && varName) {
                serviceNameMap[obj.id] = `${parentName} — ${varName}`;
              } else {
                serviceNameMap[obj.id] = varName || parentName || 'Service';
              }
            } else if (obj.itemData?.name) {
              serviceNameMap[obj.id] = obj.itemData.name;
            }
          }
          logger.info(`[square] Resolved ${Object.keys(serviceNameMap).length} service names from catalog`);
        } catch (catErr) {
          logger.warn(`[square] Catalog lookup failed: ${catErr.message}`);
        }
      }

      return bookings.map(b => {
        const cust = customerMap[b.customerId] || {};
        const start = new Date(b.startAt);
        const serviceVarId = b.appointmentSegments?.[0]?.serviceVariationId;
        const serviceName = serviceNameMap[serviceVarId] || (serviceVarId?.length > 20 ? 'Service' : serviceVarId) || 'Service';
        return {
          id: b.id,
          status: b.status,
          startAt: b.startAt,
          date: start.toISOString().split('T')[0],
          time: start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
          dayOfWeek: start.toLocaleDateString('en-US', { weekday: 'short' }),
          durationMinutes: b.appointmentSegments?.[0]?.durationMinutes || null,
          customerName: cust.name || 'Walk-in',
          customerPhone: cust.phone || null,
          customerEmail: cust.email || null,
          serviceName,
          teamMemberId: b.appointmentSegments?.[0]?.teamMemberId || null,
          locationId: b.locationId,
          note: b.customerNote || b.sellerNote || null,
          source: b.source || 'SQUARE',
          version: b.version,
          createdAt: b.createdAt,
        };
      }).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  },
};

module.exports = SquareService;
