import { useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { adminFetch } from '../../lib/adminFetch';
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

function BonusCard({ scoreboard }) {
  const { seasonBonus, multiplier, stayBonus } = scoreboard;
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
        value={stayBonus ? dayLabel(stayBonus.dueDate) : 'None left'}
        note={stayBonus
          ? (stayBonus.estimateCents === null
            ? `${stayBonus.years}-year bonus. Estimate starts ${dayLabel(stayBonus.earningsStart)}, when the 12 months of pay that count toward it begin.`
            : `${stayBonus.years}-year bonus, about ${centsToDollars(stayBonus.estimateCents)}. Estimate from pay recorded so far; pay earned through ${dayLabel(stayBonus.earningsEnd)} counts. Payroll confirms the final amount.`)
          : 'The 1, 3 and 5 year stay bonuses are behind you, or your hire date is not on file.'}
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

async function call(path) {
  const response = await adminFetch(`/admin/tech-rewards-scoreboard${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Scoreboard request failed (${response.status}).`);
  return data;
}

// Staff page, Team > Scoreboard preview (admin only, works with the gate off): the owner opens any one technician's
// board to check the numbers before technicians see them, and their yearly pay statement. The picker also lists a former
// technician who has a finalized paycheck, so that statement stays reachable after they leave.
export function ScoreboardPreview() {
  const [technicians, setTechnicians] = useState(null);
  const [technicianId, setTechnicianId] = useState('');
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');

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
  }, [technicianId]);

  return <Card className="grid gap-4 p-4" aria-label="Scoreboard preview">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="m-0 text-ui-title font-medium">Scoreboard preview</h2>
        <p className="m-0 text-ui-caption text-ink-secondary">What one technician would see on their own Scoreboard tab. Check the numbers here before turning the technician view on.</p>
      </div>
      <Field label="Technician">
        <Select value={technicianId} onChange={event => setTechnicianId(event.target.value)} disabled={!technicians}>
          <option value="">Choose a technician</option>
          {/* a former technician is listed only when payroll holds a finalized paycheck for them (active: false) */}
          {(technicians || []).map(t => <option key={t.id} value={t.id}>{t.active === false ? `${t.name} (no longer active)` : t.name}</option>)}
        </Select>
      </Field>
    </div>
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
    {technicianId && !board && !error && <p role="status" className="m-0">Loading…</p>}
    {board && <ScoreboardView scoreboard={board} />}
    {technicianId && <YearStatement key={technicianId} path={`/admin/tech-rewards-scoreboard/${encodeURIComponent(technicianId)}/year-statement`} />}
  </Card>;
}
