const { ALERT_SOUNDS, soundForTrigger } = require('../services/alert-sounds');
const { TRIGGER_REGISTRY } = require('../services/notification-triggers');

describe('alert sounds map', () => {
  test('every value is a Waves .caf file name', () => {
    for (const file of Object.values(ALERT_SOUNDS)) expect(file).toMatch(/^waves-[a-z-]+\.caf$/);
  });

  test('every key is a real trigger', () => {
    for (const key of Object.keys(ALERT_SOUNDS)) expect(TRIGGER_REGISTRY[key]).toBeDefined();
  });

  test('soundForTrigger returns the file, or null for an unmapped or inherited key', () => {
    expect(soundForTrigger('new_lead')).toBe('waves-lead.caf');
    expect(soundForTrigger('twilio_failure')).toBeNull();
    expect(soundForTrigger('toString')).toBeNull();
    expect(soundForTrigger(undefined)).toBeNull();
  });

  test('the 8 AM count banner plays the soft reminder sound (GATE_MORNING_BANNER)', () => {
    expect(soundForTrigger('waiting_summary')).toBe('waves-reminder.caf');
  });

  test('the owner open-visit nudge banner plays the soft reminder sound (GATE_OWNER_NUDGE_BANNER)', () => {
    expect(soundForTrigger('open_visits_nudge')).toBe('waves-reminder.caf');
  });

  test('the map is frozen', () => {
    expect(Object.isFrozen(ALERT_SOUNDS)).toBe(true);
  });
});
