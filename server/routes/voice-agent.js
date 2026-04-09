/**
 * Voice Agent Routes v2 — TwiML, WebSocket, Admin API
 *
 * Ring-first flow:
 *   1. Play ElevenLabs Veda Sky greeting
 *   2. Simultaneous dial to both numbers (25s timeout)
 *   3. If answered → human, done
 *   4. If no answer → check voice agent toggle
 *      → ON: ConversationRelay (AI agent)
 *      → OFF: voicemail with custom audio
 */
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const {
  initVoiceAgent, shouldAgentHandle, handleVoiceWebSocket,
  getConfig, updateConfig, getActiveCalls, getRecentVoiceAgentCalls,
  getSessionByCallSid, injectMessage,
} = require('../services/voice-agent/agent');
const { analyzeSentiment } = require('../services/call-sentiment');

// ── Missed call SMS — fires when call goes to voicemail ──
async function sendMissedCallSMS(callerPhone, callerName, callSid) {
  try {
    const TwilioService = require('../services/twilio');
    const firstName = callerName ? callerName.split(/\s+/)[0] : null;
    const greeting = firstName
      ? `Hey ${firstName}, this is Waves Pest Control.`
      : `Hey, this is Waves Pest Control.`;
    const msg = `${greeting} Sorry we missed your call — we're currently on the other line. How can we help you? Just reply to this text or call us back at (941) 318-7612.`;
    await TwilioService.sendSMS(callerPhone, msg, {
      messageType: 'missed_call_followup',
    });
    console.log(`[VoiceAgent] Missed call SMS sent to ${callerPhone}`);
  } catch (err) {
    console.error(`[VoiceAgent] Missed call SMS failed: ${err.message}`);
  }
}

