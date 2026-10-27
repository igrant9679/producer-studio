import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './lib/fonts'
import './styles/theme.css'
// first: the dev mock API (when on) must be in place before the sign-in check below
import './shell/dev/installMock'
import { App, loadEditor } from './App'
import { initAppearance } from './lib/appearance'
import { ROUTER_FUTURE } from './lib/router'
import { useSession } from './lib/session'
import { preloadRoute } from './shell/ShellRoutes'

initAppearance()

// A deep link shouldn't wait in a chain (sign-in check, then the page's code): ask who's signed in and fetch the
// page's code at the same time, before React mounts. The app shell shows with placeholders meanwhile.
void useSession.getState().load()
const path = window.location.pathname
if (path.startsWith('/edit/')) void loadEditor().catch(() => undefined)
else preloadRoute(path)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter future={ROUTER_FUTURE}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
