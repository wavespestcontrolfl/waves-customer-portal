const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const modelOutputSchema = require('./call-extraction.model-output.schema.json');
const persistedSchema = require('./call-extraction.persisted.schema.json');

// 1.1.0: additive — property.additional_properties (multi-property calls),
// service_request.quote_requested / quote_promised, triage flags
// multi_property_call + quote_promised. All optional: 1.0.0 payloads
// still validate.
// 1.2.0: additive — top-level secondary_contact (a second person named as a
// party to the service: realtor's buyer, landlord's tenant, spouse). Optional
// and nullable: 1.0.0 / 1.1.0 payloads still validate.
// 1.3.0: additive — top-level other_parties_mentioned (call named more people
// than the one secondary_contact), triage flag
// existing_appointment_coordination, primary_service_category bed_bug/wdo,
// pest_type no_see_ums/flies_gnats/scorpions/moles/love_bugs/bats,
// severity_signal swarmers_seen. All optional/enum-widening: older payloads
// still validate.
const SCHEMA_VERSION = '1.3.0';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

ajv.addFormat('e164', /^\+[1-9]\d{1,14}$/);

const validateModelOutputFn = ajv.compile(modelOutputSchema);
const validatePersistedFn = ajv.compile(persistedSchema);

function validateModelOutput(data) {
  const valid = validateModelOutputFn(data);
  return {
    valid,
    errors: valid ? null : [...validateModelOutputFn.errors],
  };
}

function validatePersisted(data) {
  const valid = validatePersistedFn(data);
  return {
    valid,
    errors: valid ? null : [...validatePersistedFn.errors],
  };
}

module.exports = {
  SCHEMA_VERSION,
  validateModelOutput,
  validatePersisted,
};
