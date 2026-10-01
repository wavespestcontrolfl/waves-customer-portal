'use strict';
// One shared "strip tracking links" step (Codex round-19 P2, PR #5334): a
// customer /track/<token> URL is not prose, and its token can end in digits
// ("…/track/abcdef9") that an ETA parser would otherwise read as a minutes
// figure. Both the draft-time live-ETA check (sms-shadow-drafter) and the
// send-time freshness check (sms-eta-freshness) parse the body WITHOUT its
// tracking links, so they cannot disagree. Whitespace-delimited tokens that
// contain "/track/" anywhere are replaced by a space (link VALIDATION —
// host, exact path, token ownership — stays in sms-eta-freshness).
function stripTrackLinks(text) {
  return String(text || '').split(/(\s+)/).map((t) => (t.toLowerCase().includes('/track/') ? ' ' : t)).join('');
}

// Codex round-5 P2: deliberately NOT track-token-expiry.js's isTrackTokenLive
// — that helper fails OPEN on a missing expiry (a legacy row with no
// track_token_expires_at at all is treated as still live), which is the
// right default for a customer who already has the link open on the public
// tracking page. This send-time gate decides whether Waves is about to HAND
// OUT a link, so it fails CLOSED instead: any expiry that is missing,
// unparseable, or in the past blocks the send.
function sendTimeTrackTokenLive(expiresAt) {
  if (!expiresAt) return false;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs > Date.now();
}

// Shared with the drafter-side context builder (round-22 P2): an expired link is
// withheld from the facts block by the SAME rule the send-time check applies.
module.exports = { stripTrackLinks, sendTimeTrackTokenLive };
