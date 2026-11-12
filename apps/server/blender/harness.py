# Producer Studio: runs one Blender scene script the space's AI wrote, inside Blender (background mode).
#
#   blender -b --factory-startup --disable-autoexec -noaudio --python-exit-code 1 --python harness.py -- job.json out/
#
# job.json: {"code_file", "mode": "test"|"render", "width", "height", "fps", "duration", "frames": [test frame numbers],
#            "words": [{"w", "start"}], "palette": {"canvas", "ink", "accent"}, "engine": "auto"|"eevee"|"cycles"}
# out/:     result.json, test-<i>.jpg (test) or one .mp4 (render). "PS_FRAME n/N" lines on stdout while rendering.
#
# The code is the model's, and the model read text a person typed, so it is treated as hostile. Before it runs it is
# parsed and refused if it imports anything but bpy, bmesh, mathutils, math, random and colorsys, names a builtin that
# reaches outside (open, exec, eval, getattr, __import__ ...), touches any attribute starting with "_", or reaches parts
# of Blender that read or write files, run scripts or register callbacks (bpy.utils, bpy.app, preferences, texts,
# libraries, filepath, drivers' expressions, operators outside modelling and animation). While it runs, a Python audit
# hook refuses files, imports, processes and the network; afterwards (rendering) processes and the network stay
# refused. Blender itself runs with factory settings and auto-run scripts off, from a throwaway folder, with no
# secrets in its environment. The parent process enforces the time limit.
#
# Run with plain Python as `python harness.py --check code.py` it only parses the code and prints the problems as JSON
# (used by the tests).

import ast
import json
import sys

ALLOWED_IMPORTS = {'bpy', 'bmesh', 'mathutils', 'math', 'random', 'colorsys'}
BANNED_NAMES = {
    'exec', 'eval', 'compile', 'open', 'getattr', 'setattr', 'delattr', 'globals', 'locals', 'vars', '__import__',
    'breakpoint', 'input', 'help', 'exit', 'quit', 'memoryview', 'super',
}
BANNED_ATTRS = {
    'utils', 'app', 'preferences', 'handlers', 'driver_namespace', 'texts', 'libraries', 'filepath', 'filepath_raw',
    'save', 'save_render', 'save_as', 'pack', 'unpack', 'reload', 'as_module', 'load', 'write', 'expression', 'msgbus',
    'window_manager', 'keyconfigs', 'addons', 'format', 'format_map', 'script', 'scripts', 'cache_file', 'cache_files',
    'directory', 'files', 'temp_override',
}
# bpy.ops.<these> only: building, modelling and animating. Never wm, script, text, render, image, file, export/import.
OPS_OK = {
    'mesh', 'object', 'curve', 'curves', 'surface', 'transform', 'material', 'armature', 'pose', 'constraint', 'anim',
    'uv', 'node', 'geometry', 'collection', 'rigidbody', 'particle', 'font', 'lattice', 'grease_pencil', 'world',
}


BANNED_PREFIXES = ('load', 'save', 'export', 'import', 'open', 'write', 'read', 'exec', 'run', 'install')


def banned_name(name):
    """An attribute or keyword argument that reads, writes or runs something (files, paths, scripts)."""
    n = name.lower()
    return n in BANNED_ATTRS or n.startswith(BANNED_PREFIXES) or 'file' in n or 'path' in n or 'dir' in n


def check(code):
    """The reasons this code won't be run (empty: it may run)."""
    try:
        tree = ast.parse(code, 'scene.py')
    except SyntaxError as e:
        return ['line %s: SyntaxError: %s' % (e.lineno, e.msg)]
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    problems = []

    def bad(node, why):
        problems.append('line %s: %s' % (getattr(node, 'lineno', '?'), why))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.split('.')[0] not in ALLOWED_IMPORTS:
                    bad(node, 'import %s is not allowed (only %s)' % (a.name, ', '.join(sorted(ALLOWED_IMPORTS))))
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or '').split('.')[0] not in ALLOWED_IMPORTS:
                bad(node, 'from %s import is not allowed' % (node.module or '.'))
        elif isinstance(node, ast.Name):
            if node.id in BANNED_NAMES or node.id.startswith('__'):
                bad(node, '%s is not allowed here' % node.id)
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith('_'):
                bad(node, 'attributes starting with _ are not allowed (%s)' % node.attr)
            elif banned_name(node.attr):
                bad(node, '.%s is not allowed here' % node.attr)
            elif node.attr == 'ops':
                up = parents.get(node)
                if not (isinstance(up, ast.Attribute) and up.value is node and up.attr in OPS_OK):
                    bad(node, 'bpy.ops may only be used as bpy.ops.<%s>.<operator>(...)' % '|'.join(sorted(OPS_OK)))
        elif isinstance(node, ast.keyword) and node.arg and banned_name(node.arg):
            bad(parents.get(node, node), 'the argument %s= is not allowed here' % node.arg)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            bad(node, 'global and nonlocal are not allowed')
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and '__' in node.value:
            bad(node, 'strings containing __ are not allowed')
    if not problems:
        defs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'build']
        if not defs:
            problems.append('the code must define def build(scene, env):')
    return problems[:40]


