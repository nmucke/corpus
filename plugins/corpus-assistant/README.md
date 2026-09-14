# Corpus Assistant plugin

This local plugin packages Corpus's training-only workflows for ChatGPT and
Claude Desktop. Its Claude manifest starts the repository's `server/mcp-local.js`
bridge; the checked-in manifest uses installation-time path settings, while
`npm run assistant:setup` creates a machine-local zip with concrete paths under
ignored `data/assistant-apps/`.

The plugin does not contain a Corpus credential or training data. Keep Corpus
running separately with `npm start` and review every saved proposal in the
Corpus browser interface.
