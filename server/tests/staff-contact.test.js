// The staff-contact rules (who counts as a person reaching a customer) live in
// one module, read by the texting helper's fulfillment loader and by the
// call-promise ledger's callback proof, so the two can never diverge.
const fs = require('fs');
const path = require('path');
const staff = require('../services/staff-contact');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');

describe('staff-contact is the one definition both callers use', () => {
  test.each(['sms-commitment-fulfillment.js', 'call-commitments.js'])('%s imports the rules and defines none of its own', (file) => {
    const text = source(file);
    expect(text).toMatch(/require\('\.\/staff-contact'\)/);
    for (const name of ['operatorReply', 'personCallBack', 'smsDelivered', 'STAFF_CALL_SOURCES', 'STAFF_APPROVED_SMS_TYPES']) {
      expect(text).not.toMatch(new RegExp(`(const|function|let|var)\\s+${name}\\b`));
    }
  });

  test('the texting helper and the ledger read the same select fragments', () => {
    expect(source('sms-commitment-fulfillment.js')).toMatch(/smsContactSelects\(conn\)[\s\S]*callContactSelects\(conn\)/);
    const ledger = source('call-commitments.js');
    expect(ledger).toMatch(/callContactSelects\(conn\)/);
    expect(ledger).toMatch(/smsContactSelects\(conn, "os"\)/);
    expect(ledger).toMatch(/operatorSentSql\("os"\)/);
  });

  test('the exports keep the reviewed contract', () => {
    expect(staff.STAFF_CALL_SOURCES).toEqual(['admin-click', 'admin-callback', 'tech-click']);
    expect(staff.STAFF_APPROVED_SMS_TYPES).toEqual(['ai_approved', 'ai_revised']);
    // A bare 'manual' type is never a person's text: automations reuse it.
    expect(staff.operatorReply({ message_type: 'manual', operator_sent: false })).toBe(false);
    expect(staff.operatorReply({ message_type: 'manual', operator_sent: true })).toBe(true);
    expect(staff.operatorReply({ message_type: 'ai_revised' })).toBe(true);
    const call = { source: 'admin-click', v2_extraction_status: 'valid', is_voicemail: 'false', customer_leg_status: null };
    expect(staff.personCallBack(call)).toBe(true);
    expect(staff.personCallBack({ ...call, source: 'collections_voice' })).toBe(false);
    expect(staff.personCallBack({ ...call, is_voicemail: 'true' })).toBe(false);
    expect(staff.personCallBack({ ...call, customer_leg_status: 'completed', customer_leg_seconds: '59' })).toBe(false);
    expect(staff.personCallBack({ ...call, customer_leg_status: 'completed', customer_leg_seconds: '60' })).toBe(true);
    expect(staff.smsDelivered({ status: 'delivered' })).toBe(true);
    expect(staff.smsDelivered({ status: 'sent' })).toBe(false);
    expect(staff.smsDelivered({ status: 'sent', provider_accepted: true, from_phone: 'push' })).toBe(true);
    expect(staff.smsDelivered({ status: 'queued', provider_accepted: true, push_channel: true })).toBe(false);
  });

  test('the SQL twins are aliased per query and carry no bare question mark (a knex raw would read it as a binding)', () => {
    for (const sql of [staff.operatorReplySql('os'), staff.smsDeliveredSql('os'), staff.personCallBackSql('ev')]) expect(sql).not.toMatch(/\?/);
    expect(staff.operatorReplySql('os')).toContain("os.message_type IN ('ai_approved', 'ai_revised')");
    expect(staff.smsDeliveredSql('os')).toContain("os.status = 'delivered'");
    expect(staff.personCallBackSql('ev')).toContain("ev.source IN ('admin-click', 'admin-callback', 'tech-click')");
    expect(staff.personCallBackSql()).toContain('call_log.v2_extraction_status');
  });

  test('the SQL helpers build the fields the predicates read, aliased per query', () => {
    const conn = { raw: (sql) => ({ sql }) };
    expect(staff.operatorSentSql('os')).toContain("os.metadata->>'human_authored'");
    expect(staff.operatorSentSql('os')).toContain('os.admin_user_id IS NOT NULL');
    const sms = staff.smsContactSelects(conn, 'os').map((r) => r.sql).join('\n');
    expect(sms).toMatch(/as provider_accepted/);
    expect(sms).toMatch(/as push_channel/);
    expect(sms).toMatch(/as operator_sent/);
    const call = staff.callContactSelects(conn).map((r) => (typeof r === 'string' ? r : r.sql)).join('\n');
    for (const field of ['source', 'v2_extraction_status', 'is_voicemail', 'customer_leg_status', 'customer_leg_seconds']) expect(call).toContain(field);
  });
});
