// officeOnlyReason: the conservative keyword screen that keeps a complaint, a
// damage report, a billing question or a no-show gripe off the customer's
// re-service report. Synthetic text only.

const { officeOnlyReason } = require('../services/reservice-office-only');

describe('officeOnlyReason', () => {
  test.each([
    ['ants are back in the kitchen', null],
    ['Fire ants in the front yard again', null],
    ['Do you treat for millipedes?', null],
    ['Picked: Ants, Spiders', null],
    ['There are brown patches in the lawn', null],
    ['Roaches near the sink; they were dead on the floor', null],
    ['I saw a spider on the porch lately', null],
    ['Is the spray safe for my cat?', null],
    ['', null],
    [null, null],
  ])('ordinary pest or lawn talk: %j -> null', (text, expected) => {
    expect(officeOnlyReason(text)).toBe(expected);
  });

  test.each([
    ['The technician spilled product on the lanai', 'damage'],
    ['There are stains on the patio now', 'damage'],
    ['You burned my plants', 'damage'],
    ['dead grass by the driveway', 'damage'],
    ['my grass is dead', 'damage'],
    ['I want a refund', 'billing'],
    ['Why was I charged twice?', 'billing'],
    ['I got a bill for a visit I did not book', 'billing'],
    ['I am unhappy with the last visit', 'complaint'],
    ['Very disappointed, still seeing ants', 'complaint'],
    ['I am upset and angry', 'complaint'],
    ['My lawyer will call you', 'complaint'],
    ['I will sue', 'complaint'],
    ['No one showed up', 'schedule'],
    ['The tech did not show', 'schedule'],
    ['Tech was late again', 'schedule'],
    ['They came past the appointment window', 'schedule'],
    ['What happened to my visit?', 'schedule'],
  ])('office-only: %j -> %s', (text, reason) => {
    expect(officeOnlyReason(text)).toBe(reason);
  });
});
