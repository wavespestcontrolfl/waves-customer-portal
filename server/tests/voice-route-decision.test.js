const {
  decideVoiceRoute,
  isAnswerFirstScheduleActive,
  isNoAnswerStatus,
} = require('../services/voice-route-decision');

// 2026-06-24 is a Wednesday; June = EDT (UTC-4).
//   11:00Z -> 07:00 ET (Wed)   16:00Z -> 12:00 ET (Wed)
// 2026-06-25T02:00Z -> 22:00 ET on 2026-06-24 (Wed)
const ET_07_WED = new Date('2026-06-24T11:00:00Z');
const ET_12_WED = new Date('2026-06-24T16:00:00Z');
const ET_22_WED = new Date('2026-06-25T02:00:00Z');

const ENDPOINT = { agentEndpoint: '+15551230000' };

describe('decideVoiceRoute — gate + endpoint safety', () => {
  test('gate off → normal (never consults config)', () => {
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: false, config: { ...ENDPOINT, aiAnswersFirst: true } }))
      .toEqual({ action: 'normal', reason: 'gate_off' });
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: false, noHumanAnswered: true, config: ENDPOINT }))
      .toEqual({ action: 'normal', reason: 'gate_off' });
  });

  test('no agent endpoint → normal even with every toggle on', () => {
    const cfg = { aiAnswersFirst: true, noAnswerBackstopEnabled: true, answerFirstSchedule: { enabled: true, startHourET: 0, endHourET: 24 } };
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: cfg, now: ET_22_WED }).action).toBe('normal');
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, noHumanAnswered: true, config: cfg }).action).toBe('normal');
  });

  test('missing/empty config → normal', () => {
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true }).action).toBe('normal');
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, noHumanAnswered: true, config: {} }).reason).toBe('no_agent_endpoint');
  });
});

describe('decideVoiceRoute — initial phase (AI answers first)', () => {
  test('default: humans ring first', () => {
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: ENDPOINT, now: ET_12_WED }))
      .toEqual({ action: 'normal', reason: 'ring_staff_first' });
  });

  test('aiAnswersFirst toggle → agent immediately', () => {
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: { ...ENDPOINT, aiAnswersFirst: true }, now: ET_12_WED }))
      .toEqual({ action: 'agent', reason: 'answers_first_toggle' });
  });

  test('active nightly schedule → agent', () => {
    const cfg = { ...ENDPOINT, answerFirstSchedule: { enabled: true, startHourET: 18, endHourET: 8 } };
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: cfg, now: ET_07_WED }))
      .toEqual({ action: 'agent', reason: 'answers_first_schedule' });
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: cfg, now: ET_22_WED }).action).toBe('agent');
  });

  test('schedule enabled but outside window → normal', () => {
    const cfg = { ...ENDPOINT, answerFirstSchedule: { enabled: true, startHourET: 18, endHourET: 8 } };
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: cfg, now: ET_12_WED }).action).toBe('normal');
  });

  test('schedule disabled → normal', () => {
    const cfg = { ...ENDPOINT, answerFirstSchedule: { enabled: false, startHourET: 0, endHourET: 24 } };
    expect(decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: cfg, now: ET_07_WED }).action).toBe('normal');
  });
});

describe('decideVoiceRoute — after_dial phase (no-answer backstop)', () => {
  test('no human answered + backstop default(undefined) → agent', () => {
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, noHumanAnswered: true, dialStatus: 'no-answer', config: ENDPOINT }))
      .toEqual({ action: 'agent', reason: 'backstop_no-answer' });
  });

  test('no human answered but backstop explicitly disabled → normal (voicemail)', () => {
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, noHumanAnswered: true, config: { ...ENDPOINT, noAnswerBackstopEnabled: false } }))
      .toEqual({ action: 'normal', reason: 'backstop_disabled' });
  });

  test('human answered → normal', () => {
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, noHumanAnswered: false, config: ENDPOINT }))
      .toEqual({ action: 'normal', reason: 'human_answered' });
  });

  test('falls back to dialStatus when noHumanAnswered not supplied', () => {
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, dialStatus: 'busy', config: ENDPOINT }).action).toBe('agent');
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, dialStatus: 'completed', config: ENDPOINT }).action).toBe('normal');
  });

  test('carrier-voicemail-answered (completed, not accepted) still backstops via noHumanAnswered', () => {
    // dialStatus would be "completed" yet no human pressed 1 → webhook sets noHumanAnswered=true
    expect(decideVoiceRoute({ phase: 'after_dial', gateEnabled: true, noHumanAnswered: true, dialStatus: 'completed', config: ENDPOINT }).action).toBe('agent');
  });
});

