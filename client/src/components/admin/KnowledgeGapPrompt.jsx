import React, { useCallback, useRef, useState } from "react";
import { uuid } from "../../utils/ibSession";

/**
 * Intelligence Bar "add to knowledge gaps" prompt. Shown when a knowledge
 * search on this exchange came back empty (the /query payload's
 * knowledgeMisses). Nothing is saved unless the operator taps the button,
 * and the search text sits in an editable box first, because it can carry
 * a customer's name, address or phone. Saved gaps go to the weekly
 * knowledge-gaps email.
 *
 * Each box's state (its request key, draft, the text locked on the first
 * tap, and save status) lives in useKnowledgeGaps, owned by the palette, so
 * closing and reopening the palette never mints a new key or forgets a
 * locked text: a retry always resends the same text under the same key.
 *
 * Dual-styled like ToolActivityList: `variant="dark"` matches the desktop
 * palette, `variant="light"` the mobile sheet.
 */

export const KNOWLEDGE_GAP_MAX = 300;

const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();

export function gapsFromMisses(misses) {
  const list = Array.isArray(misses) ? misses.filter((m) => typeof m === "string" && m.trim()) : [];
  return list.map((m) => ({
    miss: m,
    // One key per box: a retry after a lost response re-sends it, so the
    // server saves this gap once however many times the button is tapped.
    requestKey: uuid(),
    draft: m.slice(0, KNOWLEDGE_GAP_MAX),
    // The text sent on the first tap. After that the box is locked: a failed
    // save may still have landed under this key, so a retry resends exactly
    // this text and the screen never shows other words as saved.
    submitted: null,
    status: "idle", // idle | saving | saved | error
    error: "",
  }));
}

// `scope` names the exchange the misses came from (its task id). Loading the
// same scope again (a task status refresh) keeps every box that is still
// listed exactly as it was — key, draft, locked text, status — so a refresh
// can never re-arm a saved gap under a new key or undo an edit. Any other
// scope, or none, starts fresh.
export function useKnowledgeGaps() {
  const [gaps, setGaps] = useState([]);
  const scopeRef = useRef(null);
  const load = useCallback((misses, scope = null) => {
    const sameScope = scope !== null && scope === scopeRef.current;
    scopeRef.current = scope;
    const fresh = gapsFromMisses(misses);
    setGaps((rows) => (sameScope
      ? fresh.map((f) => rows.find((r) => r.miss === f.miss) || f)
      : fresh));
  }, []);
  const reset = useCallback(() => { scopeRef.current = null; setGaps([]); }, []);
  const update = useCallback((requestKey, patch) => {
    setGaps((rows) => rows.map((r) => (r.requestKey === requestKey ? { ...r, ...patch } : r)));
  }, []);
  return { gaps, load, reset, update };
}

function GapRow({ gap, update, save, dark }) {
  const { requestKey, draft, submitted, status, error } = gap;
  const text = submitted ?? normalize(draft);
  const muted = dark ? "#64748B" : "#71717A";
  const border = dark ? "#CBD5E1" : "#D4D4D8";

  async function onSave() {
    if (status === "saving" || text.length < 3) return;
    update(requestKey, { submitted: text, status: "saving", error: "" });
    try {
      await save(text, requestKey);
      update(requestKey, { status: "saved" });
    } catch (err) {
      update(requestKey, { status: "error", error: err?.message || "Could not save" });
    }
  }

  if (status === "saved") {
    return (
      <div role="listitem" style={{ color: muted }}>
        Added to Monday's knowledge-gaps email: "{text}"
      </div>
    );
  }

  return (
    <div role="listitem" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <input
        type="text"
        aria-label="Knowledge gap"
        value={submitted ?? draft}
        maxLength={KNOWLEDGE_GAP_MAX}
        onChange={(e) => { if (submitted === null) update(requestKey, { draft: e.target.value }); }}
        readOnly={submitted !== null}
        style={{
          flex: "1 1 220px",
          minWidth: 0,
          padding: "6px 8px",
          border: `1px solid ${border}`,
          borderRadius: 6,
          font: "inherit",
          // Mobile Safari zooms the page on focus below 16px.
          fontSize: dark ? "inherit" : 16,
          color: "inherit",
          background: "transparent",
        }}
      />
      <button
        type="button"
        onClick={onSave}
        disabled={status === "saving" || text.length < 3}
        style={{
          padding: "6px 12px",
          border: `1px solid ${border}`,
          borderRadius: 6,
          font: "inherit",
          cursor: status === "saving" || text.length < 3 ? "default" : "pointer",
          background: "transparent",
          color: "inherit",
        }}
      >
        {status === "saving" ? "Adding…" : status === "error" ? "Try again" : "Add to knowledge gaps"}
      </button>
      {status === "error" && (
        <div role="alert" style={{ flexBasis: "100%", color: "#B91C1C" }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeGapPrompt({ gaps, update, save, variant = "dark" }) {
  if (!Array.isArray(gaps) || !gaps.length || typeof save !== "function" || typeof update !== "function") return null;
  const dark = variant === "dark";
  const muted = dark ? "#64748B" : "#71717A";
  const text = dark ? "#334155" : "#27272A";
  const border = dark ? "#E2E8F0" : "#E4E4E7";

  return (
    <div
      style={{
        margin: dark ? "12px 0 0" : "14px 0 0",
        padding: "8px 10px",
        border: `1px solid ${border}`,
        borderRadius: 8,
        fontFamily: "Roboto, Arial, sans-serif",
        fontSize: dark ? 13 : 14,
        lineHeight: 1.5,
        color: text,
      }}
    >
      <div style={{ color: muted, marginBottom: 6 }}>
        The knowledge base had nothing on this. Add it to the weekly gaps list? Edit out any customer details first.
      </div>
      <div role="list" aria-label="Knowledge gaps" style={{ display: "grid", gap: 8 }}>
        {gaps.map((g) => (
          <GapRow key={g.requestKey} gap={g} update={update} save={save} dark={dark} />
        ))}
      </div>
    </div>
  );
}
