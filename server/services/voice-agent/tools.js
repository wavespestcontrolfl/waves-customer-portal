// ============================================================
// server/services/voice-agent/tools.js
// Claude tool definitions + execution against portal DB/services
// ============================================================

const db = require("../../models/db");
const config = require("../../config");

// ── Tool Definitions (Claude function calling schema) ───────
const TOOLS = [
  {
    name: "lookup_customer",
    description: "Look up a customer by phone number or name. Returns their profile, WaveGuard tier, active services, last service, health score, and any upsell opportunities. Use at the START of every call if caller ID didn't auto-match.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone number to search" },
        name: { type: "string", description: "Customer name to search (fallback)" },
      },
      required: [],
    },
  },
  {
    name: "classify_inquiry",
    description: "Classify the call into a service category and assign urgency. Call this once you understand the caller's need.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["general_pest", "termite_wdo", "lawn_care", "mosquito", "tree_shrub", "billing", "scheduling", "emergency", "other"],
        },
        subcategory: { type: "string", description: "Specific issue (e.g. german_roach, wdo_inspection, chinch_bug, fire_ants)" },
        urgency: { type: "integer", description: "1-5 (1=info, 5=emergency)" },
        summary: { type: "string", description: "One-sentence summary" },
      },
      required: ["category", "urgency", "summary"],
    },
  },
  {
    name: "capture_lead",
    description: "Capture a new lead and create an estimate record in the pipeline. This is the primary revenue action — every missed call that becomes a lead goes through here. The estimate pipeline will auto-run property lookup and generate pricing.",
    input_schema: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Full name" },
        phone: { type: "string" },
        email: { type: "string" },
        property_address: { type: "string", description: "Full street address including city" },
        service_category: {
          type: "string",
          enum: ["general_pest", "termite_wdo", "lawn_care", "mosquito", "tree_shrub", "rodent", "mole", "wildlife", "stinging_insect", "other"],
        },
        issue_description: { type: "string", description: "What the caller described" },
        urgency: { type: "integer", description: "1-5" },
        is_existing_customer: { type: "boolean" },
        customer_id: { type: "integer", description: "If existing customer, their DB ID" },
        waveguard_tier: { type: "string", enum: ["none", "bronze", "silver", "gold", "platinum"] },
        referral_source: { type: "string", description: "How they heard about us" },
        notes: { type: "string", description: "Pets, gate codes, preferred time, etc." },
      },
      required: ["caller_name", "phone", "property_address", "service_category", "issue_description", "urgency"],
    },
  },
  {
    name: "get_upcoming_services",
    description: "Get upcoming scheduled services for a customer. Use when an existing customer asks about their next appointment.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "integer", description: "Customer DB ID" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "get_service_history",
    description: "Get recent completed services for a customer. Use when they ask about what was done last time.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "integer", description: "Customer DB ID" },
        limit: { type: "integer", description: "How many records (default 5)" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "flag_emergency",
    description: "Flag an emergency. Sends immediate SMS alert to business owner and lead technician. Use for safety-critical: wasp/hornet nest near people, active swarming, wildlife intrusion, etc.",
    input_schema: {
      type: "object",
      properties: {
        caller_name: { type: "string" },
        phone: { type: "string" },
        address: { type: "string" },
        emergency_type: { type: "string", description: "stinging_insects_near_people, active_swarm, wildlife_intrusion, other" },
        description: { type: "string", description: "Details of the situation" },
      },
      required: ["phone", "emergency_type", "description"],
    },
  },
  {
    name: "suggest_upsell",
    description: "Get the right upsell suggestion based on customer's current tier and what they're calling about. Returns a natural talking point. Do NOT read verbatim — weave into conversation.",
    input_schema: {
      type: "object",
      properties: {
        current_tier: { type: "string", enum: ["none", "bronze", "silver", "gold", "platinum"] },
        current_services: {
          type: "array",
          items: { type: "string" },
          description: "Services they currently have",
        },
        calling_about: { type: "string", description: "What they called about today" },
        customer_id: { type: "integer", description: "Customer DB ID if known" },
      },
      required: ["current_tier", "calling_about"],
    },
  },
  {
    name: "check_availability",
    description: "Check available service windows. Returns open slots based on service type and area.",
    input_schema: {
      type: "object",
      properties: {
        service_type: { type: "string" },
        preferred_date: { type: "string", description: "YYYY-MM-DD or 'next_available'" },
        preferred_time: { type: "string", enum: ["morning", "afternoon", "any"] },
        city: { type: "string", description: "Customer city for route optimization" },
      },
      required: ["service_type"],
    },
  },
  {
    name: "book_appointment",
    description: "Book a service appointment. Creates a scheduled_services record and sends SMS confirmation.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "integer" },
        customer_name: { type: "string" },
        phone: { type: "string" },
        address: { type: "string" },
        service_type: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time_window: { type: "string", enum: ["morning", "afternoon"] },
        notes: { type: "string" },
      },
      required: ["customer_name", "phone", "address", "service_type", "date", "time_window"],
    },
  },
  {
    name: "send_portal_link",
    description: "Send the customer a text with a link to the Waves customer portal for billing, account, or service info.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string" },
        context: { type: "string", enum: ["billing", "account", "general"] },
      },
      required: ["phone"],
    },
  },
  {
    name: "escalate",
    description: "Escalate to human review. Use when: customer wants to speak to owner/manager, billing dispute, cancellation request, complaint, or anything you're uncertain about.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why this needs human attention" },
        category: {
          type: "string",
          enum: ["cancellation", "complaint", "billing_dispute", "manager_request", "complex_issue", "uncertain"],
        },
        customer_id: { type: "integer" },
        phone: { type: "string" },
        summary: { type: "string", description: "Brief context for the human reviewer" },
      },
      required: ["reason", "category"],
    },
  },
  {
    name: "log_call_outcome",
    description: "Log the final call outcome. ALWAYS call this as the conversation ends.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        urgency: { type: "integer" },
        outcome: {
          type: "string",
          enum: ["lead_captured", "appointment_booked", "billing_deflected", "emergency_flagged", "info_provided", "callback_requested", "escalated", "wrong_number", "hangup"],
        },
        summary: { type: "string", description: "2-3 sentence call summary" },
        customer_id: { type: "integer" },
        upsell_attempted: { type: "boolean" },
        upsell_interest: { type: "boolean" },
        follow_up_required: { type: "boolean" },
        follow_up_notes: { type: "string" },
      },
      required: ["category", "outcome", "summary"],
    },
  },
];

