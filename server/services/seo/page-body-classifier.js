'use strict';

const { decodeHTML } = require('entities');

// A 200 that is not really the page: bot-challenge interstitials (Cloudflare
// "Just a moment…", Turnstile, hCaptcha/reCAPTCHA walls, WAF blocks) or a
// non-HTML body. Absence of expected content in such a response proves nothing.
const CHALLENGE_RE = /just a moment|attention required|verify you are human|checking your browser|cf-chl|challenge-platform|turnstile|hcaptcha|g-recaptcha|access denied|request blocked|enable javascript and cookies/i;
const STRICT_HEADING_RE = /^(?:just a moment|attention required|access denied|verify you are human)\s*[.!?…-]*\s*(?:\|\s*cloudflare)?\s*$/i;
const STRICT_CONTAINER_RE = /<(?:div|form)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:cf-chl|challenge-form|challenge-container)[^"']*["']|<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/challenge-platform\//i;
const STRICT_PLAIN_RE = /^\s*(?:access denied|request blocked|verify you are human|checking your browser)\b/i;

function hasStrictChallenge(head) {
  if (STRICT_CONTAINER_RE.test(head) || STRICT_PLAIN_RE.test(head)) return true;
  for (const match of head.matchAll(/<(title|h1)\b[^>]*>([^]*?)<\/\1>/gi)) {
    const heading = decodeHTML(match[2].replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ').trim();
    if (STRICT_HEADING_RE.test(heading)) return true;
  }
  return false;
}

function classifyPageBody(html, contentType, { strictChallenge = false } = {}) {
  if (contentType && !/html|xhtml|text\/plain|^\s*$/i.test(String(contentType))) return 'non_html';
  const head = String(html || '').slice(0, 20000);
  const challenge = strictChallenge
    ? hasStrictChallenge(head)
    : CHALLENGE_RE.test(head) && !/wavespestcontrol\.com/i.test(html);
  if (strictChallenge && challenge) return 'challenge';
  const htmlElementRe = strictChallenge
    ? /<(html|body|head|title|main|article|section|header|footer|nav|aside|h[1-6]|p|div|a|ul|ol|li|table|form)\b/i
    : /<(html|body|a|div|p|title)\b/i;
  if (!htmlElementRe.test(head)) return 'non_html';
  if (challenge) return 'challenge';
  return 'html';
}

module.exports = { classifyPageBody };
