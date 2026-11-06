// Banking → Cash forecast (owner only, GATE_CASH_FORECAST; owner 2026-11-04 "A A A A").
// The next 13 weeks for both checking accounts as one pool: money in, money out, and two end balances
// each week (booked work only; booked plus expected new money once last year's months are set). The
// numbers come from GET /admin/banking/cash-forecast; the owner types planned items, the floor and last
// year's monthly receipts here. Read-only apart from those inputs.
import { Fragment, useCallback, useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ActionFeedback, Button, Card, Field, Input, Select, Table, THead, TBody, TR, TH, TD } from "../ui";
import { adminFetch } from "../../lib/adminFetch";
import { formatETDateOnly, formatETDateTime } from "../../lib/timezone";

// Is the tab available? Owner only, while GATE_CASH_FORECAST is on: the Banking page asks once per load,
// and the forecast inputs read answers 200 (other staff get 403; a gate that is off answers 404).
export function useCashForecastAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    adminFetch("/admin/banking/cash-forecast/inputs")
      .then((r) => {
        if (!cancelled) setAvailable(r.ok);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

// The tab's requests: every caller names its literal path; a failure throws the server's error text.
async function readJson(path, options) {
  const r = await adminFetch(path, options);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const usd = (n) => (n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);
const usdAxis = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n) >= 1000 ? `${Math.round(Math.abs(n) / 100) / 10}K` : Math.round(Math.abs(n))}`;
const day = (d) => formatETDateOnly(d, { month: "short", day: "numeric" });
const dollarsToCents = (text) => {
  const n = Number(String(text).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && String(text).trim() !== "" ? Math.round(n * 100) : null;
};
const centsToDollars = (c) => (c == null ? "" : String(c / 100));

const LINE_WORDS = {
  stripe: "Stripe money on its way",
  visits: "Booked visits",
  invoices: "Open invoices",
  dues: "Monthly dues",
  new_work: "Expected new work",
  prepay_sales: "Expected prepay sales",
  products_fuel: "Products and fuel",
  products_fuel_extra: "Products and fuel for expected work",
  ai_software: "AI and software",
  card_payments_off_feed: "Payments to cards outside the feed",
  other_spending: "Other spending",
  card_owed: "Spark card owed today",
  payroll: "Payroll",
  taxes: "Taxes",
  planned: "Planned items",
  hire: "Planned hire",
};
const KIND_WORDS = {
  insurance: "Insurance",
  health: "Health plan",
  tax_account: "Tax account",
  ads: "Ads",
  card_payoff: "Card payoff",
  hire: "Hire (gross pay per check)",
  other: "Other",
};
const CADENCE_WORDS = { once: "Once", weekly: "Every week", biweekly: "Every 2 weeks", monthly: "Every month" };
const lastFour = (label) => (String(label || "").match(/(\d{4})$/) || [])[1] || label;

// One plain sentence per thing the forecast cannot see.
const MISSING_WORDS = {
  account_unavailable: (m) => `${m.institution || "A bank"}${m.mask ? ` ••${m.mask}` : ""} is not counted. The Cash today card above says how to fix it.`,
  balance_unavailable: () => "The bank balance could not be read, so every end balance is a change from today.",
  card_balance_unavailable: () => "A card balance could not be read, so what it owes is not counted.",
  stripe_balance_unavailable: () => "Stripe's balance could not be read, so money already charged is not counted.",
  card_not_in_feed: (m) => `Card ••${lastFour(m.account)} is not in the bank feed (last statement row ${day(m.last_day)}; ${usd(m.debits_30d_usd)} of charges in its last 30 days). Its charges are not counted.`,
  card_payoff_plan: (m) => `Payments to cards outside the feed average ${usd(m.weekly_usd)} a week. Add a card payoff plan below to replace that line.`,
  last_year_months: (m) => `Expected new money needs last year's money in for ${(m.months || []).map(monthWords).join(", ")}. Add it under Settings below.`,
  draft_invoices: (m) => `${m.count} draft invoices (${usd(m.usd)}) were never sent. They are not counted.`,
  completed_visits_not_billed: (m) => `${m.count} finished visits (${usd(m.usd)}) in the last 90 days have no invoice. They are not counted.`,
  payer_billed_visits: (m) => `${m.count} booked visits are billed to a payer. They are not counted.`,
  invoices_late_beyond: (m) => `${m.count} invoices (${usd(m.usd)}) are more than 91 days late. They are not counted.`,
  payouts_overdue: (m) => `Stripe still shows ${m.count === 1 ? "a payout" : `${m.count} payouts`} (${usd(m.usd)}) on the way past the arrival day (the first was due ${day(m.first_day)}). It is not counted: check that it reached the bank.`,
  tax_rows_without_amount: (m) => `${m.count} tax calendar rows have no amount. They are not counted.`,
  hire_overlaps_pay_runs: (m) => `Pay runs exist from ${day(m.first_pay_day)}. If "${m.label}" is on payroll now, end that planned hire.`,
};
const missingText = (m) => (MISSING_WORDS[m.kind] ? MISSING_WORDS[m.kind](m) : m.kind);

