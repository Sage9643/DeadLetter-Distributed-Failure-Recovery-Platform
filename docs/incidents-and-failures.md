# Incidents & Failures

## Incident 1 — TypeScript compile failure: verbatimModuleSyntax vs CommonJS

**Date:** 2026-09-08

**Expected behavior:** `npm run dev` compiles `src/config/env.ts` and
`src/index.ts` and runs them.

**Actual behavior:** TypeScript compilation failed with TS1295 and TS1287,
refusing to compile `import`/`export` syntax.

**How it was reproduced:** Ran `npm run dev` immediately after creating
`src/config/env.ts` with standard ES `import`/`export` syntax.

**Root cause:** `tsc --init`'s generated `tsconfig.json` set
`"module": "nodenext"` and `"verbatimModuleSyntax": true`. `nodenext`
makes TypeScript infer each file's module format from `package.json`'s
`"type"` field, which was `"commonjs"` (npm's default, never changed).
`verbatimModuleSyntax` requires import/export syntax to be emitted
unchanged, which is impossible for a file being compiled as CommonJS,
since CommonJS uses `require()`/`module.exports`, not `import`/`export`.
The two settings were contradictory for our actual project type.

**Fix:** Changed `tsconfig.json`: `"module"` set to `"commonjs"`,
`"verbatimModuleSyntax"` set to `false`, and added
`"esModuleInterop": true` to allow default-style imports from CommonJS
packages (e.g. `import express from "express"`).

**Verification:** `npm run dev` compiled and ran successfully afterward,
printing expected environment values.

**Engineering lesson:** `tsc --init`'s defaults assume an ESM project by
default in recent TypeScript versions. A CommonJS project (the npm
default, and what we're using) needs `module` and `verbatimModuleSyntax`
explicitly aligned with that choice — the generated config is not
plug-and-play for every project type, and the error messages, while
initially alarming, directly named the fix.