'use strict';

const { decodeHTML } = require('entities');

// A 200 that is not really the page: bot-challenge interstitials (Cloudflare
// "Just a moment…", Turnstile, hCaptcha/reCAPTCHA walls, WAF blocks) or a
// non-HTML body. Absence of expected content in such a response proves nothing.
const CHALLENGE_RE = /just a moment|attention required|verify you are human|checking your browser|cf-chl|challenge-platform|turnstile|hcaptcha|g-recaptcha|access denied|request blocked|enable javascript and cookies/i;
const STRICT_HEADING_RE = /^(?:just a moment|attention required|access denied|verify you are human|checking your browser|security check|please wait)\s*[.!?…-]*\s*(?:\|\s*cloudflare)?\s*$/i;
// Interstitial-only markup. The challenge-platform script counts only for the
// interstitial's own orchestration path — NOT /challenge-platform/scripts/jsd/,
// which Cloudflare's JavaScript Detections inject into ordinary pages.
const STRICT_CONTAINER_RE = /<(?:div|form)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:cf-chl|challenge-form|challenge-container|challenge-running|challenge-stage|cf-browser-verification)[^"']*["']|<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/challenge-platform\/(?!scripts\/jsd\/)|window\._cf_chl_opt\b/i;
const STRICT_PLAIN_RE = /^\s*(?:access denied|request blocked|verify you are human|checking your browser)\b/i;
// Challenge WORDING counts only on a THIN page — a wall, not a real page that
// mentions the words. A CAPTCHA widget alone is never a challenge: an ordinary
// article or form may embed one (pinned by editorial-review-sources tests).
const STRICT_WALL_MARKER_RE = /verify you are human|checking (?:your browser|if the site connection is secure)|enable javascript and cookies to continue|complete the security check/i;
const STRICT_WALL_MAX_VISIBLE_CHARS = 1500;

function visibleTextLength(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function hasStrictChallenge(head, html) {
  if (STRICT_CONTAINER_RE.test(head) || STRICT_PLAIN_RE.test(head)) return true;
  for (const match of head.matchAll(/<(title|h1)\b[^>]*>([^]*?)<\/\1>/gi)) {
    const heading = decodeHTML(match[2].replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ').trim();
    if (STRICT_HEADING_RE.test(heading)) return true;
  }
  return STRICT_WALL_MARKER_RE.test(head) && visibleTextLength(html) <= STRICT_WALL_MAX_VISIBLE_CHARS;
}

function classifyPageBody(html, contentType, { strictChallenge = false } = {}) {
  if (contentType && !/html|xhtml|text\/plain|^\s*$/i.test(String(contentType))) return 'non_html';
  const head = String(html || '').slice(0, 20000);
  const challenge = strictChallenge
    ? hasStrictChallenge(head, html)
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
