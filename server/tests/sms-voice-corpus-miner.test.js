const {
  SCHEMA_VERSION,
  _test: { pairRepliesWithInbound, isMinableReply, hasAgentCallerLabels, redactCorpusText, PAIR_WINDOW_HOURS },
} = require('../services/sms-voice-corpus-miner');
const { redactText } = require('../services/agent-decision-training');

const HOUR = 3600 * 1000;
const base = new Date('2026-06-10T12:00:00Z').getTime();
const at = (offsetHours) => new Date(base + offsetHours * HOUR).toISOString();

describe('voice corpus miner — reply/inbound pairing', () => {
  test('pairs a reply with the latest preceding inbound from the same customer', () => {
    const replies = [{ id: 'r1', customer_id: 'c1', message_body: 'Hello! You are all set for Friday.', created_at: at(2) }];
    const inbounds = [
      { id: 'i1', customer_id: 'c1', message_body: 'Old question', created_at: at(0) },
      { id: 'i2', customer_id: 'c1', message_body: 'What time Friday?', created_at: at(1) },
      { id: 'i3', customer_id: 'c2', message_body: 'Different customer', created_at: at(1.5) },
    ];
    const pairs = pairRepliesWithInbound(replies, inbounds);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].inbound.id).toBe('i2');
  });

  test('drops replies with no inbound inside the pairing window', () => {
    const replies = [
      { id: 'r1', customer_id: 'c1', message_body: 'Proactive outreach text here', created_at: at(PAIR_WINDOW_HOURS + 10) },
      { id: 'r2', customer_id: 'c2', message_body: 'Reply with no stimulus at all', created_at: at(5) },
    ];
    const inbounds = [{ id: 'i1', customer_id: 'c1', message_body: 'Hi', created_at: at(0) }];
    expect(pairRepliesWithInbound(replies, inbounds)).toHaveLength(0);
  });

  test('never pairs an inbound that arrives after the reply', () => {
    const replies = [{ id: 'r1', customer_id: 'c1', message_body: 'Following up on your request', created_at: at(1) }];
    const inbounds = [{ id: 'i1', customer_id: 'c1', message_body: 'Late message', created_at: at(2) }];
    expect(pairRepliesWithInbound(replies, inbounds)).toHaveLength(0);
  });

  test('two replies can pair with the same inbound thread in order', () => {
    const replies = [
      { id: 'r1', customer_id: 'c1', message_body: 'First reply with details', created_at: at(1) },
      { id: 'r2', customer_id: 'c1', message_body: 'Second reply with more details', created_at: at(3) },
    ];
    const inbounds = [
      { id: 'i1', customer_id: 'c1', message_body: 'Question one', created_at: at(0) },
      { id: 'i2', customer_id: 'c1', message_body: 'Question two', created_at: at(2) },
    ];
    const pairs = pairRepliesWithInbound(replies, inbounds);
    expect(pairs.map((p) => [p.reply.id, p.inbound.id])).toEqual([
      ['r1', 'i1'],
      ['r2', 'i2'],
    ]);
  });
});

describe('voice corpus miner — eligibility filters', () => {
  test('trivial acknowledgements are not minable', () => {
    expect(isMinableReply('ok')).toBe(false);
    expect(isMinableReply('Thanks!')).toBe(false);
    expect(isMinableReply('👍')).toBe(false);
    expect(isMinableReply('')).toBe(false);
    expect(isMinableReply('Hello Dale! You are on the schedule for Friday morning.')).toBe(true);
  });

  test('only transcripts with BOTH Agent: and Caller: labels qualify', () => {
    expect(hasAgentCallerLabels('Agent: Thanks for calling Waves.\nCaller: Hi, I have ants.')).toBe(true);
    expect(hasAgentCallerLabels('agent: lowercase works\ncaller: both sides here')).toBe(true);
    // one-sided diarization would pollute the corpus with non-house voice
    expect(hasAgentCallerLabels('Caller: only the customer talking here')).toBe(false);
    expect(hasAgentCallerLabels('Agent: voicemail greeting only')).toBe(false);
    expect(hasAgentCallerLabels('hi i have ants in my kitchen can someone come out')).toBe(false);
    expect(hasAgentCallerLabels(null)).toBe(false);
  });
});

describe('voice corpus miner — redaction contract', () => {
  test('corpus text rides agent-decision-training redaction', () => {
    const context = { customer: { first_name: 'Dale', last_name: 'Cooper' } };
    const out = redactText('Dale, call me at 941-555-1234 or coop@example.com re 123 Palm Ave', context);
    expect(out).not.toContain('Dale');
    expect(out).not.toContain('941-555-1234');
    expect(out).not.toContain('coop@example.com');
    expect(out).not.toContain('123 Palm Ave');
    expect(out).toContain('[name]');
    expect(out).toContain('[phone]');
    expect(out).toContain('[email]');
    expect(out).toContain('[address]');
  });

  test('self-introduced names are scrubbed even with no customer context', () => {
    const out = redactCorpusText('Caller: Hi, my name is Alicia Jonesworth and I have ants everywhere.', {});
    expect(out).not.toContain('Alicia');
    expect(out).not.toContain('Jonesworth');
  });

  test('allowlisted staff names survive — house-voice attribution, not PII', () => {
    const out = redactCorpusText('Agent: Hello, this is Virginia with Waves Pest Control.', {});
    expect(out).toContain('Virginia');
  });

  test('schema version is pinned for the distiller', () => {
    expect(SCHEMA_VERSION).toBe('voice-corpus.v1');
  });
});
