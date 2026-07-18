// ============================================================
// server/services/call-sentiment.js
// Call Sentiment Analysis — uses Claude to analyze call transcripts
// ============================================================

const db = require('../models/db');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');

/**
 * Analyze sentiment for a completed voice agent call.
 * Reads the transcription from call_log, sends to Claude for analysis.
 *
 * @param {string} callSid - The Twilio call SID
 * @returns {Object} { overall, customerSatisfaction, keyMoments, escalationRisk }
 */
async function analyzeSentiment(callSid) {
  // Fetch transcript from call_log
  const callRecord = await db('call_log')
    .where(function () {
      this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid);
    })
    .first();

  if (!callRecord) throw new Error(`Call not found: ${callSid}`);

  const transcript = callRecord.transcription;
  if (!transcript || transcript.trim().length === 0) {
    throw new Error(`No transcription available for call: ${callSid}`);
  }

  const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
    maxTokens: 1024,
    jsonMode: true,
    text: `Analyze the sentiment of this customer service phone call transcript from Waves Pest Control. Return a JSON object with exactly these fields:

{
  "overall": "positive" | "neutral" | "negative" | "frustrated",
  "customerSatisfaction": 1-5 (1=very dissatisfied, 5=very satisfied),
  "keyMoments": [{"timestamp": "description of moment", "sentiment": "positive|negative|neutral"}],
  "escalationRisk": true/false (would this customer likely complain or churn?),
  "summary": "One sentence summary of the customer's emotional journey"
}

Transcript:
${transcript}

Return ONLY the JSON, no markdown formatting.`,
  });
  if (!response.ok || !response.json) {
    // An analysis outage must stay visible as an outage: a fabricated
    // neutral/non-escalation result would be persisted below and make the
    // call read as genuinely low-risk. Pre-failover behavior (an unavailable
    // client threw before any metadata write) is preserved.
    throw new Error(`Sentiment analysis unavailable: ${response.reason || 'invalid JSON from providers'}`);
  }
  const result = response.json;

  // Store sentiment result in call_log metadata
  try {
    const existingMeta = callRecord.metadata ? JSON.parse(callRecord.metadata) : {};
    existingMeta.sentiment = result;
    await db('call_log')
      .where(function () {
        this.where('twilio_call_sid', callSid).orWhere('call_sid', callSid);
      })
      .update({
        metadata: JSON.stringify(existingMeta),
        updated_at: new Date(),
      });
  } catch (err) {
    console.error('[CallSentiment] Failed to store sentiment:', err.message);
  }

  return result;
}

module.exports = { analyzeSentiment };
