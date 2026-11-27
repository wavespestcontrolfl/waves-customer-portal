// Services -> Treatments -> Mix safety (owner 2026-11-27): which products can share a tank. One rule names two products,
// or a product and a product group. Every answer is a warning only: nothing here blocks a visit or a product.
// Server: server/routes/admin-product-mix-rules.js + server/services/product-mix-rules.js.
import { useEffect, useMemo, useState } from "react";
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

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
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
  const chosen = picked.filter(Boolean);
  const nameOf = (id) => products.find((p) => p.id === id)?.name || "Unknown product";

  async function checkTank() {
    setChecking(true);
    setError("");
    try {
      const ids = [...new Set(chosen)].join(",");
      setResult(await readJson(await adminFetch(`/admin/product-mix-rules/check?productIds=${encodeURIComponent(ids)}`)));
    } catch (err) {
      setError(err.message || "Could not check the tank");
    } finally {
      setChecking(false);
    }
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
              onChange={(v) => setPicked((prev) => prev.map((old, i) => (i === index ? v : old)))}
              products={products}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={picked.length >= TANK_MAX} onClick={() => setPicked((prev) => [...prev, ""])}>Add product</Button>
          <Button onClick={checkTank} loading={checking} disabled={checking || new Set(chosen).size < 2}>Check</Button>
        </div>
        {error && <ActionFeedback error>{error}</ActionFeedback>}
        {result && (
          <ul className="grid gap-2" aria-label="Tank check result">
            {result.pairs.map((pair) => (
              <li key={`${pair.productAId}-${pair.productBId}`} className="rounded-sm border-hairline border-zinc-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-14 font-medium">
                  <span>{pair.productAName || nameOf(pair.productAId)} + {pair.productBName || nameOf(pair.productBId)}</span>
                  <VerdictBadge verdict={pair.verdict} />
                  {pair.jarTestRequired && <Badge tone="warn">Jar test first</Badge>}
                </div>
                <div className="mt-1 text-14 text-zinc-700">{pair.reason}</div>
                {pair.entries.length > 1 && (
                  <ul className="mt-1 list-disc pl-5 text-14 text-ink-secondary">
                    {pair.entries.slice(1).map((entry, i) => (
                              <li key={i}>{VERDICT_TEXT[entry.verdict]?.label || entry.verdict}: {entry.reason}</li>
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
    const body = {
      productAId: form.productAId,
      productBId: form.mode === "product" ? form.productBId : null,
      groupB: form.mode === "group" ? form.groupB : null,
      verdict: form.verdict,
      reason: form.reason,
      source: form.source,
      jarTestRequired: form.jarTestRequired,
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
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(rule) {
    setError("");
    try {
      await readJson(await adminFetch(`/admin/product-mix-rules/${rule.id}`, { method: "DELETE" }));
      setNotice("Rule removed");
      await loadRules();
    } catch (err) {
      setError(err.message || "Could not remove the rule");
    }
  }

  const editRule = (rule) => setForm({
    id: rule.id,
    productAId: rule.productAId,
    mode: rule.productBId ? "product" : "group",
    productBId: rule.productBId || "",
    groupB: rule.groupB || "",
    verdict: rule.verdict,
    reason: rule.reason,
    source: rule.source || "",
    jarTestRequired: rule.jarTestRequired,
  });

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
                    <TD className="max-w-[320px] text-ink-secondary">{rule.source}</TD>
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
          onCancel={() => setForm(null)}
        />
      )}
      {!loading && <TankCheck products={products} />}
    </div>
  );
}
