// dom-accessibility-api (installed with @testing-library/dom) ships types its package "exports" doesn't point to;
// the one function the audit tests use.
declare module 'dom-accessibility-api' {
  export function computeAccessibleName(el: Element): string
}
