/**
 * Per-tech Twilio line — registry contract (config/twilio-numbers.js
 * `fieldTech`). The gate is read at CALL time by findByNumber: off, the line
 * is reported exactly like an unassigned office number so nothing inbound is
 * dropped; on, it is `tech_line` and the webhooks route it to the holder.
 */
const TWILIO_NUMBERS = require('../config/twilio-numbers');

const LINE = '+19413529161';

describe('fieldTech registry bucket', () => {
  const prior = process.env.GATE_TECH_LINES;
  afterEach(() => {
    if (prior === undefined) delete process.env.GATE_TECH_LINES;
    else process.env.GATE_TECH_LINES = prior;
  });

  test('gate off (unset) → unassigned/office semantics, never dropped', () => {
    delete process.env.GATE_TECH_LINES;
    const cfg = TWILIO_NUMBERS.findByNumber(LINE);
    expect(cfg).toMatchObject({ number: LINE, type: 'location', locationId: 'bradenton', label: 'Tech line 1' });
  });

  test('gate exactly on → tech_line', () => {
    process.env.GATE_TECH_LINES = 'true';
    expect(TWILIO_NUMBERS.findByNumber(LINE)).toMatchObject({ number: LINE, type: 'tech_line', locationId: 'bradenton' });
    process.env.GATE_TECH_LINES = 'yes';
    expect(TWILIO_NUMBERS.findByNumber(LINE).type).toBe('location');
  });

  test('listed in allNumbers as tech_line (stats, webhook scripts) and owned (never a lead)', () => {
    const row = TWILIO_NUMBERS.allNumbers.find((n) => n.number === LINE);
    expect(row).toMatchObject({ type: 'tech_line', formatted: '(941) 352-9161' });
    expect(TWILIO_NUMBERS.isOwnedNumber('9413529161')).toBe(true);
    expect(TWILIO_NUMBERS.isInternalNumber(LINE)).toBe(true);
  });

  test('a tech line never doubles as a location / tracking / paid / GBP number', () => {
    const others = TWILIO_NUMBERS.allNumbers.filter((n) => n.type !== 'tech_line').map((n) => n.number);
    for (const t of TWILIO_NUMBERS.fieldTech) {
      expect(others).not.toContain(t.number);
      expect(t.number).not.toBe(TWILIO_NUMBERS.mainLine.number);
    }
  });

  test('never attributed as a lead source', () => {
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(LINE).source).toBe('unknown');
  });
});
