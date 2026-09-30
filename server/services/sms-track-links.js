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

module.exports = { stripTrackLinks };
