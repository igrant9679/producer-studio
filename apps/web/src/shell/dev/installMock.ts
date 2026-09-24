// Installs the dev mock API before the app's first request when localStorage.psMock === '1'.
// Imported for its side effect by AuthPage, ShellRoutes and SharePage (App imports those statically, so this
// runs before App's session load). `import.meta.env.DEV` is false in production builds, so the whole branch
// and the mock module are dropped from the bundle.
import { installMockApi } from './mockApi'

export const MOCK_ACTIVE: boolean = (() => {
  if (!import.meta.env.DEV || typeof window === 'undefined' || import.meta.env.MODE === 'test') return false
  try {
    const flag = new URLSearchParams(window.location.search).get('psmock')
    if (flag === '1') localStorage.setItem('psMock', '1')
    if (flag === '0') localStorage.removeItem('psMock')
    const mode = new URLSearchParams(window.location.search).get('psmockmode')
    if (mode === 'desktop' || mode === 'cloud') localStorage.setItem('psMockMode', mode)
    if (localStorage.getItem('psMock') === '1') {
      installMockApi()
      return true
    }
  } catch {
    /* storage unavailable */
  }
  return false
})()
