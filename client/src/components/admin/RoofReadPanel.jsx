import React, { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Field, Input } from "../ui";

// Staff-only roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19). The county aerial of the home, with the AI's
// likely rodent entry points drawn on it, and the technician's own count saved beside it. Every new read is a
// paid model call, so nothing here runs on its own: only the "Read the roof" tap posts. The parent shows this
// panel only while the server says the gate is on, and mounts it with a key so a new estimate, property,
// customer or lead starts from a blank panel.

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export const ROOF_TYPES = [
  { key: "roof_returns_and_valleys", label: "Roof returns and valleys" },
  { key: "plumbing_vent_stacks", label: "Plumbing vent stacks" },
  { key: "roof_vents_or_turbines", label: "Roof vents or turbines" },
  { key: "chimney_or_flue", label: "Chimney or flue" },
  { key: "ac_or_utility_line_entry", label: "AC or utility line entry" },
  { key: "soffit_or_fascia_gaps", label: "Soffit or fascia gaps" },
  { key: "gable_vents", label: "Gable vents" },
  { key: "trees_touching_roof", label: "Trees touching the roof" },
  { key: "tile_eave_open_ends", label: "Tile eave open ends" },
];

const TIER_LABELS = { low: "Low", med: "Medium", high: "High", unknown: "Could not be read" };
const LIKELY_LABELS = { yes: "Yes", no: "No", unsure: "Unsure" };
const MAX_TECH_COUNT = 500;

// A missing, blank or null coordinate is NaN, never 0.
const coordinate = (v) => (typeof v === "number" || (typeof v === "string" && v.trim()) ? Number(v) : NaN);

// The lookup doubts the address: the geocoder snapped the typed house number to another premise (marker on
// addressAudit, and on the record's _addressAudit), or the lookup raised an address verify flag
// (enriched.fieldVerifyFlags, field "address"). The map point may then be a neighbour's house.
export function roofAddressDoubtful(data) {
  const record = data?.propertyRecord || data?.rentcast || null;
  const flagged = Array.isArray(data?.enriched?.fieldVerifyFlags) && data.enriched.fieldVerifyFlags.some((f) => f?.field === "address");
  return !!(data?.addressAudit?.snappedRecord || record?._addressAudit?.snappedRecord || flagged);
}

// Where the lookup put the home: coordinates and county, or null when either is missing or the lookup doubts the address.
export function roofSpotFrom(data) {
  const record = data?.propertyRecord || data?.rentcast || null;
  if (roofAddressDoubtful(data)) return null;
  const lat = coordinate(data?.satellite?.lat ?? record?.latitude);
  const lng = coordinate(data?.satellite?.lng ?? record?.longitude);
  const county = record?._parcel?.county || record?.county || "";
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !String(county).trim()) return null;
  return { lat, lng, county: String(county) };
}

function roofFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

const PROBLEM_COPY = {
  no_image: "No county photo for this spot, so nothing was read. No charge.",
  model_failed: "The photo was found but the read failed. Try again in a minute.",
  in_progress: "Another read of this roof is still running. Wait a few seconds, then tap Try again.",
};

function techFlagsFrom(read) {
  const saved = read?.tech_final_flags || {};
  return Object.fromEntries(ROOF_TYPES.map(({ key }) => [key, saved[key] === "yes"]));
}

// The county crop with one numbered dot per pin. Pin x and y are fractions from the top-left of the picture.
function RoofImage({ url, read }) {
  const marked = ROOF_TYPES.map((t, i) => ({ ...t, n: i + 1, pins: read.flags?.[t.key]?.pins || [] })).filter((t) => t.pins.length);
  return (
    <div>
      <div className="relative w-full max-w-md aspect-square bg-zinc-100 border-hairline border-zinc-200 rounded-xs overflow-hidden" data-testid="roof-read-image">
        <img src={url} alt="County aerial photo of the roof" className="absolute inset-0 w-full h-full object-cover" />
        {marked.flatMap((t) => t.pins.map((p, i) => (
          <span
            key={`${t.key}-${i}`}
            data-testid="roof-read-pin"
            data-type={t.key}
            title={t.label}
            className="absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-zinc-900 text-white text-11 leading-5 text-center border-2 border-white"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          >
            {t.n}
          </span>
        )))}
      </div>
      {marked.length > 0 && (
        <p className="text-14 text-zinc-600 mt-2">{marked.map((t) => `${t.n} ${t.label}`).join(" · ")}</p>
      )}
    </div>
  );
}

