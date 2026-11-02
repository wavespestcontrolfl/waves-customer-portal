// Sign in with Google for staff (GATE_STAFF_GOOGLE_SIGNIN). The server runs
// the whole Google flow (server/services/staff-google-signin.js). This page
// side only proves, at the end, that it is the page that started it:
//   1. a random secret stays in this tab's sessionStorage, and its SHA-256
//      (base64url) goes to /api/admin/auth/google/start as `challenge`;
//   2. the browser visits Google and comes back to /admin/login with
//      #google_result=<one-time result> (or #google_error=<reason>);
//   3. POST /api/admin/auth/google/finish { result, verifier: the secret }.
// Google refuses its sign-in page inside an app's web view, so Waves Admin
// 1.7+ (ios/WavesPay) runs steps 1-2 in Apple's sign-in sheet: the page posts
// { type: 'googleSignIn', challenge } and the app answers with a
// 'wavesadmin:googlesignin' window event, detail = { result } or { error }.
// The iPhone home-screen web app may finish Google in a separate Safari layer
// that cannot read this tab's secret, so the button hides there.

import { isWavesAdminApp } from './platform';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const SECRET_KEY = 'waves_google_signin_secret';
const NEXT_KEY = 'waves_google_signin_next';
const RESULT_EVENT = 'wavesadmin:googlesignin';
const OUTCOME_RE = /^#google_(result|error)=([A-Za-z0-9_-]{1,64})$/;

const REASONS = {
  canceled: 'Google sign-in was canceled.',
  not_allowed: 'This Google account is not linked to an active Waves staff account. Ask the owner to link it on the Team tab.',
  relink_needed: 'This Google account changed. Ask the owner to link it again on the Team tab.',
  expired: 'Your Google sign-in expired. Try again.',
  busy: 'Google sign-in is already open.',
};

export function googleSignInMessage(reason) {
  return REASONS[reason] || 'Google sign-in did not finish. Try again.';
}

// Waves Admin before 1.7 has no Google step; its user agent ends in
// "WavesAdmin/<version>" (PortalView.swift).
function appHasGoogleStep() {
  const match = /WavesAdmin\/(\d+)\.(\d+)/.exec(navigator.userAgent || '');
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 1 || (major === 1 && minor >= 7);
}

export function googleSignInWorksHere() {
  if (isWavesAdminApp()) return appHasGoogleStep();
  try {
    return navigator.standalone !== true;
  } catch {
    return true;
  }
}

export async function fetchGoogleSignInEnabled() {
  try {
    const res = await fetch(`${API_BASE}/admin/auth/google/status`);
    if (!res.ok) return false;
    const data = await res.json();
    return data?.enabled === true;
  } catch {
    return false;
  }
}

function base64url(bytes) {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function askApp(challenge) {
  return new Promise((resolve) => {
    const onResult = (event) => {
      window.removeEventListener(RESULT_EVENT, onResult);
      const detail = event.detail || {};
      resolve(typeof detail.result === 'string' ? { result: detail.result } : { error: String(detail.error || 'failed') });
    };
    window.addEventListener(RESULT_EVENT, onResult);
    window.webkit.messageHandlers.wavesAdmin.postMessage({ type: 'googleSignIn', challenge });
  });
}

// In a browser this leaves the page for Google (resolves null). Inside Waves
// Admin it resolves with the app's { result } or { error }.
export async function startGoogleSignIn({ next } = {}) {
  let challenge;
  try {
    const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    challenge = base64url(new Uint8Array(digest));
    sessionStorage.setItem(SECRET_KEY, secret);
    if (next) sessionStorage.setItem(NEXT_KEY, next);
    else sessionStorage.removeItem(NEXT_KEY);
  } catch {
    return { error: 'failed' };
  }
  if (isWavesAdminApp()) return askApp(challenge);
  window.location.assign(`${API_BASE}/admin/auth/google/start?client=web&challenge=${challenge}`);
  return null;
}

// The outcome the callback put in the address bar, with the ?next= target the
// starting page saved; null when the hash is not a Google outcome.
export function readGoogleRedirect(hash) {
  const match = OUTCOME_RE.exec(hash || '');
  if (!match) return null;
  let next = null;
  try {
    next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
  } catch { /* storage unavailable: no return target */ }
  return match[1] === 'result' ? { result: match[2], next } : { error: match[2], next };
}

// The server's sign-in answer ({ token, user } or { mfaRequired, challengeToken }),
// or { error } when this tab holds no secret or the server refused.
export async function finishGoogleSignIn(result) {
  let verifier = null;
  try {
    verifier = sessionStorage.getItem(SECRET_KEY);
    sessionStorage.removeItem(SECRET_KEY);
  } catch { /* storage unavailable: treated as expired */ }
  if (!verifier) return { error: 'expired' };
  const res = await fetch(`${API_BASE}/admin/auth/google/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result, verifier }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: 'expired' };
}
