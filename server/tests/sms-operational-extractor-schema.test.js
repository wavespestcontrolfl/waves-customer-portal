'use strict';

// Provider-compatibility lint for the SMS operational-actions output schema.
// Both structured-output providers reject a schema at request time, which
// fails EVERY extraction (36/36 in the 2026-09-24 dry run) with no test
// signal because the lane tests inject `extract`. These rules are the two
// that bit: OpenAI strict mode wants every property key listed in
// `required` (optionals are nullable types), and Anthropic rejects array
// cardinality keywords, which the shared Anthropic leg strips on the wire.
const { SCHEMA } = require('../services/sms-operational-extractor');
const { anthropicSchema } = require('../services/llm/call');

function objectNodes(node, path = '$', out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'object' && node.properties) out.push({ path, node });
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') Object.entries(value).forEach(([name, child]) => objectNodes(child, `${path}.${name}`, out));
    else if (typeof value === 'object') objectNodes(value, `${path}.${key}`, out);
  }
  return out;
}

describe('sms operational-actions schema is accepted by both structured-output providers', () => {
  test('every object node lists all of its property keys in required and forbids extras (OpenAI strict)', () => {
    const nodes = objectNodes(SCHEMA);
    expect(nodes.length).toBeGreaterThan(3);
    for (const { path, node } of nodes) {
      expect({ path, additionalProperties: node.additionalProperties }).toEqual({ path, additionalProperties: false });
      expect({ path, required: [...(node.required || [])].sort() }).toEqual({ path, required: Object.keys(node.properties).sort() });
    }
  });

  test('the Anthropic wire copy carries no array cardinality keywords', () => {
    expect(JSON.stringify(SCHEMA)).toMatch(/maxItems/);
    expect(JSON.stringify(anthropicSchema(SCHEMA))).not.toMatch(/m(in|ax)Items/);
  });
});
