import { z } from "zod";

// zod tries `new Function` once to see whether it may compile its parsers, and the page's policy
// reports every such try as a refused eval. It parses the same without it.
z.config({ jitless: true });
