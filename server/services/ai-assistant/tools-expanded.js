/**
 * Waves AI Assistant — Expanded Tool Definitions
 *
 * Original 7 tools (unchanged from tools.js):
 *   lookup_customer, get_upcoming_services, get_service_history,
 *   get_billing_info, get_pest_advice, get_call_history, escalate
 *
 * New tools (8 additions):
 *   check_availability, book_appointment, get_property_profile,
 *   get_lawn_health, send_payment_link, check_payment_status,
 *   get_service_recommendations, send_sms
 */

const db = require('../../models/db');
const logger = require('../logger');

// Import original tools
const { TOOLS: ORIGINAL_TOOLS, executeToolCall: executeOriginalTool } = require('./tools');

// ── New tool definitions ────────────────────────────────────────

const EXPANDED_TOOLS = [
  ...ORIGINAL_TOOLS,

  // ── Appointment Booking ───────────────────────────────────────

  {
    name: 'check_availability',
    description: `Check available appointment slots for a customer's city. Returns dates with open time slots over the next 14 days. Only shows slots when a technician is already working in the customer's zone that day. Use this when a customer wants to schedule or reschedule a service. Requires the customer's city (from their profile) or a specific city name.`,
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: "Customer's city (Bradenton, Lakewood Ranch, Sarasota, Venice, North Port, Parrish, Port Charlotte)" },
        estimate_id: { type: 'string', description: 'Optional estimate ID to link the booking to' },
      },
      required: ['city'],
    },
  },
  {
    name: 'book_appointment',
    description: `Book a confirmed appointment for a customer. Creates the scheduled service, sends confirmation SMS to the customer, and notifies Adam. Returns a confirmation code. IMPORTANT: Always check_availability first and present the options to the customer. Only book after the customer confirms a specific date and time slot. Never book without explicit customer confirmation.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Waves customer UUID' },
        date: { type: 'string', description: 'Selected date in YYYY-MM-DD format' },
        start_time: { type: 'string', description: 'Selected start time in HH:MM format (24-hour)' },
        customer_notes: { type: 'string', description: 'Any notes from the customer about the appointment' },
        estimate_id: { type: 'string', description: 'Optional estimate ID to link' },
      },
      required: ['customer_id', 'date', 'start_time'],
    },
  },

  // ── Payment ───────────────────────────────────────────────────

  {
    name: 'send_payment_link',
    description: `Send a tap-to-pay invoice link to the customer via SMS. Creates an invoice if one doesn't exist for the specified service, then texts the customer a link to the pay page where they can pay by card, Apple Pay, Google Pay, or bank transfer. Use when a customer asks to pay, or after discussing a service that needs payment. Returns the pay URL and invoice details.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Waves customer UUID' },
        invoice_id: { type: 'string', description: 'Existing invoice ID to send (if known)' },
        amount: { type: 'number', description: 'Amount in dollars (only if creating a new invoice)' },
        description: { type: 'string', description: 'What the payment is for (only if creating a new invoice)' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'check_payment_status',
    description: `Check the payment status of a specific invoice or the customer's most recent unpaid invoice. Returns the invoice status (draft, sent, paid, overdue), amount, due date, and payment details if paid. Use when a customer asks "did my payment go through" or "what do I owe".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Waves customer UUID' },
        invoice_id: { type: 'string', description: 'Specific invoice ID (optional — defaults to most recent unpaid)' },
      },
      required: ['customer_id'],
    },
  },

  // ── Property Assessment ───────────────────────────────────────

  {
    name: 'get_property_profile',
    description: `Get the full property profile for a customer. Returns property square footage, lot size, property preferences (gate codes, pets, irrigation system, HOA restrictions, special instructions, scheduling preferences), and chemical sensitivities. Also returns any pest/lawn flags from the context aggregator. Use when a customer asks about their property details, or when you need property context to give accurate advice about treatment timing, access, or pet safety.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Waves customer UUID' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_lawn_health',
    description: `Get the lawn health assessment history for a customer. Returns the latest scores (turf density, weed suppression, fungus control, thatch level, color health, overall score 0-100) plus the initial baseline scores for comparison. Shows improvement over time. Use when a customer asks "how is my lawn doing" or when discussing lawn care recommendations.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Waves customer UUID' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_service_recommendations',
    description: `Generate personalized service recommendations for a customer based on their property profile, current services, lawn health scores, service history, and the current pest pressure season. Returns recommended add-on services, treatment adjustments, and seasonal advice. Use when a customer asks "what else should I be doing" or "what do you recommend for my property" — or proactively when you notice gaps in their coverage.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Waves customer UUID' },
      },
      required: ['customer_id'],
    },
  },

  // ── Communication ─────────────────────────────────────────────

  {
    name: 'send_sms',
    description: `Send an SMS message to a customer via Twilio. Use this to send follow-up information, appointment details, or anything the customer needs in writing. The message will come from the Waves Pest Control number. Keep messages concise and professional. Do NOT use this for the main conversation reply — only for supplementary information like links, confirmation details, or follow-up instructions.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Waves customer UUID (used to look up phone number)' },
        message: { type: 'string', description: 'SMS message text (keep under 320 chars for single SMS)' },
      },
      required: ['customer_id', 'message'],
    },
  },
];

// ── New tool execution ──────────────────────────────────────────

async function executeExpandedTool(toolName, input, contextCustomerId) {
  // Try original tools first
  const originalNames = ORIGINAL_TOOLS.map(t => t.name);
  if (originalNames.includes(toolName)) {
    return executeOriginalTool(toolName, input, contextCustomerId);
  }

  // Expanded tools
  const customerId = input.customer_id || contextCustomerId;

  switch (toolName) {

    case 'check_availability': {
      const Availability = require('../../services/availability');
      const result = await Availability.getAvailableSlots(input.city, input.estimate_id);

      // Simplify for the agent — just dates and slots
      return {
        zone: result.zone?.zone_name || null,
        days: (result.days || []).slice(0, 7).map(d => ({
          date: d.date,
          dayOfWeek: d.dayOfWeek,
          slots: (d.slots || []).map(s => ({
            start: s.start,
            end: s.end,
            display: s.display,
          })),
        })),
        message: result.message || null,
      };
    }

    case 'book_appointment': {
      if (!customerId) return { error: 'customer_id required' };

      const Availability = require('../../services/availability');
      const result = await Availability.confirmBooking(
        input.estimate_id || null,
        customerId,
        input.date,
        input.start_time,
        input.customer_notes || null
      );

      return {
        booked: true,
        confirmationCode: result.confirmationCode,
        date: input.date,
        time: input.start_time,
        message: 'Appointment confirmed. Customer and Adam have been notified via SMS.',
      };
    }

    case 'send_payment_link': {
      if (!customerId) return { error: 'customer_id required' };

      const InvoiceService = require('../../services/invoice');

      let invoiceId = input.invoice_id;

      // If no invoice specified, find the most recent unpaid one
      if (!invoiceId) {
        const unpaid = await db('invoices')
          .where({ customer_id: customerId })
          .whereNotIn('status', ['paid', 'void'])
          .orderBy('created_at', 'desc')
          .first();

        if (unpaid) {
          invoiceId = unpaid.id;
        } else if (input.amount && input.description) {
          // Create a new invoice
          const customer = await db('customers').where('id', customerId).first();
          const newInvoice = await InvoiceService.create({
            customerId,
            title: input.description,
            lineItems: [{ description: input.description, quantity: 1, unit_price: input.amount }],
            taxRate: customer?.tax_rate || 0,
          });
          invoiceId = newInvoice.id;
        } else {
          return { error: 'No unpaid invoice found. Provide amount and description to create one.' };
        }
      }

      // Send the pay link via SMS
      const sendResult = await InvoiceService.sendViaSMS(invoiceId);
      const invoice = await db('invoices').where('id', invoiceId).first();

      return {
        sent: true,
        invoiceNumber: invoice.invoice_number,
        amount: parseFloat(invoice.total),
        payUrl: sendResult.payUrl,
        status: invoice.status,
      };
    }

    case 'check_payment_status': {
      if (!customerId) return { error: 'customer_id required' };

      let invoice;
      if (input.invoice_id) {
        invoice = await db('invoices').where({ id: input.invoice_id, customer_id: customerId }).first();
      } else {
        // Most recent invoice
        invoice = await db('invoices')
          .where({ customer_id: customerId })
          .orderBy('created_at', 'desc')
          .first();
      }

      if (!invoice) return { found: false, message: 'No invoices found for this customer.' };

      return {
        found: true,
        invoiceNumber: invoice.invoice_number,
        amount: parseFloat(invoice.total),
        status: invoice.status,
        dueDate: invoice.due_date,
        paidAt: invoice.paid_at,
        cardBrand: invoice.card_brand,
        cardLastFour: invoice.card_last_four,
        sentAt: invoice.sms_sent_at,
      };
    }

    case 'get_property_profile': {
      if (!customerId) return { error: 'customer_id required' };

      const [customer, prefs] = await Promise.all([
        db('customers').where('id', customerId).first(),
        db('property_preferences').where('customer_id', customerId).first(),
      ]);

      if (!customer) return { error: 'Customer not found' };

      return {
        address: `${customer.address_line1}, ${customer.city}, FL ${customer.zip}`,
        property_sqft: customer.property_sqft,
        lot_sqft: customer.lot_sqft,
        property_type: customer.property_type,
        grass_type: customer.grass_type,
        preferences: prefs ? {
          gate_code: prefs.neighborhood_gate_code || prefs.property_gate_code,
          pets: prefs.pet_count > 0 ? `${prefs.pet_count} pet(s): ${prefs.pet_details}` : 'No pets',
          pet_secured_plan: prefs.pets_secured_plan,
          irrigation: prefs.irrigation_system ? `Yes — ${prefs.irrigation_zones} zones, ${prefs.irrigation_schedule_notes || 'no notes'}` : 'No irrigation',
          hoa: prefs.hoa_name ? `${prefs.hoa_name}: ${prefs.hoa_restrictions || 'no restrictions noted'}` : 'No HOA',
          preferred_day: prefs.preferred_day,
          preferred_time: prefs.preferred_time,
          contact_preference: prefs.contact_preference,
          special_instructions: prefs.special_instructions,
          chemical_sensitivities: prefs.chemical_sensitivities ? prefs.chemical_sensitivity_details : null,
        } : null,
      };
    }

    case 'get_lawn_health': {
      if (!customerId) return { error: 'customer_id required' };

      const assessments = await db('lawn_assessments')
        .where({ customer_id: customerId })
        .orderBy('service_date', 'asc');

      if (!assessments.length) {
        return { has_assessments: false, message: 'No lawn health assessments on file yet.' };
      }

      const score = (row) => ({
        date: row.service_date,
        turf_density: row.turf_density,
        weed_suppression: row.weed_suppression,
        fungus_control: row.fungus_control,
        thatch_level: row.thatch_level,
        color_health: row.color_health,
        overall: Math.round((row.turf_density + row.weed_suppression + row.fungus_control + (row.color_health || 0) + (row.thatch_level || 0)) / 5),
        notes: row.observations,
      });

      const initial = assessments[0];
      const latest = assessments[assessments.length - 1];

      return {
        has_assessments: true,
        latest: score(latest),
        initial: score(initial),
        improvement: assessments.length > 1
          ? score(latest).overall - score(initial).overall
          : 0,
        total_assessments: assessments.length,
      };
    }

    case 'get_service_recommendations': {
      if (!customerId) return { error: 'customer_id required' };

      // Gather context
      const [customer, prefs, services, lawnAssessments, subscriptions] = await Promise.all([
        db('customers').where('id', customerId).first(),
        db('property_preferences').where('customer_id', customerId).first(),
        db('service_records').where('customer_id', customerId).orderBy('service_date', 'desc').limit(10),
        db('lawn_assessments').where('customer_id', customerId).orderBy('service_date', 'desc').limit(3),
        db('customer_subscriptions').where({ customer_id: customerId, status: 'active' }),
      ]);

      const month = new Date().getMonth() + 1;
      const pestPressure = await db('seasonal_pest_index').where({ month }).orderBy('sort_order');

      const activeServices = subscriptions.map(s => s.service_type);
      const latestLawn = lawnAssessments[0];

      // Build recommendations based on gaps
      const recommendations = [];

      // Check for missing core services
      if (!activeServices.some(s => /pest/i.test(s))) {
        recommendations.push({ service: 'General Pest Control', reason: 'No active pest control subscription — SWFL properties need year-round protection.', priority: 'high' });
      }
      if (!activeServices.some(s => /lawn/i.test(s)) && customer?.grass_type) {
        recommendations.push({ service: 'Lawn Care', reason: `${customer.grass_type} lawn detected but no active lawn care plan.`, priority: 'high' });
      }
      if (!activeServices.some(s => /mosquito/i.test(s)) && month >= 4 && month <= 10) {
        recommendations.push({ service: 'Mosquito Control', reason: 'Peak mosquito season — no active mosquito plan.', priority: 'medium' });
      }
      if (!activeServices.some(s => /termite/i.test(s))) {
        recommendations.push({ service: 'Termite Protection', reason: 'No termite monitoring in place. SWFL subterranean termite pressure is year-round.', priority: 'medium' });
      }

      // Lawn-specific recommendations
      if (latestLawn) {
        if (latestLawn.weed_suppression < 60) recommendations.push({ service: 'Weed Treatment', reason: `Weed suppression score is ${latestLawn.weed_suppression}/100 — targeted weed treatment recommended.`, priority: 'medium' });
        if (latestLawn.fungus_control < 50) recommendations.push({ service: 'Fungicide Application', reason: `Fungus control score is ${latestLawn.fungus_control}/100 — preventive fungicide recommended.`, priority: 'high' });
        if (latestLawn.thatch_level < 50) recommendations.push({ service: 'Dethatching', reason: `Thatch score is ${latestLawn.thatch_level}/100 — mechanical dethatching may help.`, priority: 'low' });
      }

      // Seasonal pest pressure
      const highPressure = pestPressure.filter(p => p.pressure_level === 'high' || p.pressure_level === 'peak');

      return {
        customer_name: `${customer.first_name} ${customer.last_name}`,
        tier: customer.waveguard_tier,
        active_services: activeServices,
        property: { sqft: customer.property_sqft, grass: customer.grass_type, city: customer.city },
        recommendations,
        seasonal_pressure: highPressure.map(p => ({ pest: p.pest_name, level: p.pressure_level, service: p.service_line })),
        upsell_note: customer.waveguard_tier === 'Bronze'
          ? 'Customer is on Bronze — upgrading to Silver or Gold would add services and save 10-15% on everything.'
          : null,
      };
    }

    case 'send_sms': {
      if (!customerId) return { error: 'customer_id required' };

      const customer = await db('customers').where('id', customerId).first();
      if (!customer?.phone) return { error: 'Customer has no phone number' };

      const TwilioService = require('../../services/twilio');
      await TwilioService.sendSMS(customer.phone, input.message, {
        customerId: customer.id,
        messageType: 'ai_assistant_followup',
      });

      return { sent: true, to: customer.phone };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { TOOLS: EXPANDED_TOOLS, executeToolCall: executeExpandedTool };
