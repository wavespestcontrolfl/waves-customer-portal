/**
 * Read/write scope catalog for the Intelligence Bar.
 *
 * Every tool in action-policy.json declares a `scope`, the class of customer
 * data it can reach, and task-context.js enforces that class inside a
 * customer-scoped task. A tool with a missing or invalid scope is rejected
 * by the action registry at load time (it never becomes executable) and by
 * the task-context guards at call time, so an unclassified tool fails closed
 * instead of reading every customer's rows.
 *
 * Membership lives in action-policy.json; tests/intelligence-bar-action-registry.test.js
 * freezes the non-trivial classes so a tool cannot silently drop out of one.
 */
const policy = require('./action-policy.json');

// Read classes.
//   none        touches no customer-identifying rows (infra, SEO, catalogs, pure totals)
//   record      reads one customer's records through a customer or record selector;
//               a selector-free call inherits the task customer and fails closed when
//               the named customer did not resolve
//   scoped      confines its rows to the task's read scope (readCustomerIds); fails
//               closed when an explicitly named customer did not resolve
//   broad       lists other customers' identifiable rows and takes no selector;
//               refused inside a customer-scoped task
//   actor_wide  the operator's own history, quoting any customer verbatim; refused
//               inside a customer-scoped task
//   phone_keyed / email_keyed / address_keyed
//               keyed by a contact or street address that must belong to the
//               task customer (a saved customer or property address)
// Write classes.
//   none        touches no customer records
//   record      acts on customer records; every record it references must belong
//               to a task customer (validateRecordTarget). A writer that creates a
//               record, or whose cohort the route resolves to ids before proposal,
//               references nothing at proposal time and is admitted on that basis
//   route_wide  acts on every stop for a date or technician; refused inside a
//               customer-scoped task
const READ_SCOPES = Object.freeze(['none', 'record', 'scoped', 'broad', 'actor_wide', 'phone_keyed', 'email_keyed', 'address_keyed']);
const WRITE_SCOPES = Object.freeze(['none', 'record', 'route_wide']);

const WRITE_KINDS = Object.freeze(['internal_write', 'external_action']);

// Only a reviewed kind has scopes at all: a missing or misspelled kind cannot
// borrow the write classes and pass as `none` or `record`.
function scopesFor(kind) {
  if (kind === 'read') return READ_SCOPES;
  return WRITE_KINDS.includes(kind) ? WRITE_SCOPES : Object.freeze([]);
}

function validScope(entry) {
  return Boolean(entry) && typeof entry.scope === 'string' && scopesFor(entry.kind).includes(entry.scope);
}

// The declared scope of a tool, or null when the tool is unknown or its
// declaration is missing or invalid for its kind. Callers treat null as a
// refusal, never as "unrestricted".
function scopeOf(toolName) {
  const entry = policy[toolName];
  return validScope(entry) ? entry.scope : null;
}

function toolsWithScope(scope) {
  return Object.keys(policy).filter(name => scopeOf(name) === scope).sort();
}

const UNCLASSIFIED = Object.freeze({
  error: 'This capability has no reviewed data scope and cannot run',
  code: 'scope_unclassified',
});

module.exports = { READ_SCOPES, WRITE_SCOPES, WRITE_KINDS, scopesFor, validScope, scopeOf, toolsWithScope, UNCLASSIFIED };
