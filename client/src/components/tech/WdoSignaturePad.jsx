import { useRef, useState, useEffect, useCallback } from "react";
import { adminFetch } from "../../lib/adminFetch";

/**
 * Licensee e-signature capture for WDO inspection reports. A WDO report is an
 * official FDACS-13645 filing and must carry the licensee signature before it
 * can be sent, so this gates the send buttons upstream. Draws to a canvas,
 * exports a PNG data URL, and POSTs to /admin/projects/:id/wdo-signature.
 */
const CANVAS_CSS_HEIGHT = 160;

// onBusyChange (optional): reports the in-flight save/clear mutation so a host
// that can unmount this pad (the create sheet's sign step) can hold its exits
// until the POST/DELETE settles — leaving mid-mutation strands the caller with
// stale signed/unsigned state.
export default function WdoSignaturePad({ projectId, signature, defaultSignerName = "", defaultSignerIdCard = "", onChanged, onBusyChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasDrawn = useRef(false);
  // Last completed-stroke snapshot (PNG data URL) so a viewport resize
  // mid-signature (rotation, iOS keyboard/URL-bar collapse) can restore the
  // ink instead of silently wiping it.
  const inkSnapshot = useRef(null);
  // Bumped on every canvas init: the restore's async image decode must not
  // land on a canvas that was cleared or re-inited after it started, or old
  // ink would resurrect over a Clear (and mark the pad drawn).
  const initGen = useRef(0);
  const [signerName, setSignerName] = useState(defaultSignerName);
  const [signerIdCard, setSignerIdCard] = useState(defaultSignerIdCard);
  const [saving, setSavingState] = useState(false);
  const setSaving = (v) => { setSavingState(v); onBusyChange?.(v); };
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(!signature?.signed);

  const initCanvas = useCallback(({ preserveInk = false } = {}) => {
    const c = canvasRef.current;
    if (!c) return;
    const gen = ++initGen.current;
    // Size the bitmap from the rendered box (× devicePixelRatio): a fixed
    // 520×160 bitmap on a ~350px-wide phone box stretched the exported PNG
    // horizontally relative to what was actually signed, and rendered blurry
    // on Retina. Falls back to the width/height attributes pre-layout.
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (rect.width > 0) {
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(CANVAS_CSS_HEIGHT * dpr);
    }
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.2 * (rect.width > 0 ? dpr : 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
    hasDrawn.current = false;
    if (!preserveInk) {
      inkSnapshot.current = null;
      return;
    }
    // Restore the in-progress signature after a resize re-init. The bitmap
    // height is constant (CSS height × dpr), so drawing the snapshot scaled
    // by HEIGHT keeps the stroke aspect true — no stretching, which is what
    // the old wipe-on-resize existed to prevent. A narrower box may clip the
    // rightmost ink; the licensee can still Clear and restart.
    const snapshot = inkSnapshot.current;
    if (!snapshot) return;
    const img = new Image();
    img.onload = () => {
      const cur = canvasRef.current;
      // Stale-callback fence: a Clear or another resize re-init after this
      // decode started means this restore must not land (it would resurrect
      // cleared ink and mark the pad drawn).
      if (!cur || initGen.current !== gen) return;
      const scale = cur.height / (img.height || 1);
      cur.getContext("2d").drawImage(img, 0, 0, img.width * scale, cur.height);
      hasDrawn.current = true;
    };
    img.src = snapshot;
  }, []);

  useEffect(() => {
    if (editing) initCanvas();
  }, [editing, initCanvas]);

  // Re-size the bitmap when the rendered box changes (rotation, sheet
  // resize): strokes drawn after a resize would otherwise map against the
  // stale bitmap aspect and export distorted — the exact bug initCanvas
  // fixes at mount. Re-initing restores completed strokes from the snapshot
  // (height-scaled, aspect-true) so a rotation or iOS keyboard collapse
  // mid-signature no longer silently wipes the licensee's ink.
  useEffect(() => {
    if (!editing) return undefined;
    const c = canvasRef.current;
    if (!c || typeof ResizeObserver === "undefined") return undefined;
    let lastWidth = c.getBoundingClientRect().width;
    const ro = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect?.width || 0;
      if (width > 0 && Math.abs(width - lastWidth) > 1) {
        lastWidth = width;
        initCanvas({ preserveInk: true });
      }
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [editing, initCanvas]);

  function pointFor(e) {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const t = e.touches?.[0];
    const cx = t ? t.clientX : e.clientX;
    const cy = t ? t.clientY : e.clientY;
    return { x: (cx - rect.left) * (c.width / rect.width), y: (cy - rect.top) * (c.height / rect.height) };
  }
  function startDraw(e) {
    e.preventDefault();
    drawing.current = true;
    const ctx = canvasRef.current.getContext("2d");
    const p = pointFor(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function moveDraw(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const p = pointFor(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasDrawn.current = true;
  }
  function endDraw() {
    drawing.current = false;
    // Snapshot completed strokes for the resize-restore path.
    if (hasDrawn.current && canvasRef.current) {
      try {
        inkSnapshot.current = canvasRef.current.toDataURL("image/png");
      } catch {
        inkSnapshot.current = null;
      }
    }
  }

  async function save() {
    if (!hasDrawn.current) { setError("Please sign in the box above."); return; }
    if (!signerName.trim()) { setError("Enter the licensee / inspector name."); return; }
    if (!signerIdCard.trim()) { setError("Enter the inspector's FDACS ID card number."); return; }
    setSaving(true);
    setError("");
    try {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const r = await adminFetch(`/admin/projects/${projectId}/wdo-signature`, {
        method: "POST",
        body: { signature: dataUrl, signer_name: signerName.trim(), signer_id_card: signerIdCard.trim() },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(d.error || "Could not save signature");
      }
      setEditing(false);
      // Pass the authoritative outcome (the POST response's metadata) and
      // AWAIT the host's handler inside the busy window — a host that only
      // refreshes on onChanged must not see busy end before it has the new
      // signed state (it could exit with stale unsigned metadata).
      await onChanged?.({
        signed: true,
        signer_name: d.signer_name || signerName.trim(),
        signed_at: d.signed_at || new Date().toISOString(),
      });
    } catch (e) {
      setError(e.message || "Could not save signature");
    } finally {
      setSaving(false);
    }
  }

  async function clearSaved() {
    if (!confirm("Remove the saved signature? The report can't be sent until it's signed again.")) return;
    setSaving(true);
    setError("");
    try {
      const r = await adminFetch(`/admin/projects/${projectId}/wdo-signature`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Could not clear signature");
      }
      setEditing(true);
      // null = cleared; awaited for the same reason as save().
      await onChanged?.(null);
    } catch (e) {
      setError(e.message || "Could not clear signature");
    } finally {
      setSaving(false);
    }
  }

  const card = {
    border: "1px solid #d4d4d8",
    borderRadius: 10,
    padding: 14,
    background: "#fafafa",
    margin: "12px 0",
  };
  const label = { fontSize: 13, fontWeight: 600, color: "#3f3f46", marginBottom: 6 };
  const btn = {
    fontSize: 13, padding: "7px 12px", borderRadius: 8, border: "1px solid #d4d4d8",
    background: "#fff", cursor: "pointer",
  };

  if (signature?.signed && !editing) {
    const when = signature.signed_at ? new Date(signature.signed_at).toLocaleString() : "";
    const stale = !!signature.content_stale;
    return (
      <div style={card}>
        <div style={label}>Licensee signature</div>
        {stale ? (
          <div style={{ fontSize: 13, color: "#b45309", marginBottom: 8 }}>
            ⚠ Signed{signature.signer_name ? ` by ${signature.signer_name}` : ""}{when ? ` · ${when}` : ""}, but the
            report changed after signing — clear &amp; re-sign before it can be sent.
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#16a34a", marginBottom: 8 }}>
            ✓ Signed{signature.signer_name ? ` by ${signature.signer_name}` : ""}{when ? ` · ${when}` : ""}
          </div>
        )}
        <button type="button" style={btn} onClick={clearSaved} disabled={saving}>
          Clear &amp; re-sign
        </button>
        {error ? <div style={{ color: "#dc2626", fontSize: 13, marginTop: 6 }}>{error}</div> : null}
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={label}>Licensee signature (required to send the WDO report)</div>
      <input
        type="text"
        value={signerName}
        onChange={(e) => setSignerName(e.target.value)}
        placeholder="Licensee / inspector printed name"
        style={{ width: "100%", maxWidth: 360, padding: "7px 10px", fontSize: 14, border: "1px solid #d4d4d8", borderRadius: 8, marginBottom: 8 }}
      />
      <input
        type="text"
        value={signerIdCard}
        onChange={(e) => setSignerIdCard(e.target.value)}
        placeholder="FDACS ID card number"
        style={{ width: "100%", maxWidth: 360, padding: "7px 10px", fontSize: 14, border: "1px solid #d4d4d8", borderRadius: 8, marginBottom: 8 }}
      />
      <div style={{ position: "relative", width: "100%", maxWidth: 520 }}>
        <canvas
          ref={canvasRef}
          width={520}
          height={CANVAS_CSS_HEIGHT}
          style={{ width: "100%", height: CANVAS_CSS_HEIGHT, border: "1px dashed #a1a1aa", borderRadius: 8, background: "#fff", touchAction: "none", cursor: "crosshair" }}
          onMouseDown={startDraw}
          onMouseMove={moveDraw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={moveDraw}
          onTouchEnd={endDraw}
          onTouchCancel={endDraw}
        />
      </div>
      {error ? <div style={{ color: "#dc2626", fontSize: 13, marginTop: 6 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" style={{ ...btn, background: "#0f172a", color: "#fff", borderColor: "#0f172a" }} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save signature"}
        </button>
        <button type="button" style={btn} onClick={() => initCanvas()} disabled={saving}>Clear</button>
        {signature?.signed ? (
          <button type="button" style={btn} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: "#71717a", marginTop: 6 }}>
        By signing, the licensee certifies they performed this inspection and the findings are accurate.
      </div>
    </div>
  );
}
