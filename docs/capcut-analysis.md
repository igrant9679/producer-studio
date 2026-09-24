# CapCut (web) — functional analysis

Captured 23 Sept 2026 from capcut.com in a signed-in Edge session (test draft `202609232244`).
This is a record of *functionality and interaction patterns*. Producer Studio implements the
same capabilities with its own visual identity — no CapCut branding, assets or copy.

## 1. App shell (outside the editor)

| Area | What it does |
|---|---|
| Left nav | Create new · Home · *Create with AI*: Design Studio, Video Studio (AI agent), Video Editor, Voice Studio, All tools · *Templates & projects*: Templates, Library, Share and schedule · *Spaces* (team workspaces, invite members, create space) |
| Top bar | Credit balance + Renew, Free credits, desktop-app link, notifications, help, avatar |
| Home | Prompt box ("Create with …") with Video/Design toggle, `+` attach, model picker (Auto), agent mode (Standard / Director) · Popular features carousel · Inspiration gallery with category chips |
| Video Editor home | Big "Create new" · Start with AI: AI captions, Transcript-based editing, Text templates, Transitions · Recent projects |
| All tools | Trending / Create with AI / For videos / For audio: Text to speech, Voice changer, Batch edit, Video Studio, Remove background, Resize video, Video stabilization, Super slow motion |
| Video Studio | "Direct your videos, all in one canvas" — prompt → generated video (Seedance model), agent modes, showroom |
| Voice Studio | See §1a |
| Templates | See §1b |
| Design Studio | See §1c |
| Library | See §1d |
| Share and schedule | See §1e |

### 1a. Voice Studio
- Landing: two tool cards (Text to speech, Voice changer), search voice, **My voices** ("Record 5 seconds of your voice to create a lifelike, custom voice" → Create), **Library** of voices with chips: All, Trending, TikTok, Female, Male, Character, Narration, Memesong, and ~15 languages (English, Japanese, Korean, Chinese, Russian, Vietnamese, Thai, Indonesian, Portuguese, Arabic, Spanish…) + Filter.
- **Text to speech** workspace (tabs TTS / Voice changer, History button):
  - Large text editor — "Press `/` to use AI writer or enter your text"; starter examples (Podcast, Story, News, Advertisement).
  - Right column "Select a voice": My voices (+ Create new), Library (356) with All/Trending/TikTok/Female/Male + filter; each voice = avatar, name, language/style; Generate button.
- **Voice changer**: drop an audio/video file (≤50 MB, ≤15 min), Select file ▾ or Start recording; target voices library (72) All / Voice characters; Generate (Pro).

### 1b. Templates
- Hero with type picker (Video ▾ / Image) + search; tabs **Video / Image**.
- Category chips: For You, New Year, Hot, Business, Editor's Picks, Logo reveal, Gaming, Intro, Daily VLOG, Business 16:9, Collage, Travel VLOG, YouTube Outro, Student, Sports & Fitness …
- Masonry grid: preview (autoplay on hover), duration, use count, title/author.
- Template detail modal: player, author, **clip count, duration, uses, text count, original aspect ratio**, **Use this template** (opens editor with replaceable placeholder clips/texts), related templates, prev/next arrows.

### 1c. Design Studio (AI image design agent)
- "Imagine it. Design it." prompt box: text + upload images (`+`), **Model** picker (Auto toggle; GPT Image 2, Nano Banana 2, Nano Banana Pro, Seedream 5.0 Pro, Seedream 5.0 with speed hints), **Skills** menu: Video cover, Presentation slide, Story book, Carousel, Brand kit, Social media pack, Product listing image, Poster …
- Quick chips: GPT Image 2, Presentation, Social media, Branding, Product …
- Inspiration gallery with chips (Seedream 5.0 Pro, GPT Image 2, Social media, Posters, Recap, Brand, Pets, Business, Work, Photos, Graduation, IP design, Product design, Fashion design, Game design, Visual arts, Menu).

### 1d. Library
- Tabs: **Projects** (filters Video / Image / Effects; grid/list toggle), **Generated assets** (all AI-generated images, videos, documents for reuse), **Elements** (reusable characters, locations, props, styles for consistent AI generation).
- Project card: thumbnail, duration, name, space, edited time; ••• → Rename, Share, Move to Trash, Multi-select.

