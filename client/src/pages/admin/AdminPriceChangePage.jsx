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
import { Badge, Button, Card, Field, Input, Select, UiSurface, Table, THead, TBody, TR, TH, TD, ActionFeedback } from "../../components/ui";

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

export default function AdminPriceChangePage({ embedded = false } = {}) {
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
      // Always clear the spinner — a parameter change mid-flight bumps
      // previewSeq (invalidating the RESULT), but only one request is ever
      // in flight, so an unconditional clear can't race a newer one. Gating
      // this on requestId left the page stuck on "Building preview…".
      setPreviewing(false);
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
          expectedDigest: preview.digest,
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
    <UiSurface density="comfortable" className="min-h-full max-w-[1100px] mx-auto p-4 sm:p-6 space-y-4">
      <div>
        {!embedded && (
          <h1 className="text-22 font-medium text-zinc-900">Price change notices</h1>
        )}
        <p className="text-ui-body text-ink-secondary mt-0.5 max-w-2xl">
          Formal advance notice for recurring-service price changes — a short email + text per
          customer linking to their personal notice page (current price, new price, effective date,
          no action needed, cancel anytime). Policy: the effective date must be at least 30 days
          out, and a price change never first appears on a charge. This tool sends notices only —
          it does not change any customer's rate.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Field label="Location">
            <Select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              {LOCATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Adjustment">
            <Select
              value={incType}
              onChange={(e) => setIncType(e.target.value)}
            >
              <option value="amount">Dollars / month</option>
              <option value="percent">Percent</option>
            </Select>
          </Field>
          <Field label={incType === "percent" ? "Change (%)" : "Change ($ / month)"}>
            <Input
              type="number"
              step={incType === "percent" ? "0.5" : "1"}
              value={incValue}
              onChange={(e) => setIncValue(e.target.value)}
              placeholder={incType === "percent" ? "e.g. 5" : "e.g. 3"}
            />
          </Field>
          <Field label="Effective date">
            <Input
              type="date"
              value={effectiveDate}
              min={isoDatePlusDays(30)}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
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
            <span className="text-ui-body text-ink-secondary">No matching recurring customers.</span>
          )}
          {preview && preview.invalidCount > 0 && (
            <span className="text-ui-body text-alert-fg">
              {preview.invalidCount} customer(s) would go to $0 or below — adjust the amount.
            </span>
          )}
          {preview && preview.overCap && (
            <span className="text-ui-body text-alert-fg">List exceeds the batch cap — narrow by location.</span>
          )}
          {result && (
            <ActionFeedback error={!result.ok}>{result.text}</ActionFeedback>
          )}
        </div>
      </Card>

      {preview && preview.rows?.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-hairline border-zinc-200 flex items-center gap-2">
            <span className="text-ui-body font-medium text-zinc-900">
              {preview.count} customers · effective {preview.effectiveDate}
            </span>
            <Badge tone="neutral">notices only — rates unchanged</Badge>
          </div>
          {/* The bound has to live on Table's own container: that wrapper is the
              sticky THead's nearest overflow ancestor, so a separate outer
              scroller would scroll the headings out of view. */}
          <Table
            layout="records"
            containerClassName="max-h-[480px] overflow-y-auto"
            aria-label="Affected customers"
          >
            <THead className="bg-zinc-50 border-b border-hairline border-zinc-200 sticky top-0">
              <TR>
                <TH className="px-4 py-2 text-left text-ui-body text-ink-tertiary font-medium">Customer</TH>
                <TH className="px-4 py-2 text-right text-ui-body text-ink-tertiary font-medium">Current</TH>
                <TH className="px-4 py-2 text-right text-ui-body text-ink-tertiary font-medium">New</TH>
                <TH className="px-4 py-2 text-right text-ui-body text-ink-tertiary font-medium">Reach</TH>
              </TR>
            </THead>
            <TBody>
              {preview.rows.map((row) => (
                <TR key={row.customerId} className="border-b border-hairline border-zinc-100 last:border-b-0">
                  <TD data-label="Customer" className="px-4 py-2 text-zinc-900">{row.name}</TD>
                  <TD data-label="Current" className="px-4 py-2 text-right u-nums text-ink-secondary">{row.current}/mo</TD>
                  <TD data-label="New" className="px-4 py-2 text-right u-nums font-medium text-zinc-900">{row.next}/mo</TD>
                  <TD data-label="Reach" className="px-4 py-2 text-right text-ui-body text-ink-tertiary">
                    {[row.hasEmail ? "email" : null, row.hasPhone ? "text" : null].filter(Boolean).join(" + ") || "unreachable"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </UiSurface>
  );
}
