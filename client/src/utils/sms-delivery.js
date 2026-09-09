// Suppressed sends can return sent:true with a sentinel instead of a SID.
// Clear a composer only after the SMS/MMS provider has accepted the message.
// Message SID contract: https://www.twilio.com/docs/messaging/api/message-resource
export function isAcceptedSms(result) {
  return Boolean(result?.sent && /^(SM|MM)[0-9a-f]{32}$/i.test(result.providerMessageId || ""));
}
