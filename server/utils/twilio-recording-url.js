/**
 * The one exact Twilio recording URL a stored recording_url may name, or null. Shared by the admin recording proxy
 * and the call sound check: both send the Twilio account's Basic credentials to it, so only https://api.twilio.com
 * with no port, user info, query or fragment passes (an old http:// Twilio URL is upgraded to https).
 */
function canonicalTwilioRecordingUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl !== rawUrl.trim()) return null;

  let url;
  try {
    url = new URL(rawUrl, 'https://api.twilio.com/');
  } catch {
    return null;
  }

  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.hostname !== 'api.twilio.com'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return null;
  }

  // Twilio historically emitted HTTP media URLs and now redirects them to
  // HTTPS. Upgrade the one exact trusted host locally so Basic credentials are
  // never sent over plaintext and the proxy still refuses all redirects.
  url.protocol = 'https:';
  if (!url.pathname.endsWith('.mp3')) url.pathname += '.mp3';
  return url.toString();
}

module.exports = { canonicalTwilioRecordingUrl };
