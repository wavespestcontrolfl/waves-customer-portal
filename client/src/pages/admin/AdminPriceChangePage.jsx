// /admin/price-change — the price-change notice workflow (owner policy
// 2026-07-12: no renewal notices for the no-term recurring service; a price
// change gets a formal 30+ day advance notice instead).
//
// Two-step, same trust model as the Automations segment send: Preview shows
// the LIVE per-customer current → new price list; Confirm re-derives the
// list server-side and refuses on drift. The preview snapshot carries the
// parameters it was computed with — the confirm sends exactly what was
// previewed, never the live form state. Sends NOTICES only: it never
// touches monthly_rate.
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, cn } from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  });
}

const LOCATION_OPTIONS = [
  { value: "", label: "All locations" },
  { value: "bradenton", label: "Bradenton / Lakewood Ranch" },
  { value: "parrish", label: "Parrish" },
  { value: "sarasota", label: "Sarasota" },
  { value: "venice", label: "Venice" },
];

function isoDatePlusDays(days) {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export default function AdminPriceChangePage() {
  const [locationId, setLocationId] = useState("");
  const [incType, setIncType] = useState("amount");
  const [incValue, setIncValue] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(isoDatePlusDays(35));
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const previewSeq = useRef(0);

  // Any parameter change invalidates the preview — the confirm only arms
  // against the exact list the operator just saw.
  useEffect(() => {
    previewSeq.current += 1;
    setPreview(null);
    setResult(null);
  }, [locationId, incType, incValue, effectiveDate]);

  const increase = { type: incType, value: Number(incValue) };
  const paramsValid = Number.isFinite(increase.value) && increase.value !== 0 && effectiveDate;

  const runPreview = async () => {
    if (previewing || !paramsValid) return;
    const requestId = ++previewSeq.current;
    setPreviewing(true);
    setResult(null);
    try {
      const data = await adminFetch("/admin/price-change/preview", {
        method: "POST",
        body: JSON.stringify({ locationId: locationId || undefined, increase }),
      });
      if (previewSeq.current === requestId) {
        setPreview({ ...data, locationId, increase, effectiveDate });
      }
    } catch (e) {
      if (previewSeq.current === requestId) setResult({ ok: false, text: "Preview failed: " + e.message });
    } finally {
      if (previewSeq.current === requestId) setPreviewing(false);
    }
  };

  const sendNotices = async () => {
    if (!preview || preview.overCap || !preview.count || preview.invalidCount > 0 || sending) return;
    setSending(true);
    setResult(null);
    try {
      const data = await adminFetch("/admin/price-change/send", {
        method: "POST",
        body: JSON.stringify({
          locationId: preview.locationId || undefined,
          increase: preview.increase,
          effectiveDate: preview.effectiveDate,
          cadenceLabel: "month",
          expectedCount: preview.count,
        }),
      });
      setResult({ ok: data.ok !== false, text: data.message || "Notices sent." });
      setPreview(null);
    } catch (e) {
      setResult({ ok: false, text: e.message });
      setPreview(null); // drift/policy error — force a fresh preview
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-surface-page min-h-full font-sans text-zinc-900 max-w-[1100px] mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-18 font-medium text-zinc-900">Price Change Notices</h1>
        <p className="text-12 text-ink-secondary mt-0.5 max-w-2xl">
          Formal advance notice for recurring-service price changes — a short email + text per
          customer linking to their personal notice page (current price, new price, effective date,
          no action needed, cancel anytime). Policy: the effective date must be at least 30 days
          out, and a price change never first appears on a charge. This tool sends notices only —
          it does not change any customer's rate.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Location</label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900"
            >
              {LOCATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Adjustment</label>
            <select
              value={incType}
              onChange={(e) => setIncType(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900"
            >
              <option value="amount">Dollars / month</option>
              <option value="percent">Percent</option>
            </select>
          </div>
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
              {incType === "percent" ? "Change (%)" : "Change ($ / month)"}
            </label>
            <input
              type="number"
              step={incType === "percent" ? "0.5" : "1"}
              value={incValue}
              onChange={(e) => setIncValue(e.target.value)}
              placeholder={incType === "percent" ? "e.g. 5" : "e.g. 3"}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 font-mono"
            />
          </div>
          <div>
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">Effective date</label>
            <input
              type="date"
              value={effectiveDate}
              min={isoDatePlusDays(30)}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 font-mono"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {preview && preview.count > 0 && !preview.overCap && preview.invalidCount === 0 ? (
            <Button onClick={sendNotices} disabled={sending}>
              {sending ? "Sending…" : `Send ${preview.count} notices`}
            </Button>
          ) : (
            <Button onClick={runPreview} disabled={previewing || !paramsValid}>
              {previewing ? "Building preview…" : "Preview affected customers"}
            </Button>
          )}
          {preview && preview.count === 0 && (
            <span className="text-12 text-ink-secondary">No matching recurring customers.</span>
          )}
          {preview && preview.invalidCount > 0 && (
            <span className="text-12 text-alert-fg">
              {preview.invalidCount} customer(s) would go to $0 or below — adjust the amount.
            </span>
          )}
          {preview && preview.overCap && (
            <span className="text-12 text-alert-fg">List exceeds the batch cap — narrow by location.</span>
          )}
          {result && (
            <span className={cn("text-12", result.ok ? "text-zinc-900" : "text-alert-fg")}>{result.text}</span>
          )}
        </div>
      </Card>

      {preview && preview.rows?.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-hairline border-zinc-200 flex items-center gap-2">
            <span className="text-13 font-medium text-zinc-900">
              {preview.count} customers · effective {preview.effectiveDate}
            </span>
            <Badge tone="neutral">notices only — rates unchanged</Badge>
          </div>
          <div className="max-h-[480px] overflow-y-auto">
            <table className="w-full text-13">
              <thead className="bg-zinc-50 border-b border-hairline border-zinc-200 sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left text-11 uppercase tracking-label text-ink-tertiary font-medium">Customer</th>
                  <th className="px-4 py-2 text-right text-11 uppercase tracking-label text-ink-tertiary font-medium">Current</th>
                  <th className="px-4 py-2 text-right text-11 uppercase tracking-label text-ink-tertiary font-medium">New</th>
                  <th className="px-4 py-2 text-right text-11 uppercase tracking-label text-ink-tertiary font-medium">Reach</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.customerId} className="border-b border-hairline border-zinc-100 last:border-b-0">
                    <td className="px-4 py-2 text-zinc-900">{row.name}</td>
                    <td className="px-4 py-2 text-right u-nums text-ink-secondary">{row.current}/mo</td>
                    <td className="px-4 py-2 text-right u-nums font-medium text-zinc-900">{row.next}/mo</td>
                    <td className="px-4 py-2 text-right text-11 text-ink-tertiary">
                      {[row.hasEmail ? "email" : null, row.hasPhone ? "text" : null].filter(Boolean).join(" + ") || "unreachable"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
