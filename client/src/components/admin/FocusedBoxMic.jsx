import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff } from "lucide-react";
import useSpeechDictation from "../../hooks/useSpeechDictation";
import { checkEveryBoxDictation, refreshEveryBoxDictation } from "../../hooks/serverDictation";
import { readToken } from "../../hooks/useServerDictationMode";
import { setDictationPending } from "../../hooks/dictationPending";
import { useIntelligenceBarPageData } from "../../hooks/useIntelligenceBarPageData";
import { boxFits, insertDictatedText, isEligibleBox, readSelection } from "../../lib/dictationInsert";

// One Waves mic for every staff multi-line text box that has none of its own
// (GATE_DICTATION_EVERY_BOX). AdminLayoutV2 mounts it once. While an eligible
// box has focus, a small mic sits inside its bottom-right corner; a tap records
// a clip, our server transcribes it (the same route and word list as every other
// staff mic), and the words go in at the caret the box had at the tap.
// Boxes with their own mic carry `data-own-mic`; `data-no-dictation` opts out.

const Z_INDEX = 10000; // above the modals (9999) the staff pages use
const HANDLE_CLEARANCE = 20; // the textarea's resize handle lives in the corner
const NOTICE_MS = 6000;

const NOTICES = {
  gone: "Dictation: the text box was closed before the words came back, so they were not added.",
  locked: "Dictation: the text box is locked now, so the words were not added.",
  full: "Dictation: the text box is full, so the words were not added.",
  wait: "Dictation: wait for the words to appear in the box, then press that button again.",
};

// Buttons that stay live while words are on the way: they leave the box, they do not read it.
// The whole label must be one of these words ("Save and close" is not): a longer label may send.
const SAFE_BUTTON = /^\s*(cancel|close|back|dismiss|discard|no thanks|×|x)( dialog| modal| window| panel)?\s*$/i;

const RECHECK_MS = 5 * 60 * 1000;

/**
 * Asks the server whether the every-box mic is on: once at mount, then again when
 * the page comes back to the front (at most every five minutes), so turning the
 * gate off reaches an open session without a reload. A failed check turns it off (fail closed).
 * Nothing renders until the server says yes.
 */
function useEveryBox() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const token = readToken();
    if (!token) return undefined;
    let disposed = false;
    let checkedAt = Date.now();
    checkEveryBoxDictation(token).then((yes) => {
      if (!disposed) setOn(yes === true);
    });
    const recheck = () => {
      if (document.visibilityState === "hidden" || Date.now() - checkedAt < RECHECK_MS) return;
      checkedAt = Date.now();
      refreshEveryBoxDictation(token).then((answer) => {
        // Fail closed: a check that could not reach the server turns the mic off until the next one.
      if (!disposed) setOn(answer === true);
      });
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, []);
  return on;
}

// Where the mic and its notice are drawn: inside the box's own dialog when it has one, so the
// dialog's focus trap and its hidden-background markers (aria-hidden / inert) include the mic.
function hostFor(el) {
  const dialog = el?.isConnected ? el.closest('[role="dialog"], [aria-modal="true"]') : null;
  return dialog || document.body;
}

/** The mic's fixed position for a box, or null when the box is off screen or too small. */
function placeFor(el) {
  const rect = el.getBoundingClientRect();
  if (!boxFits(rect)) return null;
  const viewport = window.visualViewport;
  const viewBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const size = rect.height >= 96 ? 40 : 32;
  const bottom = Math.min(rect.bottom, viewBottom);
  const top = bottom - size - 6;
  if (top < rect.top || top < 0 || rect.right < 0 || rect.left > window.innerWidth) return null;
  return { top, left: rect.right - size - HANDLE_CLEARANCE, size };
}

