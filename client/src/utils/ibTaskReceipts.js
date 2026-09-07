// Retain the server's known action outcome even if the follow-up task read fails.
export function retainTaskReceipt(task, action, decision, result) {
  if (result.outcome === 'awaiting_approval' || (decision === 'cancel' && result.cancelled !== true)) return task;
  const known = [...(task?.pendingActions || []), ...(task?.receipts || [])].find(item => item.id === action.id);
  if (!known) return task;
  const receipt = { ...known, ...result, id: known.id, tool: known.tool, summary: known.summary, contract: known.contract,
    ...(decision === 'cancel' && result.cancelled ? { outcome: 'canceled' } : {}) };
  return { ...task, pendingActions: (task.pendingActions || []).filter(item => item.id !== action.id),
    receipts: [...(task.receipts || []).filter(item => item.id !== action.id), receipt] };
}
