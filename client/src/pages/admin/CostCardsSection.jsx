import React, { useCallback, useEffect, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../../components/ui";

// Cost cards (GATE_TECH_COST_RATES). Lives on Settings > Operating costs. The
// server answers { enabled: false } while the gate is off, and then nothing here
// renders. Cards are never edited: a change is a new card with an effective date.
// The Open time panel (GATE_TECH_OPEN_TIME) sits under the cards; its route answers
// 404 while that gate is off, and then the panel renders nothing.

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data?.error || `Request failed (${r.status})`);
      err.status = r.status;
      throw err;
    }
    return data;
  });
}

const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (n, places = 2) => (n == null ? "" : String(Number(Number(n).toFixed(places))));

const TECH_FIELDS = [
  { key: "paidHoursPerWeek", label: "Paid hours per week", def: "40" },
  { key: "paidHoursPerDay", label: "Paid hours per day", def: "10" },
  { key: "healthMoneyMonthly", label: "Health money per month", def: "0", prefix: "$" },
  { key: "retirementPct", label: "Retirement %", def: "0" },
  { key: "workersCompPct", label: "Workers' comp %", def: "0" },
  { key: "paidDaysOffPerYear", label: "Paid days off per year", def: "0" },
];

const VEHICLE_FIELDS = [
  { key: "lossOfValuePerYear", label: "Loss of value per year" },
  { key: "insurancePerYear", label: "Insurance per year" },
  { key: "loanInterestPerYear", label: "Loan interest per year" },
  { key: "otherFixedPerYear", label: "Other fixed costs per year" },
  { key: "fuelPerMile", label: "Fuel per mile" },
  { key: "upkeepPerMile", label: "Upkeep per mile" },
];

// Blank fields are left out so the server's defaults apply; anything else must be a number.
function numbersFrom(form, fields) {
  const body = {};
  for (const f of fields) {
    const raw = String(form[f.key] ?? "").trim();
    if (raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`"${f.label}" must be a number of 0 or more.`);
    body[f.key] = v;
  }
  return body;
}

function BreakdownTable({ rate }) {
  if (!rate) return null;
  if (!rate.ok) {
    const why = {
      no_pay_rate: "This technician has no pay rate on file, so a W-2 card cannot give a cost yet.",
      no_imputed_rate: "The card has no hourly rate.",
      no_worked_hours: "The card leaves no worked hours in the year.",
    }[rate.reason] || "No cost can be worked out from this card.";
    return <p className="text-ui-caption text-ink-secondary">{why} Costing uses the company labor rate for this technician.</p>;
  }
  return (
    <Table aria-label="Cost breakdown">
      <THead>
        <TR>
          <TH>Cost line</TH>
          <TH className="text-right">Per year</TH>
          <TH className="text-right">Per paid hour</TH>
          <TH className="text-right">Per worked hour</TH>
        </TR>
      </THead>
      <TBody>
        {rate.lines.map((l) => (
          <TR key={l.key}>
            <TD>{l.label}</TD>
            <TD className="text-right u-nums">{money(l.perYearCents)}</TD>
            <TD className="text-right u-nums">{money(l.perPaidHourCents)}</TD>
            <TD className="text-right u-nums">{money(l.perWorkedHourCents)}</TD>
          </TR>
        ))}
        <TR>
          <TD className="font-medium">Total labor cost</TD>
          <TD className="text-right font-medium u-nums">{money(rate.totalPerYearCents)}</TD>
          <TD className="text-right font-medium u-nums">{money(rate.laborPerPaidHourCents)}</TD>
          <TD className="text-right font-medium u-nums">{money(rate.laborPerWorkedHourCents)}</TD>
        </TR>
      </TBody>
    </Table>
  );
}

function VehicleRateLines({ rate }) {
  if (!rate || !rate.ok) return null;
  return (
    <p className="text-ui-caption text-ink-secondary">
      {rate.spreadOverHoursPerYear
        ? `Fixed costs ${money(rate.fixedPerYearCents)} a year = ${money(rate.fixedPerWorkedHourCents)} per worked hour (spread over ${plain(rate.spreadOverHoursPerYear)} worked hours a year of the technicians whose cards name it). `
        : `Fixed costs ${money(rate.fixedPerYearCents)} a year. No technician card names this vehicle, so no fixed cost is charged per hour yet. `}
      Per mile: ${rate.perMile.toFixed(4)}.
    </p>
  );
}

