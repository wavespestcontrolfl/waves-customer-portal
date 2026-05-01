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
const MODELS = require('../config/models');
const crypto = require('crypto');

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

const PROCESSING_STALE_MINUTES = 30;

function makeProcessingToken() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

async function claimCallForProcessing(call) {
  const token = makeProcessingToken();
  const now = new Date();
  const updated = await db('call_log')
    .where({ id: call.id })
    .where(function () {
      this.whereNull('processing_status')
        .orWhereIn('processing_status', ['pending', 'no_transcription', 'extraction_failed'])
        .orWhere(function () {
          this.where('processing_status', 'processing')
            .andWhere(function () {
              this.whereNull('processing_started_at')
                .orWhere('processing_started_at', '<', db.raw(`NOW() - INTERVAL '${PROCESSING_STALE_MINUTES} minutes'`));
            });
        });
    })
    .update({
      processing_status: 'processing',
      processing_token: token,
      processing_started_at: now,
      updated_at: now,
    });

  if (updated > 0) return { claimed: true, token };

  const fresh = await db('call_log')
    .where({ id: call.id })
    .select('processing_status', 'processing_started_at')
    .first();
  if (fresh?.processing_status === 'processed') {
    return { claimed: false, skipped: true, reason: 'already_processed' };
  }
  if (['processing', 'spam', 'voicemail'].includes(fresh?.processing_status)) {
    return { claimed: false, skipped: true, reason: fresh.processing_status };
  }
  return { claimed: false, skipped: true, reason: 'not_claimable' };
}

