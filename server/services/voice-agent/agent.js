// ============================================================
// server/services/voice-agent/agent.js
// Waves Pest Control — AI Voice Agent Service
// ============================================================
// Plugs into existing portal architecture:
//   - Uses portal DB (customers, call_log, estimates, etc.)
//   - Uses portal services (twilio.js, context-aggregator.js, ai-assistant/)
//   - Uses portal feature gates (GATE_TWILIO_VOICE)
//   - Shares Anthropic API key with existing AI assistant
//
// Architecture:
//   Inbound call → Twilio (25s ring, no answer)
//   → ConversationRelay → WebSocket → This service
//   → Claude API w/ tool use → Portal DB + APIs
//   → Structured lead data → estimates table → auto-estimate pipeline
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");
const config = require("../../config");
const { isEnabled: checkGate } = require("../../config/feature-gates");
const db = require("../../models/db");

const { SYSTEM_PROMPT, buildDynamicPrompt } = require("./system-prompt");
const { TOOLS, executeTool } = require("./tools");

let anthropic; try { anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { anthropic = null; }

// ── #7: Spanish Language Detection Words ───────────────────
const SPANISH_INDICATORS = [
  'hola', 'necesito', 'ayuda', 'hablar', 'servicio', 'plaga', 'casa',
  'buenos', 'buenas', 'gracias', 'por favor', 'tengo', 'quiero',
  'problema', 'hormigas', 'cucarachas', 'ratas', 'mosquitos',
  'jardin', 'cesped', 'precio', 'cita', 'llamar',
];

// ── Active call sessions (in-memory, keyed by callSid) ─────
const sessions = new Map();

// ── Agent Configuration (persisted to DB, cached here) ──────
let agentConfig = {
  enabled: false,              // master toggle
  afterHoursOnly: true,        // default: only active outside business hours
  businessHours: { start: 8, end: 18 },
  maxRingSeconds: 25,
  model: "claude-sonnet-4-20250514",
  ttsProvider: "ElevenLabs",
  ttsVoice: "Rachel",
  sttProvider: "Deepgram",
};

// ── Load config from DB on startup ──────────────────────────
async function initVoiceAgent() {
  try {
    const saved = await db("system_config")
      .where({ key: "voice_agent_config" })
      .first();
    if (saved?.value) {
      agentConfig = { ...agentConfig, ...JSON.parse(saved.value) };
    }
  } catch (err) {
    // Table might not exist yet — use defaults
    console.log("[VoiceAgent] Using default config (no DB row found)");
  }
  console.log(`[VoiceAgent] Initialized — enabled: ${agentConfig.enabled}, mode: ${agentConfig.afterHoursOnly ? "after-hours" : "always"}`);
}

// ── Save config to DB ───────────────────────────────────────
async function saveConfig() {
  try {
    await db("system_config")
      .insert({
        key: "voice_agent_config",
        value: JSON.stringify(agentConfig),
        updated_at: new Date(),
      })
      .onConflict("key")
      .merge();
  } catch (err) {
    console.error("[VoiceAgent] Failed to save config:", err.message);
  }
}

// ── Business Hours Check (Eastern Time) ─────────────────────
function isBusinessHours() {
  const now = new Date();
  // Get ET offset (handles EDT/EST automatically)
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etString);
  const hour = etDate.getHours();
  const day = etDate.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  return hour >= agentConfig.businessHours.start && hour < agentConfig.businessHours.end;
}

// ── Should Agent Handle This Call? ──────────────────────────
function shouldAgentHandle() {
  if (!agentConfig.enabled) return false;
  if (!checkGate("twilioVoice")) return false;
  if (agentConfig.afterHoursOnly && isBusinessHours()) return false;
  return true;
}

// ── Get/Update Config (for admin API) ───────────────────────
function getConfig() {
  return {
    ...agentConfig,
    is_business_hours: isBusinessHours(),
    currently_active: shouldAgentHandle(),
    active_calls: sessions.size,
    gate_enabled: checkGate("twilioVoice"),
  };
}

async function updateConfig(updates) {
  Object.assign(agentConfig, updates);
  await saveConfig();
  return getConfig();
}

