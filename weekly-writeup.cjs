// Producer Studio weekly writeup → .docx. The content is the data below; edit it and run:
//   node weekly-writeup.cjs <output.docx>
// (needs the `docx` npm package on the module path)
const fs = require('fs')
const {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat, Packer, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType,
} = require('docx')

const UPDATED = '27 November 2026'
const PERIOD = '20 to 27 November 2026'

// ---------------------------------------------------------------- content

const AT_A_GLANCE = [
  ['20 Nov', 'Help gets a Music library tab', 'Live'],
  ['21 Nov', 'Media library: 20 AI songs, 10 AI-drawn animations, 10 full-motion clips', 'Live'],
  ['21 Nov', 'Watch a clip before adding it; Make it your own', 'Live'],
  ['22 Nov', 'In your brand (title, narrative text, logo over a clip); branded export covers', 'Live'],
  ['23 Nov', 'Producer uses the library by itself (songs, clips, brand stamp)', 'Live'],
  ['24 Nov', 'The composer plays in tune; swap a video’s music for a library song', 'Live'],
  ['24 Nov', 'Stock pictures checked by the AI before they are used', 'Live'],
  ['24–25 Nov', 'Flow-style clips: flowing scenes and long shots', 'Live'],
  ['25 Nov', 'Voice Studio on VoiceStudio 0.5.8', 'Live'],
  ['25 Nov', 'Desktop app 0.7.2, 0.7.3 and 0.7.4', 'Published'],
  ['26 Nov', 'Sign-up from meyousocial.com, memberships, sign-in links', 'Live; switched on 26 Nov'],
  ['26 Nov', 'Server AI members-only; a welcome step after in-app sign-up', 'Live'],
  ['26 Nov', 'Flowing joins cut cleanly; captions use the script’s words', 'Live'],
  ['27 Nov', 'OpenRouter as an AI provider', 'Built and tested; waits for your go-ahead'],
]

