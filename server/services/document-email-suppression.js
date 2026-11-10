// Local email_suppressions check for the document emails that call sendgrid.sendOne directly (sweep #7765 B2):
// the document request and reminder email (document-contract-delivery.js) and the signed-copy email
// (contract-signed-email.js). SendGrid's own bounce and spam lists still apply upstream. This adds the rows only the
// local table holds (a do_not_email row, a manual unsubscribe from the admin suppression form), read with the same
// rules as the template library's send path (activeSuppressionFor), so the office's "do not email" stops these too.
//
// The stub templates name each email's stream, the same way service-report/email-delivery.js and
// admin-service-outlines.js stub a template for their direct sendOne calls:
// - The document request goes out under the service ASM group, so the service stream's rows block it: the global
//   types (bounce, spam_complaint, do_not_email), any row with no group, and service_operational rows.
// - The signed copy is the signer's only record of what they signed (asmGroupId 0), so only the global types
//   block it. A service unsubscribe does not.
const DOCUMENT_REQUEST_EMAIL = Object.freeze({
  template_key: 'document_request',
  send_stream: 'service_operational',
  suppression_group_key: 'service_operational',
});

const DOCUMENT_SIGNED_COPY_EMAIL = Object.freeze({
  template_key: 'document_signed_copy',
  send_stream: 'transactional_required',
  suppression_group_key: 'transactional_required',
});

// Lazy: the template library is a large module, and a lazy require keeps it out of every suite that loads these
// senders without sending.
function library() {
  return require('./email-template-library');
}

// The active suppression row that blocks this email to this address, or null. Throws on a read failure: callers
// fail closed (nothing is sent) rather than send to an address they could not check.
async function documentEmailSuppression(template, email) {
  if (!email) return null;
  return library().activeSuppressionFor(template, email, template.suppression_group_key);
}

// One "Email blocked by suppression" admin alert per address per week (the library's own dedupe), the same alert a
// blocked template send raises. Best-effort: it never throws.
async function alertBlockedDocumentEmail(template, email, suppression) {
  try {
    await library().alertBlockedOperationalSend({
      template,
      suppressionGroupKey: template.suppression_group_key,
      to: email,
      suppression,
    });
  } catch {
    // alertBlockedOperationalSend already logs and swallows its own failures.
  }
}

function suppressionReason(suppression) {
  const type = String(suppression?.suppression_type || 'unknown');
  return suppression?.group_key ? `${type} (${suppression.group_key})` : type;
}

module.exports = {
  DOCUMENT_REQUEST_EMAIL,
  DOCUMENT_SIGNED_COPY_EMAIL,
  documentEmailSuppression,
  alertBlockedDocumentEmail,
  suppressionReason,
};