const muted = { color: "#71717A", fontSize: 14 };
const heading = { fontSize: 16, fontWeight: 500, color: "#09090B", marginBottom: 8 };

function Tile({ label, value, note }) {
  return (
    <Card style={{ padding: "12px 16px" }}>
      <div style={muted}>{label}</div>
      <div className="u-nums" style={{ fontSize: 20, fontWeight: 600, color: "#09090B" }}>{value}</div>
      {note && <div style={muted}>{note}</div>}
    </Card>
  );
}

function ForecastSummary({ forecast, floorCents, hasHire }) {
  const { opening, lowest } = forecast;
  const low = (l) => (l ? `${usd(l.usd)} · week of ${day(l.week_start)}` : "—");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
      <Tile label="Cash today (both checking accounts)" value={usd(opening.bank_usd)}
        note={opening.bank_usd == null ? "No live balance: end balances are changes from today" : opening.partial ? "Partial: see What the forecast cannot see" : null} />
      <Tile label="Lowest week, booked work only" value={low(lowest.booked)} />
      <Tile label="Lowest week, with expected new money" value={forecast.expected_available ? low(lowest.expected) : "Needs last year's months"} />
      {hasHire && <Tile label="Lowest week with the planned hire" value={low(lowest[forecast.expected_available ? "expected_with_hire" : "booked_with_hire"])} />}
      <Tile label="Your floor" value={floorCents == null ? "Not set" : usd(floorCents / 100)} />
    </div>
  );
}

// The line the owner reads first: with expected new money when last year's months are set, else booked
// work only. A planned hire adds its own line on that same base.
const primaryKey = (forecast) => (forecast.expected_available ? "end_expected" : "end_booked");
const hireKey = (forecast) => (forecast.expected_available ? "end_expected_with_hire" : "end_booked_with_hire");

const INK = "#09090B";
const CONTEXT = "#A1A1AA";
const axisText = { fill: "#71717A", fontSize: 14 };

// The lines, in the order the legend and the tooltip list them: the line the owner reads first, booked
// work only as context (when the expected line shows), and the planned hire on the first line's base.
function chartSeries(forecast, hasHire) {
  const expected = forecast.expected_available;
  return [
    { key: "main", name: expected ? "With expected new money" : "Booked work only", stroke: INK },
    ...(expected ? [{ key: "booked", name: "Booked work only", stroke: CONTEXT }] : []),
    ...(hasHire ? [{ key: "hire", name: "With the planned hire", stroke: INK, dash: "2 4" }] : []),
  ];
}

// A short stroke of the line's own color and dash: the key for a line, in the legend and the tooltip.
function LineKey({ s }) {
  return (
    <svg width="20" height="8" aria-hidden="true" style={{ flex: "none" }}>
      <line x1="1" y1="4" x2="19" y2="4" stroke={s.stroke} strokeWidth="2" strokeDasharray={s.dash} strokeLinecap="round" />
    </svg>
  );
}

