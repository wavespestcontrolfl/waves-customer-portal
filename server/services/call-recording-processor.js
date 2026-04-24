/**
 * Call Recording Processor.
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
const MODELS = require('../config/models');

function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMc(\w)/g, (_, c) => 'Mc' + c.toUpperCase())
    .replace(/\bO'(\w)/g, (_, c) => "O'" + c.toUpperCase());
}
const TwilioService = require('./twilio');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { resolveLocation } = require('../config/locations');
const { parseETDateTime, formatETDate, formatETTime } = require('../utils/datetime-et');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ── Download Twilio recording (authenticated) ──
async function downloadRecording(mp3Url) {
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const res = await fetch(mp3Url, {
    headers: { Authorization: `Basic ${twilioAuth}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString('base64');
}

// ── Transcribe audio via Gemini (download + inline base64) ──
async function transcribeWithGemini(mp3Url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    // Download audio from Twilio (requires auth)
    logger.info(`[call-proc] Downloading recording: ${mp3Url}`);
    const audioBase64 = await downloadRecording(mp3Url);
    logger.info(`[call-proc] Downloaded ${Math.round(audioBase64.length / 1024)}KB audio`);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'audio/mpeg', data: audioBase64 } },
              { text: `Transcribe this phone call recording for Waves Pest Control (pest control + lawn care, SW Florida).

Rules:
- Label every turn "Agent:" or "Caller:" on its own line.
- Transcribe verbatim — preserve fillers ("um", "uh"), numbers, addresses, phone numbers, and proper nouns exactly as spoken.
- If audio is silent, unintelligible, or only voicemail tones, output exactly: [VOICEMAIL] or [NO SPEECH].
- Do NOT summarize, translate, or add commentary. Output the transcript only, nothing before or after.` },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      }
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn(`[call-proc] Gemini transcription failed: ${res.status} ${errBody.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    // Gemini 2.5 may return thinking parts — skip those
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => p.text && !p.thought);
    return textPart?.text || parts[0]?.text || null;
  } catch (err) {
    logger.error(`[call-proc] Gemini transcription error: ${err.message}`);
    return null;
  }
}

// ── AI extraction via Gemini ──
//
// Same JSON schema as the prior Claude implementation — only the model
// endpoint changed. Gemini's response_mime_type='application/json'
// forces structured output so we rarely have to strip markdown fences,
// but we still guard-parse for the "text-only refusal" edge case.
async function extractCallData(transcription, callerPhone) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const prompt = `Analyze this phone call transcript for Waves Pest Control (pest control + lawn care, SW Florida).

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
  "preferred_date_time": "ISO 8601 local (no timezone) in Eastern Time: YYYY-MM-DDTHH:MM — e.g. 2026-04-20T14:00 for April 20, 2026 at 2:00 PM ET. null if not confirmed.",
  "is_voicemail": true/false,
  "is_spam": true/false,
  "sentiment": "positive/neutral/negative/frustrated",
  "pain_points": "brief summary of customer concerns or pest issues",
  "call_summary": "2-3 sentence summary of the call",
  "lead_quality": "hot/warm/cold/spam",
  "matched_service": "best match from: General Pest Control, Lawn Care, Mosquito Control, Termite Inspection, Rodent Control, Bed Bug Treatment, WDO Inspection, Tree & Shrub Care, or null"
}

IMPORTANT — appointment_confirmed rules:
- Only set appointment_confirmed to true if BOTH a specific DATE and a specific TIME were explicitly agreed to by the caller.
- Vague references like "tomorrow", "next week", "noonish", "sometime Tuesday" do NOT count — the caller must confirm an actual time (e.g. "10 AM", "2:30 PM", "noon").
- If the agent says "I'll text you" or "let me check" without the caller confirming a specific time slot, appointment_confirmed must be false.
- preferred_date_time must include the confirmed time, not just a date.

Return ONLY valid JSON.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.2, // keep extraction deterministic
        },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 240)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || '{}';
  // response_mime_type:application/json usually prevents fences, but strip
  // defensively in case the model falls back to markdown.
  const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    logger.error(`[call-proc] Invalid JSON from Gemini: ${e.message} — raw: ${cleaned.slice(0, 200)}`);
    return { first_name: null, is_spam: false, is_voicemail: false, call_summary: 'AI extraction returned invalid JSON', lead_quality: 'cold' };
  }
}

// ── Lead Synopsis via Claude (Sales Strategist prompt) ──
async function generateLeadSynopsis(transcription) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Role:
You are a Sales Strategist and Customer Experience Analyst for Waves Pest Control & Lawn Care, a family-owned company serving Southwest Florida (Manatee, Sarasota, and Charlotte counties). You think like a local business owner — direct, practical, no corporate fluff.

Analyze the following lead interaction (call transcription or SMS thread):
${transcription}

Step 0 — Qualify the Lead (Gate Check):
Before any analysis, determine whether this interaction is a new inbound lead — someone reaching out for the first time via website, phone, or text requesting services or information.
If the interaction is any of the following, respond with only: "Not a new lead — no analysis needed." and stop.
- An existing customer calling about a scheduled service, billing, or account issue
- A vendor, solicitor, robocall, or spam
- An internal team conversation
- A callback or follow-up on an already-quoted job

If it IS a new lead, proceed with the full analysis below.

Step 1 — Service Request Identification:
List every service the caller/texter is asking about or implying they need. Be specific. Examples: general pest control (interior/exterior), lawn care program, mosquito treatment, termite inspection, rodent exclusion, WDO inspection, tree & shrub care, fire ant treatment, etc. If they describe a problem without naming a service, map it to the correct Waves service.

Step 2 — Lead Intelligence:
- Primary Pain Point: Urgent infestation? Frustration with a previous provider? Aesthetic/lawn health concern? Quote the specific language they used.
- Buying Triggers: Words or questions that signal purchase intent — asking about scheduling, pricing, "how soon can someone come out," comparing providers, describing urgency. List each one.
- Trust Barriers: Any hesitation signals — pet/child safety concerns, contract aversion, price sensitivity, skepticism about effectiveness, bad past experience. List each one.
- Property Context: Anything mentioned about property size, location, HOA, type (single-family, condo, new construction), or existing conditions.

Step 3 — Actionable Strategy:
A. Immediate Close — What to Say Right Now
Write the exact words (2–4 sentences) the person calling them back or responding to their text should say to win this job today. Match the tone to the customer's energy.

B. WaveGuard Positioning
Based on their specific pain point, write one concise pitch (2–3 sentences) that positions the WaveGuard recurring membership as the solution — not as an upsell, but as the answer to the exact problem they described. Use their own language back at them.

C. Office Follow-Up Action
One specific, concrete step Virginia or the office should take within the next 2 hours to keep this lead warm. Not generic ("follow up") — specific.

Formatting:
Use markdown headers (##) for sections. Use bullet points. Keep the entire output under 400 words. Write like you're handing a cheat sheet to a technician sitting in the truck.`,
      }],
    });

    return response.content[0]?.text?.trim() || null;
  } catch (err) {
    logger.error(`[call-proc] Synopsis generation failed: ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN PROCESSOR
// ══════════════════════════════════════════════════════════════
const CallRecordingProcessor = {
  /**
   * Process a call recording end-to-end.
   * Called from recording-status webhook or manually from admin.
   */
  async processRecording(callSid, opts = {}) {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) throw new Error(`Call not found: ${callSid}`);

    // Dedup guard — skip if already fully processed (prevents duplicate
    // SMS on webhook retries). opts.force=true bypasses the guard so the
    // admin "Reprocess" button can re-run extraction with updated prompts
    // / model / customer-field backfills without hand-editing the DB.
    if (call.processing_status === 'processed' && !opts.force) {
      logger.info(`[call-proc] Already processed ${callSid} — skipping`);
      return { success: true, skipped: true, reason: 'already_processed' };
    }

    // Concurrent-run guard: the ring-first flow can fire two
    // recording-status webhooks for one call (outer <Dial record> + inner
    // voicemail <Record> share the same CallSid), and both schedule
    // processRecording on a 5s delay. Without this atomic claim, both
    // race through extraction and both send the confirmation SMS. Atomic
    // UPDATE → conditional exit: the first run wins, the second bails.
    if (!opts.force) {
      const claimed = await db('call_log')
        .where({ twilio_call_sid: callSid })
        .whereNot('processing_status', 'processing')
        .whereNot('processing_status', 'processed')
        .update({ processing_status: 'processing', updated_at: new Date() });
      if (claimed === 0) {
        logger.info(`[call-proc] Concurrent run detected for ${callSid} — skipping`);
        return { success: true, skipped: true, reason: 'already_processing' };
      }
    }

    logger.info(`[call-proc] Processing recording for ${callSid}`);

    // Step 1: Transcribe — Gemini is the source of truth. Twilio's built-in is fallback only.
    let transcription = null;

    if (call.recording_url) {
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

    // Fallback: use Twilio's built-in transcription if Gemini failed or no recording URL
    if (!transcription) {
      const freshCall = await db('call_log').where('twilio_call_sid', callSid).select('transcription').first();
      if (freshCall?.transcription) {
        transcription = freshCall.transcription;
        logger.info(`[call-proc] Gemini unavailable — falling back to Twilio transcription: ${transcription.length} chars`);
      } else if (call.transcription) {
        transcription = call.transcription;
        logger.info(`[call-proc] Gemini unavailable — using cached Twilio transcription: ${transcription.length} chars`);
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
          // Parse address if AI extracted a full address string
          let addrLine = extracted.address_line1 || extracted.address || '';
          let addrCity = extracted.city || '';
          let addrState = extracted.state || 'FL';
          let addrZip = extracted.zip || '';
          if (addrLine && !addrCity) {
            // Try to parse "8224 Abalone Loop, Parrish 34219" → parts
            const parts = addrLine.split(',').map(p => p.trim());
            if (parts.length >= 2) {
              addrLine = parts[0];
              const cityZip = parts[parts.length - 1].match(/^(.+?)\s*(?:FL\s*)?(\d{5})?$/i);
              if (cityZip) {
                addrCity = capitalizeName(cityZip[1].replace(/\s*FL\s*/i, '').trim());
                if (cityZip[2]) addrZip = cityZip[2];
              }
            }
          }

          const [newCust] = await db('customers').insert({
            first_name: capitalizeName(extracted.first_name),
            last_name: capitalizeName(extracted.last_name || ''),
            phone,
            email: extracted.email || null,
            address_line1: addrLine,
            city: addrCity,
            state: addrState,
            zip: addrZip,
            referral_code: code,
            lead_source: leadSource.source || 'phone_call',
            lead_source_detail: numberConfig?.domain || 'inbound call',
            pipeline_stage: 'new_lead',
            pipeline_stage_changed_at: new Date(),
            nearest_location_id: loc.id,
          }).returning('*');
          customerId = newCust.id;
          logger.info(`[call-proc] Created customer: ${extracted.first_name} ${extracted.last_name} (${customerId})`);

          // Auto-create Stripe customer
          try {
            const StripeService = require('./stripe');
            await StripeService.ensureStripeCustomer(customerId);
          } catch (e) { /* non-blocking */ }
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

    // Step 4b: Create lead in leads table for pipeline tracking
    // Note: we create the lead DIRECTLY here instead of going through lead-attribution,
    // because Step 3 already created the customer — attribution would find the customer
    // and skip lead creation (race condition).
    let leadId = null;
    if (customerId && extracted.first_name && !extracted.is_spam) {
      try {
        // Check if lead already exists for this phone
        const existingLead = phone ? await db('leads').where('phone', phone).orderBy('created_at', 'desc').first() : null;

        if (existingLead) {
          leadId = existingLead.id;
          logger.info(`[call-proc] Found existing lead ${leadId} for ${phone}`);
        } else {
          // Resolve lead source from the Twilio number
          let leadSourceId = null;
          try {
            const normalizedTo = (call.to_phone || '').replace(/\D/g, '');
            const ls = await db('lead_sources').where('is_active', true).andWhere(function() {
              this.where('twilio_phone_number', call.to_phone)
                .orWhere('twilio_phone_number', `+${normalizedTo}`)
                .orWhere('twilio_phone_number', `+1${normalizedTo}`);
            }).first();
            if (ls) leadSourceId = ls.id;
          } catch { /* non-critical */ }

          const [newLead] = await db('leads').insert({
            lead_source_id: leadSourceId,
            customer_id: customerId,
            phone,
            first_name: capitalizeName(extracted.first_name),
            last_name: capitalizeName(extracted.last_name || ''),
            email: extracted.email || null,
            lead_type: 'inbound_call',
            first_contact_at: new Date(),
            first_contact_channel: 'call',
            twilio_call_sid: call.twilio_call_sid,
            call_duration_seconds: call.duration_seconds,
            call_recording_url: call.recording_url,
            status: 'new',
          }).returning('*');
          leadId = newLead.id;
          logger.info(`[call-proc] Created new lead ${leadId} for ${extracted.first_name} ${extracted.last_name}`);
        }

        // Enrich lead with AI-extracted data
        if (leadId) {
          const leadUpdates = {};
          if (extracted.first_name) leadUpdates.first_name = capitalizeName(extracted.first_name);
          if (extracted.last_name) leadUpdates.last_name = capitalizeName(extracted.last_name);
          if (extracted.email) leadUpdates.email = extracted.email;
          if (extracted.address_line1) leadUpdates.address = extracted.address_line1;
          if (extracted.city) leadUpdates.city = extracted.city;
          if (extracted.zip) leadUpdates.zip = extracted.zip;
          if (extracted.matched_service) leadUpdates.service_interest = extracted.matched_service;
          if (extracted.lead_quality) leadUpdates.urgency = extracted.lead_quality === 'hot' ? 'urgent' : 'normal';
          leadUpdates.transcript_summary = extracted.call_summary;
          leadUpdates.extracted_data = JSON.stringify({
            pain_points: extracted.pain_points,
            preferred_date_time: extracted.preferred_date_time,
            sentiment: extracted.sentiment,
          });
          leadUpdates.is_qualified = extracted.lead_quality !== 'spam';
          leadUpdates.customer_id = customerId;
          leadUpdates.updated_at = new Date();
          await db('leads').where({ id: leadId }).update(leadUpdates);

          // Log AI triage activity
          await db('lead_activities').insert({
            lead_id: leadId,
            activity_type: 'ai_triage',
            description: `AI extracted from call: ${extracted.matched_service || 'general inquiry'}, quality: ${extracted.lead_quality || 'unknown'}`,
            performed_by: 'AI Call Processor',
            metadata: JSON.stringify({ call_summary: extracted.call_summary, pain_points: extracted.pain_points, sentiment: extracted.sentiment }),
          }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
        }
      } catch (leadErr) {
        logger.error(`[call-proc] Lead creation failed (non-blocking): ${leadErr.message}`);
      }
    }

    // Step 5: If appointment detected with a SPECIFIC time, send confirmation SMS
    // Guard: reject vague date/time (must contain an actual time like "10 AM", "2:30 PM", "noon")
    let appointmentResult = null;
    const timeStr = (extracted.preferred_date_time || '').toLowerCase();
    const hasSpecificTime = /\d{1,2}:\d{2}|\d{1,2}\s*(am|pm|a\.m|p\.m)|noon|midday/i.test(timeStr);
    if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime) {
      try {
        const customer = await db('customers').where({ id: customerId }).first();
        if (customer?.phone) {
          const firstName = customer.first_name || extracted.first_name || '';
          const serviceType = extracted.matched_service || extracted.requested_service || 'service';

          // Use SMS template if available, fall back to inline
          let smsBody;
          // Parse separate date/time from preferred_date_time for template compatibility
          let parsedDate = '', parsedTime = '';
          try {
            const dt = parseETDateTime(extracted.preferred_date_time);
            if (!isNaN(dt.getTime())) {
              parsedDate = formatETDate(dt);
              parsedTime = formatETTime(dt);
            } else {
              // Fallback: extract from string
              const dateMatch = extracted.preferred_date_time.match(/(\w+day,?\s+\w+\s+\d+|\w+\s+\d+)/);
              const timeMatch = extracted.preferred_date_time.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/);
              parsedDate = dateMatch ? dateMatch[1] : extracted.preferred_date_time;
              parsedTime = timeMatch ? timeMatch[1] : '';
            }
          } catch { parsedDate = extracted.preferred_date_time; }

          try {
            const tpl = await db('sms_templates').where({ template_key: 'appointment_call_confirmed' }).first();
            if (tpl?.body) {
              smsBody = tpl.body
                .replace(/\{first_name\}/g, firstName)
                .replace(/\{service_type\}/g, serviceType)
                .replace(/\{date_time\}/g, extracted.preferred_date_time)
                .replace(/\{date\}/g, parsedDate)
                .replace(/\{time\}/g, parsedTime);
            }
          } catch { /* template table may not exist */ }

          if (!smsBody) {
            smsBody = `Hello ${firstName}! Your ${serviceType} appointment has been scheduled.\n\n` +
              `Date/Time: ${extracted.preferred_date_time}\n\n` +
              `We'll send you a reminder before your appointment. Reply to this text or call (941) 318-7612 with any questions.\n\n` +
              `— Waves Pest Control 🌊`;
          }

          // Content-level dedup: even if the concurrent-run guard above
          // misses (e.g., admin reprocess inside the same minute), don't
          // fire an identical confirmation that the customer just got.
          let alreadySent = false;
          try {
            const existing = await db('sms_log')
              .where({ to_phone: customer.phone, message_type: 'confirmation' })
              .where('message_body', smsBody)
              .where('created_at', '>', new Date(Date.now() - 10 * 60 * 1000))
              .first();
            if (existing) alreadySent = true;
          } catch { /* sms_log query issue — send anyway */ }

          if (!alreadySent) {
            await TwilioService.sendSMS(customer.phone, smsBody, { messageType: 'confirmation' });
            logger.info(`[call-proc] Appointment SMS sent to ${customer.phone}`);
          } else {
            logger.info(`[call-proc] Skipping duplicate appointment SMS to ${customer.phone} (sent within last 10 min)`);
          }

          // Create the scheduled_services record so it appears on the schedule
          try {
            const parsedDate = parseETDateTime(extracted.preferred_date_time);
            let scheduledDate, windowStart;
            if (!isNaN(parsedDate.getTime())) {
              // Render the absolute moment back into ET wall-clock components.
              const etOptions = { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false };
              const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(parsedDate);
              scheduledDate = etDate; // YYYY-MM-DD in Eastern
              const etTime = new Intl.DateTimeFormat('en-US', etOptions).format(parsedDate);
              windowStart = etTime;
            } else {
              // Fallback: try to extract date and time from the string
              const dateMatch = extracted.preferred_date_time.match(/(\w+ \d{1,2}(?:,?\s*\d{4})?)/);
              const timeMatch = extracted.preferred_date_time.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
              if (dateMatch) {
                const d = new Date(dateMatch[1]);
                if (!isNaN(d.getTime())) scheduledDate = d.toISOString().split('T')[0];
              }
              if (timeMatch) {
                const t = timeMatch[1].toLowerCase();
                let [h, m] = t.replace(/\s*(am|pm)/, '').split(':').map(Number);
                if (isNaN(m)) m = 0;
                if (t.includes('pm') && h < 12) h += 12;
                if (t.includes('am') && h === 12) h = 0;
                windowStart = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
              }
            }

            if (scheduledDate) {
              // Compute window_end (1 hour after start) and 12-hour display
              let windowEnd = null, windowDisplay = '9:00 AM';
              if (windowStart) {
                const [hh, mm] = windowStart.split(':').map(Number);
                const endH = hh >= 23 ? 23 : hh + 1;
                windowEnd = `${String(endH).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
                const ampm = hh >= 12 ? 'PM' : 'AM';
                const displayH = hh % 12 || 12;
                windowDisplay = `${displayH}:${String(mm).padStart(2, '0')} ${ampm}`;
              }
              const [svc] = await db('scheduled_services').insert({
                customer_id: customerId,
                scheduled_date: scheduledDate,
                window_start: windowStart || '09:00',
                window_end: windowEnd || '10:00',
                window_display: windowDisplay,
                service_type: extracted.matched_service || extracted.requested_service || 'General Pest Control',
                status: 'confirmed',
                customer_confirmed: true,
                confirmed_at: new Date(),
                notes: `Booked via phone call. ${extracted.call_summary || ''}`.trim(),
                booking_source: 'phone_call',
              }).returning('*');
              logger.info(`[call-proc] Scheduled service created: ${svc.id} on ${scheduledDate} at ${windowStart}`);
              appointmentResult = { smsSent: true, scheduledServiceId: svc.id, service: serviceType, dateTime: extracted.preferred_date_time };
            } else {
              logger.warn(`[call-proc] Could not parse date from: ${extracted.preferred_date_time}`);
              appointmentResult = { smsSent: true, service: serviceType, dateTime: extracted.preferred_date_time, scheduleCreated: false };
            }
          } catch (schedErr) {
            logger.error(`[call-proc] Failed to create scheduled service: ${schedErr.message}`);
            appointmentResult = { smsSent: true, service: serviceType, dateTime: extracted.preferred_date_time, scheduleError: schedErr.message };
          }
        }
      } catch (err) {
        logger.error(`[call-proc] Appointment SMS failed: ${err.message}`);
        appointmentResult = { error: err.message };
      }
    }

    // Step 6: Enroll in the local new_lead automation sequence.
    // Variable name kept as `beehiivResult` for schema/log continuity;
    // carries the local enrollment result now.
    let beehiivResult = null;
    if (customerId && extracted.email) {
      try {
        const AutomationRunner = require('./automation-runner');
        const r = await AutomationRunner.enrollCustomer({
          templateKey: 'new_lead',
          customer: {
            email: extracted.email,
            first_name: extracted.first_name,
            last_name: extracted.last_name,
            id: customerId,
          },
        });
        beehiivResult = { local: r };
      } catch (err) {
        logger.error(`[call-proc] new_lead enroll failed: ${err.message}`);
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
      }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
    }

    // Step 7b: Generate lead synopsis (Sales Strategist analysis)
    let synopsis = null;
    if (transcription && !extracted.is_spam && !extracted.is_voicemail) {
      try {
        synopsis = await generateLeadSynopsis(transcription);
        if (synopsis) {
          await db('call_log').where({ id: call.id }).update({ lead_synopsis: synopsis }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
          // Also write to lead if one was created
          if (leadId) {
            await db('leads').where({ id: leadId }).update({ lead_synopsis: synopsis }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
          }
          logger.info(`[call-proc] Lead synopsis generated: ${synopsis.length} chars`);
        }
      } catch (err) {
        logger.error(`[call-proc] Synopsis failed (non-blocking): ${err.message}`);
      }
    }

    // Step 8: CSR Coach scoring — auto-score every transcribed call
    let csrScoreResult = null;
    if (transcription && transcription.length > 50) {
      try {
        const CSRCoach = require('./csr/csr-coach');
        const scoreResult = await CSRCoach.scoreCall({
          csrName: 'Adam',
          customerId: customerId || null,
          callDirection: 'inbound',
          callSource: call.to_phone || 'unknown',
          transcript: transcription,
          metadata: {
            callSid,
            duration: call.duration_seconds,
            service: extracted.matched_service || extracted.requested_service,
            sentiment: extracted.sentiment,
          },
        });
        csrScoreResult = { score: scoreResult?.score?.total_score, outcome: scoreResult?.score?.call_outcome };
        logger.info(`[call-proc] CSR scored: ${csrScoreResult.score}/15 (${csrScoreResult.outcome})`);
      } catch (err) {
        logger.error(`[call-proc] CSR scoring failed (non-blocking): ${err.message}`);
      }
    }

    logger.info(`[call-proc] Completed processing for ${callSid}: customer=${customerId}, appointment=${!!extracted.appointment_confirmed}`);

    return {
      success: true,
      callSid,
      customerId,
      leadId,
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
          .orWhere('processing_status', 'pending')
          .orWhere('processing_status', 'no_transcription');
      })
      .where('duration_seconds', '>', 10)
      .orderBy('created_at', 'desc')
      .limit(20);

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
   * Generate or regenerate lead synopsis for a single call.
   */
  async generateSynopsis(callSid) {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) throw new Error(`Call not found: ${callSid}`);
    if (!call.transcription) throw new Error('No transcription available');

    const synopsis = await generateLeadSynopsis(call.transcription);
    if (synopsis) {
      await db('call_log').where({ id: call.id }).update({ lead_synopsis: synopsis }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
    }
    return { success: true, synopsis };
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
