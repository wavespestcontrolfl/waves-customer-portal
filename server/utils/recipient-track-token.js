'use strict';

/**
 * The visit text recipient's tracker credential (GATE_CALL_GIVEN_VISIT_TEXTS) has its OWN recognizable shape, so every layer can tell
 * it from the holder's tracker token (64 lowercase hex) by looking at it, with no database read: `vr_` + 48 lowercase hex = 51
 * characters (192 bits), which fits the varchar(64) column of migration 20261124190000. The holder's token never contains `_`.
 *
 * A recipient token is NOT a socket credential: the socket joins the HOLDER's customer room. The page skips the socket for this shape
 * and the socket auth refuses it by format (its holder-token check is 64 hex), before any lookup.
 */
const RECIPIENT_TRACK_TOKEN_RE = /^vr_[a-f0-9]{48}$/;
const HOLDER_TRACK_TOKEN_RE = /^[a-f0-9]{64}$/;

function isRecipientTrackToken(token) {
  return typeof token === 'string' && RECIPIENT_TRACK_TOKEN_RE.test(token);
}

// SQL expression that mints one (Postgres gen_random_bytes, pgcrypto: already used for the holder's tokens).
const RECIPIENT_TRACK_TOKEN_MINT_SQL = "('vr_' || encode(gen_random_bytes(24), 'hex'))";

module.exports = {
  RECIPIENT_TRACK_TOKEN_RE,
  HOLDER_TRACK_TOKEN_RE,
  isRecipientTrackToken,
  RECIPIENT_TRACK_TOKEN_MINT_SQL,
};
