/**
 * Voice Agent Routes — TwiML, WebSocket, Admin API
 * Register: voiceAgentRoutes(app, server) in index.js
 */
const { WebSocketServer } = require('ws');
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const {
  initVoiceAgent, shouldAgentHandle, handleVoiceWebSocket,
  getConfig, updateConfig, getActiveCalls, getRecentVoiceAgentCalls,
} = require('../services/voice-agent/agent');

function voiceAgentRoutes(app, httpServer) {
  initVoiceAgent();

  // WebSocket for Twilio ConversationRelay
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/voice-agent' });
  wss.on('connection', (ws, req) => {
    console.log('[VoiceAgent] WebSocket connected');
    handleVoiceWebSocket(ws, req);
  });

  // TwiML — voice agent picks up (after ring timeout or directly)
  app.all('/api/webhooks/twilio/voice-agent', (req, res) => {
    const domain = process.env.SERVER_DOMAIN || req.headers.host;
    const wsUrl = `wss://${domain}/ws/voice-agent`;

    if (!shouldAgentHandle()) {
      return res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
         <Response>
           <Say voice="alice">You've reached Waves Pest Control. We're unable to take your call right now. Please leave a message and we'll get back to you as soon as possible.</Say>
           <Record maxLength="120" transcribe="true" recordingStatusCallback="/api/webhooks/twilio/recording-status" transcribeCallback="/api/webhooks/twilio/transcription" />
         </Response>`
      );
    }

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

  // Ring-first TwiML — rings Adam's phone, then falls through to voice agent
  app.all('/api/webhooks/twilio/voice-ring-first', (req, res) => {
    const domain = process.env.SERVER_DOMAIN || req.headers.host;
    const forwardTo = process.env.FORWARD_PHONE || process.env.ADAM_PHONE || '+19413187612';

    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Response>
         <Dial timeout="25" action="https://${domain}/api/webhooks/twilio/voice-agent" callerId="{{From}}">
           <Number>${forwardTo}</Number>
         </Dial>
       </Response>`
    );
  });

  // Admin API
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
          AVG(duration_seconds) as avg_duration
        FROM call_log
        WHERE answered_by = 'voice_agent'
          AND created_at >= NOW() - INTERVAL '${days} days'
      `);
      res.json(stats.rows[0] || {});
    } catch (err) {
      res.json({ error: err.message });
    }
  });
}

module.exports = voiceAgentRoutes;
