// Lottie motion graphics for the AI-drawing sandbox (the 'lottie' drawing style). The AI writes with a small builder
// (env.motionGraphics): text, rectangles, ellipses, paths and groups, animated with chainable helpers (fadeIn, move,
// pop, spin, drawOn ...). The builder compiles the scene to standard Lottie (bodymovin v5) JSON, and lottie-web
// (vendor/lottie, MIT, the light canvas build: no expressions, so an animation can't run code) renders it frame by
// frame onto the drawing's canvas. The JSON is a real Lottie animation: the same file plays in any Lottie player.
//
// Loaded as a browser script (window.__psLottie) on pages whose code uses env.motionGraphics, after lottie-web. The
// builder touches no browser API, so its JSON is unit-tested in Node; rendering is covered by the browser test.
(function () {
  'use strict'
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)) }

  function hexRgb(hex) {
    if (Array.isArray(hex)) return [hex[0], hex[1], hex[2]]
    var h = String(hex == null ? '#000000' : hex).trim().replace('#', '')
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    var n = parseInt(h.slice(0, 6), 16)
    if (isNaN(n)) throw new Error('not a colour: ' + hex + " (use '#rrggbb')")
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }

  // Lottie eases are the cubic-bezier handles of the keyframe they leave (o) and the one they reach (i)
  var EASE = {
    linear: { o: [0, 0], i: [1, 1] },
    out: { o: [0.22, 1], i: [0.36, 1] },
    in: { o: [0.55, 0], i: [1, 0.45] },
    inOut: { o: [0.65, 0], i: [0.35, 1] },
    back: { o: [0.34, 1.56], i: [0.64, 1] },
  }
  function easeOf(e) {
    var v = typeof e === 'string' ? EASE[e] : e
    if (!v) throw new Error('unknown ease "' + e + '" (try: ' + Object.keys(EASE).join(', ') + ')')
    return v
  }

  var STATIC_TR = function () {
    return { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 }, nm: 'Transform' }
  }

  // --- the builder ---------------------------------------------------------------------------------------------------

  function Layer(scene, kind, cfg) {
    this.scene = scene
    this.kind = kind
    this.cfg = cfg || {}
    this.ind = scene._layers.length + 1
    this.kf = { p: [], s: [], r: [], o: [], tm: [] } // position px, scale %, rotation deg, opacity %, trim end %
    var c = this.cfg
    // a path's points are frame pixels, so its layer sits at the origin; everything else at its x, y (default: centre)
    var dx = kind === 'path' ? 0 : scene.w / 2, dy = kind === 'path' ? 0 : scene.h / 2
    this.base = {
      p: [c.x == null ? dx : c.x, c.y == null ? dy : c.y],
      s: c.scale == null ? 100 : c.scale * 100,
      r: c.rotation || 0,
      o: c.opacity == null ? 100 : c.opacity * 100,
    }
    this.parent = c.parent ? c.parent.ind : 0
    scene._layers.push(this)
  }
  var frameOf = function (scene, sec) { return Math.round(Math.max(0, sec) * scene.fps) }
  Layer.prototype._key = function (track, sec, value, ease) {
    if (typeof sec !== 'number' || !isFinite(sec)) throw new Error('a time must be a number of seconds (got ' + sec + ')')
    this.kf[track].push({ t: frameOf(this.scene, sec), s: value, e: easeOf(ease || 'out') })
    return this
  }
  // a keyframe at `sec` for any of { x, y, position: [x, y], scale, rotation, opacity }
  Layer.prototype.at = function (sec, props, ease) {
    props = props || {}
    if (props.position) this._key('p', sec, [props.position[0], props.position[1]], ease)
    else if (props.x != null || props.y != null) this._key('p', sec, [props.x == null ? this.base.p[0] : props.x, props.y == null ? this.base.p[1] : props.y], ease)
    if (props.scale != null) this._key('s', sec, props.scale * 100, ease)
    if (props.rotation != null) this._key('r', sec, props.rotation, ease)
    if (props.opacity != null) this._key('o', sec, props.opacity * 100, ease)
    return this
  }
  Layer.prototype.fadeIn = function (start, dur, ease) { return this.at(start, { opacity: 0 }, ease || 'out').at(start + (dur || 0.4), { opacity: this.base.o / 100 }) }
  Layer.prototype.fadeOut = function (start, dur, ease) { return this.at(start, { opacity: this.base.o / 100 }, ease || 'in').at(start + (dur || 0.4), { opacity: 0 }) }
  Layer.prototype.move = function (t0, from, t1, to, ease) { return this.at(t0, { position: from }, ease || 'inOut').at(t1, { position: to }) }
  Layer.prototype.pop = function (at, opts) {
    opts = opts || {}
    var to = opts.to == null ? this.base.s / 100 : opts.to
    return this.at(at, { scale: opts.from == null ? 0 : opts.from }, opts.ease || 'back').at(at + (opts.dur || 0.5), { scale: to })
  }
  Layer.prototype.scaleTo = function (t0, s0, t1, s1, ease) { return this.at(t0, { scale: s0 }, ease || 'inOut').at(t1, { scale: s1 }) }
  Layer.prototype.spin = function (t0, t1, degrees, ease) { return this.at(t0, { rotation: this.base.r }, ease || 'inOut').at(t1, { rotation: this.base.r + (degrees == null ? 360 : degrees) }) }
  Layer.prototype.slideIn = function (start, dur, dx, dy, ease) {
    var p = this.base.p
    return this.at(start, { position: [p[0] - (dx == null ? 0 : dx), p[1] - (dy == null ? 60 : dy)], opacity: 0 }, ease || 'out').at(start + (dur || 0.5), { position: p.slice(), opacity: this.base.o / 100 })
  }
  // a stroked shape or path draws itself on, like a pen (Lottie's trim paths, 0 → 100%)
  Layer.prototype.drawOn = function (t0, t1, ease) {
    if (!this.cfg.stroke) throw new Error('drawOn needs a stroke (set stroke and strokeWidth on the shape)')
    this.kf.tm.push({ t: frameOf(this.scene, t0), s: 0, e: easeOf(ease || 'inOut') })
    this.kf.tm.push({ t: frameOf(this.scene, t1), s: 100, e: easeOf('linear') })
    return this
  }

  // an animatable Lottie property: static, or keyframes (sorted, later duplicates of a frame win)
  function prop(base, keys, dims) {
    var wrap = function (v) { return dims === 1 ? [v] : v }
    if (!keys || !keys.length) return { a: 0, k: base }
    var sorted = keys.slice().sort(function (a, b) { return a.t - b.t })
    var k = []
    for (var n = 0; n < sorted.length; n++) {
      if (n + 1 < sorted.length && sorted[n + 1].t === sorted[n].t) continue
      var e = { t: sorted[n].t, s: wrap(sorted[n].s) }
      var ease = sorted[n].e
      var d = dims === 1 ? 1 : 2
      var rep = function (v) { var a = []; for (var j = 0; j < d; j++) a.push(v); return a }
      e.o = { x: rep(ease.o[0]), y: rep(ease.o[1]) }
      e.i = { x: rep(ease.i[0]), y: rep(ease.i[1]) }
      k.push(e)
    }
    // a property needs two keyframes to animate; one is a fixed value
    if (k.length === 1) return { a: 0, k: dims === 1 ? k[0].s[0] : k[0].s }
    return { a: 1, k: k }
  }

  function layerKs(l) {
    var s = prop([l.base.s, l.base.s], l.kf.s.map(function (x) { return { t: x.t, s: [x.s, x.s], e: x.e } }), 2)
    return { o: prop(l.base.o, l.kf.o, 1), r: prop(l.base.r, l.kf.r, 1), p: prop(l.base.p, l.kf.p, 2), a: { a: 0, k: [0, 0] }, s: s }
  }

  function paint(c) {
    var out = []
    if (c.fill) out.push({ ty: 'fl', c: { a: 0, k: hexRgb(c.fill).concat([1]) }, o: { a: 0, k: c.fillOpacity == null ? 100 : c.fillOpacity * 100 }, r: 1, nm: 'Fill' })
    if (c.stroke) out.push({ ty: 'st', c: { a: 0, k: hexRgb(c.stroke).concat([1]) }, o: { a: 0, k: 100 }, w: { a: 0, k: c.strokeWidth || 6 }, lc: 2, lj: 2, ml: 4, nm: 'Stroke' })
    if (!out.length) out.push({ ty: 'fl', c: { a: 0, k: [0, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1, nm: 'Fill' })
    return out
  }

  function geometry(l) {
    var c = l.cfg
    if (l.kind === 'rect') return { ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [c.w || 200, c.h || 120] }, r: { a: 0, k: c.radius || 0 }, nm: 'Rect' }
    if (l.kind === 'ellipse') return { ty: 'el', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [c.w || 160, c.h || 160] }, nm: 'Ellipse' }
    var pts = c.points || []
    var z = pts.map(function () { return [0, 0] })
    return { ty: 'sh', d: 1, ks: { a: 0, k: { c: c.closed !== false && !!c.fill, v: pts.map(function (p) { return [p[0], p[1]] }), i: z, o: z.slice() } }, nm: 'Path' }
  }

  function Scene(opts) {
    opts = opts || {}
    this.w = opts.width || 1920
    this.h = opts.height || 1080
    this.fps = opts.fps || 30
    this.duration = opts.duration || 5
    this.fonts = opts.fonts || { headline: 'Inter', body: 'Inter' }
    this._layers = []
  }
  Scene.prototype.background = function (color) { return this.rect({ x: this.w / 2, y: this.h / 2, w: this.w, h: this.h, fill: color }) }
  Scene.prototype.rect = function (cfg) { return new Layer(this, 'rect', cfg) }
  Scene.prototype.ellipse = function (cfg) { return new Layer(this, 'ellipse', cfg) }
  Scene.prototype.circle = function (cfg) { cfg = cfg || {}; var d = cfg.r != null ? cfg.r * 2 : cfg.d || 160; cfg.w = cfg.h = d; return new Layer(this, 'ellipse', cfg) }
  Scene.prototype.path = function (points, cfg) { cfg = cfg || {}; cfg.points = points; return new Layer(this, 'path', cfg) }
  Scene.prototype.text = function (str, cfg) { cfg = cfg || {}; cfg.text = String(str == null ? '' : str); return new Layer(this, 'text', cfg) }
  // a null layer: animate it, and layers made with { parent: g } move, scale and spin with it
  Scene.prototype.group = function (cfg) { return new Layer(this, 'null', cfg || {}) }

  // Standard Lottie v5 JSON. Layers draw from the end of the list up, so the first one added is last (at the back).
  Scene.prototype.toLottie = function () {
    var self = this
    var op = Math.max(1, Math.round(this.duration * this.fps))
    var fonts = {}
    var layers = this._layers.map(function (l) {
      var out = { ddd: 0, ind: l.ind, ty: 4, nm: l.kind + ' ' + l.ind, sr: 1, ks: layerKs(l), ao: 0, ip: 0, op: op, st: 0, bm: 0 }
      if (l.parent) out.parent = l.parent
      if (l.kind === 'null') {
        out.ty = 3
      } else if (l.kind === 'text') {
        var c = l.cfg
        var family = c.font || self.fonts.headline
        var weight = c.weight || 700
        var fName = family.replace(/[^A-Za-z0-9]/g, '') + '-' + weight
        fonts[fName] = { fName: fName, fFamily: family, fStyle: weight >= 600 ? 'Bold' : 'Regular', fWeight: String(weight), ascent: 72, origin: 0 }
        var size = c.size || 80
        var lines = String(c.text).split('\n')
        out.ty = 5
        // Lottie places text by its first baseline; centre the block on y
        out.ks.a = { a: 0, k: [0, -(size * 0.35) + ((lines.length - 1) * size * 1.2) / 2] }
        out.t = {
          d: { k: [{ s: { s: size, f: fName, t: lines.join('\r'), j: c.align === 'left' ? 0 : c.align === 'right' ? 1 : 2, tr: c.tracking || 0, lh: size * 1.2, ls: 0, fc: hexRgb(c.color || '#111111') }, t: 0 }] },
          p: {},
          m: { g: 1, a: { a: 0, k: [0, 0] } },
          a: [],
        }
      } else {
        // contents in After Effects' order: the path, then trim paths (it trims what's above it), then the paint
        var items = [geometry(l)]
        if (l.kf.tm.length) items.push({ ty: 'tm', s: { a: 0, k: 0 }, e: prop(100, l.kf.tm, 1), o: { a: 0, k: 0 }, m: 1, nm: 'Trim' })
        items = items.concat(paint(l.cfg))
        items.push(STATIC_TR())
        out.shapes = [{ ty: 'gr', it: items, nm: 'Group' }]
      }
      return out
    })
    layers.reverse()
    var json = { v: '5.9.0', fr: this.fps, ip: 0, op: op, w: this.w, h: this.h, nm: 'Producer Studio motion graphics', ddd: 0, assets: [], layers: layers, markers: [] }
    var list = Object.keys(fonts).map(function (k) { return fonts[k] })
    if (list.length) json.fonts = { list: list }
    return json
  }

  // --- rendering, with lottie-web ------------------------------------------------------------------------------------
  //
  // lottie-web's canvas renderer draws text only from glyph outlines exported into the file (it has no fillText
  // fallback), so text layers are drawn here, in the brand's fonts, from the same keyframes; shapes are lottie-web's.
  // The layers are cut into runs at each text layer, bottom to top: each run of shape layers is its own lottie-web
  // animation (with the null layers it's parented to), so text keeps its place in the stacking order.

  // cubic-bezier y for progress x, the keyframe's out (o) and next in (i) handles
  function bezier(x, o, i) {
    if (x <= 0) return 0
    if (x >= 1) return 1
    var x1 = o[0], y1 = o[1], x2 = i[0], y2 = i[1]
    var cx = function (u) { return 3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u }
    var cy = function (u) { return 3 * y1 * u * (1 - u) * (1 - u) + 3 * y2 * u * u * (1 - u) + u * u * u }
    var lo = 0, hi = 1, u = x
    for (var n = 0; n < 30; n++) { var e = cx(u) - x; if (Math.abs(e) < 1e-5) break; if (e > 0) hi = u; else lo = u; u = (lo + hi) / 2 }
    return cy(u)
  }
  // a Lottie property's value at frame f (keyframes eased as lottie-web eases them)
  function sample(p, f) {
    if (!p) return 0
    if (p.a !== 1) return p.k
    var ks = p.k
    var one = function (v) { return Array.isArray(v) && v.length === 1 ? v[0] : v }
    if (f <= ks[0].t) return one(ks[0].s)
    for (var n = 0; n < ks.length - 1; n++) {
      var a = ks[n], b = ks[n + 1]
      if (f < b.t) {
        var k = b.t === a.t ? 1 : (f - a.t) / (b.t - a.t)
        var e = bezier(k, [a.o.x[0], a.o.y[0]], [a.i.x[0], a.i.y[0]])
        var s = a.s, s2 = b.s
        var out = []
        for (var d = 0; d < s.length; d++) out.push(s[d] + (s2[d] - s[d]) * e)
        return one(out)
      }
    }
    return one(ks[ks.length - 1].s)
  }
  // the layer's transform (and its parents'), applied to ctx; returns its opacity (0..1)
  function transformTo(ctx, layer, byInd, f) {
    var chain = [], cur = layer, guard = 0
    while (cur && guard++ < 16) { chain.unshift(cur); cur = cur.parent ? byInd[cur.parent] : null }
    var alpha = 1
    for (var n = 0; n < chain.length; n++) {
      var ks = chain[n].ks, p = sample(ks.p, f), a = sample(ks.a, f), s = sample(ks.s, f), r = sample(ks.r, f)
      ctx.translate(p[0], p[1])
      if (r) ctx.rotate(r * Math.PI / 180)
      ctx.scale(s[0] / 100, s[1] / 100)
      ctx.translate(-a[0], -a[1])
      // a parent's opacity doesn't pass to its children in Lottie
      if (chain[n] === layer) alpha = sample(ks.o, f) / 100
    }
    return alpha
  }
  function drawText(ctx, layer, byInd, fonts, f) {
    var doc = layer.t.d.k[0].s
    var font = fonts[doc.f] || { fFamily: 'sans-serif', fWeight: '700' }
    ctx.save()
    var alpha = transformTo(ctx, layer, byInd, f)
    if (alpha > 0.001) {
      ctx.globalAlpha *= clamp(alpha, 0, 1)
      ctx.fillStyle = 'rgb(' + Math.round(doc.fc[0] * 255) + ',' + Math.round(doc.fc[1] * 255) + ',' + Math.round(doc.fc[2] * 255) + ')'
      ctx.font = (font.fWeight || '400') + ' ' + doc.s + 'px "' + font.fFamily + '", sans-serif'
      ctx.textAlign = doc.j === 2 ? 'center' : doc.j === 1 ? 'right' : 'left'
      ctx.textBaseline = 'alphabetic'
      if ('letterSpacing' in ctx) ctx.letterSpacing = ((doc.tr || 0) / 1000) * doc.s + 'px'
      var lines = String(doc.t).split(/\r|\n/)
      for (var n = 0; n < lines.length; n++) ctx.fillText(lines[n], 0, n * (doc.lh || doc.s * 1.2))
    }
    ctx.restore()
  }

  function player(json) {
    if (typeof window === 'undefined' || !window.lottie) throw new Error('lottie-web is not loaded on this page')
    var byInd = {}
    json.layers.forEach(function (l) { byInd[l.ind] = l })
    var fonts = {}
    ;((json.fonts && json.fonts.list) || []).forEach(function (fd) { fonts[fd.fName] = fd })
    var nulls = json.layers.filter(function (l) { return l.ty === 3 })
    // runs, bottom first (Lottie draws the end of the list first)
    var runs = []
    for (var n = json.layers.length - 1; n >= 0; n--) {
      var l = json.layers[n]
      if (l.ty === 3) continue
      if (l.ty === 5) { runs.push({ text: l }); continue }
      var last = runs[runs.length - 1]
      if (!last || last.text) runs.push((last = { shapes: [] }))
      last.shapes.unshift(l)
    }
    runs.forEach(function (r) {
      if (!r.shapes) return
      var c = document.createElement('canvas')
      c.width = json.w
      c.height = json.h
      var data = { v: json.v, fr: json.fr, ip: json.ip, op: json.op, w: json.w, h: json.h, nm: json.nm, ddd: 0, assets: [], layers: r.shapes.concat(nulls) }
      r.canvas = c
      r.anim = window.lottie.loadAnimation({ renderer: 'canvas', loop: false, autoplay: false, animationData: JSON.parse(JSON.stringify(data)), rendererSettings: { context: c.getContext('2d'), clearCanvas: true, preserveAspectRatio: 'none' } })
    })
    return {
      runs: runs,
      anim: (runs.filter(function (r) { return r.anim })[0] || {}).anim,
      render: function (target, t) {
        var f = clamp(t * json.fr, 0, Math.max(0, json.op - 1))
        var sx = target.canvas.width / json.w, sy = target.canvas.height / json.h
        for (var i = 0; i < runs.length; i++) {
          var r = runs[i]
          if (r.anim) {
            r.anim.goToAndStop(f, true)
            target.drawImage(r.canvas, 0, 0, target.canvas.width, target.canvas.height)
          } else {
            target.save()
            target.scale(sx, sy)
            drawText(target, r.text, byInd, fonts, f)
            target.restore()
          }
        }
      },
    }
  }

  var api = { Scene: Scene, player: player, hexRgb: hexRgb, EASE: EASE, sample: sample, bezier: bezier }
  if (typeof window !== 'undefined') window.__psLottie = api
  if (typeof module !== 'undefined') module.exports = api
})()
