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

  test('the 8 AM count banner plays the soft reminder sound', () => {
    expect(soundForTrigger('waiting_summary')).toBe('waves-reminder.caf');
  });

  test('the owner open-visit nudge banner plays the soft reminder sound', () => {
    expect(soundForTrigger('open_visits_nudge')).toBe('waves-reminder.caf');
  });

  test('a new-lead email banner plays the New lead sound', () => {
    expect(soundForTrigger('new_lead_email')).toBe(soundForTrigger('new_lead'));
    expect(soundForTrigger('new_lead_email')).toBe('waves-lead.caf');
  });

  test('a website quote banner plays the New lead sound', () => {
    expect(soundForTrigger('new_lead_quote')).toBe(soundForTrigger('new_lead'));
    expect(soundForTrigger('new_lead_quote')).toBe('waves-lead.caf');
  });

  test('high-value customer call, reservice, reschedule, and applicant triggers carry custom sounds', () => {
    expect(soundForTrigger('relay_unbooked_call')).toBe('waves-missed-call.caf');
    expect(soundForTrigger('relay_reservice_filed')).toBe('waves-missed-call.caf');
    expect(soundForTrigger('sandy_transfer_no_context')).toBe('waves-missed-call.caf');
    expect(soundForTrigger('appointment_reschedule_intent')).toBe('waves-text.caf');
    expect(soundForTrigger('reservice_self_booked')).toBe('waves-reminder.caf');
    expect(soundForTrigger('new_job_application')).toBe('waves-lead.caf');
    expect(soundForTrigger('job_applicant_reply')).toBe('waves-email.caf');
    expect(soundForTrigger('job_interview_booked')).toBe('waves-reminder.caf');
  });

  test('the map is frozen', () => {
    expect(Object.isFrozen(ALERT_SOUNDS)).toBe(true);
  });
});
