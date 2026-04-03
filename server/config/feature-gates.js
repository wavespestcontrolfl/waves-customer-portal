/**
 * Feature Gates — Human-in-the-loop safety layer
 *
 * Every integration that touches real customers or third-party services
 * is gated behind a flag. In production, these default to OFF until
 * Adam manually enables them after verifying each one works.
 *
 * Set these as environment variables on Railway:
 *   GATE_TWILIO_SMS=true        (enable real SMS sending)
 *   GATE_TWILIO_VOICE=true      (enable voice call handling)
 *   GATE_SQUARE_PAYMENTS=true   (enable real payment processing)
 *   GATE_AI_ASSISTANT=true      (enable AI auto-replies to customers)
 *   GATE_AI_BLOG_WRITER=true    (enable AI blog content generation)
 *   GATE_CRON_JOBS=true         (enable all automated cron jobs)
 *   GATE_WEBHOOKS=true          (enable inbound webhook processing)
 *   GATE_WORDPRESS_PUBLISH=true (enable publishing to WordPress)
 *
 * In development, all gates are OPEN by default so you can test locally.
 */

const isProd = process.env.NODE_ENV === 'production';

const gates = {
  // Twilio — sends real SMS to real phone numbers
  twilioSms: isProd ? process.env.GATE_TWILIO_SMS === 'true' : true,

  // Twilio — handles real inbound voice calls
  twilioVoice: isProd ? process.env.GATE_TWILIO_VOICE === 'true' : true,

  // Square — processes real payment charges
  squarePayments: isProd ? process.env.GATE_SQUARE_PAYMENTS === 'true' : true,

  // AI Assistant — auto-sends AI replies to customers via SMS
  aiAssistantAutoReply: isProd ? process.env.GATE_AI_ASSISTANT === 'true' : true,

  // AI Blog Writer — generates content via Anthropic API
  aiBlogWriter: isProd ? process.env.GATE_AI_BLOG_WRITER === 'true' : true,

  // Cron Jobs — automated scheduled tasks (reminders, billing, intelligence)
  cronJobs: isProd ? process.env.GATE_CRON_JOBS === 'true' : true,

  // Webhooks — process inbound Twilio/Square/Lead webhooks
  webhooks: isProd ? process.env.GATE_WEBHOOKS === 'true' : true,

  // WordPress — publish blog posts to live site
  wordpressPublish: isProd ? process.env.GATE_WORDPRESS_PUBLISH === 'true' : true,
};

function isEnabled(gate) {
  const enabled = gates[gate];
  if (enabled === undefined) {
    console.warn(`[feature-gates] Unknown gate: ${gate}`);
    return false;
  }
  return enabled;
}

function logGateStatus() {
  console.log('[feature-gates] Status:');
  for (const [name, enabled] of Object.entries(gates)) {
    console.log(`  ${enabled ? '✅' : '🔒'} ${name}: ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }
}

module.exports = { gates, isEnabled, logGateStatus };
