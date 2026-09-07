import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useIsMobile from "../../../hooks/useIsMobile";
import useModalFocus from "../../../hooks/useModalFocus";
import { adminFetch } from "./emailApi";
import { D } from "./emailStyles";

export default function EmailComposer({ active, editor, onSent }) {
  const {
    composeForm,
    setComposeForm,
    showCompose,
    setShowCompose,
    composeSending,
    storageError,
    recoveryNotice,
    handleComposeSend,
  } = editor;
  const isMobile = useIsMobile();
  const close = () => {
    if (!composeSending) setShowCompose(false);
  };
  const composeRef = useModalFocus(active && showCompose, close);
  const [toResults, setToResults] = useState([]);
  const [toSearching, setToSearching] = useState(false);
  const [toDropdownOpen, setToDropdownOpen] = useState(false);
  const toFieldRef = useRef(null);
  const sendDisabled =
    composeSending || !composeForm.to.trim() || !composeForm.body.trim();

  // Debounced customer lookup for the "To" field. Searches by name or
  // partial email via the customers list endpoint and keeps only matches
  // that actually have an email on file (the only ones we can send to).
  useEffect(() => {
    if (!active || !showCompose) return undefined;
    const q = composeForm.to.trim();
    if (q.length < 2) {
      setToResults([]);
      setToSearching(false);
      return undefined;
    }
    let cancelled = false;
    setToSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await adminFetch(
          `/api/admin/customers?search=${encodeURIComponent(q)}&limit=8`,
        );
        const d = await r.json();
        if (cancelled) return;
        setToResults((d.customers || []).filter((c) => c.email));
        setToSearching(false);
      } catch {
        if (cancelled) return;
        setToResults([]);
        setToSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [active, composeForm.to, showCompose]);

  // Dismiss the customer dropdown on an outside click/tap.
  useEffect(() => {
    if (!toDropdownOpen) return undefined;
    const handle = (e) => {
      if (toFieldRef.current && !toFieldRef.current.contains(e.target)) {
        setToDropdownOpen(false);
      }
    };
    document.addEventListener("pointerdown", handle, true);
    return () => document.removeEventListener("pointerdown", handle, true);
  }, [toDropdownOpen]);

  const handleSelectCustomer = (customer) => {
    setComposeForm((f) => ({ ...f, to: customer.email }));
    setToDropdownOpen(false);
    setToResults([]);
  };

  if (!active || !showCompose) return null;
  return createPortal(
    <div
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 16,
      }}
    >
      {" "}
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        ref={composeRef}
        aria-modal="true"
        aria-labelledby="email-compose-title"
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 12,
          width: "100%",
          maxWidth: 560,
          padding: 20,
          boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(20px + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(20px + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(20px + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
      >
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          {" "}
          <h2
            id="email-compose-title"
            style={{
              fontSize: 18,
              fontWeight: 500,
              color: D.heading,
              margin: 0,
            }}
          >
            New email
          </h2>{" "}
          <button
            onClick={close}
            style={{
              background: "transparent",
              border: "none",
              color: D.muted,
              cursor: "pointer",
              fontSize: 20,
              padding: 4,
            }}
            aria-label="Close"
          >
            ×
          </button>{" "}
        </div>{" "}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {" "}
          <div>
            {" "}
            <label
              htmlFor="email-compose-to"
              style={{
                display: "block",
                fontSize: 11,
                color: D.muted,
                marginBottom: 4,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              To *
            </label>{" "}
            <div ref={toFieldRef} style={{ position: "relative" }}>
              {" "}
              <input
                id="email-compose-to"
                type="email"
                value={composeForm.to}
                onChange={(e) => {
                  setComposeForm((f) => ({ ...f, to: e.target.value }));
                  setToDropdownOpen(true);
                }}
                onFocus={() => setToDropdownOpen(true)}
                placeholder="Search a customer or type an email…"
                autoComplete="off"
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  background: D.bg,
                  border: `1px solid ${D.inputBorder}`,
                  borderRadius: 6,
                  color: D.text,
                  fontSize: 13,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              {toDropdownOpen && composeForm.to.trim().length >= 2 && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: "100%",
                    marginTop: 4,
                    zIndex: 10,
                    background: D.card,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                    maxHeight: 240,
                    overflowY: "auto",
                  }}
                >
                  {toSearching && toResults.length === 0 ? (
                    <div
                      style={{
                        padding: "10px 12px",
                        fontSize: 12,
                        color: D.muted,
                      }}
                    >
                      Searching…
                    </div>
                  ) : toResults.length === 0 ? (
                    <div
                      style={{
                        padding: "10px 12px",
                        fontSize: 12,
                        color: D.muted,
                      }}
                    >
                      No matching customers with an email
                    </div>
                  ) : (
                    toResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => handleSelectCustomer(c)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 12px",
                          background: "transparent",
                          border: "none",
                          borderBottom: `1px solid ${D.border}`,
                          cursor: "pointer",
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: D.heading,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {[c.firstName, c.lastName]
                            .filter(Boolean)
                            .join(" ") ||
                            c.companyName ||
                            "Customer"}
                        </div>{" "}
                        <div
                          style={{
                            fontSize: 12,
                            color: D.muted,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.email}
                        </div>{" "}
                      </button>
                    ))
                  )}
                </div>
              )}{" "}
            </div>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              htmlFor="email-compose-subject"
              style={{
                display: "block",
                fontSize: 11,
                color: D.muted,
                marginBottom: 4,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Subject
            </label>{" "}
            <input
              id="email-compose-subject"
              value={composeForm.subject}
              onChange={(e) =>
                setComposeForm((f) => ({ ...f, subject: e.target.value }))
              }
              style={{
                width: "100%",
                padding: "9px 12px",
                background: D.bg,
                border: `1px solid ${D.inputBorder}`,
                borderRadius: 6,
                color: D.text,
                fontSize: 13,
                outline: "none",
                boxSizing: "border-box",
              }}
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              htmlFor="email-compose-body"
              style={{
                display: "block",
                fontSize: 11,
                color: D.muted,
                marginBottom: 4,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Message *
            </label>{" "}
            <textarea
              id="email-compose-body"
              rows={8}
              value={composeForm.body}
              onChange={(e) =>
                setComposeForm((f) => ({ ...f, body: e.target.value }))
              }
              style={{
                width: "100%",
                padding: 12,
                background: D.bg,
                border: `1px solid ${D.inputBorder}`,
                borderRadius: 6,
                color: D.text,
                fontSize: 13,
                outline: "none",
                resize: "vertical",
                fontFamily: "'Roboto', Arial, sans-serif",
                boxSizing: "border-box",
              }}
            />{" "}
          </div>{" "}
        </div>{" "}
        <p
          role={storageError ? "alert" : "status"}
          style={{ fontSize: 14, color: storageError ? D.red : D.muted }}
        >
          {recoveryNotice}
        </p>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 18,
          }}
        >
          {" "}
          <button
            onClick={() => setShowCompose(false)}
            disabled={composeSending}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
              background: "transparent",
              border: `1px solid ${D.border}`,
              color: D.muted,
            }}
          >
            Close
          </button>{" "}
          <button
            type="button"
            disabled={composeSending}
            onClick={() => {
              setComposeForm(() => ({ to: "", subject: "", body: "" }));
              setShowCompose(false);
            }}
            style={{
              fontSize: 14,
              color: D.muted,
              padding: "8px 12px",
              border: `1px solid ${D.border}`,
              borderRadius: 6,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Discard draft
          </button>
          <button
            onClick={() => handleComposeSend(onSent)}
            disabled={sendDisabled}
            style={{
              padding: "8px 20px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              background: D.teal,
              color: "#fff",
              opacity: sendDisabled ? 0.5 : 1,
            }}
          >
            {composeSending ? "Sending…" : "Send"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
  );
}