// ── Customer Lookup (uses portal DB directly) ───────────────
async function lookupCustomerByPhone(phone) {
  if (!phone) return null;

  // Normalize phone
  const normalized = phone.replace(/\D/g, "").slice(-10);

  const customer = await db("customers")
    .where(function () {
      this.where("phone", "like", `%${normalized}`)
        .orWhere("phone_alt", "like", `%${normalized}`);
    })
    .first();

  if (!customer) return null;

  // Pull full context using the existing aggregator
  try {
    const aggregator = require("../context-aggregator");
    const context = await aggregator.getFullCustomerContext(customer.phone);
    return {
      found: true,
      id: customer.id,
      name: `${customer.first_name} ${customer.last_name}`,
      first_name: customer.first_name,
      tier: customer.waveguard_tier || "none",
      address: customer.service_address,
      city: customer.city,
      services: context.activeServices || [],
      last_service: context.lastService || null,
      monthly_rate: customer.monthly_rate,
      health_score: context.healthScore || null,
      notes: customer.internal_notes,
      balance: context.balance || 0,
      upsell_opportunities: context.upsellOpportunities || [],
    };
  } catch (err) {
    // Fallback if aggregator isn't available
    return {
      found: true,
      id: customer.id,
      name: `${customer.first_name} ${customer.last_name}`,
      first_name: customer.first_name,
      tier: customer.waveguard_tier || "none",
      address: customer.service_address,
      city: customer.city,
    };
  }
}

// ── Log Call to DB (uses existing call_log table) ───────────
async function logCallStart(callSid, from, to) {
  try {
    await db("call_log").insert({
      call_sid: callSid,
      from_number: from,
      to_number: to,
      direction: "inbound",
      status: "voice-agent",
      answered_by: "voice_agent",
      started_at: new Date(),
    });
  } catch (err) {
    console.error("[VoiceAgent] Failed to log call start:", err.message);
  }
}

async function logCallEnd(callSid, sessionData) {
  try {
    const transcript = sessionData.conversation
      .filter(m => typeof m.content === "string")
      .map(m => `${m.role === "user" ? "Caller" : "Agent"}: ${m.content}`)
      .join("\n");

    await db("call_log")
      .where({ call_sid: callSid })
      .update({
        ended_at: new Date(),
        duration_seconds: Math.round((Date.now() - new Date(sessionData.startTime).getTime()) / 1000),
        transcription: transcript,
        voice_agent_classification: sessionData.classification
          ? JSON.stringify(sessionData.classification) : null,
        voice_agent_outcome: sessionData.outcome || null,
        voice_agent_lead_id: sessionData.leadId || null,
      });
  } catch (err) {
    console.error("[VoiceAgent] Failed to log call end:", err.message);
  }
}