### 1e. Share and schedule
- **Share history**: Shared with you / Shared by you, sort (Latest to earliest), Share files.
- **Schedule**: content calendar (Week / Month, month navigator), All platforms ▾, All posts ▾, **Schedule** button to queue a post to connected social accounts.

## 2. Editor layout

```
┌────┬───────────────┬──────────────────────────────────────────┬───────────┬────┐
│rail│ asset panel   │ top bar: title ▾ · select/hand · zoom% · │ property  │rail│
│    │ (per rail tab)│ undo/redo · credits · Export             │ panel     │    │
│    │               │ ┌ Ratio ┐   canvas (selection handles,   │ (per tab) │    │
│    │               │           floating object toolbar)       │           │    │
│    │               ├──────────────────────────────────────────┴───────────┴────┤
│    │               │ timeline toolbar · play · tc / total · snap · zoom · fit  │
│    │               │ ruler · tracks (text above, main video track, audio below)│
└────┴───────────────┴───────────────────────────────────────────────────────────┘
```

Dark left side (rail + asset panel), light canvas/timeline area. Asset panel collapses.

### Left rail tabs → asset panel
| Tab | Contents |
|---|---|
| Media | Upload (+ Google Drive, Dropbox), record phone / screen, library grid with durations |
| Templates | Video templates |
| Elements | Search + chips; Stock videos, Photos, AI avatars, Stickers (each "View all") |
| Audio | Music (search, filter, categories: Recommend, Pop, R&B, Healing, Warm, High tempo, Beat…; recommended list with duration + artist) · Sound effects |
| Text | Text templates (Add heading, Add body text; All / Commercial; Trending, Whimsical, Pixel Bead, Classic, Hits …) · Text effects |
| Captions | Auto captions (speech recognition) · Manual captions · Upload caption file (.srt .ass .lrc) |
| Transcript | Transcript-based editing: pick spoken language + track → Transcribe; edit the video by editing words, remove filler words |
| Effects | Video effects (search, chips blur/countdown/zoom lens/shake/retro; Trending, Classic, Black Friday, Whimsical, Pixel Bead, Hits) · Body effects |
| Transitions | Drag between two clips; Trending, Classic (3D Flip, Strobe, Flip, Cube Face, Split), Whimsical, Pixel Bead, Hits |
| Filters | Featured, Hits, Life, Landscape, Portrait, Mono, Movies … (colour LUT presets) |
| Brand kit | Per-space brand videos, images, text presets, adjustment presets, brand colours |
| Plugins | Third-party (e.g. royalty-free music) |
| ⌨ | Shortcuts dialog |

### Right rail (context-sensitive property panel)
**Video/image clip:** Basic · Background · Smart tools · Animation · Speed
- *Basic* — Mask; Color adjustment (Basic, HSL, Curves); Blend (mode, opacity ◇); Stabilize; Reduce image noise; Remove flicker; Transform (scale ◇, position X/Y ◇, rotate ◇) — ◇ = keyframe toggle on every animatable property
- *Background* — colour / blur / image fill for letterbox area, recents, brand colours, "apply to all"
- *Smart tools* — Retouch, Remove background, Relight, AI movement (camera moves), Optical flow (frame interpolation)
- *Animation* — In / Out / Combo preset grids (fade, slide L/R/U/D, zoom, glitch wipe, pixel erode, block out, spiral…) with duration
- *Speed* — Normal (1× slider, duration field) / Curve (speed ramps); Pitch toggle; Smooth slow-mo

**Text:** Presets · Basic · Text to speech · AI avatars · Animation
- *Basic* — text box, font, size, B/I/U, alignment, case, line spacing; Style: fill, stroke, background, shadow; Glow; Opacity ◇; Apply to all

**Canvas object toolbar** — replace/overlay, fit/fill, crop, overlay mode, ••• (copy, cut, paste, duplicate, delete, replace, crop, flip ▸, overlay ▸, add overlay)

