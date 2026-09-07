const properties = require('../customer-properties');
const { gateEnvValue } = require('../../config/feature-gates');

const uuid = { type: 'string', format: 'uuid' };
const label = { type: ['string', 'null'], maxLength: properties.PROPERTY_FIELD_LIMITS.label };
const occupancy = { type: 'string', enum: properties.OCCUPANCY_TYPES };
const PROPERTY_TOOLS = [
  {
    name: 'add_customer_property',
    description: 'Save an additional customer service property from any page. Look up the customer and saved properties first. Requires a complete address; never invent measurements. Returns a confirmation preview; saving creates no appointment, estimate or message.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false,
      properties: { customer_id: uuid,
        address_line1: { type: 'string', minLength: 1, maxLength: 200 },
        address_line2: { type: ['string', 'null'], maxLength: 100 },
        city: { type: 'string', minLength: 1, maxLength: 50 },
        state: { type: 'string', pattern: '^[A-Za-z]{2}$' },
        zip: { type: 'string', minLength: 1, maxLength: 10 }, label, occupancy_type: occupancy },
      required: ['customer_id', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'label', 'occupancy_type'] },
  },
  {
    name: 'update_customer_property',
    description: 'Relabel a saved property or update its occupancy. Look up the exact saved property ID and current values first. Only supplied changes are applied; account, invoice and service addresses stay unchanged.',
    input_schema: { type: 'object', additionalProperties: false,
      properties: { customer_id: uuid, property_id: uuid, label, occupancy_type: occupancy },
      required: ['customer_id', 'property_id'] },
  },
  {
    name: 'set_primary_property',
    description: 'Make a saved residential property the customer’s primary residence. Uses the existing primary-residence rules (owner-occupied or unknown occupancy). Preview explains the profile mirror and preserves existing invoice, appointment and recurring locations. Requires confirmation of the current preview.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false,
      properties: { customer_id: uuid, property_id: uuid }, required: ['customer_id', 'property_id'] },
  },
];

const kinds = { add_customer_property: 'add', update_customer_property: 'edit', set_primary_property: 'primary' };
async function executePropertyTool(name, input, actionContext = {}) {
  if (!gateEnvValue('GATE_IB_PLATFORM')) return { error: 'Property actions are disabled', code: 'integration_disabled' };
  const kind = kinds[name];
  if (!kind) return { error: 'Unknown property action' };
  try {
    if (!actionContext.confirmed) {
      return await properties.previewManualPropertyChange(input.customer_id, kind, input, input.property_id || null);
    }
    if (!actionContext.isAdmin || !input._verified_property_version) return { error: 'A fresh administrator confirmation is required', code: 'approval_required' };
    const options = { actorId: actionContext.technicianId, expectedVersion: input._verified_property_version };
    if (kind === 'add') return await properties.addManualProperty(input.customer_id, input, options);
    if (kind === 'edit') return await properties.editManualProperty(input.customer_id, input.property_id, input, options);
    return await properties.changePrimaryProperty(input.customer_id, input.property_id, options);
  } catch (err) {
    if (!err.isOperational) throw err;
    return { success: false, error: err.message, code: err.code, preview_changed: err.code === 'preview_changed' };
  }
}

module.exports = { PROPERTY_TOOLS, executePropertyTool };
