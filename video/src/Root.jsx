import { Composition } from 'remotion';
import { VisitRecap, RECAP_FPS, recapDuration } from './VisitRecap';

// Demo defaults so `remotion studio` / a no-props render still shows something.
// In production the server passes inputProps={{ data, media }} per visit, where
// `data` = { customerName, serviceDate, pestReportV2 } and `media` = the tech's
// tagged clips/photos ([] = data-only fallback tier).
const DEMO = {
  customerName: 'Tony',
  serviceDate: 'June 18, 2026',
  pestReportV2: {
    status: { key: 'recommended', label: 'One step recommended', tone: 'watch' },
    statusSummary: 'One quick step at the entry will keep your barrier strong.',
    supportingMetric: { kind: 'pressure', score: '1.4', max: 5, label: 'Low', trend: 'down' },
    defense: {
      summary: 'One customer action would help strengthen the service plan.',
      items: [
        { key: 'perimeter_shield', label: 'Perimeter', status: 'active', detail: 'Exterior protection applied today.' },
        { key: 'front_entry', label: 'Front entry', status: 'watched', detail: 'Activity noted near the entry.' },
        { key: 'lanai', label: 'Lanai', status: 'clear', detail: 'No lanai activity.' },
        { key: 'pool_equipment_pad', label: 'Pool pad', status: 'clear', detail: 'No pool pad activity.' },
      ],
    },
    primaryMove: { title: 'Pull mulch back from the front entry', dueLabel: 'Before next service' },
    bugFiles: [{ suspectLabel: 'Ghost ant', whereSeen: 'Front yard', whatWeDid: 'Perimeter spray', whyItMatters: 'They trail toward entry points.' }],
    pressureReceipt: { headline: 'Since starting WaveGuard', stats: [{ label: 'Pressure down', value: '22%' }] },
    forecast: { monthName: 'June', headline: 'Warm, humid weather is pushing ant pressure up this week.', pests: [{ label: 'Ghost ant', level: 'high', trend: 'up' }] },
  },
};

export const RemotionRoot = () => (
  <Composition
    id="VisitRecap"
    component={VisitRecap}
    durationInFrames={recapDuration([])}
    fps={RECAP_FPS}
    width={1080}
    height={1920}
    defaultProps={{ data: DEMO, media: [] }}
    calculateMetadata={({ props }) => ({ durationInFrames: recapDuration(props.media || []) })}
  />
);
