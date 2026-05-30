/**
 * Single source of truth for whether the legacy non-template email fallback
 * (Google Workspace SMTP via nodemailer, or any hardcoded-HTML renderer) may
 * fire.
 *
 * These fallbacks bypass the email_messages audit row, the email_suppressions
 * check, unsubscribe headers, and SendGrid events, so in production they must
 * hard-fail rather than deliver silently: a template-missing error is a
 * migration bug and SendGrid being unconfigured is a deploy bug — both should
 * page operators, not fall through to an invisible delivery. Keeping this
 * decision in one place means a future edit can't quietly re-open an SMTP
 * bypass in one caller while the others stay closed (the previous copies were
 * duplicated across five files and only one was pinned by a test).
 */
function emailFallbackAllowed() {
  return process.env.NODE_ENV !== 'production';
}

module.exports = {
  emailFallbackAllowed,
  // Back-compat aliases for existing call sites and exported surfaces.
  smtpFallbackAllowed: emailFallbackAllowed,
  legacyTemplateFallbackAllowed: emailFallbackAllowed,
};
