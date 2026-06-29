const crypto = require('crypto');
const modelOutputSchema = require('../../schemas/call-extraction.model-output.schema.json');

const PROMPT_VERSION = 'v1';

function buildExtractionPrompt(transcription, callerPhone, callDateET) {
  return `You are an extraction engine for Waves Pest Control & Lawn Care, a family-owned company serving Southwest Florida (Manatee, Sarasota, and Charlotte counties).

Analyze this phone call transcript and extract structured data matching the JSON schema provided via response_schema. Every field must conform to the schema's type and enum constraints.

Caller phone (from Twilio ANI): ${callerPhone || 'unknown'}
Call date in Eastern Time: ${callDateET}

Transcript:
${transcription}

═══ EXTRACTION RULES ═══

SCHEDULING STATUS — This is the most important field for downstream routing:
- "confirmed": ONLY when BOTH a specific DATE and a specific TIME are explicitly agreed to by the caller. Vague references ("tomorrow", "next week", "noonish", "sometime Tuesday") do NOT qualify — the caller must confirm an actual time slot (e.g. "10 AM", "2:30 PM", "noon"). If the agent says "I'll text you" or "let me check" without the caller confirming, status is NOT confirmed.
- "requested": Caller asked about availability or expressed interest in scheduling but no specific time was agreed.
- "offered": Agent offered specific time slots but caller has not confirmed.
- "confirmed": When confirmed, set confirmed_start_at to ISO 8601 with Eastern Time offset (e.g. "2026-05-28T10:00:00-04:00" for EDT, "2026-05-28T10:00:00-05:00" for EST). Resolve relative dates against the call date: "today" = ${callDateET}. Do not invent dates or use the model's training date.
- "reschedule_requested": Caller wants to change an existing appointment.
- "canceled": Caller wants to cancel an existing appointment or service.
- "ambiguous": Scheduling was discussed but the outcome is unclear.
- "none": No scheduling discussion occurred.
- Do NOT set status to "confirmed" for unrelated business advice, SEO, marketing, construction advice, or non-Waves services.
- DO set status to "confirmed" when a builder explicitly books a Waves pre-slab/preconstruction termite or soil-treatment field-service appointment with a specific date and time.
- Do NOT set status to "confirmed" for admin calls about invoices, payments, receipts, compliance reports, stickers, certificates, W-9s, or paperwork — unless the caller ALSO books a new field-service visit.

CALLER NAME:
- Set first_name and last_name separately when the caller clearly states both.
- Set name_full to the full name as spoken.
- If only one name is stated, put it in first_name; leave last_name null.
- Do NOT invent names from caller ID, address, email, or context.
- Set name_confidence: 0.9+ when clearly stated, 0.5-0.8 when spelled out ambiguously, <0.5 when only partially heard.

SPELLED-OUT INPUT IS AUTHORITATIVE (names + emails):
- When the caller spells a name or email letter-by-letter, or with phonetic markers ("B as in boy", "V as in Victor", "N as in Nancy"), the SPELLED letters are the source of truth — use them, not the word as it was transcribed phonetically. Callers spell precisely because the spoken form is easy to mishear (e.g. caller says "Smyth" but spells S-M-I-T-H -> use "Smith", and the email is jane.smith@example.com, NOT smyth). These are illustrative only — never copy this example name or email into the output.
- When an email is described relative to the name ("first name dot last name"), build it from the SPELLED name parts, not the misheard spoken form.

PHONE:
- phone_e164: Set to the callback number the caller states, in E.164 format (+1XXXXXXXXXX).
- phone_raw_spoken: Verbatim as spoken in transcript (e.g. "nine four one, five five five...").
- phone_source: "spoken" if caller stated a number, "caller_id" if using Twilio ANI only, "both" if spoken matches ANI, "unknown" if neither available.
- If no number is spoken, set phone_e164 to null (server will fall back to ANI).

EMAIL:
- Only extract when the caller clearly says or spells the complete email address.
- Uncertain, partial, or malformed emails must be null.

ADDRESS:
- raw_text: Verbatim address as spoken by caller.
- Parse into street_line_1, city, state, postal_code when clearly stated.
- state must be "FL" or null. Do not set for non-Florida addresses.
- county: Set if clearly identifiable from city/address. Manatee, Sarasota, Charlotte, or DeSoto only.
- normalization_status: Always set to "not_attempted" (server handles normalization).

PROPERTY:
- hoa_community_flag: true if property is IN an HOA community (e.g. Lakewood Ranch, Heritage Harbor).
- hoa_common_area_service: true ONLY if service is FOR HOA-owned common areas (clubhouse, retention ponds, entry beds). A single-family home inside an HOA is hoa_community_flag=true but hoa_common_area_service=false.

SERVICE REQUEST:
- primary_service_category: Map caller's request to the best enum value.
- If caller asks for soil poison, soil treatment, pre-slab/preconstruction termite work, or treatment before a concrete pour: use "termite" as primary_service_category.
- pests_observed_status: "observed" when caller mentions seeing specific pests, "not_observed_preventative" when they want prevention without active pests, "not_observed_inquiry" for quote/info calls, "not_discussed" for non-pest topics (billing, cancellation).
- waveguard_tier_mentioned: Only set if the caller explicitly names a WaveGuard tier they saw on the site or an ad. Do NOT infer.

CONSENT:
- sms_consent_given: true only if the caller explicitly agrees to receive text messages. Implied consent (giving a phone number) does NOT count.
- sms_consent_quote: Verbatim quote where consent was given. null if not given.
- call_recording_disclosed: true if the greeting or agent mentioned recording/AI.
- do_not_contact_request: true if caller explicitly asked not to be contacted.

VOICEMAIL & SPAM:
- is_voicemail: true if the recording is a one-sided voicemail message, not a two-party conversation.
- is_spam: true if the call is spam, solicitation, robocall, wrong number, or vendor sales pitch.

SENTIMENT & LEAD:
- sentiment: Match caller's emotional state.
- lead_quality: "hot" = ready to buy now, "warm" = interested but not urgent, "cold" = shopping/researching, "tire_kicker" = unlikely to convert, "spam_or_solicitation" = not a customer, "wrong_number" = misdial, "out_of_service_area" = outside Manatee/Sarasota/Charlotte counties.

EVIDENCE PINNING — You MUST pin evidence quotes for these routing-critical fields:
- property.service_address (any component)
- service_request.urgency
- caller.on_site_authorization (when caller != owner)
- property.hoa_common_area_service (when true)
- consent.sms_consent_given (when true)
- scheduling.status (when "confirmed")
Each evidence entry: field_path (JSON pointer), quote (verbatim transcript), speaker (caller/agent), transcript_offset_ms (approximate, or null).

CONFIDENCE SCORES — Per-section scores in [0, 1]:
- 0.9+ = clearly stated in transcript
- 0.7-0.9 = inferred with reasonable confidence
- 0.5-0.7 = partial information, some guessing
- <0.5 = very uncertain
- overall = weighted average reflecting routing reliability

TRIAGE FLAGS — Set flags for situations requiring human review:
- out_of_service_area: Address/city is outside Manatee/Sarasota/Charlotte counties.
- hoa_common_area_requires_approval: hoa_common_area_service is true.
- commercial_requires_quote: Commercial property needing custom quote.
- caller_not_authorized: Caller relationship != owner AND on_site_authorization is false.
- no_sms_consent_captured: No explicit SMS consent obtained.
- address_unverifiable: Address is vague or incomplete.
- prior_complaint_unresolved: Caller mentioned an unresolved complaint.
- spam_or_wrong_number: Call is spam or wrong number.
- after_hours_emergency: Emergency same-day request outside business hours.
- cancellation_request: Caller wants to cancel service.
- ambiguous_scheduling: Scheduling was discussed but outcome is unclear.
- reschedule_or_cancel: Caller wants to reschedule or cancel.

Waves services: General Pest Control, Lawn Care, Mosquito Control, Termite Inspection, WDO Inspection, Pre-Slab Termidor, Liquid Termite Perimeter, Termite Wood Treatment, Termite Foam Drill, Rodent Control, Bed Bug Treatment, Tree & Shrub Care, Palm Injection, Exclusion. Calls about unrelated work (SEO, marketing, advertising, construction advice) are not Waves services.`;
}

// Hash the FULL output contract — base prompt AND the JSON schema that
// extractCallDataV2 appends to it — so any schema change bumps the version
// even when the model + base prompt are unchanged. The processor stamps this
// as ai_extraction_prompt_version and the promotion-readiness gate filters on
// it, so a schema-only change correctly scopes old shadow rows out of the gate.
const _contractHash = crypto.createHash('sha256')
  .update(buildExtractionPrompt('', '', '') + '\n' + JSON.stringify(modelOutputSchema))
  .digest('hex')
  .slice(0, 12);

const PROMPT_HASH = `${PROMPT_VERSION}-${_contractHash}`;

module.exports = {
  buildExtractionPrompt,
  PROMPT_VERSION,
  PROMPT_HASH,
};
