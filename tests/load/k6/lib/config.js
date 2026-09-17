// No default value, deliberately. Every run must explicitly set
// K6_BASE_URL -- there is no "safe-looking" default that could
// accidentally point at a real deployed environment later. See
// docs/load-testing.md.
export const BASE_URL = __ENV.K6_BASE_URL;

if (!BASE_URL) {
  throw new Error(
    "K6_BASE_URL environment variable is required. Refusing to run without an explicit target (e.g. K6_BASE_URL=http://localhost:3000)."
  );
}