import { configure } from '@testing-library/react'

// `vite.config.ts` raises vitest's own `testTimeout`, but that setting does not reach
// testing-library: `findBy*` and `waitFor` keep a separate budget, `asyncUtilTimeout`,
// which defaults to 1000 ms. One second is tight for a render-heavy page, so this
// raises it; `testTimeout` still catches a genuine hang at 20 s.
//
// The two runs that used to fail under load were real races, fixed on 2026-11-06: library-views' shift-click
// ("2 selected") read the range anchor inside a state updater React ran late (library/bulk.tsx, with a test in
// library-logic.test.ts), and templates' arrow keys counted from the last render, not the last key pressed
// (TemplatesPage.tsx). Wait for what a test needs (`findBy*`/`waitFor`), never for a fixed time.
configure({ asyncUtilTimeout: 5_000 })
