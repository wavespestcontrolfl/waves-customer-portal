const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const modelOutputSchema = require('./call-extraction.model-output.schema.json');
const persistedSchema = require('./call-extraction.persisted.schema.json');

// 1.1.0: additive — property.additional_properties (multi-property calls),
// service_request.quote_requested / quote_promised, triage flags
// multi_property_call + quote_promised. All optional: 1.0.0 payloads
// still validate.
const SCHEMA_VERSION = '1.1.0';

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
