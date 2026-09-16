const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');

test.each([
  ['Your next visit is free of cancellation fees and we will bill you normally.', 'pass'],
  ['Your next visit is now free of cancellation fees and we will bill you normally.', 'pass'],
  ['Your next visit is free of cancellation fees and the office will bill you normally.', 'pass'],
  ['Your next visit is free of cancellation fees and rescheduling charges and we will bill you normally.', 'pass'],
  ['Your next visit is free from ants and the office will bill you normally.', 'pass'],
  ['Your next visit is free of cancellation fees and treatment charges.', 'fail'],
  ['Your next visit is now free of cancellation fees and the treatment charges.', 'fail'],
  ['Your next visit is free of cancellation fees and we will bill you normally, but the return visit is free.', 'fail'],
  ['Your next visit is free of cancellation fees and the next visit is complimentary.', 'fail'],
])('nonprice qualifiers allow a coordinated finite clause: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['It is free to view the report.', 'pass'],
  ['It is free to download the report.', 'pass'],
  ['Your next visit is free to review the report.', 'pass'],
  ['Your next visit is free of ants.', 'pass'],
  ['Your next visit is free from termites.', 'pass'],
  ['Your next visit is free of an ant infestation.', 'pass'],
  ['Your next visit is free of cancellation fees and ants.', 'pass'],
  ['Your next visit is free of charge.', 'fail'],
  ['Your next visit is free of treatment charges.', 'fail'],
  ['Your next visit is free of ants and treatment charges.', 'fail'],
  ['Your next visit is free of ants and is free.', 'fail'],
  ['Your next visit is free to you.', 'fail'],
  ['It is free to view the report, but your next visit is free.', 'fail'],
  ['Your next visit is free of ants, but the return visit is free.', 'fail'],
])('explicit nonprice freedom and state stay distinct from visit price: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['You will not have to pay for this visit.', 'fail'],
  ["You won't need to pay for that appointment.", 'fail'],
  ["You don't have to pay for the visit.", 'fail'],
  ['You will not have to pay for your upcoming service.', 'fail'],
  ['You will not have to pay for the report during this visit.', 'pass'],
  ['You will not have to pay until this visit.', 'pass'],
  ['The technician will not have to pay for this visit.', 'pass'],
  ['If the office approves, you will not have to pay for this visit.', 'pass'],
  ['You will not have to pay for this visit if the office approves.', 'pass'],
  ['The report needs approval, but you will not have to pay for this visit.', 'fail'],
  ['I cannot confirm that you will not have to pay for this visit.', 'pass'],
  ['I cannot confirm the date, but you will not have to pay for this visit.', 'fail'],
  ['You will not have to pay for this visit until next month.', 'pass'],
])('payment obligation uses the shared visit target and scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Nobody promised that your next visit is free.', 'pass'],
  ['No one said your next visit is free.', 'pass'],
  ['No-one guaranteed that your next visit is free.', 'pass'],
  ['Neither of us said the return visit is free.', 'pass'],
  ['Neither I nor the office promised that your next visit is free.', 'pass'],
  ['Nobody has confirmed that we will cover your next visit.', 'pass'],
  ['Nobody promised that your next visit is free, but the return visit is free.', 'fail'],
  ['No one said the report was free, but your next visit is free.', 'fail'],
  ['Neither of us said the appointment is tomorrow, but your next visit is free.', 'fail'],
])('negative reporting subjects refuse only their own proposition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ["We don't charge you for your next visit.", 'fail'],
  ['We do not charge you for your next visit.', 'fail'],
  ["We don’t bill you anything for the return visit.", 'fail'],
  ['The office does not invoice you for your next visit.', 'fail'],
  ["The office doesn't charge you for your next visit.", 'fail'],
  ["We don't invoice you for your next visit.", 'fail'],
  ["We don't charge you today; the next visit is Tuesday.", 'pass'],
  ["We don't charge you a cancellation fee for your next visit.", 'pass'],
  ["We don't charge you for the report during your next visit.", 'pass'],
  ['If the office approves, we do not charge you for your next visit.', 'pass'],
  ["We don't charge you for your next visit if the office approves.", 'pass'],
  ["The report needs approval, but we don't charge you for your next visit.", 'fail'],
  ["We don't charge you for your next visit until next month.", 'pass'],
  ['We do not bill you for the return visit before it begins.', 'pass'],
  ["We don't charge you for your next visit, but the report waits until next month.", 'fail'],
  ["I cannot confirm that we don't charge you for your next visit.", 'pass'],
  ['It is false that we do not charge you for your next visit.', 'pass'],
  ["I cannot confirm the date, but we don't charge you for your next visit.", 'fail'],
  ["It is false that we don't charge you for the report, but we don't charge you for your next visit.", 'fail'],
])('present-tense billing assurances retain target and qualifier scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ["You don't need to pay for your next visit.", 'fail'],
  ["You won't need to pay for your next visit.", 'fail'],
  ['You do not need to pay for the return treatment.', 'fail'],
  ['You will not need to pay anything for your next visit.', 'fail'],
  ['You do need to pay for your next visit.', 'pass'],
  ["You don't need to pay attention during your next visit.", 'pass'],
  ["You won't need to pay until your next visit.", 'pass'],
  ["The technician won't need to pay for your next visit.", 'pass'],
  ['The technician will not need to pay for your next visit.', 'pass'],
  ["The customer won't need to pay for your next visit.", 'fail'],
  ['If the office approves, you do not need to pay for your next visit.', 'pass'],
  ["You don't need to pay for your next visit if the office approves.", 'pass'],
  ["The report needs approval, but you don't need to pay for your next visit.", 'fail'],
  ["I cannot confirm that you won't need to pay for your next visit.", 'pass'],
  ["It is false that you won't need to pay for your next visit.", 'pass'],
  ["I cannot confirm the date, but you won't need to pay for your next visit.", 'fail'],
  ["You won't need to pay for your next visit until next month.", 'pass'],
  ["You don't need to pay for your next visit before it begins.", 'pass'],
])('need-to-pay claims retain payment and qualifier scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['You will never be charged for your next visit.', 'fail'],
  ["You'll never be billed for your next visit.", 'fail'],
  ['You are never invoiced for your next visit.', 'fail'],
  ["You're never charged for your next visit.", 'fail'],
  ['The technician will never be charged for your next visit.', 'pass'],
  ["We'll never be billed for your next visit.", 'pass'],
  ['If the office approves, you will never be charged for your next visit.', 'pass'],
  ['You will never be charged for your next visit if the office approves.', 'pass'],
  ['The report needs approval, but you will never be charged for your next visit.', 'fail'],
  ['I cannot confirm that you will never be charged for your next visit.', 'pass'],
  ["It is false that you'll never be billed for your next visit.", 'pass'],
  ['I cannot confirm the date, but you will never be charged for your next visit.', 'fail'],
  ['You will never be charged for your next visit until it is completed.', 'pass'],
  ['You will never be charged until your next visit.', 'pass'],
])('never-passive charges retain payment and qualifier scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free of cancellation fees and is billed normally.', 'pass'],
  ['Your next visit is free of cancellation fees, and will be billed normally.', 'pass'],
  ['Your next visit is free of cancellation fees when you give notice.', 'pass'],
  ['Your next visit is free of cancellation fees after you give notice.', 'pass'],
  ['Your next visit is now free of cancellation fees and is billed normally.', 'pass'],
  ['Your next visit is already free of cancellation fees when you give notice.', 'pass'],
  ['Your next visit is free of cancellation fees and treatment charges.', 'fail'],
  ['Your next visit is now free of cancellation fees and treatment charges.', 'fail'],
  ['Your next visit is free of cancellation fees and is free.', 'fail'],
  ['Your next visit is now free of cancellation fees and is complimentary.', 'fail'],
  ['Your next visit is free of cancellation fees and is billed normally, but the return visit is free.', 'fail'],
  ['Your next visit is already free of cancellation fees when you give notice, and the return visit is free.', 'fail'],
])('ancillary fee tails allow finite or temporal continuation only: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free and complimentary, if that helps.', 'fail'],
  ['Your next visit is complimentary and free, if you ask me.', 'fail'],
  ['Your next visit is free and complimentary if you have questions call us.', 'fail'],
  ['Your next visit is free and complimentary if the office approves.', 'pass'],
  ['We will cover your next visit and the report if you have questions call us.', 'fail'],
  ['We will cover your next visit and the report, if that helps.', 'fail'],
  ['We will cover your next visit and the report if you have approval and call us.', 'pass'],
  ['We will cover your next visit and the report if the office approves.', 'pass'],
  ['It is not true that you will owe nothing for your next visit.', 'pass'],
  ["It is false that you'll owe nothing for your next visit.", 'pass'],
  ['It isn’t true that you are going to owe nothing for your next visit.', 'pass'],
  ['It is not true that you will not be charged for your next visit.', 'pass'],
  ['It is not true that the report is free, but you will owe nothing for your next visit.', 'fail'],
  ['You will owe nothing for your next visit.', 'fail'],
])('coordinated conditions and future-debtor denials retain claim scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free and complimentary if the office approves.', 'pass'],
  ['Your next visit is complimentary and free if the office approves.', 'pass'],
  ['Your next visit is free and will be complimentary if the office approves.', 'pass'],
  ['Your next visit is free and complimentary, provided the office approves.', 'pass'],
  ['Your next visit is free and complimentary if you have approval and call us.', 'pass'],
  ['Your next visit is free and complimentary if you have questions call us.', 'fail'],
  ['Your next visit is free and complimentary, if you have questions, please call us.', 'fail'],
  ['Your next visit is free and the report is complimentary if the office approves.', 'fail'],
  ['Your next visit is free and the next treatment is complimentary if the office approves.', 'fail'],
  ['Your next visit is free and complimentary if the office approves, but the return visit is free.', 'fail'],
  ['Your next visit is free and complimentary. If the office approves, we will call.', 'fail'],
])('coordinated price predicates share only their own condition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['You will not be charged for your next visit.', 'fail'],
  ["You won't be billed for the return visit.", 'fail'],
  ['You are not being charged for your next visit.', 'fail'],
  ["You're not going to be charged for your next visit.", 'fail'],
  ["You'll be charged nothing for your next visit.", 'fail'],
  ['The customer will not be invoiced for your next visit.', 'fail'],
  ['The technician will not be charged for your next visit.', 'pass'],
  ['We will not be billed for your next visit.', 'pass'],
  ['You might not be charged for your next visit.', 'pass'],
  ['You will not be charged for your next visit if the office approves.', 'pass'],
  ['You will not be charged for your next visit until next month.', 'pass'],
  ["You won't be billed for the return visit before it is completed.", 'pass'],
  ['You will not be charged for your next visit, but the report will wait until next month.', 'fail'],
  ['You will not be charged for the report during your next visit.', 'pass'],
])('passive customer payment keeps debtor and deferral scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free, assuming the office approves.', 'pass'],
  ['Assuming the office approves, your next visit is free.', 'pass'],
  ['Your next visit is free assuming that we get approval.', 'pass'],
  ['Assuming approval, your next visit is free.', 'pass'],
  ['Your next visit is free, on condition that the office approves.', 'pass'],
  ['On the condition that we get consent, your next visit is free.', 'pass'],
  ['Assuming the office approves, your next visit is free and your next treatment is complimentary.', 'pass'],
  ['Your next visit is free, assuming responsibility for the report.', 'fail'],
  ['Assuming responsibility for the report, your next visit is free.', 'fail'],
  ['Your next visit is free, but the report is ready assuming the office approves.', 'fail'],
  ['Assuming the office approves, the report is ready, but your next visit is free.', 'fail'],
  ['Your next visit is free, on condition that the report is delivered, but the return visit is free.', 'fail'],
])('assuming and on-condition qualifiers govern only their visit claims: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['We will owe nothing for your next visit.', 'pass'],
  ['I will owe nothing for your next visit.', 'pass'],
  ["We'll owe nothing for your next visit.", 'pass'],
  ['I’ll owe nothing for your next visit.', 'pass'],
  ['We are going to owe nothing for your next visit.', 'pass'],
  ["We're going to owe nothing for your next visit.", 'pass'],
  ['The technician will owe nothing for your next visit.', 'pass'],
  ['You will owe nothing for your next visit.', 'fail'],
  ["You'll owe nothing for your next visit.", 'fail'],
  ['You are going to owe nothing for your next visit.', 'fail'],
  ["You're going to owe nothing for your next visit.", 'fail'],
  ['The customer will owe nothing for your next visit.', 'fail'],
  ['We will owe nothing for your next visit, but you will owe nothing for your next visit.', 'fail'],
  ['You will owe nothing for your next visit if the office approves.', 'pass'],
  ['You will owe nothing for your next visit until next month.', 'pass'],
  ['You will owe nothing for your next visit, but the report will wait until next month.', 'fail'],
])('future owe statements keep their explicit debtor: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is now free.', 'fail'],
  ['Your next visit is already free.', 'fail'],
  ['Your next visit is still free.', 'fail'],
  ['The return visit is just free.', 'fail'],
  ['Your next appointment is actually free.', 'fail'],
  ["Your next visit's now free.", 'fail'],
  ['Your next visit is not free.', 'pass'],
  ['Your next visit is now free if the office approves.', 'pass'],
  ['Your next visit is still free, but that is false.', 'pass'],
  ['Your next visit is already free of charge if the office approves.', 'pass'],
  ['Your next visit is now free of cancellation fees.', 'pass'],
  ['Your next visit is still free to reschedule.', 'pass'],
  ['Your next visit is now free of treatment charges.', 'fail'],
  ['Your next visit is now free of charge.', 'fail'],
])('temporal price modifiers keep free-visit claim scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['We will cover your next visit and the report if the office approves.', 'pass'],
  ["We'll cover your next visit and the report if the office approves.", 'pass'],
  ['We will cover the cost of your next visit and the report only if the office approves.', 'pass'],
  ['We will cover your next visit and the report, if the office approves.', 'pass'],
  ['We will cover your next visit and the report is ready if the office approves.', 'fail'],
  ['We will cover your next visit and we will send the report if the office approves.', 'fail'],
  ['We will cover your next visit and the report. If the office approves, we will call.', 'fail'],
  ['We will cover your next visit, but the report is ready if the office approves.', 'fail'],
  ['Your next visit is free of charge if the office approves.', 'pass'],
  ['Your next visit is completely free of charge if the office approves.', 'pass'],
  ['Your next visit is free of charge, provided the office approves.', 'pass'],
  ['Your next visit is free of charge, but that is not true.', 'pass'],
  ['Your next visit is free of charge, but the report date is not true.', 'fail'],
  ['Your next visit is free of charge.', 'fail'],
])('price phrases and coordinated objects retain their own tail scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free of cancellation fees.', 'pass'],
  ['The return visit is free of any rescheduling fee.', 'pass'],
  ['Your next visit is free from booking charges.', 'pass'],
  ['Your next appointment is free of cancellation fees and rescheduling charges.', 'pass'],
  ['Your next visit is free of cancellation fees, and rescheduling charges.', 'pass'],
  ['Your next visit is free of cancellation fees, and the report will be emailed.', 'pass'],
  ['Your next visit is free to cancel.', 'pass'],
  ['Your next visit is free of charge.', 'fail'],
  ['Your next visit is free of treatment charges.', 'fail'],
  ['Your next visit is free of any charge.', 'fail'],
  ['Your next visit is free of cancellation fees and treatment charges.', 'fail'],
  ['Your next visit is free of cancellation fees, and treatment charges.', 'fail'],
  ['Your next visit is free of cancellation fees, but the return visit is free.', 'fail'],
  ['Your next visit is free of cancellation fees, but the return visit is free if the office approves.', 'pass'],
])('ancillary-fee wording does not assert a free treatment: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is free, if that helps.', 'fail'],
  ['Your next visit is free if it helps you.', 'fail'],
  ['Your next visit is free, if this helps.', 'fail'],
  ['Your next visit is free, if you ask me.', 'fail'],
  ['If you ask me, your next visit is free.', 'fail'],
  ['If that helps, your next visit is free.', 'fail'],
  ['If you ask me, your next visit is free and your next treatment is complimentary.', 'fail'],
  ['If you ask me, if the office approves, your next visit is free and your next treatment is complimentary.', 'pass'],
  ['Your next visit is free if the office approves.', 'pass'],
  ['Your next visit is free if that helps and the office approves.', 'pass'],
  ['Your next visit is free, if that helps, if the office approves.', 'pass'],
])('conversational if-asides do not condition visit prices: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['You will pay nothing for your next visit.', 'fail'],
  ['You will not pay anything for your next visit.', 'fail'],
  ["You'll pay nothing for your next visit.", 'fail'],
  ['You’ll pay nothing for your next visit.', 'fail'],
  ["You won't pay a dime for the return visit.", 'fail'],
  ['You pay nothing for your next visit.', 'fail'],
  ['You do not pay anything for your next visit.', 'fail'],
  ["You're going to pay nothing for your next visit.", 'fail'],
  ["You aren't going to pay anything for your next visit.", 'fail'],
  ['The customer will pay nothing for your next visit.', 'fail'],
  ['The technician will pay nothing for your next visit.', 'pass'],
  ['We will not pay anything for your next visit.', 'pass'],
  ['I will pay nothing for your next visit.', 'pass'],
  ['You might pay nothing for your next visit.', 'pass'],
  ['You could pay nothing for your next visit.', 'pass'],
  ['You cannot pay nothing for your next visit.', 'pass'],
  ['You do not pay nothing for your next visit.', 'pass'],
  ['You will pay nothing for your next visit if the office approves.', 'pass'],
  ['You will not pay anything for your next visit until next month.', 'pass'],
  ['You will pay nothing for your next visit before next month.', 'pass'],
  ['You will pay nothing for your next visit, but the report will wait until next month.', 'fail'],
  ['You will pay nothing for the report.', 'pass'],
])('direct customer payment claims keep debtor and qualifier scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['I am not promising that your next visit is free.', 'pass'],
  ['We never said that your next visit is free.', 'pass'],
  ['I was not confirming that your next visit is free.', 'pass'],
  ['I did not mention that your next visit is free.', 'pass'],
  ['We never told you that your next visit is free.', 'pass'],
  ['I am not guaranteeing that your next visit is free.', 'pass'],
  ['We are not checking that your next visit is free.', 'pass'],
  ['I am not promising that you will pay nothing for your next visit.', 'pass'],
  ['I am not promising the report is free, but your next visit is free.', 'fail'],
  ['We never said the estimate was free, but your next visit is free.', 'fail'],
  ['I am not promising that your next visit is free, but the return visit is complimentary.', 'fail'],
  ['We said that your next visit is free.', 'fail'],
  ['We promised that your next visit is free.', 'fail'],
])('inflected reporting refusals stay with their claim: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['If the office approves, your next visit is free and your next treatment is complimentary.', 'pass'],
  ['If the office approves, your next visit is free, and your next treatment is complimentary.', 'pass'],
  ['If the office approves, your next visit is free, your next treatment is complimentary.', 'pass'],
  ['Provided the office approves, your next visit is free and your next treatment is complimentary.', 'pass'],
  ['If the office approves, your next visit is free and then your next treatment is complimentary.', 'pass'],
  ['If the office approves, your next visit is free or your next treatment is complimentary.', 'pass'],
  ['If the office approves, your next visit is free, but your next treatment is complimentary.', 'fail'],
  ['If the office approves, your next visit is free. Your next treatment is complimentary.', 'fail'],
  ['If the office approves, your next visit is free; your next treatment is complimentary.', 'fail'],
  ['If the office approves, your next visit is free: your next treatment is complimentary.', 'fail'],
  ['If you have questions, please call us, your next visit is free and your next treatment is complimentary.', 'fail'],
  ['If the office approves, your next visit is free and your next treatment is complimentary, but the return visit is free.', 'fail'],
])('preposed conditions govern coordinated results only: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

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
  ['We cover your next visit.', 'fail'],
  ['We covered the next visit.', 'fail'],
  ['We will cover the next visit.', 'fail'],
  ["We'll cover the next visit.", 'fail'],
  ['We are covering your next visit.', 'fail'],
  ["We're covering your next visit.", 'fail'],
  ['We have covered your next visit.', 'fail'],
  ["We've covered your next visit.", 'fail'],
  ['We are going to cover your next visit.', 'fail'],
  ["We're going to cover your next visit.", 'fail'],
  ['We cover the cost of your next visit.', 'fail'],
  ['We are covering the cost of your next visit.', 'fail'],
  ["We've covered the cost of your next visit.", 'fail'],
  ['We can cover your next visit.', 'pass'],
  ['We could cover the cost of your next visit.', 'pass'],
  ['We would cover your next visit.', 'pass'],
  ['We will cover your next visit if the office approves.', 'pass'],
  ["We're covering the cost of your next visit if the office approves.", 'pass'],
  ['We cover the cost of the report.', 'pass'],
])('cover predicates retain a visit target and affirmative scope: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
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
  ['Your next visit is free if you have approval and then call us.', 'pass'],
  ['Your next visit is free if you have approval and promptly call us.', 'pass'],
  ['If you have approval and then call us, your next visit is free.', 'pass'],
  ['Your next visit is free, if you have questions then call us.', 'fail'],
  ['Your next visit is free, if you have questions, then call us.', 'fail'],
  ['Your next visit is free, if you have questions and please call us.', 'fail'],
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
  ["We'll waive the charge for your next visit.", 'fail'],
  ['We’ll waive the charge for your next visit.', 'fail'],
  ["I'll waive the charge for the return visit.", 'fail'],
  ["We've waived the charge for your next visit.", 'fail'],
  ["We're waiving the charge for your next visit.", 'fail'],
  ["I'm waiving the charge for your next visit.", 'fail'],
  ["We haven't waived the charge for your next visit.", 'pass'],
  ['We could waive the charge for your next visit.', 'pass'],
  ['We will cover your next visit.', 'fail'],
  ['We will cover the cost of your next visit.', 'fail'],
  ["We'll cover the cost of your next visit.", 'fail'],
  ['We’ll cover the cost of the return visit.', 'fail'],
  ['I will cover the cost of the next visit.', 'fail'],
  ['We will cover the cost of the report.', 'pass'],
  ["We'll cover the cost of the report.", 'pass'],
  ["We'll cover the cost.", 'pass'],
  ["We'll cover the visit.", 'fail'],
  ['We will cover the cost of the report, but we will cover the cost of your next visit.', 'fail'],
  ['We will waive the charge for your next visit if the office approves.', 'pass'],
  ["We'll waive the charge for your next visit if the office approves.", 'pass'],
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
  ['It is not true that there is no charge for your next visit.', 'pass'],
  ['It is false that there is no charge for your next visit.', 'pass'],
  ['There is no charge for your next visit.', 'fail'],
  ['It is not true that there is no charge for the report, but there is no charge for your next visit.', 'fail'],
  ['Your next visit is not a service that is free.', 'pass'],
  ['Your next visit is not the one that is complimentary.', 'pass'],
  ['Your next visit is not a treatment that is complimentary.', 'pass'],
  ['Your next visit is a service that is free.', 'fail'],
  ['Your next visit is the one that is complimentary.', 'fail'],
  ['Your next visit is a treatment that is complimentary.', 'fail'],
  ["The technician won't have to pay for your next visit.", 'pass'],
  ['The technician will not have to pay for your next visit.', 'pass'],
  ["We don't owe anything for your next visit.", 'pass'],
  ['We owe nothing for your next visit.', 'pass'],
  ["I don't owe anything for your next visit.", 'pass'],
  ["You won't have to pay for your next visit.", 'fail'],
  ["The customer won't have to pay for your next visit.", 'fail'],
  ["You don't owe anything for your next visit.", 'fail'],
  ['You owe us nothing for your next visit.', 'fail'],
  ["The office won't bill you for the next visit.", 'fail'],
  ["We don't owe anything for your next visit, but you don't owe anything for your next visit.", 'fail'],
])('price denials and debtor scope stay with their own proposition: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Your next visit is going to be free.', 'fail'],
  ["Your next visit's going to be free.", 'fail'],
  ['The return visit is going to be complimentary.', 'fail'],
  ['Your next visit will cost you nothing.', 'fail'],
  ['The return visit will cost nothing.', 'fail'],
  ['Your next visit is going to cost you nothing.', 'fail'],
  ['Your next visit is not going to be free.', 'pass'],
  ['Your next visit could cost you nothing.', 'pass'],
  ['Your next visit is free to cancel.', 'pass'],
  ['Your next visit is free to reschedule.', 'pass'],
  ['Your next visit is free to you.', 'fail'],
  ['Your next visit is free to cancel, but the return visit is free.', 'fail'],
  ['Your next visit includes a report that is complimentary.', 'pass'],
  ['Your next visit includes a report that is free.', 'pass'],
  ["Your next visit includes a report that's free.", 'pass'],
  ['Your next visit is not something that is complimentary.', 'pass'],
  ['Your next visit is something that is complimentary.', 'fail'],
  ['The next visit that is complimentary is Tuesday.', 'fail'],
  ["That's free.", 'fail'],
  ['Your next visit is complimentary.', 'fail'],
  ['Your next visit already costs you nothing.', 'fail'],
  ['Your next visit will be absolutely complimentary.', 'fail'],
  ['Your next visit has been waived.', 'fail'],
  ["Your next visit's waived.", 'fail'],
  ['Your next visit’s waived.', 'fail'],
])('a visit price predicate stays with the visit: %s', (text, status) => {
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
