'use strict';

// Every customer-facing word of the "Turn Waves emails back on?" flow that the
// server writes lives here, so the owner can edit the copy in one place
// (GATE_PORTAL_EMAIL_RESUBSCRIBE). The app's own lines are in
// client/src/pages/PortalPage.jsx (EMAIL_RESUBSCRIBE_COPY).
//
// Rules for editors: the greeting and the address are inserted ESCAPED by the
// callers; do not put raw user text in these strings.

const EMAIL = {
  subject: 'Turn Waves emails back on?',
  preheader: 'One tap from this mailbox turns Waves emails back on.',
  heading: 'Turn Waves emails back on?',
  // `${greeting}` is "Hi Pat," or "Hi there,".
  intro: (greeting) => `${greeting} you asked in the Waves app to get our emails again. This address was unsubscribed, so we need your OK first.`,
  ctaLabel: 'Turn emails back on',
  footerNote: "If you didn't ask for this, you can ignore this email. Nothing changes.",
};

const PAGE = {
  confirmHeading: 'Turn Waves emails back on?',
  // `${address}` is already escaped.
  confirmBody: (address) => `Waves emails to ${address} are off because of an unsubscribe link. Press the button to turn them back on.`,
  confirmButton: 'Turn emails back on',
  confirmNote: "If you didn't ask for this, just close this tab. Nothing changes until you press the button.",
  doneHeading: "You're all set.",
  doneAlreadyBody: 'Waves emails are on for this address.',
  successHeading: 'Done.',
  successBody: (address) => `Waves emails will reach ${address} again.`,
  retryHeading: "We couldn't finish that.",
  retryBody: 'Please try the button again in a few minutes.',
  expiredHeading: 'Link expired.',
  expiredBody: 'This link has expired or was already used.',
};

module.exports = { EMAIL, PAGE };
