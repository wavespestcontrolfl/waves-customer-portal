// Suppressed sends can return sent:true with a sentinel instead of a SID.
// Clear a composer only after the SMS provider has accepted the message.
export function isAcceptedSms(result) {
  return Boolean(result?.sent && /^SM[0-9a-z_]+$/i.test(result.providerMessageId || ""));
}
