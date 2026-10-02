import React from "react";

// The promise check on the completion form (owner "ok yes add these"
// 2026-10-01): the open promises Waves made this customer that a technician
// can keep at a visit (GET /admin/dispatch/:serviceId/promises), each marked
// Done, Partly or Not yet. The report says only what was marked; a blank
// changes nothing. Marking is never required to complete.

export const PROMISE_MARKS = [
  { value: "done", label: "Done" },
  { value: "partly", label: "Partly" },
  { value: "not_yet", label: "Not yet" },
];
export const STILL_LEFT_MAX = 200;

const SOURCE_LABELS = { call: "Phone call", text: "Text", email: "Email" };

// "Phone call · Sep 29"
export function promiseSourceLabel(promise) {
  const source = SOURCE_LABELS[promise?.source] || "Message";
  const made = promise?.madeAt ? new Date(promise.madeAt) : null;
  const day = made && !Number.isNaN(made.getTime())
    ? made.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })
    : null;
  return day ? `${source} · ${day}` : source;
}

// A mark holds only for the wording it was made against: each mark stores
// the promise's version when marked, and a promise reworded since (a draft
// restored after an office edit) reads as unmarked.
export function currentMark(marks, promise) {
  const entry = marks?.[promise?.id];
  return entry && promise?.version && entry.version === promise.version ? entry : null;
}

// The request's marks: marked, listed promises only, each with the version
// of the wording the tech marked (the server drops a mark once the promise
// was reworded), a Partly with its note.
export function promiseMarksPayload(marks, promises) {
  return (Array.isArray(promises) ? promises : []).flatMap((promise) => {
    const entry = currentMark(marks, promise);
    if (!entry || !PROMISE_MARKS.some((option) => option.value === entry.mark)) return [];
    const stillLeft = entry.mark === "partly" ? String(entry.stillLeft || "").trim().slice(0, STILL_LEFT_MAX) : "";
    // Partly counts once it says what is still left (the report and the
    // office note both need it).
    if (entry.mark === "partly" && !stillLeft) return [];
    return [{ id: promise.id, mark: entry.mark, version: entry.version, ...(stillLeft ? { stillLeft } : {}) }];
  });
}

// The next marks after a tap: the chosen mark on the promise's current
// wording, or blank when the same mark is tapped again.
export function toggledMarks(marks, promise, mark) {
  const next = { ...(marks || {}) };
  const current = currentMark(marks, promise);
  if (current?.mark === mark) delete next[promise.id];
  else next[promise.id] = { mark, version: promise.version, stillLeft: current?.stillLeft || "" };
  return next;
}

// "2 open", or "10 of 14 open" when the list shows only the newest.
export function promiseCountLabel(shown, total) {
  return Number(total) > shown ? `${shown} of ${total} open` : `${shown} open`;
}

// The marks as the form's staleness check compares them: valid marks in id
// order, whether or not the list has loaded (a restored draft's marks must
// not read as a change when the list arrives after the restore).
export function promiseMarksSignature(marks) {
  return Object.entries(marks || {})
    .filter(([, entry]) => PROMISE_MARKS.some((option) => option.value === entry?.mark))
    .map(([id, entry]) => [id, entry.mark, entry.version || "", entry.mark === "partly" ? String(entry.stillLeft || "").trim() : ""])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const DEFAULT_TOKENS = {
  ink: "#111111",
  muted: "#737373",
  border: "#E5E5E5",
  card: "#FFFFFF",
  onInk: "#FFFFFF",
  font: "inherit",
};

export default function PromiseCheck({ promises, total = null, marks, onChange, disabled = false, tokens = {}, compact = false }) {
  const t = { ...DEFAULT_TOKENS, ...tokens };
  const list = Array.isArray(promises) ? promises : [];
  if (!list.length) return null;
  // Tapping the chosen mark again clears it (left blank: no change).
  const setMark = (promise, mark) => onChange(toggledMarks(marks, promise, mark));
  const setStillLeft = (promise, stillLeft) => {
    onChange({ ...(marks || {}), [promise.id]: { ...(currentMark(marks, promise) || { mark: "partly", version: promise.version }), stillLeft } });
  };
  const buttonHeight = compact ? 36 : 44;
  return (
    <section aria-label="Promises we made" style={{ margin: "4px 0 16px", fontFamily: t.font }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: compact ? 14 : 15, fontWeight: 500, color: t.ink }}>Promises we made</span>
        <span style={{ fontSize: 14, color: t.muted }}>{promiseCountLabel(list.length, total)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {list.map((promise) => {
          const entry = currentMark(marks, promise);
          return (
            <div
              key={promise.id}
              style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: "10px 12px", background: t.card }}
            >
              <div style={{ fontSize: compact ? 14 : 15, color: t.ink, lineHeight: 1.35 }}>{promise.description}</div>
              <div style={{ fontSize: 14, color: t.muted, marginTop: 3 }}>{promiseSourceLabel(promise)}</div>
              <div role="group" aria-label={`Mark: ${promise.description}`} style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                {PROMISE_MARKS.map((option) => {
                  const selected = entry?.mark === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => setMark(promise, option.value)}
                      style={{
                        minHeight: buttonHeight,
                        padding: "0 14px",
                        borderRadius: 10,
                        background: selected ? t.ink : t.card,
                        color: selected ? t.onInk : t.ink,
                        border: `1px solid ${selected ? t.ink : t.border}`,
                        fontFamily: t.font,
                        fontSize: 14,
                        fontWeight: 500,
                        cursor: disabled ? "default" : "pointer",
                        opacity: disabled ? 0.55 : 1,
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              {entry?.mark === "partly" && (
                <label style={{ display: "block", marginTop: 8 }}>
                  <span style={{ display: "block", fontSize: 14, color: t.muted, marginBottom: 4 }}>What’s still left?</span>
                  <input
                    type="text"
                    value={entry.stillLeft || ""}
                    maxLength={STILL_LEFT_MAX}
                    disabled={disabled}
                    onChange={(event) => setStillLeft(promise, event.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      minHeight: buttonHeight,
                      padding: "0 12px",
                      borderRadius: 10,
                      border: `1px solid ${t.border}`,
                      background: t.card,
                      color: t.ink,
                      fontFamily: t.font,
                      fontSize: 16,
                    }}
                  />
                </label>
              )}
              {entry?.mark === "partly" && !String(entry.stillLeft || "").trim() && (
                <span style={{ display: "block", fontSize: 14, color: t.muted, marginTop: 4 }}>
                  Add what’s still left. The mark counts once you do.
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 14, color: t.muted, margin: "8px 0 0" }}>
        Promises left unmarked stay open and stay out of the report. Marking is never required to complete.
      </p>
    </section>
  );
}
