import { useCallback, useEffect, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../ui";
import { addETDays, etDateString, formatETDateOnly, formatETDateTime } from "../../lib/timezone";

// PPC -> Capacity: the gap-fill rule. Shows the open-stop count for the next
// few days, the rule's decision, the owner's day limits, and per-campaign
// "keep ads on/off until <date>" holds. The server routes ship behind
// GATE_ADS_GAP_RULE; while they are off GET /admin/ads/gap-rule answers 404
// and this panel renders nothing.

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const SETTING_FIELDS = [
  { key: "weekday_limit", label: "Weekday limit", help: "Stops per technician" },
  { key: "saturday_limit", label: "Saturday limit", help: "Stops per technician" },
  { key: "sunday_limit", label: "Sunday limit", help: "Stops per technician" },
  { key: "window_days", label: "Days to look ahead" },
  { key: "run_at_open", label: "Run ads when open stops ≥" },
  { key: "stop_below_open", label: "Stop ads when open stops <" },
];

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
    "Content-Type": "application/json",
  };
}

async function errorText(res, fallback) {
  const body = await res.json().catch(() => null);
  return (body && body.error) || fallback;
}

const shortDate = (value) => formatETDateOnly(value, { month: "short", day: "numeric" });
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

const DECISION_LABEL = { base: "run full budget", stop: "stop (1% budget)", keep: "no change" };

function decisionText(mode, shadow) {
  const label = DECISION_LABEL[mode] || DECISION_LABEL.keep;
  if (!shadow) return label;
  return label === DECISION_LABEL.keep ? "would make no change" : `would ${label}`;
}

function holdLine(campaign) {
  const hold = campaign.hold;
  if (!hold) return "Automatic";
  return `Held ${hold.mode === "stop" ? "off" : "on"} until ${shortDate(hold.until)}`;
}

function CampaignHold({ campaign, onChanged }) {
  const [until, setUntil] = useState(() => etDateString(addETDays(new Date(), 7)));
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const today = etDateString();

  async function confirmHold() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/admin/ads/campaigns/${campaign.id}/hold`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ mode: pending.mode, until: pending.until }),
      });
      if (!res.ok) {
        setError(await errorText(res, "Could not set the hold."));
        return;
      }
      setPending(null);
      await onChanged();
    } catch {
      setError("Could not set the hold.");
    } finally {
      setBusy(false);
    }
  }

  async function clearHold() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/admin/ads/campaigns/${campaign.id}/hold`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        setError(await errorText(res, "Could not clear the hold."));
        return;
      }
      setPending(null);
      await onChanged();
    } catch {
      setError("Could not clear the hold.");
    } finally {
      setBusy(false);
    }
  }

  const base = Number(campaign.daily_budget_base || 0);
  // Same 1% floor as budget-manager.js calculateBudget('stop').
  const stopBudget = Math.max(0.01, Math.round(base) / 100);
  const effect = pending
    ? pending.mode === "stop"
      ? `Google Ads budget set to ${money(stopBudget)}/day (1% of budget) until ${shortDate(pending.until)}`
      : `Google Ads budget set to ${money(base)}/day until ${shortDate(pending.until)}`
    : "";

  return (
    <div className="flex flex-col [gap:8px] [padding:12px_0] border-t border-zinc-200">
      <div className="flex flex-wrap items-center [gap:8px]">
        <div className="text-ui-body font-medium text-zinc-900">{campaign.campaign_name}</div>
        <Badge tone={campaign.hold ? "strong" : "neutral"}>{holdLine(campaign)}</Badge>
      </div>
      <div className="text-ui-body text-ink-secondary">
        Budget now {money(campaign.daily_budget_current)}/day (full budget {money(base)}/day)
      </div>
      <div className="flex flex-wrap items-end [gap:8px]">
        <Field label="Hold until" className="[min-width:160px]">
          <Input
            type="date"
            value={until}
            min={today}
            onChange={(e) => setUntil(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Button
          variant="secondary"
          disabled={busy || !until}
          onClick={() => setPending({ mode: "base", until })}
        >
          Keep ads on until this date
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !until}
          onClick={() => setPending({ mode: "stop", until })}
        >
          Keep ads off until this date
        </Button>
        {campaign.hold && (
          <Button variant="ghost" disabled={busy} onClick={clearHold}>
            Back to automatic
          </Button>
        )}
      </div>
      {pending && (
        <div
          role="group"
          aria-label="Confirm hold"
          className="flex flex-wrap items-center [gap:8px] rounded-sm border border-zinc-300 bg-zinc-50 [padding:12px]"
        >
          <div className="text-ui-body text-zinc-900">{effect}</div>
          <Button disabled={busy} onClick={confirmHold}>
            Confirm
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      )}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
    </div>
  );
}

