/**
 * Call Recording Processor — replaces Zapier zaps #2 and #23.
 *
 * Processes Twilio call recordings end-to-end:
 *   1. Transcribe audio (Gemini or Twilio built-in)
 *   2. AI extraction: customer info, appointment details, pain points, sentiment
 *   3. Create/update customer in portal DB
 *   4. If appointment detected → send confirmation SMS + log
 *   5. Tag lead in Beehiiv + enroll in automation
 *   6. Full audit trail in call_log
 */

const db = require('../models/db');
const logger = require('./logger');
const TwilioService = require('./twilio');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { resolveLocation } = require('../config/locations');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ── Transcribe audio via Gemini ──
async function transcribeWithGemini(mp3Url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: 'audio/mpeg', fileUri: mp3Url } },
              { text: 'Transcribe this phone call recording for Waves Pest Control. Output the full transcription only, no commentary.' },
            ],
          }],
        }),
      }
    );
    if (!res.ok) {
      logger.warn(`[call-proc] Gemini transcription failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    logger.error(`[call-proc] Gemini transcription error: ${err.message}`);
    return null;
  }
}

// ── AI extraction via Claude ──
async function extractCallData(transcription, callerPhone) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Analyze this phone call transcript for Waves Pest Control (pest control + lawn care, SW Florida).

Caller phone: ${callerPhone || 'unknown'}

Transcript:
${transcription}

Extract the following as JSON. Use null for anything not clearly stated:
{
  "first_name": "string or null",
  "last_name": "string or null",
  "email": "string or null",
  "phone": "string — use caller phone if not stated",
  "address_line1": "street address or null",
  "city": "string or null — must be a Florida city",
  "state": "FL",
  "zip": "string or null",
  "requested_service": "what service they're calling about",
  "appointment_confirmed": true/false,
  "preferred_date_time": "the raw text of when they want the appointment, or null",
  "is_voicemail": true/false,
  "is_spam": true/false,
  "sentiment": "positive/neutral/negative/frustrated",
  "pain_points": "brief summary of customer concerns or pest issues",
  "call_summary": "2-3 sentence summary of the call",
  "lead_quality": "hot/warm/cold/spam",
  "matched_service": "best match from: General Pest Control, Lawn Care, Mosquito Control, Termite Inspection, Rodent Control, Bed Bug Treatment, WDO Inspection, Tree & Shrub Care, or null"
}

Return ONLY valid JSON, no markdown.`,
    }],
  });

  const text = response.content[0]?.text?.trim() || '{}';
  // Parse JSON, stripping any markdown code fences
  const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(cleaned);
}

