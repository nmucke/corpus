# Corpus training assistant

The Corpus training assistant is for training analysis and reviewable planning.
It is deliberately separate from the repository's development-agent role. The
repository root `AGENTS.md` governs development; the training-only instructions
and skills are in `assistant/`. Restricted CLI sessions copy them into a
temporary workspace; desktop support packages matching copies as a local app
plugin. They are never placed in global agent-skill directories.

## Use a desktop app

ChatGPT Desktop and desktop-local Claude Cowork can use Corpus without launching
a separate CLI session. Keep the local Corpus server running:

```sh
npm start
```

Run the one-time setup command from this repository:

```sh
npm run assistant:setup
```

It does two local-only things:

1. Prints the Node executable, bridge path, working directory, and environment
   values to enter under **ChatGPT Desktop → Settings → MCP servers → Add
   server**. Choose STDIO, save, and restart ChatGPT. The desktop app and local
   Codex clients share this MCP configuration.
2. Packages `plugins/corpus-assistant/` as
   `data/assistant-apps/corpus-assistant-claude.zip`, with absolute paths for
   this checkout. Upload it from **Claude Desktop → Cowork → Customize →
   Plugins**, then restart Claude Desktop. Re-run setup and replace the plugin
   after moving the repository, changing Node installations, or changing
   `PORT` / `CORPUS_DATA_DIR`.

The app bridge is `server/mcp-local.js`. It obtains the existing bearer
credential from the selected local data directory and loads the training role
from `assistant/AGENTS.md`; the token is not written into the plugin or printed.
The Claude plugin also contains the four scoped workflows. ChatGPT receives the
same top-level behavior through MCP server instructions and can retrieve a
workflow with `corpus_workflow`.

After the one-time setup, only `npm start` is required. Try “Analyze my last
eight weeks of training in Corpus” or “Draft a three-day program for review in
Corpus” in a new desktop chat/task.

This integration is intentionally local-only:

- ChatGPT on the web or mobile does not read the desktop MCP configuration.
- Claude web/mobile and cloud Cowork cannot reach this loopback MCP server; use
  Cowork in Claude Desktop.
- Desktop app sessions are not isolated like the CLI launchers below. The app
  may retain other enabled tools, plugins, or Cowork folder access. Use a
  dedicated session and disable unrelated capabilities when narrow client-side
  scope matters. The Corpus server boundary still rejects every unregistered
  operation and cannot approve, publish, sync, change settings, or call Hevy.

## Use a restricted CLI session

Keep the local Corpus server running in one terminal:

```sh
npm start
```

In a second terminal, from this repository, launch one assistant:

```sh
npm run assistant:codex
# or
npm run assistant:claude
```

Use `npm run assistant:codex -- --check` or
`npm run assistant:claude -- --check` to verify the installed CLI and launch
configuration without starting an AI session. The launcher needs the same
`PORT` and `CORPUS_DATA_DIR` as the server when either has been customized.

