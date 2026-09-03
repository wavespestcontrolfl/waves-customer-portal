/**
 * Call-research extraction prompt (voice-of-customer corpus, v1).
 *
 * Follows the call-extraction prompt-version convention: PROMPT_HASH covers
 * the FULL output contract — the rendered base prompt AND the model-output
 * JSON schema — so a schema-only change still bumps the version and triggers
 * a re-mine. The per-call transcript is excluded from the hash (it renders
 * empty at hash time).
 *
 * The schema is embedded in the prompt as text AND handed to the provider
 * as PROVIDER_OUTPUT_SCHEMA (constrained decoding via llm/call.js
 * jsonSchema). ajv still enforces the full contract afterward — the
 * provider subset cannot carry the length/count bounds — and the miner
 * additionally verifies every quote is verbatim.
 */

const crypto = require('crypto');
const Ajv = require('ajv/dist/2020');
const { RESEARCH_TAGS } = require('../call-research-taxonomy');

const PROMPT_VERSION = 'v1';

const MODEL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['chunks'],
  additionalProperties: false,
  properties: {
    chunks: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        required: ['speaker', 'quote', 'tag'],
        additionalProperties: false,
        properties: {
          speaker: { enum: ['caller', 'agent'] },
          quote: { type: 'string', minLength: 3, maxLength: 1200 },
          context: { type: ['string', 'null'], maxLength: 600 },
          tag: { enum: RESEARCH_TAGS },
          topics: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 60 },
          },
          service_mentioned: { type: ['string', 'null'], maxLength: 50 },
        },
      },
    },
  },
};

// The provider-facing copy of MODEL_OUTPUT_SCHEMA: every object closed with
// every key required (nullable keys stay nullable), enums typed, and the
// minLength/maxLength/minItems/maxItems bounds stripped — no provider's
// structured-output mode accepts them, so ajv keeps enforcing those.
const STRIPPED_BOUNDS = ['minLength', 'maxLength', 'minItems', 'maxItems'];
function toProviderSchema(node) {
  if (Array.isArray(node)) return node.map(toProviderSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_BOUNDS.includes(key)) continue;
    out[key] = toProviderSchema(value);
  }
  if (out.enum && !out.type) out.type = 'string';
  if (out.type === 'object' && out.properties) out.required = Object.keys(out.properties);
  return out;
}
const PROVIDER_OUTPUT_SCHEMA = toProviderSchema(MODEL_OUTPUT_SCHEMA);

function buildCallResearchPrompt(transcript) {
  return `You are a market-research analyst for a pest control and lawn care company. Extract VERBATIM research quotes from the call transcript below.

The transcript labels our staff "Agent:" and the customer "Caller:".

Extract every distinct moment where the CALLER reveals research signal — a need, objection, question, confusion, satisfaction, complaint, churn risk, or competitor mention. Agent speech is only quotable when the caller's meaning is lost without it (speaker "agent").

RULES:
- "quote" must be copied EXACTLY, word-for-word, from the transcript. Never paraphrase, never fix grammar, never stitch together separate sentences.
- "context": 1-2 surrounding sentences (verbatim where possible) when the quote alone is ambiguous; otherwise null.
- One chunk per distinct signal. A focused call may yield 1-3 chunks; a rambling call more. Wrong numbers, robocalls, and pure-logistics calls with no research signal yield an empty chunks array — that is a correct answer.
- Tag definitions:
  - need: the problem in the customer's own words ("I keep finding ants in the kitchen every morning")
  - objection: price, contract, or commitment pushback ("that's more than I wanted to spend")
  - capability_question: asks whether we handle something ("do you guys treat for iguanas?") — service-gap and content-gap signal
  - confusion: customer confused by prep, billing, scheduling, or arrival windows — each one is a UX/copy defect signal
  - churn_signal: hints at cancelling, downgrading, or shopping around
  - praise: unprompted satisfaction
  - complaint: dissatisfaction with service, scheduling, billing, or staff
  - competitor_mention: names or references another provider
- topics: 1-4 short lowercase topic strings per chunk ("german roaches", "prepay discount", "arrival window"). Plain nouns, no sentences.
- service_mentioned: the specific service discussed when clearly identifiable (e.g. "pest control", "lawn care", "termite", "mosquito", "rodent", "WDO inspection"), else null.

Output ONLY JSON matching this contract exactly:
${JSON.stringify(MODEL_OUTPUT_SCHEMA)}

═══ TRANSCRIPT ═══
${transcript || ''}`;
}

// Version stamp for call_log.research_prompt_version — bump PROMPT_VERSION
// (or change the prompt/schema) and every call re-mines.
const _contractHash = crypto
  .createHash('sha256')
  .update(buildCallResearchPrompt(''))
  .digest('hex')
  .slice(0, 12);
const PROMPT_HASH = `${PROMPT_VERSION}-${_contractHash}`;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(MODEL_OUTPUT_SCHEMA);

function validateResearchOutput(data) {
  const valid = validateFn(data);
  return { valid, errors: valid ? null : [...validateFn.errors] };
}

module.exports = {
  buildCallResearchPrompt,
  validateResearchOutput,
  MODEL_OUTPUT_SCHEMA,
  PROVIDER_OUTPUT_SCHEMA,
  PROMPT_VERSION,
  PROMPT_HASH,
};
