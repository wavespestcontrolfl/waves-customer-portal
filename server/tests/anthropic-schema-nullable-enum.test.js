/**
 * Anthropic structured output 400s on a nullable enum written with a type
 * array (`Enum value 'bad_lead' does not match declared type
 * '['string', 'null']'`). csr_coach failed every Anthropic leg from #6019 on.
 * anthropicSchema() drops `type` on such nodes for the wire copy only.
 */
const { anthropicSchema } = require('../services/llm/call');

function nodes(schema, out = []) {
  if (schema && typeof schema === 'object') {
    if (!Array.isArray(schema)) out.push(schema);
    Object.values(schema).forEach((v) => nodes(v, out));
  }
  return out;
}

describe('anthropicSchema nullable enum', () => {
  test('drops the type array from a nullable enum and keeps the values', () => {
    const wire = anthropicSchema({ type: ['string', 'null'], enum: ['a', 'b', null], description: 'd' });
    expect(wire).toEqual({ enum: ['a', 'b', null], description: 'd' });
  });

  test('keeps a type array without an enum and a single type with an enum', () => {
    expect(anthropicSchema({ type: ['number', 'null'] })).toEqual({ type: ['number', 'null'] });
    expect(anthropicSchema({ type: 'integer', enum: [0, 1] })).toEqual({ type: 'integer', enum: [0, 1] });
  });

  test('rewrites nested nodes and does not mutate the caller schema', () => {
    const schema = {
      type: 'object',
      properties: { loss: { type: ['string', 'null'], enum: ['x', null] }, tags: { type: 'array', maxItems: 3, items: { type: 'string' } } },
    };
    const before = JSON.stringify(schema);
    const wire = anthropicSchema(schema);
    expect(wire.properties.loss).toEqual({ enum: ['x', null] });
    expect(wire.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(JSON.stringify(schema)).toBe(before);
  });

  test('the csr_coach wire schema has no type array next to an enum', () => {
    const { CSR_SCORE_SCHEMA } = require('../services/csr/csr-coach');
    const bad = nodes(anthropicSchema(CSR_SCORE_SCHEMA)).filter((n) => Array.isArray(n.type) && Array.isArray(n.enum));
    expect(bad).toEqual([]);
    expect(nodes(CSR_SCORE_SCHEMA).some((n) => Array.isArray(n.type) && Array.isArray(n.enum))).toBe(true);
  });
});
