// ============================================================
// server/services/call-sentiment.js
// Call Sentiment Analysis — uses Claude to analyze call transcripts
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../models/db');

let anthropic;
try { anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { anthropic = null; }

/**
 * Analyze sentiment for a completed voice agent call.
 * Reads the transcription from call_log, sends to Claude for analysis.
 *
 * @param {string} callSid - The Twilio call SID
 * @returns {Object} { overall, customerSatisfaction, keyMoments, escalationRisk }
 */
async function analyzeSentiment(callSid) {
  if (!anthropic) throw new Error('Anthropic API not configured');

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

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Analyze the sentiment of this customer service phone call transcript from Waves Pest Control. Return a JSON object with exactly these fields:

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
      },
    ],
  });

  const text = response.content[0]?.text || '{}';
  let result;
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
    result = JSON.parse(cleaned);
  } catch {
    result = {
      overall: 'neutral',
      customerSatisfaction: 3,
      keyMoments: [],
      escalationRisk: false,
      summary: 'Unable to parse sentiment analysis.',
      raw: text,
    };
  }

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
