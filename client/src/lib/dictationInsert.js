// Helpers for FocusedBoxMic (the one Waves mic on every staff multi-line text box,
// GATE_DICTATION_EVERY_BOX): which boxes get the mic, and how dictated words go
// into a box the mic does not own. Pure DOM, no React.

// A box shorter than this reads as one line: the mic would sit on its text.
export const MIN_BOX_HEIGHT = 52;

/**
 * True for a multi-line text box the shared mic may serve: a textarea that is
 * not disabled, not read-only, and not inside a box that has its own mic
 * (`data-own-mic`) or opts out (`data-no-dictation`). Single-line inputs never
 * qualify. Size is checked where the mic is placed (`boxFits`).
 */
export function isEligibleBox(el) {
  if (!el || el.tagName !== "TEXTAREA") return false;
  if (el.disabled || el.readOnly) return false;
  if (el.closest("[data-own-mic], [data-no-dictation]")) return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

/** True when a box's rectangle is big enough to carry the mic without covering its first line. */
export function boxFits(rect) {
  return Boolean(rect) && rect.width >= 120 && rect.height >= MIN_BOX_HEIGHT;
}

/** The box's selection now, or the end of its text when the browser will not say. */
export function readSelection(el) {
  const end = el.value.length;
  const start = Number.isInteger(el.selectionStart) ? el.selectionStart : end;
  return { start, end: Number.isInteger(el.selectionEnd) ? el.selectionEnd : start };
}

// How many characters the box still takes (maxLength), or Infinity.
function roomFor(el, replacing) {
  return el.maxLength > 0 ? el.maxLength - (el.value.length - replacing) : Infinity;
}

function clampSelection(value, selection) {
  const start = Math.min(Math.max(selection?.start ?? value.length, 0), value.length);
  return { start, end: Math.min(Math.max(selection?.end ?? start, start), value.length) };
}

function browserInsert(payload) {
  try {
    return typeof document.execCommand === "function" && document.execCommand("insertText", false, payload) === true;
  } catch {
    return false;
  }
}

function nativeSet(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/**
 * Puts dictated `text` into `el` at the saved selection. One space goes before
 * the words when the character before the caret is not whitespace and the caret
 * is not at the start. The browser's own insert runs first, so the box's
 * undo history and React's onChange both see an ordinary typed edit; if the
 * value did not change, the native value setter plus a bubbling `input` event
 * does the same job for React.
 * Returns { ok: true } or { ok: false, reason: "gone" | "locked" | "full" }.
 */
export function insertDictatedText(el, text, selection) {
  if (!el || !el.isConnected) return { ok: false, reason: "gone" };
  if (el.disabled || el.readOnly) return { ok: false, reason: "locked" };
  const words = String(text || "").trim();
  if (!words) return { ok: true };
  const before = el.value;
  const { start, end } = clampSelection(before, selection);
  const lead = start > 0 && !/\s/.test(before[start - 1]) ? " " : "";
  if (roomFor(el, end - start) <= 0) return { ok: false, reason: "full" };
  let payload = lead + words;
  try {
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
  } catch {
    /* a box that cannot hold a selection still takes the value below */
  }
  if (browserInsert(payload) && el.value !== before) return { ok: true };
  // The browser declined (or has no execCommand): set the value ourselves.
  payload = payload.slice(0, roomFor(el, end - start));
  nativeSet(el, before.slice(0, start) + payload + before.slice(end));
  const caret = start + payload.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* no selection support */
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true };
}
