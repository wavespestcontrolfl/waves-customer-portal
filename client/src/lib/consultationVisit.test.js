import { describe, expect, it } from 'vitest';
import { canRecordConsultationOutcome, isConsultationVisit } from './consultationVisit';

describe('isConsultationVisit', () => {
  it('matches the lawn_inspection catalog key or the Waves Assessment name', () => {
    expect(isConsultationVisit({ completionProfile: { serviceKey: 'lawn_inspection' }, serviceType: 'Anything' })).toBe(true);
    expect(isConsultationVisit({ serviceType: ' waves assessment ' })).toBe(true);
    expect(isConsultationVisit({ service_type: 'Waves Assessment' })).toBe(true);
  });

  it('rejects other services, including names that only contain the phrase', () => {
    expect(isConsultationVisit({ serviceType: 'Quarterly Pest Control' })).toBe(false);
    expect(isConsultationVisit({ serviceType: 'Waves Assessment Follow-up' })).toBe(false);
    expect(isConsultationVisit(null)).toBe(false);
  });
});

describe('canRecordConsultationOutcome', () => {
  it.each(['no_show', 'cancelled', 'skipped', 'rescheduled'])('refuses a %s visit', (status) => {
    expect(canRecordConsultationOutcome({ serviceType: 'Waves Assessment', status })).toBe(false);
  });

  it.each(['pending', 'on_site', 'completed'])('allows a %s visit', (status) => {
    expect(canRecordConsultationOutcome({ serviceType: 'Waves Assessment', status })).toBe(true);
  });
});
