import { readFileSync, writeFileSync } from "node:fs";
import { syntaxDocs } from "../src/core/query.ts";

/** Writes the tables of docs/search.md again from the filters' table, which a test holds it to. */
const path = new URL("../docs/search.md", import.meta.url);
const written = readFileSync(path, "utf8");
const marks = /(<!-- syntax -->\n)[\s\S]*?(<!-- \/syntax -->)/;
if (!marks.test(written)) throw new Error("docs/search.md has no <!-- syntax --> ... <!-- /syntax --> to write the tables between");
writeFileSync(path, written.replace(marks, (_, open: string, close: string) => `${open}${syntaxDocs()}\n${close}`));
