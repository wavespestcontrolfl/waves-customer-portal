const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
const auditPathSuffix = path.join(
  'server',
  'scripts',
  'audit-staff-rollout-readiness.js',
);

const transaction = {
  raw: async (sql) => {
    if (sql.includes('current_database()')) {
      return {
        rows: [{
          database_name: 'staff_audit_test',
          server_address: 'mock-db',
          server_port: 5432,
          database_user: 'staff_audit_test',
        }],
      };
    }
    return { rows: [] };
  },
};
transaction.transaction = async (callback) => callback(transaction);

const database = {
  destroy: async () => {},
  transaction: async (callback) => callback(transaction),
};

Module._load = function loadWithStaffAuditDatabase(request, parent, isMain) {
  if (
    request === '../models/db'
    && parent?.filename?.endsWith(auditPathSuffix)
  ) {
    return database;
  }
  return originalLoad.call(this, request, parent, isMain);
};
