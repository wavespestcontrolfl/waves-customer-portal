const mockDb = jest.fn();

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const { executeAction } = require('../services/health-alerts');
const retirementMigration = require('../models/migrations/20260518000001_retire_customer_save_sequences');

describe('save sequence retirement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('executeAction rejects legacy sequence actions without marking them executed', async () => {
    const updateAlert = jest.fn();
    mockDb.mockImplementation((table) => {
      if (table === 'customer_health_alerts') {
        return {
          where: jest.fn(() => ({
            first: jest.fn(async () => ({
              id: 'alert-1',
              customer_id: 'customer-1',
              recommended_actions: JSON.stringify([
                { label: 'Enroll in save sequence', sequenceType: 'churn_save' },
              ]),
              auto_action_taken: JSON.stringify([]),
            })),
            update: updateAlert,
          })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await executeAction('alert-1', 0);

    expect(result).toEqual({
      success: false,
      code: 'retired_action_type',
      message: 'Save sequence actions are no longer available.',
    });
    expect(mockDb).not.toHaveBeenCalledWith('customers');
    expect(updateAlert).not.toHaveBeenCalled();
  });

  test('migration strips saved sequence actions and carries the disabled churn-save kill switch', async () => {
    const updateAlert = jest.fn(async () => 1);
    const disableReplacementTemplates = jest.fn(async () => 2);
    const deleteChurnSaveTemplate = jest.fn(async () => 1);
    const dropColumn = jest.fn();
    const droppedTables = [];

    const knex = jest.fn((table) => {
      if (table === 'customer_health_alerts') {
        return {
          select: jest.fn(() => ({
            whereNotNull: jest.fn(async () => [
              {
                id: 'alert-1',
                recommended_actions: JSON.stringify([
                  { label: 'Call immediately', type: 'call' },
                  { label: 'Enroll in save sequence', type: 'sequence', sequenceType: 'churn_save' },
                ]),
              },
            ]),
          })),
          where: jest.fn(() => ({ update: updateAlert })),
        };
      }
      if (table === 'sms_templates') {
        return {
          where: jest.fn(() => ({
            first: jest.fn(async () => ({ template_key: 'churn_save_step1', is_active: false })),
            del: deleteChurnSaveTemplate,
          })),
          whereIn: jest.fn(() => ({ update: disableReplacementTemplates })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    knex.schema = {
      hasTable: jest.fn(async (table) => (
        ['customer_health_alerts', 'customer_save_sequences', 'retention_agent_reports', 'sms_templates'].includes(table)
      )),
      hasColumn: jest.fn(async () => true),
      dropTable: jest.fn(async (table) => {
        droppedTables.push(table);
      }),
      alterTable: jest.fn(async (_table, callback) => callback({ dropColumn })),
    };

    await retirementMigration.up(knex);

    expect(updateAlert).toHaveBeenCalledWith(expect.objectContaining({
      recommended_actions: JSON.stringify([{ label: 'Call immediately', type: 'call' }]),
    }));
    expect(droppedTables).toEqual(['customer_save_sequences']);
    expect(dropColumn).toHaveBeenCalledWith('sequences_enrolled');
    expect(disableReplacementTemplates).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    expect(deleteChurnSaveTemplate).toHaveBeenCalled();
  });
});
