/**
 * Pest Insider writer: ONE single-turn model call, no tools, JSON output.
 *
 * The model restates the lead fact and the identifier species it is handed and
 * nothing else; claim-check.js then cuts anything it cannot trace back to
 * them. Lane `pest_insider` rides the newsletterWriter policy (Opus 5.5 effort
 * max, OpenAI backup) through dispatchWithFallback, like the weekly newsletter.
 *
 * Max-plan runner: the request is one user text message, a text system prompt
 * and a JSON schema, which is exactly what ~/max-runner/claude-code-fetch.js
 * answers through `claude -p` (it refuses tools, images, streaming and
 * multi-turn, and none of those are used here).
 */
'use strict';

const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const { getVoiceProfile } = require('../../config/voice-profiles');

const VOICE_PROFILE = 'waves_phase_3_local';
const WRITER_MAX_TOKENS = 4000;
// The job restates two short texts, so it does not need the policy's 'max'
// effort. Measured 2026-11-19 on the Max-plan runner: 12 s at 'medium', while
// 'max' had not answered after 5 minutes. Only the primary leg takes it.
const WRITER_EFFORT = 'medium';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Objects need additionalProperties:false and every key in `required` (llm/call.js jsonSchema).
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'preview', 'lead', 'id_item'],
  properties: {
    subject: { type: 'string' },
    preview: { type: 'string' },
    lead: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'sentences'],
      properties: {
        headline: { type: 'string' },
        sentences: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'fact_id'],
            properties: { text: { type: 'string' }, fact_id: { type: 'string' } },
          },
        },
      },
    },
    id_item: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
});

function systemPrompt() {
  const maxSubject = getVoiceProfile(VOICE_PROFILE).subjectLineRules.maxLength;
  return `You write "Pest Insider", the twice-a-month email from Waves Pest Control to Southwest Florida homeowners (Manatee, Sarasota and Charlotte counties). Every issue teaches one small, true thing.

VOICE: plain, friendly, like a knowledgeable neighbor. Short sentences. No hype, no jokes at the reader's expense, no fear.

YOU RECEIVE: one LEAD FACT (its statement, the source text it came from and who published it) and one SPECIES entry from the Waves pest identifier. You write only from those two. You have no other knowledge to add.

LEAD ("Today I learned"):
- 2 to 4 short sentences, plus a short headline.
- Restate the lead fact. Name the publisher once, as given in SAY THE SOURCE AS (for example "UF/IFAS says ...").
- Every number, month, season and proper name you write must appear in the lead fact's statement or source text, spelled the same way. Do not round, convert, estimate or add a number. Do not use a number word such as "one" or "two" unless the source text uses it.
- Put the fact id in every sentence's fact_id. Never open a sentence with a Latin name.
- At most one sentence may mention Waves. It explains what we do in plain words, for example that a technician can look at the spot during a regular visit. It never sells: no offer, no booking, no phone number, no price.

WHAT'S THIS ("id_item"): 1 to 3 short sentences about the species. Build them from the entry's "fact". Use the "note" only for its plain meaning, and skip any part of it that mentions treatment, sprays, baits or products, or calls the species harmless or safe. Do not add a number, a place, a season or a name the entry does not contain.

NEVER WRITE:
- DIY steps, instructions, amounts, mixes, rates or recipes. Say what the source observed, not what the reader should do.
- A pesticide, active ingredient, product or brand name. A price or a dollar sign.
- The word "safe" in any form, or any promise or guarantee.
- Anything the source does not say. If a detail is missing, leave it out.

SUBJECT: one leading emoji, then a space, then a plain, specific line, ${maxSubject} characters or fewer in all. Use only facts from the lead fact. PREVIEW: 30 to 90 characters, a short teaser, not a summary.

Return only the JSON object in the required schema.`;
}

/** The label a sentence uses for a source: "UF/IFAS", "CDC", ... */
function sourceLabel(fact) {
  const publisher = fact.sources[0].publisher;
  if (/^UF\/IFAS/.test(publisher)) return 'UF/IFAS';
  if (publisher === 'Florida Statutes') return 'Florida law';
  return publisher;
}

function userText({ month, leadFact, idItem }) {
  return JSON.stringify({
    send_month: month,
    lead_fact: {
      fact_id: leadFact.id,
      title: leadFact.title,
      statement: leadFact.statement,
      source_text: leadFact.quotes,
      say_the_source_as: sourceLabel(leadFact),
      ...(leadFact.scope_note ? { scope_note: leadFact.scope_note } : {}),
    },
    species: {
      name: idItem.name,
      category: idItem.category,
      fact: idItem.fact,
      note: idItem.note,
    },
  }, null, 2);
}

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/** Why a parsed reply is not the schema's shape, or null. */
function shapeProblem(json) {
  if (!json || typeof json !== 'object') return 'not_an_object';
  if (!isText(json.subject) || !isText(json.preview)) return 'missing_subject_or_preview';
  const lead = json.lead;
  if (!lead || !isText(lead.headline) || !Array.isArray(lead.sentences) || !lead.sentences.length) return 'missing_lead';
  if (!lead.sentences.every((s) => s && isText(s.text) && isText(s.fact_id))) return 'bad_lead_sentence';
  if (!json.id_item || !isText(json.id_item.text)) return 'missing_id_item';
  return null;
}

/**
 * @param {{ sendDate: string, leadFact: object, idItem: object, effort?: string, timeoutMs?: number }} input
 * @returns {Promise<{ ok: boolean, draft?: object, reason?: string, provider?: string, model?: string }>}
 */
async function writeIssue({ sendDate, leadFact, idItem, effort = WRITER_EFFORT, timeoutMs = 240000 }) {
  const month = MONTH_NAMES[Number(String(sendDate).slice(5, 7)) - 1];
  const basePolicy = MODELS.TEXT_POLICIES.newsletterWriter;
  const policy = effort && effort !== basePolicy.primary.effort
    ? { ...basePolicy, primary: { ...basePolicy.primary, effort } }
    : basePolicy;
  const response = await dispatchWithFallback(policy, {
    laneId: 'pest_insider',
    maxTokens: WRITER_MAX_TOKENS,
    timeoutMs,
    jsonMode: true,
    jsonSchema: OUTPUT_SCHEMA,
    system: systemPrompt(),
    text: userText({ month, leadFact, idItem }),
  }, { reserveFallbackBudget: true, validate: (result) => shapeProblem(result.json) });
  if (!response.ok || !response.json) return { ok: false, reason: response.reason || 'writer_failed' };
  return { ok: true, draft: response.json, provider: response.provider, model: response.model };
}

module.exports = { writeIssue, shapeProblem, systemPrompt, userText, sourceLabel, OUTPUT_SCHEMA };
