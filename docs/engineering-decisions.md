# Engineering Decisions

## Decision: Fail-fast environment variable validation

**Context:** The API depends on environment variables (database URL, port,
etc.) that could be missing or malformed, especially across different
environments (local dev, CI, production).

**Options considered:**
1. Read `process.env` directly wherever needed, trust it's correct.
2. Validate once at startup with a schema (Zod), fail immediately if
   invalid.

**Chosen approach:** Option 2 — a single `src/config/env.ts` module
validates all required environment variables at startup using Zod, and
exports a typed `env` object for the rest of the app to import.

**Why:** Option 1 defers failure to whenever the bad value is first used,
which could be mid-request, with a confusing error far from the actual
cause (e.g. `pg` throwing a cryptic connection error because
`DATABASE_URL` was `undefined`). Option 2 fails at process startup, with
a clear message naming exactly which variable is missing or invalid,
before the app ever accepts a request.

**Trade-offs:** Slightly more upfront code (one schema file) compared to
just reading `process.env.WHATEVER` inline. Considered negligible against
the debugging time saved.

**Consequences:** Every new environment variable the app needs must be
added to the Zod schema in `env.ts`, or it won't be available (TypeScript
will also correctly refuse to let us reference a property that isn't in
the schema, which is a feature, not friction).

## Decision: CommonJS over ESM for apps/api and apps/worker

**Context:** `tsc --init`'s modern defaults (`module: nodenext`,
`verbatimModuleSyntax: true`) assume the project is either explicitly
ESM or CommonJS, and error loudly if the `tsconfig.json` and
`package.json` disagree (see incidents-and-failures.md, Incident 1).

**Options considered:**
1. Convert to ESM (`"type": "module"` in package.json), requiring
   explicit `.js` extensions on relative imports and no `require()`
   anywhere.
2. Stay CommonJS (npm's default), align `tsconfig.json` to match.

**Chosen approach:** Option 2.

**Why:** This project's priority is a working, well-tested distributed
system — not showcasing ESM/CommonJS interop. CommonJS is still the
default and most common choice for Node/Express backends, has fewer
tooling surprises with commonly used libraries, and required no
package.json changes since it was already npm's default.

**Trade-offs:** Slightly "older-style" module system; some newer
ESM-only packages could theoretically require workarounds later. No
such conflict encountered so far.

**Consequences:** All future files in `apps/api` and `apps/worker` are
written and compiled as CommonJS. `packages/shared`, when introduced,
should follow the same convention for consistency.