const SECTIONS = [
  {
    title: 'The media library (21–24 November)',
    intro: 'A shared library of ready-made music and clips that anyone can drop into a video, made once on the server and available in every space.',
    bullets: [
      ['What’s in it: ', '20 instrumental songs made with Google’s Lyria, 10 animations drawn by AI in ten drawing styles, and 10 eight-second full-motion clips from Gemini. An operator makes them once (Operator → Media library).'],
      ['Try before you add: ', 'Listen to a song or Watch a clip, with sound, before putting it on the timeline at the playhead.'],
      ['Make it your own: ', 'redraw an animation in your brand kit’s colours and fonts (only the render, no AI cost), or remake any item for your video’s topic on the space’s own keys.'],
      ['In your brand: ', 'a library clip goes on the timeline with an optional title, a line of narrative text and your logo stamp, in your brand’s fonts and colours. This replaced the animation redraw as the main way to brand a clip, after you found the redraw barely changed the animations.'],
      ['Better sound: ', 'library clips now play with a fitting library song instead of the video model’s own sound, which sounded out of tune.'],
      ['Copyright filter: ', 'if Google blocks a song for sounding like an existing piece, it is asked for once more as an original composition.'],
    ],
  },
  {
    title: 'Producer uses the library by itself (23 November)',
    bullets: [
      ['Music: ', 'a new video starts with the library song that suits the brief’s tone, or one you pick and hear in the brief. It is cut or looped to fit and set to the right loudness.'],
      ['Clips and brand: ', 'library clips can appear in scenes, and your logo stamp goes on the video when the brief asks for it.'],
      ['Brand kit: ', 'the brief now reads the open space’s brand kit, so the logo stamp and caption look are right for a brand-new video.'],
    ],
  },
  {
    title: 'Music',
    bullets: [
      ['In tune: ', 'the composer’s instruments no longer waver on held notes. The detuning and off-pitch overtones that made them sound out of tune are gone.'],
      ['Swap the music: ', '“Use as this video’s music” replaces a finished video’s music with any library song. The version before stays in Versions.'],
      ['Help: ', 'the editor’s Help (the ? key, and the Help buttons) has a Music library tab that explains where the tracks are and how to add them.'],
    ],
  },
  {
    title: 'Branded export covers (22 November)',
    bullets: [
      ['Export → Cover → Brand the cover: ', 'your title in the brand’s headline font and your logo over the cover frame. It becomes the export’s thumbnail.'],
    ],
  },
  {
    title: 'Stock pictures that fit (24 November)',
    bullets: [
      ['Checked before use: ', 'free stock photos and clips are now looked at by the space’s AI before they go in a scene. A scene that searched for “person stretching by window” no longer gets a water tower.'],
      ['Shown in the wizard: ', 'each scene says briefly what the AI passed over and why.'],
      ['Fewer empty searches: ', 'when a search finds nothing, shorter versions of it are tried.'],
    ],
  },
  {
    title: 'Flow-style clips (24–26 November)',
    intro: 'Two brief options under Full motion, both off by default, built on Gemini Omni.',
    bullets: [
      ['Flowing scenes: ', 'an AI clip that follows another starts on that clip’s frame, so the shots continue from one to the next.'],
      ['Long shots: ', 'a long scene’s clip is extended turn by turn, up to 30 seconds, instead of being slowed down or frozen.'],
      ['Fixed after your paper boat test (26 Nov): ', 'the half-second crossfade at flowing joins laid two nearly identical moving pictures on top of each other, which is the blur you saw. Flowing joins now cut straight to the next clip on the exact frame it starts from.'],
      ['Captions: ', 'captions now always use the script’s own words, timed to the voice. The paper boat film had captioned “a wide, calm pond” as “a wide compound”.'],
    ],
  },
  {
    title: 'Voice Studio on VoiceStudio 0.5.8 (25 November)',
    bullets: [
      ['Licences: ', 'accept a voice model’s licence in the app when the model needs it.'],
      ['Sound effects: ', 'made from a description on a computer with an NVIDIA graphics card, and from the website through a linked desktop.'],
      ['Voice changer: ', 'changes the voice of a recording while keeping its delivery.'],
      ['How it’s said: ', 'tell a line how to be delivered (its emotion).'],
    ],
  },
  {
    title: 'Desktop app releases (all published 25 November)',
    bullets: [
      ['0.7.2: ', 'in-tune music, your brand on videos, and stock pictures that fit.'],
      ['0.7.3: ', 'the media library in the desktop app, through its link to producerstudio.app. Items work offline once they have been fetched.'],
      ['0.7.4: ', 'Voice Studio on VoiceStudio 0.5.8.'],
    ],
  },
  {
    title: 'Sign-up and memberships (26 November)',
    bullets: [
      ['From the website: ', 'meyousocial.com can sign members up. A signed call makes the member’s Producer Studio space and account, keeps the membership’s plan, status and seats, and hands out a one-time sign-in link that lasts 15 minutes.'],
      ['From the app: ', 'a space made in the app can get a membership. Its owner goes to the website with a claim, and the membership lands on that space.'],
      ['Seats: ', 'a membership’s seats cap the space’s members plus pending invites. Your decision: 1 seat for Member, Contributor and Steward, and 2 for Founder (the owner plus one person).'],
      ['Welcome step: ', 'after signing up in the app, a new account chooses a plan (once memberships are on), adds its own AI key, or continues free.'],
      ['Members-only server AI: ', 'switching on the server’s AI now needs a membership. Operators are exempt, and spaces that already had it keep it.'],
      ['Switched on: ', 'you set the signing secret on Railway on 26 November, and a signed test call from here passed. The website session is building the WordPress side.'],
    ],
  },
  {
    title: 'OpenRouter as an AI provider (built 27 November, not live yet)',
    intro: 'Asked for in all four apps. Built and tested on its own branch; it goes live when you say so.',
    bullets: [
      ['Keys: ', 'a space’s own OpenRouter key is used first. Without one, a space that picks OpenRouter runs on the server’s shared key, as the server’s AI: members only, and you pay for it.'],
      ['Scope: ', 'all writing AI can run through OpenRouter: the writer, Producer scripts, the editor assistant and AI-drawn animation. Pictures, clips, music and voices keep their current providers.'],
      ['Models: ', 'Settings → AI lists OpenRouter’s current models with prices per million tokens, offering only models that can give structured answers. The default is the newest Claude Sonnet on the list (anthropic/claude-sonnet-5.5 today).'],
      ['Costs: ', 'the Usage page shows the dollars OpenRouter actually charged for each request, not an estimate. The monthly limits still apply.'],
      ['Operator → AI: ', 'chooses what spaces that picked nothing run on. It stays on Claude, and can switch to OpenRouter only once the shared key is set.'],
      ['Desktop: ', 'OpenRouter works there with the person’s own key only.'],
    ],
  },
  {
    title: 'Housekeeping',
    bullets: [
      ['Release workflow: ', 'the desktop release workflow uses current GitHub actions.'],
      ['Steadier tests: ', 'the voice engine tests retry when the machine is short of memory.'],
    ],
  },
]

