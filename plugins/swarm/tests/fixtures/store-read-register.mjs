// --import entry for the store-read count (row 9): registers the load hook.
import { register } from "node:module";
register(new URL("./store-read-hook.mjs", import.meta.url).href);