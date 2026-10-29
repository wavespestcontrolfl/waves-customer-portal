/**
 * IB compose_email against real Postgres (committed fixture rows, cleaned up), Gmail mocked (no email is ever sent): a
 * double Confirm never sends twice. The pending card is claimed by ONE atomic UPDATE on ib_pending_actions
 * (pending-actions.js claimForConfirm), so two concurrent Confirms of the same card produce one claim and one send, and a
 * later replay is refused as already_used. The executor then sends exactly the carded fields; a card whose recipient
 * changed (a customer's email edited in the database) is refused with nothing sent. Synthetic names and addresses only.
 */
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockSendMessage = jest.fn();
jest.mock('../services/email/gmail-client', () => ({
  sendMessage: (...a) => mockSendMessage(...a),
  fromHeader: () => 'Waves Pest Control <office@example.invalid>',
}));

const LOCAL = (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();

(SKIP || !LOCAL ? describe.skip : describe)('IB compose_email (real PG)', () => {
  let db;
  let PendingActions;
  let executeComposeEmailTool;
  const created = { actions: [], customers: [] };
  const ADMIN = { isAdmin: true, technicianId: null };
  const ACTOR = `fixture-admin-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    process.env.GATE_IB_COMPOSE_EMAIL = 'true';
    process.env.GATE_IB_PLATFORM = 'true';
    db = require('../models/db');
    PendingActions = require('../services/intelligence-bar/pending-actions');
    ({ executeComposeEmailTool } = require('../services/intelligence-bar/compose-email-tools'));
  });

  afterAll(async () => {
    delete process.env.GATE_IB_COMPOSE_EMAIL;
    delete process.env.GATE_IB_PLATFORM;
    if (!db) return;
    if (created.actions.length) await db('ib_pending_actions').whereIn('id', created.actions).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
    await db.destroy();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMessage.mockResolvedValue({ id: 'fixture-gmail-id' });
  });

  async function customer(email) {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Fixture', last_name: 'Composer', phone: '+12025550188', email, property_type: 'residential' });
    created.customers.push(id);
    return id;
  }

  // The card as the route stores it: the proposal params and the preview the confirm re-derives.
  async function card(input) {
    const preview = await executeComposeEmailTool('compose_email', input, ADMIN);
    expect(preview).toMatchObject({ preview: true });
    const { row } = await PendingActions.createPendingAction({
      toolName: 'compose_email', params: input, requestedBy: ACTOR, summary: 'Send a new email',
    }).then((r) => ({ row: r.row || r }));
    created.actions.push(row.id);
    return { preview, id: row.id };
  }

  // What the confirm route does for one Confirm tap: claim the card, then run the executor with its pin and operation id.
  async function tap(cardInfo, input) {
    const claim = await PendingActions.claimForConfirm(cardInfo.id, ACTOR);
    if (!claim.action) return { claimed: false, error: claim.error };
    const result = await executeComposeEmailTool('compose_email', { ...input, confirmed: true, _verified_compose_email_version: cardInfo.preview._version }, { ...ADMIN, operationId: cardInfo.id });
    return { claimed: true, result };
  }

  test('two concurrent Confirms of one card: one claim, one send; a later replay is already_used', async () => {
    const input = { email_address: `fixture-${randomUUID().slice(0, 8)}@vendor.example`, subject: 'Quote request', body: 'Hello,\nCould you send a quote for next month?\nThanks' };
    const cardInfo = await card(input);
    const [a, b] = await Promise.all([tap(cardInfo, input), tap(cardInfo, input)]);
    expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
    const loser = a.claimed ? b : a;
    expect(loser.error).toBe('already_used');
    const winner = a.claimed ? a : b;
    expect(winner.result).toMatchObject({ success: true, state: 'provider_accepted', providerMessageId: 'fixture-gmail-id' });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(input.email_address, 'Quote request', 'Hello,<br>Could you send a quote for next month?<br>Thanks', undefined, undefined);
    const replay = await tap(cardInfo, input);
    expect(replay).toMatchObject({ claimed: false, error: 'already_used' });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(await db('ib_pending_actions').where({ id: cardInfo.id }).first('status')).toMatchObject({ status: 'confirmed' });
  });

  test('five concurrent Confirms still send once', async () => {
    const input = { email_address: `fixture-${randomUUID().slice(0, 8)}@vendor.example`, subject: 'Hello', body: 'One line.' };
    const cardInfo = await card(input);
    const taps = await Promise.all(Array.from({ length: 5 }, () => tap(cardInfo, input)));
    expect(taps.filter((t) => t.claimed)).toHaveLength(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test('a customer\'s email edited after the card: the confirmed run is refused and nothing is sent', async () => {
    const id = await customer(`fixture-${randomUUID().slice(0, 8)}@example.invalid`);
    const input = { customer_id: id, subject: 'Your visit', body: 'See you tomorrow.' };
    const cardInfo = await card(input);
    expect(cardInfo.preview).toMatchObject({ sends_to_customer: true, pinned_recipient: { customer_id: id } });
    await db('customers').where({ id }).update({ email: `changed-${randomUUID().slice(0, 8)}@example.invalid` });
    const out = await tap(cardInfo, input);
    expect(out.claimed).toBe(true);
    expect(out.result).toMatchObject({ preview_changed: true, code: 'preview_changed' });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('a customer on file: the card names them and the send goes to their email on file, once', async () => {
    const email = `fixture-${randomUUID().slice(0, 8)}@example.invalid`;
    const id = await customer(email);
    const input = { customer_id: id, subject: 'Your visit', body: 'See you tomorrow.' };
    const cardInfo = await card(input);
    expect(cardInfo.preview).toMatchObject({ to_label: `Fixture Composer <${email}>` });
    expect(await tap(cardInfo, input)).toMatchObject({ claimed: true, result: { success: true, sent_to_customer: true } });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toBe(email);
  });
});
