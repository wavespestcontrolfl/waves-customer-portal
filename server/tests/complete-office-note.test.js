// The office note a completion may carry (voice fill, GATE_FAST_COMPLETE_VOICE_FILL):
// honored only while the gate is live, trimmed, capped, strings only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { officeNoteForCompletion } = require('../services/complete-scheduled-service');

describe('officeNoteForCompletion', () => {
  const prev = process.env.GATE_FAST_COMPLETE_VOICE_FILL;
  afterEach(() => {
    if (prev === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL;
    else process.env.GATE_FAST_COMPLETE_VOICE_FILL = prev;
  });

  test('gate off: nothing is kept, whatever the body says', () => {
    delete process.env.GATE_FAST_COMPLETE_VOICE_FILL;
    expect(officeNoteForCompletion('Gate code changed')).toBe('');
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'TRUE';
    expect(officeNoteForCompletion('Gate code changed')).toBe('');
  });

  test('gate on: a trimmed string, capped at 800 characters', () => {
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    expect(officeNoteForCompletion('  Dog in the yard, call first.  ')).toBe('Dog in the yard, call first.');
    expect(officeNoteForCompletion('x'.repeat(900))).toHaveLength(800);
  });

  test('gate on: blank or non-string is nothing', () => {
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    for (const value of [undefined, null, '', '   ', 42, { note: 'x' }, ['x']]) {
      expect(officeNoteForCompletion(value)).toBe('');
    }
  });
});
