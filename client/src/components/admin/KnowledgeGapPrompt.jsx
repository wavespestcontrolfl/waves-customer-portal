import React, { useState } from "react";
import { uuid } from "../../utils/ibSession";

/**
 * Intelligence Bar "add to knowledge gaps" prompt. Shown when a knowledge
 * search on this exchange came back empty (the /query payload's
 * knowledgeMisses). Nothing is saved unless the operator taps the button,
 * and the search text sits in an editable box first, because it can carry
 * a customer's name, address or phone. Saved gaps go to the weekly
 * knowledge-gaps email.
 *
 * Dual-styled like ToolActivityList: `variant="dark"` matches the desktop
 * palette, `variant="light"` the mobile sheet.
 */

export const KNOWLEDGE_GAP_MAX = 300;

function GapRow({ initial, save, dark }) {
  const [text, setText] = useState(String(initial || "").slice(0, KNOWLEDGE_GAP_MAX));
  // One key per box: a retry after a lost response re-sends it, so the
  // server saves this gap once however many times the button is tapped.
  const [requestKey] = useState(uuid);
  const [state, setState] = useState("idle"); // idle | saving | saved | error
  const [error, setError] = useState("");
  const trimmed = text.replace(/\s+/g, " ").trim();
  const muted = dark ? "#64748B" : "#71717A";
  const border = dark ? "#CBD5E1" : "#D4D4D8";

  async function onSave() {
    if (state === "saving" || trimmed.length < 3) return;
    setState("saving");
    setError("");
    try {
      await save(trimmed, requestKey);
      setState("saved");
    } catch (err) {
      setError(err?.message || "Could not save");
      setState("error");
    }
  }

  if (state === "saved") {
    return (
      <div role="listitem" style={{ color: muted }}>
        Added to Monday's knowledge-gaps email: "{trimmed}"
      </div>
    );
  }

  return (
    <div role="listitem" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <input
        type="text"
        aria-label="Knowledge gap"
        value={text}
        maxLength={KNOWLEDGE_GAP_MAX}
        onChange={(e) => setText(e.target.value)}
        disabled={state === "saving"}
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
        disabled={state === "saving" || trimmed.length < 3}
        style={{
          padding: "6px 12px",
          border: `1px solid ${border}`,
          borderRadius: 6,
          font: "inherit",
          cursor: state === "saving" || trimmed.length < 3 ? "default" : "pointer",
          background: "transparent",
          color: "inherit",
        }}
      >
        {state === "saving" ? "Adding…" : "Add to knowledge gaps"}
      </button>
      {state === "error" && (
        <div role="alert" style={{ flexBasis: "100%", color: "#B91C1C" }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeGapPrompt({ misses, save, variant = "dark" }) {
  const list = Array.isArray(misses) ? misses.filter((m) => typeof m === "string" && m.trim()) : [];
  if (!list.length || typeof save !== "function") return null;
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
        {list.map((m) => (
          <GapRow key={m} initial={m} save={save} dark={dark} />
        ))}
      </div>
    </div>
  );
}
