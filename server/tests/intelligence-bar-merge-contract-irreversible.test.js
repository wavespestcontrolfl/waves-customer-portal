/**
 * merge_customers' confirmation contract: irreversibility is input-dependent.
 * A merge whose referral fold the duplicates-queue undo refuses says so in
 * its preview (revertible_from_queue:false) and the contract must carry
 * irreversible:true so PendingActionsCard shows "Cannot be undone" (Codex r3 P2).
 */
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const params = { winner_customer_id: '10000000-0000-4000-8000-000000000001', loser_customer_id: '10000000-0000-4000-8000-000000000002' };
const displayParams = { winner: 'Real Customer (…0101)', loser: 'Unknown (…0101)', moving: { total_rows: 3 } };
const preview = (revertible) => ({
  preview: true, winner_name: 'Real Customer', loser_name: 'Unknown', moving: { invoices: 3, total_rows: 3 },
  financial_effects: { account_credits_moved_to_winner: 0, predicted_collision_handlers: revertible === false ? ['referral_promoters'] : [], revertible_from_queue: revertible },
  note_to_operator: 'x',
});

const previewWithSessions = (sessions) => ({
  preview: true, winner_name: 'Real Customer', loser_name: 'Unknown', moving: { invoices: 3, total_rows: 3 },
  financial_effects: {
    account_credits_moved_to_winner: 0, predicted_collision_handlers: [],
    revertible_from_queue: 'unless the sweep has to fold colliding rows (journaled)',
    combined_payment_sessions: sessions,
  },
  note_to_operator: 'x',
});

test('a plain merge is not flagged irreversible; a merge with a predicted collision fold is', () => {
  const plain = buildContract({ toolName: 'merge_customers', params, displayParams, preview: preview('unless the sweep has to fold colliding rows (journaled)') });
  expect(plain.irreversible).toBe(false);
  const folded = buildContract({ toolName: 'merge_customers', params, displayParams, preview: preview(false) });
  expect(folded.irreversible).toBe(true);
});

test('a merge that cancels a Stripe checkout session is irreversible however undoable the database merge is (Codex r7 P2)', () => {
  // The DB merge may revert cleanly, but a canceled PaymentIntent cannot be
  // restored and the customer's payment link is dead — the card has to carry
  // the prominent "Cannot be undone" warning.
  const cancels = buildContract({
    toolName: 'merge_customers', params, displayParams,
    preview: previewWithSessions({ winner: [], loser: [{ payment_intent_id: 'pi_a', outcome: 'cancel' }] }),
  });
  expect(cancels.irreversible).toBe(true);
  // Same for a single-invoice checkout the merge invalidates.
  const cancelsSingle = buildContract({
    toolName: 'merge_customers', params, displayParams,
    preview: previewWithSessions({ winner: [{ payment_intent_id: 'pi_w', outcome: 'cancel_single_invoice' }], loser: [] }),
  });
  expect(cancelsSingle.irreversible).toBe(true);
  // Outcomes that cancel nothing in Stripe leave the merge revertible.
  const noCancel = buildContract({
    toolName: 'merge_customers', params, displayParams,
    preview: previewWithSessions({
      winner: [{ payment_intent_id: 'pi_w', outcome: 'kept_single_invoice' }],
      loser: [{ payment_intent_id: 'pi_a', outcome: 'stamps_cleared' }, { payment_intent_id: 'pi_b', outcome: 'in_flight' }],
    }),
  });
  expect(noCancel.irreversible).toBe(false);
});