# --- the sandbox while the model's code runs -------------------------------------------------------------------------

STATE = {'armed': False, 'locked': False, 'execs': 0}
ALWAYS_BLOCKED = ('socket.', 'subprocess.', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.fork', 'os.forkpty',
                  'ctypes.', 'winreg.', 'webbrowser.', 'urllib.', 'http.', 'ftplib.', 'smtplib.', 'poplib.', 'imaplib.',
                  'nntplib.', 'telnetlib.', '_winapi.', 'msvcrt.')
ARMED_BLOCKED = ALWAYS_BLOCKED + ('open', 'os.', 'shutil.', 'glob.', 'pathlib.', 'tempfile.', 'compile', 'code.__new__',
                                  'function.__new__', 'sys.', 'marshal.', 'pickle.', 'sqlite3.', 'mmap.', 'array.')


def audit(event, args):
    if STATE['armed']:
        if event == 'exec':
            STATE['execs'] += 1
            if STATE['execs'] == 1:
                return
            raise RuntimeError('blocked: exec')
        if event == 'import':
            name = str(args[0] or '')
            if name.split('.')[0] in ALLOWED_IMPORTS or name in ('encodings', 'codecs'):
                return
            raise RuntimeError('blocked: import %s' % name)
        if event.startswith(ARMED_BLOCKED) or event == 'open':
            raise RuntimeError('blocked: %s' % event)
    elif STATE['locked'] and event.startswith(ALWAYS_BLOCKED):
        raise RuntimeError('blocked: %s' % event)


def safe_builtins():
    import builtins

    real_import = builtins.__import__

    def limited_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level or name.split('.')[0] not in ALLOWED_IMPORTS:
            raise ImportError('import %s is not allowed' % name)
        return real_import(name, globals, locals, fromlist, level)

    out = {k: v for k, v in vars(builtins).items() if not k.startswith('_') and k not in BANNED_NAMES}
    out['__import__'] = limited_import
    out['__build_class__'] = builtins.__build_class__
    out['__name__'] = 'builtins'
    return out


# --- what the code gets: env ------------------------------------------------------------------------------------------


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgba(color, alpha=1.0):
    """'#rrggbb', (r, g, b) or (r, g, b, a) in 0..1 sRGB → linear RGBA for Blender."""
    if isinstance(color, str):
        h = color.strip().lstrip('#')
        if len(h) == 3:
            h = ''.join(ch * 2 for ch in h)
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)
    t = tuple(float(x) for x in color)
    if len(t) == 3:
        t = t + (alpha,)
    return (srgb_to_linear(t[0]), srgb_to_linear(t[1]), srgb_to_linear(t[2]), t[3])


