import { useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { adminFetch } from '../../lib/adminFetch';
import { centsToDollars, dayLabel } from '../payroll/payrollFormat';

// Tech Rewards Plan D5-4 (owner 2026-11-20). The technician's OWN scoreboard (Staff page, Time > Scoreboard, behind
// GATE_TECH_REWARDS_SCOREBOARD) and the owner's preview of any one technician (Staff > Team > Scoreboard preview, not gated).
// Both render ScoreboardView from the same server object. Every figure except commission is an estimate; the pay itself
// comes later. Nothing here changes pay or sends a message. No customer data is shown.

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
    : `${season.year} season, ${range}: over. These are its final figures; the bonus is paid ${dayLabel(season.payDate)}.`;
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
      {score.complete
        ? <span className="text-ui-title font-medium">{percent(score.value)}{score.band && <Badge tone="strong">{score.band.rateBps > 0 ? `Bonus band ${bpsPercent(score.band.rateBps)}` : 'Below the bonus bands'}</Badge>}</span>
        : <span className="text-ui-caption text-ink-secondary">Not complete: {score.missing.map(key => PART_LABELS[key]).join(', ')} {score.missing.length === 1 ? 'has' : 'have'} no data yet.</span>}
    </div>
    <Table aria-label="Score parts">
      <THead><TR><TH>Part</TH><TH align="right">Score</TH><TH align="right">Weight</TH></TR></THead>
      <TBody>
        {Object.entries(score.parts).map(([key, part]) => <TR key={key}>
          <TD>{PART_LABELS[key]}</TD>
          <TD nums align="right">{part.value === null ? 'No data yet' : percent(part.value)}</TD>
          <TD nums align="right">{percent(part.weight)}</TD>
        </TR>)}
      </TBody>
    </Table>
  </Card>;
}

function BonusCard({ scoreboard }) {
  const { seasonBonus, multiplier, stayBonus } = scoreboard;
  return <Card className="grid gap-3 p-4" aria-label="Bonus estimates">
    <h3 className="m-0 text-ui-title font-medium">Bonus estimates</h3>
    <div className="grid gap-4 sm:grid-cols-2">
      <Stat
        label="Season bonus (paid the last Friday of September)"
        value={seasonBonus.estimateCents === null ? 'Not estimated yet' : centsToDollars(seasonBonus.estimateCents)}
        note={seasonBonus.estimateCents === null
          ? NO_BONUS_REASONS[seasonBonus.reason] || ESTIMATE_NOTE
          : `${ESTIMATE_NOTE} ${bpsPercent(seasonBonus.rateBps)} of ${centsToDollars(seasonBonus.grossCents)} pay x ${times(seasonBonus.multiplierE4)} multiplier.`}
      />
      <Stat
        label="Next stay bonus"
        value={stayBonus ? dayLabel(stayBonus.dueDate) : 'None left'}
        note={stayBonus
          ? `${stayBonus.years}-year bonus, about ${centsToDollars(stayBonus.estimateCents)}. ${ESTIMATE_NOTE}`
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
        label={`Commission, ${commission.year} to date`}
        value={centsToDollars(commission.yearToDateCents)}
        note={`${centsToDollars(commission.paidCents)} paid, ${centsToDollars(commission.pendingCents)} waiting for the next pay run.`}
      />
    </Card>
    <BonusCard scoreboard={scoreboard} />
  </div>;
}

// Staff page, Time > Scoreboard: the signed-in technician's own board, loaded by useTechScoreboard.
export default function Scoreboard({ board }) {
  if (board.status !== 'ready') return null;
  return <Card className="grid gap-3 p-4" aria-label="Scoreboard">
    <div>
      <h2 className="m-0 text-ui-title font-medium">Scoreboard</h2>
      <p className="m-0 text-ui-caption text-ink-secondary">Your own numbers only. {ESTIMATE_NOTE}</p>
    </div>
    <ScoreboardView scoreboard={board.scoreboard} />
  </Card>;
}

async function call(path) {
  const response = await adminFetch(`/admin/tech-rewards-scoreboard${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Scoreboard request failed (${response.status}).`);
  return data;
}

// Staff page, Team > Scoreboard preview (admin only, works with the gate off): the owner opens any one technician's
// board to check the numbers before technicians see them.
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
          {(technicians || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
    </div>
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
    {technicianId && !board && !error && <p role="status" className="m-0">Loading…</p>}
    {board && <ScoreboardView scoreboard={board} />}
  </Card>;
}