const WAITING = [
  ['Say “deploy OpenRouter” in our chat. ', 'Then paste your OpenRouter key into Railway as OPENROUTER_API_KEY on the Producer Studio service. Switching the server’s AI to OpenRouter (Operator → AI) is a separate choice for later.'],
  ['Re-assemble the paper boat film and check the joins. ', 'Re-assembling reuses every clip, so Google makes no new ones. Then export it and tell me how the joins look, and whether I can delete the film.'],
  ['Test desktop 0.7.4. ', 'Install it, then click Voice Studio → Engine → Update. If anything fails, send me the Engine tab’s log and the exact message on screen.'],
  ['Answer the website session. ', 'Give it the go-ahead for the WordPress plugin, and decide: whether to add a pick-your-tools step for Member and Contributor; whether the 14-day free trials get the tools (trials run on the server’s AI at your cost); and whether you can edit wp-config.php.'],
  ['Decide when you’re ready: ', 'what each membership tier gets in Producer Studio (for example monthly AI clip seconds or storage), and an email service (Producer Studio sends no email today).'],
]

const WAITING_OTHER = [
  ['Velocity sign-up is built but switched off. ', 'Set MEMBERSHIP_API_SECRET (32 or more characters), SELF_SERVE_SIGNUP=trial and MEMBERSHIP_SITE_URL on Velocity’s Railway service. I can generate the secret into a local file that git ignores.'],
  ['Velocity: one gap to decide on. ', 'Should I build linking a Trial workspace made in the app to a later purchase on the website? Without it, buying creates a second workspace. Producer Studio already handles this.'],
]

const HISTORY = [
  ['27 Nov 2026', 'First version.'],
]

// ---------------------------------------------------------------- layout

const FONT = 'Arial'
const ACCENT = '1F4E79'
const CONTENT = 9360 // US Letter minus 1-inch margins, in DXA

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: 22, ...o })
const para = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [run(children)], spacing: { after: 120 }, ...o })
const bullet = ([lead, rest]) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 80 }, children: [run(lead, { bold: true }), run(rest)] })
const numbered = (ref) => ([lead, rest]) => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 100 }, children: [run(lead, { bold: true }), run(rest)] })
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text })] })
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text })] })

const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' }
const borders = { top: border, bottom: border, left: border, right: border }
function table(header, rows, widths) {
  const cell = (text, w, head) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      borders,
      shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'DCE6F1' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [run(text, { bold: !!head, size: 20 })] })],
    })
  return new Table({
    width: { size: CONTENT, type: WidthType.DXA },
    columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, widths[i], true)) }), ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, widths[i], false)) }))],
  })
}

const body = [
  new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Producer Studio: what changed this week' })] }),
  para([run(`${PERIOD} · last updated ${UPDATED}`, { color: '595959' })], { spacing: { after: 240 } }),
  para('This covers what was built and shipped in Producer Studio (producerstudio.app and the Windows desktop app) over the last seven days, what is built but not live yet, and what is waiting on you. It is kept up to date as you ask for changes.'),
  h1('At a glance'),
  table(['Date', 'Change', 'Status'], AT_A_GLANCE, [1300, 5560, 2500]),
  new Paragraph({ spacing: { after: 120 }, children: [] }),
]
for (const s of SECTIONS) {
  body.push(h1(s.title))
  if (s.intro) body.push(para(s.intro))
  for (const b of s.bullets) body.push(bullet(b))
}
body.push(h1('What I’m waiting on you for'))
body.push(h2('Producer Studio'))
for (const w of WAITING) body.push(numbered('waiting')(w))
body.push(h2('Other apps (from this week’s work)'))
for (const w of WAITING_OTHER) body.push(numbered('waitingOther')(w))
body.push(h1('Document history'))
body.push(table(['Date', 'Change'], HISTORY, [1800, 7560]))

const doc = new Document({
  creator: 'Claude',
  title: 'Producer Studio: what changed this week',
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: 'Title', name: 'Title', basedOn: 'Normal', run: { font: FONT, size: 40, bold: true, color: ACCENT }, paragraph: { spacing: { before: 0, after: 80 }, keepNext: true } },
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 28, bold: true, color: ACCENT }, paragraph: { spacing: { before: 300, after: 120 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 24, bold: true, color: '404040' }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      { reference: 'waiting', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] },
      { reference: 'waitingOther', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] },
    ],
  },
  sections: [
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('Producer Studio weekly writeup · page ', { size: 18, color: '808080' }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: '808080' })] })],
        }),
      },
      children: body,
    },
  ],
})

const out = process.argv[2] || 'Producer-Studio-weekly.docx'
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')
})
