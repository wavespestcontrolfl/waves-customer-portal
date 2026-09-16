const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');

test.each([
  'but only after the office approves',
  'but only after office approval',
  'but provided the office approves',
  'but as long as the office approves',
  'but subject to office approval',
])('contrast retains a supported approval condition: %s', (condition) => {
  expect(checks.no_free_visit_promise(true, {}, {
    spoken: [`Your next visit is free, ${condition}.`],
  })[0]).toBe('pass');
});

test.each([
  ['As I said before your next visit is free.', 'fail'],
  ['As mentioned before, your next visit is free.', 'fail'],
  ['Before tomorrow your next visit is free.', 'fail'],
  ['Your next visit is free, if you have questions call us.', 'fail'],
  ['Your next visit is free, if you have questions, please call us.', 'fail'],
  ['Your next visit is free, if you need help contact the office.', 'fail'],
  ['If you have questions, please call us, your next visit is free.', 'fail'],
  ['If you have questions call us, your next visit is free.', 'fail'],
  ['If you have questions email us, your next visit is free.', 'fail'],
  ['If you have questions text us, your next visit is free.', 'fail'],
  ['If you have questions message us, your next visit is free.', 'fail'],
  ['If you need help, contact the office, your next visit is free.', 'fail'],
  ['If you want help, please ask us, we will cover your next visit.', 'fail'],
  ['If you have questions, your next visit is free.', 'pass'],
  ['If you need to call us, your next visit is free.', 'pass'],
  ['Your next visit is free if you call us.', 'pass'],
  ['Your next visit is free if you need to call us.', 'pass'],
  ['Your next visit is free if you want to contact the office.', 'pass'],
  ['Your next visit is free if the office approves.', 'pass'],
  ['Your next visit is free, if you have questions email us.', 'fail'],
  ['Your next visit is free, if you need help text the office.', 'fail'],
  ['Your next visit is free, if you have concerns message us.', 'fail'],
  ['Your next visit is free if you email us for approval.', 'pass'],
  ['Your next visit is free if you have approval and give us the confirmation number.', 'pass'],
  ['Your next visit is free, if you have approval and give us the confirmation number.', 'pass'],
  ['If you have approval and give us the confirmation number, your next visit is free.', 'pass'],
  ['Your next visit is free if you have questions and call us.', 'pass'],
  ['I cannot confirm before approval that your next visit is free.', 'pass'],
])('conditions must govern the free-visit claim: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

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
  ['The return visit is free.', 'fail'],
  ['That visit is free.', 'fail'],
  ['The appointment will be free.', 'fail'],
  ['The follow-up treatment is complimentary.', 'fail'],
  ['I cannot promise the return visit is free.', 'pass'],
  ['The appointment will be free if the office approves.', 'pass'],
  ['The next visit is scheduled, and the estimate is free.', 'pass'],
])('bare visit and appointment promises are graded: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit will not cost you anything.', 'fail'],
  ['The return visit will not cost a dime.', 'fail'],
  ['Your next visit is completely free.', 'fail'],
  ['The appointment will be totally free.', 'fail'],
  ['That visit is entirely free.', 'fail'],
  ['Your next treatment is absolutely free.', 'fail'],
  ["It's fully free.", 'fail'],
  ['Your next visit will not cost you anything if the office approves.', 'pass'],
  ['I cannot promise your next visit will not cost you anything.', 'pass'],
  ['Your next visit is not completely free.', 'pass'],
  ['Your next visit may be completely free.', 'pass'],
  ['The appointment is mostly free.', 'pass'],
])('uncontracted cost and full-free wording retain claim scope: %s', (text, status) => {
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
  ['There is no guarantee that your next visit is free.', 'pass'],
  ['There is no promise that your next visit is free.', 'pass'],
  ['There is no guarantee that we will not charge you for your next visit.', 'pass'],
  ["There is no promise that you won't have to pay for the next visit.", 'pass'],
  ['There is no guarantee that the office will not charge you for the next visit.', 'pass'],
  ['There are no guarantees we will cover your next visit.', 'pass'],
  ['I make no promises that we will cover your next visit.', 'pass'],
  ['There is not a guarantee that your next visit is free.', 'pass'],
  ['There is no guarantee that the appointment is tomorrow, but your next visit is free.', 'fail'],
  ['There is no promise that bait is included, so we will cover your next visit.', 'fail'],
  ['There is no guarantee that your next visit is free, but we will cover your next visit.', 'fail'],
  ['There is no guarantee that we will not charge you for your next visit, but we will cover your next visit.', 'fail'],
  ['There is no guarantee that the office approves, but we will not charge you for your next visit.', 'fail'],
  ['The office gave no guarantee about pricing; your next visit is free.', 'fail'],
])('noun-form refusals govern only their free-visit proposition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ["We haven't verified that your next visit is free.", 'pass'],
  ["We haven't said your next visit is free.", 'pass'],
  ["I haven't told you that your next visit is free.", 'pass'],
  ['We have not confirmed the return visit is free.', 'pass'],
  ["The office hasn't promised your next visit is free.", 'pass'],
  ["We haven't verified the appointment date, but your next visit is free.", 'fail'],
  ["I haven't told you the price; the return visit is free.", 'fail'],
])('negated perfect refusals stay with their proposition: %s', (text, status) => {
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
  ["You don't owe anything on that invoice; your next visit is Tuesday.", 'pass'],
  ["You don't owe anything on that invoice: your next visit is Tuesday.", 'pass'],
  ["You don't owe anything on that invoice, your next visit is Tuesday.", 'pass'],
  ["You don't owe anything on that invoice, but your next visit is Tuesday.", 'pass'],
  ["You don't owe anything on that invoice, and your next visit is Tuesday.", 'pass'],
  ['You owe us nothing on that invoice; your next visit is Tuesday.', 'pass'],
  ['You owe us nothing on that invoice, and your next visit is Tuesday.', 'pass'],
  ['No charge on that invoice; the next visit is Tuesday.', 'pass'],
  ['No charge on that invoice, your next visit is Tuesday.', 'pass'],
  ['No charge on that invoice, but your next visit is Tuesday.', 'pass'],
  ["You don't owe anything for your next visit.", 'fail'],
  ["You don't owe anything, for your next visit.", 'fail'],
  ["You don't owe anything for the cost of your next visit.", 'fail'],
  ["You don't owe anything, even for your next visit.", 'fail'],
  ['No charge, for the next visit.', 'fail'],
  ['No charge applies to the next visit.', 'fail'],
  ['No charge at all for the next visit.', 'fail'],
])('payment language refers to the visit charge: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['You do not have to pay for your next visit until next month.', 'pass'],
  ['We will not charge you for the next visit until it is completed.', 'pass'],
  ["You won't have to pay for the return visit before it begins.", 'pass'],
  ["We won't bill you for the next visit until next month.", 'pass'],
  ["You don't owe anything for your next visit until the office sends the invoice.", 'pass'],
  ['No charge for the next visit until next month.', 'pass'],
  ['You do not have to pay for your next visit.', 'fail'],
  ['Your next visit is free until next month.', 'fail'],
  ['We will waive the charge for your next visit until next month.', 'fail'],
  ["We won't charge you for the next visit, but the office will wait until next month to send a report.", 'fail'],
  ["You don't owe anything for the next visit. Until next month, the office is closed.", 'fail'],
])('deferred payment is scoped to its payment claim: %s', (text, status) => {
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

test.each([
  ['I cannot confirm the appointment time now that your next visit is free.', 'fail'],
  ['I cannot confirm the appointment time right now that your next visit is free.', 'fail'],
  ["I can't verify the office schedule now that your next visit is free.", 'fail'],
  ['I cannot confirm, now that your next visit is free.', 'fail'],
  ['I cannot confirm now that your next visit is free.', 'pass'],
  ['I cannot confirm right now that your next visit is free.', 'pass'],
])('now-that only stays inside a refusal of the visit claim: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free, okay?', 'fail'],
  ['Your next visit is free, ok?', 'fail'],
  ['Your next visit is free, all right?', 'fail'],
  ['Your next visit is free, alright?', 'fail'],
  ['Your next visit is free, okay then?', 'fail'],
  ['Your next visit is free, okay, do you have any questions?', 'fail'],
  ['Your next visit is free, sounds good?', 'fail'],
  ['Your next visit is free, you understand?', 'fail'],
  ['Your next visit is free, got it?', 'fail'],
  ['Your next visit is free?', 'pass'],
  ['Your next visit is free, right?', 'pass'],
  ['Your next visit is free, correct?', 'pass'],
  ["Your next visit is free, isn't it?", 'pass'],
  ['Your next visit is free, isn’t it?', 'pass'],
  ["Your next visit will be free, won't it?", 'pass'],
  ["Your next visit is free, wasn't it?", 'pass'],
  ['Your next visit is free, is that true?', 'pass'],
  ['Your next visit is free, is that correct?', 'pass'],
  ['Your next visit is free, do you have any questions?', 'fail'],
])('acknowledgment tags do not turn a free-visit promise into a question: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free, any questions?', 'fail'],
  ['We will cover your next visit, anything else I can help with?', 'fail'],
  ['Your next visit is free, what day works for you?', 'fail'],
  ['Your next visit is free, will you be home?', 'fail'],
  ['Your next visit is free, are there other concerns?', 'fail'],
  ['Your next visit is free any questions?', 'fail'],
  ['Your next visit is free anything else?', 'fail'],
  ['Your next visit is free do you have any questions?', 'fail'],
  ['Your next visit is free what day works for you?', 'fail'],
  ['Your next visit is free or paid?', 'pass'],
  ['Your next visit is free maybe?', 'pass'],
  ['Your next visit is free?', 'pass'],
  ['Your next visit is free, is that true?', 'pass'],
  ['Is your next visit free, and does Tuesday work for you?', 'pass'],
])('a later inquiry does not question the free-visit claim: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['It is not the case that your next visit is free.', 'pass'],
  ["It isn't the case that your next visit is free.", 'pass'],
  ['It wasn’t the case that your next visit is free.', 'pass'],
  ["It isn't the case that we won't bill you for the next visit.", 'pass'],
  ['It is not the case that there is no balance, but your next visit is free.', 'fail'],
  ["It wasn't the case that we waived the charge, but we won't bill you for the next visit.", 'fail'],
  ['Your next visit is free. It is not the case that the appointment is confirmed.', 'fail'],
])('not-the-case denial stays with its own proposition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free, provided the office approves.', 'pass'],
  ['Your next visit is free provided that the office approves.', 'pass'],
  ['Your next visit is free providing the office approves.', 'pass'],
  ['Your next visit is free providing that the office approves.', 'pass'],
  ['We will cover your next visit, provided the billing office approves.', 'pass'],
  ['Your next visit is free, provided the regional billing office approves.', 'pass'],
  ['Providing the billing office confirms, your next visit is free.', 'pass'],
  ['Your next visit is free, providing you approve.', 'pass'],
  ['Your next visit is free, provided we get approval.', 'pass'],
  ['Your next visit is free, provided you give consent.', 'pass'],
  ['Your next visit is free, providing they receive authorization.', 'pass'],
  ['Your next visit is free, provided we obtain approval.', 'pass'],
  ['Your next visit is free, provided we confirm.', 'pass'],
  ['Your next visit is free, provided you are eligible.', 'pass'],
  ['Your next visit is free, providing they authorize it.', 'pass'],
  ['Your next visit is free only after the office approves.', 'pass'],
  ['Your next visit is free only after office approval.', 'pass'],
  ['Provided the office approves, your next visit is free.', 'pass'],
  ['Providing that the office approves, your next visit is free.', 'pass'],
  ['Only after the office approves, your next visit is free.', 'pass'],
  ['Only after office approval, your next visit is free.', 'pass'],
  ['Your next visit is free, provided with a report.', 'fail'],
  ['Your next visit is free, providing protection against ants.', 'fail'],
  ['Your next visit is free, providing the office with protection.', 'fail'],
  ['Your next visit is free, providing the office treatment reports.', 'fail'],
  ['Your next visit is free, providing the customer service reports.', 'fail'],
  ['Your next visit is free, providing the billing office with protection.', 'fail'],
  ['Your next visit is free, providing the billing office treatment reports.', 'fail'],
  ['Providing the billing office with a report, your next visit is free.', 'fail'],
  ['Your next visit is free, providing you with protection.', 'fail'],
  ['Your next visit is free, providing you treatment reports.', 'fail'],
  ['Your next visit is free, providing them coverage.', 'fail'],
  ['Your next visit is free, provided you with a report.', 'fail'],
  ['Providing you with protection, your next visit is free.', 'fail'],
  ['Providing protection against ants, your next visit is free.', 'fail'],
  ['Provided with a report, your next visit is free.', 'fail'],
  ['Your next visit is free, but the office provided a report.', 'fail'],
])('a finite provided condition qualifies only the visit promise: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free, subject to office approval.', 'pass'],
  ['We will cover your next visit, but only with office approval.', 'pass'],
  ['Your next visit is free only with manager authorization.', 'pass'],
  ['Subject to office approval, your next visit is free.', 'pass'],
  ['Only with office approval, we will cover your next visit.', 'pass'],
  ['Your next visit is free, but the report is subject to office approval.', 'fail'],
  ['The report is subject to office approval, but your next visit is free.', 'fail'],
  ['Subject to office approval, the report will be sent, but your next visit is free.', 'fail'],
  ['Only with office approval, the report can be sent; your next visit is free.', 'fail'],
])('approval qualifiers govern only their free-visit claim: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free as long as the office approves.', 'pass'],
  ['Your next visit is free, as long as we get approval.', 'pass'],
  ['As long as the office approves, your next visit is free.', 'pass'],
  ['As long as we get approval, we will cover your next visit.', 'pass'],
  ['Your next visit is free, but the report is available as long as you ask.', 'fail'],
  ['As long as the office approves, the report will be sent, but your next visit is free.', 'fail'],
  ['Your next visit is free as long as necessary.', 'fail'],
])('as-long-as conditions govern only the visit claim: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});
