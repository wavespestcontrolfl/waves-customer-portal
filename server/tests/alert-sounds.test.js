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

  test('the map is frozen', () => {
    expect(Object.isFrozen(ALERT_SOUNDS)).toBe(true);
  });
});
