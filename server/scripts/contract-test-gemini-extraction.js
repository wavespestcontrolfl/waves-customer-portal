/**
 * Live contract test for the v2 extraction against the configured Gemini model.
 * Sends the transformed response_schema + a SYNTHETIC transcript (no PII) and
 * asserts the response validates against both the model-output and persisted
 * schemas. Run: railway run -s waves-customer-portal node <thisfile>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const CRP = require('../services/call-recording-processor');

const SYNTHETIC = `Agent: Good afternoon, Waves Pest Control.
Caller: Hi, this is Jordan Maple at 4410 Palm Breeze Court in Bradenton, 34209. I keep seeing German roaches in my kitchen, started about a week ago.
Agent: Sorry to hear that. Are you the homeowner?
Caller: Yes I own the place. Can someone come out Friday around 10 AM?
Agent: Friday at 10 works. Can I text you a confirmation at this number?
Caller: Yes, texting is fine.
Agent: Great, you're booked for Friday at 10 AM for general pest control.`;

(async () => {
  console.log(`Model under test: ${process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-pro'}\n`);
  const t0 = Date.now();
  const result = await CRP._test.extractCallDataV2(SYNTHETIC, '+19415551234', {
    callId: '00000000-0000-0000-0000-000000000000',
    callStartedAt: new Date(),
  });
  console.log(`status: ${result.status}  (${Date.now() - t0}ms)`);
  if (result.status !== 'valid') {
    console.log('ERRORS:', JSON.stringify(result.errors, null, 2)?.slice(0, 1500));
    process.exit(1);
  }
  const e = result.extraction;
  console.log('\n— Key extracted fields —');
  console.log('caller.first_name:', e.caller.first_name, '| relationship:', e.caller.relationship_to_property, '| on_site_auth:', e.caller.on_site_authorization);
  console.log('address:', e.property.service_address.street_line_1, '|', e.property.service_address.city, e.property.service_address.postal_code, '| county:', e.property.service_address.county);
  console.log('service:', e.service_request.primary_service_category, '| pests_status:', e.service_request.pests_observed_status, '| urgency:', e.service_request.urgency);
  console.log('scheduling.status:', e.scheduling?.status, '| confirmed_start_at:', e.scheduling?.confirmed_start_at);
  console.log('sms_consent_given:', e.consent.sms_consent_given);
  console.log('confidence.overall:', e.confidence.overall, '| triage_flags:', JSON.stringify(e.triage_flags));
  console.log('\nCONTRACT TEST PASSED — schema accepted by model, output valid.');
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
