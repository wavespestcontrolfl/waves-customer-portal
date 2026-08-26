/**
 * AI pre-screen for job applications — ranking assist ONLY.
 *
 * The screen scores and summarizes so the owner can read the queue
 * best-first; it never rejects an applicant and no applicant-facing
 * outcome depends on it (every status change is the owner's, which also
 * keeps us clear of automated-employment-decision law). Failures leave
 * the row unscored — the queue still shows it, just without a score.
 *
 * Live model = GPT-5.5 via MODELS.ROUTES.leadClassify (the low-cost
 * structured lane); on any miss it falls back to Claude FAST, same shape
 * as lead-triage.js. model + prompt_version are stored for auditability.
 */

const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatch } = require('./llm/call');
const { stripThinkingBlocks } = require('./llm/deep');
const { ANSWER_KEYS } = require('./job-applications');

const PROMPT_VERSION = 1;
const RECOMMENDATIONS = ['strong', 'possible', 'weak'];

function buildPrompt(app) {
  const contact = app.contact_snapshot || {};
  const answers = app.answers || {};
  const answerLines = ANSWER_KEYS
    .filter((key) => answers[key])
    .map((key) => `${key}: ${answers[key]}`)
    .join('\n');

  return `You are screening a job application for Waves Pest Control, a pest control and lawn care company in Southwest Florida. The role is: ${app.role}. Application language: ${app.language || 'en'} (answers may be in Spanish — evaluate them the same).

Applicant: ${contact.name || 'Unknown'}${contact.city ? ` (${contact.city})` : ''}

Answers:
${answerLines || '(no answers provided)'}

Score the application against this rubric (100 points total):
- Reliability signals (license, availability, realistic start): 25
- Relevant experience or transferable outdoor/trade work: 25
- Judgment and communication quality (especially the gate-code scenario answer): 30
- Comfort with daily phone-app workflows: 10
- Motivation specific to this trade/company: 10

Return a JSON object with:
1. "score" — integer 0-100
2. "recommendation" — one of: "strong", "possible", "weak"
3. "strengths" — array of up to 3 short strings
4. "flags" — array of up to 3 short strings (concerns worth probing in a call; empty if none)
5. "summary" — 1-2 sentences an owner can read in 5 seconds

Return ONLY valid JSON, no markdown.`;
}

function mapScreen(parsed) {
  const score = Number.isInteger(parsed.score) && parsed.score >= 0 && parsed.score <= 100
    ? parsed.score
    : null;
  const recommendation = RECOMMENDATIONS.includes(parsed.recommendation)
    ? parsed.recommendation
    : null;
  if (score === null || recommendation === null) return null;
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, 3) : []);
  return {
    score,
    recommendation,
    strengths: strings(parsed.strengths),
    flags: strings(parsed.flags),
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 400) : '',
  };
}

async function runScreen(app) {
  const prompt = buildPrompt(app);

  // Live model — GPT-5.5. On any miss, fall through to Claude below.
  {
    const r = await dispatch(MODELS.ROUTES.leadClassify, { text: prompt, jsonMode: true, maxTokens: 500 });
    if (r.ok && r.json) {
      const mapped = mapScreen(r.json);
      if (mapped) return { ...mapped, model: r.model || 'openai', prompt_version: PROMPT_VERSION };
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODELS.FAST,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  // FAST can lead with a thinking block (no .text) — see lead-triage.js.
  const text = stripThinkingBlocks(response).content?.[0]?.text || '';
  const mapped = mapScreen(JSON.parse(text));
  return mapped ? { ...mapped, model: MODELS.FAST, prompt_version: PROMPT_VERSION } : null;
}

/**
 * Fire-and-forget entry point: loads the row, runs the screen, stores the
 * result. Never throws — a failed screen only logs.
 */
async function screenJobApplication(applicationId, database) {
  const db = database || require('../models/db');
  try {
    const app = await db('job_applications').where({ id: applicationId }).first();
    if (!app) return null;

    const screen = await runScreen(app);
    if (!screen) {
      logger.error(`[job-screen] no usable screen for application ${applicationId}`);
      return null;
    }

    await db('job_applications')
      .where({ id: applicationId })
      .update({
        ai_screen: JSON.stringify(screen),
        ai_score: screen.score,
        ai_recommendation: screen.recommendation,
        updated_at: new Date(),
      });
    return screen;
  } catch (err) {
    logger.error(`[job-screen] screen failed for ${applicationId}: ${err.message}`);
    return null;
  }
}

module.exports = { screenJobApplication, __private: { buildPrompt, mapScreen } };
