import { configure } from '@testing-library/react'

// `vite.config.ts` raises vitest's own `testTimeout`, but that setting does not reach
// testing-library: `findBy*` and `waitFor` keep a separate budget, `asyncUtilTimeout`,
// which defaults to 1000 ms. One second is tight for a render-heavy page, so this
// raises it; `testTimeout` still catches a genuine hang at 20 s.
//
// ⚠ This is NOT a cure for the flaky runs. Measured on 2026-10-30:
// `shell/__tests__/templates.test.tsx` (arrow keys) and `shell/__tests__/library-views.test.tsx`
// (shift-click range) fail whenever files run in PARALLEL on a loaded machine and pass
// with `--no-file-parallelism`. library-views fails a *synchronous* assertion
// ("2 selected" where it wants "3 selected"), which no timeout can affect — the
// assertions race the re-render. The durable fixes are to await those assertions
// (`findBy*`/`waitFor` instead of a bare `expect` after `fireEvent`), and to cap
// workers (`--maxWorkers=2`) when a run has to be trustworthy.
configure({ asyncUtilTimeout: 5_000 })
