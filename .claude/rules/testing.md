# Testing

Rules for when tests accompany development work and how to react when tests fail.

## Every development ends with tests

- Any change that touches testable logic is not done until the new/changed behavior is
  covered in the package's existing Vitest suite.
- Match the repo's coverage pattern (see "Testing" in CLAUDE.md): pure logic in
  `packages/*`, desktop driver loops (via injected deps), pure stores, and the pure
  modules in `apps/web/src/lib` get tests. Electron shell wiring (`main.ts`, `auth/`,
  IPC registration) is exempt — don't build mock scaffolding around Electron APIs just
  to claim coverage.
- Compile-time-only changes (types, contracts enforced by `tsc` on every build) need no
  runtime tests — the build is the test.
- In the `/plan-issue` flow tests are written after the user confirms manual
  verification (skill step 11). For work outside that flow the rule applies all the
  same: finish the change, then add the tests before reporting the work as complete.

## When tests fail

Never make a failing test pass without first establishing **why** it fails. Triage into
one of three cases and act accordingly:

1. **Regression** — the change broke intended behavior. Fix the code; the test stays
   as it is.
2. **Intentional behavior change** — the test asserts the old behavior that the change
   deliberately replaced. Update the test to the new contract and call this out
   explicitly in the report/PR (which tests changed and why).
3. **Pre-existing or environmental** — the failure also happens on `develop`, or comes
   from the environment (stale `dist`, Node version quirks). Verify against `develop`
   before blaming the branch; flag it, don't silently fix out-of-scope failures — open
   or mention a separate issue instead.

Reports of test runs must state the outcome faithfully: if something fails, say which
case above it is — never report green by weakening assertions.
