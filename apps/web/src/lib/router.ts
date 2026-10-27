// React Router v7 behaviour, opted into now so v6 stops warning about it on every page.
// Every route path and link in the app is absolute, so relative-splat resolution changes nothing here.
export const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const
