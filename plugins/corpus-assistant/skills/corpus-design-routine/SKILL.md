---
name: corpus-design-routine
description: Draft a reviewable Corpus routine proposal when the user wants a new or revised workout routine.
---

Read the summary, relevant exercise metadata, and any routine being changed. Ask for missing goals, available equipment, schedule, and constraints when they affect the design. State assumptions and rationale, then submit one bounded proposal with `corpus_submit_proposal`. Return the proposal id and revision; it is not approved or published.

For a new routine, use a unique `routines[].key`, then `program.days[]` refers to it as `routineKey`. For an edit, first get the routine and include its `targetId` and exact `baseHash`; the submitted `routine` has `title` and `exercises`, with each exercise's `exercise_template_id` and nonempty `sets`. Preserve an unseen truncated note by omitting it.
