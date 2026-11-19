// The Plan tab of the Protocol panel (lawn visits): the visit's lawn facts, nitrogen budget,
// blocks and warnings, protocol lines and closeout list, from GET /admin/treatment-plans/:id.
// It shows no product amount and no rate: amounts live on the Job tab only, under the Job tab's own
// withhold rules (blocked plan, no rig carrier rate, unverified label, spray-check hold). A protocol line
// shows its server `description` (the Job tab's line-text rule: no rate, no price), never `raw`.
import { AlertTriangle, Camera, ClipboardList, Leaf, RefreshCw } from 'lucide-react';
import { Button, Badge, cn } from '../ui';

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
      <div className="text-14 text-zinc-900 break-words">{value || '—'}</div>
    </div>
  );
}

function PlanCard({ icon: Icon, title, children, right }) {
  return (
    <section className="bg-white border-hairline border-zinc-200 rounded-md">
      <div className="min-h-11 px-4 border-b-hairline border-zinc-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={16} strokeWidth={1.75} className="text-zinc-700 flex-shrink-0" />
          <h3 className="text-14 font-medium text-zinc-900">{title}</h3>
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
      <div className={cn('text-14 font-medium mb-2', tone === 'alert' ? 'text-red-900' : 'text-amber-900')}>
        {title}
      </div>
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={`${item.code || idx}-${idx}`} className={cn('text-14 leading-snug', tone === 'alert' ? 'text-red-800' : 'text-amber-800')}>
            <span className="font-medium">{item.code ? item.code.replace(/_/g, ' ') : 'Notice'}:</span> {item.description || item.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProtocolLine({ item }) {
  const product = item.product;
  return (
    <div className="border-hairline border-zinc-200 rounded-sm p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-14 font-medium text-zinc-900">{product?.name || item.description}</span>
        {item.conditional && <Badge tone="neutral">{item.selected ? 'Selected' : 'Optional'}</Badge>}
        {!item.matched && <Badge tone="alert">Unmatched</Badge>}
      </div>
      <div className="text-14 text-ink-secondary mt-1 leading-snug">{item.description}</div>
      {product && (
        <div className="flex gap-3 flex-wrap mt-2 text-14 text-ink-secondary">
          {product.category && <span>{product.category}</span>}
          {product.groups?.frac && <span>FRAC {product.groups.frac}</span>}
          {product.groups?.irac && <span>IRAC {product.groups.irac}</span>}
          {product.groups?.hrac && <span>HRAC {product.groups.hrac}</span>}
          {product.groups?.moa && <span>MOA {product.groups.moa}</span>}
        </div>
      )}
    </div>
  );
}

function LawnFacts({ plan, onRefresh }) {
  const gate = plan.propertyGate || {};
  const annualN = gate.annualN || {};
  const nutrients = plan.mixCalculator?.nutrientProjection || {};
  return (
    <>
      <PlanCard
        icon={Leaf}
        title="Lawn facts"
        right={<Button size="sm" variant="secondary" onClick={onRefresh}><RefreshCw size={14} /> Refresh</Button>}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Track" value={gate.trackName || gate.trackKey} />
          <Field label="Month / Visit" value={`${gate.month || '—'} / ${gate.visit || '—'}`} />
          <Field label="Lawn Area" value={gate.lawnSqft ? `${Number(gate.lawnSqft).toLocaleString()} sq ft` : '—'} />
          <Field label="Municipality" value={gate.municipality || gate.county} />
          <Field label="Ordinance" value={gate.ordinanceStatus} />
          <Field label="Carrier" value={fmtNumber(plan.mixCalculator?.carrierGalPer1000, ' gal/1K')} />
          <Field label="Assessment" value={gate.latestAssessment?.overallScore ? `${gate.latestAssessment.overallScore}/100` : '—'} />
        </div>
      </PlanCard>
      <PlanCard icon={AlertTriangle} title="Nitrogen budget">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Annual N" value={`${fmtNumber(annualN.used)} used / ${fmtNumber(annualN.limit)} limit`} />
          <Field label="Projected N" value={`${fmtNumber(annualN.projected)} (${annualN.status || '—'})`} />
          <Field label="N Remaining" value={fmtNumber(annualN.remainingAfterVisit)} />
          <Field label="N Ledger" value={`${fmtNumber(annualN.ledgerEntries)} entries`} />
        </div>
        <div className="grid grid-cols-3 gap-2 mt-4">
          {[['N / 1K', nutrients.nPer1000], ['P / 1K', nutrients.pPer1000], ['K / 1K', nutrients.kPer1000]].map(([label, value]) => (
            <div key={label} className="border-hairline border-zinc-200 rounded-sm p-3">
              <div className="u-label text-ink-tertiary">{label}</div>
              <div className="u-nums text-16 font-medium text-zinc-900">{fmtNumber(value)}</div>
            </div>
          ))}
        </div>
      </PlanCard>
    </>
  );
}

// The note under the protocol lines names the tab that carries the mix amounts, by `jobTab`: true = the panel has a
// Job tab; false = it does not (the legacy Lawn tab then carries the mix); null or not given = not known yet, no note.
const AMOUNTS_NOTE = {
  true: 'Amounts show on the Job tab.',
  false: 'The Job tab is off. Mix amounts show on the Lawn tab.',
};

export default function LawnPlanTab({ plan, loading, error, onRefresh, jobTab }) {
  if (error) {
    return <NoticeList title="Plan unavailable" tone="alert" items={[{ code: 'load_failed', message: error }]} />;
  }
  if (!plan) {
    return <div className="p-6 text-14 text-ink-secondary text-center">{loading ? 'Loading plan…' : 'Plan unavailable right now.'}</div>;
  }
  const blocks = plan.propertyGate?.blocks || [];
  const warnings = plan.propertyGate?.warnings || [];
  const base = plan.protocol?.base || [];
  const conditional = plan.protocol?.conditional || [];
  const closeout = plan.closeout || {};
  return (
    <div className="space-y-4">
      <LawnFacts plan={plan} onRefresh={onRefresh} />
      {(blocks.length > 0 || warnings.length > 0) && (
        <div className="space-y-3">
          <NoticeList title="Blocks" tone="alert" items={blocks} />
          <NoticeList title="Warnings" tone="warning" items={warnings} />
        </div>
      )}
      <PlanCard icon={ClipboardList} title="Protocol lines">
        <div className="text-14 text-ink-secondary leading-snug mb-3">{plan.protocol?.objectiveDescription || 'No protocol objective available.'}</div>
        <div className="space-y-2">
          {[...base, ...conditional].map((item, idx) => (
            <ProtocolLine key={`${idx}-${item.raw}`} item={item} />
          ))}
        </div>
        {AMOUNTS_NOTE[jobTab] && <div className="text-14 text-ink-secondary mt-3">{AMOUNTS_NOTE[jobTab]}</div>}
      </PlanCard>
      <PlanCard icon={Camera} title="Closeout">
        <div className="grid grid-cols-1 gap-3">
          <Field label="Photos" value={(closeout.requiredPhotos || []).join(', ')} />
          <Field label="Actual Amounts" value={closeout.captureActualProductAmounts ? 'Required' : 'Not required'} />
          <Field label="Recap" value={closeout.customerRecapPreview} />
        </div>
      </PlanCard>
    </div>
  );
}
