// For the accessibility audit tests (R3-E): every control a person can reach has a name a screen reader can say.
// Names come from Testing Library's accessible-name computation (labels, aria-label/labelledby, text, title).
import { within } from '@testing-library/react'

const ROLES = ['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'checkbox', 'switch', 'radio'] as const

/** Controls under `root` with no accessible name, described so a failure says where they are. */
export function unnamedControls(root: HTMLElement = document.body): string[] {
  const out: string[] = []
  for (const role of ROLES) {
    const all = within(root).queryAllByRole(role)
    const named = new Set(within(root).queryAllByRole(role, { name: /\S/ }))
    for (const el of all) {
      if (named.has(el)) continue
      const where = el.parentElement?.className || el.parentElement?.tagName.toLowerCase()
      out.push(`${role} <${el.tagName.toLowerCase()} class="${el.className}"> in ${where}`)
    }
  }
  return out
}
