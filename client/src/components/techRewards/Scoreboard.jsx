import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { adminFetch } from '../../lib/adminFetch';
import { etDateString } from '../../lib/timezone';
import useTechScoreboard from '../../hooks/useTechScoreboard';
import { centsToDollars, dayLabel } from '../payroll/payrollFormat';
import YearStatement from './YearStatement';

// Tech Rewards Plan D5-4 (owner 2026-11-20). The technician's OWN scoreboard (Staff page, Time > Scoreboard, behind
// GATE_TECH_REWARDS_SCOREBOARD) and the owner's preview of any one technician (Staff > Team > Scoreboard preview, not gated).
// Both render ScoreboardView from the same server object. Every figure except commission is an estimate; the pay itself
// comes later. Under the board both show that person's yearly pay statement (YearStatement.jsx, D5-6): finalized amounts.
// Nothing here changes pay or sends a message. No customer data is shown.

const PART_LABELS = {
  onTime: 'Reports on time',
  audit: 'Protocol audit',
  callbacks: 'Callbacks',
  truck: 'Truck kit',
  ownerRating: 'Owner rating',
};
const ESTIMATE_NOTE = 'Estimate, final at season end.';
const NO_BONUS_REASONS = {
  score_incomplete: 'No estimate yet: a score part has no data so far.',
  no_settings: 'No estimate yet: the score settings for this season are not set.',
  no_hire_date: 'No estimate yet: your hire date is not on file.',
  hired_after_season: 'No estimate: you started after this season.',
};

const percent = value => `${Number(value)}%`;
const bpsPercent = bps => `${(bps / 100).toFixed(1)}%`;
const times = e4 => `${(e4 / 10000).toFixed(2)}x`;

function seasonWords(season) {
  const range = `${dayLabel(season.start)} to ${dayLabel(season.end)}`;
  return season.status === 'running'
    ? `${season.year} season, ${range}: running, the numbers so far.`
    : `${season.year} season, ${range}: over. Bonus pay is scheduled for ${dayLabel(season.payDate)}. Figures stay estimates until the office finalizes the pay.`;
}

function Stat({ label, value, note }) {
  return <div className="grid gap-1">
    <span className="text-ui-caption text-ink-secondary">{label}</span>
    <span className="text-ui-title font-medium">{value}</span>
    {note && <span className="text-ui-caption text-ink-secondary">{note}</span>}
  </div>;
}

function ScoreCard({ score }) {
  return <Card className="grid gap-3 p-4" aria-label="Season score">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="m-0 text-ui-title font-medium">Season score</h3>
      {score.unavailable
        ? <span className="text-ui-caption text-ink-secondary">Not available yet: the score settings for this season are not set.</span>
        : score.complete
        ? <span className="text-ui-title font-medium">{percent(score.value)}{score.band && <Badge tone="strong">{score.band.rateBps > 0 ? `Bonus band ${bpsPercent(score.band.rateBps)}` : 'Below the bonus bands'}</Badge>}</span>
        : <span className="text-ui-caption text-ink-secondary">Not complete: {score.missing.map(key => PART_LABELS[key]).join(', ')} {score.missing.length === 1 ? 'has' : 'have'} no data yet.</span>}
    </div>
    {!score.unavailable && <Table aria-label="Score parts">
      <THead><TR><TH>Part</TH><TH align="right">Score</TH><TH align="right">Weight</TH></TR></THead>
      <TBody>
        {Object.entries(score.parts).map(([key, part]) => <TR key={key}>
          <TD>{PART_LABELS[key]}</TD>
          <TD nums align="right">{part.value === null ? 'No data yet' : percent(part.value)}</TD>
          <TD nums align="right">{percent(part.weight)}</TD>
        </TR>)}
      </TBody>
    </Table>}
  </Card>;
}

// A season bonus payroll has paid shows the paid amount (paidCents), with no estimate beside it.
function seasonBonusValue(seasonBonus) {
  if (seasonBonus.paidCents != null) return centsToDollars(seasonBonus.paidCents);
  return seasonBonus.estimateCents === null ? 'Not estimated yet' : centsToDollars(seasonBonus.estimateCents);
}

function seasonBonusNote(seasonBonus) {
  if (seasonBonus.paidCents != null) return 'Paid. This is the amount payroll put on your paycheck.';
  if (seasonBonus.estimateCents === null) return NO_BONUS_REASONS[seasonBonus.reason] || ESTIMATE_NOTE;
  return `${ESTIMATE_NOTE} ${bpsPercent(seasonBonus.rateBps)} of ${centsToDollars(seasonBonus.grossCents)} pay x ${times(seasonBonus.multiplierE4)} multiplier.`;
}