class Env:
    """Everything the scene script needs: the frame, the clock, the narration's words, the palette and helpers."""

    def __init__(self, job, bpy, mathutils):
        self.bpy_ = bpy
        self.mu_ = mathutils
        self.W = int(job['width'])
        self.H = int(job['height'])
        self.fps = int(job['fps'])
        self.duration = float(job['duration'])
        self.frames = max(1, int(round(self.duration * self.fps)))
        self.words = [(str(w['w']), float(w['start'])) for w in job.get('words', [])]
        p = job['palette']
        self.palette = {k: rgba(v) for k, v in p.items()}
        self.hex = dict(p)
        self.vertical = self.H > self.W

    def frame(self, seconds):
        """The frame number (1-based) at `seconds` from the scene's start."""
        return 1 + int(round(max(0.0, float(seconds)) * self.fps))

    def seconds(self, frame):
        return (float(frame) - 1) / self.fps

    def word_at(self, word, default=None):
        """Seconds at which the narration first says `word` (any case, punctuation ignored), else `default`."""
        clean = lambda s: ''.join(ch for ch in s.lower() if ch.isalnum())
        want = clean(word)
        for w, t in self.words:
            if clean(w) == want:
                return t
        return default

    def color(self, c, alpha=1.0):
        return rgba(self.hex.get(c, c) if isinstance(c, str) else c, alpha)

    def material(self, color, kind='plastic', name=None):
        """A Principled material: clay, plastic, glossy, metal, glass, matte, glow (emission) or toon."""
        bpy = self.bpy_
        m = bpy.data.materials.new(name or ('%s-%s' % (kind, color if isinstance(color, str) else 'rgb')))
        try:
            m.use_nodes = True  # always on (and deprecated) in Blender 5
        except Exception:
            pass
        b = m.node_tree.nodes.get('Principled BSDF')
        col = self.color(color)

        def put(name, value):
            if name in b.inputs:
                b.inputs[name].default_value = value

        put('Base Color', col)
        settings = {
            'clay': {'Roughness': 0.85, 'Subsurface Weight': 0.15, 'Specular IOR Level': 0.3},
            'plastic': {'Roughness': 0.35},
            'glossy': {'Roughness': 0.12, 'Coat Weight': 1.0, 'Coat Roughness': 0.05},
            'metal': {'Metallic': 1.0, 'Roughness': 0.25},
            'glass': {'Transmission Weight': 1.0, 'Roughness': 0.04, 'IOR': 1.45},
            'matte': {'Roughness': 0.95, 'Specular IOR Level': 0.2},
            'glow': {'Emission Strength': 5.0, 'Roughness': 0.5},
            'toon': {'Roughness': 1.0, 'Specular IOR Level': 0.0},
        }.get(kind, {'Roughness': 0.4})
        for k, v in settings.items():
            put(k, v)
        if kind == 'glow':
            put('Emission Color', col)
        return m

    def look_at(self, obj, target):
        """Point a camera or light (or anything) at a point or an object."""
        mu = self.mu_
        t = target.location if hasattr(target, 'location') else mu.Vector(target)
        d = mu.Vector(t) - obj.location
        obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

    def key(self, idblock, path, frame, value=None, index=-1):
        """Set `idblock.<path>` to `value` (when given) and keyframe it at `frame` (Bezier: eases in and out)."""
        if value is not None:
            owner, attr = idblock, path
            if '.' in path:
                head, attr = path.rsplit('.', 1)
                owner = idblock.path_resolve(head)
            if index >= 0:
                getattr(owner, attr)[index] = value
            else:
                setattr(owner, attr, value)
        idblock.keyframe_insert(data_path=path, frame=frame, index=index)

    def fcurves(self, idblock):
        ad = idblock.animation_data
        if not ad or not ad.action:
            return []
        act = ad.action
        out = []
        layers = list(getattr(act, 'layers', []) or [])
        if layers:
            slot = getattr(ad, 'action_slot', None)
            for layer in layers:
                for strip in layer.strips:
                    cb = strip.channelbag(slot) if slot is not None else None
                    if cb is not None:
                        out.extend(cb.fcurves)
        if not out and hasattr(act, 'fcurves'):
            try:
                out = list(act.fcurves)
            except Exception:
                out = []
        return out

    def interpolate(self, idblock, kind='BEZIER', easing='AUTO'):
        """Every keyframe of idblock eased the same way: BEZIER, LINEAR, CONSTANT, BACK, ELASTIC, BOUNCE, SINE, CUBIC ...
        easing: AUTO, EASE_IN, EASE_OUT, EASE_IN_OUT."""
        for fc in self.fcurves(idblock):
            for kp in fc.keyframe_points:
                kp.interpolation = kind
                kp.easing = easing

    def stage(self, backdrop=True, camera=(0.0, -9.0, 2.4), target=(0.0, 0.0, 1.0), lens=50):
        """A lit studio: a curved backdrop in the canvas colour, a soft key light, fill and rim, a camera. Returns an
        object with .camera .key .fill .rim .floor (floor is None without a backdrop)."""
        bpy = self.bpy_
        mu = self.mu_
        scene = bpy.context.scene
        world = scene.world or bpy.data.worlds.new('World')
        scene.world = world
        try:
            world.use_nodes = True
        except Exception:
            pass
        bg = world.node_tree.nodes.get('Background') if world.node_tree else None
        if bg:
            bg.inputs[0].default_value = self.palette['canvas']
            bg.inputs[1].default_value = 0.35

        class Stage:
            pass

        st = Stage()
        st.floor = None
        if backdrop:
            bpy.ops.mesh.primitive_plane_add(size=1)
            floor = bpy.context.active_object
            floor.name = 'Backdrop'
            me = floor.data
            import bmesh
            import math as m_
            bm = bmesh.new()
            # a cyclorama: a floor that curves up into a back wall, no seam (y back, z up)
            verts_rows = []
            for i in range(0, 13):
                a = (i / 12) * (m_.pi / 2)
                verts_rows.append((4.0 + 3.0 * m_.sin(a), 3.0 * (1 - m_.cos(a))))
            rows = [(-30.0, 0.0)] + verts_rows + [(7.0, 20.0)]
            grid = []
            for (y, z) in rows:
                grid.append([bm.verts.new((x, y, z)) for x in (-30.0, 30.0)])
            for i in range(len(grid) - 1):
                bm.faces.new((grid[i][0], grid[i][1], grid[i + 1][1], grid[i + 1][0]))
            bm.to_mesh(me)
            bm.free()
            for poly in me.polygons:
                poly.use_smooth = True
            floor.data.materials.append(self.material(self.hex.get('canvas', '#dddddd'), 'matte', 'Backdrop'))
            st.floor = floor

        def area(name, energy, size, loc, color=(1, 1, 1)):
            ld = bpy.data.lights.new(name, 'AREA')
            ld.energy = energy
            ld.size = size
            ld.color = color
            ob = bpy.data.objects.new(name, ld)
            scene.collection.objects.link(ob)
            ob.location = loc
            self.look_at(ob, target)
            return ob

        st.key = area('Key', 900, 4.0, (-4.5, -5.0, 6.5))
        st.fill = area('Fill', 250, 6.0, (5.5, -4.0, 3.0), (0.92, 0.96, 1.0))
        st.rim = area('Rim', 600, 3.0, (2.5, 5.0, 5.5), (1.0, 0.95, 0.88))
        cd = bpy.data.cameras.new('Camera')
        cd.lens = lens
        cam = bpy.data.objects.new('Camera', cd)
        scene.collection.objects.link(cam)
        cam.location = mu.Vector(camera)
        self.look_at(cam, target)
        scene.camera = cam
        st.camera = cam
        return st


