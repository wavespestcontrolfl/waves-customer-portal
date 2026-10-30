// Misting system records for the office (Customer 360, admin only; dark behind GATE_MOSQUITO_MISTING).
//
// Two records for an automatic mosquito misting system: the install calibration (the spray-rate math
// done at install, checked against the pesticide label's daily limit) and one row per tank refill.
// GET /api/admin/misting-records/customers/:id/records answers 404 while the gate is off, and the panel then
// renders nothing at all. The server is the authority: it recomputes and stores every number and
// refuses an over-label schedule; the preview here (lib/mistingCalibrationMath.js) is the same math,
// so staff see the refusal coming. Rows are never deleted; an admin voids one with a reason.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminFetch } from "../../utils/admin-fetch";
import { Button, Checkbox, Field, Input, Textarea, cn } from "../ui";
import { etDateString, formatETDate, formatETDateOnly } from "../../lib/timezone";
import { computeCalibration, formatOzPair, overLabelMessage } from "../../lib/mistingCalibrationMath";
import PRODUCT_FILE from "../../../../shared/misting-products.json";

const BASE = "/admin/misting-records";
const PRODUCTS = PRODUCT_FILE.products;
const SECTOR = PRODUCTS.find((p) => p.key === "sector");
const REFILLS_SHOWN = 10;

const productByEpa = (epa) => PRODUCTS.find((p) => p.epaRegNo.toLowerCase() === String(epa || "").trim().toLowerCase()) || null;

// Sector's label rate for a tank of this size, to one decimal: 64 for 55 gal, 11.6 for 10 gal.
function defaultConcentrate(tank) {
  const t = Number(tank);
  if (!Number.isFinite(t) || t <= 0) return "";
  const perGal = SECTOR.labelRateMix.concentrateFlOz / SECTOR.labelRateMix.waterGal;
  return String(Math.round(perGal * t * 10) / 10);
}

function blankCalibration() {
  return {
    propertyId: "",
    installedOn: etDateString(),
    vendor: "Pynamite",
    model: "",
    serialNumber: "",
    tankGallons: "55",
    zoneCount: "1",
    nozzleCount: "",
    riserCount: "0",
    nozzleFlowFlOzPerMin: "",
    cycleSeconds: "45",
    mistTimes: ["06:30", "19:30", "22:30"],
    productName: SECTOR.name,
    epaRegNo: SECTOR.epaRegNo,
    concentrateFlOzPerTank: defaultConcentrate("55"),
    labelMaxFlOzPer1000CuFtDay: String(SECTOR.labelMaxFlOzPer1000CuFtPerDay),
    treatedAreaSqFt: "",
    treatedHeightFt: "",
    cabinetLocked: false,
    labelPosted: false,
    scheduleAvoidsPeople: false,
    notes: "",
  };
}

// A new calibration starts from the current one. The three install checks start unticked: they are
// confirmed again each time.
function fromCalibration(cal, primaryId) {
  const text = (v) => (v === null || v === undefined ? "" : String(v));
  return {
    propertyId: cal.propertyId || primaryId || "",
    installedOn: cal.installedOn || etDateString(),
    vendor: cal.vendor,
    model: cal.model,
    serialNumber: text(cal.serialNumber),
    tankGallons: text(cal.tankGallons),
    zoneCount: text(cal.zoneCount),
    nozzleCount: text(cal.nozzleCount),
    riserCount: text(cal.riserCount),
    nozzleFlowFlOzPerMin: text(cal.nozzleFlowFlOzPerMin),
    cycleSeconds: text(cal.cycleSeconds),
    mistTimes: [...cal.mistTimes],
    productName: cal.productName,
    epaRegNo: cal.epaRegNo,
    concentrateFlOzPerTank: text(cal.concentrateFlOzPerTank),
    labelMaxFlOzPer1000CuFtDay: text(cal.labelMaxFlOzPer1000CuFtDay),
    treatedAreaSqFt: text(cal.treatedAreaSqFt),
    treatedHeightFt: text(cal.treatedHeightFt),
    cabinetLocked: false,
    labelPosted: false,
    scheduleAvoidsPeople: false,
    notes: "",
  };
}

