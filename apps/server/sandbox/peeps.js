// Rigged 2D characters for the AI-drawing sandbox, drawn from Open Peeps (Pablo Stanley, openpeeps.com, CC0; the art
// comes from react-peeps, MIT, built into vendor/peeps/peeps.json by scripts/build-peeps.mjs).
//
// A person is a cut-out puppet, the way explainer-video characters are rigged: a body drawing (one of Open Peeps'
// standing, sitting or bust poses) and a head on its own pivot at the neck, made of hair, a face, facial hair and an
// accessory. The puppet is scheduled, then drawn from the scene's clock alone:
//   - the body switches pose with a small squash (cut-out animation hides the swap that way) and breathes;
//   - the head nods, shakes and tilts on the neck; the face changes expression;
//   - talk() opens and closes the mouth on the narration's words (env.words) by swapping to an open-mouth face;
//   - it enters, exits, moves and walks (the walking pose, a step bob and a little sway).
// Loaded as a browser script (window.__psPeeps) on pages whose code uses env.peep; it needs window.__peepsData. The
// scheduling and timing maths touch only Math, so they're unit-tested in Node; drawing is covered by the browser test.
(function () {
  'use strict'
  var DATA = typeof window !== 'undefined' ? window.__peepsData : null
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)) }
  var smooth = function (k) { k = clamp(k, 0, 1); return k * k * (3 - 2 * k) }
  var backOut = function (k) { k = clamp(k, 0, 1); var c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2) }
  var envelope = function (lt, dur, up, down) {
    if (lt <= 0 || lt >= dur) return 0
    if (lt < up) return smooth(lt / up)
    if (lt > dur - down) return smooth((dur - lt) / down)
    return 1
  }

  // Faces Open Peeps also draws without a mouth: talking draws its own mouth on these, so the eyes stay put.
  var NO_MOUTH = { Calm: 'CalmNM', Smile: 'SmileNM', CalmNM: 'CalmNM', SmileNM: 'SmileNM', CheersNM: 'CheersNM' }
  // For the rest, the face drawn while the mouth is open (talking flips between the two).
  var OPEN_MOUTH = {
    Calm: 'Explaining', Smile: 'SmileBig', SmileNM: 'SmileBig', CalmNM: 'Explaining', Serious: 'Explaining', Solemn: 'Explaining',
    Cute: 'SmileBig', Driven: 'Explaining', Concerned: 'ConcernedFear', Suspicious: 'Explaining', Contempt: 'Explaining',
    Tired: 'Awe', Blank: 'Awe', Cheeky: 'SmileTeeth', OldAged: 'Explaining', EyesClosed: 'SmileLol', Angry: 'Rage',
  }
  var CATEGORIES = ['face', 'hair', 'facialHair', 'accessories', 'standing', 'sitting', 'bust']

  function names(cat) { return DATA && DATA[cat] ? Object.keys(DATA[cat]) : [] }
  // a name as written, or with Open Peeps' colourway suffix (BW: dark top on light, WB: the other way round)
  function resolve(cat, name) {
    if (!name || name === 'None' || !DATA || !DATA[cat]) return name
    if (DATA[cat][name]) return name
    var lower = String(name).toLowerCase()
    var all = names(cat)
    for (var i = 0; i < all.length; i++) if (all[i].toLowerCase() === lower) return all[i]
    for (var j = 0; j < all.length; j++) if (all[j].toLowerCase().indexOf(lower) === 0) return all[j]
    return name
  }

  // a part's paths as Path2D, built once
  var cache = {}
  function part(cat, name) {
    if (!name || name === 'None') return null
    name = resolve(cat, name)
    var key = cat + '/' + name
    if (cache[key]) return cache[key]
    var src = DATA && DATA[cat] && DATA[cat][name]
    if (!src) throw new Error('unknown ' + cat + ' "' + name + '" (try: ' + names(cat).join(', ') + ')')
    var out = { box: src.box, paths: src.paths.map(function (p) { return { path: new Path2D(p.d), fill: p.fill, rule: p.rule || 'nonzero', x: p.x, y: p.y } }) }
    cache[key] = out
    return out
  }
  function drawPart(ctx, pt, ink, paper) {
    if (!pt) return
    for (var i = 0; i < pt.paths.length; i++) {
      var p = pt.paths[i]
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.fillStyle = p.fill === 'ink' ? ink : p.fill === 'paper' ? paper : p.fill
      ctx.fill(p.path, p.rule)
      ctx.restore()
    }
  }

  // Where a body's shoulders meet in the middle: the first row, from the top, whose widest filled span is a good part
  // of the body's width (a raised arm is thin and is passed over). Measured once per body, small, offscreen. The
  // bust poses already sit right under react-peeps' head; every other body gets its head moved by the difference
  // between its shoulders and Explaining's (bust) shoulders, so heads sit on necks whatever the pose.
  var shoulders = {}
  function shoulderPoint(cat, name) {
    var key = cat + '/' + resolve(cat, name)
    if (shoulders[key]) return shoulders[key]
    var pt = part(cat, name), bx = pt.box, k = 0.2
    var W = Math.ceil((bx[2] - bx[0]) * k) + 4, H = Math.ceil((bx[3] - bx[1]) * k) + 4
    var c = document.createElement('canvas'); c.width = W; c.height = H
    var g = c.getContext('2d'); g.scale(k, k); g.translate(-bx[0] + 10, -bx[1] + 10); drawPart(g, pt, '#000', '#000')
    var d = g.getImageData(0, 0, W, H).data
    var need = W * 0.22, found = null
    for (var y = 0; y < H && !found; y++) {
      var best = 0, bestMid = 0, run = 0
      for (var x = 0; x <= W; x++) {
        var on = x < W && d[(y * W + x) * 4 + 3] > 128
        if (on) run++
        else { if (run > best) { best = run; bestMid = x - run / 2 } run = 0 }
      }
      if (best >= need) found = { x: bestMid / k + bx[0] - 10, y: y / k + bx[1] - 10 }
    }
    shoulders[key] = found || { x: (bx[0] + bx[2]) / 2, y: bx[1] }
    return shoulders[key]
  }
  function headOffset(cat, name) {
    if (cat === 'bust') return [0, 0]
    var ref = shoulderPoint('bust', 'Explaining'), b = shoulderPoint(cat, name)
    return [b.x - ref.x, b.y - ref.y]
  }

  var mouths = {}
  function mouthBox(face) {
    var nm = NO_MOUTH[face]
    if (!nm || nm === face || typeof document === 'undefined') return null
    if (mouths[face] !== undefined) return mouths[face]
    var a = part('face', face), b = part('face', nm)
    var bx = a.box, W = Math.ceil(bx[2] - bx[0] + 20), H = Math.ceil(bx[3] - bx[1] + 20)
    var paint = function (pt) {
      var c = document.createElement('canvas'); c.width = W; c.height = H
      var g = c.getContext('2d'); g.translate(10 - bx[0], 10 - bx[1]); drawPart(g, pt, '#000', '#000')
      return g.getImageData(0, 0, W, H).data
    }
    var da = paint(a), db = paint(b)
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var i = (y * W + x) * 4 + 3
      if (da[i] > 128 && db[i] < 64) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y }
    }
    mouths[face] = isFinite(x0) ? { x: (x0 + x1) / 2 + bx[0] - 10, y: (y0 + y1) / 2 + bx[1] - 10, w: Math.max(18, x1 - x0), h: Math.max(8, y1 - y0) } : null
    return mouths[face]
  }

  // --- the schedule (pure) -------------------------------------------------------------------------------------------

  // the value of a "from this time on" track at t (the last entry started by t, else the default)
  function latest(track, t, def) {
    var v = def, at = -Infinity
    for (var i = 0; i < track.length; i++) if (track[i].t <= t + 1e-9 && track[i].t >= at) { v = track[i].v; at = track[i].t }
    return { v: v, at: at }
  }

  // How open the mouth is at t (0 shut .. 1 wide): inside a talk window it opens and shuts once over each narration
  // word, wider for longer words; without word timings, about five flaps a second. Outside talk windows it's shut.
  function mouthOpenness(talks, words, t) {
    for (var i = 0; i < talks.length; i++) {
      var w = talks[i]
      if (t < w.t0 || t > w.t1) continue
      if (!words || !words.length) return Math.max(0, Math.sin((t - w.t0) * Math.PI * 5))
      for (var k = 0; k < words.length; k++) {
        var s = words[k].start, e = words[k].end != null ? words[k].end : s + 0.3
        if (s < w.t0 || s > w.t1 || t < s || t > e) continue
        var len = Math.max(0.08, e - s)
        var k2 = (t - s) / len
        return Math.sin(Math.PI * clamp(k2, 0, 1)) * clamp(0.55 + len * 1.2, 0.55, 1)
      }
      return 0
    }
    return 0
  }
  var mouthOpen = function (talks, words, t) { return mouthOpenness(talks, words, t) > 0.25 }

  // Where the puppet stands at t: x, y (its feet), extra lift, sway (degrees), scale and opacity, from enter/exit/move/walk.
  function placement(o, t) {
    var x = o.x, y = o.y, lift = 0, sway = 0, scale = 1, alpha = 1, walking = false
    for (var i = 0; i < o.moves.length; i++) {
      var m = o.moves[i]
      if (t <= m.t0) continue
      var k = m.t1 > m.t0 ? clamp((t - m.t0) / (m.t1 - m.t0), 0, 1) : 1
      var e = m.walk ? k : smooth(k)
      x = m.x0 + (m.x - m.x0) * e
      y = m.y0 + (m.y - m.y0) * e
      if (m.walk && t < m.t1) {
        walking = true
        var phase = (t - m.t0) * (m.steps || 2.2) * Math.PI
        lift = Math.abs(Math.sin(phase)) * 0.025
        sway = Math.sin(phase) * 2
      }
    }
    for (var j = 0; j < o.shows.length; j++) {
      var s = o.shows[j]
      var lt = t - s.t
      if (s.kind === 'enter') {
        if (lt < 0) { alpha = 0; continue }
        var p = clamp(lt / s.dur, 0, 1)
        if (s.from === 'pop') { scale *= backOut(p) ; alpha *= p > 0 ? 1 : 0 }
        else if (s.from === 'fade') alpha *= smooth(p)
        else if (s.from === 'bottom') { lift -= (1 - backOut(p)) * 0.6 ; alpha *= smooth(Math.min(1, p * 3)) }
        else { var dir = s.from === 'left' ? -1 : 1; x += dir * (1 - smooth(p)) * s.distance ; alpha *= smooth(Math.min(1, p * 3)) }
      } else if (lt >= 0) {
        var q = clamp(lt / s.dur, 0, 1)
        if (s.to === 'pop') scale *= 1 - smooth(q)
        else if (s.to === 'fade') alpha *= 1 - smooth(q)
        else if (s.to === 'bottom') { lift -= smooth(q) * 0.6 ; alpha *= 1 - smooth(Math.max(0, q * 3 - 2)) }
        else { var d2 = s.to === 'left' ? -1 : 1; x += d2 * smooth(q) * s.distance ; alpha *= 1 - smooth(Math.max(0, q * 3 - 2)) }
      }
    }
    return { x: x, y: y, lift: lift, sway: sway, scale: scale, alpha: alpha, walking: walking }
  }

  // The head's rotation at t (degrees), from nods, shakes and tilts, plus a little life while talking or idle.
  function headTurn(o, t, talking) {
    var r = 0, nodY = 0
    for (var i = 0; i < o.heads.length; i++) {
      var h = o.heads[i], lt = t - h.t
      if (lt < 0 || lt > h.dur) continue
      var e = envelope(lt, h.dur, Math.min(0.25, h.dur / 3), Math.min(0.3, h.dur / 3))
      if (h.kind === 'nod') nodY += (0.5 + 0.5 * Math.cos(lt * 9)) * 0.03 * e
      else if (h.kind === 'shake') r += Math.sin(lt * 11) * 7 * e
      else r += (h.deg || 8) * e
    }
    r += Math.sin(t * 1.3) * 1.2 + (talking ? Math.sin(t * 3.7) * 2.2 : 0)
    return { deg: r, dip: nodY }
  }

  // --- the puppet ----------------------------------------------------------------------------------------------------

  function Peep(env, opts) {
    opts = opts || {}
    var kind = opts.pose === 'sitting' || opts.pose === 'bust' ? opts.pose : 'standing'
    var def = { standing: 'RestingWB', sitting: 'MediumWB', bust: 'Explaining' }[kind]
    var o = {
      kind: kind,
      x: opts.x == null ? env.W / 2 : opts.x,
      y: opts.y == null ? env.H * 0.84 : opts.y,
      height: opts.height || env.H * 0.62,
      flip: !!opts.flip,
      ink: opts.ink || env.palette.ink || '#111111',
      paper: opts.paper || opts.fill || '#ffffff',
      hair: opts.hair === undefined ? 'ShortVolumed' : opts.hair,
      facialHair: opts.facialHair || null,
      accessory: opts.accessory || null,
      bodies: [{ t: -1, v: resolve(kind, opts.body || def) }],
      faces: [{ t: -1, v: resolve('face', opts.face || 'Smile') }],
      talks: [], heads: [], moves: [], shows: [],
    }
    // check every name now, so a mistake fails on the first frame with the list to choose from
    part(kind, o.bodies[0].v); part('face', o.faces[0].v); part('hair', o.hair); part('facialHair', o.facialHair); part('accessories', o.accessory)
    // the person's box (body and head), its feet at the bottom middle; the neck pivot under the face
    var body = part(kind, o.bodies[0].v), hair = part('hair', o.hair), face = part('face', o.faces[0].v)
    var hb = hair ? hair.box : face.box
    var off0 = typeof document !== 'undefined' ? headOffset(kind, o.bodies[0].v) : [0, 0]
    var top = Math.min(hb[1], face.box[1]) + off0[1], bottom = body.box[3]
    var unitH = bottom - top
    var neck = [(face.box[0] + face.box[2]) / 2, face.box[3] + 70]
    var cx = (Math.min(body.box[0], hb[0]) + Math.max(body.box[2], hb[2])) / 2
    var words = env.words || []
    var self = {
      o: o,
      // the person's height in pixels at scale 1; where its feet are
      get height() { return o.height },
      at: function (x, y) { o.x = x; o.y = y; return self },
      body: function (t, name) { part(kind, name); o.bodies.push({ t: t, v: resolve(kind, name) }); return self },
      face: function (t, name) { part('face', name); o.faces.push({ t: t, v: resolve('face', name) }); return self },
      talk: function (t0, t1) { o.talks.push({ t0: t0, t1: t1 == null ? env.duration : t1 }); return self },
      nod: function (t, dur) { o.heads.push({ kind: 'nod', t: t, dur: dur || 0.8 }); return self },
      shake: function (t, dur) { o.heads.push({ kind: 'shake', t: t, dur: dur || 0.9 }); return self },
      tilt: function (t, deg, dur) { o.heads.push({ kind: 'tilt', t: t, deg: deg == null ? 10 : deg, dur: dur || 1.2 }); return self },
      moveTo: function (t0, t1, x, y) { var p = placement(o, t0); o.moves.push({ t0: t0, t1: t1, x0: p.x, y0: p.y, x: x, y: y == null ? p.y : y }); return self },
      walk: function (t0, t1, x, y) {
        var p = placement(o, t0)
        o.moves.push({ t0: t0, t1: t1, x0: p.x, y0: p.y, x: x, y: y == null ? p.y : y, walk: true, steps: 2.2 })
        if (kind === 'standing') {
          var before = latest(o.bodies, t0 - 1e-6, o.bodies[0].v).v
          // the walking pose in the same colourway as the outfit
          var walkBody = /WB$/.test(before) ? 'WalkingWB' : /Filled$/.test(before) ? 'WalkingFilled' : 'WalkingBW'
          if (names('standing').indexOf(walkBody) < 0) walkBody = before
          o.bodies.push({ t: t0, v: walkBody }, { t: t1, v: before })
        }
        // face the way it walks
        o.flip = x < p.x
        return self
      },
      enter: function (t, from, dur) { o.shows.push({ kind: 'enter', t: t || 0, from: from || 'pop', dur: dur || 0.6, distance: env.W * 0.6 }); return self },
      exit: function (t, to, dur) { o.shows.push({ kind: 'exit', t: t, to: to || 'fade', dur: dur || 0.5, distance: env.W * 0.6 }); return self },
      draw: function (ctx, t) {
        var pl = placement(o, t)
        if (pl.alpha <= 0.001 || pl.scale <= 0.001) return
        var b = latest(o.bodies, t, o.bodies[0].v)
        var f = latest(o.faces, t, o.faces[0].v).v
        var open = mouthOpenness(o.talks, words, t)
        var inTalk = o.talks.some(function (w) { return t >= w.t0 && t <= w.t1 })
        var mouth = open > 0.05 ? mouthBox(f) : null
        if (mouth) f = NO_MOUTH[f]
        else if (open > 0.25) f = OPEN_MOUTH[f] || f
        var head = headTurn(o, t, inTalk)
        // a body swap squashes in; breathing all the time
        var sinceSwap = t - b.at
        var squash = sinceSwap >= 0 && sinceSwap < 0.22 && b.at > 0 ? 1 - 0.05 * (1 - backOut(sinceSwap / 0.22)) : 1
        var breathe = 1 + Math.sin(t * 2.1) * 0.006
        var s = (o.height / unitH) * pl.scale
        ctx.save()
        ctx.globalAlpha *= pl.alpha
        ctx.translate(pl.x, pl.y - pl.lift * o.height)
        ctx.rotate(pl.sway * Math.PI / 180)
        ctx.scale(s * (o.flip ? -1 : 1), s * squash * breathe)
        ctx.translate(-cx, -bottom)
        drawPart(ctx, part(kind, b.v), o.ink, o.paper)
        var off = headOffset(kind, b.v)
        ctx.translate(off[0], off[1])
        ctx.translate(neck[0], neck[1] + head.dip * unitH)
        ctx.rotate(head.deg * Math.PI / 180)
        ctx.translate(-neck[0], -neck[1])
        drawPart(ctx, part('hair', o.hair), o.ink, o.paper)
        drawPart(ctx, part('face', f), o.ink, o.paper)
        if (mouth) {
          // a drawn mouth, eased open and shut on the words: an ink shape with a little tongue
          var mw = mouth.w * (0.55 + 0.12 * open), mh = Math.max(mouth.h * 0.35, mouth.w * (0.06 + 0.3 * open))
          ctx.fillStyle = o.ink
          ctx.beginPath(); ctx.ellipse(mouth.x, mouth.y, mw / 2, mh / 2, 0, 0, Math.PI * 2); ctx.fill()
          if (open > 0.55) { ctx.fillStyle = '#e8726b'; ctx.beginPath(); ctx.ellipse(mouth.x, mouth.y + mh * 0.22, mw * 0.24, mh * 0.18, 0, 0, Math.PI * 2); ctx.fill() }
        }
        drawPart(ctx, part('facialHair', o.facialHair), o.ink, o.paper)
        drawPart(ctx, part('accessories', o.accessory), o.ink, o.paper)
        ctx.restore()
      },
    }
    return self
  }

  var api = { Peep: Peep, names: names, resolve: resolve, CATEGORIES: CATEGORIES, NO_MOUTH: NO_MOUTH, OPEN_MOUTH: OPEN_MOUTH, mouthOpen: mouthOpen, mouthOpenness: mouthOpenness, placement: placement, headTurn: headTurn, latest: latest }
  if (typeof window !== 'undefined') window.__psPeeps = api
  if (typeof module !== 'undefined') module.exports = api
})()
