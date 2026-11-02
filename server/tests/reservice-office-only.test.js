// officeOnlyReason: the keyword screen that keeps a message about US (damage we caused, money, a complaint about the
// service, a missed or late visit) off the customer's re-service report, and never the pest or lawn problem itself.
// Synthetic text only.

const { officeOnlyReason } = require('../services/reservice-office-only');

describe('officeOnlyReason', () => {
  test.each([
    'ants are back in the kitchen',
    'Fire ants in the front yard again',
    'Do you treat for millipedes?',
    'Picked: Ants, Spiders',
    'There are brown patches in the lawn',
    'Roaches near the sink; they were dead on the floor',
    'I saw a spider on the porch lately',
    'Is the spray safe for my cat?',
    '',
    null,
    // Strong words about the pests are the request itself, never a complaint about us.
    'The ants are the worst they have ever been',
    'The mosquitoes are worst near the porch',
    'The ants are the worst you have ever seen',
    "I'm fed up with these ants",
    'The ants are terrible this year',
    'Mosquitoes are horrible in the evening',
    'Frustrated, the ants are back in the kitchen',
    'Very disappointed, still seeing ants',
    // Pests damage and kill lawns too: no word points at us.
    'We have chinch bug damage in the front yard',
    'The chinch bugs killed my grass',
    'Dead spots in the lawn by the fence',
    'Brown patches and some dead grass near the driveway',
    'The weeds are ruining the lawn',
    'The fire ant bites burn',
    'My kids got stung and it was burning',
    // The treatment's result on a pest or a weed is the re-service's subject, never damage; a "not" undoes the harm.
    'The spray did not kill the ants',
    'The spray killed the weeds but they are growing back',
    'The spray killed the bugs in my yard',
    'The ants are dying after your treatment',
    "The spray didn't hurt my dog",
    // Harm with nothing of the customer's named, stains that are a pest sign, the customer's own bleach, the sun.
    'Brown spots after your treatment',
    'There are roach stains in the cabinets',
    'There are stains on the walls by the stove',
    'There are stains on the patio now',
    // A missed area is the re-service's own request, not a no-show.
    "The tech didn't come inside the gate",
    'I used bleach on the ants',
    'My grass is burnt from the sun',
    'Our cat gets sick if we let her out on the lanai',
    // "late" and "what happened" about the pests, not the visit.
    'I see them late at night in the kitchen',
    'The roaches come out late at night',
    "They're out late at night by the pool",
    'What happened to the grass by the pool?',
    'The ants did not come back after the last visit',
    'I am still waiting for the ants to go away',
    'Waiting all day for the bait to work',
    // A name, not a bill.
    'Bill said the roaches are in the garage',
    // The request the re-service is for: it prints, and the tech answers it.
    "Why didn't you treat the east side yard?",
  ])('the pest or lawn problem itself: %j -> null', (text) => {
    expect(officeOnlyReason(text)).toBeNull();
  });

  test.each([
    ['The technician spilled product on the lanai', 'damage'],
    ['Your guy spilled granules on my driveway', 'damage'],
    ['Stains on the pool deck from the spray', 'damage'],
    ['Burn spots on the lawn after the treatment', 'damage'],
    ['You burned my plants', 'damage'],
    ['The lawn looks burned after the last treatment', 'damage'],
    ['There is fertilizer burn by the walkway', 'damage'],
    ['Your tech broke my sprinkler head', 'damage'],
    ['The spray turned my shrubs brown', 'damage'],
    ['My dog got sick after the spray', 'damage'],
    ['The treatment made my dog sick', 'damage'],
    ['The weed killer killed the grass and the weeds', 'damage'],
    ['You killed my roses', 'damage'],
    ['I want a refund', 'billing'],
    ['Why was I charged twice?', 'billing'],
    ['I got a bill for a visit I did not book', 'billing'],
    ['I am unhappy with the last visit', 'complaint'],
    ['Not happy with the service at all', 'complaint'],
    ['Worst service I have ever had', 'complaint'],
    ['Your tech was rude', 'complaint'],
    ['You guys are the worst', 'complaint'],
    ['This is unacceptable, the treatment did nothing', 'complaint'],
    ['I am not happy with you', 'complaint'],
    ['I want to cancel my service', 'complaint'],
    ['My lawyer will call you', 'complaint'],
    ['I will sue', 'complaint'],
    ['No one showed up', 'schedule'],
    ['Nobody came today', 'schedule'],
    ['You never showed up', 'schedule'],
    ['The tech did not show', 'schedule'],
    ['Tech was late again', 'schedule'],
    ["You're late", 'schedule'],
    ['Why did you come so late?', 'schedule'],
    ['Your tech showed up late', 'schedule'],
    ['They came past the appointment window', 'schedule'],
    ['It is now past the appointment window. What happened?', 'schedule'],
    ['What happened to my visit?', 'schedule'],
    ['Where is the tech?', 'schedule'],
    ['Still waiting for someone to come out', 'schedule'],
    ['Still waiting.', 'schedule'],
    ['Been waiting all day for your tech', 'schedule'],
    ['Still waiting on a call back', 'schedule'],
  ])('a message about us: %j -> %s', (text, reason) => {
    expect(officeOnlyReason(text)).toBe(reason);
  });
});
