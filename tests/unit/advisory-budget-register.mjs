import { register } from "node:module";

register(new URL("./advisory-budget-resolve.mjs", import.meta.url).href, import.meta.url);