describe('isAnswerFirstScheduleActive', () => {
  test('overnight wrap window', () => {
    const s = { enabled: true, startHourET: 18, endHourET: 8 };
    expect(isAnswerFirstScheduleActive(s, ET_07_WED)).toBe(true);   // 07:00 < 8
    expect(isAnswerFirstScheduleActive(s, ET_22_WED)).toBe(true);   // 22:00 >= 18
    expect(isAnswerFirstScheduleActive(s, ET_12_WED)).toBe(false);  // midday
  });

  test('same-day window', () => {
    const s = { enabled: true, startHourET: 9, endHourET: 17 };
    expect(isAnswerFirstScheduleActive(s, ET_12_WED)).toBe(true);
    expect(isAnswerFirstScheduleActive(s, ET_07_WED)).toBe(false);
  });

  test('openDays gates the morning tail on the window START day (prev ET day)', () => {
    const weekdays = { enabled: true, startHourET: 18, endHourET: 8, openDays: [1, 2, 3, 4, 5] };
    const weekend = { enabled: true, startHourET: 18, endHourET: 8, openDays: [0, 6] };
    // Wed 07:00 is the tail of TUE-night's window; Tue(2) ∈ Mon–Fri, ∉ weekend.
    expect(isAnswerFirstScheduleActive(weekdays, ET_07_WED)).toBe(true);
    expect(isAnswerFirstScheduleActive(weekend, ET_07_WED)).toBe(false);
  });

  test('overnight window uses the START day at the midnight boundary', () => {
    const monFri = { enabled: true, startHourET: 18, endHourET: 8, openDays: [1, 2, 3, 4, 5] };
    const MON_02 = new Date('2026-06-22T06:00:00Z'); // Mon 02:00 ET — tail of SUN night
    const SAT_02 = new Date('2026-06-27T06:00:00Z'); // Sat 02:00 ET — tail of FRI night
    const FRI_20 = new Date('2026-06-27T00:00:00Z'); // Fri 20:00 ET — evening
    expect(isAnswerFirstScheduleActive(monFri, MON_02)).toBe(false); // Sun not selected
    expect(isAnswerFirstScheduleActive(monFri, SAT_02)).toBe(true);  // Fri selected
    expect(isAnswerFirstScheduleActive(monFri, FRI_20)).toBe(true);  // Fri evening
  });

  test('disabled / malformed → false', () => {
    expect(isAnswerFirstScheduleActive({ enabled: false, startHourET: 0, endHourET: 24 }, ET_07_WED)).toBe(false);
    expect(isAnswerFirstScheduleActive(null, ET_07_WED)).toBe(false);
    expect(isAnswerFirstScheduleActive({ enabled: true, startHourET: 8, endHourET: 8 }, ET_07_WED)).toBe(false);
    expect(isAnswerFirstScheduleActive({ enabled: true }, ET_07_WED)).toBe(false);
  });
});

describe('isNoAnswerStatus', () => {
  test('recognizes unanswered Twilio statuses', () => {
    ['no-answer', 'busy', 'failed', 'canceled', 'NO-ANSWER'].forEach((s) => expect(isNoAnswerStatus(s)).toBe(true));
    ['completed', 'answered', '', null, undefined].forEach((s) => expect(isNoAnswerStatus(s)).toBe(false));
  });
});