// ── #5: Post-Call Survey ────────────────────────────────────
function sendPostCallSurvey(callSid, callerPhone) {
  if (!callerPhone) return;
  // Wait 5 minutes then send survey SMS
  setTimeout(async () => {
    try {
      const TwilioService = require("../twilio");
      await TwilioService.sendSMS(
        callerPhone,
        "Thanks for calling Waves Pest Control! How was your experience? Reply 1-5 (1=poor, 5=excellent)",
        { messageType: "post_call_survey" }
      );
      // Store pending survey for matching when they reply
      try {
        await db("system_config")
          .insert({
            key: `survey_pending_${callerPhone.replace(/\D/g, "").slice(-10)}`,
            value: JSON.stringify({ callSid, phone: callerPhone, sentAt: new Date().toISOString() }),
            updated_at: new Date(),
          })
          .onConflict("key")
          .merge();
      } catch (_) {}
      console.log(`[VoiceAgent] Post-call survey sent to ${callerPhone} for ${callSid}`);
    } catch (err) {
      console.error("[VoiceAgent] Post-call survey failed:", err.message);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

/**
 * Handle a post-call survey reply. Called from the SMS webhook.
 * @param {string} phone - Normalized phone (last 10 digits)
 * @param {string} body - SMS body (should be 1-5)
 * @returns {{ handled: boolean }} whether this was a survey response
 */
async function handleSurveyReply(phone, body) {
  const normalized = phone.replace(/\D/g, "").slice(-10);
  const key = `survey_pending_${normalized}`;
  try {
    const pending = await db("system_config").where({ key }).first();
    if (!pending) return { handled: false };

    const rating = parseInt((body || "").trim());
    if (isNaN(rating) || rating < 1 || rating > 5) return { handled: false };

    const surveyData = JSON.parse(pending.value);

    // Log the survey rating to call_log
    await db("call_log")
      .where(function () {
        this.where("twilio_call_sid", surveyData.callSid).orWhere("call_sid", surveyData.callSid);
      })
      .update({
        metadata: db.raw(`
          COALESCE(metadata::jsonb, '{}'::jsonb) || ?::jsonb
        `, [JSON.stringify({ survey_rating: rating, survey_replied_at: new Date().toISOString() })]),
        updated_at: new Date(),
      });

    // Remove pending survey
    await db("system_config").where({ key }).del();

    console.log(`[VoiceAgent] Survey reply from ${phone}: ${rating}/5 for call ${surveyData.callSid}`);
    return { handled: true, rating, callSid: surveyData.callSid };
  } catch (err) {
    console.error("[VoiceAgent] Survey reply handling failed:", err.message);
    return { handled: false };
  }
}

// ── #7: Detect Spanish from transcript ──────────────────────
function detectSpanish(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const matches = SPANISH_INDICATORS.filter(w => lower.includes(w));
  return matches.length >= 2; // At least 2 Spanish words to be confident
}

// ── Streaming AI Response with Tool Use ─────────────────────
async function aiResponseStream(sessionData, ws) {
  // #6: Use dynamic prompt if available, fall back to static
  let systemPrompt = SYSTEM_PROMPT;
  try {
    if (sessionData.dynamicPrompt) {
      systemPrompt = sessionData.dynamicPrompt;
    }
  } catch (_) {}

  // #7: If Spanish was detected, append Spanish instruction
  if (sessionData.languageDetected === 'es') {
    systemPrompt += "\n\n## LANGUAGE\nThe caller is speaking Spanish. Respond in Spanish. Use natural, friendly Mexican/Central American Spanish appropriate for Southwest Florida's Latino community.";
  }

  const stream = await anthropic.messages.create({
    model: agentConfig.model,
    max_tokens: 1024,
    messages: sessionData.conversation,
    system: systemPrompt,
    tools: TOOLS,
    stream: true,
  });

  let fullResponse = "";
  let currentToolUse = null;
  let toolInput = "";

  for await (const chunk of stream) {
    // Text tokens → stream to Twilio immediately
    if (chunk.type === "content_block_delta") {
      if (chunk.delta.type === "text_delta" && chunk.delta.text) {
        fullResponse += chunk.delta.text;
        // #8: Track current response for live monitoring
        sessionData.currentResponse = fullResponse;
        ws.send(JSON.stringify({
          type: "text",
          token: chunk.delta.text,
        }));
      }
      if (chunk.delta.type === "input_json_delta" && chunk.delta.partial_json) {
        toolInput += chunk.delta.partial_json;
      }
    }

    // Tool use block started
    if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
      currentToolUse = {
        id: chunk.content_block.id,
        name: chunk.content_block.name,
      };
      toolInput = "";
    }

    // Tool use block finished → execute
    if (chunk.type === "content_block_stop" && currentToolUse) {
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(toolInput || "{}");
      } catch (e) {
        console.error("[VoiceAgent] Failed to parse tool input:", toolInput);
      }

      console.log(`[VoiceAgent] Tool: ${currentToolUse.name}`, JSON.stringify(parsedInput).substring(0, 200));

      // Execute tool against portal DB/services
      const toolResult = await executeTool(currentToolUse.name, parsedInput, sessionData);

      // Add tool use + result to conversation
      sessionData.conversation.push({
        role: "assistant",
        content: [
          ...(fullResponse ? [{ type: "text", text: fullResponse }] : []),
          {
            type: "tool_use",
            id: currentToolUse.id,
            name: currentToolUse.name,
            input: parsedInput,
          },
        ],
      });

      sessionData.conversation.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: currentToolUse.id,
          content: JSON.stringify(toolResult),
        }],
      });

      // Log tool call to ai_messages if tracking
      try {
        await db("ai_messages").insert({
          conversation_id: sessionData.aiConversationId,
          role: "tool",
          content: JSON.stringify({ tool: currentToolUse.name, input: parsedInput, result: toolResult }),
          tool_name: currentToolUse.name,
          created_at: new Date(),
        });
      } catch (_) { /* non-critical */ }

      // Reset and continue with tool results
      fullResponse = "";
      currentToolUse = null;
      toolInput = "";

      await aiResponseStream(sessionData, ws);
      return;
    }
  }

  // End of non-tool response
  if (fullResponse) {
    ws.send(JSON.stringify({ type: "text", token: "", last: true }));
    sessionData.conversation.push({ role: "assistant", content: fullResponse });
    sessionData.currentResponse = null; // #8: Clear when done

    // Log assistant message
    try {
      await db("ai_messages").insert({
        conversation_id: sessionData.aiConversationId,
        role: "assistant",
        content: fullResponse,
        created_at: new Date(),
      });
    } catch (_) { /* non-critical */ }
  }
}

