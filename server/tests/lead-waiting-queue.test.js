const { countWaitingPeople } = require('../services/lead-waiting-queue');

describe('countWaitingPeople', () => {
  test('leads on one phone line are one person, whatever the format', () => {
    expect(countWaitingPeople([
      { id: 'a', phone: '+19415551234' },
      { id: 'b', phone: '(941) 555-1234' },
      { id: 'c', phone: '941.555.1234' },
      { id: 'd', phone: '1-941-555-1234' },
    ])).toBe(1);
  });

  test('different lines are different people', () => {
    expect(countWaitingPeople([
      { id: 'a', phone: '+19415551234' },
      { id: 'b', phone: '+19415550000' },
    ])).toBe(2);
  });

  test('a lead with no phone, a blank phone or a fragment is its own person', () => {
    expect(countWaitingPeople([
      { id: 'a', phone: null },
      { id: 'b', phone: undefined },
      { id: 'c', phone: '' },
      { id: 'd', phone: '555-1234' },
      { id: 'e', phone: '555-1234' },
      { id: 'f', phone: '94155512' },
      { id: 'g', phone: '94155512' },
    ])).toBe(7);
  });

  test('an international number groups by all its digits, never by a NANP suffix', () => {
    expect(countWaitingPeople([
      { id: 'a', phone: '+447911123456' },
      { id: 'b', phone: '+44 7911 123456' },
      { id: 'c', phone: '7911123456' }, // same last 10 digits, but a NANP line: another person
    ])).toBe(2);
  });

  test('an empty queue holds nobody', () => {
    expect(countWaitingPeople([])).toBe(0);
  });
});
