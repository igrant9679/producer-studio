// For the accessibility audit tests (R3-E): every control a person can reach has a name a screen reader can say.
// Names come from the same accessible-name computation Testing Library's role queries use (labels,
// aria-label/labelledby, text, title); one pass over the controls keeps it quick on big screens.
import { isInaccessible } from '@testing-library/react'
import { computeAccessibleName } from 'dom-accessibility-api'

const CONTROLS = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  ...['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'checkbox', 'switch', 'radio'].map((r) => `[role="${r}"]`),
].join(', ')

/** Controls under `root` with no accessible name, described so a failure says where they are. */
export function unnamedControls(root: HTMLElement = document.body): string[] {
  const out: string[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(CONTROLS))) {
    if (isInaccessible(el) || computeAccessibleName(el).trim()) continue
    const where = el.parentElement?.className || el.parentElement?.tagName.toLowerCase()
    out.push(`<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role="${el.getAttribute('role')}"` : ''} class="${el.className}"> in ${where}`)
  }
  return out
}