// ── WebSocket Handler (called from route) ───────────────────
async function handleVoiceWebSocket(ws, req) {
  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "setup": {
          const callSid = message.callSid;
          const from = message.from || null;
          const to = message.to || null;
          console.log(`[VoiceAgent] 📞 Call setup: ${callSid} from ${from}`);

          ws.callSid = callSid;

          // Log call start
          await logCallStart(callSid, from, to);

          // Create AI conversation record
          let aiConversationId = null;
          try {
            const [row] = await db("ai_conversations").insert({
              channel: "voice",
              phone: from,
              status: "active",
              started_at: new Date(),
            }).returning("id");
            aiConversationId = row?.id || row;
          } catch (_) { /* non-critical */ }

          // #6: Build dynamic prompt for this session
          let dynamicPrompt = SYSTEM_PROMPT;
          try {
            dynamicPrompt = await buildDynamicPrompt();
          } catch (err) {
            console.log("[VoiceAgent] Dynamic prompt build failed, using static:", err.message);
          }

          // Initialize session
          const sessionData = {
            conversation: [],
            customerData: null,
            classification: null,
            extractedData: null,
            callerPhone: from,
            calledNumber: to,
            startTime: new Date().toISOString(),
            aiConversationId,
            outcome: null,
            leadId: null,
            dynamicPrompt,              // #6
            languageDetected: "en",     // #7
            currentResponse: null,      // #8
            ws,                         // #8: keep ref for inject
          };

          // Auto-lookup customer by caller ID
          if (from) {
            const customer = await lookupCustomerByPhone(from);
            if (customer?.found) {
              sessionData.customerData = customer;
              console.log(`[VoiceAgent] ✅ Existing customer: ${customer.name} (${customer.tier})`);

              // Inject context so Claude knows who's calling
              sessionData.conversation.push({
                role: "user",
                content: `[SYSTEM: Caller identified as existing customer. Customer ID: ${customer.id}. Name: ${customer.name}. WaveGuard tier: ${customer.tier}. Address: ${customer.address || "unknown"}. City: ${customer.city || "unknown"}. Active services: ${customer.services?.map(s => s.service_type || s).join(", ") || "unknown"}. Last service: ${customer.last_service?.date || "unknown"} — ${customer.last_service?.type || "unknown"}. Monthly rate: $${customer.monthly_rate || "unknown"}. Health score: ${customer.health_score || "unknown"}/100. Balance: $${customer.balance || 0}. Notes: ${customer.notes || "none"}. Upsell opportunities: ${customer.upsell_opportunities?.map(u => u.description || u).join("; ") || "none"}]`
              });
              sessionData.conversation.push({
                role: "assistant",
                content: `[Acknowledged — I'll greet ${customer.first_name} by name and reference their account naturally.]`
              });
            } else {
              console.log(`[VoiceAgent] New caller: ${from}`);
            }
          }

          sessions.set(callSid, sessionData);
          break;
        }

        case "prompt": {
          const sessionData = sessions.get(ws.callSid);
          if (!sessionData) {
            console.error("[VoiceAgent] No session for:", ws.callSid);
            return;
          }

          console.log(`[VoiceAgent] 💬 Caller: "${message.voicePrompt}"`);

          // #7: Detect Spanish on first few messages
          if (sessionData.languageDetected === "en" && sessionData.conversation.filter(m => m.role === "user" && typeof m.content === "string").length < 3) {
            if (detectSpanish(message.voicePrompt)) {
              sessionData.languageDetected = "es";
              console.log(`[VoiceAgent] 🇪🇸 Spanish detected — switching language`);
            }
            // Also check Deepgram language hint if provided
            if (message.language && message.language.startsWith("es")) {
              sessionData.languageDetected = "es";
              console.log(`[VoiceAgent] 🇪🇸 Spanish detected via STT provider`);
            }
          }

          sessionData.conversation.push({ role: "user", content: message.voicePrompt });

          // Log caller message
          try {
            await db("ai_messages").insert({
              conversation_id: sessionData.aiConversationId,
              role: "user",
              content: message.voicePrompt,
              created_at: new Date(),
            });
          } catch (_) { /* non-critical */ }

          await aiResponseStream(sessionData, ws);
          break;
        }

        case "interrupt": {
          const sessionData = sessions.get(ws.callSid);
          if (sessionData?.conversation.length > 0) {
            const last = sessionData.conversation[sessionData.conversation.length - 1];
            if (last.role === "assistant" && typeof last.content === "string") {
              last.content = message.utteranceUntilInterrupt || last.content;
            }
          }
          break;
        }

        case "dtmf": {
          console.log(`[VoiceAgent] 🔢 DTMF: ${message.digit}`);
          break;
        }

        case "end": {
          console.log(`[VoiceAgent] 📵 Call ended: ${ws.callSid}`);
          const sessionData = sessions.get(ws.callSid);
          if (sessionData) {
            await logCallEnd(ws.callSid, sessionData);

            // Close AI conversation
            try {
              await db("ai_conversations")
                .where({ id: sessionData.aiConversationId })
                .update({ status: "completed", ended_at: new Date() });
            } catch (_) {}

            // #5: Send post-call survey after 5 minutes
            if (sessionData.callerPhone && !sessionData.surveySent) {
              sessionData.surveySent = true;
              sendPostCallSurvey(ws.callSid, sessionData.callerPhone);
            }
          }
          sessions.delete(ws.callSid);
          break;
        }
      }
    } catch (err) {
      console.error("[VoiceAgent] WebSocket error:", err);
    }
  });

  ws.on("close", () => {
    if (ws.callSid) {
      const sessionData = sessions.get(ws.callSid);
      if (sessionData) {
        logCallEnd(ws.callSid, sessionData).catch(() => {});
        // #5: Send post-call survey (if not already sent via "end" message)
        if (sessionData.callerPhone && !sessionData.surveySent) {
          sessionData.surveySent = true;
          sendPostCallSurvey(ws.callSid, sessionData.callerPhone);
        }
      }
      sessions.delete(ws.callSid);
    }
  });
}