export default function RoofReadPanel({ spot, addressDoubt = false, estimateId = null, customerId = null }) {
  const [phase, setPhase] = useState("idle");
  const [problem, setProblem] = useState("");
  const [result, setResult] = useState(null);
  const [count, setCount] = useState("");
  const [techFlags, setTechFlags] = useState(() => techFlagsFrom(null));
  // What the tech changed since the read was loaded or last saved. Only edited fields are sent.
  const [touched, setTouched] = useState({});
  const [countEdited, setCountEdited] = useState(false);
  const [saveState, setSaveState] = useState({ busy: false, msg: "", err: "" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function readRoof() {
    if (phase === "loading" || !spot || addressDoubt) return;
    setPhase("loading");
    setProblem("");
    try {
      const r = await roofFetch("/admin/roof-entry-read", {
        method: "POST",
        body: JSON.stringify({
          lat: spot.lat,
          lng: spot.lng,
          county: spot.county,
          ...(estimateId ? { estimate_id: estimateId } : {}),
          ...(customerId ? { customer_id: customerId } : {}),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!mounted.current) return;
      if (r.status === 404 && body?.enabled === false) {
        setPhase("error");
        setProblem("Roof read is switched off on the server.");
        return;
      }
      if (!r.ok && r.status !== 202) {
        setPhase("error");
        setProblem(body?.error === "reference_mismatch"
          ? "This estimate belongs to a different customer, so no read was made."
          : body?.error || "The roof read failed. Try again.");
        return;
      }
      if (body.status === "ok" && body.read && body.image_url) {
        setResult(body);
        setCount(body.read.tech_final_count == null ? "" : String(body.read.tech_final_count));
        setTechFlags(techFlagsFrom(body.read));
        setTouched({});
        setCountEdited(false);
        setSaveState({ busy: false, msg: "", err: "" });
        setPhase("ok");
        return;
      }
      setPhase(body.status in PROBLEM_COPY ? body.status : "error");
      setProblem(PROBLEM_COPY[body.status] || "The roof read failed. Try again.");
    } catch {
      if (!mounted.current) return;
      setPhase("error");
      setProblem("Could not reach the server. Try again.");
    }
  }

  async function saveTech() {
    const read = result?.read;
    if (!read || saveState.busy || !estimateId) return;
    const trimmed = countEdited ? count.trim() : "";
    if (trimmed !== "" && !(/^\d+$/.test(trimmed) && Number(trimmed) <= MAX_TECH_COUNT)) {
      setSaveState({ busy: false, msg: "", err: `Count must be a whole number from 0 to ${MAX_TECH_COUNT}.` });
      return;
    }
    const touchedKeys = ROOF_TYPES.map((t) => t.key).filter((key) => touched[key]);
    if (trimmed === "" && !touchedKeys.length) {
      setSaveState({ busy: false, msg: "", err: "Change the count or an entry point first." });
      return;
    }
    // The server merges the flags into the saved ones and writes the count only when sent, so only edited fields go.
    const flags = touchedKeys.length
      ? Object.fromEntries(touchedKeys.map((key) => [key, techFlags[key] ? "yes" : "no"]))
      : null;
    setSaveState({ busy: true, msg: "", err: "" });
    try {
      const r = await roofFetch(`/admin/roof-entry-read/${encodeURIComponent(read.id)}/tech-count`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(trimmed === "" ? {} : { count: Number(trimmed) }),
          ...(flags ? { flags } : {}),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!r.ok || !body?.read) {
        setSaveState({ busy: false, msg: "", err: body?.error || "Could not save the count. Try again." });
        return;
      }
      setResult((prev) => ({ ...prev, read: body.read }));
      // What the server holds now, then clear the edited markers.
      setCount(body.read.tech_final_count == null ? "" : String(body.read.tech_final_count));
      setTechFlags(techFlagsFrom(body.read));
      setTouched({});
      setCountEdited(false);
      setSaveState({ busy: false, msg: "Saved.", err: "" });
    } catch {
      if (mounted.current) setSaveState({ busy: false, msg: "", err: "Could not reach the server. Try again." });
    }
  }

  const read = phase === "ok" ? result?.read : null;
  return (
    <div className="space-y-3" data-testid="roof-read-panel">
      <p className="text-14 text-zinc-400 font-medium">Roof read</p>
      <p className="text-14 text-zinc-600">
        Staff only. Reads the county aerial photo for likely rodent entry points. Each new read is a paid model call, and a read of this roof
        from the last 90 days is reused at no cost. Nothing here reaches the customer.
      </p>
      {addressDoubt && (
        <p className="text-14 text-zinc-600" data-testid="roof-read-snapped">
          The map point may be a neighbour's house. Fix the address first.
        </p>
      )}
      {!spot && !addressDoubt && (
        <p className="text-14 text-zinc-600" data-testid="roof-read-no-spot">
          Look up the address first. The read needs the home's map point and county.
        </p>
      )}
      {spot && !addressDoubt && phase !== "ok" && (
        <div>
          <Button variant="secondary" size="sm" onClick={readRoof} loading={phase === "loading"} disabled={phase === "loading"} data-testid="roof-read-button">
            {phase === "idle" ? "Read the roof" : phase === "loading" ? "Reading" : "Try again"}
          </Button>
        </div>
      )}
      {problem && phase !== "ok" && phase !== "loading" && (
        <p className="text-14 text-zinc-600" role="status" data-testid={`roof-read-${phase}`}>{problem}</p>
      )}
      {read && (
        <div className="space-y-4" data-testid="roof-read-result">
          <RoofImage url={result.image_url} read={read} />
          <p className="text-14 text-zinc-600">
            {String(read.county).replace(/^./, (c) => c.toUpperCase())} County aerial, {read.image_year}.
            {result.cached ? " Reused from an earlier read." : ""}
          </p>
          <p className="text-14 text-zinc-900" data-testid="roof-read-tier">
            Entry-point tier: <span className="font-medium">{TIER_LABELS[read.tier] || read.tier}</span>
          </p>
          <div className="space-y-2" data-testid="roof-read-flags">
            <div className="grid grid-cols-[1fr_4.5rem_5rem_5rem] gap-2 text-14 text-zinc-400 font-medium">
              <span>Entry point</span><span>AI read</span><span>Tech saved</span><span>Tech saw it</span>
            </div>
            {ROOF_TYPES.map(({ key, label }) => {
              const likely = read.flags?.[key]?.likely;
              return (
                <div key={key} className="grid grid-cols-[1fr_4.5rem_5rem_5rem] gap-2 items-center text-14 text-zinc-900" data-testid={`roof-read-row-${key}`}>
                  <span>{label}</span>
                  <span data-testid={`roof-read-ai-${key}`}>{LIKELY_LABELS[likely] || "Not read"}</span>
                  <span data-testid={`roof-read-saved-${key}`}>{LIKELY_LABELS[read.tech_final_flags?.[key]] || "None"}</span>
                  <Checkbox
                    id={`roof-read-tech-${key}`}
                    aria-label={`Tech saw: ${label}`}
                    checked={!!techFlags[key]}
                    disabled={saveState.busy || !estimateId}
                    onChange={() => {
                      setTechFlags((f) => ({ ...f, [key]: !f[key] }));
                      setTouched((t) => ({ ...t, [key]: true }));
                    }}
                  />
                </div>
              );
            })}
          </div>
          <Field label="Entry points the tech counted" id="roof-read-tech-count" className="mb-2">
            <Input type="number" inputMode="numeric" min="0" max={String(MAX_TECH_COUNT)} step="1" value={count} disabled={saveState.busy || !estimateId} onChange={(e) => { setCount(e.target.value); setCountEdited(true); }} />
          </Field>
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={saveTech} loading={saveState.busy} disabled={saveState.busy || !estimateId} data-testid="roof-read-save">
              Save the tech's count
            </Button>
            {!estimateId && (
              <span className="text-14 text-zinc-600" data-testid="roof-read-save-first">Save the estimate first to record the tech's count.</span>
            )}
            {saveState.msg && <span className="text-14 text-zinc-600" role="status">{saveState.msg}</span>}
            {saveState.err && <span className="text-14 text-zinc-600" role="alert">{saveState.err}</span>}
          </div>
          <p className="text-14 text-zinc-600" data-testid="roof-read-saved">
            {read.tech_final_count == null && !read.tech_final_flags
              ? "No tech count saved yet."
              : `Saved tech count: ${read.tech_final_count == null ? "none" : read.tech_final_count}.`}
          </p>
        </div>
      )}
    </div>
  );
}