const num = (v) => (String(v ?? "").trim() === "" ? undefined : Number(v));

function calibrationPayload(f) {
  return {
    propertyId: f.propertyId || undefined,
    installedOn: f.installedOn,
    vendor: f.vendor,
    model: f.model,
    serialNumber: f.serialNumber,
    tankGallons: num(f.tankGallons),
    zoneCount: num(f.zoneCount),
    nozzleCount: num(f.nozzleCount),
    riserCount: num(f.riserCount),
    nozzleFlowFlOzPerMin: num(f.nozzleFlowFlOzPerMin),
    cycleSeconds: num(f.cycleSeconds),
    mistTimes: f.mistTimes,
    productName: f.productName,
    epaRegNo: f.epaRegNo,
    concentrateFlOzPerTank: num(f.concentrateFlOzPerTank),
    labelMaxFlOzPer1000CuFtDay: num(f.labelMaxFlOzPer1000CuFtDay),
    treatedAreaSqFt: num(f.treatedAreaSqFt),
    treatedHeightFt: num(f.treatedHeightFt),
    cabinetLocked: f.cabinetLocked,
    labelPosted: f.labelPosted,
    scheduleAvoidsPeople: f.scheduleAvoidsPeople,
    notes: f.notes,
  };
}

// The live line under the form, or null until the numbers are complete.
function previewFor(f) {
  const input = {
    tankGallons: num(f.tankGallons),
    nozzleCount: num(f.nozzleCount),
    riserCount: num(f.riserCount),
    nozzleFlowFlOzPerMin: num(f.nozzleFlowFlOzPerMin),
    cycleSeconds: num(f.cycleSeconds),
    mistTimes: f.mistTimes,
    treatedAreaSqFt: num(f.treatedAreaSqFt),
    treatedHeightFt: num(f.treatedHeightFt),
    labelMaxFlOzPer1000CuFtDay: num(f.labelMaxFlOzPer1000CuFtDay),
    concentrateFlOzPerTank: num(f.concentrateFlOzPerTank),
  };
  const positive = ["tankGallons", "nozzleFlowFlOzPerMin", "cycleSeconds", "treatedAreaSqFt", "treatedHeightFt", "labelMaxFlOzPer1000CuFtDay", "concentrateFlOzPerTank"];
  if (positive.some((k) => !Number.isFinite(input[k]) || input[k] <= 0)) return null;
  if (!Number.isFinite(input.nozzleCount) || !Number.isFinite(input.riserCount) || input.nozzleCount + input.riserCount < 1) return null;
  if (!input.mistTimes.length) return null;
  const result = computeCalibration(input, productByEpa(f.epaRegNo));
  const [daily, cap] = formatOzPair(result.dailyOutputFlOz, result.labelDailyCapFlOz);
  return {
    over: !result.withinLabel,
    text: result.withinLabel
      ? `Puts out ${daily} fl oz a day. The label allows ${cap} at this mix.${result.strengthFactor > 1 ? " Stronger mix: the daily limit is lower." : ""}`
      : overLabelMessage(result.dailyOutputFlOz, result.labelDailyCapFlOz),
  };
}

