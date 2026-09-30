/**
 * photo-subject-confirmer.js — lets an LLM CONFIRM (never choose) the one
 * species a blog brief's photo slots are built from.
 *
 * Why: licensed-photo-library.matchSpeciesEntry refuses every topic with an
 * and/or/from/not connector, because four rounds of word rules on #5272 each
 * leaked a two-subject topic ("fire ants and insects", "…or pests",
 * "…and gnats", "this is not a fire ant"). The cost is that genuinely
 * single-subject topics ("where do fire ants come from", "fire ant signs and
 * identification") get no automatic photo.
 *
 * The split of authority:
 *   - CODE finds the candidate: connectorBlockedCandidate(topic) is the one
 *     library entry the topic would match if ONLY the connector test were
 *     skipped (alias match, not_if clear, no other pest named). No candidate
 *     → no call. Explicit comparison words ("vs", "like", "than"…) and the
 *     "-like" suffix never reach here; they block outright.
 *   - The LLM may only CONFIRM: accepted solely when single_subject === true
 *     AND species_slug equals the candidate's catalog_slug exactly. Any other
 *     answer, malformed output, error, timeout or provider outage → null
 *     (fail closed, same as today's "no photo"). The model can never
 *     introduce a species.
 *
 * One structured FAST-tier call (fastStructured two-provider policy, lane
 * photo_subject_confirm) per brief whose topic has a connector-blocked
 * candidate; most briefs make none. Input is the topic text only.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const { connectorBlockedCandidate } = require('./licensed-photo-library');

const CALL_TIMEOUT_MS = 15_000;
const PROMPT_VERSION = 'photo-subject-v1';
const MAX_TOPIC_CHARS = 300;

const SYSTEM_PROMPT = [
  'You check the subject of a blog topic for a Florida pest control company.',
  'Decide whether the topic is about EXACTLY ONE kind of pest or animal, and whether it is the one kind named in the question.',
  'single_subject is false when the topic names, contrasts with, rules out, lists, or also covers any second kind of pest, insect, animal or plant, or a whole group such as "insects" or "pests" — including negations like "not a fire ant" and alternatives like "fire ants or something else".',
  'single_subject is true only when every part of the topic is about the one named kind of pest (its identification, signs, origin, behavior, bites, treatment and so on).',
  'When single_subject is true, species_slug is exactly the slug given in the question; otherwise species_slug is null.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['single_subject', 'species_slug'],
  properties: {
    single_subject: { type: 'boolean' },
    species_slug: { type: ['string', 'null'] },
  },
};

const validateShape = (r) => (
  typeof r?.json?.single_subject === 'boolean'
    && (r.json.species_slug === null || typeof r.json.species_slug === 'string')
    ? null
    : 'invalid_photo_subject'
);

/**
 * confirmPhotoSubject(topic) → { slug, confirmed_by: 'llm' } when the model
 * confirms the code-found candidate, else null. Never throws. No candidate →
 * no model call.
 */
async function confirmPhotoSubject(topic) {
  let candidate;
  try {
    candidate = connectorBlockedCandidate(topic);
  } catch (err) {
    logger.warn(`[photo-subject] candidate lookup failed (${err.message}) — no photo`);
    return null;
  }
  if (!candidate) return null;
  const text = String(topic || '').trim().slice(0, MAX_TOPIC_CHARS);
  try {
    const result = await dispatchWithFallback(
      MODELS.TEXT_POLICIES.fastStructured,
      {
        laneId: 'photo_subject_confirm',
        maxTokens: 100,
        jsonMode: true,
        jsonSchema: RESPONSE_SCHEMA,
        timeoutMs: CALL_TIMEOUT_MS,
        system: SYSTEM_PROMPT,
        text: `BLOG TOPIC: ${text}\n\nIs this topic about exactly one kind of pest, and is it the ${candidate.species} (slug "${candidate.catalog_slug}")?\nAnswer {"single_subject": boolean, "species_slug": string|null}.`,
        promptVersion: PROMPT_VERSION,
      },
      {
        // Split the explicit budget across both legs so a stalled primary
        // leaves the fallback time to answer.
        reserveFallbackBudget: true,
        validate: validateShape,
      },
    );
    const json = result?.ok ? result.json : null;
    if (json?.single_subject === true && json.species_slug === candidate.catalog_slug) {
      return { slug: candidate.catalog_slug, confirmed_by: 'llm' };
    }
    logger.info(`[photo-subject] not confirmed for candidate ${candidate.catalog_slug} (${result?.ok ? 'declined' : (result?.reason || 'error')}) — no photo`);
    return null;
  } catch (err) {
    logger.warn(`[photo-subject] confirmation threw (${err.message}) — no photo`);
    return null;
  }
}

module.exports = { confirmPhotoSubject, _internals: { SYSTEM_PROMPT, RESPONSE_SCHEMA, PROMPT_VERSION } };