// ══════════════════════════════════════════════════════════════
// MAIN PROCESSOR
// ══════════════════════════════════════════════════════════════
const CallRecordingProcessor = {
  /**
   * Process a call recording end-to-end.
   * Called from recording-status webhook or manually from admin.
   */
  async processRecording(callSid) {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) throw new Error(`Call not found: ${callSid}`);

    logger.info(`[call-proc] Processing recording for ${callSid}`);

    // Step 1: Get or create transcription
    let transcription = call.transcription;

    if (!transcription && call.recording_url) {
      // Try Gemini transcription
      transcription = await transcribeWithGemini(call.recording_url);
      if (transcription) {
        await db('call_log').where({ id: call.id }).update({
          transcription,
          transcription_status: 'completed',
          updated_at: new Date(),
        });
        logger.info(`[call-proc] Gemini transcription complete: ${transcription.length} chars`);
      }
    }

    if (!transcription) {
      logger.warn(`[call-proc] No transcription available for ${callSid}`);
      await db('call_log').where({ id: call.id }).update({
        processing_status: 'no_transcription',
        updated_at: new Date(),
      });
      return { success: false, error: 'No transcription available' };
    }

    // Step 2: AI extraction
    let extracted;
    try {
      extracted = await extractCallData(transcription, call.from_phone);
    } catch (err) {
      logger.error(`[call-proc] AI extraction failed: ${err.message}`);
      await db('call_log').where({ id: call.id }).update({
        processing_status: 'extraction_failed',
        updated_at: new Date(),
      });
      return { success: false, error: `AI extraction failed: ${err.message}` };
    }

    // Skip voicemail/spam
    if (extracted.is_voicemail || extracted.is_spam) {
      await db('call_log').where({ id: call.id }).update({
        ai_extraction: JSON.stringify(extracted),
        processing_status: extracted.is_spam ? 'spam' : 'voicemail',
        updated_at: new Date(),
      });
      logger.info(`[call-proc] Skipping ${callSid}: ${extracted.is_spam ? 'spam' : 'voicemail'}`);
      return { success: true, skipped: true, reason: extracted.is_spam ? 'spam' : 'voicemail' };
    }

    // Step 3: Create or update customer
    let customerId = call.customer_id;
    const phone = extracted.phone || call.from_phone;

    if (!customerId && phone) {
      // Try to find existing customer by phone
      const existing = await db('customers').where({ phone }).first();
      if (existing) {
        customerId = existing.id;
        // Update with any new info
        const updates = {};
        if (!existing.email && extracted.email) updates.email = extracted.email;
        if ((!existing.address_line1 || existing.address_line1 === '') && extracted.address_line1) {
          updates.address_line1 = extracted.address_line1;
          if (extracted.city) updates.city = extracted.city;
          if (extracted.zip) updates.zip = extracted.zip;
        }
        if (Object.keys(updates).length > 0) {
          await db('customers').where({ id: customerId }).update(updates);
        }
      } else if (extracted.first_name) {
        // Create new customer
        const loc = resolveLocation(extracted.city || '');
        const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        const numberConfig = TWILIO_NUMBERS.findByNumber(call.to_phone);
        const leadSource = numberConfig ? TWILIO_NUMBERS.getLeadSourceFromNumber(call.to_phone) : { source: 'phone_call' };

        try {
          const [newCust] = await db('customers').insert({
            first_name: extracted.first_name,
            last_name: extracted.last_name || '',
            phone,
            email: extracted.email || null,
            address_line1: extracted.address_line1 || '',
            city: extracted.city || '',
            state: 'FL',
            zip: extracted.zip || '',
            referral_code: code,
            lead_source: leadSource.source || 'phone_call',
            lead_source_detail: numberConfig?.domain || 'inbound call',
            pipeline_stage: 'new_lead',
            pipeline_stage_changed_at: new Date(),
            location_id: loc.id,
          }).returning('*');
          customerId = newCust.id;
          logger.info(`[call-proc] Created customer: ${extracted.first_name} ${extracted.last_name} (${customerId})`);
        } catch (err) {
          logger.error(`[call-proc] Customer creation failed: ${err.message}`);
        }
      }
    }

    // Step 4: Update call log with extraction results
    await db('call_log').where({ id: call.id }).update({
      customer_id: customerId || call.customer_id,
      ai_extraction: JSON.stringify(extracted),
      call_summary: extracted.call_summary || null,
      sentiment: extracted.sentiment || null,
      lead_quality: extracted.lead_quality || null,
      processing_status: 'processed',
      updated_at: new Date(),
    });

    // Step 5: If appointment detected, send confirmation SMS
    let appointmentResult = null;
    if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId) {
      try {
        const customer = await db('customers').where({ id: customerId }).first();
        if (customer?.phone) {
          const firstName = customer.first_name || extracted.first_name || '';
          const smsBody = `Hello ${firstName}! Your ${extracted.matched_service || extracted.requested_service || 'service'} appointment has been scheduled.\n\n` +
            `Date/Time: ${extracted.preferred_date_time}\n\n` +
            `We'll send you a reminder before your appointment. Reply to this text or call (941) 318-7612 with any questions.\n\n` +
            `— Waves Pest Control 🌊`;

          await TwilioService.sendSMS(customer.phone, smsBody);
          appointmentResult = { smsSent: true, service: extracted.matched_service, dateTime: extracted.preferred_date_time };
          logger.info(`[call-proc] Appointment SMS sent to ${customer.phone}`);
        }
      } catch (err) {
        logger.error(`[call-proc] Appointment SMS failed: ${err.message}`);
        appointmentResult = { error: err.message };
      }
    }

    // Step 6: Beehiiv — tag as lead + enroll in automation
    let beehiivResult = null;
    if (customerId && extracted.email) {
      try {
        const beehiiv = require('./beehiiv');
        if (beehiiv.configured) {
          const sub = await beehiiv.upsertSubscriber(extracted.email, {
            firstName: extracted.first_name,
            lastName: extracted.last_name,
            utmSource: 'phone_call',
          });
          if (sub?.id) {
            await beehiiv.addTags(sub.id, ['Lead', 'Phone Call']);
            const autoId = process.env.BEEHIIV_AUTO_LEAD || 'aut_d08077d4-3079-4e69-9488-f6669caf6a6c';
            await beehiiv.enrollInAutomation(autoId, { email: extracted.email, subscriptionId: sub.id });
            beehiivResult = { subscriberId: sub.id, tags: ['Lead', 'Phone Call'] };
          }
        }
      } catch (err) {
        logger.error(`[call-proc] Beehiiv failed: ${err.message}`);
        beehiivResult = { error: err.message };
      }
    }

    // Step 7: Log activity
    if (customerId) {
      await db('customer_interactions').insert({
        customer_id: customerId,
        interaction_type: 'call',
        subject: `Inbound call — ${extracted.matched_service || extracted.requested_service || 'General inquiry'}`,
        body: extracted.call_summary || `Call from ${phone}. ${extracted.pain_points || ''}`,
      }).catch(() => {});
    }

    logger.info(`[call-proc] Completed processing for ${callSid}: customer=${customerId}, appointment=${!!extracted.appointment_confirmed}`);

    return {
      success: true,
      callSid,
      customerId,
      extracted,
      appointmentResult,
      beehiivResult,
    };
  },

  /**
   * Process all unprocessed recordings.
   * Called from admin or cron.
   */
  async processAllPending() {
    const pending = await db('call_log')
      .where('recording_url', '!=', '')
      .whereNotNull('recording_url')
      .where(function () {
        this.whereNull('processing_status')
          .orWhere('processing_status', 'pending');
      })
      .where('duration_seconds', '>', 10)
      .orderBy('created_at', 'desc')
      .limit(10);

    const results = [];
    for (const call of pending) {
      try {
        const result = await this.processRecording(call.twilio_call_sid);
        results.push({ callSid: call.twilio_call_sid, ...result });
      } catch (err) {
        results.push({ callSid: call.twilio_call_sid, success: false, error: err.message });
      }
    }
    return { processed: results.length, results };
  },

  /**
   * Get processing stats.
   */
  async getStats() {
    const [totals] = await db('call_log').select(
      db.raw("COUNT(*) FILTER (WHERE recording_url IS NOT NULL) as total_recordings"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'processed') as processed"),
      db.raw("COUNT(*) FILTER (WHERE processing_status IS NULL OR processing_status = 'pending') as pending"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'voicemail') as voicemail"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'spam') as spam"),
      db.raw("COUNT(*) FILTER (WHERE ai_extraction IS NOT NULL AND ai_extraction::text LIKE '%appointment_confirmed\": true%') as appointments"),
      db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND recording_url IS NOT NULL) as last_7d"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'processed' AND customer_id IS NOT NULL AND ai_extraction IS NOT NULL AND ai_extraction::text NOT LIKE '%\"is_spam\": true%' AND ai_extraction::text NOT LIKE '%\"is_voicemail\": true%') as leads_extracted"),
    );

    // Source analytics: calls grouped by receiving number
    const sourceBreakdown = await db('call_log')
      .select('to_phone')
      .count('* as call_count')
      .whereNotNull('recording_url')
      .groupBy('to_phone')
      .orderBy('call_count', 'desc');

    return {
      totalRecordings: parseInt(totals.total_recordings || 0),
      processed: parseInt(totals.processed || 0),
      pending: parseInt(totals.pending || 0),
      voicemail: parseInt(totals.voicemail || 0),
      spam: parseInt(totals.spam || 0),
      appointments: parseInt(totals.appointments || 0),
      last7d: parseInt(totals.last_7d || 0),
      leadsExtracted: parseInt(totals.leads_extracted || 0),
      sourceBreakdown: sourceBreakdown.map(s => ({ number: s.to_phone, count: parseInt(s.call_count) })),
    };
  },
};

module.exports = CallRecordingProcessor;
