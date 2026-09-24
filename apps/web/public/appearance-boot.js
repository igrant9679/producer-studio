// Sets the appearance attributes on <html> before first paint (no flash of the wrong theme).
// A static file rather than an inline script so it runs under the desktop CSP (script-src 'self').
// Mirrors resolve/apply in src/lib/appearance.ts, which takes over once the app loads.
;(function () {
  var root = document.documentElement
  var scale = { sm: 0.9, md: 1, lg: 1.125, xl: 1.25 }
  var pick = function (v, list, d) { return list.indexOf(v) >= 0 ? v : d }
  var p = {}
  var explicit = false
  try {
    var s = JSON.parse(localStorage.getItem('ps.appearance') || 'null')
    if (s && typeof s === 'object') {
      p = s.prefs || {}
      explicit = s.motionExplicit === true
    }
  } catch (e) { /* storage unavailable or corrupt: defaults */ }
  var mq = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches) }
  var pref = pick(p.theme, ['system', 'dark', 'light'], 'system')
  var theme = pref === 'system' ? (mq('(prefers-color-scheme: light)') ? 'light' : 'dark') : pref
  var reduce = p.reduceMotion === true || (!explicit && mq('(prefers-reduced-motion: reduce)'))
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-theme-pref', pref)
  root.setAttribute('data-accent', pick(p.accent, ['coral', 'violet', 'blue', 'teal', 'amber', 'pink'], 'coral'))
  root.setAttribute('data-density', pick(p.density, ['comfortable', 'compact'], 'comfortable'))
  root.setAttribute('data-reduce-motion', String(reduce))
  root.style.setProperty('--ui-scale', String(scale[pick(p.textSize, ['sm', 'md', 'lg', 'xl'], 'md')]))
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f5f8' : '#0c0e14')
})()
