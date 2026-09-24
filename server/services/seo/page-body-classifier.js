'use strict';

// A 200 that is not really the page: bot-challenge interstitials (Cloudflare
// "Just a moment…", Turnstile, hCaptcha/reCAPTCHA walls, WAF blocks) or a
// non-HTML body. Absence of expected content in such a response proves nothing.
const CHALLENGE_RE = /just a moment|attention required|verify you are human|checking your browser|cf-chl|challenge-platform|turnstile|hcaptcha|g-recaptcha|access denied|request blocked|enable javascript and cookies/i;

function classifyPageBody(html, contentType, { strictChallenge = false } = {}) {
  if (contentType && !/html|xhtml|text\/plain|^\s*$/i.test(String(contentType))) return 'non_html';
  const head = String(html || '').slice(0, 20000);
  const challenge = CHALLENGE_RE.test(head) && (strictChallenge || !/wavespestcontrol\.com/i.test(html));
  if (strictChallenge && challenge) return 'challenge';
  if (!/<(html|body|a|div|p|title)\b/i.test(head)) return 'non_html';
  if (challenge) return 'challenge';
  return 'html';
}

module.exports = { classifyPageBody };
