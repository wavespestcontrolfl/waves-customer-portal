/**
 * Voice-relay tools — Phase 0 (capture-only).
 *
 * The live ConversationRelay agent runs a Claude tool-use loop. Phase 0 exposes
 * a SINGLE tool, `capture_lead`, which writes the caller into the exact same
 * Leads pipeline the current ElevenLabs agent uses (createLeadFromExtraction).
 * This is the floor: every call leaves a lead, identical to today's behavior,
 * just initiated over a real-time Claude conversation instead of a one-shot
 * post-call webhook.
 *
 * Phase 1+ adds read-only tools (get_availability, find_slots) and Phase 2 the
 * mutating confirm_booking — they slot into the TOOLS array and the executeTool
 * switch below without touching the conversation loop or server.
 */

const logger = require('../logger');
const { createLeadFromExtraction } = require('../lead-from-extraction');

const LEAD_QUALITIES = ['hot', 'warm', 'cold', 'spam'];

const TOOLS = [
  {
    name: 'capture_lead',
    description:
      'Save the caller as a lead in the Waves system. Call this once you have ' +
      'gathered the caller\'s reason for calling and as much contact/location ' +
      'detail as they\'ll give. Always call it before ending the call so a human ' +
      'can follow up. Safe to call with partial information.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'Caller first name, if given' },
        last_name: { type: 'string', description: 'Caller last name, if given' },
        email: { type: 'string', description: 'Email, if given' },
        address_line1: { type: 'string', description: 'Street address of the service location' },
        city: { type: 'string', description: 'City of the service location' },
        zip: { type: 'string', description: '5-digit ZIP of the service location' },
        requested_service: {
          type: 'string',
          description: 'What the caller wants in their own words (e.g. "ants in the kitchen", "lawn looks bad")',
        },
        pain_points: { type: 'string', description: 'Specific problem details / urgency' },
        preferred_date_time: { type: 'string', description: 'Any timing preference the caller mentioned (free text)' },
        call_summary: { type: 'string', description: 'One or two sentence summary of the call' },
        lead_quality: {
          type: 'string',
          enum: LEAD_QUALITIES,
          description: 'hot = ready to buy / urgent, warm = interested, cold = just asking, spam = not a real lead',
        },
      },
      required: ['call_summary'],
    },
  },
];

/**
 * Execute a tool call. Returns a short string (the tool_result content) that
 * tells the model what happened so it can respond to the caller naturally.
 *
 * ctx: { from, to, callSid, language, markCaptured() }
 */
async function executeTool(name, input = {}, ctx = {}) {
  if (name !== 'capture_lead') {
    return `Unknown tool "${name}". Do not retry; continue the conversation.`;
  }
  try {
    const extracted = {
      first_name: input.first_name || null,
      last_name: input.last_name || null,
      email: input.email || null,
      address_line1: input.address_line1 || null,
      city: input.city || null,
      zip: input.zip || null,
      requested_service: input.requested_service || null,
      matched_service: null,
      preferred_date_time: input.preferred_date_time || null,
      pain_points: input.pain_points || null,
      call_summary: input.call_summary || null,
      lead_quality: LEAD_QUALITIES.includes(input.lead_quality) ? input.lead_quality : null,
    };
    await createLeadFromExtraction(extracted, {
      phone: ctx.from || null,
      toPhone: ctx.to || null,
      callSid: ctx.callSid || null,
      language: ctx.language || null,
    });
    if (typeof ctx.markCaptured === 'function') ctx.markCaptured();
    logger.info(`[voice-relay] capture_lead saved callSid=${ctx.callSid || 'n/a'}`);
    return 'Lead saved successfully. Let the caller know a Waves team member will follow up shortly to confirm details and scheduling.';
  } catch (err) {
    logger.error(`[voice-relay] capture_lead failed: ${err.message}`);
    // Don't surface the failure to the caller as an error — let the model wrap up gracefully.
    return 'The lead could not be saved right now, but proceed to wrap up the call politely; the call is still recorded for follow-up.';
  }
}

module.exports = { TOOLS, executeTool };