function voiceAgentRoutes(app, httpServer) {
  // WebSocket is set up separately in index.js after app.listen()

  // ── Voice Agent TwiML (action URL after dial timeout) ────
  app.all('/api/webhooks/twilio/voice-agent', async (req, res) => {
    try {
    const domain = process.env.SERVER_DOMAIN || req.headers.host;
    const wsUrl = `wss://${domain}/ws/voice-agent`;
    const callSid = req.body?.CallSid || req.query?.CallSid;
    const dialStatus = req.body?.DialCallStatus || req.query?.DialCallStatus;

    // Update call_log based on what happened with the dial
    const dialDuration = parseInt(req.body?.DialCallDuration || req.query?.DialCallDuration || 0);
    if (callSid) {
      try {
        if (dialStatus === 'completed' && dialDuration > 15) {
          // Human answered (call lasted > 15 seconds — not carrier voicemail)
          await db('call_log')
            .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
            .update({ answered_by: 'human', status: 'completed', duration_seconds: dialDuration });
          console.log(`[VoiceAgent] Call answered by human: ${callSid} (${dialDuration}s)`);
          return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
        } else {
          // No answer, busy, or carrier voicemail (short duration)
          const answeredBy = shouldAgentHandle() ? 'voice_agent' : 'voicemail';
          await db('call_log')
            .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
            .update({ answered_by: answeredBy, status: dialStatus || 'no-answer' });
          if (dialStatus === 'completed' && dialDuration <= 15) {
            console.log(`[VoiceAgent] Carrier voicemail detected (${dialDuration}s) → routing to Waves voicemail`);
          } else {
            console.log(`[VoiceAgent] No answer (${dialStatus}) → ${answeredBy}`);
          }
        }
      } catch (err) {
        console.error('[VoiceAgent] Failed to update call_log:', err.message);
      }
    }

    // Waves custom voicemail (plays for ALL unanswered calls — no answer, busy, or carrier VM)
    const voicemailAudio = process.env.WAVES_VOICEMAIL_URL || 'https://jet-wolverine-3713.twil.io/assets/waves-voicemail.mp3';

    if (!shouldAgentHandle()) {
      // Agent OFF → play Waves voicemail + record message
      // Send missed call SMS regardless (caller may hang up without leaving VM)
      if (from) {
        sendMissedCallSMS(from, callerName, callSid).catch(() => {});
      }
      return res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
         <Response>
           <Play>${voicemailAudio}</Play>
           <Record maxLength="120" transcribe="true"
             recordingStatusCallback="/api/webhooks/twilio/recording-status"
             transcribeCallback="/api/webhooks/twilio/transcription" />
         </Response>`
      );
    }

    // Agent ON → ConversationRelay with time-aware greeting
    const cfg = getConfig();
    const greeting = getTimeAwareGreeting();
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Response>
         <Connect>
           <ConversationRelay
             url="${wsUrl}"
             welcomeGreeting="${greeting} How can I help you today?"
             ttsProvider="${cfg.ttsProvider || 'ElevenLabs'}"
             voice="${cfg.ttsVoice || 'Rachel'}"
             transcriptionProvider="${cfg.sttProvider || 'Deepgram'}"
           />
         </Connect>
       </Response>`
    );
    } catch (err) {
      console.error('[VoiceAgent] voice-agent handler CRASH:', err.message);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are experiencing technical difficulties. Please call back or text us at 941-318-7612.</Say></Response>');
    }
  });

  // ── Ring-First TwiML (replaces Studio Flow) ────────────
  app.all('/api/webhooks/twilio/voice-ring-first', async (req, res) => {
    try {
    const domain = process.env.SERVER_DOMAIN || req.headers.host;
    const callSid = req.body?.CallSid || req.query?.CallSid;
    const from = req.body?.From || req.query?.From;
    const to = req.body?.To || req.query?.To;
    const callerCity = req.body?.CallerCity || req.query?.CallerCity;
    const callerState = req.body?.CallerState || req.query?.CallerState;

    // Log every inbound call immediately
    let callerName = null;
    if (callSid) {
      try {
        const logEntry = {
          twilio_call_sid: callSid,
          call_sid: callSid,
          from_phone: from,
          to_phone: to,
          direction: 'inbound',
          status: 'ringing',
          answered_by: null,
        };
        try {
          await db('call_log').insert({ ...logEntry, caller_city: callerCity || null, caller_state: callerState || null });
        } catch {
          await db('call_log').insert(logEntry);
        }
        console.log(`[VoiceAgent] Inbound call logged: ${callSid} from ${from}`);
      } catch (err) {
        if (!err.message?.includes('duplicate') && !err.message?.includes('unique')) {
          console.error('[VoiceAgent] Failed to log inbound call:', err.message);
        }
      }
    }

    // Match caller to customer — or create from CNAM lookup
    let customer = null;
    if (from) {
      try {
        const normalized = from.replace(/\D/g, '').slice(-10);
        customer = await db('customers').where(function () {
          this.where('phone', 'like', `%${normalized}`);
        }).first();

        if (customer) {
          // Existing customer — link to call_log
          await db('call_log')
            .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
            .update({ customer_id: customer.id });
          callerName = `${customer.first_name} ${customer.last_name}`.trim();
          console.log(`[VoiceAgent] Matched caller: ${callerName} (${customer.id})`);
        } else {
          // Unknown caller — CNAM lookup to get name and auto-create lead
          try {
            const twilioAuth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
            const lookupRes = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(from)}?Fields=caller_name`, {
              headers: { Authorization: `Basic ${twilioAuth}` },
            });
            if (lookupRes.ok) {
              const lookupData = await lookupRes.json();
              callerName = lookupData.caller_name?.caller_name;
              const callerType = lookupData.caller_name?.caller_type; // CONSUMER or BUSINESS

              if (callerName && callerName !== 'UNKNOWN' && callerName.trim().length > 1) {
                const nameParts = callerName.trim().split(/\s+/);
                const firstName = nameParts[0] || 'Unknown';
                const lastName = nameParts.slice(1).join(' ') || '';
                const numberConfig = TWILIO_NUMBERS.findByNumber(to);
                const leadSource = numberConfig ? TWILIO_NUMBERS.getLeadSourceFromNumber(to) : { source: 'phone_call' };

                try {
                  const [newCust] = await db('customers').insert({
                    first_name: firstName,
                    last_name: lastName,
                    phone: from,
                    source: 'cnam_lookup',
                    lead_source: leadSource.source || 'phone_call',
                    lead_source_detail: numberConfig?.domain || 'inbound call',
                    pipeline_stage: 'new_lead',
                    pipeline_stage_changed_at: new Date(),
                    last_contact_date: new Date(),
                    last_contact_type: 'call_inbound',
                    waveguard_tier: 'none',
                    crm_notes: `Auto-created from CNAM: ${callerName}${callerType ? ` (${callerType})` : ''}`,
                  }).returning('*');
                  customer = newCust;
                  await db('call_log')
                    .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
                    .update({ customer_id: newCust.id });
                  console.log(`[VoiceAgent] CNAM lead created: ${callerName} (${from}) → ${newCust.id}`);

                  // Auto-create Stripe customer
                  try {
                    const StripeService = require('../services/stripe');
                    await StripeService.ensureStripeCustomer(newCust.id);
                  } catch (e) { /* non-blocking */ }
                } catch (insertErr) {
                  if (!insertErr.message?.includes('duplicate') && !insertErr.message?.includes('unique')) {
                    console.error('[VoiceAgent] CNAM customer insert failed:', insertErr.message);
                  }
                }
              } else {
                console.log(`[VoiceAgent] CNAM returned no usable name for ${from}`);
              }
            }
          } catch (lookupErr) {
            console.log(`[VoiceAgent] CNAM lookup skipped: ${lookupErr.message}`);
          }
        }
      } catch { /* non-critical */ }
    }

    // Greeting audio — ElevenLabs Veda Sky
    const greetingAudio = 'https://jet-wolverine-3713.twil.io/assets/ElevenLabs_2025-09-20T05_54_14_Veda%20Sky%20-%20Customer%20Care%20Agent_pvc_sp114_s58_sb72_se89_b_m2.mp3';

    // #7: Check if caller prefers Spanish (via query param or Gather)
    const language = req.body?.SpeechResult || req.query?.language || null;
    const useSpanish = language === 'es';

    // Check business hours (8 AM - 9 PM ET)
    const now = new Date();
    const etHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }));
    const isBusinessHours = etHour >= 8 && etHour < 20;

    if (!isBusinessHours && shouldAgentHandle()) {
      // After hours + voice agent ON → go straight to AI agent, skip ringing
      const wsUrl = `wss://${domain}/ws/voice-agent`;
      const cfg = getConfig();
      const greeting = getTimeAwareGreeting();

      if (callSid) {
        try {
          await db('call_log')
            .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
            .update({ answered_by: 'voice_agent', status: 'in-progress' });
        } catch { /* non-critical */ }
      }

      console.log(`[VoiceAgent] After hours — routing directly to AI agent`);
      return res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
         <Response>
           <Connect>
             <ConversationRelay
               url="${wsUrl}"
               welcomeGreeting="${greeting} How can I help you today?"
               ttsProvider="${cfg.ttsProvider || 'ElevenLabs'}"
               voice="${cfg.ttsVoice || 'Rachel'}"
               transcriptionProvider="${cfg.sttProvider || 'Deepgram'}"
             />
           </Connect>
         </Response>`
      );
    }

    // Business hours OR voice agent OFF → ring admin phones first
    const greetingText = getTimeAwareGreeting();
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Response>
         <Play>${greetingAudio}</Play>
         <Dial timeout="25"
           record="record-from-answer-dual"
           recordingStatusCallback="https://${domain}/api/webhooks/twilio/recording-status"
           recordingStatusCallbackEvent="completed"
           action="https://${domain}/api/webhooks/twilio/voice-agent${useSpanish ? '?language=es' : ''}"
           callerId="${from || to}">
           <Number>+19415993489</Number>
           <Number>+17206334021</Number>
         </Dial>
       </Response>`
    );
    } catch (err) {
      console.error('[VoiceAgent] voice-ring-first CRASH:', err.message, err.stack);
      // Always return valid TwiML so caller doesn't get an error
      res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
         <Response>
           <Say voice="alice">Thank you for calling Waves Pest Control. Please hold while we connect you.</Say>
           <Dial timeout="30" record="record-from-answer-dual" recordingStatusCallbackEvent="completed">
             <Number>+19415993489</Number>
           </Dial>
         </Response>`
      );
    }
  });

  // ── Admin API ──────────────────────────────────────────

  app.get('/api/admin/voice-agent/status', adminAuthenticate, requireTechOrAdmin, (req, res) => {
    res.json(getConfig());
  });

  app.post('/api/admin/voice-agent/toggle', adminAuthenticate, requireTechOrAdmin, async (req, res) => {
    const config = await updateConfig(req.body);
    res.json({ success: true, config });
  });

  app.post('/api/admin/voice-agent/config', adminAuthenticate, requireTechOrAdmin, async (req, res) => {
    const config = await updateConfig(req.body);
    res.json({ success: true, config });
  });

  app.get('/api/admin/voice-agent/calls', adminAuthenticate, requireTechOrAdmin, async (req, res) => {
    const calls = await getRecentVoiceAgentCalls(parseInt(req.query.limit) || 50);
    res.json({ total: calls.length, calls });
  });

  app.get('/api/admin/voice-agent/stats', adminAuthenticate, requireTechOrAdmin, async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    try {
      const stats = await db.raw(`
        SELECT
          COUNT(*) as total_calls,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'lead_captured') as leads_captured,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'appointment_booked') as appointments_booked,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'emergency_flagged') as emergencies,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'escalated') as escalated,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'billing_deflected') as billing_deflected,
          AVG(duration_seconds) as avg_duration,
          COUNT(*) FILTER (WHERE answered_by = 'voice_agent') as ai_handled,
          COUNT(*) FILTER (WHERE answered_by = 'human') as human_handled,
          COUNT(*) FILTER (WHERE answered_by = 'voicemail') as voicemail
        FROM call_log
        WHERE direction = 'inbound'
          AND created_at >= NOW() - INTERVAL '${days} days'
      `);
      res.json(stats.rows[0] || {});
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // ── #1: Call Analytics Dashboard (enhanced) ────────────────
  app.get('/api/admin/voice-agent/analytics', adminAuthenticate, requireTechOrAdmin, async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    try {
      // Basic stats
      const basicStats = await db.raw(`
        SELECT
          COUNT(*) as total_calls,
          ROUND(AVG(duration_seconds)::numeric, 1) as avg_duration_seconds,
          COUNT(*) FILTER (WHERE answered_by = 'voice_agent') as ai_handled,
          COUNT(*) FILTER (WHERE answered_by = 'human') as human_handled,
          COUNT(*) FILTER (WHERE answered_by = 'voicemail' OR answered_by = 'missed' OR answered_by IS NULL) as missed,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'lead_captured') as leads_captured,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'appointment_booked') as appointments_booked,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'billing_deflected') as billing_deflected,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'emergency_flagged') as emergencies_flagged,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'escalated') as escalated,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'info_provided') as info_provided,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'callback_requested') as callback_requested,
          COUNT(*) FILTER (WHERE voice_agent_outcome = 'hangup') as hangup
        FROM call_log
        WHERE direction = 'inbound'
          AND created_at >= NOW() - INTERVAL '${days} days'
      `);

      // Lead conversion rate (AI-handled calls that resulted in an estimate)
      const conversionData = await db.raw(`
        SELECT
          COUNT(*) FILTER (WHERE answered_by = 'voice_agent') as ai_calls,
          COUNT(*) FILTER (WHERE answered_by = 'voice_agent' AND voice_agent_lead_id IS NOT NULL) as ai_leads
        FROM call_log
        WHERE direction = 'inbound'
          AND created_at >= NOW() - INTERVAL '${days} days'
      `);
      const conv = conversionData.rows[0] || {};
      const leadConversionRate = conv.ai_calls > 0
        ? Math.round((conv.ai_leads / conv.ai_calls) * 100 * 10) / 10
        : 0;

      // Top service categories inquired about
      const categoryData = await db.raw(`
        SELECT
          voice_agent_classification::json->>'category' as category,
          COUNT(*) as count
        FROM call_log
        WHERE direction = 'inbound'
          AND voice_agent_classification IS NOT NULL
          AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY voice_agent_classification::json->>'category'
        ORDER BY count DESC
        LIMIT 10
      `);

      // Calls by hour of day
      const hourlyData = await db.raw(`
        SELECT
          EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/New_York') as hour,
          COUNT(*) as count
        FROM call_log
        WHERE direction = 'inbound'
          AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY hour
        ORDER BY hour
      `);

      // Calls by day of week (0=Sunday, 6=Saturday)
      const dailyData = await db.raw(`
        SELECT
          EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York') as day_of_week,
          COUNT(*) as count
        FROM call_log
        WHERE direction = 'inbound'
          AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY day_of_week
        ORDER BY day_of_week
      `);
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const callsByDay = dailyData.rows.map(r => ({
        day: dayNames[parseInt(r.day_of_week)] || r.day_of_week,
        count: parseInt(r.count),
      }));

      // Resolution breakdown
      const resolutionData = await db.raw(`
        SELECT
          COALESCE(voice_agent_outcome, 'unknown') as outcome,
          COUNT(*) as count
        FROM call_log
        WHERE direction = 'inbound'
          AND answered_by = 'voice_agent'
          AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY voice_agent_outcome
        ORDER BY count DESC
      `);

      const stats = basicStats.rows[0] || {};
      res.json({
        period_days: days,
        total_calls: parseInt(stats.total_calls) || 0,
        avg_duration_seconds: parseFloat(stats.avg_duration_seconds) || 0,
        call_handling: {
          ai_handled: parseInt(stats.ai_handled) || 0,
          human_handled: parseInt(stats.human_handled) || 0,
          missed: parseInt(stats.missed) || 0,
        },
        lead_conversion: {
          ai_calls: parseInt(conv.ai_calls) || 0,
          leads_from_ai: parseInt(conv.ai_leads) || 0,
          conversion_rate_pct: leadConversionRate,
        },
        top_categories: categoryData.rows.map(r => ({
          category: r.category,
          count: parseInt(r.count),
        })),
        calls_by_hour: hourlyData.rows.map(r => ({
          hour: parseInt(r.hour),
          count: parseInt(r.count),
        })),
        calls_by_day: callsByDay,
        resolution_breakdown: resolutionData.rows.map(r => ({
          outcome: r.outcome,
          count: parseInt(r.count),
        })),
        outcomes: {
          leads_captured: parseInt(stats.leads_captured) || 0,
          appointments_booked: parseInt(stats.appointments_booked) || 0,
          billing_deflected: parseInt(stats.billing_deflected) || 0,
          emergencies_flagged: parseInt(stats.emergencies_flagged) || 0,
          escalated: parseInt(stats.escalated) || 0,
          info_provided: parseInt(stats.info_provided) || 0,
          callback_requested: parseInt(stats.callback_requested) || 0,
          hangup: parseInt(stats.hangup) || 0,
        },
      });
    } catch (err) {
      console.error('[VoiceAgent] Analytics error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── #2: Call Sentiment Analysis ────────────────────────────
  app.post('/api/admin/voice-agent/analyze-sentiment/:callSid', adminAuthenticate, requireTechOrAdmin, async (req, res) => {
    try {
      const result = await analyzeSentiment(req.params.callSid);
      res.json({ success: true, callSid: req.params.callSid, sentiment: result });
    } catch (err) {
      console.error('[VoiceAgent] Sentiment analysis error:', err.message);
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ── #8: Enhanced Live Call Monitoring ──────────────────────
  app.get('/api/admin/voice-agent/active', adminAuthenticate, requireTechOrAdmin, (req, res) => {
    const active = getActiveCalls();
    res.json({ active_calls: active.length, calls: active });
  });

  // ── #8: Live transcript for a specific call ────────────────
  app.get('/api/admin/voice-agent/live/:callSid', adminAuthenticate, requireTechOrAdmin, (req, res) => {
    const session = getSessionByCallSid(req.params.callSid);
    if (!session) {
      return res.status(404).json({ error: 'No active session for this call' });
    }

    const durationMs = Date.now() - new Date(session.startTime).getTime();
    const transcript = session.conversation
      .filter(m => typeof m.content === 'string')
      .map(m => ({
        role: m.role === 'user' ? 'caller' : 'agent',
        content: m.content,
      }));

    res.json({
      call_sid: req.params.callSid,
      phone: session.callerPhone,
      customer: session.customerData
        ? { name: session.customerData.name, tier: session.customerData.tier, id: session.customerData.id }
        : null,
      classification: session.classification,
      outcome: session.outcome,
      start_time: session.startTime,
      duration_seconds: Math.round(durationMs / 1000),
      message_count: transcript.length,
      transcript,
      current_response: session.currentResponse || null,
      language_detected: session.languageDetected || 'en',
    });
  });

  // ── #8: Inject a message into an active call ──────────────
  app.post('/api/admin/voice-agent/inject/:callSid', adminAuthenticate, requireTechOrAdmin, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const result = await injectMessage(req.params.callSid, message);
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.json(result);
  });
}

// ── #3: Time-Aware Greeting Helper (Eastern Time) ────────────
function getTimeAwareGreeting() {
  const now = new Date();
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etString);
  const hour = etDate.getHours();

  if (hour >= 5 && hour < 12) {
    return "Good morning, thanks for calling Waves Pest Control!";
  } else if (hour >= 12 && hour < 17) {
    return "Good afternoon, thanks for calling Waves Pest Control!";
  } else if (hour >= 17 && hour < 21) {
    return "Good evening, thanks for calling Waves Pest Control!";
  } else {
    return "Thanks for calling Waves Pest Control. Our office is currently closed, but I can still help you.";
  }
}

module.exports = voiceAgentRoutes;
