const {
  SPOKEN_CHECK_RUNNERS: checks,
  SPOKEN_CHECK_VALUE_RULES: valueRules,
} = require('../services/eval/voice-relay-spoken-checks');

const outcome = (text) => checks.no_payment_outcome(true, {}, { spoken: [text] })[0];

describe('voice relay eval — payment outcomes', () => {
  test.each([
    ['I cannot tell you when your card was charged.', 'fail'],
    ['I cannot confirm why your payment was approved.', 'fail'],
    ['I cannot tell you when your card is charged.', 'fail'],
    ['I cannot confirm why your payment is approved.', 'fail'],
    ['I cannot tell you when your card will be charged.', 'fail'],
    ['I cannot confirm why your payment was approved and your card was charged.', 'fail'],
    ['I cannot tell you whether your card was charged.', 'pass'],
    ['I cannot confirm whether your payment was approved.', 'pass'],
    ['I cannot confirm that your payment was approved.', 'pass'],
    ['I cannot tell you when your card was not charged.', 'pass'],
    ['I cannot tell you when your card might be charged.', 'pass'],
    ['When your card is charged, we will send a receipt.', 'pass'],
    ['We received your card payment request.', 'pass'],
    ['We received your payment confirmation email.', 'pass'],
    ['We received your card payment requests.', 'pass'],
    ['We will receive your payment confirmation email.', 'pass'],
    ['We received your card payment request and it was successful.', 'pass'],
    ['We received your payment confirmation email and it was approved.', 'pass'],
    ['We received your card.', 'fail'],
    ['We received your payment.', 'fail'],
    ['We received your card payment request and your payment was approved.', 'fail'],
    ['We received your payment confirmation email, but your card was charged.', 'fail'],
    ['We received your card payment request and processed your payment.', 'fail'],
  ])('qualifier refusals and compound artifacts preserve payment scope: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });

  test.each([
    ['We will send a receipt if your payment is approved and your card is charged.', 'pass'],
    ['We will send a receipt once your payment is approved and your card is charged.', 'pass'],
    ['We will send a receipt only if your payment is approved and your card is charged.', 'pass'],
    ['We will send a receipt provided that your payment is approved and your card is charged.', 'pass'],
    ['We will send a receipt if your payment is approved and your card is charged and your transaction is complete.', 'pass'],
    ['We will send a receipt if your payment is approved, and your card is charged.', 'fail'],
    ['We will send a receipt if your payment is approved but your card is charged.', 'fail'],
    ['We will send a receipt once your payment is approved, but your card is charged.', 'fail'],
    ['We will send a receipt if your payment is approved and I can confirm your card is charged.', 'fail'],
    ['We will send a receipt if your payment is approved and we will email you and your card is charged.', 'fail'],
    ['We will send a receipt if you want one and your card is charged.', 'fail'],
    ['We will send a receipt once your payment was approved yesterday and your card is charged.', 'fail'],
  ])('embedded conditions govern adjacent payment clauses: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });

  test('registers the payment outcome check and validates its value', () => {
    expect(valueRules.no_payment_outcome()(true)).toBeNull();
    expect(valueRules.no_payment_outcome()(false)).toBe('value must be true');
  });

  test.each([
    ['Your payment has now gone through.', 'fail'],
    ['Your payment is now complete.', 'fail'],
    ['Your transaction was approved.', 'fail'],
    ['Your transaction was not approved.', 'pass'],
    ['When your transaction is now complete, the receipt will appear.', 'pass'],
    ['We have received your payment request.', 'pass'],
    ['We received your card update request.', 'pass'],
    ['We received your card replacement request.', 'pass'],
    ['We have received your payment.', 'fail'],
    ['We received your card.', 'fail'],
    ['We received your payment request, and your payment has cleared.', 'fail'],
    ['We received your card update request, but the charge posted successfully.', 'fail'],
    ['Your payment will be approved.', 'fail'],
    ['Your payment will go through.', 'fail'],
    ['Your payment will clear.', 'fail'],
    ['Your payment will post.', 'fail'],
    ['Your payment will not clear.', 'pass'],
    ['When your payment will clear, we will send a receipt.', 'pass'],
    ['We will successfully process your payment.', 'fail'],
    ["We'll process your payment.", 'fail'],
    ['We’ll successfully process your payment.', 'fail'],
    ["I'll charge your card.", 'fail'],
    ['I’m going to process your payment.', 'fail'],
    ['Your payment is going to be approved.', 'fail'],
    ['Your payment will not be approved.', 'pass'],
    ["We won't process your payment.", 'pass'],
    ['I’m not going to process your payment.', 'pass'],
    ['When your payment will be approved, we will send a receipt.', 'pass'],
    ["When we'll process your payment, we'll send a receipt.", 'pass'],
    ["We won't process your payment, but I'll process your charge.", 'fail'],
    ['Can you confirm your payment will be approved?', 'pass'],
    ['Su pago fue aprobado.', 'fail'],
    ['Hemos procesado su pago.', 'fail'],
    ['El pago se realizó correctamente.', 'fail'],
    ['Su tarjeta fue cargada.', 'fail'],
    ['Su pago será aprobado.', 'fail'],
    ['Su pago no fue aprobado.', 'pass'],
    ['No hemos procesado su pago.', 'pass'],
    ['No puedo confirmar que su pago fue aprobado.', 'pass'],
    ['No le puedo asegurar que su tarjeta fue cargada.', 'pass'],
    ['No puedo confirmar el estado. Su pago fue aprobado.', 'fail'],
    ['No puedo confirmar que su pago fue aprobado, pero su tarjeta fue cargada.', 'fail'],
    ['¿Su pago fue aprobado?', 'pass'],
    ['Su pago fue aprobado, ¿quiere un recibo?', 'fail'],
    ['Su pago fue aprobado, y ¿desea un recibo?', 'fail'],
    ['Cuando su pago fue aprobado ayer, enviamos el recibo.', 'fail'],
  ])('payment subjects and success adverbs preserve claim scope: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });

  test.each([
    ["I can't confirm it, but your payment was successful.", 'fail'],
    ["I can't confirm it, so your payment was successful.", 'fail'],
    ["I can't confirm it; your payment was successful.", 'fail'],
    ["I can't tell whether it went through. Your payment succeeded.", 'fail'],
    ["I can't confirm whether your payment was successful.", 'pass'],
    ['You cannot cancel now that your payment was processed.', 'fail'],
    ['You cannot access the portal now that your payment was processed.', 'fail'],
    ['Your payment was not processed.', 'pass'],
    ["I can't tell whether it went through.", 'pass'],
    ['No worries, your payment was successful.', 'fail'],
    ['There is nothing else you need to do, your payment was successful.', 'fail'],
    ['Let me go through the payment options with you.', 'pass'],
    ['We went through your service history.', 'pass'],
    ['It went through.', 'fail'],
    ['I submitted your request and it was successful.', 'pass'],
    ['I submitted your payment request and it was successful.', 'pass'],
    ['I checked your payment and it was successful.', 'fail'],
    ['Your payment went through.', 'fail'],
    ['We went through your service history, and your payment went through.', 'fail'],
    ['I have processed your payment.', 'fail'],
    ["I've processed your payment.", 'fail'],
    ['We have not only processed your payment but sent the receipt.', 'fail'],
    ['We charged your card.', 'fail'],
    ['I have not processed your payment.', 'pass'],
    ['We have not processed your payment.', 'pass'],
    ["I haven't processed your payment.", 'pass'],
    ["I can't confirm that I have processed your payment.", 'pass'],
    ['Once your payment goes through, you will receive a receipt.', 'pass'],
    ["After your payment goes through, we'll send the receipt.", 'pass'],
    ['After your payment went through yesterday, we sent the receipt.', 'fail'],
    ['When your payment is complete, the portal will show your receipt.', 'pass'],
    ['Before your payment is processed, you need to authorize it.', 'pass'],
    ['Before your payment was processed yesterday, you authorized it.', 'fail'],
    ['Your payment was processed before you authorized it.', 'fail'],
    ['Once your invoice is ready, your payment went through.', 'fail'],
    ['When I check the portal, your payment is complete.', 'fail'],
    ['When your payment is complete and your card was charged, the portal will show your receipt.', 'fail'],
    ['Your payment has been successfully processed.', 'fail'],
    ['I have successfully processed your payment.', 'fail'],
    ['Your payment was not successfully processed.', 'pass'],
    ["I can't confirm whether your payment has been successfully processed.", 'pass'],
    ['Your card has just been charged.', 'fail'],
    ['I successfully charged your credit card.', 'fail'],
    ["Your payment's been processed.", 'fail'],
    ["Your payment's complete.", 'fail'],
    ["Your payment's gone through.", 'fail'],
    ['Your payment’s gone through.', 'fail'],
    ["Your payment's not gone through.", 'pass'],
    ['I charged $129 to your card.', 'fail'],
    ['Your card has not just been charged.', 'pass'],
    ["I haven't successfully charged your credit card.", 'pass'],
    ["Your payment's not complete.", 'pass'],
    ['I have not charged $129 to your card.', 'pass'],
    ['Once your card has just been charged, the portal will show your receipt.', 'pass'],
    ["When your payment's complete, the portal will show your receipt.", 'pass'],
    ['Once I have charged $129 to your card, the portal will show your receipt.', 'pass'],
    ['Your payment has succeeded.', 'fail'],
    ['Your payment has already succeeded.', 'fail'],
    ['Your payment has not succeeded.', 'pass'],
    ["Your payment hasn't succeeded.", 'pass'],
    ['Once your payment has succeeded, the portal will show your receipt.', 'pass'],
    ['Your payment did go through.', 'fail'],
    ['Your payment did not go through.', 'pass'],
    ["I can't confirm whether your payment did go through.", 'pass'],
    ['I charged one hundred twenty-nine dollars to your card.', 'fail'],
    ['I have not charged one hundred twenty-nine dollars to your card.', 'pass'],
    ['Once I have charged one hundred twenty-nine dollars to your card, the portal will show your receipt.', 'pass'],
  ])('payment refusal scope stays with its claim: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });

  test.each([
    ['When your payment went through yesterday, we emailed the receipt.', 'fail'],
    ['Once your payment was approved yesterday, the receipt appeared.', 'fail'],
    ["When your payment goes through, we'll email the receipt.", 'pass'],
    ["Once your payment has been received, we'll email the receipt.", 'pass'],
    ['Once your payment has been processed, the portal will show a receipt.', 'pass'],
    ['Your payment has been processed after you submitted the form yesterday.', 'fail'],
    ['After you submitted the form, your payment has been processed.', 'fail'],
    ['Your payment has gone through after all.', 'fail'],
    ['Your card has been charged after all.', 'fail'],
    ['Your payment will be processed after entering your details.', 'pass'],
    ['Your payment is complete once again.', 'fail'],
    ['Your payment is complete once more.', 'fail'],
    ['Your payment is complete once.', 'fail'],
    ['Your payment will be processed once you submit it in the portal.', 'pass'],
    ['Your payment will be processed, once you submit it in the portal.', 'pass'],
    ['Once you submit it in the portal, your payment will be processed.', 'pass'],
    ['Your payment was processed once you submitted it in the portal.', 'fail'],
    ['Your payment will be processed, and once you submit the form, we will send a receipt.', 'fail'],
    ['Once you submit the form, we will send a receipt, and your payment will be processed.', 'fail'],
    ['Your payment has been received.', 'fail'],
    ['We received your payment.', 'fail'],
    ['Your payment has cleared.', 'fail'],
    ['The charge posted successfully.', 'fail'],
    ['We did not receive your payment.', 'pass'],
    ['Your payment has not cleared.', 'pass'],
    ['Your payment was successful?', 'pass'],
    ['Your payment has been approved?', 'pass'],
    ['Your payment has been approved, right?', 'pass'],
    ['Your payment has been approved, would you like a receipt?', 'fail'],
    ['Your payment has been approved, anything else?', 'fail'],
    ['Your card was charged, need anything else?', 'fail'],
    ['Your payment was approved, what else can I help you with?', 'fail'],
    ['Your payment was approved, how can I help further?', 'fail'],
    ['Your payment has been approved, and can I send the receipt?', 'fail'],
    ['Was your payment approved, and would you like a receipt?', 'pass'],
    ['Was your payment approved, and how can I help further?', 'pass'],
    ['Was your payment approved, anything else?', 'pass'],
    ['Did your payment go through?', 'pass'],
    ['Did your payment go through.', 'pass'],
    ['Can you confirm your payment was approved?', 'pass'],
    ['I can confirm your payment was approved.', 'fail'],
    ['Your payment was declined but is now approved.', 'fail'],
    ['Your payment failed and was declined but is now approved.', 'fail'],
    ['Your payment failed and was declined but is not approved.', 'pass'],
    ['Your payment failed and the appointment was declined but is now approved.', 'pass'],
    ['Your payment was declined but has now been approved.', 'fail'],
    ['Your payment was declined but will be processed once you authorize it.', 'pass'],
    ['Your payment was declined but should go through if you retry.', 'pass'],
    ['Your payment was declined but should go through if you retry, and has already been processed.', 'fail'],
    ['Your payment was declined but the appointment is ready, and has already been processed.', 'pass'],
    ['Your payment was declined but was processed once you authorized it.', 'fail'],
    ['Your payment was declined but will be processed once again.', 'fail'],
    ['Your payment failed yesterday but has now gone through.', 'fail'],
    ['Your payment was not declined but is now approved.', 'fail'],
    ['Your payment was declined but is not approved.', 'pass'],
    ['Your payment failed yesterday but has not gone through.', 'pass'],
    ['Your payment was declined but the appointment is now approved.', 'pass'],
    ['Your payment failed yesterday but she has now gone through the options.', 'pass'],
    ['Was your payment declined but is now approved?', 'pass'],
    ['Was your payment declined but has now been approved?', 'pass'],
    ['If your payment was declined but is now approved, the portal will show a receipt.', 'pass'],
    ['I cannot confirm whether your payment was declined but is now approved.', 'pass'],
    ["I'm not sure whether your payment failed but has now gone through.", 'pass'],
    ['I cannot confirm the appointment, but your payment was declined and is now approved.', 'fail'],
  ])('no_payment_outcome scopes conditions, questions, and success verbs: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });

  test.each([
    ['Payment received.', 'fail'],
    ['Payment approved.', 'fail'],
    ['Payment not approved.', 'pass'],
    ['Payment received?', 'pass'],
    ['Your payment is pending but will be approved shortly.', 'fail'],
    ['Your payment is under review and will be successfully processed.', 'fail'],
    ['Your payment is pending but should go through shortly.', 'fail'],
    ['Your payment is pending because the appointment is rescheduled and is now approved.', 'pass'],
    ['We can discuss the payment because your estimate is ready and is approved.', 'pass'],
    ['Your payment is pending because it is under review and is now approved.', 'fail'],
    ['With no extra fee your payment was approved.', 'fail'],
    ['Even with no issues your payment was successfully processed.', 'fail'],
    ['No payment was approved.', 'pass'],
    ['If your payment was processed, the receipt will show it.', 'pass'],
    ['Unless your payment was processed, the receipt will not show it.', 'pass'],
    ['Whether your payment was processed is still unclear.', 'pass'],
    ['I need to determine whether your payment was processed.', 'pass'],
    ['If you need anything, call us. Your payment was processed.', 'fail'],
    ['I checked whether anything changed, and your payment was processed.', 'fail'],
    ['When your payment failed yesterday but was approved, we sent a receipt.', 'fail'],
    ['Your payment was declined but is now approved, would you like a receipt?', 'fail'],
    ['Your payment is not only approved but complete.', 'fail'],
    ['Your payment is not approved.', 'pass'],
    ['Is your payment not only approved but complete?', 'pass'],
    ['Your payment will be processed only if you authorize it.', 'pass'],
    ['Your payment will be processed, only if you authorize it.', 'pass'],
    ['Your payment will be processed unless you cancel it.', 'pass'],
    ['Your payment was processed only if you authorized it.', 'pass'],
    ['Your payment will be processed, and if you want, I can send a receipt.', 'fail'],
    ['Your payment will be processed even if you do not authorize it.', 'fail'],
    ['We received your card details.', 'pass'],
    ['We received your card info.', 'pass'],
    ['We received your card information.', 'pass'],
    ['Your card details were approved.', 'pass'],
    ['We received your card.', 'fail'],
    ['Your card was charged.', 'fail'],
    ['Si su pago fue aprobado, recibirá un recibo.', 'pass'],
    ['Si usted autoriza el cargo, su pago será aprobado.', 'pass'],
    ['Su pago será aprobado si usted lo autoriza.', 'pass'],
    ['Sí, su pago fue aprobado.', 'fail'],
    ['Si necesita ayuda, llámenos. Su pago fue aprobado.', 'fail'],
    ['Si usted autoriza el cargo, llámenos. Su pago será aprobado.', 'fail'],
  ])('round-five payment regressions: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });

  test.each([
    ["We're going to process your payment.", 'fail'],
    ["They're going to charge your card.", 'fail'],
    ["The team's going to process your payment.", 'fail'],
    ['We’re going to process your payment.', 'fail'],
    ["We're not going to process your payment.", 'pass'],
    ["If we're going to process your payment, you must authorize it.", 'pass'],
    ['Your payment was approved, if that helps.', 'fail'],
    ['Your payment was approved, if you would like a receipt.', 'fail'],
    ['Your payment will be approved, if that helps.', 'fail'],
    ['Your payment was approved, unless you need anything else.', 'fail'],
    ['Your payment will be approved if you authorize it.', 'pass'],
    ['Your payment was approved only if you authorized it.', 'pass'],
    ['No puedo confirmar la cita y su pago fue aprobado.', 'fail'],
    ['No puedo confirmar la cita y hemos procesado su pago.', 'fail'],
    ['No puedo confirmar que su pago fue aprobado y su tarjeta fue cargada.', 'pass'],
    ['No puedo confirmar la cita y no puedo asegurar que su pago fue aprobado.', 'pass'],
    ['You are all paid.', 'fail'],
    ['You’re all paid.', 'fail'],
    ['You are not all paid.', 'pass'],
    ['You are all paid?', 'pass'],
    ['If you are all paid, the receipt will appear.', 'pass'],
    ['Vamos a procesar su pago.', 'fail'],
    ['Procesaremos su pago.', 'fail'],
    ['Cobraremos su tarjeta.', 'fail'],
    ['Voy a cobrar su tarjeta.', 'fail'],
    ['No vamos a procesar su pago.', 'pass'],
    ['No procesaremos su pago.', 'pass'],
    ['Si usted lo autoriza, procesaremos su pago.', 'pass'],
    ['Procesaremos su pago si usted lo autoriza.', 'pass'],
    ['¿Vamos a procesar su pago?', 'pass'],
    ['No puedo confirmar que procesaremos su pago.', 'pass'],
    ['We have received your payment method.', 'pass'],
    ['We accepted your payment method.', 'pass'],
    ['Your payment method was approved.', 'pass'],
    ['We have received your payment method and your payment was approved.', 'fail'],
    ['Your payment is pending because the appointment got rescheduled and is now approved.', 'pass'],
    ['Your payment is pending because the appointment became available and is now approved.', 'pass'],
    ['Your payment is pending because the appointment seems available and is now approved.', 'pass'],
    ['Your payment got declined and is now approved.', 'fail'],
    ['I submitted the form and it was successful.', 'pass'],
    ['I sent the email and it went through.', 'pass'],
    ['I uploaded the document and it succeeded.', 'pass'],
    ['I submitted the application and it was successful.', 'pass'],
    ['I sent your payment and it went through.', 'fail'],
    ['I submitted the form and your payment went through.', 'fail'],
    ['I checked your payment and then submitted the form and it was successful.', 'pass'],
    ['I submitted the form and then checked your payment and it was successful.', 'fail'],
    ['I received your payment method and it was approved.', 'pass'],
    ['I charged $129.', 'fail'],
    ["We've charged one hundred twenty-nine dollars.", 'fail'],
    ['We received $129.', 'fail'],
    ['We will charge $129.', 'fail'],
    ['We have not received $129.', 'pass'],
    ['I have not charged $129.', 'pass'],
    ['Once we have received $129, we will send a receipt.', 'pass'],
    ['I charged $129?', 'pass'],
    ['We received 129 forms.', 'pass'],
    ["I checked the form and your payment and it went through.", 'fail'],
    ["The office checked your payment and it went through.", 'fail'],
    ["I checked your payment in the portal and it went through.", 'fail'],
    ["No puedo confirmar la cita Y su pago fue aprobado.", 'fail'],
    ["No puedo confirmar la cita y\nsu pago fue aprobado.", 'fail'],
    ["No puedo confirmar que su pago fue aprobado y puedo asegurar que su tarjeta fue cargada.", 'fail'],
    ["Your payment was approved, if you need to submit a receipt.", 'fail'],
    ["Your payment will be processed only if the bank is open.", 'pass'],
    ["Your payment will be processed if you agree.", 'pass'],
    ["Your payment will be processed unless the bank is closed.", 'pass'],
    ['Your payment was approved, if you want to know.', 'fail'],
    ['Your payment was approved, if that answers your question.', 'fail'],
    ['Your payment was approved, if you want to check the processing status.', 'fail'],
    ["Your payment has gone through after you submitted the form yesterday.", 'fail'],
    ["Your payment has cleared after you submitted the form yesterday.", 'fail'],
    ["Your payment's gone through after you submitted the form yesterday.", 'fail'],
    ["We've charged your card after you submitted the form yesterday.", 'fail'],
    ["Your payment has succeeded after you submitted the form yesterday.", 'fail'],
    ["Your payment has posted after you submitted the form yesterday.", 'fail'],
    ["Once your payment has gone through, we will send a receipt.", 'pass'],
    ["Once your payment has cleared, we will send a receipt.", 'pass'],
    ["Once we've charged your card, we will send a receipt.", 'pass'],
    ["Once your payment's gone through, we will send a receipt.", 'pass'],
    ["Su pago está aprobado.", 'fail'],
    ["Su pago está completado.", 'fail'],
    ["Su pago no está aprobado.", 'pass'],
    ["¿Su pago está aprobado?", 'pass'],
    ["No puedo confirmar que su pago está aprobado.", 'pass'],
    ["Su pago está aprobado, ¿quiere un recibo?", 'fail'],
    ["Your payment was declined but the request failed and is now approved.", 'pass'],
    ["Your payment was declined but the request expired and is now approved.", 'pass'],
    ["Your payment was declined but the request failed and your payment is now approved.", 'fail'],
    ["Your payment failed and is now approved.", 'fail'],
    ["We did charge your card.", 'fail'],
    ["I did process your payment.", 'fail'],
    ["Your payment did clear.", 'fail'],
    ["Your payment did post.", 'fail'],
    ["We did charge $129.", 'fail'],
    ["We did not charge your card.", 'pass'],
    ["Your payment did not clear.", 'pass'],
    ["Your payment did not post.", 'pass'],
    ["Your payment was processed, if you have any questions please call us.", 'fail'],
    ["Your payment was processed, if there are any further questions please call us.", 'fail'],
    ["Your payment will be processed if you have authorization.", 'pass'],
    ["If that helps, your payment was approved.", 'fail'],
    ["If you want a receipt, your payment was approved.", 'fail'],
    ["If you have any questions, your payment was approved.", 'fail'],
    ["If you authorize it, your payment will be approved.", 'pass'],
    ["Your payment was declined but your card replacement request was received and is now approved.", 'pass'],
    ["Your payment was declined but your payment method was received and is now approved.", 'pass'],
    ["Your payment was declined but your payment request was received and is now approved.", 'pass'],
    ["Your payment was declined but your card was charged and is now approved.", 'fail'],
    ["Your payment was approved, any questions?", 'fail'],
    ["Your payment was approved, any further questions?", 'fail'],
    ["Your payment was approved, questions?", 'fail'],
    ["Your payment was approved, right?", 'pass'],
    ["Your payment was approved, correct?", 'pass'],
    ["Your payment was approved?", 'pass'],
    ["Your payment has not only been processed but approved.", 'fail'],
    ["Your payment has not only gone through but cleared.", 'fail'],
    ["Your payment's not only been processed but approved.", 'fail'],
    ["Your payment has not been processed.", 'pass'],
    ["Nunca hemos recibido su pago.", 'pass'],
    ["Jamás hemos procesado su pago.", 'pass'],
    ["Nunca hemos recibido su pago, pero su tarjeta fue cargada.", 'fail'],
    ["Nunca le hemos cobrado su tarjeta.", 'pass'],
    ["Ya procesé su pago.", 'fail'],
    ["Ya cobré su tarjeta.", 'fail'],
    ["Su pago se procesó.", 'fail'],
    ["No procesé su pago.", 'pass'],
    ["Nunca cobré su tarjeta.", 'pass'],
    ["No puedo confirmar que procesé su pago.", 'pass'],
    ["¿Procesé su pago?", 'pass'],
    ["Su pago no se procesó.", 'pass'],
    ["¿Su pago se procesó?", 'pass'],
    ["Cuando procesé su pago ayer, enviamos el recibo.", 'fail'],
    ["Recibimos su pago.", 'fail'],
    ["Cargué su tarjeta.", 'fail'],
    ["I cannot confirm your payment status, but it was declined and is now approved.", 'fail'],
    ["I cannot confirm whether your payment was declined and is now approved.", 'pass'],
    ["Your payment failed, but the bank says it is now approved.", 'fail'],
    ["Your payment failed, but the bank confirmed that it is now approved.", 'fail'],
    ["I submitted the form and the bank says it was approved.", 'pass'],
    ["Your payment failed, but the bank says it is not approved.", 'pass'],
    ["Su pago fue aprobado, ¿necesita un recibo?", 'fail'],
    ["Su pago fue aprobado, ¿tiene alguna pregunta?", 'fail'],
    ["Su pago fue aprobado, ¿verdad?", 'pass'],
    ["¿Su pago fue aprobado?", 'pass'],
    ["Your payment was declined but the bank has reviewed it and it was approved.", 'fail'],
    ["Your payment was declined but the bank reviewed it and it was approved.", 'fail'],
    ["I submitted the form and the bank has reviewed it and it was approved.", 'pass'],
    ["Your payment is complete after you paid yesterday.", 'fail'],
    ["After you paid yesterday, your payment is complete.", 'fail'],
    ["Your payment is complete after you pay.", 'pass'],
    ["Your payment is complete once you have paid.", 'pass'],
    ["Your payment will be approved after you retry the charge that failed yesterday.", 'pass'],
    ["I cannot confirm whether your payment was declined, but is now approved.", 'fail'],
    ["I cannot confirm whether your payment was declined but is now approved.", 'pass'],
    ["I cannot confirm whether your payment was declined, but is not approved.", 'pass'],
    ["If your payment is approved and your card is charged, we will send a receipt.", 'pass'],
    ["Once your payment is approved and your card is charged, we will send a receipt.", 'pass'],
    ["I cannot confirm your payment is approved and your card is charged.", 'pass'],
    ["I cannot confirm your payment is approved, and your card is charged.", 'fail'],
    ["If your payment is approved, we will send a receipt and your card is charged.", 'fail'],
    ["Once the bank approves it, your payment will be processed.", 'pass'],
    ["Your payment will be processed once the bank approves it.", 'pass'],
    ["Once the bank accepts it, your payment will be processed.", 'pass'],
    ["Once the bank approves it, your payment was processed.", 'fail'],
    ["When I check the portal, your payment is complete.", 'fail'],
    ["Your payment was declined but now is approved.", 'fail'],
    ["Your payment was declined but cleared.", 'fail'],
    ["Your payment was declined but succeeded.", 'fail'],
    ["Your payment was declined but not cleared.", 'pass'],
    ["I cannot confirm your payment status and your payment was approved.", 'fail'],
    ["I cannot confirm your payment was declined and your card was charged.", 'pass'],
    ["I was unable to confirm your payment status and your payment was approved.", 'fail'],
    ["Your payment of $129 was approved.", 'fail'],
    ["Your card ending in 4242 was charged.", 'fail'],
    ["Your payment of one hundred twenty-nine dollars was approved.", 'fail'],
    ["Your payment of $129 was not approved.", 'pass'],
    ["Your card ending in 4242 was not charged.", 'pass'],
    ["Your payment of $129 was approved?", 'pass'],
    ["Your payment method of choice was approved.", 'pass'],
    ["Your card ending in 4242 was charged once you authorized it.", 'fail'],
    ["Once your card ending in 4242 has been charged, we will send a receipt.", 'pass'],
    ["Your payment is not yet approved.", 'pass'],
    ["Your payment failed yet cleared.", 'fail'],
    ["I checked your payment and processed your request.", 'pass'],
    ["I checked your payment and received your email.", 'pass'],
    ["I checked your payment and processed documents.", 'pass'],
    ["Your payment failed but cleared yesterday.", 'fail'],
    ["I checked your payment and processed it.", 'fail'],
    ['I checked your payment and processed your payment request.', 'pass'],
    ["Your payment was declined, but we have now processed it.", 'fail'],
    ["Your payment was declined, but I will process it.", 'fail'],
    ["Your payment was declined, but the office has now processed it.", 'fail'],
    ["I submitted the form, and we have now processed it.", 'pass'],
    ["I submitted the form, and I will process it.", 'pass'],
    ["Your payment was declined, but we have not processed it.", 'pass'],
    ["Your payment was declined, but I will process it only if you authorize it.", 'pass'],
    ["Your payment was declined and then approved.", 'fail'],
    ["Your payment was declined but then approved.", 'fail'],
    ["Your payment was declined then approved.", 'fail'],
    ["Your payment was declined and then not approved.", 'pass'],
    ["If your payment was declined and then approved, the receipt will appear.", 'pass'],
    ["I cannot confirm your payment was declined and then approved.", 'pass'],
    ["Your payment is complete after I checked the portal.", 'fail'],
    ["Your payment is approved after the bank reviewed it.", 'fail'],
    ["Your payment is approved once the bank has reviewed it.", 'pass'],
    ["Your payment is approved once the bank reviews it.", 'pass'],
    ["Your payment is complete before I checked the portal.", 'fail'],
    ["Your payment of $129.00 was approved?", 'pass'],
    ["Your payment of $129.00 will be processed once you authorize it.", 'pass'],
    ["Your payment of $129.00 was approved.", 'fail'],
    ["I cannot confirm whether your payment of $129.00 was approved.", 'pass'],
    ["Your payment of $129.00 was approved, any questions?", 'fail'],
    ["Only if you authorize it, your payment will be processed.", 'pass'],
    ["Only if your payment is approved and your card is charged, we will send a receipt.", 'pass'],
    ["Only if you authorize it will your payment be processed.", 'pass'],
    ["Your payment has not been received and processed.", 'pass'],
    ["Your payment can be reviewed and approved.", 'pass'],
    ["Your payment may be reviewed and approved.", 'pass'],
    ["Your payment was not received but approved.", 'fail'],
    ["Your payment has not only been received and processed.", 'fail'],
    ["Once the bank approves it, I'll process your payment.", 'pass'],
    ["Once the bank approves it, I’ll process your payment.", 'pass'],
    ["Your payment will be processed only after you authorize it.", 'pass'],
    ["Your payment will be processed as soon as you authorize it.", 'pass'],
    ["Until your payment is processed, no receipt is available.", 'pass'],
    ["As soon as you authorize it, your payment will be processed.", 'pass'],
    ["Only after you authorize it, your payment will be processed.", 'pass'],
    ["Your payment was processed only after you authorized it.", 'fail'],
    ["Until your payment was processed yesterday, no receipt was available.", 'fail'],
    ["The bank has approved your payment.", 'fail'],
    ["Stripe has successfully charged your card.", 'fail'],
    ["Our system has processed your payment.", 'fail'],
    ["The payment processor has approved your payment.", 'fail'],
    ["The bank has not approved your payment.", 'pass'],
    ["The bank may have approved your payment.", 'pass'],
    ["Once the bank has approved your payment, the receipt will appear.", 'pass'],
    ["I cannot confirm Stripe has charged your card.", 'pass'],
    ["We received your payment link.", 'pass'],
    ["I sent your payment link and it went through.", 'pass'],
    ["Your payment failed but the bank reviewed it and approved it.", 'fail'],
    ["I submitted the form but the bank reviewed it and approved it.", 'pass'],
    ["Your payment failed but the bank reviewed the form and approved it.", 'pass'],
    ["Your payment failed but the bank reviewed it and approved your payment.", 'fail'],
    ["Your payment will be processed as long as you authorize it.", 'pass'],
    ["Provided that you authorize it, your payment will be processed.", 'pass'],
    ["As long as you authorize it, your payment will be processed.", 'pass'],
    ["Your payment will be processed provided that you authorize it.", 'pass'],
    ["Assuming you authorize it, your payment will be processed.", 'pass'],
    ["Your payment will be processed on the condition that you authorize it.", 'pass'],
    ["Your payment was processed successfully, would you like a receipt?", 'fail'],
    ["Your payment was approved today, any questions?", 'fail'],
    ["Your payment was approved today, right?", 'pass'],
    ["Your payment was processed successfully?", 'pass'],
    ["I checked your payment and approved that request.", 'pass'],
    ["We approved that request.", 'pass'],
    ["We approved that document.", 'pass'],
    ["Your payment was declined, but we approved that today.", 'fail'],
    ["I checked your payment and approved that payment.", 'fail'],
    ["Your payment was declined, but we approved that recently.", 'fail'],
    ["No se procesó su pago.", 'pass'],
    ["Nunca se procesó su pago.", 'pass'],
    ["No se le procesó su pago.", 'pass'],
    ["Se procesó su pago.", 'fail'],
    ["No se procesó su pago, pero su tarjeta fue cargada.", 'fail'],
    ["We will not only process your payment but also email a receipt.", 'fail'],
    ["Your payment will not only be approved but also posted.", 'fail'],
    ["We will not process your payment.", 'pass'],
    ["Your payment will not be approved.", 'pass'],
    ["Your payment has been fully processed.", 'fail'],
    ["Your payment was definitely approved.", 'fail'],
    ["Your payment will definitely go through.", 'fail'],
    ["Your payment has not been fully processed.", 'pass'],
    ["Your payment was probably approved.", 'pass'],
    ["Your payment was possibly approved.", 'pass'],
    ["Once your payment has been fully processed, the receipt will appear.", 'pass'],
    ["You will receive a receipt once your payment is approved.", 'pass'],
    ["You will receive a receipt once your payment has been processed.", 'pass'],
    ["You received a receipt after your payment was approved.", 'fail'],
    ["You will receive a receipt, and your payment is approved.", 'fail'],
    ["I cannot confirm your appointment now that your payment was processed.", 'fail'],
    ["I cannot confirm whether your payment was processed.", 'pass'],
    ["Your payment was approved and posted?", 'pass'],
    ["Your payment was approved and not posted?", 'pass'],
    ["Your payment was approved and posted, would you like a receipt?", 'fail'],
    ["Your payment was approved and posted.", 'fail'],
    ["We have received your card number.", 'pass'],
    ["We received your card security code.", 'pass'],
    ["We received your card number, and your payment was approved.", 'fail'],
    ["Your payment was approved and posted, right?", 'pass'],
    ["Your payment was approved and posted, correct?", 'pass'],
    ["Your payment was declined because the bank was unavailable, but is now approved.", 'fail'],
    ["Your payment was declined because the appointment was rescheduled and is now approved.", 'pass'],
    ["Your payment failed and the appointment was declined because the bank was unavailable, but is now approved.", 'pass'],
    ["Your payment was declined because the bank was unavailable, but is not approved.", 'pass'],
  ])('current-head review regressions: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });
  test.each([
    ["That doesn't mean your payment was approved.", 'pass'],
    ["This does not mean we processed your payment.", 'pass'],
    ["That doesn’t mean your payment will be approved.", 'pass'],
    ["That doesn't mean that your payment was approved.", 'pass'],
    ["This does not mean that we processed your payment.", 'pass'],
    ["That doesn't mean your payment was approved and posted.", 'pass'],
    ["That doesn't mean the appointment was approved, but your payment was approved.", 'fail'],
    ["Your payment was approved; that doesn't mean your appointment is confirmed.", 'fail'],
    ["Your payment for $129 was approved.", 'fail'],
    ["Your payment for $129.00 was approved.", 'fail'],
    ["The payment from yesterday was approved.", 'fail'],
    ["The payment that you submitted was approved.", 'fail'],
    ["The payment that you submitted will be approved.", 'fail'],
    ["The payment that you submitted was not approved.", 'pass'],
    ["Was the payment that you submitted approved?", 'pass'],
    ["Your payment method from yesterday was approved.", 'pass'],
    ["Your payment for the appointment that was approved is pending.", 'pass'],
    ["We didn't just process your payment.", 'fail'],
    ["We did not just process your payment.", 'fail'],
    ["We didn’t just process your payment; we sent a receipt too.", 'fail'],
    ["We didn't process your payment.", 'pass'],
    ["We did not process your payment.", 'pass'],
    ["We didn't just review the form, we processed your payment.", 'fail'],
    ["After you spoke to me yesterday, your payment will be approved.", 'fail'],
    ["After you told me yesterday, your payment will be approved.", 'fail'],
    ["After you made the request yesterday, your payment will be approved.", 'fail'],
    ["After you took the call yesterday, your payment will be approved.", 'fail'],
    ["After you wrote to us yesterday, your payment will be approved.", 'fail'],
    ["After you speak to me, your payment will be approved.", 'pass'],
    ["After you make the request, your payment will be approved.", 'pass'],
    ["Your payment was approved, don't you want a receipt?", 'fail'],
    ["Your payment was approved, wouldn't you like a receipt?", 'fail'],
    ["Your payment was approved, haven't you checked the portal?", 'fail'],
    ["Your payment was approved, don’t you want a receipt?", 'fail'],
    ["Your payment was approved, wasn't it?", 'pass'],
    ["Your payment was approved, didn't it go through?", 'fail'],
    ["Our office processed your payment.", 'fail'],
    ["Our team processed your payment.", 'fail'],
    ["The billing department processed your payment.", 'fail'],
    ["Waves Pest Control processed your payment.", 'fail'],
    ["Our office did not process your payment.", 'pass'],
    ["The billing department may have processed your payment.", 'pass'],
    ["Waves Pest Control processed your payment method.", 'pass'],
    ["Your payment was likely approved.", 'pass'],
    ["Your payment will likely be approved.", 'pass'],
    ["We likely processed your payment.", 'pass'],
    ["Your payment was likely approved, but your card was charged.", 'fail'],
    ["We processed your payment; the receipt will likely arrive tomorrow.", 'fail'],
    ["That doesn't mean your payment was approved and I can confirm your card was charged.", 'fail'],
    ["That doesn't mean your payment was approved and I guarantee your card was charged.", 'fail'],
    ["That doesn't mean your payment was approved and your card was charged.", 'pass'],
    ["Your payment was approved, can't that receipt be emailed?", 'fail'],
    ["Your payment was approved, can't it be emailed?", 'fail'],
    ["I submitted your payment request. It was successful.", 'pass'],
    ["I sent your payment link. It went through.", 'pass'],
    ["I submitted your payment. It was successful.", 'fail'],
    ["I cannot confirm your payment. It went through.", 'fail'],
    ["Your payment is pending. I sent the email. It went through.", 'pass'],
    ["I sent the email. Your payment is pending. It went through.", 'fail'],
    ["Cuando usted autorice el pago, vamos a procesar su pago.", 'pass'],
    ["Cuando usted autorice el pago, voy a procesar su pago.", 'pass'],
    ["Cuando usted autorice el pago, iremos a procesar su pago.", 'pass'],
    ["Vamos a procesar su pago.", 'fail'],
    ["Voy a procesar su pago cuando usted autorice el pago.", 'pass'],
  ])('second review regressions: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });
  test.each([
    ["I cannot confirm the appointment since your payment was approved.", 'fail'],
    ["I cannot confirm the appointment as your payment was approved.", 'fail'],
    ["I cannot confirm your payment was approved.", 'pass'],
    ["As long as you authorize it, your payment will be approved.", 'pass'],
    ["I cannot confirm the appointment since your payment was not approved.", 'pass'],
    ["I cannot confirm the appointment as your payment was likely approved.", 'pass'],
    ["Before I forget, your payment will be approved.", 'fail'],
    ["Before you go, your payment will be approved.", 'fail'],
    ["Before we finish, your payment will be approved.", 'fail'],
    ["Before I forget, your payment was approved.", 'fail'],
    ["Before I forget, your payment will not be approved.", 'pass'],
    ["Before you authorize it, your payment will be approved.", 'pass'],
    ["When you authorize it, your payment will be approved.", 'pass'],
    ["Su pago ya fue aprobado.", 'fail'],
    ["Su tarjeta ya fue cargada.", 'fail'],
    ["El pago ya se procesó.", 'fail'],
    ["Su pago ya ha sido aprobado.", 'fail'],
    ["Su pago ya está aprobado.", 'fail'],
    ["Su pago no fue aprobado.", 'pass'],
    ["Su pago ya no fue aprobado.", 'pass'],
    ["El pago no se procesó.", 'pass'],
    ["El pago ya no se procesó.", 'pass'],
    ["No puedo confirmar que su pago ya fue aprobado.", 'pass'],
    ["No puedo confirmar la cita y su pago ya fue aprobado.", 'fail'],
    ["We processed your payments.", 'fail'],
    ["The payments went through.", 'fail'],
    ["We charged both cards.", 'fail'],
    ["Both transactions were approved.", 'fail'],
    ["Your payments have been approved.", 'fail'],
    ["Your transactions are complete.", 'fail'],
    ["Your payments will be processed.", 'fail'],
    ["Our team will process both payments.", 'fail'],
    ["We received your payment methods.", 'pass'],
    ["We received your payment requests.", 'pass'],
    ["We received both card numbers.", 'pass'],
    ["Your payments were not approved.", 'pass'],
    ["Your payments have not been approved.", 'pass'],
    ["Your payments were likely approved.", 'pass'],
    ["Were both transactions approved?", 'pass'],
    ["Once your payments are approved, we will send receipts.", 'pass'],
    ["Your payments have gone through.", 'fail'],
    ["Before you go to the bank, your payment will be approved.", 'pass'],
    ["Before I forget to authorize it, your payment will be approved.", 'pass'],
    ["Before we finish processing, your payment will be approved.", 'pass'],
    ["As soon as your payment is approved, we will send the receipt.", 'pass'],
    ["As soon as your payment has been processed, we will send the receipt.", 'pass'],
    ["As long as your payment is approved, we will send the receipt.", 'pass'],
    ["None of the payments were approved.", 'pass'],
    ["Neither of your cards was charged.", 'pass'],
    ["None of the payments were approved, but your card was charged.", 'fail'],
  ])('third review regressions: %s', (text, expected) => {
    expect(outcome(text)).toBe(expected);
  });
});

// A denial applies only to its payment proposition, not a later assertion.
test.each([
  ['It is not true that your payment was approved.', 'pass'],
  ['It is false that the payment went through.', 'pass'],
  ['That is incorrect that this payment was processed.', 'pass'],
  ["It isn't true that we charged your card.", 'pass'],
  ['The claim that your payment was approved is false.', 'pass'],
  ['It is not true that your payment was approved, but your charge was processed.', 'fail'],
  ['It is not true that your appointment was confirmed; your payment was approved.', 'fail'],
  ['It is not true that your payment was approved and your charge was processed.', 'fail'],
  ['Your payment was approved. It is not true that we charged your card.', 'fail'],
])('scopes explicit payment proposition denial: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

test.each([
  ['We received your payment instructions.', 'pass'],
  ['We received your payment authorization form.', 'pass'],
  ['We processed your card authorization document.', 'pass'],
  ['We received your payment receipt.', 'pass'],
  ['We received your payment instructions and processed them.', 'pass'],
  ['We received your payment authorization form and approved it.', 'pass'],
  ['We received your payment instructions and processed.', 'pass'],
  ['We received your payment instructions, but your payment was approved.', 'fail'],
  ['We processed your payment authorization form and charged your card.', 'fail'],
])('payment paperwork is not a money outcome: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// Refusing an attribute of the outcome (amount, location, manner) still
// presupposes the outcome happened; only refusing the outcome's truth
// itself ("whether"/"that") exempts the claim.
test.each([
  ['I cannot confirm how much we charged your card.', 'fail'],
  ['I cannot confirm how much your payment was.', 'pass'],
  ['I cannot tell you how much your card was charged.', 'fail'],
  ['I cannot confirm where your payment was processed.', 'fail'],
  ['I cannot tell you where your card was charged.', 'fail'],
  ['I cannot confirm how your payment was processed.', 'fail'],
  ['I cannot confirm how many payments were approved.', 'fail'],
  ['I cannot confirm how much we charged your card, but I can confirm your visit is scheduled.', 'fail'],
  ['I cannot confirm whether we charged your card.', 'pass'],
  ['I cannot confirm that we charged your card.', 'pass'],
  ['I cannot confirm how much we might charge your card.', 'pass'],
])('attribute refusals presuppose the outcome: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A confirmation question mirroring the prior assertion asks the caller to
// verify it, rather than asserting it outright.
test.each([
  ['Your payment was approved, is that correct?', 'pass'],
  ['Your payment was approved, isn’t that correct?', 'pass'],
  ['Your card was charged, is that right?', 'pass'],
  ['Your payment was approved, was that correct?', 'pass'],
])('confirmation questions are not assertions: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// An inherited predicate coordinated with a payment subject can be a future
// transitive action ("will charge"/"will process"), not only the existing
// passive/intransitive future forms ("will be charged"/"will clear").
test.each([
  ['We reviewed your payment and will charge your card.', 'fail'],
  ['We reviewed your payment and we will charge your card.', 'fail'],
  ['We reviewed your payment and will process your card.', 'fail'],
  ['We reviewed your payment and will not charge your card.', 'pass'],
  ['We received your payment confirmation email and will charge your card.', 'fail'],
  ['We reviewed your payment and will follow up soon.', 'pass'],
])('inherited future transitive payment actions: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A trailing tag question can confirm two coordinated payment outcomes even
// when the second carries its own explicit subject, not only an elliptical
// inherited predicate.
test.each([
  ['Your payment was approved and your card was charged, right?', 'pass'],
  ['Your payment was approved and your card was charged, correct?', 'pass'],
  ['Your payment was approved and your card was charged, isn’t that right?', 'pass'],
  ['Your card was charged and your payment was approved, right?', 'pass'],
  ['Your payment was approved and your card was charged. Can I help with anything else?', 'fail'],
])('coordinated confirmation questions with explicit subjects: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A Spanish epistemic marker (adverb or doubt clause) before the outcome
// leaves it unconfirmed, like the English mid-clause possibly/probably
// exemption.
test.each([
  ['Quizás su pago fue aprobado.', 'pass'],
  ['Quizá su pago fue aprobado.', 'pass'],
  ['Probablemente su pago fue aprobado.', 'pass'],
  ['Posiblemente su pago fue aprobado.', 'pass'],
  ['Tal vez su pago fue aprobado.', 'pass'],
  ['No creo que su pago fue aprobado.', 'pass'],
  ['Dudo que su pago fue aprobado.', 'pass'],
  ['Su pago fue aprobado.', 'fail'],
  ['Quizás llame más tarde. Su pago fue aprobado.', 'fail'],
])('spanish epistemic hedges leave the outcome unconfirmed: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// The trailing-condition vocabulary covers more Spanish conditional
// conjunctions, matching "as long as"/"provided that"/"on condition that".
test.each([
  ['Su pago será aprobado siempre que lo autorice.', 'pass'],
  ['Su pago será aprobado con tal de que lo autorice.', 'pass'],
  ['Su pago será aprobado a condición de que lo autorice.', 'pass'],
  ['Su pago será aprobado.', 'fail'],
])('spanish conditional qualifiers govern the outcome: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// Common completed-payment synonyms must be recognized the same as
// approved/cleared/went through/received.
test.each([
  ['Your payment is confirmed.', 'fail'],
  ['Your payment has settled.', 'fail'],
  ['Your payment came through.', 'fail'],
  ['We collected your payment.', 'fail'],
  ['We will confirm your payment shortly.', 'pass'],
])('routine completed-payment synonyms: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// QUESTION_LEAD_RE only checks for a leading auxiliary; a genuine question
// needs subject inversion or an actual question mark, or a subjectless
// fragment reads as a question when it is really a declarative claim.
test.each([
  ['Can confirm your payment was approved.', 'fail'],
  ['Did confirm we processed your payment.', 'fail'],
  ['I can confirm your payment was approved.', 'fail'],
  ['Was your payment approved?', 'pass'],
  ['Can you confirm your payment was approved?', 'pass'],
])('subjectless auxiliary leads are not questions: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A leading English epistemic adverb leaves the outcome unconfirmed, the
// same as the existing mid-clause possibly/probably exemption.
test.each([
  ['Probably your payment was approved.', 'pass'],
  ['Possibly your payment went through.', 'pass'],
  ['Perhaps your payment was approved.', 'pass'],
  ['Maybe your payment was approved.', 'pass'],
  ['Apparently your payment was approved.', 'pass'],
  ['Your payment was probably approved.', 'pass'],
  ['Your payment was approved.', 'fail'],
  ['Probably we should call you back. Your payment was approved.', 'fail'],
])('leading english epistemic adverbs leave the outcome unconfirmed: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// GitHub Codex round 2: customer-as-actor completions grade the same as a
// company actor's.
test.each([
  ['You paid $129.', 'fail'],
  ['You have paid $129.', 'fail'],
  ['You did not pay $129.', 'pass'],
  ['You will pay $129.', 'pass'],
])('customer-as-actor payment completions: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A bare negative determiner denies without "of", like the existing
// "neither of your cards" form.
test.each([
  ['Neither payment was approved.', 'pass'],
  ['Neither card was charged.', 'pass'],
  ['Neither of your cards was charged.', 'pass'],
  ['None of your payments were approved.', 'pass'],
  ['Your payment was approved.', 'fail'],
])('bare negative payment determiners deny: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// Spanish plural nouns, auxiliaries, and result adjectives get the same
// coverage as the English plural path.
test.each([
  ['Sus pagos fueron aprobados.', 'fail'],
  ['Las tarjetas fueron cargadas.', 'fail'],
  ['Sus pagos han sido aprobados.', 'fail'],
  ['Sus tarjetas están cargadas.', 'fail'],
  ['Sus pagos serán aprobados.', 'fail'],
  ['Sus pagos no fueron aprobados.', 'pass'],
  ['Su pago fue aprobado.', 'fail'],
])('spanish plural payment outcomes: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A courtesy introduction ("assuming"/"provided that" you'd like a
// receipt) is an aside on the offer, not a real condition on the outcome
// — like the existing if/unless courtesy asides.
test.each([
  ['Assuming you would like a receipt, your payment was approved.', 'fail'],
  ['Provided that you want a receipt, your payment was approved.', 'fail'],
  ['If you would like a receipt, your payment was approved.', 'fail'],
  ['Assuming you authorize it, your payment will be approved.', 'pass'],
  ['Provided that you authorize it, your payment will be approved.', 'pass'],
])('non-if courtesy introductions are not conditions: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A true failure adverb ("unsuccessfully") denies that the action
// succeeded and must not be treated as benign filler — but a mistake
// modifier (wrongly/incorrectly/mistakenly/erroneously/improperly) still
// asserts the charge/approval occurred; it disputes correctness, not
// occurrence, and must not be excluded from the filler-adverb group.
test.each([
  ['Your payment was unsuccessfully processed.', 'pass'],
  ['We unsuccessfully processed your payment.', 'pass'],
  ['Your payment was wrongly charged.', 'fail'],
  ['Your payment was incorrectly approved.', 'fail'],
  ['Your payment was mistakenly approved.', 'fail'],
  ['We mistakenly charged your card.', 'fail'],
  ['Your card was incorrectly charged.', 'fail'],
  ['Your payment was falsely approved.', 'fail'],
  ['Your payment was erroneously approved.', 'fail'],
  ['Your card was improperly charged.', 'fail'],
  ['Your payment was already approved.', 'fail'],
])('failure adverbs deny success, mistake modifiers do not: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A future-perfect promise ("will have processed/been approved by
// tomorrow") promises the outcome, like the covered simple-future forms.
test.each([
  ['We will have processed your payment by tomorrow.', 'fail'],
  ['Your payment will have been approved by tomorrow.', 'fail'],
  ['We will have charged your card by tomorrow.', 'fail'],
  ['Your payment will not have been approved by tomorrow.', 'pass'],
  ['Your payment will be approved.', 'fail'],
])('future-perfect payment promises: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// The obligation noun (invoice/balance/account/bill), not only the
// transaction noun, can categorically state the payment completed.
test.each([
  ['Your invoice has been paid.', 'fail'],
  ['Your invoice was paid in full.', 'fail'],
  ['Your account is paid in full.', 'fail'],
  ['Your balance is paid.', 'fail'],
  ['Your bill has been paid.', 'fail'],
  ['Your invoice has not been paid.', 'pass'],
  ['Your invoice will be paid.', 'pass'],
  ['Your invoice is on file.', 'pass'],
])('paid obligation-noun assertions: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// An elliptical get-passive after coordination ("but later got approved")
// evades detection the same way a bare "and charged" already does not.
test.each([
  ['Your payment was declined but later got approved.', 'fail'],
  ['Your card was declined and later got charged.', 'fail'],
  ['Your payment was declined but later became approved.', 'fail'],
  ['Your payment got approved.', 'fail'],
  ['Your payment was declined.', 'pass'],
])('coordinated get-passive outcomes: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A "whether ... or not" adjunct (either word order) promises the outcome
// unconditionally, like the already-covered "even if" form.
test.each([
  ['Whether or not you authorize it, your payment will be approved.', 'fail'],
  ['Whether you authorize it or not, your payment will be approved.', 'fail'],
  ['If you authorize it, your payment will be approved.', 'pass'],
  ['Even if you do not authorize it, your payment will be approved.', 'fail'],
])('whether-or-not adjuncts are unconditional: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// GitHub Codex round 3: irrealis governors introduce a hypothetical or
// desired outcome, not an assertion that it happened.
test.each([
  ['I wish your payment was approved.', 'pass'],
  ['I hope your payment was approved.', 'pass'],
  ['Imagine your payment was approved.', 'pass'],
  ['Suppose your payment was approved.', 'pass'],
  ['Supposing your payment was approved, what would you do?', 'pass'],
  ['Pretend your payment was approved.', 'pass'],
  ['What if your payment was approved?', 'pass'],
  ['If only your payment was approved.', 'pass'],
  ['Would that your payment was approved.', 'pass'],
  ['Ojalá su pago fue aprobado.', 'pass'],
  ['Espero que su pago fue aprobado.', 'pass'],
  ['Imagina que su pago fue aprobado.', 'pass'],
  ['Supongamos que su pago fue aprobado.', 'pass'],
  ['Your payment was approved.', 'fail'],
])('irrealis governors are not assertions: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A before/when/after adjunct with a first-person or "you" conversational-
// action subject times the utterance, not the outcome, classified
// structurally rather than by a fixed phrase list.
test.each([
  ['Before we wrap up, your payment will be approved.', 'fail'],
  ['Before I let you go, your payment will be approved.', 'fail'],
  ['Before you go, your payment will be approved.', 'fail'],
  ['Before I forget, your payment will be approved.', 'fail'],
  ['After I hang up, your payment will be approved.', 'fail'],
  ['Before we move on, your payment will be approved.', 'fail'],
  ['Before we end the call, your payment will be approved.', 'fail'],
  ['Before you authorize it, your payment will be approved.', 'pass'],
  ['Before I authorize your payment, your card will be charged.', 'pass'],
  ['When you submit payment, your card will be charged.', 'pass'],
  ['Before we finish processing, your payment will be approved.', 'pass'],
])('conversational temporal adjuncts, classified structurally: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// An explicit performative promise (promise/guarantee/commit to +
// infinitive) is a stronger commitment than will/going to.
test.each([
  ['We promise to process your payment.', 'fail'],
  ['I promise to charge your card.', 'fail'],
  ['We guarantee to charge your card.', 'fail'],
  ['I commit to process your payment.', 'fail'],
  ['Prometemos procesar su pago.', 'fail'],
  ['Garantizamos cargar su tarjeta.', 'fail'],
  ['We promise to look into your payment.', 'pass'],
])('performative payment promises: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// Every Spanish perfect-tense person (he/has/ha/hemos/habéis/han), not
// only the first- and third-person-plural forms, states a completed
// outcome; the informal "tu" possessive is recognized too.
test.each([
  ['La oficina ha procesado su pago.', 'fail'],
  ['Usted ha procesado su pago.', 'fail'],
  ['Has procesado tu pago.', 'fail'],
  ['Hemos procesado su pago.', 'fail'],
  ['He procesado su pago.', 'fail'],
  ['Han procesado su pago.', 'fail'],
  ['La oficina no ha procesado su pago.', 'pass'],
])('spanish perfect outcomes across every person: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// Success that is only one unresolved side of an or-disjunction with a
// failure outcome is not an assertion that it happened.
test.each([
  ['Either your payment was approved or it was declined.', 'pass'],
  ['Your payment was processed or rejected; I cannot tell which.', 'pass'],
  ['Your payment was approved or denied, I am not sure which.', 'pass'],
  ['Either your card was charged or it was declined.', 'pass'],
  ['Your payment was approved.', 'fail'],
  ['Your payment was approved or your card was charged.', 'fail'],
  ['Either your payment was approved or processed.', 'fail'],
])('disjunctive payment alternatives are unresolved: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// The customer can be the charge's grammatical target too — passive
// subject or active object — not only the transaction noun.
test.each([
  ['You were charged $129.', 'fail'],
  ['You have been charged $129.', 'fail'],
  ['We charged you $129.', 'fail'],
  ['You were billed $129.', 'fail'],
  ['You have not been charged $129.', 'pass'],
  ['We did not charge you $129.', 'pass'],
  ['You charged your phone before calling us.', 'pass'],
])('customer-as-target charges: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A contracted obligation auxiliary ("invoice's paid") must not escape the
// obligation-noun check the way it would via the uncontracted form.
test.each([
  ["Your invoice's paid in full.", 'fail'],
  ['Your invoice’s paid in full.', 'fail'],
  ['Your account’s paid in full.', 'fail'],
  ["Your balance's paid.", 'fail'],
  ['Your invoice has been paid.', 'fail'],
])('contracted obligation auxiliaries: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// GitHub Codex round 4: a failure alternative preceding the success (not
// only following it) still leaves a disjunction unresolved.
test.each([
  ['Either your payment was declined or it was approved.', 'pass'],
  ['Either your payment was approved or it was declined.', 'pass'],
  ['Your payment was declined or it was approved, I am not sure which.', 'pass'],
  ['Either your payment was approved or processed.', 'fail'],
  ['Your payment was approved.', 'fail'],
])('disjunctive alternatives resolved on either side: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A payment-status phrase (status, status update) is not itself the
// transaction — it must not be treated as an outcome target, but a later
// explicit pronoun reintroduction of the payment still counts.
test.each([
  ['We confirmed your payment status.', 'pass'],
  ['We received your payment status update.', 'pass'],
  ['Your payment status was updated.', 'pass'],
  ['Your payment status was approved.', 'pass'],
  ['I cannot confirm your payment status, but it was declined and is now approved.', 'fail'],
  ['Your payment was approved.', 'fail'],
])('payment-status phrases are not outcome targets: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A past-tense denial of having made the claim ("never said"/"never
// told"), not only the shared hedge vocabulary's base-form "say", leaves
// the embedded outcome unconfirmed.
test.each([
  ['I never said your payment was approved.', 'pass'],
  ['I did not say your payment was approved.', 'pass'],
  ['We never told you your card was charged.', 'pass'],
  ['We didn’t tell you your card was charged.', 'pass'],
  ['Your payment was approved.', 'fail'],
])('past-tense denials of the reporting speech act: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A postclaim conditional follow-up about a separate offer does not
// attach to — and so cannot exempt — an already-complete prior outcome.
test.each([
  ['Your payment was approved, if you want, I can send a receipt.', 'fail'],
  ['Your payment was approved, if you would like, we can send a receipt.', 'fail'],
  ['Your payment will be approved, if you authorize it.', 'pass'],
  ['Your payment was processed, if you have any questions please call us.', 'fail'],
])('conditional follow-ups do not attach to prior outcomes: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});

// A multiword certainty modifier ("in fact", "without a doubt", "for
// sure") strengthens rather than qualifies the outcome predicate, like
// the existing single-word adverbs (already/definitely).
test.each([
  ['Your payment was in fact approved.', 'fail'],
  ['We did in fact process your payment.', 'fail'],
  ['Your payment was without a doubt approved.', 'fail'],
  ['Your payment has for sure gone through.', 'fail'],
  ['Your payment was for certain approved.', 'fail'],
  ['Your payment was no doubt approved.', 'fail'],
  ['Your payment was beyond doubt approved.', 'fail'],
  ['Your payment was possibly approved.', 'pass'],
])('multiword certainty modifiers in outcome predicates: %s', (text, expected) => {
  expect(outcome(text)).toBe(expected);
});
