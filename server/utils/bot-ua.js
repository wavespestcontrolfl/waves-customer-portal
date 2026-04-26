/**
 * Shared bot / preview / scanner user-agent filter. Used by routes that
 * record customer engagement (estimate views, shortlink clicks) so link
 * unfurlers (iMessage, Slack, WhatsApp), email scanners, antivirus, and
 * CLI clients don't inflate the counts surfaced to operators.
 */
const BOT_UA_RE = /bot\b|crawler|spider|crawling|facebookexternalhit|slackbot|twitterbot|linkedinbot|whatsapp|telegram|discordbot|preview|prerender|headlesschrome|curl\/|wget\/|python-requests|axios\/|node-fetch|pingdom|uptimerobot|statuscake|monitoring|http-client/i;

function isBotUserAgent(ua) {
  return !!ua && BOT_UA_RE.test(ua);
}

module.exports = { BOT_UA_RE, isBotUserAgent };
