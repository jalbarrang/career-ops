// Markdown → HTML for the ported views. The Next app used `react-markdown` +
// `remark-gfm`; this is `marked`, configured ONCE here so every call site (the
// assistant console, the report body, inline table cells) renders identically.
//
// Sanitisation posture is the source's, not `marked`'s default. react-markdown
// does NOT render raw HTML — it escapes it — while marked passes any HTML in
// the source straight through. Reports and model replies are untrusted input,
// so two renderers below restore the source behaviour:
//   • `html`   — a raw HTML token renders as literal text instead of markup.
//   • `link`   — a URL whose scheme react-markdown's `defaultUrlTransform`
//                would have dropped (`javascript:` and friends) keeps its text
//                but loses its href, which is what react-markdown produced.
import { Marked, type Tokens } from "marked";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Escape the way react-markdown's text output does (&, <, >). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPES[c]);
}

/** Schemes react-markdown's defaultUrlTransform lets through. A URL with no
 *  scheme (relative, in-page) is always allowed. */
const SAFE_SCHEMES = new Set(["http", "https", "irc", "ircs", "mailto", "xmpp"]);

function isSafeHref(href: string): boolean {
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  return !scheme || SAFE_SCHEMES.has(scheme.toLowerCase());
}

// `gfm` is what remark-gfm added: pipe tables, task lists, autolinks, ~~del~~.
const md = new Marked({ gfm: true });

md.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link({ href, title, text, tokens, autolink }: Tokens.Link): string {
      const label = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
      if (!isSafeHref(href)) return `<a>${label}</a>`;
      const url = escapeHtml(encodeURI(href));
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${url}"${titleAttr}>${label}</a>`;
    },
  },
});

/** Block-level markdown → HTML. */
export function renderMarkdown(source: string): string {
  return md.parse(String(source ?? ""), { async: false });
}

/** Inline markdown (a table cell, a bolded label) → HTML, no wrapping `<p>`. */
export function renderInline(source: string): string {
  return md.parseInline(String(source ?? ""), { async: false });
}
