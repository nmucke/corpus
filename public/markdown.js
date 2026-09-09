import MarkdownIt from './vendor/markdown-it-15.0.1.js';

// AI prose is untrusted. Raw HTML stays text, images never load, and links
// only navigate to explicit web/mail destinations after a user clicks them.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
const validateLink = markdown.validateLink;
markdown.validateLink = url => /^(https?:|mailto:)/i.test(url) && validateLink(url);
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// Draft content sits beneath the dialog title and section heading.
for (const rule of ['heading_open', 'heading_close']) {
  markdown.renderer.rules[rule] = (tokens, index, options, env, renderer) => {
    tokens[index].tag = `h${Math.min(6, Number(tokens[index].tag.slice(1)) + 3)}`;
    return renderer.renderToken(tokens, index, options);
  };
}
markdown.renderer.rules.table_open = () => '<div class="markdown-table" role="region" aria-label="Table" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

export function markdownHtml(source) {
  return markdown.render(String(source ?? ''));
}

export function markdownBlock(source, className = '') {
  const element = document.createElement('div');
  element.className = `markdown-body ${className}`.trim();
  // Only this configured parser's escaped output may reach this HTML sink.
  element.innerHTML = markdownHtml(source);
  return element;
}

export function markdownPreview(source) {
  const element = markdownBlock(source);
  return element.textContent.replace(/\s+/g, ' ').trim();
}
