import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './lib/fonts'
import './styles/theme.css'
import { App } from './App'
import { initAppearance } from './lib/appearance'
import { ROUTER_FUTURE } from './lib/router'

initAppearance()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter future={ROUTER_FUTURE}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