function SeriesLegend({ series }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "4px 16px", fontSize: 14, color: "#3F3F46", paddingTop: 8 }}>
      {series.map((s) => (
        <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <LineKey s={s} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

// One readout for every line at the week under the pointer: the value leads, the line's key names it.
function ChartTooltip({ active, payload, label, series }) {
  if (!active || !payload?.length) return null;
  const valueOf = new Map(payload.map((p) => [p.dataKey, p.value]));
  return (
    <Card style={{ padding: "10px 14px", fontSize: 14 }}>
      <div style={{ color: "#71717A", marginBottom: 4 }}>Week of {label}</div>
      {series.filter((s) => valueOf.has(s.key)).map((s) => (
        <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, color: INK }}>
          <LineKey s={s} />
          <span className="u-nums" style={{ fontWeight: 600 }}>{usd(valueOf.get(s.key))}</span>
          <span style={{ color: "#71717A" }}>{s.name}</span>
        </div>
      ))}
    </Card>
  );
}

const lineShape = { strokeWidth: 2, dot: false, strokeLinecap: "round", strokeLinejoin: "round", isAnimationActive: false };

function ForecastChart({ forecast, floorCents, hasHire }) {
  const main = primaryKey(forecast);
  const series = chartSeries(forecast, hasHire);
  const data = forecast.weeks.map((w) => ({
    week: day(w.week_start),
    main: w[main],
    booked: w.end_booked,
    hire: hasHire ? w[hireKey(forecast)] : null,
  }));
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={heading}>Cash at the end of each week</div>
      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#E4E4E7" vertical={false} />
            <XAxis dataKey="week" tick={axisText} axisLine={{ stroke: "#E4E4E7" }} tickLine={false} minTickGap={16} />
            <YAxis className="u-nums" tickFormatter={usdAxis} tick={axisText} axisLine={false} tickLine={false} width={64} />
            <Tooltip content={<ChartTooltip series={series} />} cursor={{ stroke: "#A1A1AA", strokeWidth: 1 }} />
            <Legend content={<SeriesLegend series={series} />} />
            {floorCents != null && (
              <ReferenceLine
                y={floorCents / 100}
                stroke="#71717A"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={{ value: `Floor ${usd(floorCents / 100)}`, position: "insideBottomRight", fill: "#71717A", fontSize: 14 }}
              />
            )}
            {/* drawn last to first, so the line the owner reads first sits on top */}
            {[...series].reverse().map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={s.stroke}
                strokeDasharray={s.dash}
                activeDot={s.key === "main" ? { r: 4, strokeWidth: 2, stroke: "#FFFFFF" } : false}
                {...lineShape}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

const total = (lines) => Object.values(lines).reduce((s, v) => s + v, 0);
const shownLines = (lines) => Object.entries(lines).filter(([, v]) => Math.abs(v) >= 0.5);

function WeekDetail({ week, colSpan }) {
  const rows = [
    ...shownLines(week.money_in).map(([k, v]) => [LINE_WORDS[k] || k, v]),
    ...shownLines(week.money_out).map(([k, v]) => [LINE_WORDS[k] || k, -v]),
  ];
  return (
    <TR>
      <TD colSpan={colSpan}>
        {rows.length === 0 ? <span style={muted}>Nothing moves this week.</span> : rows.map(([label, v]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", maxWidth: 460, ...muted }}>
            <span>{label}</span>
            <span className="u-nums">{usd(v)}</span>
          </div>
        ))}
      </TD>
    </TR>
  );
}

function ForecastWeeks({ forecast, hasHire }) {
  const [open, setOpen] = useState(null);
  const cols = 4 + (forecast.expected_available ? 1 : 0) + (hasHire ? 1 : 0);
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={heading}>Week by week</div>
      <Table>
        <THead>
          <TR>
            <TH>Week of</TH>
            <TH>Money in</TH>
            <TH>Money out</TH>
            <TH>End, booked only</TH>
            {forecast.expected_available && <TH>End, expected</TH>}
            {hasHire && <TH>With the hire</TH>}
          </TR>
        </THead>
        <TBody>
          {forecast.weeks.map((w) => (
            <Fragment key={w.week_start}>
              <TR onClick={() => setOpen(open === w.week_start ? null : w.week_start)} style={{ cursor: "pointer" }}>
                <TD>{day(w.week_start)}{w.days < 7 ? ` (${w.days} days)` : ""}</TD>
                <TD className="u-nums">{usd(total(w.money_in))}</TD>
                <TD className="u-nums">{usd(total(w.money_out) - w.money_out.hire)}</TD>
                <TD className="u-nums">{usd(w.end_booked)}</TD>
                {forecast.expected_available && <TD className="u-nums">{usd(w.end_expected)}</TD>}
                {hasHire && <TD className="u-nums">{usd(w[hireKey(forecast)])}</TD>}
              </TR>
              {open === w.week_start && <WeekDetail week={w} colSpan={cols} />}
            </Fragment>
          ))}
        </TBody>
      </Table>
      <div style={{ ...muted, marginTop: 8 }}>Tap a week to see its lines.</div>
    </Card>
  );
}

function MissingData({ missing }) {
  if (!missing.length) return null;
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={heading}>What the forecast cannot see</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {missing.map((m) => <li key={`${m.kind}-${m.account || m.label || ""}`} style={{ marginBottom: 4 }}>{missingText(m)}</li>)}
      </ul>
    </Card>
  );
}

const EMPTY_ITEM = { kind: "insurance", label: "", amount: "", cadence: "monthly", first_date: "", last_date: "" };

function ItemForm({ inputs, initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const cents = dollarsToCents(form.amount);
    if (!(cents > 0)) return setError("Type an amount above $0.");
    const body = { kind: form.kind, label: form.label, amount_cents: cents, cadence: form.cadence, first_date: form.first_date, last_date: form.last_date || null };
    setSaving(true);
    try {
      setError(null);
      await onSave(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
    return null;
  };
  return (
    <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, alignItems: "end", marginTop: 8 }}>
      <Field label="Kind">
        <Select value={form.kind} onChange={set("kind")}>
          {inputs.kinds.map((k) => <option key={k} value={k}>{KIND_WORDS[k] || k}</option>)}
        </Select>
      </Field>
      <Field label="Name"><Input value={form.label} onChange={set("label")} maxLength={120} /></Field>
      <Field label="Amount ($)"><Input value={form.amount} onChange={set("amount")} inputMode="decimal" /></Field>
      <Field label="How often">
        <Select value={form.cadence} onChange={set("cadence")}>
          {inputs.cadences.map((c) => <option key={c} value={c}>{CADENCE_WORDS[c] || c}</option>)}
        </Select>
      </Field>
      <Field label="First date"><Input type="date" value={form.first_date} onChange={set("first_date")} /></Field>
      <Field label="Last date (optional)"><Input type="date" value={form.last_date} onChange={set("last_date")} /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Button type="submit" disabled={saving}>Save</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
      {error && <div style={{ gridColumn: "1 / -1" }}><ActionFeedback error>{error}</ActionFeedback></div>}
    </form>
  );
}

function PlannedItems({ inputs, onChanged }) {
  const [editing, setEditing] = useState(null); // item id, 'new', or null
  const [error, setError] = useState(null);
  const saved = () => {
    setEditing(null);
    onChanged();
  };
  const create = async (body) => {
    await readJson("/admin/banking/cash-forecast/items", { method: "POST", body });
    saved();
  };
  const update = (id) => async (body) => {
    await readJson(`/admin/banking/cash-forecast/items/${id}`, { method: "PATCH", body });
    saved();
  };
  const remove = async (id) => {
    try {
      setError(null);
      await readJson(`/admin/banking/cash-forecast/items/${id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };
  const asForm = (it) => ({ kind: it.kind, label: it.label, amount: centsToDollars(it.amount_cents), cadence: it.cadence, first_date: it.first_date, last_date: it.last_date || "" });
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={heading}>Planned money out</div>
      <div style={muted}>Insurance, a health plan, a tax account, ads, a card payoff plan, a hire. A card payoff plan takes the place of the line for payments to cards outside the bank feed, from its first date to its last.</div>
      {inputs.items.map((it) => (editing === it.id
        ? <ItemForm key={it.id} inputs={inputs} initial={asForm(it)} onSave={update(it.id)} onCancel={() => setEditing(null)} />
        : (
          <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #F4F4F5" }}>
            <div>
              <div style={{ color: "#09090B" }}>{it.label} · {KIND_WORDS[it.kind] || it.kind}</div>
              <div style={muted}>{usd(it.amount_cents / 100)} {(CADENCE_WORDS[it.cadence] || it.cadence).toLowerCase()} from {day(it.first_date)}{it.last_date ? ` to ${day(it.last_date)}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="button" variant="ghost" onClick={() => setEditing(it.id)}>Edit</Button>
              <Button type="button" variant="ghost" onClick={() => remove(it.id)}>Remove</Button>
            </div>
          </div>
        )))}
      {editing === "new"
        ? <ItemForm inputs={inputs} initial={EMPTY_ITEM} onSave={create} onCancel={() => setEditing(null)} />
        : <div style={{ marginTop: 8 }}><Button type="button" onClick={() => setEditing("new")}>Add a planned item</Button></div>}
      {error && <ActionFeedback error className="mt-2">{error}</ActionFeedback>}
    </Card>
  );
}

