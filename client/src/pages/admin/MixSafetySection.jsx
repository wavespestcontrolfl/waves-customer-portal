// Services -> Treatments -> Mix safety (owner 2026-11-27): which products can share a tank. One rule names two products,
// or a product and a product group. Every answer is a warning only: nothing here blocks a visit or a product.
// Server: server/routes/admin-product-mix-rules.js + server/services/product-mix-rules.js.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Checkbox,
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
import { adminFetch } from "../../lib/adminFetch";

const REASON_MAX = 200;
const TANK_MAX = 5;

export const VERDICT_TEXT = {
  ok: { label: "Yes", tone: "neutral" },
  caution: { label: "Caution", tone: "warn" },
  never: { label: "Never", tone: "alert" },
  unknown: { label: "No rule", tone: "neutral" },
};

const EMPTY_FORM = {
  id: null,
  productAId: "",
  mode: "product",
  productBId: "",
  groupB: "",
  verdict: "caution",
  reason: "",
  source: "owner",
  jarTestRequired: false,
};

// The Source column shows a plain word; the stored text (file, migration or card quote) stays in the cell's title.
// A label quote reads "Label", a catalog compatibility note reads "Catalog" (it is not a verified label direction),
// a field-guide limits quote reads "Field guide" (its limits mix label text and Waves rules), a Waves card or safety
// rule reads "Waves rule", and a short source someone typed in the form shows as typed.
export function sourceLabel(source) {
  const text = String(source || "").trim();
  if (!text) return "—";
  if (/^owner$/i.test(text)) return "Owner";
  if (/^(card|card rule|waves rule)$/i.test(text)) return "Waves rule";
  const technical = /\.(json|js|md)\b|migration|safety_rules|card lines?\b|^Catalog row/i.test(text);
  if (!technical) return text;
  if (/^Catalog row/i.test(text)) return "Catalog";
  // The field guide file's limits, or the tree & shrub visit field guide on the card (the TriTek and SuffOil-X oil rules).
  if (/field-guide\.json .* limits:|\bvisit field guide\b/i.test(text)) return "Field guide";
  // Only a quote that states what the label says reads "Label"; a mere mention ("not on the label") is not.
  if (/\b(the label (says|states|bars|bans|requires)|specimen label|label:)/i.test(text)) return "Label";
  if (/safety_rules|card lines?\b/i.test(text)) return "Waves rule";
  // A file or migration source this does not recognize: say so plainly; the stored text stays in the title.
  return "Other (see note)";
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: response.status, data });
  return data;
}

function VerdictBadge({ verdict }) {
  const shown = VERDICT_TEXT[verdict] || VERDICT_TEXT.unknown;
  return <Badge tone={shown.tone}>{shown.label}</Badge>;
}

// A name filter over the catalog, then a list to pick from.
function ProductPicker({ label, value, onChange, products }) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const list = words ? products.filter((p) => p.name.toLowerCase().includes(words) || p.id === value) : products;
    return list;
  }, [filter, products, value]);
  return (
    <div className="grid gap-1">
      <Field label={label}>
        <Select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Pick a product</option>
          {shown.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Input
        aria-label={`Search ${label}`}
        placeholder="Type to narrow the list"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
    </div>
  );
}

