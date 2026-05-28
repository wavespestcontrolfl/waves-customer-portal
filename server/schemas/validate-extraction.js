const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const modelOutputSchema = require('./call-extraction.model-output.schema.json');
const persistedSchema = require('./call-extraction.persisted.schema.json');

const SCHEMA_VERSION = '1.0.0';

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