// ── Tool Execution ──────────────────────────────────────────
async function executeTool(toolName, input, sessionData) {
  switch (toolName) {

    // ── LOOKUP CUSTOMER ───────────────────────────────────
    case "lookup_customer": {
      const phone = input.phone?.replace(/\D/g, "").slice(-10);
      const name = input.name;

      let customer;
      if (phone) {
        customer = await db("customers")
          .where(function () {
            this.where("phone", "like", `%${phone}`)
              .orWhere("phone_alt", "like", `%${phone}`);
          })
          .first();
      }
      if (!customer && name) {
        customer = await db("customers")
          .whereRaw("LOWER(first_name || ' ' || last_name) LIKE ?", [`%${name.toLowerCase()}%`])
          .first();
      }

      if (!customer) return { found: false };

      // Get active services
      const services = await db("service_records")
        .where({ customer_id: customer.id })
        .where("service_date", ">=", db.raw("NOW() - INTERVAL '90 days'"))
        .select("service_type", "service_date")
        .orderBy("service_date", "desc")
        .limit(5);

      // Get health score
      const healthRow = await db("customer_health_scores")
        .where({ customer_id: customer.id })
        .orderBy("scored_at", "desc")
        .first();

      // Get upsell opportunities
      const upsells = await db("upsell_opportunities")
        .where({ customer_id: customer.id, status: "pending" })
        .select("service_type", "description", "estimated_monthly")
        .limit(3);

      sessionData.customerData = {
        found: true,
        id: customer.id,
        name: `${customer.first_name} ${customer.last_name}`,
        first_name: customer.first_name,
        tier: customer.waveguard_tier || "none",
        address: customer.service_address,
        city: customer.city,
        email: customer.email,
        services: services.map(s => ({ type: s.service_type, date: s.service_date })),
        last_service: services[0] || null,
        monthly_rate: customer.monthly_rate,
        health_score: healthRow?.score || null,
        balance: customer.balance || 0,
        notes: customer.internal_notes,
        upsell_opportunities: upsells,
      };

      return sessionData.customerData;
    }

    // ── CLASSIFY INQUIRY ──────────────────────────────────
    case "classify_inquiry": {
      sessionData.classification = input;
      console.log(`[VoiceAgent] 📋 Classified: ${input.category} | Urgency: ${input.urgency}`);

      if (input.category === "termite_wdo") {
        console.log("[VoiceAgent] 🚨 HIGH-VALUE: Termite/WDO lead");
      }

      return {
        classified: true,
        priority_flag: input.category === "termite_wdo" || input.urgency >= 4,
      };
    }

    // ── CAPTURE LEAD → ESTIMATE PIPELINE ──────────────────
    case "capture_lead": {
      sessionData.extractedData = input;

      // Create or find customer
      let customerId = input.customer_id;
      if (!customerId) {
        // Check if phone already exists
        const normalized = input.phone?.replace(/\D/g, "").slice(-10);
        const existing = await db("customers")
          .where("phone", "like", `%${normalized}`)
          .first();

        if (existing) {
          customerId = existing.id;
        } else {
          // Create new customer
          const nameParts = (input.caller_name || "").trim().split(/\s+/);
          const firstName = nameParts[0] || "Unknown";
          const lastName = nameParts.slice(1).join(" ") || "";

          try {
            const [row] = await db("customers").insert({
              first_name: firstName,
              last_name: lastName,
              phone: input.phone,
              email: input.email || null,
              address_line1: input.property_address || '',
              city: extractCity(input.property_address) || '',
              state: 'FL', zip: '',
              waveguard_tier: input.waveguard_tier || "none",
              lead_source: "voice_agent",
              internal_notes: input.notes || null,
              created_at: new Date(),
            }).returning("id");
            customerId = row?.id || row;
            console.log(`[VoiceAgent] 👤 New customer created: ${customerId}`);
          } catch (err) {
            console.error("[VoiceAgent] Failed to create customer:", err.message);
          }
        }
      }

      // Create estimate record
      let estimateId = null;
      try {
        const [row] = await db("estimates").insert({
          customer_id: customerId || null,
          customer_name: input.caller_name,
          phone: input.phone,
          email: input.email || null,
          property_address: input.property_address,
          service_type: input.service_category,
          description: input.issue_description,
          urgency: input.urgency,
          source: "voice_agent",
          status: "new",
          referral_source: input.referral_source || null,
          notes: input.notes || null,
          is_priority: input.service_category === "termite_wdo" || input.urgency >= 4,
          created_at: new Date(),
        }).returning("id");
        estimateId = row?.id || row;
        sessionData.leadId = estimateId;
        console.log(`[VoiceAgent] ✅ Estimate created: #${estimateId} → pipeline running`);
      } catch (err) {
        console.error("[VoiceAgent] Failed to create estimate:", err.message);
      }

      // Log customer interaction
      if (customerId) {
        try {
          await db("customer_interactions").insert({
            customer_id: customerId,
            type: "voice_agent_lead",
            channel: "voice",
            summary: `Voice agent captured lead: ${input.service_category} — ${input.issue_description}`,
            metadata: JSON.stringify({
              urgency: input.urgency,
              estimate_id: estimateId,
              referral: input.referral_source,
            }),
            created_at: new Date(),
          });
        } catch (_) {}
      }

      return {
        success: true,
        estimate_id: estimateId,
        customer_id: customerId,
        message: "Lead captured — estimate pipeline initiated. Customer will receive SMS estimate.",
      };
    }

    // ── GET UPCOMING SERVICES ─────────────────────────────
    case "get_upcoming_services": {
      const upcoming = await db("scheduled_services")
        .where({ customer_id: input.customer_id })
        .where("scheduled_date", ">=", db.raw("CURRENT_DATE"))
        .orderBy("scheduled_date", "asc")
        .limit(5)
        .select("service_type", "scheduled_date", "time_window", "technician_name", "status", "notes");

      return {
        count: upcoming.length,
        services: upcoming.map(s => ({
          type: s.service_type,
          date: s.scheduled_date,
          window: s.time_window,
          tech: s.technician_name,
          status: s.status,
        })),
      };
    }

    // ── GET SERVICE HISTORY ───────────────────────────────
    case "get_service_history": {
      const history = await db("service_records")
        .where({ customer_id: input.customer_id })
        .orderBy("service_date", "desc")
        .limit(input.limit || 5)
        .select("service_type", "service_date", "tech_notes", "products_used", "revenue");

      return {
        count: history.length,
        services: history.map(s => ({
          type: s.service_type,
          date: s.service_date,
          notes: s.tech_notes,
          products: s.products_used,
        })),
      };
    }

    // ── FLAG EMERGENCY ────────────────────────────────────
    case "flag_emergency": {
      // Create urgent interaction record
      const customerId = sessionData.customerData?.id;

      try {
        await db("customer_interactions").insert({
          customer_id: customerId || null,
          type: "emergency",
          channel: "voice",
          summary: `EMERGENCY: ${input.emergency_type} — ${input.description}`,
          metadata: JSON.stringify({
            address: input.address,
            phone: input.phone,
            caller_name: input.caller_name,
          }),
          requires_followup: true,
          created_at: new Date(),
        });
      } catch (_) {}

      // Create AI escalation for immediate review
      try {
        await db("ai_escalations").insert({
          conversation_id: sessionData.aiConversationId,
          customer_id: customerId || null,
          reason: `EMERGENCY: ${input.emergency_type}`,
          category: "emergency",
          summary: `${input.caller_name || "Caller"} at ${input.address || "unknown address"}: ${input.description}`,
          status: "pending",
          priority: "urgent",
          created_at: new Date(),
        });
      } catch (_) {}

      // Send SMS alert to owner via Twilio (if gate enabled)
      try {
        const TwilioService = require("../twilio");
        if (config.adamPhone) {
          await TwilioService.sendSMS(
            config.adamPhone,
            `🚨 EMERGENCY — Voice Agent\n${input.emergency_type}\n${input.caller_name || "Unknown"}: ${input.phone}\n${input.address || "No address"}\n${input.description}`
          );
        }
      } catch (err) {
        console.error("[VoiceAgent] Emergency SMS failed:", err.message);
      }

      console.log(`[VoiceAgent] 🚨 EMERGENCY: ${input.emergency_type}`);
      return {
        success: true,
        escalated: true,
        message: "Emergency alert sent to owner and lead technician.",
      };
    }

    // ── SUGGEST UPSELL ────────────────────────────────────
    case "suggest_upsell": {
      // Check DB for existing upsell opportunities
      let dbUpsells = [];
      if (input.customer_id) {
        dbUpsells = await db("upsell_opportunities")
          .where({ customer_id: input.customer_id, status: "pending" })
          .select("service_type", "description", "estimated_monthly")
          .limit(2);
      }

      if (dbUpsells.length > 0) {
        return {
          source: "customer_intelligence",
          suggestions: dbUpsells.map(u => u.description),
        };
      }

      // Fallback logic
      const { current_tier, current_services = [], calling_about } = input;
      let suggestion = null;

      if (current_tier === "none") {
        suggestion = "Mention WaveGuard membership — bundled services, guaranteed pricing, priority scheduling.";
      } else if (current_tier === "bronze" && /interior|inside|roach|kitchen|bathroom/i.test(calling_about)) {
        suggestion = "Gold tier includes interior pest coverage — could save them vs. one-time interior treatments.";
      } else if (current_tier === "bronze" || current_tier === "silver") {
        suggestion = "Upgrading to Gold gets interior pest coverage + 10% bundle discount on all services.";
      } else if (!current_services.includes("lawn_care")) {
        suggestion = "Many pest customers add lawn care — bundled for a WaveGuard discount.";
      } else if (!current_services.includes("mosquito")) {
        suggestion = "Mosquito barrier spray pairs well with existing services — especially this time of year.";
      }

      return { suggestion };
    }

    // ── CHECK AVAILABILITY ────────────────────────────────
    case "check_availability": {
      // Query dispatch for open slots
      try {
        const csr = await db("dispatch_csr_bookings")
          .where("date", ">=", db.raw("CURRENT_DATE"))
          .orderBy("date", "asc")
          .limit(6)
          .select("date", "time_window", "available_slots", "recommended");

        if (csr.length > 0) {
          return {
            slots: csr.map(s => ({
              date: s.date,
              window: s.time_window,
              available: s.available_slots,
              recommended: s.recommended,
            })),
          };
        }
      } catch (_) {}

      // Fallback — general availability
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (tomorrow.getDay() === 0) tomorrow.setDate(tomorrow.getDate() + 1);
      if (tomorrow.getDay() === 6) tomorrow.setDate(tomorrow.getDate() + 2);

      const dayAfter = new Date(tomorrow);
      dayAfter.setDate(dayAfter.getDate() + 1);
      if (dayAfter.getDay() === 0) dayAfter.setDate(dayAfter.getDate() + 1);

      return {
        slots: [
          { date: tomorrow.toISOString().split("T")[0], window: "morning", note: "Team will confirm exact time" },
          { date: tomorrow.toISOString().split("T")[0], window: "afternoon", note: "Team will confirm exact time" },
          { date: dayAfter.toISOString().split("T")[0], window: "morning", note: "Team will confirm exact time" },
        ],
        note: "Our team will confirm the exact time window.",
      };
    }

    // ── BOOK APPOINTMENT ──────────────────────────────────
    case "book_appointment": {
      try {
        const [row] = await db("scheduled_services").insert({
          customer_id: input.customer_id || null,
          customer_name: input.customer_name,
          phone: input.phone,
          service_address: input.address,
          service_type: input.service_type,
          scheduled_date: input.date,
          time_window: input.time_window,
          status: "scheduled",
          source: "voice_agent",
          notes: input.notes || null,
          created_at: new Date(),
        }).returning("id");

        // Send SMS confirmation
        try {
          const TwilioService = require("../twilio");
          await TwilioService.sendSMS(
            input.phone,
            `✅ Waves Pest Control — Appointment Confirmed\n${input.service_type} on ${input.date} (${input.time_window})\nAddress: ${input.address}\n\nQuestions? Reply to this text or call us anytime.`
          );
        } catch (err) {
          console.error("[VoiceAgent] Confirmation SMS failed:", err.message);
        }

        return {
          success: true,
          appointment_id: row?.id || row,
          message: `Booked ${input.service_type} for ${input.date} (${input.time_window}). SMS confirmation sent.`,
        };
      } catch (err) {
        console.error("[VoiceAgent] Booking failed:", err.message);
        return {
          success: false,
          message: "Booking noted — team will confirm via text.",
          needs_confirmation: true,
        };
      }
    }

    // ── SEND PORTAL LINK ──────────────────────────────────
    case "send_portal_link": {
      try {
        const TwilioService = require("../twilio");
        const portalUrl = config.clientUrl || "https://portal.wavespestcontrol.com";
        await TwilioService.sendSMS(
          input.phone,
          `Waves Pest Control — Here's your customer portal link: ${portalUrl}\n\nYou can view invoices, make payments, and manage your account. 🌊`
        );
        return { success: true, message: "Portal link sent via SMS." };
      } catch (err) {
        return { success: false, message: "Couldn't send link — direct them to wavespestcontrol.com" };
      }
    }

    // ── ESCALATE ──────────────────────────────────────────
    case "escalate": {
      try {
        await db("ai_escalations").insert({
          conversation_id: sessionData.aiConversationId,
          customer_id: input.customer_id || sessionData.customerData?.id || null,
          reason: input.reason,
          category: input.category,
          summary: input.summary || input.reason,
          status: "pending",
          priority: input.category === "complaint" || input.category === "cancellation" ? "high" : "normal",
          created_at: new Date(),
        });

        // SMS notify for high-priority escalations
        if (["cancellation", "complaint", "manager_request"].includes(input.category)) {
          try {
            const TwilioService = require("../twilio");
            if (config.adamPhone) {
              await TwilioService.sendSMS(
                config.adamPhone,
                `⚠️ Voice Agent Escalation (${input.category})\n${input.phone || ""}\n${input.summary || input.reason}`
              );
            }
          } catch (_) {}
        }

        return { success: true, escalated: true, message: "Escalated for human follow-up." };
      } catch (err) {
        console.error("[VoiceAgent] Escalation failed:", err.message);
        return { success: false, message: "Noted for follow-up." };
      }
    }

    // ── LOG CALL OUTCOME ──────────────────────────────────
    case "log_call_outcome": {
      sessionData.outcome = input.outcome;

      // Update call_log
      try {
        await db("call_log")
          .where({ call_sid: sessionData.callSid || "" })
          .update({
            voice_agent_classification: JSON.stringify({
              category: input.category,
              urgency: input.urgency,
            }),
            voice_agent_outcome: input.outcome,
          });
      } catch (_) {}

      // Log CSR-style score for the voice agent call
      try {
        await db("csr_call_scores").insert({
          call_sid: sessionData.callSid || `voice-${Date.now()}`,
          phone: sessionData.callerPhone,
          customer_id: input.customer_id || sessionData.customerData?.id || null,
          agent_type: "voice_agent",
          category: input.category,
          outcome: input.outcome,
          summary: input.summary,
          upsell_attempted: input.upsell_attempted || false,
          upsell_interest: input.upsell_interest || false,
          follow_up_required: input.follow_up_required || false,
          follow_up_notes: input.follow_up_notes || null,
          created_at: new Date(),
        });
      } catch (_) {}

      // Create follow-up task if needed
      if (input.follow_up_required) {
        try {
          await db("ai_follow_up_tasks").insert({
            customer_id: input.customer_id || sessionData.customerData?.id || null,
            type: "voice_agent_followup",
            description: input.follow_up_notes || input.summary,
            status: "pending",
            priority: input.urgency >= 4 ? "high" : "normal",
            created_at: new Date(),
          });
        } catch (_) {}
      }

      return { logged: true };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Helpers ─────────────────────────────────────────────────
function extractCity(address) {
  if (!address) return null;
  const cities = ["Bradenton", "Parrish", "Sarasota", "Venice", "Lakewood Ranch", "North Port", "Port Charlotte", "Palmetto", "Ellenton"];
  const lower = address.toLowerCase();
  for (const city of cities) {
    if (lower.includes(city.toLowerCase())) return city;
  }
  return null;
}

module.exports = { TOOLS, executeTool };
