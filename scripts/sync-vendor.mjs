import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
await mkdir(new URL("public/vendor/", root), { recursive: true });
for (const [source, dest] of [
  ["marked/lib/marked.esm.js", "marked.js"],
  ["marked/LICENSE", "marked.LICENSE"],
  ["dompurify/dist/purify.es.mjs", "purify.js"],
  ["dompurify/LICENSE", "purify.LICENSE"],
  ["@highlightjs/cdn-assets/es/highlight.min.js", "highlight.js"],
  ["@highlightjs/cdn-assets/LICENSE", "highlight.LICENSE"],
])
  await copyFile(
    fileURLToPath(new URL("node_modules/" + source, root)),
    new URL("public/vendor/" + dest, root),
  );
