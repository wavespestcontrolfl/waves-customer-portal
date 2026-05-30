import { useRef, useState, useEffect, useCallback } from "react";
import { adminFetch } from "../../lib/adminFetch";

/**
 * Licensee e-signature capture for WDO inspection reports. A WDO report is an
 * official FDACS-13645 filing and must carry the licensee signature before it
 * can be sent, so this gates the send buttons upstream. Draws to a canvas,
 * exports a PNG data URL, and POSTs to /admin/projects/:id/wdo-signature.
 */
export default function WdoSignaturePad({ projectId, signature, defaultSignerName = "", defaultSignerIdCard = "", onChanged }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasDrawn = useRef(false);
  const [signerName, setSignerName] = useState(defaultSignerName);
  const [signerIdCard, setSignerIdCard] = useState(defaultSignerIdCard);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(!signature?.signed);

  const initCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
    hasDrawn.current = false;
  }, []);

  useEffect(() => {
    if (editing) initCanvas();
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
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Could not save signature");
      }
      setEditing(false);
      onChanged?.();
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
      await adminFetch(`/admin/projects/${projectId}/wdo-signature`, { method: "DELETE" });
      setEditing(true);
      onChanged?.();
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
    return (
      <div style={card}>
        <div style={label}>Licensee signature</div>
        <div style={{ fontSize: 13, color: "#16a34a", marginBottom: 8 }}>
          ✓ Signed{signature.signer_name ? ` by ${signature.signer_name}` : ""}{when ? ` · ${when}` : ""}
        </div>
        <button type="button" style={btn} onClick={clearSaved} disabled={saving}>
          Clear &amp; re-sign
        </button>
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
      <div style={{ position: "relative", width: "100%", maxWidth: 520 }}>
        <canvas
          ref={canvasRef}
          width={520}
          height={160}
          style={{ width: "100%", height: 160, border: "1px dashed #a1a1aa", borderRadius: 8, background: "#fff", touchAction: "none", cursor: "crosshair" }}
          onMouseDown={startDraw}
          onMouseMove={moveDraw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={moveDraw}
          onTouchEnd={endDraw}
        />
      </div>
      {error ? <div style={{ color: "#dc2626", fontSize: 13, marginTop: 6 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" style={{ ...btn, background: "#0f172a", color: "#fff", borderColor: "#0f172a" }} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save signature"}
        </button>
        <button type="button" style={btn} onClick={initCanvas} disabled={saving}>Clear</button>
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