export default function AdsGapRulePanel() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/ads/gap-rule`, { headers: authHeaders() });
      if (!res.ok) {
        setData(null);
        return;
      }
      const body = await res.json();
      setData(body && body.settings && body.window ? body : null);
    } catch {
      setData(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const settings = data && data.settings;
  useEffect(() => {
    if (!settings) return;
    setForm(
      Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, String(settings[key] ?? "")])),
    );
  }, [settings]);

  if (!data) return null;

  const shadow = data.mode !== "live";
  const win = data.window;
  const days = win.days || [];
  const changed = SETTING_FIELDS.filter(({ key }) => form[key] !== String(settings[key] ?? ""));

  async function saveSettings() {
    setSaving(true);
    setSaveError("");
    const body = {};
    for (const { key } of changed) body[key] = form[key] === "" ? null : Number(form[key]);
    try {
      const res = await fetch(`${API_BASE}/admin/ads/gap-rule/settings`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setSaveError(await errorText(res, "Could not save the settings."));
        return;
      }
      await load();
    } catch {
      setSaveError("Could not save the settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6" aria-label="Gap-fill rule">
      <div className="flex flex-col [gap:16px]">
        <div className="flex flex-wrap items-center [gap:8px]">
          <div className="text-ui-body font-medium text-zinc-900">Gap-fill rule</div>
          <Badge tone={shadow ? "neutral" : "strong"}>
            {shadow ? "Shadow — watching only" : "Live — sets the budget"}
          </Badge>
        </div>

        <div>
          <div className="text-ui-body text-zinc-900">
            Next {days.length || settings.window_days} days ({shortDate(win.start)} {"–"}{" "}
            {shortDate(win.end)}): {win.total_open} open stops {"→"}{" "}
            {decisionText(data.decision && data.decision.mode, shadow)}
          </div>
          {data.decision && data.decision.reason && (
            <div className="text-ui-body text-ink-secondary">{data.decision.reason}</div>
          )}
          {data.last_run && (
            <div className="text-ui-body text-ink-secondary">
              Last run{" "}
              {formatETDateTime(data.last_run.at, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
              : {data.last_run.total_open} open stops
            </div>
          )}
        </div>

        <Table aria-label="Open stops by day">
          <THead>
            <TR>
              <TH>Day</TH>
              <TH>Booked</TH>
              <TH>Limit</TH>
              <TH>Open</TH>
            </TR>
          </THead>
          <TBody>
            {days.map((d) => (
              <TR key={d.date}>
                <TD>
                  {d.weekday} {shortDate(d.date)}
                </TD>
                <TD>{d.stops}</TD>
                <TD>{d.limit}</TD>
                <TD>{d.open}</TD>
              </TR>
            ))}
            <TR>
              <TD className="font-medium">Total</TD>
              <TD className="font-medium">{win.total_stops}</TD>
              <TD className="font-medium">{win.total_limit}</TD>
              <TD className="font-medium">{win.total_open}</TD>
            </TR>
          </TBody>
        </Table>

        <div className="flex flex-col [gap:12px]">
          <div className="grid grid-cols-1 sm:grid-cols-3 [gap:12px]">
            {SETTING_FIELDS.map(({ key, label, help }) => (
              <Field key={key} label={label} help={help}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  value={form[key] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  disabled={saving}
                />
              </Field>
            ))}
          </div>
          <div className="flex flex-wrap items-center [gap:8px]">
            <Button disabled={saving || changed.length === 0} onClick={saveSettings}>
              Save settings
            </Button>
            {saveError && <ActionFeedback error>{saveError}</ActionFeedback>}
          </div>
        </div>

        {(data.campaigns || []).length > 0 && (
          <div className="flex flex-col">
            {data.campaigns.map((c) => (
              <CampaignHold key={c.id} campaign={c} onChanged={load} />
            ))}
          </div>
        )}

        <div className="text-ui-body text-ink-secondary">
          Off means 1% of budget, not a Google pause, so the campaign keeps its history.
        </div>
      </div>
    </Card>
  );
}