function stayBonusFallback(multiplier) {
  if (multiplier?.reason === 'no_hire_date') {
    return { value: 'Hire date not on file', note: 'Add a hire date on file to track the 1, 3 and 5 year stay bonuses.' };
  }
  if (multiplier?.reason === 'hired_after_season') {
    return { value: 'Starts after hire date', note: 'The 1, 3 and 5 year stay bonuses begin once employment starts.' };
  }
  return { value: 'None left', note: 'The 1, 3 and 5 year stay bonuses are behind you, or your hire date is not on file.' };
}

function BonusCard({ scoreboard }) {
  const { seasonBonus, multiplier, stayBonus } = scoreboard;
  const fallback = stayBonusFallback(multiplier);
  return <Card className="grid gap-3 p-4" aria-label="Bonus estimates">
    <h3 className="m-0 text-ui-title font-medium">Bonus estimates</h3>
    <div className="grid gap-4 sm:grid-cols-2">
      <Stat
        label="Season bonus (paid the last Friday of September)"
        value={seasonBonusValue(seasonBonus)}
        note={seasonBonusNote(seasonBonus)}
      />
      <Stat
        label="Next stay bonus"
        value={stayBonus ? dayLabel(stayBonus.dueDate) : fallback.value}
        note={stayBonus
          ? (stayBonus.estimateCents === null
            ? `${stayBonus.years}-year bonus. Estimate starts ${dayLabel(stayBonus.earningsStart)}, when the 12 months of pay that count toward it begin.`
            : `${stayBonus.years}-year bonus, about ${centsToDollars(stayBonus.estimateCents)}. Estimate from pay recorded so far; pay earned through ${dayLabel(stayBonus.earningsEnd)} counts. Payroll confirms the final amount.`)
          : fallback.note}
      />
    </div>
    {multiplier.multiplierE4 != null && <p className="m-0 text-ui-caption text-ink-secondary">
      Multiplier {times(multiplier.multiplierE4)}: base 1.00x, years of service +{(multiplier.parts.tenureE4 / 10000).toFixed(2)}x, review rate +{(multiplier.parts.reviewRateE4 / 10000).toFixed(2)}x,
      level +{(multiplier.parts.levelE4 / 10000).toFixed(2)}x (your level is not recorded yet, so this shows the entry level).
    </p>}
  </Card>;
}

export function ScoreboardView({ scoreboard }) {
  const { reviews, commission } = scoreboard;
  return <div className="grid gap-4" aria-label={`Scoreboard for ${scoreboard.technician.name}`}>
    <p className="m-0 text-ui-caption text-ink-secondary">{seasonWords(scoreboard.season)}</p>
    <ScoreCard score={scoreboard.score} />
    <Card className="grid gap-4 p-4 sm:grid-cols-2" aria-label="Reviews and commission">
      <Stat
        label="Review rate"
        value={reviews.rateBps === null ? 'No asks yet' : bpsPercent(reviews.rateBps)}
        note={`${reviews.count} Google ${reviews.count === 1 ? 'review' : 'reviews'} from ${reviews.asks} ${reviews.asks === 1 ? 'ask' : 'asks'} this season.`}
      />
      <Stat
        label={`Commission recorded, ${commission.year}`}
        value={centsToDollars(commission.yearToDateCents)}
        note={`${commission.recordedThrough ? `Payments through ${dayLabel(commission.recordedThrough.weekEnd)}.` : 'Recorded through the last pay run.'} ${centsToDollars(commission.paidCents)} paid, ${centsToDollars(commission.unpaidCents)} not paid yet. A later payment is not counted until a pay run records it.`}
      />
    </Card>
    <BonusCard scoreboard={scoreboard} />
  </div>;
}

