/**
 * The ready text on the office's Follow Up button (owner 2026-11-22, "tap").
 *
 *   "Hi Dana, it's Waves. Your lawn care and pest control estimate is here: <link> Any questions? Just reply to this text."
 *
 * A person still reads, edits and sends it. Nothing here sends anything.
 *
 *   buildFollowUpText({ firstName, serviceName, link })  pure: the words.
 *   followUpTextServiceName(label)                        pure: one of three names, or null.
 *   followUpServiceNameFor(estimate)                      async read: the name the engagement engine's follow-up
 *                                                         emails would use, or null. Never throws.
 *   swapLongLinkForShort(message, longUrl, shortUrl)      pure: the send's long-link to short-link swap.
 */

// The only names the text may carry. Every other label (home protection, service quote, every other pack
// label) gives the sentence without a name.
const ALLOWED_SERVICE_NAMES = ['pest control', 'lawn care', 'lawn care and pest control'];

function followUpTextServiceName(label) {
  return typeof label === 'string' && ALLOWED_SERVICE_NAMES.includes(label) ? label : null;
}

function buildFollowUpText({ firstName, serviceName, link }) {
  const name = followUpTextServiceName(serviceName);
  const what = name ? `Your ${name} estimate` : 'Your Waves estimate';
  return `Hi ${firstName}, it's Waves. ${what} is here: ${link} Any questions? Just reply to this text.`;
}

// The label the engagement engine's follow-up emails use: the pack's service_label, replaced by the delivery
// email's own service name when GATE_ESTIMATE_FOLLOWUP_SERVICE_NAME is on and the module can prove it
// (estimate-engagement-engine.js, "emailedName"). The same gate reader, the same two calls. A failed read is no name.
async function followUpServiceNameFor(estimate) {
  try {
    const featureGates = require('../config/feature-gates');
    const todayLabel = require('./estimate-followup-copy').followupEmailVars(estimate).service_label;
    const emailedName = typeof featureGates.estimateFollowupServiceNameLive === 'function'
      && featureGates.estimateFollowupServiceNameLive()
      ? await require('./estimate-emailed-service-name').emailedServiceName(estimate, todayLabel)
      : null;
    return followUpTextServiceName(typeof emailedName === 'string' ? emailedName : todayLabel);
  } catch {
    return null;
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every occurrence of THIS estimate's exact long link becomes the short link. A longer link that only starts with it
// (another estimate's token) is left alone. Anything that is not text, or has no long link, comes back as it was.
function swapLongLinkForShort(message, longUrl, shortUrl) {
  if (typeof message !== 'string' || !longUrl || !shortUrl || !message.includes(longUrl)) return message;
  return message.replace(new RegExp(`${escapeRegExp(longUrl)}(?![A-Za-z0-9_-])`, 'g'), () => shortUrl);
}

module.exports = {
  ALLOWED_SERVICE_NAMES,
  buildFollowUpText,
  followUpTextServiceName,
  followUpServiceNameFor,
  swapLongLinkForShort,
};