# --- the run ------------------------------------------------------------------------------------------------------------


def write(out, result):
    import os
    with open(os.path.join(out, 'result.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f)


def where(exc):
    """'line N: Type: message' for an error raised in the model's code (its line), else 'Type: message'."""
    import traceback
    line = None
    for fr in traceback.extract_tb(exc.__traceback__):
        if fr.filename == 'scene.py':
            line = fr.lineno
    msg = '%s: %s' % (type(exc).__name__, str(exc)[:300])
    return ('line %s: %s' % (line, msg)) if line else msg


def engines(bpy):
    ids = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    eevee = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in ids else 'BLENDER_EEVEE'
    return eevee, 'CYCLES'


def use_cycles(bpy, scene, samples):
    scene.render.engine = 'CYCLES'
    device = 'CPU'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for kind in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
            try:
                prefs.compute_device_type = kind
            except Exception:
                continue
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == kind
                device = kind
                break
    except Exception:
        pass
    scene.cycles.device = 'GPU' if device != 'CPU' else 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    try:
        scene.cycles.denoiser = 'OPTIX' if device == 'OPTIX' else 'OPENIMAGEDENOISE'
    except Exception:
        pass
    scene.render.use_persistent_data = True
    return 'cycles-' + device.lower()


def use_eevee(bpy, scene, samples):
    eevee, _ = engines(bpy)
    scene.render.engine = eevee
    try:
        scene.eevee.taa_render_samples = samples
    except Exception:
        pass
    for k, v in (('use_raytracing', True), ('use_shadows', True), ('use_gtao', True)):
        try:
            setattr(scene.eevee, k, v)
        except Exception:
            pass
    return 'eevee'


def image_out(scene, kind):
    s = scene.render.image_settings
    try:
        s.media_type = 'VIDEO' if kind == 'video' else 'IMAGE'
    except Exception:
        pass
    if kind == 'video':
        s.file_format = 'FFMPEG'
        f = scene.render.ffmpeg
        f.format = 'MPEG4'
        f.codec = 'H264'
        f.constant_rate_factor = 'HIGH'
        f.ffmpeg_preset = 'GOOD'
        try:
            f.audio_codec = 'NONE'
        except Exception:
            pass
    else:
        s.file_format = 'JPEG'
        s.quality = 88


def main():
    import os
    import time
    argv = sys.argv[sys.argv.index('--') + 1:]
    job = json.load(open(argv[0], encoding='utf-8'))
    out = argv[1]
    os.makedirs(out, exist_ok=True)
    started = time.time()
    code = open(job['code_file'], encoding='utf-8').read()
    problems = check(code)
    if problems:
        write(out, {'ok': False, 'error': 'the code was refused: ' + '; '.join(problems)})
        return
    import bpy
    import mathutils
    sys.addaudithook(audit)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.resolution_x = int(job['width'])
    scene.render.resolution_y = int(job['height'])
    scene.render.resolution_percentage = 100
    scene.render.fps = int(job['fps'])
    env = Env(job, bpy, mathutils)
    scene.frame_start = 1
    scene.frame_end = env.frames
    compiled = compile(code, 'scene.py', 'exec')
    g = {'__name__': 'scene', '__builtins__': safe_builtins()}
    try:
        STATE['armed'] = True
        STATE['locked'] = True
        exec(compiled, g)
        build = g.get('build')
        if not callable(build):
            raise RuntimeError('the code must define def build(scene, env):')
        build(scene, env)
    except Exception as e:
        STATE['armed'] = False
        write(out, {'ok': False, 'error': where(e)})
        return
    finally:
        STATE['armed'] = False
    # what the code may have changed that only this harness decides
    scene.render.resolution_x = int(job['width'])
    scene.render.resolution_y = int(job['height'])
    scene.render.fps = int(job['fps'])
    scene.render.fps_base = 1
    scene.frame_start = 1
    scene.frame_end = env.frames
    scene.render.film_transparent = False
    if scene.camera is None:
        write(out, {'ok': False, 'error': 'the scene has no camera (scene.camera): call env.stage() or set one'})
        return
    test = job.get('mode') == 'test'
    want = job.get('engine', 'auto')
    scene.render.resolution_percentage = 50 if test else 100
    scene.render.use_motion_blur = not test

    def setup(which):
        if which == 'cycles':
            return use_cycles(bpy, scene, 24 if test else 96)
        return use_eevee(bpy, scene, 16 if test else 64)

    order = ['cycles'] if want == 'cycles' else ['eevee'] if want == 'eevee' else ['eevee', 'cycles']
    last_error = None
    for which in order:
        try:
            used = setup(which)
            if test:
                image_out(scene, 'image')
                shots = []
                for i, f in enumerate(job.get('frames', [1])):
                    scene.frame_set(max(1, min(env.frames, int(f))))
                    path = os.path.join(out, 'test-%d.jpg' % i)
                    scene.render.filepath = path
                    bpy.ops.render.render(write_still=True)
                    if not os.path.exists(path):
                        raise RuntimeError('no image was rendered')
                    shots.append(os.path.basename(path))
                write(out, {'ok': True, 'frames': shots, 'engine': used, 'version': bpy.app.version_string, 'seconds': round(time.time() - started, 1)})
            else:
                image_out(scene, 'video')
                scene.render.filepath = os.path.join(out, 'scene')
                total = env.frames

                def tick(sc, *_):
                    print('PS_FRAME %d/%d' % (sc.frame_current, total), flush=True)

                bpy.app.handlers.render_post.append(tick)
                bpy.ops.render.render(animation=True)
                bpy.app.handlers.render_post.remove(tick)
                videos = [n for n in os.listdir(out) if n.lower().endswith('.mp4')]
                if not videos:
                    raise RuntimeError('no video was rendered')
                write(out, {'ok': True, 'video': videos[0], 'engine': used, 'version': bpy.app.version_string, 'seconds': round(time.time() - started, 1)})
            return
        except Exception as e:
            last_error = e
            print('PS_ENGINE_FAILED %s %s' % (which, e), flush=True)
    write(out, {'ok': False, 'error': 'Blender could not render it: %s' % where(last_error), 'render': True})


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '--check':
        print(json.dumps(check(open(sys.argv[2], encoding='utf-8').read())))
    else:
        main()
