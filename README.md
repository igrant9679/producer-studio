# Producer Studio reports

Writeups for the owner, kept apart from the app's code: this `reports` branch never deploys (Railway builds `main` only).

- **[Producer-Studio-weekly.docx](Producer-Studio-weekly.docx)**: what changed in Producer Studio over the last seven
  days, what is built but not live yet, and what is waiting on the owner. Updated as the owner asks for changes; the
  document's own history table says what changed and when.
- `weekly-writeup.cjs` makes the document: its content is the data at the top. Edit it, then run
  `node weekly-writeup.cjs Producer-Studio-weekly.docx` with the `docx` npm package on the module path.