Install the current native CLI using OpenAI's
[Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli) or Claude Code's
[quickstart](https://code.claude.com/docs/en/quickstart), then sign in yourself.
Run `codex login` and choose ChatGPT for Codex; start `claude` and follow its
first-run login for Claude Code. Codex's personal ChatGPT login uses subscription
access, while an API-key login is usage billed; the Corpus launcher requires the
ChatGPT path. See OpenAI's
[authentication guide](https://learn.chatgpt.com/docs/auth) and
[pricing guide](https://learn.chatgpt.com/docs/pricing). Claude Code can use a
Claude subscription or Console account; its
[authentication guide](https://code.claude.com/docs/en/authentication) describes
those choices.

Use VS Code's integrated terminal to run these same commands. Corpus does not
configure a Codex or Claude IDE extension.

The launcher preserves each CLI's normal personal login location and makes no
global configuration edits. It copies `assistant/` into an owner-only temporary
workspace, removes it after the session, and supplies a per-installation local
assistant bearer credential only to the MCP bridge.

- Codex is required to use ChatGPT authentication, its read-only sandbox, the
  Corpus MCP server, and no shell, browser, app, plugin, or other MCP tools.
- Claude Code is invoked with `Skill`, `AskUserQuestion`, a strict Corpus MCP
  configuration, and no browser or filesystem tool permissions.

These are restrictions of this launcher and its native CLI session. They are
not a claim of general operating-system isolation or a substitute for protecting
the computer and its accounts.

## What the assistant does

The shared `assistant/AGENTS.md` requires the assistant to begin with a short
data summary, make bounded queries, state rationale, assumptions, metadata, and
evidence, and ask when a material goal or constraint is missing. It must not
invent medical facts or prescriptions. It can submit or revise a proposal, then
returns its proposal id and revision for human review.

The four scoped skills are:

| Skill | Use |
| --- | --- |
| `corpus-analyze-training` | Analyze training history, routines, programs, or coverage without changing anything. |
| `corpus-design-routine` | Draft a reviewable new or changed routine. |
| `corpus-design-program` | Draft a reviewable multi-day program. |
| `corpus-revise-proposal` | Revise a proposal after feedback, using its next revision. |

If a native client did not load the copied skill instructions, it can request
one of those exact workflows with `corpus_workflow`. This is a fixed enum of
server-owned skill files, not a path-reading facility.

## Context and MCP contract

`server/mcp.js` is a newline-delimited JSON-RPC stdio MCP server. It supports
MCP lifecycle negotiation through `2025-11-25`, ignores
`notifications/initialized`, accepts at most 256 KB per input message, writes
protocol messages only to stdout, and uses a fixed loopback HTTP origin. It
advertises server-wide training instructions, human-readable tool titles,
read/write and destructive-operation hints, and structured JSON results for
desktop clients. It never calls an AI API. Its bearer POST has a timeout and
refuses redirects.

The bridge is only a client of this local endpoint:

```text
POST /api/assistant/tools/:toolName
Authorization: Bearer <local assistant credential>
Content-Type: application/json

{ "args": { ... } }
```

The server allows only the registered names below, validates unknown arguments,
and returns compact JSON. It never accepts a URL, file path, SQL statement, or
arbitrary service method. Responses target 12 KB; list and detail tools expose
offsets and explicit next-page markers. A large proposal falls back to a compact
index so the assistant can retrieve its relevant current routine or program
before revising.

| Tool | Data or effect |
| --- | --- |
| `corpus_summary`, `corpus_get_profile` | Compact mode, counts, profile, current-program summaries, and recent aggregate. |
| `corpus_search_exercises` | Bounded exercise-template metadata. |
| `corpus_list_routines`, `corpus_get_routine` | Routine summaries and paged exercises/sets with an entity hash. |
| `corpus_list_programs`, `corpus_get_program` | Program summaries and paged days with an entity hash. |
| `corpus_workout_summary` | Date-filtered volume and strength progress aggregates, never raw workout sets. |
| `corpus_muscle_coverage` | Coverage counts for one routine or program from template metadata. |
| `corpus_list_proposals`, `corpus_get_proposal` | Proposal summaries, rationale chunks, or paged proposed routine/program entities with revision and feedback. |
| `corpus_submit_proposal` | Save a draft or requested revision only. |
| `corpus_workflow` | Return one fixed training skill when the native instruction loader is unavailable. |

There are no tools for approvals, declines, publishing, settings, sync, Hevy
calls, code edits, direct SQL, or arbitrary reads. The response context omits
the Hevy API key, local assistant credential, private settings, and raw
workout archive.

## Proposal and publication lifecycle

1. The assistant retrieves a current target and uses its `baseHash` for every
   routine or program it changes. For a routine with more than one detail page,
   it retrieves all needed exercise and set pages; `notesTruncated` means it
   should omit that unchanged note to preserve the original. For a saved draft,
   proposal entity pages use `textOffset` and `textLimit` for long notes or
   descriptions, and `kind: "rationale"` pages long rationales.
2. `corpus_submit_proposal` writes a `draft` and returns only its id, revision,
   status, and title. A repeated request id is idempotent only for the same
   payload.
3. A person reviews the draft in Corpus. They can accept, decline, or request a
   revision. A requested revision must include the current `expectedRevision`.
   Conflicting revisions and stale target hashes are rejected.
4. Acceptance is local and atomic. It creates or updates local routine overlays
   and programs, and it does not call Hevy.
5. For a live accepted local routine, a person separately chooses publish in
   Corpus. The service checks its current imported target when relevant, claims
   a durable publication request, then performs one Hevy create or update. A
   newly published routine remaps affected local program days after success.
   Uncertain remote outcomes are not retried automatically.

The assistant cannot perform steps 3 or 5.

## Privacy and backup

Corpus itself does not invoke an AI model. When a user starts either native CLI,
the compact Corpus context returned by the MCP tool can be sent to that CLI's
provider under the user's account and provider terms. The launcher prints this
before the session starts.

The data directory contains the SQLite database, proposal records and rationale
files, settings, exports, and the local assistant credential. Stop Corpus and
copy the entire directory for backup. Treat every backup as sensitive because it
contains personal training data and credentials. Restore by replacing the data
directory or selecting it with `CORPUS_DATA_DIR`.