// The focused box, tracked by focusin / focusout. Focus landing on the mic
// itself (keyboard) changes nothing.
function useFocusedBox(micRef) {
  const [box, setBox] = useState(null);
  useEffect(() => {
    const onIn = (event) => {
      if (micRef.current?.contains(event.target)) return;
      setBox(isEligibleBox(event.target) ? event.target : null);
    };
    const onOut = (event) => {
      if (micRef.current?.contains(event.relatedTarget)) return;
      setBox((current) => (current === event.target ? null : current));
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, [micRef]);
  return box;
}

// Keeps `place` current for `el` through scroll, resize, the box's own size
// changes and layout shifts nothing else announces (a slow check).
function useBoxPlace(el) {
  const [place, setPlace] = useState(null);
  useEffect(() => {
    if (!el) {
      setPlace(null);
      return undefined;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = el.isConnected && isEligibleBox(el) ? placeFor(el) : null;
      setPlace((prev) => (prev && next && prev.top === next.top && prev.left === next.left && prev.size === next.size ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    el.addEventListener("input", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(el);
    const slow = setInterval(schedule, 300);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      el.removeEventListener("input", schedule);
      observer?.disconnect();
      clearInterval(slow);
    };
  }, [el]);
  return place;
}

// The box's own form, dialog or page area: what a Send / Save / Create button in it would read.
function actionScope(box) {
  return box.closest('[role="dialog"], [aria-modal="true"], form') || document.getElementById("admin-main") || document.body;
}

/**
 * While words are on the way (recording or transcribing), a button in the
 * box's own form, dialog or page area that would act on its text waits, and so
 * does a form submit or an Enter key. Most Send / Ask buttons already read `useDictationPending`;
 * this covers the boxes that gain the mic here without that wiring.
 */
function useHoldActions(box, active, onHeld) {
  useEffect(() => {
    if (!active || !box) return undefined;
    const scope = actionScope(box);
    const onClick = (event) => {
      const button = event.target instanceof Element ? event.target.closest('button, [role="button"], input[type="submit"]') : null;
      if (!button || !scope.contains(button) || button.closest("[data-focused-box-mic]")) return;
      const label = button.getAttribute("aria-label") || button.textContent || button.title || "";
      if (SAFE_BUTTON.test(label)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onHeld();
    };
    const onSubmit = (event) => {
      if (!scope.contains(event.target) && !event.target.contains?.(box)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onHeld();
    };
    // Enter (and Ctrl/Cmd+Enter) sends from a key handler in some boxes, with no click or submit.
    const onKey = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      if (!(event.target instanceof Element) || !scope.contains(event.target)) return;
      // Enter on a focused button or link activates it as a click, which the click guard above judges
      // (the mic, Cancel and Close stay usable from the keyboard).
      if (event.target.closest('button, [role="button"], a[href], input[type="submit"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onHeld();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [box, active, onHeld]);
}

function Notice({ message, host }) {
  if (!message) return null;
  return createPortal(
    <div
      role="status"
      className="fixed left-1/2 -translate-x-1/2 bottom-4 max-w-[90vw] rounded-sm border border-zinc-300 bg-white px-3 py-2 text-ui-body text-zinc-900 shadow-sm"
      style={{ zIndex: Z_INDEX }}
    >
      {message}
    </div>,
    host,
  );
}

function MicButton({ micRef, host, place, listening, uploading, onTap }) {
  const label = uploading ? "Transcribing" : listening ? "Stop dictation" : "Dictate into this box";
  const size = place?.size || 40;
  // Pinned to a box that left the screen: the mic stays reachable so a recording can be stopped.
  // A dialog with a transform makes `fixed` relative to itself: measure once per place and shift back.
  const [nudge, setNudge] = useState({ host, x: 0, y: 0 });
  const measuredFor = useRef("");
  useLayoutEffect(() => {
    if (host === document.body || !place || !micRef.current) return;
    const key = `${place.left},${place.top}`;
    if (measuredFor.current === key) return;
    measuredFor.current = key;
    const rect = micRef.current.getBoundingClientRect();
    const dx = place.left - rect.left;
    const dy = place.top - rect.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    setNudge((n) => ({ host, x: (n.host === host ? n.x : 0) + dx, y: (n.host === host ? n.y : 0) + dy }));
  }, [host, place, micRef]);
  const shift = nudge.host === host ? nudge : { x: 0, y: 0 };
  const style = place
    ? { top: place.top + shift.y, left: place.left + shift.x, width: size, height: size }
    : { bottom: 16, right: 16, width: 40, height: 40 };
  return createPortal(
    <button
      ref={micRef}
      type="button"
      data-focused-box-mic="true"
      // The mic must not take focus from the box: that would close the caret the words go to.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onTap}
      disabled={uploading}
      aria-busy={uploading || undefined}
      aria-pressed={listening}
      aria-label={label}
      title={label}
      className={
        "fixed inline-flex items-center justify-center rounded-full border border-zinc-300 p-0 shadow-sm " +
        (listening ? "bg-zinc-900 text-white" : "bg-white text-zinc-900 hover:bg-zinc-50") +
        (uploading ? " animate-pulse" : "")
      }
      style={{ ...style, zIndex: Z_INDEX }}
    >
      {listening ? <MicOff size={16} strokeWidth={2.2} aria-hidden="true" /> : <Mic size={16} strokeWidth={2.2} aria-hidden="true" />}
    </button>,
    host,
  );
}

function FocusedBoxMicInner() {
  const pageData = useIntelligenceBarPageData();
  // appointment_id is a scheduled_services id (Dispatch publishes the open visit's row id).
  const dictationContext = {
    customerId: pageData?.customer_id ? String(pageData.customer_id) : undefined,
    serviceId: pageData?.appointment_id ? String(pageData.appointment_id) : undefined,
  };
  const micRef = useRef(null);
  const focused = useFocusedBox(micRef);
  // The box and caret of the tap in flight; the words go there even if focus has moved.
  const sessionRef = useRef(null);
  const [pinned, setPinned] = useState(null);
  const [notice, setNotice] = useState(null);

  const onTranscript = useCallback((text) => {
    const session = sessionRef.current;
    if (!session) return;
    const result = insertDictatedText(session.el, text, session.selection);
    if (!result.ok) setNotice(NOTICES[result.reason]);
  }, []);
  const { listening, starting, uploading, toggle, mode, supported } = useSpeechDictation(onTranscript, { dictationContext });
  const busy = mode === "upload" && (starting || listening || uploading);

  // Send / Ask buttons wait for words still in flight (dictationPending.js).
  const pendingId = useId();
  useEffect(() => {
    setDictationPending(pendingId, busy);
    return () => setDictationPending(pendingId, false);
  }, [busy, pendingId]);

  // The tap's box is let go once nothing is recording or in flight.
  useEffect(() => {
    if (!busy) {
      sessionRef.current = null;
      setPinned(null);
    }
  }, [busy]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const holdNotice = useCallback(() => setNotice(NOTICES.wait), []);
  useHoldActions(pinned, busy, holdNotice);

  const target = busy ? pinned : focused;
  const place = useBoxPlace(target);
  const host = hostFor(target);

  const onTap = useCallback(() => {
    if (!sessionRef.current && focused) {
      sessionRef.current = { el: focused, selection: readSelection(focused) };
      setPinned(focused);
    }
    toggle();
  }, [focused, toggle]);

  if (!supported || mode !== "upload") return <Notice message={notice} host={host} />;
  const show = busy || (focused && place);
  return (
    <>
      {show ? <MicButton micRef={micRef} host={host} place={place} listening={listening} uploading={uploading} onTap={onTap} /> : null}
      <Notice message={notice} host={host} />
    </>
  );
}

export default function FocusedBoxMic() {
  const everyBox = useEveryBox();
  return everyBox ? <FocusedBoxMicInner /> : null;
}
