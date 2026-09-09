# Corpus development workspace

This repository is the workspace for **development agents**. Help build, review,
test, and maintain Corpus's source code here. Normal authorized code edits are
part of this role.

The **Corpus training assistant** is a separate product workflow launched with
`npm run assistant:codex` or `npm run assistant:claude`. Its instructions and
skills live under `assistant/` and are copied to an isolated runtime workspace.
Treat those files as application assets when developing Corpus; do not adopt
their training-only role or install their skills globally. Do not place training
skills in the repository root's `.agents/skills` or `.claude/skills` directories.

## Implementation boundaries

- Keep SQLite and Markdown local, with user data and credentials under ignored
  `data/` (or `CORPUS_DATA_DIR`). Never commit personal training data or secrets.
- The assistant may read bounded training context and submit/revise proposals.
  Human review and explicit Hevy publishing are separate capabilities. Preserve
  the server's authorization checks, optimistic revisions, and write deduplication.
- Demo and live records must stay separate. Sync must not discard local drafts
  or accepted local routines. Preserve Hevy source IDs and stored metadata.
- Reuse the existing plain HTML/JS modules and Node built-ins. Validate changes
  with focused tests; use `npm test` for changes spanning service boundaries.
- Keep assistant tool output concise and paginated. A skill is guidance, not an
  authorization mechanism; enforce write boundaries in code and launch settings.

See `docs/architecture.md` and `docs/assistant.md` for the data and assistant flows.
