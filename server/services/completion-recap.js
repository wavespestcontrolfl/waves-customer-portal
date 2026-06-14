const MODELS = require('../config/models');
const logger = require('./logger');

// Outcomes that always skip the AI path. These are customer-sensitive
// situations where generated wording could go off-tone or contradict the
// recorded outcome — we want predictable copy. customer_concern and
// incomplete are included so an AI outage doesn't fall back to the
// "Today we completed your service" default branch (Codex P2 on PR #588).
const DETERMINISTIC_OUTCOMES = new Set([
  'inspection_only',
  'customer_declined',
  'follow_up_needed',
  'customer_concern',
  'incomplete',
]);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeOutcome(value) {
  return cleanText(value || 'completed').toLowerCase();
}

function safeAreas(areas) {
  return Array.isArray(areas)
    ? areas.map(cleanText).filter(Boolean).slice(0, 12)
    : [];
}

function sentenceJoin(parts) {
  return parts.map(cleanText).filter(Boolean).join(' ');
}

const SMS_RECAP_MAX_CHARS = 232;

// Trim to `maxLength`, preferring the last sentence boundary so copy never ends
// mid-thought; falls back to a clean word boundary. Only applied to SMS-sized copy.
function clampRecap(text, maxLength) {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastStop >= Math.floor(maxLength / 2)) return slice.slice(0, lastStop + 1).trim();
  return slice.replace(/\s+\S*$/, '').trim();
}

// Normalize a recap. By default returns the FULL text (no length cap) — this is
// what we store and render on the service report. Pass { maxLength } for
// SMS-sized copy. The 232-char cap was previously UNCONDITIONAL, which chopped
// the stored recap mid-sentence and surfaced on the report ("...noticed some.").
function sanitizeRecap(value, { maxLength = null } = {}) {
  // Normalize dashes first so an em-dash signoff ("text — Waves") is recognized.
  let text = cleanText(value).replace(/[–—]/g, '-');
  // Strip wrapping quotes BOTH before and after removing the "- Waves" signoff.
  // A pasted, already-signed + quoted recap ("text." - Waves) hides its closing
  // quote behind the signoff, so a single pre-strip would leave it dangling once
  // the signoff is removed (Codex P3); a recap quoted AROUND the signoff
  // ("text - Waves") needs the pre-strip so the signoff is then at the edge.
  // Smart→straight runs last so a smart-quoted recap keeps its (converted) quotes
  // rather than being unwrapped.
  text = text.replace(/^["']+|["']+$/g, '');
  text = text.replace(/\s*-\s*Waves\s*$/i, '').trim();
  text = text
    .replace(/^["']+|["']+$/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
  if (typeof maxLength === 'number' && maxLength > 0) text = clampRecap(text, maxLength);
  return text ? `${text} - Waves` : '';
}

// SMS-sized recap: complete-sentence copy capped for messaging. The service
// report uses the full recap; the completion SMS gets this tightened version.
function smsRecap(value) {
  return sanitizeRecap(value, { maxLength: SMS_RECAP_MAX_CHARS });
}

function deterministicRecap(input = {}) {
  const outcome = normalizeOutcome(input.visitOutcome);
  const serviceType = cleanText(input.serviceType) || 'service';
  const areas = safeAreas(input.areasTreated || input.areasServiced);

  if (outcome === 'inspection_only') {
    return sentenceJoin([
      `Today we completed an inspection for your ${serviceType}.`,
      areas.length ? `We checked ${areas.join(', ')} and noted the current conditions.` : 'We checked the accessible areas and noted the current conditions.',
      'No treatment was needed during this visit.',
    ]);
  }

  if (outcome === 'customer_declined') {
    return sentenceJoin([
      `Today we stopped by for your scheduled ${serviceType}, but service was not completed at the property.`,
      'We documented the visit so the office can help with the next step.',
      'Please reply if you would like us to reschedule.',
    ]);
  }

  if (outcome === 'follow_up_needed') {
    return sentenceJoin([
      `Today we completed the available work for your ${serviceType}.`,
      areas.length ? `We focused on ${areas.join(', ')}.` : 'We documented the areas that need continued attention.',
      'A follow-up is recommended so we can check progress and finish any remaining items.',
    ]);
  }

  if (outcome === 'customer_concern') {
    return sentenceJoin([
      `Today we visited for your ${serviceType} and noted a concern that came up.`,
      'We documented it so the office can follow up with the next step.',
      'Please reply with any additional details and we will be in touch.',
    ]);
  }

  if (outcome === 'incomplete') {
    return sentenceJoin([
      `Today we started your ${serviceType} but were not able to finish the full visit.`,
      areas.length ? `We focused on ${areas.join(', ')}.` : 'We documented what was done so we can pick up where we left off.',
      'We will reach out about scheduling the remaining work.',
    ]);
  }

  return sentenceJoin([
    `Today we completed your ${serviceType}.`,
    areas.length ? `We treated ${areas.join(', ')}.` : 'We treated the accessible service areas.',
    'You may continue to see normal activity for a short period as the service takes effect.',
    'Reply to this message if anything needs attention before your next visit.',
  ]);
}

function buildPrompt(input = {}) {
  const serviceType = cleanText(input.serviceType) || 'service';
  const areas = safeAreas(input.areasTreated || input.areasServiced);
  const notes = cleanText(input.notes || input.technicianNotes);
  const outcome = normalizeOutcome(input.visitOutcome);

  return `Write one customer-facing SMS recap for a Waves Pest Control & Lawn Care service visit.

Rules:
- 2 to 4 short sentences.
- Friendly, plain-language, professional.
- Never mention product names, chemical names, application rates, prices, or EPA details.
- Mention treated areas in plain language when provided.
- Do not say eliminated, guaranteed, pest-free, eradicated, or solved forever.
- Do not blame the customer.
- Stay neutral if the visit was declined, incomplete, or follow-up only.
- Plain text only. No markdown. No greeting, bullets, or headings.
- End with " - Waves".

Inputs:
Service type: ${serviceType}
Visit outcome: ${outcome}
Areas treated: ${areas.length ? areas.join(', ') : 'not specified'}
Technician notes: ${notes || 'not specified'}

Return only the recap text.`;
}

async function aiRecap(input = {}) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return null;
  }
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 220,
    messages: [{ role: 'user', content: buildPrompt(input) }],
  });
  return cleanText(msg.content?.[0]?.text || '');
}

async function generateRecap(input = {}) {
  const outcome = normalizeOutcome(input.visitOutcome);
  if (DETERMINISTIC_OUTCOMES.has(outcome)) {
    return { recap: sanitizeRecap(deterministicRecap(input)), source: 'deterministic' };
  }

  try {
    const recap = await aiRecap(input);
    if (recap) return { recap: sanitizeRecap(recap), source: 'ai' };
  } catch (err) {
    logger.warn(`[completion-recap] AI recap failed, using fallback: ${err.message}`);
  }

  return { recap: sanitizeRecap(deterministicRecap(input)), source: 'fallback' };
}

function composeCompletionSmsPreview({ recap, willInvoice, willReview }) {
  return [
    smsRecap(recap),
    willInvoice ? '[pay link inserted]' : '',
    willReview && !willInvoice ? '[review link inserted]' : '',
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  buildPrompt,
  composeCompletionSmsPreview,
  deterministicRecap,
  generateRecap,
  normalizeOutcome,
  sanitizeRecap,
  smsRecap,
  SMS_RECAP_MAX_CHARS,
};
