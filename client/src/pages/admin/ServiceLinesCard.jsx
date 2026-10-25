import { useCallback, useEffect, useState } from "react";

// Service lines (GATE_SERVICE_LINE_MAP=shadow, owner 2026-10-25): which technician is
// the home tech and which covers the gaps for each service line. SHADOW ONLY: saving
// this changes no booking; the six booking choice points only log what the map would
// pick. The Team tab renders this card only while the server marks the roster response
// `serviceLinesEnabled`.
const API_BASE = import.meta.env.VITE_API_URL || "/api";

const D = {
  card: "#FFFFFF",
  border: "#E4E4E7",
  text: "#27272A",
  muted: "#71717A",
  heading: "#09090B",
  input: "#FFFFFF",
  inputBorder: "#D4D4D8",
  red: "#991B1B",
};

export const SERVICE_LINES = [
  { key: "general", label: "General pest" },
  { key: "mosquito", label: "Mosquito" },
  { key: "lawn", label: "Lawn / tree & shrub" },
  { key: "rodent", label: "Rodent" },
  { key: "termite", label: "Termite / WDO" },
];

function lineFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const selectStyle = {
  minHeight: 44,
  width: "100%",
  padding: "0 10px",
  background: D.input,
  color: D.text,
  border: `1px solid ${D.inputBorder}`,
  borderRadius: 4,
  fontSize: 14,
};

const labelStyle = { display: "block", fontSize: 12, color: D.muted, marginBottom: 4 };

function techOptions(techs, selectedIds) {
  const wanted = new Set(selectedIds.filter(Boolean));
  return (techs || [])
    .filter((t) => {
      const status = t.employment_status || (t.active ? "active" : "inactive");
      return status === "active" || status === "prospective" || wanted.has(t.id);
    })
    .map((t) => {
      const status = t.employment_status || (t.active ? "active" : "inactive");
      const suffix = status === "prospective" ? " (not started)" : status === "inactive" ? " (inactive)" : "";
      return { id: t.id, label: `${t.name}${suffix}` };
    });
}

export default function ServiceLinesCard({ techs = [], showToast = () => {} }) {
  const [rows, setRows] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await lineFetch("/admin/timetracking/service-lines");
      const byLine = new Map((res.lines || []).map((l) => [l.service_category, l]));
      setRows(
        SERVICE_LINES.map(({ key }) => ({
          service_category: key,
          home_technician_id: byLine.get(key)?.home_technician_id || "",
          gap_technician_id: byLine.get(key)?.gap_technician_id || "",
        })),
      );
      setError("");
    } catch {
      setError("Service lines could not be loaded.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setField = (key, field, value) =>
    setRows((prev) => prev.map((r) => (r.service_category === key ? { ...r, [field]: value } : r)));

  const save = async () => {
    setSaving(true);
    try {
      await lineFetch("/admin/timetracking/service-lines", {
        method: "PUT",
        body: JSON.stringify({
          lines: rows.map((r) => ({
            service_category: r.service_category,
            home_technician_id: r.home_technician_id || null,
            gap_technician_id: r.gap_technician_id || null,
          })),
        }),
      });
      showToast("Service lines saved");
      load();
    } catch (e) {
      showToast("Failed: " + e.message);
    }
    setSaving(false);
  };

  return (
    <section
      aria-label="Service lines"
      style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 6, padding: 16, marginBottom: 12 }}
    >
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: D.heading }}>Service lines</h3>
      <p style={{ margin: "0 0 12px", fontSize: 14, color: D.muted }}>
        The home tech takes the line; the gap tech covers days the home tech is off or out. Shadow only:
        this records what it would pick and changes no booking.
      </p>
      {error && (
        <p role="alert" style={{ margin: "0 0 12px", fontSize: 14, color: D.red }}>
          {error}
        </p>
      )}
      {rows && (
        <div style={{ display: "grid", gap: 12 }}>
          {SERVICE_LINES.map(({ key, label }) => {
            const row = rows.find((r) => r.service_category === key);
            const options = techOptions(techs, [row.home_technician_id, row.gap_technician_id]);
            return (
              <div
                key={key}
                role="group"
                aria-label={label}
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, alignItems: "end" }}
              >
                <div style={{ fontSize: 14, fontWeight: 500, color: D.heading, alignSelf: "center" }}>{label}</div>
                {[
                  ["home_technician_id", "Home tech"],
                  ["gap_technician_id", "Gap tech"],
                ].map(([field, title]) => (
                  <div key={field}>
                    <label htmlFor={`line-${key}-${field}`} style={labelStyle}>
                      {title}
                    </label>
                    <select
                      id={`line-${key}-${field}`}
                      aria-label={`${label} ${title}`}
                      value={row[field]}
                      onChange={(e) => setField(key, field, e.target.value)}
                      style={selectStyle}
                    >
                      <option value="">None</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={save}
          disabled={saving || !rows}
          style={{
            minHeight: 44,
            padding: "0 16px",
            background: D.heading,
            color: "#FFFFFF",
            border: `1px solid ${D.heading}`,
            borderRadius: 4,
            fontSize: 14,
            fontWeight: 500,
            cursor: saving || !rows ? "default" : "pointer",
            opacity: saving || !rows ? 0.5 : 1,
          }}
        >
          {saving ? "Saving…" : "Save service lines"}
        </button>
      </div>
    </section>
  );
}
