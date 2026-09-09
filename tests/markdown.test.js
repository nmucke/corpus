import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownHtml } from '../public/markdown.js';

test('draft Markdown formats headings, emphasis, nested lists, tables, quotes and code', () => {
  const rendered = markdownHtml('# Training plan\n\n**Strength** and *control* with `RIR 2`.\n\n1. Squat\n   - Three sets\n2. Press\n\n| Day | Work |\n| --- | --- |\n| Mon | Lower |\n\n> Rest as needed.\n\n```text\n3 x 5\n```');
  for (const expected of ['<h4>Training plan</h4>', '<strong>Strength</strong>', '<em>control</em>', '<code>RIR 2</code>', '<ol>', '<ul>', '<table>', '<th>Day</th>', '<blockquote>', '<pre><code class="language-text">3 x 5']) assert.ok(rendered.includes(expected), expected);
});

test('untrusted prose cannot inject HTML, execute URLs, or load remote images', () => {
  const rendered = markdownHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [data](data:text/html,test) [local](/api/session)\n\n![diagram](https://example.com/tracker.png)\n\n[Source](https://example.com/paper)');
  assert.doesNotMatch(rendered, /<script|<img|onerror="|href="(?:javascript|data|\/api)/i);
  assert.match(rendered, /&lt;script&gt;/);
  assert.match(rendered, /diagram/);
  assert.doesNotMatch(rendered, /tracker\.png/);
  assert.match(rendered, /href="https:\/\/example.com\/paper" target="_blank" rel="noopener noreferrer"/);
});

test('code stays literal and ordinary prose keeps its paragraph boundaries', () => {
  assert.equal(markdownHtml('First paragraph.\n\nSecond paragraph.'), '<p>First paragraph.</p>\n<p>Second paragraph.</p>\n');
  const rendered = markdownHtml('```html\n<img onerror="alert(1)">\n```');
  assert.match(rendered, /&lt;img onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(rendered, /<img/);
});
