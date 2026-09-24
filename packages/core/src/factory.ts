import { NEUTRAL_ADJUST, TEXT_TEMPLATES, defaultTextStyle, captionStyleFromPreset } from './presets'
import type {
  Asset,
  AudioItem,
  CaptionItem,
  ImageItem,
  Project,
  ShapeItem,
  TextItem,
  Track,
  TrackKind,
  Transform,
  VideoItem,
} from './types'
import { uid } from './util'

export const IDENTITY: Transform = { x: 0, y: 0, scale: 1, rotation: 0 }

export function createProject(opts: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background'>> & { id?: string } = {}): Project {
  const now = Date.now()
  return {
    id: opts.id ?? uid('p'),
    schema: 1,
    name: opts.name ?? 'Untitled project',
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    fps: opts.fps ?? 30,
    background: opts.background ?? '#000000',
    tracks: [createTrack('video', { main: true, name: 'Main' })],
    assets: {},
    createdAt: now,
    updatedAt: now,
  }
}

export function createTrack(kind: TrackKind, over: Partial<Track> = {}): Track {
  const names: Record<TrackKind, string> = { video: 'Video', overlay: 'Overlay', text: 'Text', audio: 'Audio', caption: 'Captions' }
  return {
    id: uid('t'),
    kind,
    name: names[kind],
    items: [],
    ...(kind === 'caption' ? { captionStyle: captionStyleFromPreset('clean') } : {}),
    ...over,
  }
}

const visualDefaults = () => ({
  transform: { ...IDENTITY },
  opacity: 1,
  blend: 'normal' as const,
  keyframes: {},
  animations: {},
  effects: [],
})

export function createVideoItem(asset: Asset, start: number, over: Partial<VideoItem> = {}): VideoItem {
  return {
    id: uid('v'),
    type: 'video',
    assetId: asset.id,
    name: asset.name,
    start,
    duration: asset.duration ?? 5,
    in: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    adjust: { ...NEUTRAL_ADJUST },
    fit: 'contain',
    ...visualDefaults(),
    ...over,
  }
}

export function createImageItem(asset: Asset, start: number, over: Partial<ImageItem> = {}): ImageItem {
  return {
    id: uid('m'),
    type: 'image',
    assetId: asset.id,
    name: asset.name,
    start,
    duration: 5,
    adjust: { ...NEUTRAL_ADJUST },
    fit: 'contain',
    ...visualDefaults(),
    ...over,
  }
}

export function createAudioItem(asset: Asset, start: number, over: Partial<AudioItem> = {}): AudioItem {
  return {
    id: uid('a'),
    type: 'audio',
    assetId: asset.id,
    name: asset.name,
    start,
    duration: asset.duration ?? 5,
    in: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    keyframes: {},
    ...over,
  }
}

export function createTextItem(start: number, templateId = 'heading', over: Partial<TextItem> = {}): TextItem {
  const tpl = TEXT_TEMPLATES.find((t) => t.id === templateId) ?? TEXT_TEMPLATES[0]
  return {
    id: uid('x'),
    type: 'text',
    name: tpl.text,
    start,
    duration: 3,
    text: tpl.text,
    style: defaultTextStyle(tpl.style),
    template: tpl.id,
    ...visualDefaults(),
    animations: {
      ...(tpl.animationIn ? { in: { preset: tpl.animationIn, duration: 0.5 } } : {}),
      ...(tpl.animationOut ? { out: { preset: tpl.animationOut, duration: 0.4 } } : {}),
    },
    ...over,
  }
}

export function createCaptionItem(start: number, duration: number, text: string, words?: CaptionItem['words']): CaptionItem {
  return { id: uid('c'), type: 'caption', start, duration, text, words }
}

export function createShapeItem(start: number, over: Partial<ShapeItem> = {}): ShapeItem {
  return {
    id: uid('s'),
    type: 'shape',
    name: 'Shape',
    start,
    duration: 3,
    shape: 'rect',
    width: 400,
    height: 240,
    fill: '#ff5a5f',
    radius: 16,
    ...visualDefaults(),
    ...over,
  }
}
