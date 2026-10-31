import { useEffect, useState } from "react";

// Territories read-out (GATE_TERRITORY_READOUT, owner 2026-10-30, Waves Territory Map
// build 3): stops a week per technician and area, booked over the next 4 weeks and done
// over the last 4, so the re-cut rule is a number on the Team tab. The Team tab renders
// this card only while the roster response marks `territoryReadoutEnabled`. Read only.
const API_BASE = import.meta.env.VITE_API_URL || "/api";

const D = {
  card: "#FFFFFF",
  border: "#E4E4E7",
  text: "#27272A",
  muted: "#71717A",
  heading: "#09090B",
  red: "#991B1B",
};

const cell = { padding: "6px 8px", borderBottom: `1px solid ${D.border}`, fontSize: 14, color: D.text, textAlign: "left" };
const num = { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" };

const perWeek = (count, weeks) => (weeks > 0 ? (count / weeks).toFixed(1) : "0.0");

// One block per technician (unassigned last), its areas in the server's order, then a total.
function groupByTechnician(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.technicianId || "unassigned";
    if (!groups.has(key)) groups.set(key, { key, name: row.technicianName || "No technician", rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => (a.key === "unassigned") - (b.key === "unassigned"));
}

export default function TerritoryReadoutCard() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/admin/timetracking/territory-readout`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => { if (live) setData(body); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const weeks = data?.weeks || 4;
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 6, padding: 16, marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: D.heading }}>Territories</h3>
      <p style={{ margin: "0 0 12px", fontSize: 14, color: D.muted }}>
        Stops a week per technician and area: booked over the next {weeks} weeks, done over the last {weeks}.
      </p>
      {failed && (
        <p role="alert" style={{ margin: 0, fontSize: 14, color: D.red }}>The territory read-out could not be loaded.</p>
      )}
      {!failed && !data && <p style={{ margin: 0, fontSize: 14, color: D.muted }}>Loading…</p>}
      {data && data.rows.length === 0 && <p style={{ margin: 0, fontSize: 14, color: D.muted }}>No stops in these weeks.</p>}
      {data && data.rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={cell}>Technician</th>
                <th style={cell}>Area</th>
                <th style={num}>Booked a week</th>
                <th style={num}>Done a week</th>
              </tr>
            </thead>
            <tbody>
              {groupByTechnician(data.rows).map((group) => {
                const booked = group.rows.reduce((n, r) => n + r.booked, 0);
                const done = group.rows.reduce((n, r) => n + r.done, 0);
                return [
                  ...group.rows.map((row) => (
                    <tr key={`${group.key}:${row.area || "none"}`}>
                      <td style={cell}>{group.name}</td>
                      <td style={cell}>{row.areaLabel || "No area (ZIP outside the map)"}</td>
                      <td style={num}>{perWeek(row.booked, weeks)}</td>
                      <td style={num}>{perWeek(row.done, weeks)}</td>
                    </tr>
                  )),
                  <tr key={`${group.key}:total`}>
                    <td style={{ ...cell, fontWeight: 600 }}>{group.name}</td>
                    <td style={{ ...cell, fontWeight: 600 }}>Total</td>
                    <td style={{ ...num, fontWeight: 600 }}>{perWeek(booked, weeks)}</td>
                    <td style={{ ...num, fontWeight: 600 }}>{perWeek(done, weeks)}</td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