function clock(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const ozLine = (cal) => {
  const [daily, cap] = formatOzPair(cal.dailyOutputFlOz, cal.labelDailyCapFlOz);
  return `Puts out ${daily} fl oz a day. The label allows ${cap}.`;
};
const dayOf = (iso) => (iso ? formatETDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "");

function Row({ label, children }) {
  return (
    <div className="flex gap-2 text-ui-body">
      <span className="w-28 shrink-0 text-ink-secondary">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function VoidBox({ state, onChange, onConfirm, onCancel }) {
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-2">
      <Field label="Why void this record?" help="3 to 300 characters. The row stays on file, struck through.">
        <Input value={state.reason} onChange={(e) => onChange(e.target.value)} maxLength={300} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="danger" onClick={onConfirm} disabled={state.busy || state.reason.trim().length < 3}>
          {state.busy ? "Voiding…" : "Void record"}
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={state.busy}>Cancel</Button>
        {state.err && <span role="alert" className="text-ui-label text-alert-fg">{state.err}</span>}
      </div>
    </div>
  );
}

function CalibrationForm({ initial, properties, onSaved, onCancel, customerId }) {
  const [form, setForm] = useState(initial);
  const [concentrateEdited, setConcentrateEdited] = useState(Boolean(initial.concentrateFlOzPerTank) && initial.concentrateFlOzPerTank !== defaultConcentrate(initial.tankGallons));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const text = (key) => ({ value: form[key], onChange: (e) => set({ [key]: e.target.value }) });
  const preview = useMemo(() => previewFor(form), [form]);

  const setTank = (value) => {
    // The concentrate follows the tank size until staff type their own.
    set(concentrateEdited ? { tankGallons: value } : { tankGallons: value, concentrateFlOzPerTank: defaultConcentrate(value) });
  };
  const setTime = (i, value) => set({ mistTimes: form.mistTimes.map((t, n) => (n === i ? value : t)) });

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setErr("");
    try {
      const res = await adminFetch(`${BASE}/customers/${customerId}/calibrations`, {
        method: "POST",
        body: JSON.stringify(calibrationPayload(form)),
      });
      onSaved(res?.calibration);
    } catch (error) {
      setErr(error.message || "Could not save the calibration.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3" aria-label="Install calibration">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {properties.length >= 2 && (
          <Field label="Property" required>
            <select className="ui-control block h-11 w-full rounded-sm border-hairline border-zinc-300 bg-white px-3 text-16 md:h-9 md:text-13" {...text("propertyId")}>
              <option value="">Pick a property</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Installed on" required><Input type="date" {...text("installedOn")} /></Field>
        <Field label="Vendor" required><Input {...text("vendor")} maxLength={60} /></Field>
        <Field label="Model" required><Input {...text("model")} maxLength={120} /></Field>
        <Field label="Serial number"><Input {...text("serialNumber")} maxLength={80} /></Field>
        <Field label="Tank (gal)" required><Input type="number" inputMode="decimal" min="1" max="300" step="any" value={form.tankGallons} onChange={(e) => setTank(e.target.value)} /></Field>
        <Field label="Zones" required><Input type="number" inputMode="numeric" min="1" max="4" step="1" {...text("zoneCount")} /></Field>
        <Field label="Nozzles" required><Input type="number" inputMode="numeric" min="0" max="240" step="1" {...text("nozzleCount")} /></Field>
        <Field label="Risers" help="Each riser carries one nozzle." required><Input type="number" inputMode="numeric" min="0" max="240" step="1" {...text("riserCount")} /></Field>
        <Field label="Flow per nozzle (fl oz a minute)" help="Time one nozzle into a measuring cup for 60 seconds." required>
          <Input type="number" inputMode="decimal" min="0.01" max="10" step="any" {...text("nozzleFlowFlOzPerMin")} />
        </Field>
        <Field label="Mist length (seconds)" required><Input type="number" inputMode="numeric" min="5" max="600" step="1" {...text("cycleSeconds")} /></Field>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="ui-label text-ink-secondary">Mist times (Eastern)</legend>
        <div className="flex flex-wrap items-center gap-2">
          {form.mistTimes.map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <Input type="time" aria-label={`Mist time ${i + 1}`} value={t} onChange={(e) => setTime(i, e.target.value)} className="!w-32" />
              {form.mistTimes.length > 1 && (
                <Button size="sm" variant="ghost" aria-label={`Remove mist time ${i + 1}`} onClick={() => set({ mistTimes: form.mistTimes.filter((_, n) => n !== i) })}>×</Button>
              )}
            </span>
          ))}
          {form.mistTimes.length < 12 && (
            <Button size="sm" variant="secondary" onClick={() => set({ mistTimes: [...form.mistTimes, "12:00"] })}>Add time</Button>
          )}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Product" required><Input {...text("productName")} maxLength={120} /></Field>
        <Field label="EPA reg. no." required><Input {...text("epaRegNo")} maxLength={40} /></Field>
        <Field label="Concentrate in a full tank (fl oz)" help={productByEpa(form.epaRegNo) ? `The ${productByEpa(form.epaRegNo).shortName} label mixes ${productByEpa(form.epaRegNo).labelRateMix.concentrateFlOz} to ${productByEpa(form.epaRegNo).maxMix.concentrateFlOz} fl oz in ${productByEpa(form.epaRegNo).labelRateMix.waterGal} gal.` : undefined} required>
          <Input type="number" inputMode="decimal" min="0" step="any" value={form.concentrateFlOzPerTank} onChange={(e) => { setConcentrateEdited(true); set({ concentrateFlOzPerTank: e.target.value }); }} />
        </Field>
        <Field label="Label limit (fl oz per 1,000 cu ft a day)" help="Finished solution, from the product label." required>
          <Input type="number" inputMode="decimal" min="0" step="any" {...text("labelMaxFlOzPer1000CuFtDay")} />
        </Field>
        <Field label="Treated area (sq ft)" required><Input type="number" inputMode="decimal" min="100" max="200000" step="any" {...text("treatedAreaSqFt")} /></Field>
        <Field label="Mist height (ft)" help="The height the mist reaches, up to 15 ft." required>
          <Input type="number" inputMode="decimal" min="1" max="15" step="any" {...text("treatedHeightFt")} />
        </Field>
      </div>

      {preview && (
        <div role="status" data-testid="misting-preview" className={cn("text-ui-body", preview.over ? "text-alert-fg" : "text-zinc-900")}>
          {preview.text}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Checkbox id="misting-check-cabinet" label="Lock the cabinet" checked={form.cabinetLocked} onChange={(e) => set({ cabinetLocked: e.target.checked })} />
        <Checkbox id="misting-check-label" label="Post the label and dilution statement at the unit" checked={form.labelPosted} onChange={(e) => set({ labelPosted: e.target.checked })} />
        <Checkbox id="misting-check-schedule" label="Set mist times when people and pets are not outside" checked={form.scheduleAvoidsPeople} onChange={(e) => set({ scheduleAvoidsPeople: e.target.checked })} />
      </div>

      <Field label="Notes"><Textarea rows={2} maxLength={2000} {...text("notes")} /></Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save calibration"}</Button>
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        {err && <span role="alert" className="text-ui-label text-alert-fg">{err}</span>}
      </div>
    </form>
  );
}

function RefillForm({ calibration, onSaved, onCancel, onNewCalibration, customerId }) {
  const [form, setForm] = useState({
    refilledOn: etDateString(),
    concentrateFlOzAdded: String(calibration.concentrateFlOzPerTank),
    waterGallonsAdded: String(calibration.tankGallons),
    levelBeforePct: "",
    counterReset: false,
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const text = (key) => ({ value: form[key], onChange: (e) => set({ [key]: e.target.value }) });

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setErr("");
    try {
      const res = await adminFetch(`${BASE}/customers/${customerId}/refills`, {
        method: "POST",
        body: JSON.stringify({
          calibrationId: calibration.id,
          refilledOn: form.refilledOn,
          productName: calibration.productName,
          epaRegNo: calibration.epaRegNo,
          concentrateFlOzAdded: num(form.concentrateFlOzAdded),
          waterGallonsAdded: num(form.waterGallonsAdded),
          levelBeforePct: num(form.levelBeforePct),
          counterReset: form.counterReset,
          notes: form.notes,
        }),
      });
      onSaved(res?.refill);
    } catch (error) {
      setErr(error.message || "Could not save the refill.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3" aria-label="Log refill">
      <div className="text-ui-body">
        <div>{calibration.productName} (EPA Reg. No. {calibration.epaRegNo})</div>
        <button data-ui-text-action type="button" className="text-ui-label text-ink-secondary underline u-focus-ring" onClick={onNewCalibration}>
          Product changed? Record a new calibration.
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Refill date" required><Input type="date" {...text("refilledOn")} /></Field>
        <Field label="Concentrate added (fl oz)" required><Input type="number" inputMode="decimal" min="0" step="any" {...text("concentrateFlOzAdded")} /></Field>
        <Field label="Water added (gal)" required><Input type="number" inputMode="decimal" min="0" step="any" {...text("waterGallonsAdded")} /></Field>
        <Field label="Level before (%)" help="Optional."><Input type="number" inputMode="numeric" min="0" max="100" step="1" {...text("levelBeforePct")} /></Field>
      </div>
      <Checkbox id="misting-counter-reset" label="Counter reset" checked={form.counterReset} onChange={(e) => set({ counterReset: e.target.checked })} />
      <Field label="Notes"><Textarea rows={2} maxLength={2000} {...text("notes")} /></Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save refill"}</Button>
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        {err && <span role="alert" className="text-ui-label text-alert-fg">{err}</span>}
      </div>
    </form>
  );
}

export default function MistingRecordsPanel({ customerId }) {
  const [status, setStatus] = useState("loading"); // loading | off | ready | error
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(null); // { type: 'calibrate', base } | { type: 'refill', calibration }
  const [voiding, setVoiding] = useState(null); // { kind, id, reason, busy, err }
  const [showEarlier, setShowEarlier] = useState(false);
  const [showAllRefills, setShowAllRefills] = useState(false);
  const [msg, setMsg] = useState("");
  const [nonce, setNonce] = useState(0);
  const customerRef = useRef(customerId);

  // The 360 sheet swaps customers in place: drop everything per-customer on a switch, same rule as
  // the other panels on this sheet.
  useEffect(() => {
    customerRef.current = customerId;
    setStatus("loading");
    setData(null);
    setLoadErr("");
    setOpen(false);
    setMode(null);
    setVoiding(null);
    setShowEarlier(false);
    setShowAllRefills(false);
    setMsg("");
  }, [customerId]);

  useEffect(() => {
    let cancelled = false;
    adminFetch(`${BASE}/customers/${customerId}/records`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        // 404: the gate is off (or no such customer). 403: not an admin. Either way, no panel.
        if (e.status === 404 || e.status === 403) {
          setStatus("off");
        } else {
          setLoadErr(e.message || "Could not load the misting records.");
          setStatus("error");
        }
      });
    return () => { cancelled = true; };
  }, [customerId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  if (status === "loading" || status === "off") return null;

  const properties = data?.properties || [];
  const calibrations = data?.calibrations || [];
  const refills = data?.refills || [];
  const primaryId = properties.find((p) => p.isPrimary)?.id || properties[0]?.id || "";
  const current = calibrations.filter((c) => c.isCurrent);
  const earlier = calibrations.filter((c) => !c.isCurrent);
  const propertyName = (propertyId) => {
    if (properties.length < 2) return "";
    const hit = properties.find((p) => p.id === (propertyId || primaryId));
    return hit?.label || "";
  };
  const currentFor = (propertyId) => current.find((c) => (c.propertyId || primaryId) === (propertyId || primaryId));
  const homesWithoutSystem = properties.filter((p) => !currentFor(p.id));

  const saved = (text) => {
    setMode(null);
    setMsg(text);
    reload();
  };

  const confirmVoid = async () => {
    const v = voiding;
    setVoiding({ ...v, busy: true, err: "" });
    try {
      await adminFetch(`${BASE}/${v.kind === "calibration" ? "calibrations" : "refills"}/${v.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: v.reason.trim() }),
      });
      if (customerRef.current !== customerId) return;
      setVoiding(null);
      setMsg("Voided.");
      reload();
    } catch (e) {
      if (customerRef.current === customerId) setVoiding({ ...v, busy: false, err: e.message || "Could not void the record." });
    }
  };

  const startVoid = (kind, id) => { setMsg(""); setVoiding({ kind, id, reason: "", busy: false, err: "" }); };
  const voidBox = (kind, id) => voiding && voiding.kind === kind && voiding.id === id && (
    <VoidBox
      state={voiding}
      onChange={(reason) => setVoiding({ ...voiding, reason })}
      onConfirm={confirmVoid}
      onCancel={() => setVoiding(null)}
    />
  );

  const shownRefills = showAllRefills ? refills : refills.slice(0, REFILLS_SHOWN);

  return (
    <div className="mb-4 pb-3 border-b border-hairline border-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <div className="c360-section-heading ui-label text-ink-secondary mb-0">Misting system</div>
        <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-4">
          {status === "error" && (
            <div className="flex items-center gap-3">
              <span role="alert" className="text-ui-body text-alert-fg">{loadErr}</span>
              <Button size="sm" variant="secondary" onClick={() => { setStatus("loading"); reload(); }}>Retry</Button>
            </div>
          )}
          {msg && <div role="status" className="text-ui-label text-zinc-700">{msg}</div>}

          {status === "ready" && current.length === 0 && mode?.type !== "calibrate" && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-ui-body text-ink-secondary">No misting system on file.</span>
              <Button size="sm" onClick={() => { setMsg(""); setMode({ type: "calibrate", base: null }); }}>Record install calibration</Button>
            </div>
          )}

          {current.map((cal) => (
            <div key={cal.id} className="flex flex-col gap-1">
              {propertyName(cal.propertyId) && <div className="ui-label text-ink-secondary">{propertyName(cal.propertyId)}</div>}
              <Row label="System">{cal.vendor} {cal.model}, {cal.tankGallons} gal tank, {cal.zoneCount} {cal.zoneCount === 1 ? "zone" : "zones"}{cal.serialNumber ? `, serial ${cal.serialNumber}` : ""}</Row>
              <Row label="Emitters">{cal.nozzleCount} nozzles, {cal.riserCount} risers</Row>
              <Row label="Product">{cal.productName} (EPA Reg. No. {cal.epaRegNo})</Row>
              <Row label="Mix">{cal.concentrateFlOzPerTank} fl oz of concentrate in {cal.tankGallons} gal</Row>
              <Row label="Mist times">{cal.mistTimes.map(clock).join(", ")}, {cal.cycleSeconds} seconds each</Row>
              <Row label="Daily output">{ozLine(cal)}</Row>
              <Row label="Recorded">by {cal.recordedBy?.name || "staff"}, {dayOf(cal.createdAt)} (installed {formatETDateOnly(cal.installedOn, { month: "short", day: "numeric", year: "numeric" })})</Row>
              {cal.notes && <Row label="Notes">{cal.notes}</Row>}
              {mode?.type === "refill" && mode.calibration.id === cal.id && (
                <RefillForm
                  customerId={customerId}
                  calibration={cal}
                  onCancel={() => setMode(null)}
                  onNewCalibration={() => setMode({ type: "calibrate", base: cal })}
                  onSaved={() => saved("Refill saved.")}
                />
              )}
              {!(mode?.type === "refill" && mode.calibration.id === cal.id) && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => { setMsg(""); setMode({ type: "refill", calibration: cal }); }}>Log refill</Button>
                  <Button size="sm" variant="secondary" onClick={() => { setMsg(""); setMode({ type: "calibrate", base: cal }); }}>New calibration</Button>
                  <Button size="sm" variant="ghost" onClick={() => startVoid("calibration", cal.id)}>Void</Button>
                </div>
              )}
              {voidBox("calibration", cal.id)}
            </div>
          ))}

          {status === "ready" && current.length > 0 && homesWithoutSystem.length > 0 && properties.length >= 2 && mode?.type !== "calibrate" && (
            <div>
              <Button size="sm" variant="secondary" onClick={() => { setMsg(""); setMode({ type: "calibrate", base: null }); }}>Record install calibration at another property</Button>
            </div>
          )}

          {mode?.type === "calibrate" && (
            <CalibrationForm
              key={mode.base?.id || "new"}
              customerId={customerId}
              properties={properties}
              initial={{ ...(mode.base ? fromCalibration(mode.base, primaryId) : blankCalibration()), ...(mode.base || properties.length < 2 ? {} : { propertyId: homesWithoutSystem[0]?.id || "" }) }}
              onCancel={() => setMode(null)}
              onSaved={() => saved("Calibration saved.")}
            />
          )}

          {refills.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="ui-label text-ink-secondary">Refills</div>
              <ul className="flex flex-col gap-2">
                {shownRefills.map((r) => (
                  <li key={r.id} className={cn("text-ui-body", r.voidedAt && "text-ink-secondary")}>
                    <div className={cn(r.voidedAt && "line-through")}>
                      {formatETDateOnly(r.refilledOn, { month: "short", day: "numeric", year: "numeric" })}: {r.productName}, {r.concentrateFlOzAdded} fl oz in {r.waterGallonsAdded} gal
                      {r.levelBeforePct !== null && r.levelBeforePct !== undefined ? `, level before ${r.levelBeforePct}%` : ""}
                      {r.counterReset ? ", counter reset" : ""}
                      {propertyName(r.propertyId) ? `, ${propertyName(r.propertyId)}` : ""}
                      {`, by ${r.recordedBy?.name || "staff"}`}
                    </div>
                    {r.notes && <div className={cn("text-ui-label text-ink-secondary", r.voidedAt && "line-through")}>{r.notes}</div>}
                    {r.voidedAt && <div className="text-ui-label">Voided {dayOf(r.voidedAt)}: {r.voidReason}</div>}
                    {!r.voidedAt && (
                      <button data-ui-text-action type="button" className="text-ui-label text-ink-secondary underline u-focus-ring" onClick={() => startVoid("refill", r.id)}>
                        Void
                      </button>
                    )}
                    {voidBox("refill", r.id)}
                  </li>
                ))}
              </ul>
              {refills.length > REFILLS_SHOWN && (
                <button data-ui-text-action type="button" className="self-start text-ui-label text-ink-secondary underline u-focus-ring" onClick={() => setShowAllRefills((v) => !v)}>
                  {showAllRefills ? "Show fewer refills" : `Show all ${refills.length} refills`}
                </button>
              )}
            </div>
          )}

          {earlier.length > 0 && (
            <div className="flex flex-col gap-1">
              <button data-ui-text-action type="button" aria-expanded={showEarlier} className="self-start text-ui-label text-ink-secondary underline u-focus-ring" onClick={() => setShowEarlier((v) => !v)}>
                {showEarlier ? "Hide earlier calibrations" : `Earlier calibrations (${earlier.length})`}
              </button>
              {showEarlier && (
                <ul className="flex flex-col gap-2">
                  {earlier.map((c) => (
                    <li key={c.id} className={cn("text-ui-body", c.voidedAt && "text-ink-secondary")}>
                      <div className={cn(c.voidedAt && "line-through")}>
                        {dayOf(c.createdAt)}: {c.vendor} {c.model}, {c.nozzleCount} nozzles, {c.riserCount} risers, {c.productName}, {c.concentrateFlOzPerTank} fl oz per {c.tankGallons} gal. {ozLine(c)}
                        {propertyName(c.propertyId) ? ` ${propertyName(c.propertyId)}.` : ""} By {c.recordedBy?.name || "staff"}.
                      </div>
                      {c.voidedAt && <div className="text-ui-label">Voided {dayOf(c.voidedAt)}: {c.voidReason}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
