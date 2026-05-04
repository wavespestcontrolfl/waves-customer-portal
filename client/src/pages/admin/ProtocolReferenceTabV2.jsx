import React, { useEffect, useState } from 'react';
import { Button, Badge, Card, Input, Select } from '../../components/ui';
import { cn } from '../../components/ui/cn';
import {
  MONTH_NAMES,
  PRODUCT_DESCRIPTIONS,
  TRACK_SAFETY_RULES,
  stripLegacyBoilerplate,
} from './SchedulePage';

function adminFetch(path, options = {}) {
  const token = localStorage.getItem('adminToken');
  return fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  });
}

function parseProductLines(text) {
  if (!text) return [];
  return text.split('\n').filter((l) => l.trim()).map((line) => {
    const clean = line.replace(/^\u2605\s*/, '').replace(/^IF\s+.*?:\s*/, '').trim();
    const nameMatch = clean.match(/^([A-Za-z][A-Za-z0-9\s\-+/.]+?)(?:\s+(?:split|liquid|broadleaf|preventive|fert|foliar|biostimulant|drought|wetting|late|curative|PGR)|\s*\(|\s*\$|$)/i);
    const productName = nameMatch ? nameMatch[1].trim().toLowerCase() : '';
    let desc = null;
    for (const [key, val] of Object.entries(PRODUCT_DESCRIPTIONS)) {
      if (productName.includes(key) || clean.toLowerCase().includes(key)) {
        desc = val;
        break;
      }
    }
    return { raw: line, description: desc };
  });
}

function TierDotV2({ active, label }) {
  return (
    <span className="inline-flex items-center gap-1 mr-2">
      <span
        className={cn(
          'inline-block w-2 h-2 rounded-full border-hairline',
          active ? 'bg-zinc-900 border-zinc-900' : 'bg-transparent border-zinc-400',
        )}
      />
      <span className={cn('text-11 font-medium u-label', active ? 'text-zinc-900' : 'text-ink-tertiary')}>
        {label}
      </span>
    </span>
  );
}

function TierDotsV2({ tiers, tier4x, tier6x }) {
  if (tiers) {
    return (
      <div className="flex items-center flex-wrap gap-1">
        <TierDotV2 active={tiers.bronze} label="B" />
        <TierDotV2 active={tiers.silver} label="S" />
        <TierDotV2 active={tiers.enhanced} label="E" />
        <TierDotV2 active={tiers.premium} label="P" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <TierDotV2 active={tier4x} label="4x" />
      <TierDotV2 active={tier6x} label="6x" />
    </div>
  );
}

function CurrentVisitCardV2({ visit, trackName }) {
  if (!visit) return null;
  const primaryProducts = parseProductLines(visit.primary);
  const secondaryProducts = parseProductLines(visit.secondary);
  const totalCost = (parseFloat(visit.material_cost) || 0) + (parseFloat(visit.labor_cost) || 0);

  const warnings = [];
  if (visit.notes) {
    const parts = visit.notes.split(/\.\s+|\n/).filter(Boolean);
    parts.forEach((p) => {
      const lower = p.toLowerCase();
      if (
        lower.includes('weather') ||
        lower.includes('>90') ||
        lower.includes('<85') ||
        (lower.includes('celsius') && lower.includes('app')) ||
        lower.includes('threshold') ||
        lower.includes('blackout')
      ) {
        warnings.push(p.trim().replace(/^\u2605\s*/, ''));
      }
    });
  }

  return (
    <Card className="overflow-hidden mb-2">
      <div className="px-4 py-3 bg-zinc-50 border-b border-hairline border-zinc-200 flex justify-between items-center flex-wrap gap-2">
        <div>
          <div className="text-14 font-medium tracking-label uppercase text-ink-primary">
            VISIT {visit.visit} — {visit.month?.toUpperCase()}
          </div>
          <div className="text-11 text-ink-tertiary mt-1 u-label">{trackName}</div>
        </div>
        <TierDotsV2 tiers={visit.tiers} tier4x={visit.tier_4x} tier6x={visit.tier_6x} />
      </div>

      <div className="px-4 py-3">
        <div className="mb-3">
          <div className="text-11 font-medium u-label text-ink-tertiary mb-2">Primary Products</div>
          {primaryProducts.map((p, i) => (
            <div key={i} className="mb-1.5">
              <div className="text-13 text-ink-primary leading-normal">{p.raw}</div>
              {p.description && (
                <div className="text-11 text-ink-tertiary ml-3 italic leading-normal">{p.description}</div>
              )}
            </div>
          ))}
        </div>

        {secondaryProducts.length > 0 && (
          <div className="mb-3">
            <div className="text-11 font-medium u-label text-ink-tertiary mb-2">Secondary / Conditional</div>
            {secondaryProducts.map((p, i) => (
              <div key={i} className="mb-1.5">
                <div className="text-13 text-ink-secondary leading-normal">{p.raw}</div>
                {p.description && (
                  <div className="text-11 text-ink-tertiary ml-3 italic leading-normal">{p.description}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="mb-3">
            {warnings.map((w, i) => (
              <div
                key={i}
                className="flex items-start gap-1.5 mb-1 px-2.5 py-1.5 rounded bg-alert-bg border border-hairline border-alert-fg/30"
              >
                <span className="text-alert-fg text-13 flex-shrink-0">!</span>
                <span className="text-12 text-alert-fg leading-normal">{w}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3 flex-wrap items-center px-3 py-2 bg-zinc-50 rounded border border-hairline border-zinc-200">
          <div className="text-12 text-ink-tertiary">
            Materials:{' '}
            <span className="font-mono u-nums text-ink-primary font-medium">${visit.material_cost || '0'}</span>
          </div>
          <div className="text-12 text-ink-tertiary">
            Labor: <span className="font-mono u-nums text-ink-primary font-medium">${visit.labor_cost || '0'}</span>
          </div>
          <div className="ml-auto text-13 text-ink-primary font-medium font-mono u-nums">
            Total: ${totalCost.toFixed(2)}
          </div>
        </div>

        {visit.notes && stripLegacyBoilerplate(visit.notes) && (
          <div className="mt-2.5 text-12 text-ink-tertiary leading-normal px-2.5 py-2 bg-zinc-50 rounded">
            {stripLegacyBoilerplate(visit.notes)}
          </div>
        )}
      </div>
    </Card>
  );
}

function fmtNumber(value, suffix = '') {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 3 })}${suffix}`;
}

function groupText(groups = {}) {
  return [
    groups.frac ? `FRAC ${groups.frac}` : null,
    groups.irac ? `IRAC ${groups.irac}` : null,
    groups.hrac ? `HRAC ${groups.hrac}` : null,
    groups.moa ? `MOA ${groups.moa}` : null,
  ].filter(Boolean).join(' · ');
}

function ProtocolMixCard({ plan, selectedConditionalIds, onToggleConditional }) {
  if (!plan) return null;
  const selectedItems = plan.selectedItems || [];
  const fullTankLabel = plan.equipment?.tankCapacityGal
    ? `${fmtNumber(plan.equipment.tankCapacityGal, ' gal')} tank`
    : 'Full tank';

  return (
    <div className="flex flex-col gap-3">
      {plan.warnings?.length > 0 && (
        <div className="rounded-md border border-hairline border-alert-fg/30 bg-alert-bg px-3 py-2">
          {plan.warnings.map((w) => (
            <div key={w.code} className="text-12 text-alert-fg leading-normal">
              <span className="font-medium">{w.code.replace(/_/g, ' ')}:</span> {w.message}
            </div>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-hairline border-zinc-200 bg-zinc-50 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-14 font-medium tracking-label uppercase text-ink-primary">
              VISIT {plan.visit?.visit} — {plan.month?.toUpperCase()}
            </div>
            <div className="text-11 text-ink-tertiary mt-1 u-label">{plan.track?.name}</div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Badge tone={plan.equipment ? 'neutral' : 'alert'}>
              {plan.equipment?.systemName || 'No calibration'}
            </Badge>
            {plan.equipment?.carrierGalPer1000 && (
              <Badge tone="neutral">{fmtNumber(plan.equipment.carrierGalPer1000, ' gal/1K')}</Badge>
            )}
          </div>
        </div>

        <div className="p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="rounded-sm border-hairline border-zinc-200 p-3">
              <div className="u-label text-ink-tertiary">Selected Area</div>
              <div className="u-nums text-16 font-medium text-zinc-900">{fmtNumber(plan.areaSqft, ' sq ft')}</div>
            </div>
            <div className="rounded-sm border-hairline border-zinc-200 p-3">
              <div className="u-label text-ink-tertiary">Carrier</div>
              <div className="u-nums text-16 font-medium text-zinc-900">{fmtNumber(plan.equipment?.carrierGalPer1000, ' gal/1K')}</div>
            </div>
            <div className="rounded-sm border-hairline border-zinc-200 p-3">
              <div className="u-label text-ink-tertiary">Tank Coverage</div>
              <div className="u-nums text-16 font-medium text-zinc-900">{fmtNumber(plan.equipment?.tankCoverageSqft, ' sq ft')}</div>
            </div>
            <div className="rounded-sm border-hairline border-zinc-200 p-3">
              <div className="u-label text-ink-tertiary">Selected Products</div>
              <div className="u-nums text-16 font-medium text-zinc-900">{selectedItems.length}</div>
            </div>
          </div>

          <div className="text-12 text-ink-secondary leading-normal mb-4">
            {plan.visit?.objective || 'No objective available for this visit.'}
          </div>

          <div className="overflow-x-auto border-hairline border-zinc-200 rounded-md">
            <table className="w-full border-collapse">
              <thead className="bg-zinc-50">
                <tr>
                  <th className="px-3 py-2 text-left text-11 u-label text-ink-tertiary">Product</th>
                  <th className="px-3 py-2 text-left text-11 u-label text-ink-tertiary">Label / Safety</th>
                  <th className="px-3 py-2 text-right text-11 u-label text-ink-tertiary">Area Mix</th>
                  <th className="px-3 py-2 text-right text-11 u-label text-ink-tertiary">{fullTankLabel}</th>
                </tr>
              </thead>
              <tbody>
                {plan.items?.map((item, idx) => {
                  const checked = item.conditional
                    ? selectedConditionalIds.includes(String(item.product?.id)) || item.selected
                    : true;
                  return (
                    <tr key={`${idx}-${item.raw}`} className="border-t border-hairline border-zinc-100 align-top">
                      <td className="px-3 py-3 min-w-[260px]">
                        <div className="flex items-start gap-2">
                          {item.conditional && item.product?.id && (
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => onToggleConditional(item.product.id)}
                              className="mt-0.5 h-4 w-4 accent-zinc-900"
                              aria-label={`Select ${item.product.name}`}
                            />
                          )}
                          <div className="min-w-0">
                            <div className="text-13 font-medium text-zinc-900">{item.product?.name || item.raw}</div>
                            <div className="text-11 text-ink-secondary leading-normal mt-1">{item.raw}</div>
                            <div className="mt-1 flex gap-1.5 flex-wrap">
                              {item.conditional && <Badge tone="neutral">{checked ? 'Selected' : 'Optional'}</Badge>}
                              {!item.matched && <Badge tone="alert">Unmatched</Badge>}
                              {item.product?.requiresSurfactant && <Badge tone="neutral">Surfactant Required</Badge>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 min-w-[220px]">
                        <div className="text-12 text-ink-primary">{item.product?.activeIngredient || '—'}</div>
                        {groupText(item.product?.groups) && (
                          <div className="text-11 text-ink-secondary mt-1">{groupText(item.product.groups)}</div>
                        )}
                        {(item.product?.reiHours || item.product?.rainfastMinutes) && (
                          <div className="text-11 text-ink-secondary mt-1">
                            {item.product.reiHours ? `REI ${item.product.reiHours}h` : ''}
                            {item.product.reiHours && item.product.rainfastMinutes ? ' · ' : ''}
                            {item.product.rainfastMinutes ? `Rainfast ${item.product.rainfastMinutes}m` : ''}
                          </div>
                        )}
                        {item.product?.excludedTurfSpecies?.length > 0 && (
                          <div className="text-11 text-alert-fg mt-1">
                            Excludes: {item.product.excludedTurfSpecies.join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <div className="u-nums text-13 font-medium text-zinc-900">
                          {fmtNumber(item.jobMix?.amount)} {item.jobMix?.amountUnit || ''}
                        </div>
                        <div className="text-11 text-ink-secondary">
                          {fmtNumber(item.jobMix?.ratePer1000)} {item.jobMix?.rateUnit || ''}/1K
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <div className="u-nums text-13 font-medium text-zinc-900">
                          {fmtNumber(item.fullTankMix?.amount)} {item.fullTankMix?.amountUnit || ''}
                        </div>
                        <div className="text-11 text-ink-secondary">
                          {fmtNumber(item.fullTankMix?.carrierGallons, ' gal carrier')}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-hairline border-zinc-200 bg-zinc-50">
          <div className="text-13 font-medium text-zinc-900">Mixing Order</div>
        </div>
        <div className="p-4 space-y-2">
          {plan.mixingOrder?.length ? plan.mixingOrder.map((step) => (
            <div key={`${step.step}-${step.productId}`} className="flex gap-3 rounded-sm border-hairline border-zinc-200 p-3">
              <div className="h-6 w-6 rounded-xs bg-zinc-900 text-white text-12 u-nums flex items-center justify-center flex-shrink-0">{step.step}</div>
              <div>
                <div className="text-13 font-medium text-zinc-900">{step.productName}</div>
                <div className="text-12 text-ink-secondary leading-normal mt-1">{step.instruction}</div>
              </div>
            </div>
          )) : (
            <div className="text-13 text-ink-secondary">Select calibrated equipment and products to build a mixing order.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function ProtocolReferenceTabV2() {
  const [programs, setPrograms] = useState(null);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [trackData, setTrackData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showFullCalendar, setShowFullCalendar] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [equipmentOptions, setEquipmentOptions] = useState([]);
  const [equipmentSystemId, setEquipmentSystemId] = useState('');
  const [lawnSqft, setLawnSqft] = useState(10000);
  const [mixPlan, setMixPlan] = useState(null);
  const [mixLoading, setMixLoading] = useState(false);
  const [selectedConditionalIds, setSelectedConditionalIds] = useState([]);

  const loadTrack = async (key) => {
    setSelectedTrack(key);
    setTrackData(null);
    setShowFullCalendar(false);
    const param = key === 'tree_shrub' ? 'program=tree_shrub' : `track=${key}`;
    const d = await adminFetch(`/admin/protocols/programs?${param}`);
    setTrackData(d.track || d.program);
    setSelectedConditionalIds([]);
  };

  useEffect(() => {
    let cancelled = false;
    adminFetch('/admin/protocols/programs')
      .then(async (d) => {
        if (cancelled) return;
        setPrograms(d);
        const defaultTrack = d?.lawn?.tracks?.find((t) => t.key === 'st_augustine')?.key || d?.lawn?.tracks?.[0]?.key;
        if (defaultTrack) {
          try {
            const param = defaultTrack === 'tree_shrub' ? 'program=tree_shrub' : `track=${defaultTrack}`;
            const track = await adminFetch(`/admin/protocols/programs?${param}`);
            if (!cancelled) {
              setSelectedTrack(defaultTrack);
              setTrackData(track.track || track.program);
            }
          } catch {
            // Leave the selector visible; a manual click can retry the track fetch.
          }
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    adminFetch('/admin/equipment-systems/calibrations')
      .then((d) => {
        const rows = d.calibrations || [];
        setEquipmentOptions(rows);
        const defaultTank = rows.find((r) => String(r.system_name || '').includes('110-Gallon Spray Tank #1'))
          || rows.find((r) => r.system_type === 'tank')
          || rows[0];
        if (defaultTank?.equipment_system_id) setEquipmentSystemId(defaultTank.equipment_system_id);
      })
      .catch(() => setEquipmentOptions([]));
  }, []);

  useEffect(() => {
    if (!selectedTrack || selectedTrack === 'tree_shrub') return;
    let cancelled = false;
    const params = new URLSearchParams({
      track: selectedTrack,
      month: String(selectedMonth),
      lawnSqft: String(lawnSqft || 0),
    });
    if (equipmentSystemId) params.set('equipmentSystemId', equipmentSystemId);
    if (selectedConditionalIds.length) params.set('selectedConditionalProductIds', selectedConditionalIds.join(','));
    setMixLoading(true);
    adminFetch(`/admin/protocols/lawn-mix?${params.toString()}`)
      .then((d) => { if (!cancelled) setMixPlan(d); })
      .catch(() => { if (!cancelled) setMixPlan(null); })
      .finally(() => { if (!cancelled) setMixLoading(false); });
    return () => { cancelled = true; };
  }, [selectedTrack, selectedMonth, equipmentSystemId, lawnSqft, selectedConditionalIds]);

  function toggleConditional(productId) {
    setSelectedConditionalIds((prev) => (
      prev.includes(String(productId))
        ? prev.filter((id) => id !== String(productId))
        : [...prev, String(productId)]
    ));
  }

  if (loading) {
    return <div className="text-ink-tertiary p-10 text-center text-13">Loading protocols…</div>;
  }

  const currentMonthAbbr = MONTH_NAMES[selectedMonth - 1];
  const currentVisit = trackData?.visits?.find((v) => v.month === currentMonthAbbr);
  const safetyRules =
    selectedTrack && selectedTrack !== 'tree_shrub' ? TRACK_SAFETY_RULES[selectedTrack] || [] : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="text-13 text-ink-tertiary">
        Tech-facing WaveGuard protocols with label-rate mix math, equipment calibration, tank fill, and mixing order.
      </div>

      <div className="flex gap-2 flex-wrap overflow-x-auto">
        {programs?.lawn?.tracks?.map((t) => {
          const active = selectedTrack === t.key;
          return (
            <button
              key={t.key}
              onClick={() => loadTrack(t.key)}
              className={cn(
                'px-4 py-2.5 rounded-md u-focus-ring flex-shrink-0 text-left transition-colors border-hairline',
                active
                  ? 'bg-zinc-900 border-zinc-900 text-white'
                  : 'bg-white border-zinc-200 text-ink-primary hover:bg-zinc-50',
              )}
            >
              <div className="text-13 font-medium">{t.name?.substring(0, 35) || t.key}</div>
              <div className={cn('text-11 mt-0.5 u-label', active ? 'text-white/70' : 'text-ink-tertiary')}>
                {t.visits} visits/year
              </div>
            </button>
          );
        })}
        <button
          onClick={() => loadTrack('tree_shrub')}
          className={cn(
            'px-4 py-2.5 rounded-md u-focus-ring flex-shrink-0 text-left transition-colors border-hairline',
            selectedTrack === 'tree_shrub'
              ? 'bg-zinc-900 border-zinc-900 text-white'
              : 'bg-white border-zinc-200 text-ink-primary hover:bg-zinc-50',
          )}
        >
          <div className="text-13 font-medium">Tree &amp; Shrub v3</div>
          <div
            className={cn(
              'text-11 mt-0.5 u-label',
              selectedTrack === 'tree_shrub' ? 'text-white/70' : 'text-ink-tertiary',
            )}
          >
            12 visits/year
          </div>
        </button>
      </div>

      {trackData && (
        <div className="flex flex-col gap-3">
          <Card className="overflow-hidden">
            <div className="px-4 py-3 flex flex-col gap-3">
              <div className="text-16 font-medium text-ink-primary tracking-tight">{trackData.name}</div>
              {selectedTrack !== 'tree_shrub' && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <label className="u-label text-ink-tertiary block mb-1">Month</label>
                    <Select value={selectedMonth} onChange={(e) => setSelectedMonth(Number(e.target.value))}>
                      {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                    </Select>
                  </div>
                  <div>
                    <label className="u-label text-ink-tertiary block mb-1">Equipment</label>
                    <Select value={equipmentSystemId} onChange={(e) => setEquipmentSystemId(e.target.value)}>
                      <option value="">Auto-select calibrated rig</option>
                      {equipmentOptions.map((row) => (
                        <option key={row.id} value={row.equipment_system_id}>
                          {row.system_name} · {fmtNumber(row.carrier_gal_per_1000, ' gal/1K')}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="u-label text-ink-tertiary block mb-1">Treatment Area</label>
                    <Input
                      type="number"
                      min="0"
                      step="500"
                      value={lawnSqft}
                      onChange={(e) => setLawnSqft(e.target.value)}
                    />
                  </div>
                  <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
                    <div className="u-label text-ink-tertiary">Tank Coverage</div>
                    <div className="u-nums text-14 font-medium text-zinc-900">
                      {fmtNumber(mixPlan?.equipment?.tankCoverageSqft, ' sq ft')}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {safetyRules.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3.5 py-2.5 bg-alert-bg border border-hairline border-alert-fg/30 rounded-md items-center">
              <span className="text-12 font-medium u-label text-alert-fg mr-1 flex-shrink-0">SAFETY</span>
              {safetyRules.map((rule, i) => (
                <Badge key={i} tone="alert" className="whitespace-nowrap">
                  {rule}
                </Badge>
              ))}
            </div>
          )}

          {selectedTrack !== 'tree_shrub' && (
            mixLoading ? (
              <Card className="px-5 py-4 text-center text-13 text-ink-tertiary">Calculating mix…</Card>
            ) : (
              <ProtocolMixCard
                plan={mixPlan}
                selectedConditionalIds={selectedConditionalIds}
                onToggleConditional={toggleConditional}
              />
            )
          )}

          {selectedTrack === 'tree_shrub' && currentVisit && <CurrentVisitCardV2 visit={currentVisit} trackName={trackData.name} />}

          {!currentVisit && trackData.visits?.length > 0 && (
            <Card className="px-5 py-4 text-center">
              <div className="text-13 text-ink-tertiary">
                No visit mapped to {currentMonthAbbr} for this track.
              </div>
            </Card>
          )}

          <div className="flex gap-3 flex-wrap items-center px-3.5 py-2 bg-white border border-hairline border-zinc-200 rounded-md">
            <span className="text-11 font-medium u-label text-ink-tertiary">Tier Legend</span>
            <span className="text-12 text-ink-secondary inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-zinc-900" /> included
            </span>
            <span className="text-12 text-ink-tertiary inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full border-hairline border-zinc-400 box-border" /> not included
            </span>
            <span className="text-11 text-ink-tertiary u-label">B=Bronze S=Silver E=Enhanced P=Premium</span>
          </div>

          <Button
            variant="secondary"
            onClick={() => setShowFullCalendar((prev) => !prev)}
            className="w-full justify-center"
          >
            {showFullCalendar ? 'Hide full calendar' : 'View full calendar'}
          </Button>

          {showFullCalendar && (
            <Card className="overflow-hidden">
              {trackData.notes?.length > 0 && (
                <div className="px-5 py-3 border-b border-hairline border-zinc-200 bg-zinc-50">
                  {trackData.notes.map((n, i) => {
                    const isWarning = n.startsWith('\u26a0');
                    return (
                      <div
                        key={i}
                        className={cn(
                          'text-12 mb-1 leading-normal last:mb-0',
                          isWarning ? 'text-alert-fg' : 'text-ink-secondary',
                        )}
                      >
                        {n}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-hairline border-zinc-200">
                      {[
                        { k: '#', cls: '' },
                        { k: 'Month', cls: '' },
                        { k: 'Primary Applications', cls: 'min-w-[250px]' },
                        { k: 'Secondary / Conditional', cls: 'min-w-[200px]' },
                        { k: 'Mat$', cls: '' },
                        { k: 'Lab$', cls: '' },
                        { k: 'Tiers', cls: '' },
                        { k: 'Notes / SOP', cls: 'min-w-[200px]' },
                      ].map((h) => (
                        <th
                          key={h.k}
                          className={cn(
                            'px-2.5 py-2 text-11 font-medium u-label text-ink-tertiary text-left',
                            h.cls,
                          )}
                        >
                          {h.k}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trackData.visits?.map((v, i) => {
                      const isCurrentMonth = v.month === currentMonthAbbr;
                      return (
                        <tr
                          key={i}
                          className={cn(
                            'border-b border-hairline border-zinc-100',
                            isCurrentMonth && 'bg-zinc-50',
                          )}
                        >
                          <td
                            className={cn(
                              'px-2.5 py-2 text-12 font-medium text-center align-top',
                              isCurrentMonth ? 'text-ink-primary' : 'text-ink-secondary',
                            )}
                          >
                            {v.visit}
                          </td>
                          <td className="px-2.5 py-2 text-12 font-medium text-ink-primary whitespace-nowrap align-top">
                            {v.month}
                            {isCurrentMonth && (
                              <span className="ml-1.5 text-10 font-medium u-label text-ink-primary">NOW</span>
                            )}
                          </td>
                          <td className="px-2.5 py-2 text-12 text-ink-primary whitespace-pre-wrap align-top">
                            {parseProductLines(v.primary).map((p, pi) => (
                              <div key={pi} className="mb-0.5 last:mb-0">
                                <div>{p.raw}</div>
                                {p.description && (
                                  <div className="text-10 text-ink-tertiary italic ml-2">{p.description}</div>
                                )}
                              </div>
                            ))}
                          </td>
                          <td className="px-2.5 py-2 text-12 text-ink-secondary whitespace-pre-wrap align-top">
                            {parseProductLines(v.secondary).map((p, pi) => (
                              <div key={pi} className="mb-0.5 last:mb-0">
                                <div>{p.raw}</div>
                                {p.description && (
                                  <div className="text-10 text-ink-tertiary italic ml-2">{p.description}</div>
                                )}
                              </div>
                            ))}
                            {!v.secondary && '\u2014'}
                          </td>
                          <td className="px-2.5 py-2 text-12 font-mono u-nums text-ink-primary whitespace-nowrap align-top">
                            {v.material_cost ? `$${v.material_cost}` : '\u2014'}
                          </td>
                          <td className="px-2.5 py-2 text-12 font-mono u-nums text-ink-primary whitespace-nowrap align-top">
                            {v.labor_cost ? `$${v.labor_cost}` : '\u2014'}
                          </td>
                          <td className="px-2.5 py-2 align-top">
                            <TierDotsV2 tiers={v.tiers} tier4x={v.tier_4x} tier6x={v.tier_6x} />
                          </td>
                          <td className="px-2.5 py-2 text-11 text-ink-tertiary whitespace-pre-wrap align-top">
                            {stripLegacyBoilerplate(v.notes) || '\u2014'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {!selectedTrack && (
        <Card className="px-10 py-10 text-center">
          <div className="text-14 font-medium text-ink-primary mb-1">Select a program above</div>
          <div className="text-13 text-ink-tertiary">
            View the full visit-by-visit protocol with products, rates, costs, and tier requirements.
          </div>
        </Card>
      )}
    </div>
  );
}
