/** Final routed action, falling back to the provisional action before routing. */
module.exports = `COALESCE(
  (SELECT r.action_type FROM autonomous_runs r
    WHERE r.opportunity_id = opportunity_queue.id
    ORDER BY r.claimed_at DESC, r.id DESC LIMIT 1),
  (SELECT b.action_type FROM content_briefs b
    WHERE b.opportunity_id = opportunity_queue.id
    ORDER BY b.composed_at DESC, b.id DESC LIMIT 1),
  opportunity_queue.action_type
)`;
