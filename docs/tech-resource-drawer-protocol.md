# Current-visit Protocol and SOP sheet

`GATE_PROTOCOL_SOP` is off unless enabled. With the existing `GATE_JOB_CARD`
enabled too, the drawer's Protocol tab uses the same resolved visit as its
Job Card. Unsetting either gate restores the existing protocol presentation.

The existing Job Card response carries the procedure; opening or downloading
the SOP performs no additional API call or write. The Job Card's existing
paragraph cache behavior is unchanged.

Non-lawn steps come from the selected service template in `protocols.json`,
including its conditional steps and program notes. Catalog identity and the
appointment's Eastern calendar date select the template through the existing
resolver. Legacy material-cost annotations and office price notes are omitted.
The sheet identifies this source as a service template; it does not certify
the template's application rates as reviewed label evidence.

Lawn steps come from the resolved plan's active structured protocol window:
its goal, required tasks, and operating sentence. The structured protocol's
grass track must match the plan's resolved track. A missing, draft, archived,
or mismatched procedure stays unavailable. Add-ons keep their own resolved
procedure; unsupported add-ons and inspections do not inherit a treatment
procedure from a similar display name.

The readable sheet preserves the selected visit, supports keyboard close and
focus return, and offers a secondary text download. Current weather verdicts,
verified mixing amounts, product precautions, and label/SDS links remain on
the Job Card. Existing plan blocks stay visible in the Protocol view.

This stage replaces the annual calendar within the gated Protocol tab. Score,
Truck, dispatch strips, property memory, application-rate review, and the
remaining tab consolidation are separate stages. The shared Ask/Photo bar
already exists and keeps its current behavior.
