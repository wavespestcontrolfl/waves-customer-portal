/**
 * Intelligence Bar — answer choices (owner 2026-10-08)
 * server/services/intelligence-bar/choice-tools.js
 *
 * When the bar must ask the operator to pick between specific values (a mic
 * reading of "$60.33" against one of "$61.33"), the model attaches those
 * values to its question. The portal shows each one as a button, and a tap
 * sends that option's reply as the operator's next message, through the same
 * path as typed text, so dictation cannot mishear the number a second time.
 *
 * Display only. This tool reads nothing, writes nothing and creates no
 * pending action. A tapped reply is ordinary operator text: every guard
 * (price_read_back, target grounding, the confirmation card) treats it as it
 * treats typing, and a write is still confirmed only on its card.
 */

const OFFER_CHOICES_TOOL_NAME = 'offer_choices';
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_LABEL_CHARS = 40;
const MAX_REPLY_CHARS = 120;

const CHOICE_TOOLS = [
  {
    name: OFFER_CHOICES_TOOL_NAME,
    description: `Show ${MIN_OPTIONS} to ${MAX_OPTIONS} tap-to-answer buttons under your reply when you must ask the operator to choose between specific values: two amounts, dates, times, quantities, products, or customers already named in this conversation. Each option has a short label (the value itself, e.g. "$61.33") and the reply sent as the operator's next message when tapped (e.g. "$61.33 is correct"). Still ask the question in your reply text. The buttons only send text: they never confirm, approve or commit anything. Never use them for a yes/no or to confirm a write; writes are confirmed only on their confirmation card. Call it once, as the last step before your question, and prepare no card in the same turn.
Use for: "Which is correct, $60.33 or $61.33?", "Tuesday the 14th or Thursday the 16th?", "Which of these two products?"`,
    input_schema: {
      type: 'object',
      properties: {
        options: {
          type: 'array', minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS,
          description: 'The exact values to choose between.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              // The length caps are enforced by validateChoices, which drops
              // an over-long option instead of refusing the whole call.
              label: { type: 'string', description: `Button text: the value itself, plain text, at most ${MAX_LABEL_CHARS} characters.` },
              reply: { type: 'string', description: `Sent as the operator's message when tapped, at most ${MAX_REPLY_CHARS} characters. Name the value: "$61.33 is correct".` },
            },
            required: ['label', 'reply'],
          },
        },
      },
      required: ['options'],
    },
  },
];

// Plain text only: one line, no control characters, no markup, no link. A
// value that fails is dropped, never repaired: a shortened amount or date
// would be a different answer.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
const MARKUP = /[<>`]|:\/\//;

function plainText(value, maxChars) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\t\n\r]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (!text || text.length > maxChars || CONTROL_CHARS.test(text) || MARKUP.test(text)) return null;
  return text;
}

// A button that reads as approval would look like a second Confirm control.
// Only the confirmation card approves a write, so such an option is dropped.
const APPROVAL_ONLY = /^(yes|no|ok|okay|confirm|confirmed|approve|approved|cancel|go ahead|do it|proceed|send it|book it)[.!]?$/i;

/**
 * The validated option list, or null when the call is not usable. Never
 * throws; a refused call means the operator answers in text as before.
 */
function validateChoices(input) {
  const raw = input?.options;
  if (!Array.isArray(raw) || raw.length > MAX_OPTIONS) return null;
  const labels = new Set();
  const replies = new Set();
  const options = [];
  for (const option of raw) {
    if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
    const label = plainText(option.label, MAX_LABEL_CHARS);
    const reply = plainText(option.reply, MAX_REPLY_CHARS);
    if (!label || !reply || APPROVAL_ONLY.test(label) || APPROVAL_ONLY.test(reply)) continue;
    // Two buttons with one label, or two that send the same words, are not a choice.
    if (labels.has(label.toLowerCase()) || replies.has(reply.toLowerCase())) continue;
    labels.add(label.toLowerCase());
    replies.add(reply.toLowerCase());
    options.push({ label, reply });
  }
  return options.length >= MIN_OPTIONS ? options : null;
}

// Not an `error`: a list the server will not show is the model's misuse, not
// a broken tool, so it must not count against Tool Health or the breaker.
const NOT_SHOWN = Object.freeze({
  status: 'choices_not_shown',
  note: `No buttons were shown. offer_choices needs ${MIN_OPTIONS} to ${MAX_OPTIONS} different plain-text options (label up to ${MAX_LABEL_CHARS} characters, reply up to ${MAX_REPLY_CHARS}), and never a yes/no or a confirmation. Ask the question in plain words instead.`,
});

async function executeChoiceTool(toolName, input) {
  if (toolName !== OFFER_CHOICES_TOOL_NAME) return { error: `Unknown tool: ${toolName}` };
  const choices = validateChoices(input);
  if (!choices) return { ...NOT_SHOWN };
  return {
    status: 'choices_shown',
    choices,
    note: 'The buttons are shown under your reply. End your turn now: ask the question in plain words, call no other tool and prepare no card. A tap sends that reply as the operator\'s next message; it confirms nothing.',
  };
}

module.exports = {
  CHOICE_TOOLS, executeChoiceTool, validateChoices, OFFER_CHOICES_TOOL_NAME,
  MIN_OPTIONS, MAX_OPTIONS, MAX_LABEL_CHARS, MAX_REPLY_CHARS,
};
