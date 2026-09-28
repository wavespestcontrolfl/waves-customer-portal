/**
 * Reader check for one planned internal link, run right before the link is
 * committed to an Astro PR. Internal-link PRs merge without a human, so this
 * is the step that asks the question a human editor would: "if a reader
 * clicks these words here, do they land where they expected?" Token rules
 * (internal-link-seo-policy) catch generic anchors; this catches the rest —
 * "Neem Oil" in a pet-safety paragraph pointing at a whitefly post.
 *
 * Fails closed: no answer, a malformed answer, or a provider outage is
 * { ok: false } and the caller leaves the task for a later sweep.
 * Kill switch: AUTONOMOUS_INTERNAL_LINK_LLM_JUDGE=false.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approve', 'reason'],
  properties: {
    approve: { type: 'boolean', description: 'true only if a reader clicking the anchor lands on a page that matches what the anchor and its sentence promise' },
    reason: { type: 'string', description: 'One short sentence explaining the verdict' },
  },
};

const SYSTEM = [
  'You review one proposed internal link on a pest control and lawn care website before it goes live without human review.',
  'Approve only when ALL of these hold:',
  '1. The anchor words, read in their sentence, promise the subject of the target page. A reader clicking them would not be surprised by where they land.',
  '2. The link helps a reader of this paragraph. It is not a tangent, and it is not inserted into a sentence about something else.',
  '3. The anchor is not a generic phrase (a place name, "pest control", "your home") pointing at a page about something narrower.',
  'When unsure, reject. A skipped link costs nothing; a misleading link hurts the page.',
].join('\n');

function judgeEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.AUTONOMOUS_INTERNAL_LINK_LLM_JUDGE || '').trim());
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function judgeLink({ anchor, paragraph, sourceTitle, sourceUrl, targetTitle, targetUrl, targetSummary } = {}) {
  if (!judgeEnabled()) return { ok: true, approve: true, reason: 'judge_disabled' };
  const text = [
    `Source page: ${clip(sourceTitle, 200)} (${sourceUrl || 'unknown'})`,
    `Paragraph the link goes in:\n"""${clip(paragraph, 1500)}"""`,
    `Anchor words to be linked: "${clip(anchor, 120)}"`,
    `Target page: ${clip(targetTitle, 200)} (${targetUrl})`,
    `Target page opening:\n"""${clip(targetSummary, 800)}"""`,
  ].join('\n\n');
  let resp;
  try {
    resp = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      laneId: 'internal_link_judge',
      maxTokens: 1024,
      jsonMode: true,
      jsonSchema: JUDGE_SCHEMA,
      system: SYSTEM,
      text,
    });
  } catch (err) {
    logger.warn(`[internal-link-judge] dispatch threw: ${err.message}`);
    return { ok: false, reason: 'judge_error' };
  }
  const json = resp?.ok ? resp.json : null;
  if (!json || typeof json.approve !== 'boolean') {
    return { ok: false, reason: `judge_unavailable:${resp?.reason || 'empty_json'}` };
  }
  return { ok: true, approve: json.approve, reason: clip(json.reason, 300) };
}

module.exports = { judgeLink, judgeEnabled, JUDGE_SCHEMA };
