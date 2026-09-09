/** Transport failures that establish no request reached the provider. */
const PRE_SEND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'ERR_INVALID_URL', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO']);
function isPreSendFailure(e) {
  const code = String(e?.cause?.code || e?.code || '');
  if (PRE_SEND_CODES.has(code)) return true;
  if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_)/.test(code)) return true;
  return /\b(?:getaddrinfo|certificate|handshake|ssl|tls)\b/i.test(String(e?.cause?.message || ''));
}

module.exports = { isPreSendFailure };
