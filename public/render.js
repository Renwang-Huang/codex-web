import { marked } from "./vendor/marked.js";
import DOMPurify from "./vendor/purify.js";
import hljs from "./vendor/highlight.js";

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const language = (lang || "").split(/\s+/)[0];
  const safe = text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
  const code = hljs.getLanguage(language)
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : safe;
  return `<pre><code>${code}</code></pre>`;
};
// Raw HTML and remote images have no role in a local session transcript.
renderer.html = ({ text }) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
renderer.image = ({ text }) =>
  text.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
const cache = new Map();
export function markdown(text) {
  if (cache.has(text)) return cache.get(text);
  const html = DOMPurify.sanitize(marked.parse(text, { renderer, gfm: true }), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "del",
      "blockquote",
      "ul",
      "ol",
      "li",
      "pre",
      "code",
      "span",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    ALLOWED_ATTR: ["href", "title", "class", "start"],
    ALLOW_DATA_ATTR: false,
  });
  if (cache.size >= 60) cache.delete(cache.keys().next().value);
  cache.set(text, html);
  return html;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text);
  // Trusted LAN HTTP has no async Clipboard API.
  const area = document.createElement("textarea");
  area.value = text;
  area.className = "clipboard-fallback";
  const focus = document.activeElement;
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  focus?.focus({ preventScroll: true });
  if (!copied) throw new Error("浏览器未允许复制，请手动选择文字");
}
