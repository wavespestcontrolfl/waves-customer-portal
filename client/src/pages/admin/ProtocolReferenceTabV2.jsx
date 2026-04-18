import React, { useEffect, useState } from 'react';
import { Button, Badge, Card } from '../../components/ui';
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

export default function ProtocolReferenceTabV2() {
  const [programs, setPrograms] = useState(null);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [trackData, setTrackData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showFullCalendar, setShowFullCalendar] = useState(false);

  useEffect(() => {
    adminFetch('/admin/protocols/programs')
      .then((d) => {
        setPrograms(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const loadTrack = async (key) => {
    setSelectedTrack(key);
    setTrackData(null);
    setShowFullCalendar(false);
    const param = key === 'tree_shrub' ? 'program=tree_shrub' : `track=${key}`;
    const d = await adminFetch(`/admin/protocols/programs?${param}`);
    setTrackData(d.track || d.program);
  };

  if (loading) {
    return <div className="text-ink-tertiary p-10 text-center text-13">Loading protocols…</div>;
  }

  const currentMonthIndex = new Date().getMonth();
  const currentMonthAbbr = MONTH_NAMES[currentMonthIndex];
  const currentVisit = trackData?.visits?.find((v) => v.month === currentMonthAbbr);
  const safetyRules =
    selectedTrack && selectedTrack !== 'tree_shrub' ? TRACK_SAFETY_RULES[selectedTrack] || [] : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="text-13 text-ink-tertiary">
        WaveGuard service protocols — visit-by-visit products, rates, costs, and SOPs for techs.
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
            <div className="px-4 py-3">
              <div className="text-16 font-medium text-ink-primary tracking-tight">{trackData.name}</div>
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

          {currentVisit && <CurrentVisitCardV2 visit={currentVisit} trackName={trackData.name} />}

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
