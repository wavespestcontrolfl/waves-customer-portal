import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Beaker,
  Calculator,
  Camera,
  CheckCircle2,
  ClipboardList,
  Leaf,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import { adminFetch } from '../../utils/admin-fetch';
import { Button, Badge, cn } from '../ui';

function isLawnService(service) {
  return String(service?.serviceType || service?.service_type || '').toLowerCase().includes('lawn');
}

function statusTone(status) {
  if (status === 'approved') return 'strong';
  if (status === 'blocked') return 'alert';
  return 'neutral';
}

function fmtNumber(value, suffix = '') {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 3 })}${suffix}`;
}

function Field({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="u-label text-ink-tertiary mb-0.5">{label}</div>
      <div className="text-13 text-zinc-900 truncate">{value || '—'}</div>
    </div>
  );
}

function PlanCard({ icon: Icon, title, children, right }) {
  return (
    <section className="bg-white border-hairline border-zinc-200 rounded-md">
      <div className="h-11 px-4 border-b-hairline border-zinc-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={16} strokeWidth={1.75} className="text-zinc-700 flex-shrink-0" />
          <h3 className="text-13 font-medium text-zinc-900 truncate">{title}</h3>
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function NoticeList({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <div className={cn(
      'rounded-sm border-hairline p-3',
      tone === 'alert' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
    )}>
      <div className={cn('text-12 font-medium mb-2', tone === 'alert' ? 'text-red-900' : 'text-amber-900')}>
        {title}
      </div>
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={`${item.code || idx}-${idx}`} className={cn('text-12 leading-snug', tone === 'alert' ? 'text-red-800' : 'text-amber-800')}>
            <span className="font-medium">{item.code ? item.code.replace(/_/g, ' ') : 'Notice'}:</span> {item.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductLine({ item, checked, onToggle }) {
  const product = item.product;
  const mix = item.mix;
  return (
    <div className="border-hairline border-zinc-200 rounded-sm p-3">
      <div className="flex items-start gap-3">
        {item.conditional && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="mt-1 h-4 w-4 accent-zinc-900"
            aria-label={`Select ${product?.name || item.raw}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-13 font-medium text-zinc-900">{product?.name || item.raw}</span>
            {item.conditional && <Badge tone="neutral">{checked ? 'Selected' : 'Optional'}</Badge>}
            {!item.matched && <Badge tone="alert">Unmatched</Badge>}
          </div>
          <div className="text-12 text-ink-secondary mt-1 leading-snug">{item.raw}</div>
          {product && (
            <div className="flex gap-3 flex-wrap mt-2 text-11 text-ink-secondary">
              {product.category && <span>{product.category}</span>}
              {product.groups?.frac && <span>FRAC {product.groups.frac}</span>}
              {product.groups?.irac && <span>IRAC {product.groups.irac}</span>}
              {product.groups?.hrac && <span>HRAC {product.groups.hrac}</span>}
              {product.groups?.moa && <span>MOA {product.groups.moa}</span>}
            </div>
          )}
        </div>
        {mix?.amount != null && (
          <div className="text-right flex-shrink-0">
            <div className="u-nums text-13 font-medium text-zinc-900">{fmtNumber(mix.amount)}</div>
            <div className="text-11 text-ink-secondary">{mix.amountUnit || ''}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TreatmentPlanPanel({ service, onClose }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [equipmentSystemId, setEquipmentSystemId] = useState('');
  const [equipmentOptions, setEquipmentOptions] = useState([]);
  const [selectedConditionalIds, setSelectedConditionalIds] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const serviceId = service?.id;
  const canLoad = serviceId && isLawnService(service);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (equipmentSystemId) params.set('equipmentSystemId', equipmentSystemId);
    if (selectedConditionalIds.length) params.set('selectedConditionalProductIds', selectedConditionalIds.join(','));
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [equipmentSystemId, selectedConditionalIds]);

  useEffect(() => {
    if (!canLoad) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    adminFetch(`/admin/treatment-plans/${serviceId}${query}`)
      .then((data) => {
        if (cancelled) return;
        const nextPlan = data.plan || null;
        setPlan(nextPlan);
        const options = nextPlan?.equipmentCalibration?.options || [];
        if (options.length) setEquipmentOptions(options);
        if (!equipmentSystemId && options.length === 1 && options[0].equipmentSystemId) {
          setEquipmentSystemId(options[0].equipmentSystemId);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load treatment plan');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [canLoad, serviceId, query, equipmentSystemId, refreshKey]);

  const options = equipmentOptions.length ? equipmentOptions : (plan?.equipmentCalibration?.options || []);
  const blocks = plan?.propertyGate?.blocks || [];
  const warnings = plan?.propertyGate?.warnings || [];
  const base = plan?.protocol?.base || [];
  const conditional = plan?.protocol?.conditional || [];
  const plannedItems = plan?.mixCalculator?.items || [];
  const conditionalOptions = plan?.mixCalculator?.conditionalOptions || conditional.filter((item) => !item.selected);

  function toggleConditional(item) {
    const id = item.product?.id;
    if (!id) return;
    setSelectedConditionalIds((prev) => (
      prev.includes(String(id))
        ? prev.filter((v) => v !== String(id))
        : [...prev, String(id)]
    ));
  }

  return (
    <div className="fixed inset-0 z-[1000] bg-zinc-900/35" role="dialog" aria-modal="true">
      <div className="absolute inset-y-0 right-0 w-full md:w-[760px] bg-surface-page shadow-2xl flex flex-col">
        <div className="h-16 px-4 md:px-5 bg-white border-b-hairline border-zinc-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Leaf size={17} strokeWidth={1.75} className="text-zinc-800" />
              <h2 className="text-15 font-medium text-zinc-900 truncate">WaveGuard Treatment Plan</h2>
              {plan?.status && <Badge tone={statusTone(plan.status)}>{plan.status}</Badge>}
            </div>
            <div className="text-12 text-ink-secondary truncate mt-0.5">
              {service?.customerName || plan?.propertyGate?.customerName || 'Customer'} · {service?.serviceType || plan?.propertyGate?.service || 'Lawn service'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-11 w-11 inline-flex items-center justify-center rounded-sm border-hairline border-zinc-200 bg-white text-zinc-700 u-focus-ring"
            aria-label="Close treatment plan"
          >
            <X size={18} />
          </button>
        </div>

        {!canLoad ? (
          <div className="p-6 text-13 text-ink-secondary">Treatment plans are available for lawn services.</div>
        ) : loading && !plan ? (
          <div className="p-6 text-13 text-ink-secondary">Loading treatment plan…</div>
        ) : error ? (
          <div className="p-6">
            <NoticeList title="Plan unavailable" tone="alert" items={[{ code: 'load_failed', message: error }]} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 md:p-5 space-y-4">
            <PlanCard icon={AlertTriangle} title="Property Gate" right={<Button size="sm" variant="secondary" onClick={() => setRefreshKey((k) => k + 1)}><RefreshCw size={14} /> Refresh</Button>}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <Field label="Track" value={plan.propertyGate?.trackName || plan.propertyGate?.trackKey} />
                <Field label="Month / Visit" value={`${plan.propertyGate?.month || '—'} / ${plan.propertyGate?.visit || '—'}`} />
                <Field label="Lawn Area" value={plan.propertyGate?.lawnSqft ? `${Number(plan.propertyGate.lawnSqft).toLocaleString()} sq ft` : '—'} />
                <Field label="Municipality" value={plan.propertyGate?.municipality || plan.propertyGate?.county} />
                <Field label="Ordinance" value={plan.propertyGate?.ordinanceStatus} />
                <Field label="Annual N" value={`${fmtNumber(plan.propertyGate?.annualN?.used)} used / ${fmtNumber(plan.propertyGate?.annualN?.limit)} limit`} />
                <Field label="Projected N" value={`${fmtNumber(plan.propertyGate?.annualN?.projected)} (${plan.propertyGate?.annualN?.status || '—'})`} />
                <Field label="N Remaining" value={fmtNumber(plan.propertyGate?.annualN?.remainingAfterVisit)} />
                <Field label="N Ledger" value={`${fmtNumber(plan.propertyGate?.annualN?.ledgerEntries)} entries`} />
                <Field label="Assessment" value={plan.propertyGate?.latestAssessment?.overallScore ? `${plan.propertyGate.latestAssessment.overallScore}/100` : '—'} />
              </div>
              <div className="space-y-3">
                <NoticeList title="Blocks" tone="alert" items={blocks} />
                <NoticeList title="Warnings" tone="warning" items={warnings} />
              </div>
            </PlanCard>

            <PlanCard icon={ClipboardList} title="Track + Month Protocol">
              <div className="text-12 text-ink-secondary leading-snug mb-3">{plan.protocol?.objective || 'No protocol objective available.'}</div>
              <div className="space-y-2">
                {base.map((item, idx) => (
                  <ProductLine key={`base-${idx}-${item.raw}`} item={item} checked={item.selected} onToggle={() => toggleConditional(item)} />
                ))}
              </div>
              {conditional.length > 0 && (
                <div className="mt-4">
                  <div className="u-label text-ink-secondary mb-2">Conditional Add-ons</div>
                  <div className="space-y-2">
                    {conditional.map((item, idx) => (
                      <ProductLine
                        key={`cond-${idx}-${item.raw}`}
                        item={item}
                        checked={selectedConditionalIds.includes(String(item.product?.id)) || !!item.selected}
                        onToggle={() => toggleConditional(item)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </PlanCard>

            <PlanCard icon={Wrench} title="Equipment Calibration">
              {options.length > 0 && (
                <div className="mb-4">
                  <label className="u-label text-ink-secondary block mb-1">Equipment</label>
                  <select
                    value={equipmentSystemId}
                    onChange={(e) => setEquipmentSystemId(e.target.value)}
                    className="h-11 md:h-9 w-full rounded-sm bg-white border-hairline border-zinc-300 px-3 text-14 md:text-13 u-focus-ring"
                  >
                    <option value="">Select equipment system</option>
                    {options.map((opt) => (
                      <option key={opt.equipmentSystemId} value={opt.equipmentSystemId}>
                        {opt.systemName} · {fmtNumber(opt.carrierGalPer1000, ' gal/1K')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Selected" value={plan.equipmentCalibration?.selected?.system_name} />
                <Field label="Carrier" value={fmtNumber(plan.mixCalculator?.carrierGalPer1000, ' gal/1K')} />
                <Field label="Tank" value={fmtNumber(plan.mixCalculator?.tankCapacityGal, ' gal')} />
                <Field label="Lawn Area" value={fmtNumber(plan.mixCalculator?.lawnSqft, ' sq ft')} />
              </div>
            </PlanCard>

            <PlanCard icon={Calculator} title="Mix Calculator">
              <div className="grid grid-cols-3 gap-2 mb-4">
                <div className="border-hairline border-zinc-200 rounded-sm p-3">
                  <div className="u-label text-ink-tertiary">N / 1K</div>
                  <div className="u-nums text-16 font-medium text-zinc-900">{fmtNumber(plan.mixCalculator?.nutrientProjection?.nPer1000)}</div>
                </div>
                <div className="border-hairline border-zinc-200 rounded-sm p-3">
                  <div className="u-label text-ink-tertiary">P / 1K</div>
                  <div className="u-nums text-16 font-medium text-zinc-900">{fmtNumber(plan.mixCalculator?.nutrientProjection?.pPer1000)}</div>
                </div>
                <div className="border-hairline border-zinc-200 rounded-sm p-3">
                  <div className="u-label text-ink-tertiary">K / 1K</div>
                  <div className="u-nums text-16 font-medium text-zinc-900">{fmtNumber(plan.mixCalculator?.nutrientProjection?.kPer1000)}</div>
                </div>
              </div>
              <div className="space-y-2">
                {plannedItems.length === 0 ? (
                  <div className="text-13 text-ink-secondary">No planned products selected yet.</div>
                ) : plannedItems.map((item, idx) => (
                  <ProductLine key={`mix-${idx}-${item.raw}`} item={item} checked={true} onToggle={() => toggleConditional(item)} />
                ))}
              </div>
              {conditionalOptions.length > 0 && (
                <div className="text-12 text-ink-secondary mt-3">
                  {conditionalOptions.length} optional product{conditionalOptions.length === 1 ? '' : 's'} excluded from mix math until selected.
                </div>
              )}
            </PlanCard>

            <PlanCard icon={Beaker} title="Mixing Order">
              {plan.mixingOrder?.length ? (
                <div className="space-y-2">
                  {plan.mixingOrder.map((step) => (
                    <div key={`${step.step}-${step.productId}`} className="flex gap-3 border-hairline border-zinc-200 rounded-sm p-3">
                      <div className="h-6 w-6 rounded-xs bg-zinc-900 text-white text-12 u-nums flex items-center justify-center flex-shrink-0">{step.step}</div>
                      <div className="min-w-0">
                        <div className="text-13 font-medium text-zinc-900">{step.productName}</div>
                        <div className="text-12 text-ink-secondary leading-snug mt-1">{step.instruction}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-13 text-ink-secondary">Select equipment and planned products to build the mix order.</div>
              )}
            </PlanCard>

            <PlanCard icon={Camera} title="Inspection / Photo / Closeout" right={<CheckCircle2 size={16} className="text-zinc-700" />}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label="Photos" value={(plan.closeout?.requiredPhotos || []).join(', ')} />
                <Field label="Actual Amounts" value={plan.closeout?.captureActualProductAmounts ? 'Required' : 'Not required'} />
                <Field label="Recap" value={plan.closeout?.customerRecapPreview} />
              </div>
            </PlanCard>
          </div>
        )}
      </div>
    </div>
  );
}
