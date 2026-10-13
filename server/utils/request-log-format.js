/**
 * The access-log format (Morgan) the app uses: URL and referrer pass through
 * the request-URL redactor, so bearer tokens and typed lookups never reach the
 * log. Kept in one module so the format the server runs is the format the
 * tests mount.
 */
const { redactRequestUrl, redactRequestUrlFor } = require('./redact-request-url');

const REDACTED_COMBINED_LOG = ':remote-addr - :remote-user [:date[clf]] '
  + '":method :redacted-url HTTP/:http-version" :status :res[content-length] '
  + '":redacted-referrer" ":user-agent"';

function registerRedactedTokens(morgan) {
  morgan.token('redacted-url', (req) => redactRequestUrlFor(req, req.originalUrl || req.url || ''));
  morgan.token('redacted-referrer', (req) => {
    const referrer = req.headers?.referer || req.headers?.referrer;
    return referrer ? redactRequestUrl(referrer) : '-';
  });
}

module.exports = { REDACTED_COMBINED_LOG, registerRedactedTokens };
