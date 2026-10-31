// "Sold by" row on an admin estimate card (GATE_COMMISSION_SOLD_BY, owner 2026-10-29, D5 part
// 3b-1). The server sends `estimate.soldBy` only while the gate is on, so a card without it shows
// nothing. It records who sold; it pays and sends nothing. Three states:
//   - from a flag: the technician's GPS-checked field flag filled it in;
//   - set by the office: an admin chose the technician;
//   - no one: unset, or an admin cleared it.
// An admin can pick an active W-2 technician or "No one" until the customer accepts.
import React, { useEffect, useState } from "react";
import { Select, cn } from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

// One options read per page load, shared by every card on the list.
let optionsRequest = null;
function loadSellerOptions() {
  if (!optionsRequest) {
    optionsRequest = adminFetch("/admin/estimates/sold-by/options")
      .then((data) => (Array.isArray(data?.technicians) ? data.technicians : []))
      .catch((err) => {
        optionsRequest = null;
        throw err;
      });
  }
  return optionsRequest;
}

function shortDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function soldByDetail(soldBy) {
  if (!soldBy?.source || !soldBy.technicianId) return "";
  if (soldBy.source === "office") return "set by the office";
  const who = soldBy.name || "the technician";
  const truck = Number.isFinite(soldBy.gpsDistanceM)
    ? `truck ${soldBy.gpsDistanceM} m away`
    : "truck GPS checked";
  const date = shortDate(soldBy.flaggedAt);
  return `from ${who}'s flag, ${truck}${date ? `, ${date}` : ""}`;
}

export default function EstimateSoldByRow({ estimate, onChanged, className }) {
  const soldBy = estimate?.soldBy;
  const shown = Boolean(soldBy);
  const [options, setOptions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!shown) return undefined;
    let live = true;
    loadSellerOptions()
      .then((list) => { if (live) setOptions(list); })
      .catch(() => { /* the select still shows the current seller */ });
    return () => { live = false; };
  }, [shown]);

  if (!soldBy) return null;

  const accepted = Boolean(estimate.acceptedAt);
  const current = soldBy.technicianId || "";
  const known = options.some((t) => t.id === current);

  const choose = async (event) => {
    const next = event.target.value;
    setSaving(true);
    setError("");
    try {
      await adminFetch(`/admin/estimates/${encodeURIComponent(estimate.id)}/sold-by`, {
        method: "PUT",
        body: JSON.stringify({ technicianId: next || null }),
      });
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message || "Could not save Sold by");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn("mt-1 flex flex-wrap items-center gap-2 text-ui-body text-ink-secondary", className)}
      data-testid="estimate-sold-by"
    >
      <span className="text-ink-tertiary">Sold by</span>
      <span className="font-medium text-zinc-900">{soldBy.name || "No one"}</span>
      {soldByDetail(soldBy) && <span>{soldByDetail(soldBy)}</span>}
      <Select
        size="sm"
        aria-label="Sold by"
        value={current}
        disabled={accepted || saving}
        onChange={choose}
        onClick={(evt) => evt.stopPropagation()}
        className="w-auto min-w-[9rem]"
        title={accepted ? "Sold by is locked once the customer accepts." : undefined}
      >
        <option value="">No one</option>
        {!known && current && <option value={current}>{soldBy.name || "Current seller"}</option>}
        {options.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </Select>
      {error && <span role="alert" className="text-alert-fg">{error}</span>}
    </div>
  );
}
