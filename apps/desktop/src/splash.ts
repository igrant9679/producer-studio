// The splash page as a data: URL. Packaged builds keep splash.html inside app.asar, and with the
// grantFileProtocolExtraPrivileges fuse off (D-12) a file:// load of a path inside the asar fails with ERR_FILE_NOT_FOUND
// (found in the first real packaged build), so the main process reads the page (its fs reads the asar) and hands it over
// whole. The page is self-contained (inline styles and mark, CSP default-src 'none'), so nothing else needs loading.
// No Electron here, so it can be tested on its own.

/** Said on the splash when the engine is slow to start. */
export const SLOW_NOTE = 'Still starting. The first start after installing can take a few minutes while Windows checks the new files.'

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The splash as a data: URL, with `note` in place of its status line when given. */
export function splashUrl(html: string, note?: string): string {
  const page = note ? html.replace(/<p>[^<]*<\/p>/, `<p>${escape(note)}</p>`) : html
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`
}
