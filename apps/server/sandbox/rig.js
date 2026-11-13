// Rigged characters for the AI-drawing sandbox's 3D scenes (three.js). A `env.character(opts)` builds an appealing,
// toy-like humanoid once (a skeleton of nested THREE.Groups, each limb a capsule whose group origin is its joint), and
// a small motion library poses the whole skeleton from the scene's clock — so the AI schedules motions by name
// (stand, walk, run, wave, nod, point, jump, cheer, clap, talk, dance, turn) and timing instead of hand-keying joints.
//
// Loaded as a browser script (window.__psRig) on 3D pages that use env.character; it needs window.THREE. The pose maths
// (evalPose and the motion library) touch only Math, so they're unit-tested in Node with a fake window; build() and
// the rig it returns touch THREE and are exercised by the real-browser drawing test.
(function () {
  'use strict'
  var PI = Math.PI
  var clamp = function (v, a, b) { return Math.min(b === undefined ? 1 : b, Math.max(a === undefined ? 0 : a, v)) }
  var smooth = function (k) { k = clamp(k); return k * k * (3 - 2 * k) }
  // a raise/hold/lower envelope over a gesture of length dur: 0 → 1 over `up`, hold, → 0 over `down`
  var envelope = function (lt, dur, up, down) {
    up = up || 0.28; down = down || 0.3
    if (lt <= 0 || lt >= dur) return 0
    if (lt < up) return smooth(lt / up)
    if (lt > dur - down) return smooth((dur - lt) / down)
    return 1
  }

  // The skeleton: each joint is a THREE.Group whose origin is the joint, placed at `pivot` in its parent. `rest` is its
  // resting euler (radians); the motion library adds offsets to it. `mesh` builds the limb that hangs off the joint.
  // Proportions scale with the character's height H (metres). Side A = the character's +X side, B = -X.
  function skeleton(H, col) {
    var leg = 0.46 * H, thigh = leg * 0.52, shin = leg * 0.48
    var hipY = leg
    var spineLen = 0.16 * H, chestLen = 0.17 * H
    var arm = 0.36 * H, upper = arm * 0.52, fore = arm * 0.48
    var shoulderW = 0.20 * H, hipW = 0.11 * H, r = 0.05 * H
    var headR = 0.125 * H
    return {
      H: H, hipY: hipY, headR: headR,
      joints: [
        // one smooth torso (on the spine, so it bends at the waist), hips under it; the chest is a pivot only
        { name: 'pelvis', parent: null, pivot: [0, 0, 0], rest: [0, 0, 0], mesh: function (T) { return cap(T, hipW * 1.05, 0.16 * H, col.pants || col.body, 0.01 * H) } },
        { name: 'spine', parent: 'pelvis', pivot: [0, 0.02 * H, 0], rest: [0, 0, 0], mesh: function (T) { return torso(T, 0.125 * H, spineLen + chestLen + 0.06 * H, col.body) } },
        { name: 'chest', parent: 'spine', pivot: [0, spineLen, 0], rest: [0, 0, 0], mesh: function (T) { return new T.Group() } },
        { name: 'head', parent: 'chest', pivot: [0, chestLen + 0.03 * H, 0], rest: [0, 0, 0], mesh: function (T) { return head(T, headR, col) } },
        { name: 'armA', parent: 'chest', pivot: [shoulderW / 2, chestLen - 0.02 * H, 0], rest: [0, 0, -0.14], mesh: function (T) { return cap(T, r * 0.9, upper, col.body, -upper / 2) } },
        { name: 'elbowA', parent: 'armA', pivot: [0, -upper, 0], rest: [0, 0, 0], mesh: function (T) { return limbEnd(T, r * 0.8, fore, col) } },
        { name: 'armB', parent: 'chest', pivot: [-shoulderW / 2, chestLen - 0.02 * H, 0], rest: [0, 0, 0.14], mesh: function (T) { return cap(T, r * 0.9, upper, col.body, -upper / 2) } },
        { name: 'elbowB', parent: 'armB', pivot: [0, -upper, 0], rest: [0, 0, 0], mesh: function (T) { return limbEnd(T, r * 0.8, fore, col) } },
        { name: 'hipA', parent: 'pelvis', pivot: [hipW / 2, 0, 0], rest: [0, 0, 0], mesh: function (T) { return cap(T, r * 1.15, thigh, col.pants || col.body, -thigh / 2) } },
        { name: 'kneeA', parent: 'hipA', pivot: [0, -thigh, 0], rest: [0, 0, 0], mesh: function (T) { return legEnd(T, r, shin, col) } },
        { name: 'hipB', parent: 'pelvis', pivot: [-hipW / 2, 0, 0], rest: [0, 0, 0], mesh: function (T) { return cap(T, r * 1.15, thigh, col.pants || col.body, -thigh / 2) } },
        { name: 'kneeB', parent: 'hipB', pivot: [0, -thigh, 0], rest: [0, 0, 0], mesh: function (T) { return legEnd(T, r, shin, col) } },
      ],
      dims: { thigh: thigh, shin: shin, upper: upper, fore: fore, headR: headR },
    }
  }

  function cap(T, radius, length, color, cy) {
    var g = new T.CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 6, 12)
    var m = new T.Mesh(g, window.__rigMat(color, 'clay'))
    m.position.y = cy || 0
    return m
  }
  // a torso: a capsule a little wider at the shoulders than the waist (scaled), standing up from its origin
  function torso(T, radius, length, color) {
    var m = cap(T, radius, length, color, length / 2)
    m.scale.set(1.12, 1, 0.82)
    return m
  }
  function limbEnd(T, radius, length, col) {
    var grp = new T.Group()
    var f = cap(T, radius, length, col.body, -length / 2); grp.add(f)
    var hand = new T.Mesh(new T.SphereGeometry(radius * 1.5, 16, 12), window.__rigMat(col.skin, 'clay'))
    hand.position.y = -length; grp.add(hand)
    return grp
  }
  function legEnd(T, radius, length, col) {
    var grp = new T.Group()
    grp.add(cap(T, radius * 1.1, length, col.pants || col.body, -length / 2))
    var foot = new T.Mesh(new T.CapsuleGeometry(radius * 1.1, radius * 2.4, 5, 10), window.__rigMat(col.foot, 'clay'))
    foot.rotation.z = PI / 2; foot.rotation.y = -0.2
    foot.position.set(0, -length, radius * 1.6); grp.add(foot)
    return grp
  }
  function head(T, R, col) {
    var g = new T.Group()
    var skull = new T.Mesh(new T.SphereGeometry(R, 32, 24), window.__rigMat(col.skin, 'clay'))
    skull.scale.set(1, 1.05, 0.98); g.add(skull)
    var eye = function (x) {
      var e = new T.Group()
      var white = new T.Mesh(new T.SphereGeometry(R * 0.22, 16, 12), window.__rigMat('#ffffff', 'matte'))
      var pupil = new T.Mesh(new T.SphereGeometry(R * 0.12, 12, 10), window.__rigMat('#241f1d', 'matte'))
      pupil.position.z = R * 0.14; e.add(white, pupil)
      e.position.set(x, R * 0.12, R * 0.9); return e
    }
    g.add(eye(R * 0.38), eye(-R * 0.38))
    // a cap of hair over the top and back of the head
    var hair = new T.Mesh(new T.SphereGeometry(R * 1.04, 32, 16, 0, PI * 2, 0, PI * 0.42), window.__rigMat(col.hair, 'clay'))
    hair.rotation.x = -0.35; g.add(hair)
    var nose = new T.Mesh(new T.SphereGeometry(R * 0.14, 12, 10), window.__rigMat(col.skin, 'clay'))
    nose.position.set(0, -R * 0.05, R * 0.98); g.add(nose)
    return g
  }

  // --- the motion library: each fn adds euler offsets to joints and may move/turn the root -------------------------
  // sink.add(joint, rx, ry, rz) accumulates; sink.root(dy, ry, rx) moves the whole figure. `base: true` means the
  // motion plays until the next base motion (stand/walk/...); the rest are gestures that play once over `dur`.
  var MOTIONS = {
    stand: { base: true, fn: function () {} },
    idle: {
      base: true,
      fn: function (lt, dur, o, s) {
        var b = Math.sin(lt * 1.6)
        s.add('spine', 0.02 * b, 0, 0); s.add('chest', 0.015 * b, 0, 0)
        s.add('head', 0.02 * Math.sin(lt * 1.6 + 0.6), 0.05 * Math.sin(lt * 0.5), 0)
        s.add('armA', 0, 0, -0.05 + 0.05 * Math.sin(lt * 1.1))
        s.add('armB', 0, 0, 0.05 - 0.05 * Math.sin(lt * 1.1))
        s.root(0.012 * b, 0, 0)
      },
    },
    walk: {
      base: true,
      fn: function (lt, dur, o, s) {
        var w = lt * (o.speed || 1) * 4.6
        var sw = Math.sin(w)
        s.add('hipA', 0.55 * sw, 0, 0); s.add('hipB', 0.55 * Math.sin(w + PI), 0, 0)
        s.add('kneeA', 0.9 * Math.max(0, Math.sin(w - 1.2)), 0, 0)
        s.add('kneeB', 0.9 * Math.max(0, Math.sin(w + PI - 1.2)), 0, 0)
        s.add('armA', -0.45 * sw, 0, 0); s.add('armB', -0.45 * Math.sin(w + PI), 0, 0)
        s.add('elbowA', 0.35, 0, 0); s.add('elbowB', 0.35, 0, 0)
        s.add('spine', 0.05, 0.08 * sw, 0)
        s.root(0.03 * Math.abs(sw) - 0.015, 0.05 * sw, 0)
      },
    },
    run: {
      base: true,
      fn: function (lt, dur, o, s) {
        var w = lt * (o.speed || 1) * 7.2
        var sw = Math.sin(w)
        s.add('hipA', 0.95 * sw, 0, 0); s.add('hipB', 0.95 * Math.sin(w + PI), 0, 0)
        s.add('kneeA', 1.3 * Math.max(0, Math.sin(w - 1)), 0, 0)
        s.add('kneeB', 1.3 * Math.max(0, Math.sin(w + PI - 1)), 0, 0)
        s.add('armA', -0.9 * sw, 0, 0); s.add('armB', -0.9 * Math.sin(w + PI), 0, 0)
        s.add('elbowA', 1.1, 0, 0); s.add('elbowB', 1.1, 0, 0)
        s.add('spine', 0.28, 0.12 * sw, 0); s.add('chest', 0.1, 0, 0)
        s.root(0.06 * Math.abs(sw), 0.07 * sw, 0)
      },
    },
    wave: {
      fn: function (lt, dur, o, s) {
        var up = envelope(lt, dur, 0.3, 0.3)
        s.add('armA', 0.1 * up, 0, -2.5 * up)
        s.add('elbowA', 0, 0, (-0.5 + 0.45 * Math.sin(lt * 9)) * up)
        s.add('head', 0, 0, 0.08 * up)
      },
    },
    nod: {
      fn: function (lt, dur, o, s) {
        var e = envelope(lt, dur, 0.2, 0.2)
        s.add('head', (0.22 + 0.22 * Math.cos(lt * 7)) * e, 0, 0)
      },
    },
    shake: {
      fn: function (lt, dur, o, s) {
        var e = envelope(lt, dur, 0.2, 0.2)
        s.add('head', 0, 0.4 * Math.sin(lt * 8) * e, 0)
      },
    },
    point: {
      fn: function (lt, dur, o, s) {
        var up = envelope(lt, dur, 0.25, 0.3)
        var arm = o.arm === 'B' ? 'armB' : 'armA', el = o.arm === 'B' ? 'elbowB' : 'elbowA'
        s.add(arm, -1.5 * up, (o.dir || 0) * up, 0); s.add(el, -0.1 * up, 0, 0)
      },
    },
    jump: {
      fn: function (lt, dur, o, s) {
        var p = clamp(lt / dur)
        var crouch = p < 0.22 ? smooth(p / 0.22) : p < 0.3 ? 1 - smooth((p - 0.22) / 0.08) : 0
        var air = p >= 0.28 && p < 0.72 ? Math.sin((p - 0.28) / 0.44 * PI) : 0
        var land = p >= 0.72 && p < 0.86 ? smooth((p - 0.72) / 0.14) : p >= 0.86 ? 1 - smooth((p - 0.86) / 0.14) : 0
        var bend = crouch * 0.9 + land * 0.7
        s.add('hipA', -bend, 0, 0); s.add('hipB', -bend, 0, 0)
        s.add('kneeA', bend * 1.6, 0, 0); s.add('kneeB', bend * 1.6, 0, 0)
        s.add('armA', -2.2 * air, 0, -0.3 * air); s.add('armB', -2.2 * air, 0, 0.3 * air)
        s.add('spine', -0.15 * bend + 0.1 * air, 0, 0)
        s.root((0.75 * (o.height || 1)) * air - 0.22 * bend, 0, 0)
      },
    },
    cheer: {
      fn: function (lt, dur, o, s) {
        var e = envelope(lt, dur, 0.25, 0.3)
        var b = Math.abs(Math.sin(lt * 5))
        s.add('armA', -2.7 * e, 0, -0.35 * e); s.add('armB', -2.7 * e, 0, 0.35 * e)
        s.add('elbowA', -0.3 * e, 0, 0); s.add('elbowB', -0.3 * e, 0, 0)
        s.add('head', -0.12 * e, 0, 0)
        s.root(0.08 * b * e, 0, 0)
      },
    },
    clap: {
      fn: function (lt, dur, o, s) {
        var e = envelope(lt, dur, 0.2, 0.2)
        var c = (Math.sin(lt * 11) * 0.5 + 0.5)
        s.add('armA', -1.2 * e, 0, (-0.5 - 0.35 * c) * e); s.add('armB', -1.2 * e, 0, (0.5 + 0.35 * c) * e)
        s.add('elbowA', -1.1 * e, 0, 0); s.add('elbowB', -1.1 * e, 0, 0)
      },
    },
    shrug: {
      fn: function (lt, dur, o, s) {
        var e = envelope(lt, dur, 0.3, 0.3)
        s.add('armA', 0.15 * e, 0, -0.55 * e); s.add('armB', 0.15 * e, 0, 0.55 * e)
        s.add('elbowA', -0.7 * e, 0, -0.3 * e); s.add('elbowB', -0.7 * e, 0, 0.3 * e)
        s.add('head', 0.05 * e, 0, 0); s.add('chest', 0.05 * e, 0, 0)
      },
    },
    talk: {
      base: true,
      fn: function (lt, dur, o, s) {
        s.add('head', 0.05 * Math.sin(lt * 3.1), 0.06 * Math.sin(lt * 1.7), 0.02 * Math.sin(lt * 2.3))
        var g = Math.max(0, Math.sin(lt * 1.3))
        s.add('armA', -0.35 * g, 0, -0.2); s.add('elbowA', -0.8 * g - 0.3, 0, 0)
        s.add('armB', 0, 0, 0.1 + 0.05 * Math.sin(lt * 1.1))
        s.root(0.006 * Math.sin(lt * 1.6), 0, 0)
      },
    },
    dance: {
      base: true,
      fn: function (lt, dur, o, s) {
        var w = lt * 3.4
        s.add('spine', 0, 0.12 * Math.sin(w), 0.16 * Math.sin(w))
        s.add('chest', 0, 0.1 * Math.sin(w + 0.4), 0)
        s.add('head', 0.06 * Math.sin(w * 2), 0.1 * Math.sin(w), 0)
        s.add('armA', -0.6 - 0.6 * Math.sin(w), 0, -0.4); s.add('armB', -0.6 + 0.6 * Math.sin(w), 0, 0.4)
        s.add('elbowA', -0.8, 0, 0); s.add('elbowB', -0.8, 0, 0)
        s.add('hipA', 0.15 * Math.sin(w), 0, 0.1 * Math.sin(w)); s.add('hipB', -0.15 * Math.sin(w), 0, 0.1 * Math.sin(w))
        s.root(0.04 * Math.abs(Math.sin(w)), 0.1 * Math.sin(w), 0)
      },
    },
    turn: {
      fn: function (lt, dur, o, s) {
        s.root(0, (o.to || 0) * smooth(clamp(lt / dur)), 0)
        if (lt >= dur) s.root(0, o.to || 0, 0)
      },
    },
    sit: {
      base: true,
      fn: function (lt, dur, o, s) {
        s.add('hipA', -1.5, 0, 0); s.add('hipB', -1.5, 0, 0)
        s.add('kneeA', 1.5, 0, 0); s.add('kneeB', 1.5, 0, 0)
        s.add('spine', 0.1, 0, 0); s.root(-0.42, 0, 0)
        s.add('head', 0.02 * Math.sin(lt * 1.5), 0, 0)
      },
    },
  }

  var MOTION_NAMES = Object.keys(MOTIONS)

  // Pure: given the scheduled base motions and gestures, the pose at time t. Base = the last base motion started by t
  // (idle before any). Gestures are additive while active. Returns joint euler offsets and the root's move/turn.
  function evalPose(bases, gestures, t) {
    var joints = {}
    var root = { y: 0, ry: 0, rx: 0 }
    var sink = {
      add: function (j, x, y, z) { var a = joints[j] || (joints[j] = [0, 0, 0]); a[0] += x || 0; a[1] += y || 0; a[2] += z || 0 },
      root: function (dy, ry, rx) { root.y += dy || 0; root.ry += ry || 0; root.rx += rx || 0 },
    }
    var base = { name: 'idle', start: 0, opts: {} }
    for (var i = 0; i < bases.length; i++) if (bases[i].start <= t + 1e-9 && bases[i].start >= base.start) base = bases[i]
    ;(MOTIONS[base.name] || MOTIONS.idle).fn(t - base.start, Infinity, base.opts || {}, sink)
    for (var g = 0; g < gestures.length; g++) {
      var ge = gestures[g], dur = ge.dur || 1
      if (t >= ge.start - 1e-9 && t <= ge.start + dur + 1e-9) (MOTIONS[ge.name] || MOTIONS.nod).fn(t - ge.start, dur, ge.opts || {}, sink)
    }
    return { joints: joints, root: root }
  }

  // Build the character once and return a rig the scene poses every frame. Needs window.THREE.
  function build(THREE, opts) {
    opts = opts || {}
    var H = opts.height || 1.7
    var col = { body: opts.color || opts.body || '#4a90d9', pants: opts.pants || '#3b4252', skin: opts.skin || '#e8b88f', foot: opts.foot || opts.shoe || '#2e2a33', hair: opts.hair || '#3a2a20' }
    var sk = skeleton(H, col)
    var groups = {}
    var root = new THREE.Group()
    for (var i = 0; i < sk.joints.length; i++) {
      var j = sk.joints[i]
      var grp = new THREE.Group()
      grp.position.set(j.pivot[0], j.pivot[1], j.pivot[2])
      grp.rotation.set(j.rest[0], j.rest[1], j.rest[2])
      grp.userData.rest = j.rest
      var mesh = j.mesh(THREE)
      mesh.traverse(function (n) { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true } })
      grp.add(mesh)
      groups[j.name] = grp
      ;(j.parent ? groups[j.parent] : root).add(grp)
    }
    root.position.y = sk.hipY
    var bases = [{ name: 'idle', start: 0, opts: {} }]
    var gestures = []
    var face = opts.face || 0
    var rig = {
      group: root,
      joints: groups,
      dims: sk.dims,
      height: H,
      motions: MOTION_NAMES,
      // schedule a motion at `start` seconds (a base motion replaces the figure's default pose until the next one)
      play: function (name, start, o) {
        o = o || {}
        if (!MOTIONS[name]) throw new Error('unknown character motion "' + name + '" (try: ' + MOTION_NAMES.join(', ') + ')')
        if (MOTIONS[name].base) bases.push({ name: name, start: start || 0, opts: o })
        else gestures.push({ name: name, start: start || 0, dur: o.dur || 1, opts: o })
        return rig
      },
      face: function (a) { face = a; return rig },
      // pose from the scene's clock; call once per frame after the scene is positioned
      update: function (t) {
        var pose = evalPose(bases, gestures, t)
        for (var k = 0; k < sk.joints.length; k++) {
          var jn = sk.joints[k], off = pose.joints[jn.name], grp = groups[jn.name]
          grp.rotation.set(jn.rest[0] + (off ? off[0] : 0), jn.rest[1] + (off ? off[1] : 0), jn.rest[2] + (off ? off[2] : 0))
        }
        root.position.y = sk.hipY + pose.root.y * H * 0.5
        root.rotation.set(pose.root.rx, face + pose.root.ry, 0)
        return rig
      },
    }
    // convenience: rig.walk(0), rig.wave(2), ...
    MOTION_NAMES.forEach(function (name) { rig[name] = function (start, o) { return rig.play(name, start, o) } })
    return rig
  }

  window.__psRig = { build: build, evalPose: evalPose, motions: MOTION_NAMES, MOTIONS: MOTIONS, skeleton: skeleton }
})()
