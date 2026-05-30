import { useState, useEffect, useCallback } from "react";
import { Inbox } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  text: "#27272A",
  muted: "#71717A",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};

// Mirrors the customer portal lifecycle (PortalPage STATUS_ORDER) and the
// server's allowed statuses (routes/admin-requests.js).
const STATUSES = ["new", "acknowledged", "scheduled", "resolved"];
const STATUS_LABEL = {
  new: "New",
  acknowledged: "Acknowledged",
  scheduled: "Scheduled",
  resolved: "Resolved",
};
const STATUS_COLOR = {
  new: D.red,
  acknowledged: D.amber,
  scheduled: "#1D4ED8",
  resolved: D.green,
};

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

function customerName(req) {
  const name = `${req.customerFirstName || ""} ${req.customerLastName || ""}`.trim();
  return name || req.customerEmail || "Customer";
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function RequestsPage() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [savingId, setSavingId] = useState(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const data = await adminFetch(`/admin/requests${params.toString() ? `?${params}` : ""}`);
      setRequests(data.requests || []);
    } catch (err) {
      setError(err.message || "Failed to load requests");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const changeStatus = async (req, nextStatus) => {
    if (nextStatus === req.status) return;
    setSavingId(req.id);
    setNotice("");
    try {
      const data = await adminFetch(`/admin/requests/${req.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setRequests((prev) => prev.map((r) => (r.id === req.id ? { ...r, ...data.request } : r)));
      if (data.statusChanged) {
        setNotice(`${customerName(req)} notified: ${STATUS_LABEL[nextStatus] || nextStatus}`);
      }
    } catch (err) {
      setError(err.message || "Failed to update request");
    } finally {
      setSavingId(null);
    }
  };

  const filters = [{ key: "", label: "All" }, ...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] }))];

  return (
    <div style={{ background: D.bg, minHeight: "100vh" }}>
      <AdminCommandHeader title="Requests" icon={Inbox} ariaLabel="Service requests" />

      <div style={{ padding: "0 16px 32px", maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {filters.map((f) => (
            <button
              key={f.key || "all"}
              onClick={() => setStatusFilter(f.key)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: `1px solid ${statusFilter === f.key ? D.heading : D.inputBorder}`,
                background: statusFilter === f.key ? D.heading : D.card,
                color: statusFilter === f.key ? "#fff" : D.text,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {notice && (
          <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, background: "#ECFDF5", color: D.green, fontSize: 13, border: `1px solid #A7F3D0` }}>
            {notice}
          </div>
        )}
        {error && (
          <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, background: "#FEF2F2", color: D.red, fontSize: 13, border: `1px solid #FECACA` }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading requests…</div>
        ) : requests.length === 0 ? (
          <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>No service requests{statusFilter ? ` with status “${STATUS_LABEL[statusFilter]}”` : ""}.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {requests.map((req) => (
              <div
                key={req.id}
                style={{
                  background: D.card,
                  border: `1px solid ${D.border}`,
                  borderRadius: 8,
                  padding: 14,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[req.status] || D.muted, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: D.heading, fontSize: 15 }}>{req.subject || "Service request"}</span>
                  </div>
                  <div style={{ color: D.muted, fontSize: 13 }}>
                    {customerName(req)}
                    {req.category ? ` · ${String(req.category).replace(/_/g, " ")}` : ""}
                    {req.urgency === "urgent" ? " · Urgent" : ""}
                    {req.createdAt ? ` · ${formatDate(req.createdAt)}` : ""}
                  </div>
                  {req.description && (
                    <div style={{ color: D.text, fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>{req.description}</div>
                  )}
                </div>

                <select
                  value={req.status}
                  disabled={savingId === req.id}
                  onChange={(e) => changeStatus(req, e.target.value)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: `1px solid ${D.inputBorder}`,
                    background: "#fff",
                    color: D.text,
                    fontSize: 13,
                    cursor: savingId === req.id ? "wait" : "pointer",
                  }}
                  aria-label={`Status for ${req.subject || "request"}`}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
