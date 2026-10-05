/** The translation lane's send snapshot (sms-translation sendSnapshotFor) against the REAL drafter helpers. Synthetic data. */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

test('the send snapshot carries the reply\'s escalation, so the follow-up timing check applies to a translated card (Codex #5839 r3)', () => {
  const { _test: { sendSnapshotFor } } = require('../services/sms-translation');
  const escalate = [{ type: 'escalate', note: 'followup_promised' }];
  const draft = (intended_actions) => ({ promptVersion: 'house_voice_v12_real_answers7_m', factsBlock: 'UPCOMING SERVICES:\n- none\nBILLING:\n', parsed: { reply: "Sorry we missed you. We'll follow up within the hour.", intended_actions } });
  const withEscalation = sendSnapshotFor({ draft: draft(escalate), context: {}, inboundEnglish: 'you missed my visit' });
  expect(withEscalation.input_snapshot.intended_actions).toEqual(escalate);
  const { draftPromisedFollowup } = require('../services/sms-followup-sla');
  expect(draftPromisedFollowup(withEscalation.input_snapshot, withEscalation.prompt_version)).toBe(true);
  const without = sendSnapshotFor({ draft: draft([]), context: {}, inboundEnglish: 'thanks' });
  expect(without.input_snapshot.intended_actions).toBeUndefined();
});