// Staff page, Time > Scoreboard: the signed-in technician's own board. It loads when the tab opens (the tab itself shows
// only when useTechScoreboardAvailability says the gate is on).
export default function Scoreboard() {
  const board = useTechScoreboard();
  if (board.status === 'off') return null;
  return <Card className="grid gap-3 p-4" aria-label="Scoreboard">
    <div>
      <h2 className="m-0 text-ui-title font-medium">Scoreboard</h2>
      <p className="m-0 text-ui-caption text-ink-secondary">Your own numbers only. {ESTIMATE_NOTE}</p>
    </div>
    {board.status === 'loading' && <p role="status" className="m-0">Loading…</p>}
    {board.status === 'error' && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{board.error}</p>}
    {board.status === 'ready' && <ScoreboardView scoreboard={board.scoreboard} />}
    {/* once the board request has answered: a 404 (gate off) never reaches here, so the statement is never asked for then */}
    {board.status !== 'loading' && <YearStatement path="/tech/rewards-scoreboard/year-statement" />}
  </Card>;
}

async function call(path, options) {
  const response = await adminFetch(`/admin/tech-rewards-scoreboard${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Scoreboard request failed (${response.status}).`);
  return data;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function OwnerRewardsControls({ technicians, selectedTechId, onUpdated }) {
  const [month, setMonth] = useState(() => etDateString(new Date()).slice(0, 7));
  const [ratings, setRatings] = useState([]);
  const [ratingTechId, setRatingTechId] = useState(selectedTechId || '');
  const [ratingValue, setRatingValue] = useState('');
  const [ratingNote, setRatingNote] = useState('');
  const [settingsState, setSettingsState] = useState(null);
  const [weights, setWeights] = useState({ onTime: '25', audit: '25', callbacks: '20', truck: '10', ownerRating: '20' });
  const [cutLines, setCutLines] = useState({ top: '90', mid: '80', low: '70' });
  const [effectiveFrom, setEffectiveFrom] = useState(() => etDateString(new Date()));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (selectedTechId) setRatingTechId(selectedTechId);
  }, [selectedTechId]);

  const loadControls = useCallback(async () => {
    if (!MONTH_RE.test(month)) return;
    setError('');
    try {
      const [rData, sData] = await Promise.all([
        call(`/owner-ratings?month=${encodeURIComponent(month)}`),
        call('/settings'),
      ]);
      setRatings(rData.ratings || []);
      setSettingsState(sData);
      const base = sData.current || sData.defaults;
      if (base?.weights) setWeights(Object.fromEntries(Object.entries(base.weights).map(([k, v]) => [k, String(v)])));
      if (base?.cutLines) setCutLines(Object.fromEntries(Object.entries(base.cutLines).map(([k, v]) => [k, String(v)])));
    } catch (failure) {
      setError(failure.message);
    }
  }, [month]);

  useEffect(() => { loadControls(); }, [loadControls]);

  async function saveRating(event) {
    event.preventDefault();
    if (!ratingTechId || ratingValue === '') return;
    setBusy(true); setError(''); setNotice('');
    try {
      await call('/owner-ratings', {
        method: 'PUT',
        body: { technicianId: ratingTechId, month, rating: Number(ratingValue), note: ratingNote },
      });
      setNotice('Owner rating saved.');
      setRatingValue(''); setRatingNote('');
      await loadControls();
      onUpdated();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function saveSettings(event) {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const numObj = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(v)]));
      await call('/settings', {
        method: 'POST',
        body: { weights: numObj(weights), cutLines: numObj(cutLines), effectiveFrom },
      });
      setNotice('New score settings version saved.');
      await loadControls();
      onUpdated();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const activeTechs = (technicians || []).filter(t => t.active !== false);
  return <Card className="grid gap-4 p-4" aria-label="Owner ratings and score settings">
    <h3 className="m-0 text-ui-title font-medium">Owner ratings &amp; score settings</h3>
    {notice && <p role="status" className="m-0 text-ui-caption text-zinc-900">{notice}</p>}
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}

    <form onSubmit={saveRating} className="grid gap-3" aria-label="Save monthly owner rating">
      <h4 className="m-0 text-ui-body font-medium">Monthly owner rating (0–100)</h4>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Rating month"><Input type="month" value={month} onChange={e => MONTH_RE.test(e.target.value) && setMonth(e.target.value)} /></Field>
        <Field label="Technician">
          <Select value={ratingTechId} onChange={e => setRatingTechId(e.target.value)}>
            <option value="">Choose a technician</option>
            {activeTechs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Rating (0–100)"><Input type="number" min="0" max="100" step="1" value={ratingValue} onChange={e => setRatingValue(e.target.value)} /></Field>
        <Field label="Note (optional)"><Input value={ratingNote} maxLength={1000} onChange={e => setRatingNote(e.target.value)} /></Field>
      </div>
      <div><Button type="submit" disabled={busy || !ratingTechId || ratingValue === ''}>Save owner rating</Button></div>
      {ratings.length > 0 && <ul className="m-0 grid list-none gap-1 p-0 text-ui-caption text-ink-secondary">
        {ratings.map(r => <li key={r.technicianId}>{r.technicianName}: {r.rating}%{r.note ? ` — ${r.note}` : ''}</li>)}
      </ul>}
    </form>

    <form onSubmit={saveSettings} className="grid gap-3 border-t border-zinc-200 pt-3" aria-label="Save score settings version">
      <div>
        <h4 className="m-0 text-ui-body font-medium">Score weights &amp; bonus cut lines</h4>
        <p className="m-0 text-ui-caption text-ink-secondary">
          {settingsState?.current
            ? `Active: version ${settingsState.current.version} (${settingsState.current.source}${settingsState.current.effectiveFrom ? `, from ${dayLabel(settingsState.current.effectiveFrom)}` : ''}). Saving creates a new immutable version.`
            : 'Saving creates a new immutable score settings version.'}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-5">
        {Object.entries(PART_LABELS).map(([key, label]) => (
          <Field key={key} label={`${label} %`}>
            <Input type="number" min="0" max="100" step="0.01" value={weights[key]} onChange={e => setWeights(w => ({ ...w, [key]: e.target.value }))} />
          </Field>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Top cut line"><Input type="number" min="0" max="100" step="0.01" value={cutLines.top} onChange={e => setCutLines(c => ({ ...c, top: e.target.value }))} /></Field>
        <Field label="Mid cut line"><Input type="number" min="0" max="100" step="0.01" value={cutLines.mid} onChange={e => setCutLines(c => ({ ...c, mid: e.target.value }))} /></Field>
        <Field label="Low cut line"><Input type="number" min="0" max="100" step="0.01" value={cutLines.low} onChange={e => setCutLines(c => ({ ...c, low: e.target.value }))} /></Field>
        <Field label="Effective from"><Input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></Field>
      </div>
      <div><Button type="submit" variant="secondary" disabled={busy || !effectiveFrom}>Save new settings version</Button></div>
    </form>
  </Card>;
}

// Staff page, Team > Scoreboard preview (admin only, works with the gate off): the owner opens any one technician's
// board to check the numbers before technicians see them, and their yearly pay statement. The picker also lists a former
// technician who has a finalized paycheck, so that statement stays reachable after they leave.
export function ScoreboardPreview() {
  const [technicians, setTechnicians] = useState(null);
  const [technicianId, setTechnicianId] = useState('');
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const [showControls, setShowControls] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let live = true;
    call('').then(data => { if (live) setTechnicians(data.technicians); }).catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!technicianId) { setBoard(null); return undefined; }
    let live = true;
    setBoard(null); setError('');
    call(`/${encodeURIComponent(technicianId)}`).then(data => { if (live) setBoard(data.scoreboard); }).catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [technicianId, reloadTick]);

  return <Card className="grid gap-4 p-4" aria-label="Scoreboard preview">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="m-0 text-ui-title font-medium">Scoreboard preview</h2>
        <p className="m-0 text-ui-caption text-ink-secondary">What one technician would see on their own Scoreboard tab. Check the numbers here before turning the technician view on.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Technician">
          <Select value={technicianId} onChange={event => setTechnicianId(event.target.value)} disabled={!technicians}>
            <option value="">Choose a technician</option>
            {/* a former technician is listed only when payroll holds a finalized paycheck for them (active: false) */}
            {(technicians || []).map(t => <option key={t.id} value={t.id}>{t.active === false ? `${t.name} (no longer active)` : t.name}</option>)}
          </Select>
        </Field>
        <Button type="button" variant="secondary" onClick={() => setShowControls(v => !v)}>
          {showControls ? 'Hide owner ratings & settings' : 'Owner ratings & settings'}
        </Button>
      </div>
    </div>
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
    {showControls && <OwnerRewardsControls technicians={technicians} selectedTechId={technicianId} onUpdated={() => setReloadTick(t => t + 1)} />}
    {technicianId && !board && !error && <p role="status" className="m-0">Loading…</p>}
    {board && <ScoreboardView scoreboard={board} />}
    {technicianId && <YearStatement key={technicianId} path={`/admin/tech-rewards-scoreboard/${encodeURIComponent(technicianId)}/year-statement`} />}
  </Card>;
}
