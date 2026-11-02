import { adminFetch } from "../utils/admin-fetch";

// GATE_SMS_LIKE (owner 2026-11-02, "SMS Like Button"): the office's like on a
// customer text, and customer likes shown as badges on our texts. The server
// sends `smsLike` and the per-message like fields (officeLike,
// customerReaction, likeable) only while the gate is on.

// The office's like. The server texts a thumbs-up back through the composer's
// own send and marks the text; it answers { success, officeLike }.
export function sendOfficeLike(messageId) {
  return adminFetch(`/admin/communications/messages/${encodeURIComponent(messageId)}/like`, { method: "POST" });
}

// A thread (oldest to newest) as the inbox shows it: with the gate on,
// customer likes folded into badges and the one text that gets the button;
// off, unchanged.
export function smsLikeThread(messages, on) {
  if (!on) return { visible: messages, badges: null, likeMessageId: null };
  return { ...collapseCustomerReactions(messages), likeMessageId: likeableMessageId(messages) };
}

// The text that gets the like button: the newest text of the thread, when it
// is a customer text that can get a like and has none yet. Calls in the same
// list do not count. The server checks again that nothing came after it.
export function likeableMessageId(messages) {
  const texts = (Array.isArray(messages) ? messages : []).filter((m) => m && (m.channel || "sms") === "sms");
  const newest = texts.reduce((latest, m) => (!latest || new Date(m.createdAt) >= new Date(latest.createdAt) ? m : latest), null);
  if (!newest || newest.direction !== "inbound" || newest.likeable !== true || newest.officeLike) return null;
  return newest.id;
}

// Customer likes become badges on our text they quote. Messages run oldest to
// newest. A like attaches to the newest earlier text of ours, between the same
// customer number and the same line of ours, whose body is exactly the quoted
// text; a removal takes back that text's matching badge.
// A matched reaction leaves the list. Anything unmatched stays a bubble, as
// before the gate. Returns { visible, badges } with badges keyed by our text's
// id: [{ id, emoji, createdAt }].
export function collapseCustomerReactions(messages) {
  const visible = [];
  const badges = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    const reaction = m?.direction === "inbound" ? m.customerReaction : null;
    const quoted = reaction ? findQuotedText(visible, reaction.target, textEnds(m)) : null;
    const list = quoted ? badges.get(quoted.id) || [] : null;
    const removeAt = reaction?.removed && list ? list.findIndex((b) => b.emoji === reaction.emoji) : -1;
    if (!quoted || (reaction.removed && removeAt < 0)) {
      visible.push(m);
      continue;
    }
    if (reaction.removed) list.splice(removeAt, 1);
    else list.push({ id: m.id, emoji: reaction.emoji, createdAt: m.createdAt });
    badges.set(quoted.id, list);
  }
  return { visible, badges };
}

function findQuotedText(earlier, target, ends) {
  const wanted = typeof target === "string" ? target.trim() : "";
  if (!wanted || !ends) return null;
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const m = earlier[i];
    if (m?.direction === "outbound" && (m.channel || "sms") === "sms" && textEnds(m) === ends
      && typeof m.body === "string" && m.body.trim() === wanted) return m;
  }
  return null;
}

// A text's two ends, the customer's number and our line, or null when either
// is unknown. Customer 360 rows carry contactPhone / ourEndpointId; Messages
// rows carry from / to.
function textEnds(m) {
  const inbound = m?.direction === "inbound";
  const theirs = phoneIdentity(m?.contactPhone ?? (inbound ? m?.from : m?.to));
  const ours = phoneIdentity(m?.ourEndpointId ?? (inbound ? m?.to : m?.from));
  return theirs && ours ? `${theirs}|${ours}` : null;
}

// The server's phoneIdentityKey: a US number as its last 10 digits, any other
// as "+digits", no digits as "".
function phoneIdentity(value) {
  const text = String(value || "").trim();
  const digits = text.replace(/\D/g, "");
  if (!digits) return "";
  return /^1\d{10}$/.test(digits) || (!text.startsWith("+") && digits.length === 10) ? digits.slice(-10) : `+${digits}`;
}
