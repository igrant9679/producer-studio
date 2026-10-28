// For the accessibility audit tests (R3-E): every control a person can reach has a name a screen reader can say.
// One pass finds the controls (Testing Library's getRoles, which leaves out hidden ones) and each is named with the
// computation Testing Library's own `name` option uses (dom-accessibility-api, which it depends on): labels,
// aria-label/labelledby, text, title. Two role queries per role over a whole editor took minutes.
import { getRoles } from '@testing-library/react'
import { computeAccessibleName } from 'dom-accessibility-api'

const ROLES = ['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'checkbox', 'switch', 'radio']

/** Controls under `root` with no accessible name, described so a failure says where they are. */
export function unnamedControls(root: HTMLElement = document.body): string[] {
  const byRole = getRoles(root)
  const out: string[] = []
  for (const role of ROLES) {
    for (const el of byRole[role] ?? []) {
      if (computeAccessibleName(el).trim()) continue
      const parent = el.parentElement
      out.push(`${role} <${el.tagName.toLowerCase()} class="${el.className}"> in ${parent?.className || parent?.tagName.toLowerCase()}`)
    }
  }
  return out
}