// The months the expected line needs (from the forecast) plus any already typed, oldest first.
function monthsToShow(settings, missing) {
  const needed = (missing.find((m) => m.kind === "last_year_months") || {}).months || [];
  return [...new Set([...needed, ...Object.keys(settings.last_year_receipts)])].sort();
}
const monthWords = (ym) => formatETDateOnly(`${ym}-15`, { month: "long", year: "numeric" });

function ForecastSettings({ settings, missing, onChanged }) {
  const months = monthsToShow(settings, missing);
  const [floor, setFloor] = useState(centsToDollars(settings.floor_cents));
  const [receipts, setReceipts] = useState(Object.fromEntries(months.map((m) => [m, centsToDollars(settings.last_year_receipts[m])])));
  const [state, setState] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    const typed = Object.entries(receipts).filter(([, v]) => String(v).trim() !== "");
    const bad = typed.find(([, v]) => dollarsToCents(v) === null) || (floor.trim() !== "" && dollarsToCents(floor) === null);
    if (bad) return setState({ error: "Type each amount as a number of dollars." });
    setState({ saving: true });
    try {
      await readJson("/admin/banking/cash-forecast/settings", {
        method: "PUT",
        body: {
          floor_cents: floor.trim() === "" ? null : dollarsToCents(floor),
          last_year_receipts: Object.fromEntries(typed.map(([m, v]) => [m, dollarsToCents(v)])),
        },
      });
      setState({ saved: true });
      onChanged();
    } catch (err) {
      setState({ error: err.message });
    }
    return null;
  };
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={heading}>Settings</div>
      <form onSubmit={save} style={{ display: "grid", gap: 8, maxWidth: 480 }}>
        <Field label="Floor: the lowest cash you want both accounts to hold ($)">
          <Input value={floor} onChange={(e) => setFloor(e.target.value)} inputMode="decimal" />
        </Field>
        <div style={muted}>Last year's money in by month, from your bank statements or tax records. It shapes the expected line by season.</div>
        {months.map((m) => (
          <Field key={m} label={`${monthWords(m)} ($)`}>
            <Input value={receipts[m] ?? ""} onChange={(e) => setReceipts({ ...receipts, [m]: e.target.value })} inputMode="decimal" />
          </Field>
        ))}
        <div><Button type="submit" disabled={!!state?.saving}>Save settings</Button></div>
        {state?.saved && <ActionFeedback>Saved.</ActionFeedback>}
        {state?.error && <ActionFeedback error>{state.error}</ActionFeedback>}
      </form>
    </Card>
  );
}

