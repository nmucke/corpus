---
name: corpus-design-program
description: Draft a reviewable Corpus multi-day training program proposal using existing or proposed routines.
---

Use Corpus summaries and bounded routine/program detail to ground the program. Clarify the goal, days available, duration, equipment, and constraints when missing. Include schedule rationale and assumptions, use routine keys for routines proposed in the same draft, and submit for review. Return the proposal id and revision only after it is saved.

A valid new program has `{ key, program: { title, description, start_date, duration_weeks, days } }`. Every day has `label` and exactly one of `routineId` or a same-draft `routineKey`; dates and duration are both null or a real `YYYY-MM-DD` plus 1–52 weeks.