### Timeline
- Toolbar: split, delete, freeze, crop, flip, transcript edit, download clip ▾; play, `current | total` timecode; magnet/snap, split-screen, zoom − slider +, fit, full-screen preview
- Tracks: text/overlay tracks stack above the **main track**; audio below; per-track mute + cover edit
- Clip: label + duration, filmstrip thumbnails, trim handles on both edges
- Context menu: Split, Copy, Cut, Paste, Duplicate, Delete, Replace, Download clip ▸, Transcript-based editing, Separate audio, Split scene, Freeze
- Ratio: Original, 16:9, 4:3, 2:1, 9:16, 1:1, 3:4 (with platform hints)

### Keyboard shortcuts
| Global | Timeline | Canvas |
|---|---|---|
| Select all Ctrl A · Multi-select Ctrl-click · Copy/Cut/Paste · Delete Backspace · Undo Ctrl Z · Redo Ctrl Shift Z · Play/pause Space · Text wrap Ctrl Enter · Split sentence Enter | Split Ctrl B · Zoom Ctrl +/− · Scroll / Shift-scroll · Prev/next frame Ctrl ←/→ · Preview axis S · Attach N · Separate audio Ctrl Shift S · Beats M | Full screen Ctrl Shift F · Move V · Hand H · Zoom Shift +/− · Fit Shift F · 50/100/200 % Shift 0/1/2 · Nudge ↑↓ 1 px |

### Export
Share for review (comments) · Share as presentation · Share on social (TikTok, Schedule) · **Download** → settings: cover, name, resolution (720p default; up to 4K), quality, frame rate (30 fps), format (MP4)

## 3. Parity map for Producer Studio

| Capability | Phase 1 | Later |
|---|---|---|
| Multi-track timeline: move, trim, split, ripple delete, snap, zoom, multi-select, copy/paste, duplicate, undo/redo | ✅ | |
| Canvas: select, drag, scale/rotate handles, ratio presets, fit/fill, background colour/blur | ✅ | |
| Transform / opacity / blend / volume keyframes | ✅ | curve editor |
| Colour adjust (brightness, contrast, saturation, exposure, temperature, tint, highlights/shadows approximations), filter presets | ✅ | HSL, curves, LUT upload |
| Speed (constant), freeze frame, reverse (server) | ✅ const + freeze | speed curves, optical flow |
| Text: fonts, size, weight, style, fill/stroke/background/shadow/glow, alignment, templates | ✅ | text effects library |
| Animations in/out/combo; transitions between clips | ✅ core set | extended library |
| Effects (blur, shake, zoom pulse, flash, vignette, grain, RGB split, B&W, VHS) | ✅ CSS-renderable set | body effects |
| Audio: music/SFX tracks, volume, fades, separate audio, waveform | ✅ | beat detection, ducking UI |
| Auto captions (speech → caption track), caption styles, SRT import/export | ✅ | .ass/.lrc |
| Transcript-based editing (delete words → cut), filler/silence removal | ✅ | |
| Text-to-speech voiceover | ✅ Kokoro voices | voice changer |
| Export MP4 720p/1080p/4K, 24/30/60 fps | ✅ | |
| Share for review (comment links) | | ✅ phase 2 |
| Spaces / team workspaces, brand kit | workspace model + brand kit basics | invites, roles |
| Stock media, stickers, music library | | licensed provider integration |
| Voice Studio: TTS workspace with voice library + filters, history, AI writer (`/`) | ✅ Kokoro voices + Claude writer | more TTS providers |
| Voice cloning ("My voices") and voice changer | | ✅ phase 2 (provider-backed) |
| Templates gallery: categories, preview, "use template" with replaceable placeholders | ✅ Producer looks as templates; save-project-as-template | community gallery |
| Design Studio: prompt → image designs with skills (cover, slide, carousel, poster, social pack) | thumbnails/covers via HyperFrames stills | image-model provider integration |
| Library: projects / generated assets / elements, rename, share, trash, multi-select | ✅ projects + assets + trash | elements (consistent characters) |
| Share history + social scheduling calendar | review links | ✅ phase 2 (platform OAuth) |
| Smart tools (remove BG, relight, stabilize, denoise, retouch) | | server-side models |
| AI video generation (prompt → video) | | provider integration |
| **Producer AI** (not in CapCut): recording → transcript → Claude script → narration → auto-assembled branded timeline; AI chat that edits the timeline | ✅ | |
