const logger = require('./logger');
const MODELS = require('../config/models');

class ResponseDrafter {
  async draftResponse(inboundMessage, context, intent) {
    // Try Claude API first, fall back to template
    if (process.env.ANTHROPIC_API_KEY) {
      try { return await this.draftWithClaude(inboundMessage, context, intent); } catch (err) {
        logger.error(`Claude draft failed: ${err.message}`);
      }
    }
    return this.draftFromTemplate(inboundMessage, context, intent);
  }

  async draftWithClaude(inboundMessage, context, intent) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const conversation = (context.smsHistory || []).slice(0, 10).reverse()
      .map(m => `[${m.direction === 'inbound' ? 'CUSTOMER' : 'WAVES'}] ${m.body}`).join('\n');

    const flagsSummary = (context.flags || []).map(f => `${f.severity === 'high' ? '🚨' : '⚠️'} ${f.type}: ${f.detail}`).join('\n') || 'No flags.';

    const resp = await client.messages.create({
      model: MODELS.FLAGSHIP, max_tokens: 500,
      system: `You are Adam Benetti's AI assistant for Waves Pest Control. Draft SMS replies Adam will review before sending. Write as Adam — direct, knowledgeable, friendly. Keep under 300 chars when possible. Reference actual service data. Sign off "— Adam" or "— Waves". FLAGS:\n${flagsSummary}`,
      messages: [{ role: 'user', content: `CUSTOMER: ${context.summary}\n\nLAST SERVICE: ${context.lastService ? `${context.lastService.type} on ${new Date(context.lastService.date).toLocaleDateString('en-US', { timeZone: 'America/New_York' })} — "${(context.lastService.notes || '').slice(0, 150)}"` : 'None'}\n\nNEXT: ${context.upcomingServices?.[0] ? `${context.upcomingServices[0].type} ${new Date(context.upcomingServices[0].date).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}` : 'Nothing'}\n\nBALANCE: ${context.billing?.outstandingBalance > 0 ? `$${context.billing.outstandingBalance.toFixed(2)} overdue` : 'Current'}\n\nRECENT SMS:\n${conversation}\n\nINTENT: ${intent?.intent || 'UNKNOWN'}\n\nNEW MESSAGE: "${inboundMessage}"\n\nDraft reply as Adam:` }],
    });

    return { draft: resp.content[0].text, context: context.summary, flags: context.flags, intent: intent?.intent };
  }

  draftFromTemplate(inboundMessage, context, intent) {
    const name = context.customer?.firstName || 'there';
    const intentType = (intent?.intent || '').toUpperCase();
    let draft;

    switch (intentType) {
      case 'SCHEDULE_INQUIRY':
        if (context.upcomingServices?.length) {
          const next = context.upcomingServices[0];
          draft = `Hi ${name}! Your next ${next.type} is scheduled for ${new Date(next.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' })}${next.window ? ` ${next.window}` : ''}. Anything else? — Adam`;
        } else {
          draft = `Hi ${name}! Let me check your schedule and get back to you shortly. — Adam`;
        }
        break;

      case 'PEST_REPORT':
      case 'SERVICE_REQUEST':
        draft = `Hi ${name}, thanks for letting us know. I'll get a callback scheduled for you — your WaveGuard ${context.customer?.tier || ''} plan covers this at no extra charge. When's a good time this week? — Adam`;
        break;

      case 'BILLING_INQUIRY':
        if (context.billing?.outstandingBalance > 0) {
          draft = `Hi ${name}! Your current balance is $${context.billing.outstandingBalance.toFixed(2)}. I can help sort that out — want me to look into it? — Adam`;
        } else {
          draft = `Hi ${name}! Your account is current. Let me know what billing question you have and I'll look into it. — Adam`;
        }
        break;

      case 'CANCEL_REQUEST':
        draft = `Hi ${name}, I understand — I want to make sure we've explored all options. Would you be open to a quick chat? Just reply here or I'll give you a call. — Adam`;
        break;

      case 'COMPLAINT':
        draft = `Hi ${name}, I'm sorry to hear that. Your satisfaction is my top priority. Can you tell me more about what's going on so I can make it right? — Adam`;
        break;

      case 'POSITIVE_FEEDBACK':
        draft = `${name}, thank you so much — that really means a lot! We love serving your property. If you ever have a neighbor looking for pest control, we'd be happy to take care of them too. 🌊 — Adam`;
        break;

      case 'CONFIRMATION':
        draft = `Got it, ${name}! You're all confirmed. See you then! — Waves`;
        break;

      default:
        draft = `Hi ${name}, thanks for reaching out! Let me look into this and get back to you shortly. — Adam`;
    }

    return { draft, context: context.summary, flags: context.flags, intent: intentType };
  }
}

module.exports = new ResponseDrafter();
