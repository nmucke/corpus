---
name: corpus-revise-proposal
description: Revise a saved Corpus training proposal in response to user or reviewer feedback.
---

Read the proposal summary, rationale pages, and each needed proposed routine/program entity page first. Preserve its id, use its current revision as `expectedRevision`, and supply fresh base hashes for every edited target. Explain how feedback changed the draft and any remaining assumptions, then submit the revised proposal for human review. Return the new proposal id and revision.

Only a `revision_requested` proposal can be revised. Use `corpus_get_proposal` with `kind: "routine"` or `"program"`, `index`, and pagination to reconstruct large draft entities; routine pages allow one exercise and paged sets, while `textOffset` and `textLimit` page long notes or descriptions. Do not revise `draft`, `accepted`, or `declined` proposals.
