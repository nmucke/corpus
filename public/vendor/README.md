# Bundled Markdown parser

`markdown-it-15.0.1.js` is the standalone ESM browser build from the
[`markdown-it` 15.0.1 npm package](https://www.npmjs.com/package/markdown-it/v/15.0.1),
copied from `dist/browser/markdown-it.esm.min.mjs` without code changes.
The original source-map reference is retained; the optional source map is not shipped.
Upstream: https://github.com/markdown-it/markdown-it (MIT; see markdown-it-LICENSE.txt).

Verified npm archive integrity:
`sha512-9/7gE95FNPkfUWrjJIoHZza2iLmuJlPD0UNMxPi7bxUrbCR525YZY0r+zyfes0dZI5ZZ/uNIXUJca0pJvtw41g==`

The application serves this asset locally; no CDN request or npm install is needed.
Configuration and trust boundaries live in `../markdown.js`. Keep HTML disabled,
remote images disabled, and explicit link validation when updating the parser.