// ── Get Active Sessions (for admin dashboard) ───────────────
function getActiveCalls() {
  const active = [];
  for (const [callSid, session] of sessions) {
    active.push({
      call_sid: callSid,
      phone: session.callerPhone,
      customer: session.customerData
        ? { name: session.customerData.name, tier: session.customerData.tier, id: session.customerData.id }
        : null,
      classification: session.classification,
      start_time: session.startTime,
      message_count: session.conversation.filter(m => typeof m.content === "string").length,
    });
  }
  return active;
}

// ── #8: Get Session by CallSid (for live monitoring) ────────
function getSessionByCallSid(callSid) {
  return sessions.get(callSid) || null;
}

// ── #8: Inject Admin Message into Active Call ───────────────
async function injectMessage(callSid, message) {
  const sessionData = sessions.get(callSid);
  if (!sessionData) {
    return { success: false, error: "No active session for this call" };
  }

  // Inject as a system-level user message that the AI will see
  sessionData.conversation.push({
    role: "user",
    content: `[ADMIN OVERRIDE]: ${message}`,
  });

  // If the session has a WS reference, trigger a new AI response
  if (sessionData.ws && sessionData.ws.readyState === 1) {
    try {
      await aiResponseStream(sessionData, sessionData.ws);
      return { success: true, message: "Message injected and AI response triggered" };
    } catch (err) {
      return { success: false, error: `AI response failed: ${err.message}` };
    }
  }

  return { success: true, message: "Message injected into conversation context" };
}

// ── Recent Calls from DB (for admin dashboard) ──────────────
async function getRecentVoiceAgentCalls(limit = 50) {
  return db("call_log")
    .where({ answered_by: "voice_agent" })
    .orderBy("started_at", "desc")
    .limit(limit)
    .select(
      "call_sid", "from_number", "to_number", "started_at", "ended_at",
      "duration_seconds", "transcription",
      "voice_agent_classification", "voice_agent_outcome", "voice_agent_lead_id"
    );
}

module.exports = {
  initVoiceAgent, shouldAgentHandle, handleVoiceWebSocket,
  getConfig, updateConfig, getActiveCalls, getRecentVoiceAgentCalls,
  getSessionByCallSid, injectMessage, handleSurveyReply,
  sendPostCallSurvey,
};