function TechnicianCardForm({ tech, vehicles, today, onSaved }) {
  const [form, setForm] = useState({
    effectiveDate: today,
    kind: "w2",
    hourlyWage: tech.payRate != null ? plain(tech.payRate) : "",
    imputedHourlyRate: "",
    vehicleEquipmentId: "",
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const set = (key) => (ev) => setForm((f) => ({ ...f, [key]: ev.target.value }));

  const save = async () => {
    setMessage(null);
    let body;
    try {
      body = { effectiveDate: form.effectiveDate, kind: form.kind, ...numbersFrom(form, TECH_FIELDS) };
      if (form.kind === "imputed") {
        const rate = Number(form.imputedHourlyRate);
        if (!(rate > 0)) throw new Error("Enter an hourly rate above zero.");
        body.imputedHourlyRate = rate;
      } else {
        const wage = Number(form.hourlyWage);
        if (!(wage > 0)) throw new Error("Enter the hourly wage.");
        body.hourlyWage = wage;
      }
      if (form.vehicleEquipmentId) body.vehicleEquipmentId = form.vehicleEquipmentId;
      if (form.note.trim()) body.note = form.note.trim();
    } catch (err) {
      setMessage({ text: err.message, error: true });
      return;
    }
    setSaving(true);
    try {
      await adminFetch(`/admin/cost-cards/technicians/${tech.id}`, { method: "POST", body: JSON.stringify(body) });
      setMessage({ text: "Card added.", error: false });
      await onSaved();
    } catch (err) {
      setMessage({ text: err.message || "Could not add the card.", error: true });
    } finally {
      setSaving(false);
    }
  };

  const id = `tech-${tech.id}`;
  return (
    <div className="space-y-3 border-t border-zinc-200 pt-4">
      <p className="text-ui-body font-medium text-zinc-900">Add card for {tech.name}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Effective date" id={`${id}-date`}>
          <Input type="date" value={form.effectiveDate} onChange={set("effectiveDate")} />
        </Field>
        <Field label="Kind of card" id={`${id}-kind`}>
          <Select value={form.kind} onChange={set("kind")}>
            <option value="w2">W-2 employee (worked out from the hourly wage)</option>
            <option value="imputed">Stated hourly rate (owner or other)</option>
          </Select>
        </Field>
        {form.kind === "imputed" ? (
          <Field label="Hourly rate" id={`${id}-imputed`}>
            <Input type="number" min="0" step="any" value={form.imputedHourlyRate} onChange={set("imputedHourlyRate")} className="u-nums" />
          </Field>
        ) : (
          <Field label="Hourly wage" id={`${id}-wage`}>
            <Input type="number" min="0" step="any" value={form.hourlyWage} onChange={set("hourlyWage")} className="u-nums" />
          </Field>
        )}
        {TECH_FIELDS.map((f) => (
          <Field label={f.label} id={`${id}-${f.key}`} key={f.key}>
            <Input type="number" min="0" step="any" value={form[f.key] ?? ""} placeholder={f.def} onChange={set(f.key)} className="u-nums" />
          </Field>
        ))}
        <Field label="Vehicle driven" id={`${id}-vehicle`}>
          <Select value={form.vehicleEquipmentId} onChange={set("vehicleEquipmentId")}>
            <option value="">No vehicle</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        </Field>
        <Field label="Note" id={`${id}-note`}>
          <Input value={form.note} maxLength={500} onChange={set("note")} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving}>{saving ? "Saving..." : "Add card"}</Button>
        {message && <ActionFeedback error={message.error}>{message.text}</ActionFeedback>}
      </div>
    </div>
  );
}

function VehicleCardForm({ vehicle, today, onSaved }) {
  const [form, setForm] = useState({ effectiveDate: today, note: "" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const set = (key) => (ev) => setForm((f) => ({ ...f, [key]: ev.target.value }));

  const save = async () => {
    setMessage(null);
    let body;
    try {
      body = { effectiveDate: form.effectiveDate, ...numbersFrom(form, VEHICLE_FIELDS) };
      if (form.note.trim()) body.note = form.note.trim();
    } catch (err) {
      setMessage({ text: err.message, error: true });
      return;
    }
    setSaving(true);
    try {
      await adminFetch(`/admin/cost-cards/vehicles/${vehicle.id}`, { method: "POST", body: JSON.stringify(body) });
      setMessage({ text: "Card added.", error: false });
      await onSaved();
    } catch (err) {
      setMessage({ text: err.message || "Could not add the card.", error: true });
    } finally {
      setSaving(false);
    }
  };

  const id = `veh-${vehicle.id}`;
  return (
    <div className="space-y-3 border-t border-zinc-200 pt-4">
      <p className="text-ui-body font-medium text-zinc-900">Add card for {vehicle.name}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Effective date" id={`${id}-date`}>
          <Input type="date" value={form.effectiveDate} onChange={set("effectiveDate")} />
        </Field>
        {VEHICLE_FIELDS.map((f) => (
          <Field label={f.label} id={`${id}-${f.key}`} key={f.key}>
            <Input type="number" min="0" step="any" value={form[f.key] ?? ""} placeholder="0" onChange={set(f.key)} className="u-nums" />
          </Field>
        ))}
        <Field label="Note" id={`${id}-note`}>
          <Input value={form.note} maxLength={500} onChange={set("note")} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving}>{saving ? "Saving..." : "Add card"}</Button>
        {message && <ActionFeedback error={message.error}>{message.text}</ActionFeedback>}
      </div>
    </div>
  );
}

function cardSummary(card) {
  if (!card) return "No card yet. Costing uses the company labor rate and drive cost per stop.";
  const kind = card.kind === "imputed"
    ? `stated rate $${plain(card.imputedHourlyRate)} an hour`
    : card.hourlyWage != null ? `W-2 at $${plain(card.hourlyWage)} an hour` : "W-2";
  return `In effect since ${card.effectiveDate}: ${kind}, ${plain(card.paidHoursPerWeek)} paid hours a week, ${plain(card.paidDaysOffPerYear, 1)} paid days off a year.`;
}

const hours = (minutes) => String(Math.round((Number(minutes) || 0) / 6) / 10);
const percent = (share) => (share == null ? "" : `${Math.round(share * 1000) / 10}%`);

const LEFT_OUT_TEXT = {
  costed_before_card: "visits costed before the card",
  no_card: "no cost card in effect",
  no_rate: "the card gives no hourly cost",
};

// Open time (GATE_TECH_OPEN_TIME): the paid hours of each technician's finished days that no visit carries.
// `version` changes each time the section reloads (a saved card), so a new or back-dated card shows here too.
function OpenTimePanel({ version }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    adminFetch("/admin/cost-cards/open-time")
      .then((data) => { if (live) { setReport(data); setError(null); } })
      .catch((err) => {
        if (!live) return;
        if (err.status === 404) { setReport(null); setError(null); } else setError(err.message || "Could not load open time.");
      });
    return () => { live = false; };
  }, [version]);

  if (error) return <ActionFeedback error>{error}</ActionFeedback>;
  if (!report || report.enabled !== true) return null;
  const leftOut = report.leftOut || { days: 0, byReason: {} };

  return (
    <Card data-testid="open-time">
      <CardHeader>
        <CardTitle>Open time, last 30 days</CardTitle>
        <p className="mt-1 text-ui-body text-ink-secondary">
          Paid hours with no visit booked, at each technician&apos;s cost per worked hour. A visit carries only its own
          on-site and drive time, so customer margins stay steady; open time shows what an empty schedule costs.
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        {report.technicians.length > 0 ? (
          <Table aria-label="Open time by technician">
            <THead>
              <TR>
                <TH>Technician</TH>
                <TH className="text-right">Days</TH>
                <TH className="text-right">Paid hours</TH>
                <TH className="text-right">Booked hours (on site + drive)</TH>
                <TH className="text-right">Open hours</TH>
                <TH className="text-right">Open cost</TH>
                <TH className="text-right">Booked share</TH>
              </TR>
            </THead>
            <TBody>
              {report.technicians.map((t) => (
                <TR key={t.technicianId}>
                  <TD>{t.name || "Technician"}</TD>
                  <TD className="text-right u-nums">{t.days}</TD>
                  <TD className="text-right u-nums">{hours(t.paidMinutes)}</TD>
                  <TD className="text-right u-nums">{hours(t.bookedMinutes)}</TD>
                  <TD className="text-right u-nums">{hours(t.openMinutes)}</TD>
                  <TD className="text-right u-nums">{money(t.openCostCents)}</TD>
                  <TD className="text-right u-nums">{percent(t.bookedShare)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <p className="text-ui-body text-ink-secondary">No finished days with a cost card yet.</p>
        )}
        <p className="text-ui-caption text-ink-secondary">
          Paid hours come from the time clock, else the card&apos;s paid hours a day on days with a visit.
        </p>
        {Object.entries(leftOut.byReason || {}).map(([reason, count]) => (
          <p key={reason} className="text-ui-caption text-ink-secondary">
            {count} {count === 1 ? "day" : "days"} left out: {LEFT_OUT_TEXT[reason] || "not enough data"}.
          </p>
        ))}
      </CardBody>
    </Card>
  );
}

export default function CostCardsSection() {
  const [data, setData] = useState(null);
  const [rates, setRates] = useState(null);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const cards = await adminFetch("/admin/cost-cards");
      if (!cards || cards.enabled !== true) {
        setData({ enabled: false });
        return;
      }
      const computed = await adminFetch(`/admin/cost-cards/rates?date=${encodeURIComponent(cards.today)}`);
      setData(cards);
      setRates(computed);
      setError(null);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err.message || "Could not load cost cards.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <ActionFeedback error>{error}</ActionFeedback>;
  if (!data || data.enabled !== true) return null;

  const techRate = (id) => rates?.technicians?.find((t) => t.technicianId === id);
  const vehicleRate = (id) => rates?.vehicles?.find((v) => v.equipmentId === id);

  return (
    <div className="space-y-5" data-testid="cost-cards">
      <Card>
        <CardHeader>
          <CardTitle>Cost cards</CardTitle>
          <p className="mt-1 text-ui-body text-ink-secondary">
            What each technician and each vehicle really costs. Job costs use the card in effect on the visit date:
            the technician&apos;s cost per worked hour for on-site and drive time, plus the vehicle&apos;s cost per mile and per
            worked hour. A technician with no card keeps the company labor rate. Customer prices never change.
            A card is never edited; add a new card with a later effective date.
          </p>
        </CardHeader>
      </Card>

      {data.technicians.map((tech) => {
        const current = tech.cards.find((c) => c.effectiveDate <= data.today) || null;
        return (
          <Card key={tech.id}>
            <CardHeader className="flex flex-wrap items-center gap-2">
              <CardTitle>{tech.name}</CardTitle>
              {tech.payRate != null && <Badge tone="neutral">Pay rate ${plain(tech.payRate)} an hour</Badge>}
            </CardHeader>
            <CardBody className="space-y-4">
              <p className="text-ui-body text-ink-secondary">{cardSummary(current)}</p>
              {current && <BreakdownTable rate={techRate(tech.id)} />}
              <TechnicianCardForm tech={tech} vehicles={data.vehicles} today={data.today} onSaved={load} />
            </CardBody>
          </Card>
        );
      })}

      {data.vehicles.map((vehicle) => {
        const current = vehicle.cards.find((c) => c.effectiveDate <= data.today) || null;
        return (
          <Card key={vehicle.id}>
            <CardHeader><CardTitle>{vehicle.name}</CardTitle></CardHeader>
            <CardBody className="space-y-4">
              <p className="text-ui-body text-ink-secondary">
                {current
                  ? `In effect since ${current.effectiveDate}: fuel $${plain(current.fuelPerMile, 4)} and upkeep $${plain(current.upkeepPerMile, 4)} per mile.`
                  : "No card yet. No vehicle cost is added to visits."}
              </p>
              {current && <VehicleRateLines rate={vehicleRate(vehicle.id)} />}
              <VehicleCardForm vehicle={vehicle} today={data.today} onSaved={load} />
            </CardBody>
          </Card>
        );
      })}

      <OpenTimePanel version={version} />
    </div>
  );
}