function makeEstimateToken(customerName) {
  const shortId = crypto.randomBytes(4).toString('hex');
  const nameSlug = (customerName || 'customer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'customer';
  return `${nameSlug}-${shortId}`;
}

function hasEstimateIntent(extracted, transcription = '') {
  if (extracted?.wants_estimate === true) return true;
  const haystack = [
    extracted?.requested_service,
    extracted?.call_summary,
    extracted?.pain_points,
    transcription,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(quote|estimate|pricing|price|prices|cost|costs|how much|what would it cost|what'?s it cost|can you give me a number|bid)\b/i.test(haystack);
}

function normalizePhone(raw, fallback = null) {
  const value = raw || fallback;
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return String(value);
}

function buildCustomerUpdates(existing, extracted) {
  const updates = {};
  if (!existing.email && extracted.email) updates.email = extracted.email;
  if ((!existing.first_name || existing.first_name === 'Unknown') && extracted.first_name) {
    updates.first_name = capitalizeName(extracted.first_name);
  }
  if (!existing.last_name && extracted.last_name) updates.last_name = capitalizeName(extracted.last_name);
  if ((!existing.address_line1 || existing.address_line1 === '') && extracted.address_line1) {
    updates.address_line1 = extracted.address_line1;
    if (extracted.city) updates.city = extracted.city;
    if (extracted.zip) updates.zip = extracted.zip;
  } else {
    if ((!existing.city || existing.city === '') && extracted.city) updates.city = extracted.city;
    if ((!existing.zip || existing.zip === '') && extracted.zip) updates.zip = extracted.zip;
  }
  updates.last_contact_date = new Date();
  updates.last_contact_type = 'call_inbound';
  return updates;
}

function hasMinimumNewCustomerFields(extracted, phone) {
  return Boolean(
    extracted?.first_name &&
    phone
  );
}

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

// ── AI extraction via Claude ──
async function extractCallData(transcription, callerPhone) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: MODELS.FLAGSHIP,
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
  "preferred_date_time": "ISO 8601 local (no timezone) in Eastern Time: YYYY-MM-DDTHH:MM — e.g. 2026-04-20T14:00 for April 20, 2026 at 2:00 PM ET. null if not confirmed.",
  "wants_estimate": true/false,
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

IMPORTANT — customer name rules:
- Capture both first_name and last_name whenever the caller states both.
- If only one name is clearly stated, put it in first_name and leave last_name null.
- Do not invent a last name from caller ID, address, email, or context.

IMPORTANT — wants_estimate rules:
- Set wants_estimate to true when the caller asks for a quote, estimate, price, pricing, cost, "how much", "what would it cost", "can you give me a number", or similar pricing intent.
- Keep wants_estimate true even if they also booked an appointment.
- Set wants_estimate to false for voicemail, spam, existing-customer service questions, complaints, billing, or rescheduling when no price/quote intent is present.

Return ONLY valid JSON, no markdown.`,
    }],
  });

  const text = response.content[0]?.text?.trim() || '{}';
  // Parse JSON, stripping any markdown code fences
  const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    logger.error(`[call-proc] Invalid JSON from Claude: ${e.message} — raw: ${cleaned.slice(0, 200)}`);
    return { first_name: null, wants_estimate: false, is_spam: false, is_voicemail: false, call_summary: 'AI extraction returned invalid JSON', lead_quality: 'cold' };
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
  async processRecording(callSid) {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) throw new Error(`Call not found: ${callSid}`);

    const claim = await claimCallForProcessing(call);
    if (!claim.claimed) {
      logger.info(`[call-proc] Skipping ${callSid}: ${claim.reason}`);
      return { success: true, skipped: true, reason: claim.reason };
    }

    const processingToken = claim.token;
    logger.info(`[call-proc] Processing recording for ${callSid} token=${processingToken}`);

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
      await db('call_log').where({ id: call.id, processing_token: processingToken }).update({
        processing_status: 'no_transcription',
        processing_token: null,
        processing_started_at: null,
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
      await db('call_log').where({ id: call.id, processing_token: processingToken }).update({
        processing_status: 'extraction_failed',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      });
      return { success: false, error: `AI extraction failed: ${err.message}` };
    }

    // Skip voicemail/spam
    if (extracted.is_voicemail || extracted.is_spam) {
      await db('call_log').where({ id: call.id, processing_token: processingToken }).update({
        ai_extraction: JSON.stringify(extracted),
        processing_status: extracted.is_spam ? 'spam' : 'voicemail',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      });
      logger.info(`[call-proc] Skipping ${callSid}: ${extracted.is_spam ? 'spam' : 'voicemail'}`);
      return { success: true, skipped: true, reason: extracted.is_spam ? 'spam' : 'voicemail' };
    }

    const wantsEstimate = hasEstimateIntent(extracted, transcription);

    // Step 3: Create or update customer
    let customerId = call.customer_id;
    const phone = normalizePhone(extracted.phone, call.from_phone);
    let existingCustomer = customerId ? await db('customers').where({ id: customerId }).first() : null;

    if (existingCustomer) {
      const updates = buildCustomerUpdates(existingCustomer, extracted);
      if (Object.keys(updates).length > 0) {
        await db('customers').where({ id: customerId }).update(updates);
      }
    } else if (phone) {
      // Try to find existing customer by phone
      const existing = await db('customers').where({ phone }).first();
      if (existing) {
        customerId = existing.id;
        // Update with any new info
        const updates = buildCustomerUpdates(existing, extracted);
        if (Object.keys(updates).length > 0) {
          await db('customers').where({ id: customerId }).update(updates);
        }
      } else if (hasMinimumNewCustomerFields(extracted, phone)) {
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
            last_name: extracted.last_name ? capitalizeName(extracted.last_name) : null,
            phone,
            email: extracted.email || null,
            address_line1: addrLine || null,
            city: addrCity || null,
            state: addrState,
            zip: addrZip || null,
            referral_code: code,
            lead_source: leadSource.source || 'phone_call',
            lead_source_detail: numberConfig?.domain || 'inbound call',
            pipeline_stage: 'new_lead',
            pipeline_stage_changed_at: new Date(),
            nearest_location_id: loc.id,
          }).returning('*');
          customerId = newCust.id;
          logger.info(`[call-proc] Created customer: ${extracted.first_name} ${extracted.last_name || ''} (${customerId})`);

          // Auto-create Stripe customer
          try {
            const StripeService = require('./stripe');
            await StripeService.ensureStripeCustomer(customerId);
          } catch (e) { /* non-blocking */ }
        } catch (err) {
          logger.error(`[call-proc] Customer creation failed: ${err.message}`);
        }
      } else {
        logger.info(`[call-proc] Skipping customer creation for ${callSid}: missing first name or phone`);
      }
    }

    // Step 4: Update call log with extraction results; keep the processing claim
    // active until critical side effects below finish.
    await db('call_log').where({ id: call.id, processing_token: processingToken }).update({
      customer_id: customerId || call.customer_id,
      ai_extraction: JSON.stringify(extracted),
      call_summary: extracted.call_summary || null,
      sentiment: extracted.sentiment || null,
      lead_quality: extracted.lead_quality || null,
      updated_at: new Date(),
    });

    // Step 4b: Create lead in leads table for pipeline tracking
    // Note: we create the lead DIRECTLY here instead of going through lead-attribution,
    // because Step 3 already created the customer — attribution would find the customer
    // and skip lead creation (race condition).
    let leadId = null;
    if (customerId && !extracted.is_spam) {
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
            first_name: capitalizeName(extracted.first_name || 'Unknown'),
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
          logger.info(`[call-proc] Created new lead ${leadId} for ${extracted.first_name || 'Unknown'} ${extracted.last_name || ''}`);
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

    // Step 4c: Queue a draft estimate when the caller asks about pricing.
    let estimateQueueResult = null;
    if (wantsEstimate && !extracted.is_spam && !extracted.is_voicemail) {
      try {
        let existingEstimate = null;
        if (customerId) {
          existingEstimate = await db('estimates')
            .where({ customer_id: customerId, status: 'draft' })
            .where('created_at', '>', db.raw("NOW() - INTERVAL '24 hours'"))
            .orderBy('created_at', 'desc')
            .first();
        } else if (phone) {
          existingEstimate = await db('estimates')
            .where({ customer_phone: phone, status: 'draft', source: 'call_recording' })
            .where('created_at', '>', db.raw("NOW() - INTERVAL '24 hours'"))
            .orderBy('created_at', 'desc')
            .first();
        }

        if (existingEstimate) {
          estimateQueueResult = { skipped: true, existingEstimateId: existingEstimate.id };
          logger.info(`[call-proc] Estimate already queued for ${customerId || phone || callSid}: ${existingEstimate.id}`);
        } else {
          const customer = customerId ? await db('customers').where({ id: customerId }).first() : null;
          const customerName = [customer?.first_name || extracted.first_name, customer?.last_name || extracted.last_name]
            .filter(Boolean)
            .join(' ')
            .trim() || 'Unknown Caller';
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);
          const serviceInterest = extracted.matched_service || extracted.requested_service || 'General Pest Control';
          const leadQuality = extracted.lead_quality || 'cold';
          const urgency = leadQuality === 'hot' ? 3 : leadQuality === 'warm' ? 2 : 1;

          const [estimate] = await db('estimates').insert({
            customer_id: customerId || null,
            status: 'draft',
            source: 'call_recording',
            service_interest: serviceInterest,
            lead_source: 'phone_call',
            lead_source_detail: call.to_phone || null,
            urgency,
            is_priority: leadQuality === 'hot' || extracted.sentiment === 'frustrated',
            estimate_data: JSON.stringify({
              callSid,
              leadId,
              requested_service: extracted.requested_service || null,
              matched_service: extracted.matched_service || null,
              pain_points: extracted.pain_points || null,
              sentiment: extracted.sentiment || null,
              lead_quality: leadQuality,
              city: extracted.city || null,
              zip: extracted.zip || null,
              wants_estimate: true,
            }),
            address: extracted.address_line1 || customer?.address_line1 || null,
            customer_name: customerName,
            customer_phone: customer?.phone || phone || null,
            customer_email: customer?.email || extracted.email || null,
            token: makeEstimateToken(customerName),
            expires_at: expiresAt,
            notes: extracted.call_summary || `Queued from inbound call ${callSid}`,
          }).returning('*');

          estimateQueueResult = { created: true, estimateId: estimate.id, token: estimate.token };
          logger.info(`[call-proc] Queued draft estimate ${estimate.id} for ${customerId || phone || callSid}`);
        }
      } catch (estimateErr) {
        logger.error(`[call-proc] Estimate queue failed (non-blocking): ${estimateErr.message}`);
        estimateQueueResult = { error: estimateErr.message };
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

          await TwilioService.sendSMS(customer.phone, smsBody, { messageType: 'confirmation' });
          logger.info(`[call-proc] Appointment SMS sent to ${customer.phone}`);

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
              const needsServiceAddress = !(customer.address_line1 || extracted.address_line1);
              const scheduleNotes = [
                'Booked via phone call.',
                needsServiceAddress ? 'ADDRESS NEEDED - confirm service street address before dispatch.' : '',
                extracted.call_summary || '',
              ].filter(Boolean).join(' ').trim();
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
                notes: scheduleNotes,
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

    const finalUpdated = await db('call_log')
      .where({ id: call.id, processing_token: processingToken })
      .update({
        processing_status: 'processed',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      });

    if (finalUpdated === 0) {
      logger.warn(`[call-proc] Finished ${callSid}, but processing claim was no longer owned by token=${processingToken}`);
    }

    logger.info(`[call-proc] Completed processing for ${callSid}: customer=${customerId}, appointment=${!!extracted.appointment_confirmed}`);

    return {
      success: true,
      callSid,
      customerId,
      leadId,
      extracted,
      appointmentResult,
      estimateQueueResult,
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
          .orWhere('processing_status', 'no_transcription')
          .orWhere('processing_status', 'extraction_failed')
          .orWhere(function () {
            this.where('processing_status', 'processing')
              .andWhere(function () {
                this.whereNull('processing_started_at')
                  .orWhere('processing_started_at', '<', db.raw(`NOW() - INTERVAL '${PROCESSING_STALE_MINUTES} minutes'`));
              });
          });
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
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'processing') as processing"),
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
      processing: parseInt(totals.processing || 0),
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
