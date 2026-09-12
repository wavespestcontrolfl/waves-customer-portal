# Recovery attribution follow-up to PR #4437

Status: design proposal; implementation is separate from the safety change.

Persist the recovery result with the call processing result. Triage cards remain operator tasks; their status, timestamps, and payload edits must not establish a promotion cohort.

Add a nullable JSONB field on call_log for the finalized recovery result. It carries processing_generation, the recovery prompt version, the resolved recovery model, attempted/skipped outcome, and recovered/failed outcome. Capture model and prompt identity at execution, not when a later card is filed. Store only contract identity and outcome, without candidate streets or transcript text.

Clear or mark the result pending when claiming a new processing generation. Finalize it under the same processing_token guard as the routing result. Interrupted, unprocessed, legacy, or generation-mismatched rows are unattributable and excluded with explicit counts. A skipped result is current only when it belongs to the finalized processing generation; absence must never mean skipped. Preserve compatibility for older deployed workers: missing attribution cannot produce a positive readiness verdict.

The readiness command reads this field directly. Attempted rows qualify only when their execution-time prompt and model match the current contract. A recovered result reconstructs an accepting address verdict only for that same finalized processing result. A failed result keeps its failure verdict. Triage card creation, resolution, reopening, and timestamp changes have no effect on the cohort.

Restore the readiness command only after database tests prove: success → failure → success; failed → skipped → failed; prompt changes; model changes and rollbacks; stale worker after claim loss; crashes between extraction, recovery, routing, and finalization; historical rows without attribution; and operator mutations of all related cards.

The original experimental implementation is retained in commit 6016932fc on PR #4437 for investigation. It is reference material, not the implementation proposed here.
