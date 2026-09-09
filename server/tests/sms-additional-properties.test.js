'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { groundExtraction } = require('../services/sms-operational-extractor');
const { reviewedAddresses } = require('../services/sms-additional-properties');
const quote = 'Family: 42 Sample Way, Example City FL 34201 — ask me before adding service.';
const address = { address_line1: '42 Sample Way', address_line2: null, city: 'Example City',
  state: 'FL', zip: '34201', quote, label: 'Family' };
const context = (message_body = quote, extra = {}) => ({ captureAdditionalProperties: true,
  message: { direction: 'inbound', message_body, created_at: '2040-03-10T15:00:00Z' }, ...extra });
const parsed = (additional_properties = [address], extra = {}) => ({ obligations: [], facts: [], additional_properties, ...extra });

test('keeps the complete address line and its conditions for office review', () => {
  expect(groundExtraction(parsed(), context()).additional_properties).toEqual([address]);
  expect(groundExtraction(parsed([address, address]), context()).additional_properties).toHaveLength(1);
});

test('refuses shortened evidence, inferred address parts, and a fabricated label', () => {
  for (const patch of [{ quote: '42 Sample Way' }, { city: 'Somewhere Else' }, { label: 'Rental' }]) {
    expect(groundExtraction(parsed([{ ...address, ...patch }]), context()).additional_properties).toEqual([]);
  }
});

test('labels must belong to their own quoted address line', () => {
  const rental = 'Rental: 84 Sample Avenue, Example City FL 34201';
  expect(groundExtraction(parsed([{ ...address, label: 'Rental' }]), context(`${quote}\n${rental}`)))
    .toMatchObject({ additional_properties: [], dropped: 1 });
});

test('a missing address array is an invalid extractor response', () => {
  expect(() => groundExtraction({ obligations: [], facts: [] }, context())).toThrow('sms_operations_invalid_schema');
});

test('additional-property capture stays gated and inbound-only', () => {
  expect(groundExtraction(parsed(), context(quote, { captureAdditionalProperties: false })).additional_properties).toEqual([]);
  const outbound = context(); outbound.message.direction = 'outbound';
  expect(groundExtraction(parsed(), outbound).additional_properties).toEqual([]);
});

test('long address lists cannot widen the existing facts and obligations lane', () => {
  const request = 'Please call me';
  const message = `${request}\n${'Additional information. '.repeat(40)}\n${quote}`;
  const result = groundExtraction(parsed([address], { obligations: [{ party: 'waves', kind: 'callback',
    description: request, quote: request, basis: 'request', property_id: null, due_text: null, due_at: null }] }), context(message));
  expect(result.additional_properties).toHaveLength(1);
  expect(result.obligations).toEqual([]);
  expect(result.facts).toEqual([]);
  expect(result.dropped).toBeGreaterThan(0);
});

test('a long source still requires operational review when the model returns no ordinary instructions', () => {
  const message = `${'Additional information. '.repeat(40)}\n${quote}`;
  expect(groundExtraction(parsed(), context(message))).toMatchObject({ additional_properties: [address], dropped: 1 });
});

test('office review requires complete address fields and an explicit property role', () => {
  expect(() => reviewedAddresses([address], [{ ...address, occupancy_type: 'unsupported' }])).toThrow();
  expect(() => reviewedAddresses([address], [{ ...address, zip: '', occupancy_type: 'rental_investment' }])).toThrow();
  expect(() => reviewedAddresses([address], [])).toThrow();
});
