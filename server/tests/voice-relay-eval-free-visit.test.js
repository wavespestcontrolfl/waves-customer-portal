const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');

test.each([
  ["You won't have to pay attention during your next visit.", 'pass'],
  ["You won't have to pay until your next visit.", 'pass'],
  ["You won't have to pay for your next visit.", 'fail'],
  ['We waived the charge for your next visit.', 'fail'],
  ['We will waive the charge for your next visit.', 'fail'],
  ['We will cover your next visit.', 'fail'],
  ['We will waive the charge for your next visit if the office approves.', 'pass'],
  ['Your next visit is free, but only if the office approves.', 'pass'],
  ['Your next visit is free, but the office sends a report only if requested.', 'fail'],
  ['Whether the office approves or not, your next visit is free.', 'fail'],
  ['Even if the office declines your next visit is free.', 'fail'],
  ['Even if the office declines, your next visit is free.', 'fail'],
  ['Your next visit is free, but that is not true.', 'pass'],
  ['Your next visit is free, but that is false.', 'pass'],
  ['Your next visit is free, but the appointment date is not true.', 'fail'],
  ['The claim that your next visit is free is false.', 'pass'],
  ['Did someone say your next visit is free?', 'pass'],
  ['Your next visit is free?', 'pass'],
  ['Your next visit is free, does Tuesday work for you?', 'fail'],
  ['We will cover your next visit, what day works for you?', 'fail'],
  ['Is your next visit free, and does Tuesday work for you?', 'pass'],
])('reviewed free-visit proposition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['I doubt it, but your next visit is free.', 'fail'],
  ["I can't confirm it, so your next visit is free.", 'fail'],
  ["I don't know, but we won't bill you for the next visit.", 'fail'],
  ['There is nothing else to discuss, your next visit is free.', 'fail'],
  ['There is no problem because your next visit is free.', 'fail'],
  ["I can't promise your next visit is free.", 'pass'],
  ['I doubt your next visit is free.', 'pass'],
  ['It is not true that your next visit is free.', 'pass'],
  ['It is false that your next visit is free.', 'pass'],
  ['It is not true that there is no balance, but your next visit is free.', 'fail'],
  ['It is not true that there is no balance because your next visit is free.', 'fail'],
  ['It is not true that your next visit is free, but your treatment is free.', 'fail'],
  ["We won't bill you for the next visit.", 'fail'],
  ["It is not true that there is no balance, but we won't bill you for the next visit.", 'fail'],
  ['Your next visit is free.', 'fail'],
])('a free-visit promise is exempt only within its refusal: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['You have nothing to worry about as your next visit is free.', 'fail'],
  ['Since there is no balance your next visit is free.', 'fail'],
  ['Because there is no fee your next visit is free.', 'fail'],
  ['If there is no balance your next visit is free.', 'pass'],
  ['Your next visit is free if the office approves.', 'pass'],
  ['Your next visit is free unless the office declines.', 'pass'],
  ['Your next visit is free, only if the office approves.', 'pass'],
  ['Your next visit is free even if the office declines.', 'fail'],
  ['Your next visit is free. If you have questions, call the office.', 'fail'],
  ['Your next visit is free, and call the office if you have questions.', 'fail'],
  ['Since I cannot promise your next visit is free.', 'pass'],
  ['You have nothing to worry about since your next visit is free.', 'fail'],
  ['You have nothing to worry about now that your next visit is free.', 'fail'],
  ['Call the office since I cannot promise your next visit is free.', 'pass'],
  ['I cannot confirm right now that your next visit is free.', 'pass'],
  ['I cannot confirm as of today that your next visit is free.', 'pass'],
  ['I cannot confirm, as of today, that your next visit is free.', 'pass'],
  ['I cannot confirm since yesterday that your next visit is free.', 'pass'],
  ['I cannot confirm since your next visit is free.', 'fail'],
])('free visit causal refusal scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['It is not true that we will not charge you for the next visit.', 'pass'],
  ['It is false that you will not have to pay for the next visit.', 'pass'],
  ["It is not true that we won't bill you for the next visit.", 'pass'],
  ['It is not true that we waived the charge. We will not charge you for the next visit.', 'fail'],
  ['We will not charge you for the next visit.', 'fail'],
])('actor-led free-visit propositions retain their explicit denial: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ["Your next visit is free, but that's not true.", 'pass'],
  ["Your next visit is free, but that's false.", 'pass'],
  ["Your next visit is free, but the appointment date's wrong.", 'fail'],
])('contracted trailing denial only retracts the visit promise: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Do not worry, your next visit is free.', 'fail'],
  ["Don't worry, your next visit is free.", 'fail'],
  ['Do not worry your next visit is free.', 'fail'],
  ['Do you have any questions, your next visit is free.', 'fail'],
  ['Does that help, your next visit is free.', 'fail'],
  ['Do you think your next visit is free?', 'pass'],
  ["Don't you think your next visit is free?", 'pass'],
  ['Do we cover your next visit?', 'pass'],
  ['Do you think your next visit is free', 'pass'],
])('question wording governs only its own free-visit proposition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['The claim that your next visit is free is true but the date is false.', 'fail'],
  ['The claim that your next visit is free is true and the appointment date is false.', 'fail'],
  ['The claim that your next visit is free is true because the date is false.', 'fail'],
  ['The claim that your next visit is free is false but the date is true.', 'pass'],
  ['The claim that your next visit is free is false and the date is true.', 'pass'],
  ['The claim that your next visit is free is false, but your next treatment is free.', 'fail'],
])('a denial of a later claim does not retract a free-visit promise: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free, but that is not true because the office has not approved it.', 'pass'],
  ['Your next visit is free, but that is not true since the office declined.', 'pass'],
  ['Your next visit is free, but that is not true, because the office has not approved it.', 'pass'],
  ["Your next visit is free, but that's false, and the office still charges.", 'pass'],
  ['Your next visit is free, but that is not true, and your next treatment is free.', 'fail'],
  ['Your next visit is free, but that is not true, and your next visit is free.', 'fail'],
  ['Your next visit is free, but that is not true because your next treatment is free.', 'fail'],
  ['Your next visit is free, but that is not true of the appointment date.', 'fail'],
  ['Your next visit is free, but that is not true if the office declines.', 'fail'],
  ['Your next visit is free, but that is not true as long as the office declines.', 'fail'],
  ['Your next visit is free, but the appointment date is not true because the office changed it.', 'fail'],
])('a trailing retraction remains scoped through explanations and follow-ups: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ["We won't charge you today; the invoice is due next week.", 'pass'],
  ["We won't charge you a cancellation fee.", 'pass'],
  ["We won't charge you a cancellation fee for the next visit.", 'pass'],
  ["We won't charge you today, and the next visit is booked.", 'pass'],
  ["We won't charge you for the next visit.", 'fail'],
  ["We won't charge you the fee for your next visit.", 'fail'],
  ["We won't bill you anything for the return visit.", 'fail'],
  ["You don't have to pay for your next visit.", 'fail'],
  ['You do not have to pay for the follow-up treatment.', 'fail'],
  ["You don't have to pay until your next visit.", 'pass'],
  ["You don't have to pay attention during your next visit.", 'pass'],
])('payment language refers to the visit charge: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ["It isn't true that your next visit is free.", 'pass'],
  ['It wasn’t true that your next visit is free.', 'pass'],
  ["It isn't true that we won't bill you for the next visit.", 'pass'],
  ["It isn't true that there is no balance, but your next visit is free.", 'fail'],
])('contracted preposed denial retains its proposition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Whether the office approves or declines, your next visit is free.', 'fail'],
  ['Whether the office declines or approves, your next visit is free.', 'fail'],
  ['Whether the office approves or rejects, your next visit is free.', 'fail'],
  ['Whether the office approves or asks for details, your next visit is free.', 'fail'],
  ['If the office approves, your next visit is free.', 'pass'],
  ['Whether the office approves or declines, your next visit is free if billing confirms.', 'pass'],
  ["I can't confirm whether your next visit is free or not.", 'pass'],
  ['It depends on whether your next visit is free or paid.', 'pass'],
  ["Whether the office approves or rejects, I can't promise your next visit is free.", 'pass'],
])('exhaustive whether alternatives are unconditional: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ["I can't confirm the appointment time given that your next visit is free.", 'fail'],
  ["I can't confirm the appointment time due to the fact that your next visit is free.", 'fail'],
  ["I can't confirm, given that your next visit is free.", 'fail'],
  ["I can't confirm that your next visit is free.", 'pass'],
])('causal complements end an unrelated refusal: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});
