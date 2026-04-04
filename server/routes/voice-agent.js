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
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const {
  initVoiceAgent, shouldAgentHandle, handleVoiceWebSocket,
  getConfig, updateConfig, getActiveCalls, getRecentVoiceAgentCalls,
} = require('../services/voice-agent/agent');

function voiceAgentRoutes(app, httpServer) {
  // WebSocket is set up separately in index.js after app.listen()

  // ── Voice Agent TwiML (action URL after dial timeout) ────
  app.all('/api/webhooks/twilio/voice-agent', async (req, res) => {
    const domain = process.env.SERVER_DOMAIN || req.headers.host;
    const wsUrl = `wss://${domain}/ws/voice-agent`;
    const callSid = req.body?.CallSid || req.query?.CallSid;
    const dialStatus = req.body?.DialCallStatus || req.query?.DialCallStatus;

    // Update call_log based on what happened with the dial
    if (callSid) {
      try {
        if (dialStatus === 'completed') {
          // Someone picked up — mark as human-answered
          await db('call_log')
            .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
            .update({ answered_by: 'human', status: 'completed' });
          console.log(`[VoiceAgent] Call answered by human: ${callSid}`);
          return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
        } else {
          await db('call_log')
            .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
            .update({
              answered_by: shouldAgentHandle() ? 'voice_agent' : 'voicemail',
              status: dialStatus || 'no-answer',
            });
          console.log(`[VoiceAgent] No answer (${dialStatus}) → ${shouldAgentHandle() ? 'voice agent' : 'voicemail'}`);
        }
      } catch (err) {
        console.error('[VoiceAgent] Failed to update call_log:', err.message);
      }
    }

    if (!shouldAgentHandle()) {
      // Agent OFF → voicemail
      const voicemailAudio = 'https://jet-wolverine-3713.twil.io/assets/lakewood-ranch-voicemail.mp3';
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

    // Agent ON → ConversationRelay
    const cfg = getConfig();
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Response>
         <Connect>
           <ConversationRelay
             url="${wsUrl}"
             welcomeGreeting="Hi, thanks for calling Waves Pest Control! How can I help you today?"
             ttsProvider="${cfg.ttsProvider || 'ElevenLabs'}"
             voice="${cfg.ttsVoice || 'Rachel'}"
             transcriptionProvider="${cfg.sttProvider || 'Deepgram'}"
           />
         </Connect>
       </Response>`
    );
  });

  // ── Ring-First TwiML (replaces Studio Flow) ────────────
  app.all('/api/webhooks/twilio/voice-ring-first', async (req, res) => {
    const domain = process.env.SERVER_DOMAIN || req.headers.host;
    const callSid = req.body?.CallSid || req.query?.CallSid;
    const from = req.body?.From || req.query?.From;
    const to = req.body?.To || req.query?.To;
    const callerCity = req.body?.CallerCity || req.query?.CallerCity;
    const callerState = req.body?.CallerState || req.query?.CallerState;

    // Log every inbound call immediately
    if (callSid) {
      try {
        await db('call_log').insert({
          twilio_call_sid: callSid,
          call_sid: callSid,
          from_phone: from,
          to_phone: to,
          direction: 'inbound',
          status: 'ringing',
          answered_by: null,
          caller_city: callerCity || null,
          caller_state: callerState || null,
        });
        console.log(`[VoiceAgent] Inbound call logged: ${callSid} from ${from}`);
      } catch (err) {
        if (!err.message?.includes('duplicate') && !err.message?.includes('unique')) {
          console.error('[VoiceAgent] Failed to log inbound call:', err.message);
        }
      }
    }

    // Match caller to customer
    if (from) {
      try {
        const normalized = from.replace(/\D/g, '').slice(-10);
        const customer = await db('customers').where(function () {
          this.where('phone', 'like', `%${normalized}`);
        }).first();
        if (customer) {
          await db('call_log')
            .where(function () { this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid); })
            .update({ customer_id: customer.id });
        }
      } catch { /* non-critical */ }
    }

    // Greeting audio — ElevenLabs Veda Sky
    const greetingAudio = 'https://jet-wolverine-3713.twil.io/assets/ElevenLabs_2025-09-20T05_54_14_Veda%20Sky%20-%20Customer%20Care%20Agent_pvc_sp114_s58_sb72_se89_b_m2.mp3';

    // Simultaneous dial to both numbers
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Response>
         <Play>${greetingAudio}</Play>
         <Dial timeout="25"
           action="https://${domain}/api/webhooks/twilio/voice-agent"
           callerId="{{From}}">
           <Number>+19415993489</Number>
           <Number>+17206334021</Number>
         </Dial>
       </Response>`
    );
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

  app.get('/api/admin/voice-agent/active', adminAuthenticate, requireTechOrAdmin, (req, res) => {
    const active = getActiveCalls();
    res.json({ active_calls: active.length, calls: active });
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
}

module.exports = voiceAgentRoutes;