function RuleForm({ form, setForm, products, groups, saving, onSave, onCancel }) {
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  return (
    <Card>
      <CardHeader><CardTitle>{form.id ? "Edit rule" : "Add a rule"}</CardTitle></CardHeader>
      <CardBody className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <ProductPicker label="Product" value={form.productAId} onChange={(v) => set({ productAId: v })} products={products} />
          <div className="grid gap-1">
            <Field label="Mixed with">
              <Select value={form.mode} onChange={(event) => set({ mode: event.target.value })}>
                <option value="product">Another product</option>
                <option value="group">A product group</option>
              </Select>
            </Field>
            {form.mode === "product" ? (
              <ProductPicker label="Second product" value={form.productBId} onChange={(v) => set({ productBId: v })} products={products} />
            ) : (
              <Field label="Product group">
                <Select value={form.groupB} onChange={(event) => set({ groupB: event.target.value })}>
                  <option value="">Pick a group</option>
                  {groups.map((g) => (
                    <option key={g.key} value={g.key}>{g.label}</option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[160px_1fr]">
          <Field label="Can mix?">
            <Select value={form.verdict} onChange={(event) => set({ verdict: event.target.value })}>
              <option value="ok">Yes</option>
              <option value="caution">Caution</option>
              <option value="never">Never</option>
            </Select>
          </Field>
          <Field label="Reason (the tech reads this)" help={`${form.reason.length} of ${REASON_MAX} characters`}>
            <Input maxLength={REASON_MAX} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        </div>
        <Field label="Source (label section, card rule, or owner)">
          <Input value={form.source} onChange={(event) => set({ source: event.target.value })} />
        </Field>
        <Checkbox
          id="mix-rule-jar-test"
          label="Jar test first"
          checked={form.jarTestRequired}
          onChange={(event) => set({ jarTestRequired: event.target.checked })}
        />
        <div className="flex gap-2">
          <Button onClick={onSave} loading={saving} disabled={saving}>Save rule</Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        </div>
      </CardBody>
    </Card>
  );
}

function TankCheck({ products }) {
  const [picked, setPicked] = useState(["", ""]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const lastRequest = useRef(0);
  const chosen = picked.filter(Boolean);
  // The selection a result answers: the same products in any order. A result shows only while it matches.
  const selectionKey = [...new Set(chosen)].sort().join(",");
  const shownResult = result && result.key === selectionKey ? result.data : null;
  const nameOf = (id) => products.find((p) => p.id === id)?.name || "Unknown product";

  async function checkTank() {
    const request = lastRequest.current + 1;
    lastRequest.current = request;
    const key = selectionKey;
    setChecking(true);
    setError("");
    // An answer from an earlier check never stays on screen while this one runs or after it fails.
    setResult(null);
    try {
      const ids = [...new Set(chosen)].join(",");
      const data = await readJson(await adminFetch(`/admin/product-mix-rules/check?productIds=${encodeURIComponent(ids)}`));
      // A later request, or a changed selection, wins over this answer.
      if (lastRequest.current === request) setResult({ key, data });
    } catch {
      if (lastRequest.current === request) setError("Check failed. Try again.");
    } finally {
      if (lastRequest.current === request) setChecking(false);
    }
  }

  function pick(index, value) {
    lastRequest.current += 1;
    setChecking(false);
    setError("");
    setResult(null);
    setPicked((prev) => prev.map((old, i) => (i === index ? value : old)));
  }

  return (
    <Card>
      <CardHeader><CardTitle>Check a tank</CardTitle></CardHeader>
      <CardBody className="grid gap-3">
        <p className="text-14 text-ink-secondary">Pick 2 to {TANK_MAX} products. You see the answer for each pair. It is a warning only.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {picked.map((value, index) => (
            <ProductPicker
              key={index}
              label={`Tank product ${index + 1}`}
              value={value}
              onChange={(v) => pick(index, v)}
              products={products}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={picked.length >= TANK_MAX} onClick={() => setPicked((prev) => [...prev, ""])}>Add product</Button>
          <Button onClick={checkTank} loading={checking} disabled={checking || new Set(chosen).size < 2}>Check</Button>
        </div>
        {error && <ActionFeedback error>{error}</ActionFeedback>}
        {shownResult && (
          <ul className="grid gap-2" aria-label="Tank check result">
            {shownResult.pairs.map((pair) => (
              <li key={`${pair.productAId}-${pair.productBId}`} className="rounded-sm border-hairline border-zinc-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-14 font-medium">
                  <span>{pair.productAName || nameOf(pair.productAId)} + {pair.productBName || nameOf(pair.productBId)}</span>
                  <VerdictBadge verdict={pair.verdict} />
                  {pair.jarTestRequired && <Badge tone="warn">Jar test first</Badge>}
                </div>
                <div className="mt-1 text-14 text-zinc-700">{pair.reason}</div>
                {pair.entries.length > 1 && (
                  <ul className="mt-1 list-disc pl-5 text-14 text-ink-secondary">
                    {/* The server lists the headline entry first; the rest are every other match, once. */}
                    {pair.entries.slice(1).map((entry, i) => (
                      // An older catalog note under a pair rule carries no verdict of its own.
                      <li key={i}>{entry.verdict ? `${VERDICT_TEXT[entry.verdict]?.label || entry.verdict}: ` : ""}{entry.reason}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export default function MixSafetySection() {
  const [rules, setRules] = useState([]);
  const [products, setProducts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  // Add rule on a pair that already has an active rule: the server answers 409 with that rule; offer to edit it.
  const [existing, setExisting] = useState(null);

  async function loadRules() {
    setLoading(true);
    setError("");
    try {
      const data = await readJson(await adminFetch("/admin/product-mix-rules"));
      setRules(data.rules || []);
      setProducts(data.products || []);
      setGroups(data.groups || []);
    } catch (err) {
      setError(err.message || "Could not load the mix rules");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadRules(); }, []);

  async function saveRule() {
    setSaving(true);
    setError("");
    setExisting(null);
    const body = {
      productAId: form.productAId,
      productBId: form.mode === "product" ? form.productBId : null,
      groupB: form.mode === "group" ? form.groupB : null,
      verdict: form.verdict,
      reason: form.reason,
      source: form.source,
      jarTestRequired: form.jarTestRequired,
      // An edit carries the version it was loaded at; the server answers 409 "This rule changed. Reload it." when the
      // rule changed since.
      ...(form.id ? { version: form.version } : {}),
    };
    try {
      await readJson(await (form.id
        ? adminFetch(`/admin/product-mix-rules/${form.id}`, { method: "PUT", body })
        : adminFetch("/admin/product-mix-rules", { method: "POST", body })));
      setForm(null);
      setNotice("Rule saved");
      await loadRules();
    } catch (err) {
      setError(err.message || "Could not save the rule");
      if (!form.id && err.status === 409 && err.data?.rule) setExisting(err.data.rule);
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(rule) {
    setError("");
    try {
      await readJson(await adminFetch(`/admin/product-mix-rules/${rule.id}?version=${rule.version}`, { method: "DELETE" }));
      setNotice("Rule removed");
      await loadRules();
    } catch (err) {
      setError(err.message || "Could not remove the rule");
    }
  }

  const editRule = (rule) => { setExisting(null); setError(""); setForm({
    id: rule.id,
    productAId: rule.productAId,
    mode: rule.productBId ? "product" : "group",
    productBId: rule.productBId || "",
    groupB: rule.groupB || "",
    verdict: rule.verdict,
    reason: rule.reason,
    source: rule.source || "",
    jarTestRequired: rule.jarTestRequired,
    version: rule.version,
  }); };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Mix safety</CardTitle>
          {!form && <Button onClick={() => { setNotice(""); setForm({ ...EMPTY_FORM }); }}>Add rule</Button>}
        </CardHeader>
        <CardBody className="grid gap-3">
          <p className="text-14 text-ink-secondary">
            Can these products go in the same tank? Each answer is a warning for the tech. It never blocks a product.
          </p>
          {error && <ActionFeedback error>{error}</ActionFeedback>}
          {existing && (
            <div className="flex flex-wrap items-center gap-2 text-14">
              <span>Current rule: {VERDICT_TEXT[existing.verdict]?.label || existing.verdict}. {existing.reason}</span>
              <Button variant="secondary" onClick={() => editRule(existing)}>Edit that rule</Button>
            </div>
          )}
          {notice && <ActionFeedback>{notice}</ActionFeedback>}
          {loading ? (
            <ActionFeedback>Loading mix rules…</ActionFeedback>
          ) : rules.length === 0 ? (
            <ActionFeedback>No rules yet.</ActionFeedback>
          ) : (
            <Table aria-label="Mix safety rules">
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Mixed with</TH>
                  <TH>Can mix?</TH>
                  <TH>Reason</TH>
                  <TH>Source</TH>
                  <TH><span className="sr-only">Actions</span></TH>
                </TR>
              </THead>
              <TBody>
                {rules.map((rule) => (
                  <TR key={rule.id}>
                    <TD>{rule.productAName || "Unknown product"}</TD>
                    <TD>{rule.productBId ? (rule.productBName || "Unknown product") : `Group: ${rule.groupLabel || rule.groupB}`}</TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        <VerdictBadge verdict={rule.verdict} />
                        {rule.jarTestRequired && <Badge tone="warn">Jar test first</Badge>}
                      </div>
                    </TD>
                    <TD>{rule.reason}</TD>
                    <TD className="text-ink-secondary" title={rule.source || undefined}>{sourceLabel(rule.source)}</TD>
                    <TD>
                      <div className="flex gap-1">
                        <Button size="sm" variant="secondary" onClick={() => { setNotice(""); editRule(rule); }}>Edit</Button>
                        <Button size="sm" variant="ghost" onClick={() => removeRule(rule)}>Remove</Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
      {form && (
        <RuleForm
          form={form}
          setForm={setForm}
          products={products}
          groups={groups}
          saving={saving}
          onSave={saveRule}
          onCancel={() => { setForm(null); setExisting(null); }}
        />
      )}
      {!loading && <TankCheck products={products} />}
    </div>
  );
}
