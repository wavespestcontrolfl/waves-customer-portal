/**
 * Per-customer limits on the customer portal chat (POST /api/ai/chat).
 *
 * Security audit run 3 (2026-11-05): the route's only limit was the broad
 * global /api limiter (1,500 requests per 15 minutes per process, in memory,
 * reset by every deploy), so one customer login could start thousands of
 * flagship-model turns. Behind GATE_PORTAL_CHAT_CUSTOMER_CAP the route checks,
 * keyed on the authenticated customer id (never the body sessionId):
 *   1. a short window, 10 turns per minute, in memory (per process), then
 *   2. a daily cap, 60 turns per Eastern day, counted in Postgres through the
 *      shared consumeSharedDailyCap counter (bucket portal-chat:<customerId>),
 *      so it survives deploys and holds across processes.
 * The minute check runs first and costs no database call, so a request refused
 * for speed never burns the day's budget. A counter error fails open (the
 * minute window still applies). Gate off: allowed at once, nothing counted.
 * Over a limit the route answers with a canned reply and makes no model call.
 */
const { consumeSharedDailyCap } = require('./public-llm-shared-cap');

const MINUTE_WINDOW_MS = 60 * 1000;
const MINUTE_MAX = 10;
const DAILY_ENV_VAR = 'PORTAL_CHAT_DAILY_CAP_PER_CUSTOMER';
const DAILY_DEFAULT_MAX = 60;

// Owner approval pending on this text (PR body, "Copy for owner approval").
const MINUTE_LIMIT_REPLY = "You're sending messages faster than I can keep up. Please wait a minute and try again.";
const DAILY_LIMIT_REPLY = "You've reached today's chat limit. Please try again tomorrow, or call us and a real person will help right away.";

const recentTurns = new Map(); // customerId -> ascending array of turn timestamps (ms)

function portalChatCustomerCapLive() {
  return require('../config/feature-gates').portalChatCustomerCapLive();
}

// Drop customers whose newest turn is outside the window so the map stays small.
function sweep(now) {
  for (const [id, times] of recentTurns) {
    if (!times.length || now - times[times.length - 1] >= MINUTE_WINDOW_MS) recentTurns.delete(id);
  }
}

function takeMinuteSlot(customerId, now) {
  if (recentTurns.size > 5000) sweep(now);
  const times = (recentTurns.get(customerId) || []).filter((t) => now - t < MINUTE_WINDOW_MS);
  if (times.length >= MINUTE_MAX) {
    recentTurns.set(customerId, times);
    return false;
  }
  times.push(now);
  recentTurns.set(customerId, times);
  return true;
}

// { allowed: true } or { allowed: false, reply }. Never throws.
async function checkPortalChatCustomerCap(customerId, now = Date.now()) {
  try {
    if (!portalChatCustomerCapLive() || !customerId) return { allowed: true };
  } catch {
    return { allowed: true };
  }
  if (!takeMinuteSlot(String(customerId), now)) return { allowed: false, reply: MINUTE_LIMIT_REPLY };
  const daily = await consumeSharedDailyCap({
    bucket: `portal-chat:${customerId}`,
    envVar: DAILY_ENV_VAR,
    defaultMax: DAILY_DEFAULT_MAX,
    gate: portalChatCustomerCapLive,
  });
  if (!daily.allowed) return { allowed: false, reply: DAILY_LIMIT_REPLY };
  return { allowed: true };
}

function resetPortalChatMinuteWindows() { recentTurns.clear(); }

module.exports = {
  checkPortalChatCustomerCap, resetPortalChatMinuteWindows,
  MINUTE_MAX, MINUTE_LIMIT_REPLY, DAILY_LIMIT_REPLY, DAILY_DEFAULT_MAX, DAILY_ENV_VAR,
};
