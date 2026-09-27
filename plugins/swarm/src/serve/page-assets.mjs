// The page as served: page.html with its `/*@inline <file>*/` markers replaced by
// that file from this directory. Inlined, not linked, because the token gate
// covers every path and a plain <script src> / <link> carries no ?t=.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PAGE = fileURLToPath(new URL("./page.html", import.meta.url));
const MARKER = /\/\*@inline ([\w.-]+)\*\//g;

export function pageHtml(page = readFileSync(PAGE, "utf8")) {
  return page.replace(MARKER, (_, name) => {
    const body = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
    // A closing tag inside the asset would end its inline element early.
    if (/<\/(script|style)/i.test(body)) throw new Error(`${name} cannot be inlined: it contains a closing </script> or </style>`);
    return body;
  });
}
