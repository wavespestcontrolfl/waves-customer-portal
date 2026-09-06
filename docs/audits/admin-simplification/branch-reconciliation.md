# Reconciliation with the earlier workspace proposal

The cleanup branch is the review candidate for the conservative audit changes.
The separate unpublished `feat/admin-workspace-consolidation` proposal at
`74c13a0f5326687e270e35c396e21cd1f16f6c9e` was inspected read-only. Its worktree
and branch remain intact. No commits from that proposal were imported.

| Overlap | Review candidate | Disposition of earlier proposal |
| --- | --- | --- |
| Navigation and shell | Regroup existing links, retain daily Schedule access and leaf roles; prevent restricted child mounting before redirect | Do not import the broad workspace switcher or its parallel metadata |
| Settings Team | Preserve current-account fields in General, including when health fails | Do not redirect a self-profile bookmark to employee administration |
| Tool Health | Keep operational alerts and runtime details; link to the canonical credential catalog | Do not retire the operational destination into Settings |
| Communications | Clarify labels, retain every existing tab and permission | Do not remove template editors, change Events permissions, or combine distinct queues |
| Email | Retain the original inbox in this cleanup | Subsequent work must establish draft recovery before embedding the inbox |
| Finance and Pricing | Keep existing capabilities, routes and editors | No broad financial workspaces, AR relocation or operating-cost editor retirement without parity evidence |
| Customer AI | Keep outreach approvals and upsell states | A label change does not authorize deleting the specialist workflow |
| Legacy aliases | Preserve query multiplicity and fragments with the existing redirect helper | Do not replace detailed bookmarks with generic workspace targets |

This is an alternative to merging the older proposal wholesale. Future work
should start from this reviewed cleanup and port only individually verified
changes. Do not merge both branches: the older proposal would reintroduce the
same unresolved permission, draft, history and workflow questions recorded in
[the parity ledger](parity-and-routes.md).

Before PR creation, `origin/main` was refreshed to
`f9d267fb9407dbefcf956b8aba91d1d906e545e6`. Git's merge-tree check reported no
conflicts with cleanup HEAD `a28039bf0cb54d9dfd1b2120c6f9c42197ea2e13`.
This checks integration conflicts, not deployed state. Local verification in
[verification.md](verification.md) applies to the cleanup source; PR CI checks
its merge result with current main. No production operations were performed.
