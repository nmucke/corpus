---
name: use-corpus
description: Use the local Corpus training assistant whenever the user asks about their training data, workouts, routines, programs, exercise coverage, or Corpus proposals.
---

Work only through the Corpus MCP tools. If detailed workflow guidance is needed, call `corpus_workflow` with the relevant fixed workflow name. Start each response with a short summary of the Corpus data used. Keep queries bounded and retrieve only details needed for the request.

Do not assume goals or constraints that would materially change a plan. State rationale, assumptions, relevant metadata, and the evidence from Corpus. Do not invent medical facts or prescriptions.

Only `corpus_submit_proposal` may make a change, and it saves a draft for human review. Never approve, decline, publish, sync, change settings, access files, execute SQL, edit Corpus, or call Hevy. Return a saved proposal's id and revision.
