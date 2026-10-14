// The scoring dispatch carries a strict jsonSchema (all 15 points required as
// 0/1, no numeric bounds that Anthropic rejects with a 400), and the stored
// totals come from the points, not the model's own arithmetic.
const mockInsert = jest.fn();
jest.mock('../models/db', () => jest.fn(() => ({ insert: mockInsert })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const CSRCoach = require('../services/csr/csr-coach');

const POINTS = ['greeting', 'empathy', 'problem_capture', 'address', 'time_options', 'fee_confirmation', 'name_confirmation', 'callback_number', 'set_expectations', 'strong_close', 'objection_save', 'upsell_attempt', 'urgency_creation', 'referral_mention', 'follow_up_offer'];
const reply = (pointDetails, totals) => ({
  ok: true,
  json: {
    ...totals,
    point_details: pointDetails,
    control_score: 4, warmth_score: 4, clarity_score: 4, objection_handling_score: 3, closing_strength_score: 4,
    call_outcome: 'booked', lead_quality_score: 8,
  },
});
const allPoints = (value) => Object.fromEntries(POINTS.map((k) => [k, value]));

const run = () => CSRCoach.scoreCall({ csrName: 'Test CSR', callDirection: 'inbound', callSource: 'main', transcript: 'synthetic transcript', metadata: {} });

beforeEach(() => {
  jest.clearAllMocks();
  mockInsert.mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 'score-1' }]) });
});

test('the dispatch requires all 15 points as 0/1 and carries no numeric bounds', async () => {
  dispatchWithFallback.mockResolvedValue(reply(allPoints(1), {}));
  await run();
  const schema = dispatchWithFallback.mock.calls[0][1].jsonSchema;
  expect(schema.properties.point_details.required).toEqual(expect.arrayContaining(POINTS));
  expect(schema.properties.point_details.required).toHaveLength(15);
  expect(schema.properties.point_details.properties.greeting).toEqual({ type: 'integer', enum: [0, 1] });
  expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minItems|maxItems|minLength|maxLength)"/);
});

test('model totals that disagree with complete points are accepted and the stored totals are recomputed', async () => {
  const points = allPoints(1);
  points.greeting = 0;
  points.follow_up_offer = 0; // core 9, rescue 4
  dispatchWithFallback.mockResolvedValue(reply(points, { total_score: 15, core_score: 10, rescue_score: 5 }));
  await run();
  const { validate } = dispatchWithFallback.mock.calls[0][2];
  expect(validate(reply(points, { total_score: 15, core_score: 10, rescue_score: 5 }))).toBeNull();
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ total_score: 13, core_score: 9, rescue_score: 4 }));
});

test('a missing core point is still rejected by the dispatch validator', async () => {
  const points = allPoints(1);
  delete points.address;
  dispatchWithFallback.mockResolvedValue(reply(allPoints(1), {}));
  await run();
  const { validate } = dispatchWithFallback.mock.calls[0][2];
  expect(validate(reply(points, {}))).toBe('schema_invalid');
});
