import PendingActionsCard from './PendingActionsCard';

export default function IntelligenceTaskCard({ task, onSelectTarget, onRefresh, onContinue, onResolved, variant = 'light' }) {
  if (!task) return null;
  // "dark" is the Tier-2 D palette of the desktop modal; "light" the zinc shell.
  const dark = variant === 'dark';
  const text = dark ? '#334155' : '#27272A', border = dark ? '#E2E8F0' : '#E4E4E7';
  const target = task.taskTarget;
  const receipts = task.receipts || [];
  const status = task.taskState === 'running' ? 'Request running'
    : task.taskState === 'needs_information' ? 'Target needs clarification'
      : task.pendingActions?.length ? 'Review the proposed action'
        : receipts.length ? 'Saved outcomes'
          : 'No changes recorded';
  const buttonStyle = { minHeight: 44, padding: '8px 12px', border: `1px solid ${dark ? '#CBD5E1' : '#D4D4D8'}`, borderRadius: 8,
    background: '#FFF', color: text, font: 'inherit', cursor: 'pointer' };
  return (
    <section aria-label="Active intelligence task" style={{ border: `1px solid ${border}`, borderRadius: 12, padding: 12, marginBottom: 12, fontSize: 14, color: text }}>
      <div role="status" style={{ fontWeight: 500, marginBottom: 8 }}>{status}</div>
      {target && <div><span>Task for </span><a href={target.href} style={{ color: 'inherit', fontWeight: 500 }}>{target.label}</a>
        {target.address && <div style={{ marginTop: 4 }}>{target.address}</div>}</div>}
      {task.taskState === 'needs_information' && task.candidates?.map(candidate => (
        <button key={candidate.customer_id} type="button" onClick={() => onSelectTarget(candidate)}
          style={{ display: 'block', minHeight: 44, width: '100%', textAlign: 'left', padding: 8, marginTop: 8 }}>
          {candidate.label} — {candidate.address || candidate.city || 'No address saved'}
        </button>
      ))}
      <PendingActionsCard actions={[
        ...receipts.filter(r => r.outcome !== 'awaiting_approval').map(r => ({
          id: r.id, tool: r.tool, summary: r.summary, contract: r.contract, receipt: r,
        })), ...(task.pendingActions || []),
      ]} variant={variant} touchFriendly onResolved={onResolved} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button type="button" onClick={onRefresh} style={buttonStyle}>Refresh status</button>
        {task.canContinue && <button type="button" onClick={onContinue} style={buttonStyle}>Continue request</button>}
      </div>
    </section>
  );
}
