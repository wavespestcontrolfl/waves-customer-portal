/**
 * The owner's Claude Code key for the read-only admin MCP endpoint
 * (/api/mcp-admin, routes/mcp-admin.js), minted by
 * ops/agents/mint-mcp-admin-key.js. One contract, two callers: the mint
 * script signs with it and the endpoint verifies with it.
 *
 * The key is a JWT whose type is MCP_KEY_TYPE ('mcp_read'), never 'access'.
 * Every staff verifier calls isStaffAccessToken() (middleware/admin-auth.js),
 * which requires type 'access', so adminAuthenticate, the staff socket, the
 * large-body guard, reports-public, Stripe Terminal and the rate-limit key all
 * refuse this key with no change of their own. A new *scope* on an access
 * token would not do that: those checks refuse only the 'terminal' scope by
 * name, so a scoped access token would still be a full admin session.
 *
 * Eligibility is re-read on every request: the technician row must be active,
 * an admin, on the full-access list (ib-access.js), not held for a forced
 * password change, and its auth_token_version must equal the key's, so a
 * password change or reset (which bumps the version) revokes the key. The
 * staff MFA session check (sessionMfaBlock) is deliberately not applied: the
 * key is minted out of band by an operator holding the production secret,
 * never by a login, so it must not claim an `mfa: true` it never passed.
 */

const jwt = require('jsonwebtoken');
const { isFullAccessEmail } = require('./intelligence-bar/ib-access');

const MCP_KEY_TYPE = 'mcp_read';
const MCP_KEY_TTL = '30d';

function signMcpAdminKey({ technicianId, tokenVersion, jti }, secret) {
  return jwt.sign({ type: MCP_KEY_TYPE, technicianId, tokenVersion, jti }, secret, { algorithm: 'HS256', expiresIn: MCP_KEY_TTL });
}

// Returns the decoded key. Throws on a bad signature, an expired key, or any
// token that is not an MCP admin key (a staff access token included).
function verifyMcpAdminKey(token, secret) {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (decoded?.type !== MCP_KEY_TYPE
    || typeof decoded.technicianId !== 'string' || !decoded.technicianId
    || !Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion < 1) {
    const err = new Error('not an MCP admin key');
    err.name = 'McpAdminKeyError';
    throw err;
  }
  return decoded;
}

function mcpKeyEligible(tech, tokenVersion) {
  const currentVersion = Number(tech?.auth_token_version);
  return Boolean(tech)
    && tech.employment_status === 'active'
    && tech.role === 'admin'
    && isFullAccessEmail(tech.email)
    && !tech.must_change_password
    && Number.isInteger(currentVersion)
    && currentVersion >= 1
    && currentVersion === tokenVersion;
}

module.exports = { MCP_KEY_TYPE, MCP_KEY_TTL, signMcpAdminKey, verifyMcpAdminKey, mcpKeyEligible };
