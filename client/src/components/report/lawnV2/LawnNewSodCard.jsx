// GATE_LAWN_NEW_SOD_REPORT_CARD: the "New sod" card on the lawn web report. It prints the strings the server built
// from the block frozen at completion (server/services/lawn-sod-report-card.js) and restates no rule: what was held,
// when each resumes and the bag swap are all in `data.lawnNewSod`. Live web report only (the PDF and static views
// do not print it). Absent payload key = nothing.

import { Card, CardTitle } from './LawnReportV2';

const BODY = 'var(--text)';

const text = { margin: 0, fontSize: 16, color: BODY, lineHeight: 1.5 };

export default function LawnNewSodCard({ data, mode, style = null }) {
  const card = data?.lawnNewSod;
  if (mode !== 'live' || !card || typeof card.title !== 'string' || !Array.isArray(card.items) || !card.items.length) return null;
  return (
    <Card style={style}>
      <div data-testid="lawn-new-sod">
        <CardTitle>{card.title}</CardTitle>
        <p style={text}>{card.lead}</p>
        <ul style={{ ...text, margin: '6px 0 0', paddingLeft: 22 }}>
          {card.items.map((item) => <li key={item} style={{ marginTop: 4 }}>{item}</li>)}
        </ul>
        {[card.rest, card.swap, card.close].filter((line) => typeof line === 'string' && line).map((line) => (
          <p key={line} style={{ ...text, marginTop: 10 }}>{line}</p>
        ))}
      </div>
    </Card>
  );
}