export default function CashForecastTab() {
  const [forecast, setForecast] = useState(null);
  const [inputs, setInputs] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, i] = await Promise.all([readJson("/admin/banking/cash-forecast"), readJson("/admin/banking/cash-forecast/inputs")]);
      setForecast(f);
      setInputs(i);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!forecast || !inputs) {
    return (
      <Card style={{ padding: 16 }}>
        {error ? <ActionFeedback error onRetry={load}>The forecast could not be read: {error}</ActionFeedback> : <span style={muted}>Reading the forecast…</span>}
      </Card>
    );
  }
  const hasHire = inputs.items.some((i) => i.kind === "hire");
  const floorCents = inputs.settings.floor_cents;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <div style={muted}>The next 13 weeks for both checking accounts as one pool. Read {formatETDateTime(forecast.fetched_at)}.</div>
        <Button type="button" variant="ghost" onClick={load} disabled={loading}>Refresh</Button>
      </div>
      {error && <ActionFeedback error onRetry={load} className="mb-4">The forecast could not be read again: {error}. These numbers are from the last read.</ActionFeedback>}
      <div style={{ opacity: loading ? 0.6 : 1 }}>
        <ForecastSummary forecast={forecast} floorCents={floorCents} hasHire={hasHire} />
        <ForecastChart forecast={forecast} floorCents={floorCents} hasHire={hasHire} />
        <MissingData missing={forecast.missing} />
        <ForecastWeeks forecast={forecast} hasHire={hasHire} />
        <PlannedItems inputs={inputs} onChanged={load} />
        <ForecastSettings key={inputs.settings.updated_at || "new"} settings={inputs.settings} missing={forecast.missing} onChanged={load} />
      </div>
    </div>
  );
}

export const _private = { missingText, monthsToShow, dollarsToCents, LINE_WORDS };
