/**
 * Intelligence Bar: what the model is shown of a task context.
 * server/services/intelligence-bar/model-context.js
 *
 * Kept apart from task-context.js so the route can import it without the lookup code.
 */
const { ibTargetRulesV2Live } = require('../../config/feature-gates');
const TaskContext = require('./task-context');

// What the model is shown of a task context (GATE_IB_TARGET_RULES_V2, Codex #6369 r14).
// With more than one same-name customer in play, each customer row is cut to its id,
// display name, plain city (safeChoiceCity or omitted), last visit and button text:
// no address, version, link or other customer-entered text reaches the model. The
// stored context keeps the full rows. A single customer with no candidates is unchanged.
const slimCustomer = customer => (customer && typeof customer === 'object' ? {
  customer_id: customer.customer_id, label: customer.label, provenance: customer.provenance,
  ...(TaskContext.safeChoiceCity(customer.city) ? { city: TaskContext.safeChoiceCity(customer.city) } : {}),
  ...(customer.last_visit !== undefined ? { last_visit: customer.last_visit } : {}),
  ...(customer.choice_label !== undefined ? { choice_label: customer.choice_label } : {}),
} : customer);

function modelContext(taskContext) {
  // Owner-direct requests only: every other admin keeps the legacy context (Codex #6369 r24).
  if (!ibTargetRulesV2Live() || taskContext?.ownerDirect !== true || !(taskContext?.candidates?.length > 1)) return taskContext;
  const { page = {} } = taskContext;
  return { ...taskContext, candidates: taskContext.candidates.map(slimCustomer),
    target: slimCustomer(taskContext.target), targets: (taskContext.targets || []).map(slimCustomer),
    page: { ids: page.ids, ...(page.customer ? { customer: slimCustomer(page.customer) } : {}) } };
}


module.exports = { modelContext, slimCustomer };
