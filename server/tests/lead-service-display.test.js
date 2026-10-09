/**
 * leadServiceDisplay — the Leads screen names a lead's service the way the
 * booking catalog does (owner 2026-10-09). Five intake paths write
 * leads.service_interest in five vocabularies; these pin that each one lands
 * on the same name, that a lead is recurring OR one-time, that an unstated
 * frequency reads as a Waves Assessment, and that a one-time request never
 * does.
 */

const { leadServiceDisplay, catalogNameIndex } = require('../utils/lead-service-display');

const catalogNames = catalogNameIndex([
  'Quarterly Pest Control Service', 'Monthly Pest Control Service', 'One-Time Pest Control Service',
  'Cockroach Treatment Service', 'Monthly Lawn Care Service', 'One-Time Lawn Care Service',
  'WDO Inspection Service', 'Bee / Wasp Nest Removal Service', 'Flea Control Service',
  'Termite Inspection Service', 'Termite Monitoring Service', 'Rodent Trapping Service',
  'Quarterly Rodent Bait Station Service', 'Waves Assessment', 'Semiannual Pest Control Service',
  'Every 6 Weeks Lawn Care Service',
]);
const name = (text) => leadServiceDisplay(text, { catalogNames });

describe('leadServiceDisplay', () => {
  test.each([
    // the same request from four paths reads as one name
    ['Recurring Pest Control', 'Quarterly Pest Control Service'], // website form
    ['Quarterly Pest Control', 'Quarterly Pest Control Service'], // quote wizard
    ['Quarterly Pest Control Service', 'Quarterly Pest Control Service'], // call, catalog pick
    ['Quarterly general pest control for ants, roaches/palmetto bugs, and spiders', 'Quarterly Pest Control Service'], // email
    ['rodent trapping', 'Rodent Trapping Service'],
  ])('%s → %s', (text, expected) => {
    expect(name(text)).toBe(expected);
  });

  test.each([
    ['Recurring Pest Control + Recurring Lawn Care', 'Quarterly Pest Control Service + Monthly Lawn Care Service'],
    ['Quarterly Pest Control Service + Lawn Care Service', 'Quarterly Pest Control Service + Monthly Lawn Care Service'],
    ['Recurring Lawn Care + One-Time Lawn Treatment', 'Monthly Lawn Care Service'],
    ['Recurring Cockroach Control', 'Quarterly Pest Control Service'],
    ['Rodent Bait Stations', 'Quarterly Rodent Bait Station Service'],
    ['Recurring Termite Bait Stations', 'Termite Bait Station Service'],
    ['Termite bait stations and rodent bait stations', 'Termite Bait Station Service + Quarterly Rodent Bait Station Service'],
    ['Recurring Lawn Care + One-Time Lawn Care Service', 'Monthly Lawn Care Service'],
    ['Quarterly Pest Control Service + One-Time Lawn Care Service', 'Quarterly Pest Control Service + Monthly Lawn Care Service'],
  ])('one frequency for the lead, recurring wins: %s → %s', (text, expected) => {
    expect(name(text)).toBe(expected);
  });

  test.each([
    ['General Pest Control', 'Waves Assessment (Pest)'],
    ['Pest Control Consultation', 'Waves Assessment (Pest)'],
    ['Flea & Tick Control Consultation', 'Waves Assessment (Pest)'],
    ['Lawn Care + Pest Control Service', 'Waves Assessment (Pest + Lawn)'],
    ['Waves Assessment + Pest Control Service + Termite Inspection', 'Waves Assessment (Pest + Termite)'],
    ['Waves Assessment + Quarterly Pest Control Service', 'Waves Assessment (Pest)'],
    ['Preventative indoor and exterior pest control; termite protection', 'Waves Assessment (Pest + Termite)'],
    ['Waves Assessment', 'Waves Assessment'],
  ])('no stated frequency is an assessment: %s → %s', (text, expected) => {
    expect(name(text)).toBe(expected);
  });

  test.each([
    ['One-Time Pest Control', 'One-Time Pest Control Service'],
    ['One-Time Cockroach Control', 'Cockroach Treatment Service'],
    ['One-Time Spider & Wasp Control', 'One-Time Pest Control Service'],
    ['One-Time Tree & Shrub Care', 'One-Time Tree & Shrub Care Service'],
    ['One-Time Termite Inspection', 'Termite Inspection Service'],
    ['One-Time Pest Control + Termite Inspection', 'One-Time Pest Control Service + Termite Inspection Service'],
    ['Waves Assessment + One-Time Pest Control', 'One-Time Pest Control Service'],
    ['One-Time Pest Control + Lawn Care', 'One-Time Pest Control Service + One-Time Lawn Care Service'],
  ])('a one-time request is never an assessment: %s → %s', (text, expected) => {
    expect(name(text)).toBe(expected);
    expect(name(text)).not.toMatch(/Assessment/);
  });

  test.each([
    ['WDO Inspection Service', 'WDO Inspection Service'],
    ['WDO inspection and report', 'WDO Inspection Service'],
    ['One-Time WDO inspection and termite treatment', 'WDO Inspection Service + Termite Liquid Treatment Service'],
    ['Termite inspection for a closing', 'Waves Assessment (Termite)'],
    ['Quarterly Pest Control Service + Bee / Wasp Nest Removal Service', 'Quarterly Pest Control Service + Bee / Wasp Nest Removal Service'],
    ['Waves Assessment + WDO Inspection Service', 'Waves Assessment + WDO Inspection Service'],
    ['Ongoing lawn treatment, including fertilizer, weed, pest, and disease treatments', 'Monthly Lawn Care Service'],
    ['Commercial Service', 'Commercial Service'],
  ])('one-job services and unknown text keep their name: %s → %s', (text, expected) => {
    expect(name(text)).toBe(expected);
  });

  test.each([
    ['Monthly pest control for ants', 'Monthly Pest Control Service'],
    ['Bi-monthly lawn care', 'Monthly Lawn Care Service'], // no bi-monthly row in this catalog
    ['Quarterly Pest Control Service + monthly lawn care', 'Quarterly Pest Control Service + Monthly Lawn Care Service'],
    ['Pest control twice a year', 'Semiannual Pest Control Service'],
    ['Lawn care every six weeks', 'Every 6 Weeks Lawn Care Service'],
    ['Pest control every two months', 'Quarterly Pest Control Service'], // no bi-monthly row in this catalog
    ['Recurring Pest Control', 'Quarterly Pest Control Service'],
  ])('a stated cadence is kept when the catalog has that service: %s → %s', (text, expected) => {
    expect(name(text)).toBe(expected);
  });

  test('empty text has no name, and a missing catalog still passes a "… Service" pick through', () => {
    expect(name('')).toBeNull();
    expect(name(null)).toBeNull();
    expect(leadServiceDisplay('Semiannual Pest Control Service')).toBe('Semiannual Pest Control Service');
    expect(leadServiceDisplay('Pest Control Service')).toBe('Waves Assessment (Pest)');
  });
});
