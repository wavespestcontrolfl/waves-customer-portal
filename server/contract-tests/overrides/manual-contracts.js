/**
 * Manual contract overrides for tools whose DB references can't be reliably
 * extracted via regex (raw SQL, dynamic column names, CTEs, etc.).
 *
 * Format:
 *   {
 *     '<tool_name>': {
 *       tables:  ['table_a', 'table_b'],
 *       columns: { table_a: ['col1', 'col2'], table_b: ['*'] },
 *       reason:  'why this needs manual declaration',
 *       sideEffects: true,         // optional — skip execute-smoke
 *       registerManually: true,    // optional — add a tool the registry wouldn't find
 *       schema:  { ... },          // optional — required if registerManually
 *     }
 *   }
 *
 * Tools can also declare an inline `_contracts` object on their definition;
 * the registry honors both.
 */
module.exports = {
  // _global applies to every tool. Use for tables/columns referenced inside
  // try/catch best-effort blocks that may legitimately be absent in some envs.
  _global: {
    optionalTables: [
      'revenue_daily',        // tax-tools: try/catch YTD revenue aggregation
      'ad_spend_log',         // revenue-tools: try/catch ad spend lookup
      'csr_call_records',     // comms-tools: try/catch CSR call log join
      'csr_follow_up_tasks',  // comms-tools: try/catch follow-up aggregation
    ],
    optionalColumns: {
      call_log: ['transcript'], // comms-tools: try/catch transcript search
    },
    reason: 'Tables/columns referenced inside try/catch best-effort blocks. Absence is tolerated at runtime.',
  },

  // Lead-response agent write tools — they insert lead_activities /
  // estimates / lead_agent_responses rows and send SMS via Twilio. Smoke
  // execution must never fire them (the nil-UUID probe got as far as an
  // estimates INSERT before the FK stopped it — that was luck, not safety).
  flag_for_estimate:  { sideEffects: true, reason: 'inserts estimates + lead_activities rows' },
  send_lead_response: { sideEffects: true, reason: 'sends SMS via Twilio, inserts lead_activities' },
  update_lead_pipeline: { sideEffects: true, reason: 'updates leads.pipeline stage, inserts lead_activities' },
  queue_for_adam:     { sideEffects: true, reason: 'inserts lead_agent_responses queue rows' },
  save_lead_response_report: { sideEffects: true, reason: 'inserts lead_agent_responses report rows (write path swallowed its own failure during smoke)' },
};
