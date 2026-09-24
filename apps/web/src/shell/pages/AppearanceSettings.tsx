// Settings → Appearance: theme cards, text size, accent, density, reduce motion. Changes apply instantly
// (lib/appearance.ts) and are saved to the account in the background.
import { ACCENT_PRESETS, DEFAULT_PREFERENCES, type AccentPreset, type Density, type TextSize, type ThemePreference } from '@producer/core'
import clsx from 'clsx'
import { Check, Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAppearance } from '../../lib/appearance'

const THEMES: Array<{ id: ThemePreference; label: string; icon: ReactNode; hint: string }> = [
  { id: 'system', label: 'System', icon: <Monitor size={14} />, hint: 'Match your device' },
  { id: 'dark', label: 'Dark', icon: <Moon size={14} />, hint: 'Easy on the eyes' },
  { id: 'light', label: 'Light', icon: <Sun size={14} />, hint: 'Bright rooms' },
]
const SIZES: Array<{ id: TextSize; label: string }> = [
  { id: 'sm', label: 'Small' },
  { id: 'md', label: 'Default' },
  { id: 'lg', label: 'Large' },
  { id: 'xl', label: 'Extra large' },
]
const ACCENT_LABEL: Record<AccentPreset, string> = { coral: 'Coral', violet: 'Violet', blue: 'Blue', teal: 'Teal', amber: 'Amber', pink: 'Pink' }
const DENSITY: Array<{ id: Density; label: string }> = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
]

/** A tiny drawing of the app in one theme ('system' shows dark and light split diagonally). */
function ThemeMini({ theme }: { theme: ThemePreference }) {
  if (theme === 'system')
    return (
      <span className="ps-theme-mini split" aria-hidden>
        <span className="half dark"><MiniUi /></span>
        <span className="half light"><MiniUi /></span>
      </span>
    )
  return (
    <span className={clsx('ps-theme-mini', theme)} aria-hidden>
      <MiniUi />
    </span>
  )
}

function MiniUi() {
  return (
    <span className="ps-mini-ui">
      <span className="nav"><i /><i /><i /></span>
      <span className="main">
        <span className="bar" />
        <span className="cards"><i /><i /><i /></span>
        <span className="cta" />
      </span>
    </span>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={clsx('ps-toggle', on && 'on')} onClick={() => onChange(!on)}>
      <i />
    </button>
  )
}

export function AppearanceSettings() {
  const prefs = useAppearance((s) => s.prefs)
  const system = useAppearance((s) => s.system)
  const systemReduced = useAppearance((s) => s.systemReduced)
  const motionExplicit = useAppearance((s) => s.motionExplicit)
  const update = useAppearance((s) => s.update)
  const reset = useAppearance((s) => s.reset)
  const isDefault = (Object.keys(DEFAULT_PREFERENCES) as Array<keyof typeof DEFAULT_PREFERENCES>).every((k) => prefs[k] === DEFAULT_PREFERENCES[k])
  const motionOn = prefs.reduceMotion || (!motionExplicit && systemReduced)

  return (
    <div className="ps-appearance">
      <div className="ps-ap-block">
        <div className="ps-ap-label" id="ap-theme">Theme</div>
        <div className="ps-theme-cards" role="radiogroup" aria-labelledby="ap-theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={prefs.theme === t.id} aria-label={`${t.label} theme: ${t.id === 'system' ? `match your device (now ${system})` : t.hint.toLowerCase()}`} className={clsx('ps-theme-card', prefs.theme === t.id && 'on')} onClick={() => update({ theme: t.id })}>
              <ThemeMini theme={t.id} />
              <span className="ps-theme-meta">
                <strong>{t.icon} {t.label}</strong>
                <span>{t.id === 'system' ? `${t.hint} · now ${system}` : t.hint}</span>
              </span>
              {prefs.theme === t.id && <span className="ps-theme-check"><Check size={12} strokeWidth={3} /></span>}
            </button>
          ))}
        </div>
      </div>

      <div className="ps-set-row">
        <div>
          <strong id="ap-size">Text size</strong>
          <span>Scales text across the app. The editor’s timeline and canvas keep their geometry.</span>
        </div>
        <div className="ps-seg" role="group" aria-labelledby="ap-size">
          {SIZES.map((s) => (
            <button key={s.id} type="button" aria-pressed={prefs.textSize === s.id} className={prefs.textSize === s.id ? 'on' : ''} onClick={() => update({ textSize: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <p className="ps-ap-sample" data-testid="text-sample">
        The quick brown fox jumps over the lazy dog. <span className="muted">Captions, labels and menus use this size.</span>
      </p>

      <div className="ps-set-row">
        <div>
          <strong id="ap-accent">Accent colour</strong>
          <span>Buttons, selections and highlights. {ACCENT_LABEL[prefs.accent]} is selected.</span>
        </div>
        <div className="ps-accents" role="radiogroup" aria-labelledby="ap-accent">
          {ACCENT_PRESETS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={prefs.accent === a}
              aria-label={ACCENT_LABEL[a]}
              title={ACCENT_LABEL[a]}
              className={clsx('ps-accent-sw', `sw-${a}`, prefs.accent === a && 'on')}
              onClick={() => update({ accent: a })}
            >
              {prefs.accent === a && <Check size={14} strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>

      <div className="ps-set-row">
        <div>
          <strong id="ap-density">Density</strong>
          <span>Compact fits more on screen: shorter controls, rows and timeline tracks.</span>
        </div>
        <div className="ps-seg" role="group" aria-labelledby="ap-density">
          {DENSITY.map((d) => (
            <button key={d.id} type="button" aria-pressed={prefs.density === d.id} className={prefs.density === d.id ? 'on' : ''} onClick={() => update({ density: d.id })}>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ps-set-row">
        <div>
          <strong>Reduce motion</strong>
          <span>
            Turns off animated transitions and effects previews. Video playback and progress bars are unaffected.
            {systemReduced && !motionExplicit ? ' Your system asks for reduced motion, so it’s on.' : ''}
          </span>
        </div>
        <Toggle label="Reduce motion" on={motionOn} onChange={(v) => update({ reduceMotion: v })} />
      </div>

      <div className="ps-set-row">
        <div>
          <strong>Reset appearance</strong>
          <span>System theme, default text size, coral accent, comfortable density.</span>
        </div>
        <button type="button" className="btn sm" onClick={reset} disabled={isDefault && !motionExplicit}>
          <RotateCcw size={13} /> Reset to defaults
        </button>
      </div>
    </div>
  )
}

/** Compact System / Dark / Light switcher for menus (avatar menu, editor). */
export function ThemeSwitcher({ className }: { className?: string }) {
  const theme = useAppearance((s) => s.prefs.theme)
  const update = useAppearance((s) => s.update)
  return (
    <div className={clsx('ps-seg ps-theme-switch', className)} role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} aria-label={`${t.label} theme`} title={`${t.label} theme (Ctrl+Shift+L cycles)`} className={theme === t.id ? 'on' : ''} onClick={() => update({ theme: t.id })}>
          {t.icon}
        </button>
      ))}
    </div>
  )
}
