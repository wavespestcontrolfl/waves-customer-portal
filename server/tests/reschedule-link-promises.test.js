jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const links = require('../services/reschedule-link-promises');
const { parseETDateTime } = require('../utils/datetime-et');
const { gates } = require('../config/feature-gates');
const now = new Date('2030-01-07T12:00:00Z');
const quote = 'I will text you a reschedule link for that appointment.';
const customer = { id: 'customer', phone: '+15555550100' };
const visit = { id: 'visit', customer_id: customer.id, scheduled_date: '2030-01-08', window_start: '09:00', window_end: '10:30',
  status: 'confirmed', service_type: 'WaveGuard', reschedule_token: 'token', property_address: '100 Example Street', property_unit: 'Unit 2' };
const call = { customer_id: customer.id, direction: 'inbound', from_phone: customer.phone, created_at: now,
  v2_extraction_status: 'valid', ai_extraction_enriched: { meta: {} }, transcription: `Agent: ${quote}\nCaller: Thank you.` };
const commitment = { confidence: 0.95, evidence: [{ quote, speaker: 'agent' }] };
const select = (extra = {}) => links.selectDiscussedVisit({ commitment, call, customer, candidates: [visit], now, ...extra });

test('an explicit promise with one available visit identifies it; multiple visits stay in review', () => {
  expect(select().visit?.id).toBe('visit');
  expect(select({ candidates: [visit, { ...visit, id: 'other' }] }).reason).toBe('ambiguous_visit');
});

test.each([undefined, NaN, 0.89])('invalid or low promise confidence stays in review: %s', confidence => {
  expect(select({ commitment: { ...commitment, confidence } }).reason).toBe('promise_needs_review');
});

test('a caller request, conditional promise, or later revocation cannot send', () => {
  expect(select({ call: { ...call, transcription: `Caller: ${quote}` } }).reason).toBe('promise_needs_review');
  expect(select({ call: { ...call, transcription: `Agent: If that works, ${quote}` } }).reason).toBe('promise_needs_review');
  expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: Do not send the link.` } }).reason).toBe('promise_needs_review');
});

test('outbound source variants retain full phone identity', () => {
  expect(select({ call: { ...call, direction: 'outbound-api', from_phone: '+15555550200', to_phone: customer.phone } }).visit?.id).toBe('visit');
  expect(select({ customer: { ...customer, phone: '+445555550100' } }).reason).toBe('customer_identity');
});

test('each subject field must occur in its own source quote, and units remain distinct', () => {
  const subject = { quote: 'The appointment at 100 Example Street Unit 2.', address: '100 Example Street Unit 2' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}\nCaller: WaveGuard is my other service.` };
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, service: 'WaveGuard' } } }).reason).toBe('subject_not_grounded');
  expect(select({ call: source, commitment: { ...commitment, subject }, candidates: [visit, { ...visit, id: 'unit-3', property_unit: 'Unit 3' }] }).visit?.id).toBe('visit');
});

test('a stated current date must bind to the canonical quoted weekday and time', () => {
  const weekday = parseETDateTime('2030-01-08T09:00').toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const subject = { quote: `My appointment is ${weekday} at 9 AM.`, visit_date: '2030-01-08' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject } }).visit?.id).toBe('visit');
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-09' } } }).reason).toBe('discussed_visit_unavailable');
});

test('dispatch-owned pending, elapsed and grouped visits stay in review', () => {
  expect(select({ candidates: [{ ...visit, visit_id: 'group' }] }).reason).toBe('visit_not_self_service');
  expect(select({ candidates: [{ ...visit, status: 'pending', source_action: 'ai_call_outbound_review' }] }).visit).toBeUndefined();
  expect(select({ now: parseETDateTime('2030-01-08T11:00') }).reason).toBe('visit_elapsed');
});

test('the commitment gate and explicit shadow/true modes are required', () => {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  try {
    gates.callCommitments = true;
    for (const value of ['', 'false', 'on']) { process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = value; expect(links.mode()).toBe('off'); }
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow'; expect(links.mode()).toBe('shadow');
    gates.callCommitments = false; expect(links.mode()).toBe('off');
  } finally {
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
});
