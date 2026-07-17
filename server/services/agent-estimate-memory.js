async function approvedAgentEstimateMemoryPrompt(database, limit = 30) {
  const rows = await database('agent_estimate_memory')
    .where({ status: 'approved' })
    // Select the newest approvals before limiting. Reverse only after the DB
    // has returned that newest window so the prompt reads chronologically.
    .orderBy('version', 'desc')
    .limit(limit)
    .select('version', 'rule_text')
    .catch(() => []);
  if (!rows.length) return '';
  const rules = [...rows].reverse()
    .map((row) => `- v${row.version}: ${String(row.rule_text || '').slice(0, 1600)}`);
  return `\n\nAPPROVED AGENT ESTIMATE LEARNING (operator-reviewed; apply as policy, never as pricing data):\n${rules.join('\n')}`;
}

module.exports = { approvedAgentEstimateMemoryPrompt };
