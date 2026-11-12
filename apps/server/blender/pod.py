# Producer Studio: the job loop on a rented RunPod graphics card (plain Python 3, outside Blender).
#
# The server never connects to the pod. It writes jobs to its own storage and the pod fetches them: /ps/config.json
# lists presigned download links for job slots 0, 1, 2 ... in order. Each job holds the scene script, its settings and
# presigned upload links for the results. The pod runs Blender on it (harness.py, as on a desktop), uploads what came
# out and result.json last, then waits for the next slot. A "stop" job, no job for idleSeconds, or maxSeconds since
# boot ends it, and the pod deletes itself (runpodctl, RunPod's tool in every pod; or its API with the pod's own key).
# The server deletes the pod too when it's done; this is the safety net if the server goes away mid-job.
#
# Blender gets a clean environment: none of the pod's variables (RUNPOD_API_KEY among them), a fresh folder per job.
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

BLENDER = '/opt/blender/blender'


def terminate():
    pod = os.environ.get('RUNPOD_POD_ID', '')
    if pod:
        for cmd in (['runpodctl', 'remove', 'pod', pod], ['runpodctl', 'pod', 'delete', pod]):
            try:
                if subprocess.run(cmd, timeout=60, capture_output=True).returncode == 0:
                    break
            except Exception:
                pass
        else:
            key = os.environ.get('RUNPOD_API_KEY', '')
            if key:
                try:
                    req = urllib.request.Request('https://rest.runpod.io/v1/pods/' + pod, method='DELETE', headers={'Authorization': 'Bearer ' + key})
                    urllib.request.urlopen(req, timeout=60)
                except Exception:
                    pass
    # if deleting failed, wait to be deleted by the server rather than exit (an exited container is restarted)
    while True:
        time.sleep(3600)


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise


def put(url, data, ctype):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Type': ctype})
            urllib.request.urlopen(req, timeout=600).read()
            return
        except Exception:
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))


def clean_env(work):
    keep = {k: v for k, v in os.environ.items() if k.startswith(('NVIDIA_', 'CUDA_')) or k in ('PATH', 'LANG', 'LD_LIBRARY_PATH')}
    keep.update({'HOME': work, 'TMPDIR': work, 'BLENDER_USER_RESOURCES': work + '/user'})
    return keep


def run_job(n, job):
    work = '/ps/job%d' % n
    shutil.rmtree(work, ignore_errors=True)
    out = work + '/out'
    os.makedirs(out)
    with open(work + '/code.py', 'w', encoding='utf-8') as f:
        f.write(job['code'])
    spec = dict(job['spec'], code_file=work + '/code.py')
    with open(work + '/job.json', 'w', encoding='utf-8') as f:
        json.dump(spec, f)
    tail = ''
    result = None
    try:
        p = subprocess.run([BLENDER, '-b', '--factory-startup', '--disable-autoexec', '-noaudio', '--python-exit-code', '1', '--python', '/ps/harness.py', '--', work + '/job.json', out],
                           timeout=int(job.get('timeout', 1800)), env=clean_env(work), cwd=work, capture_output=True)
        tail = (p.stdout + p.stderr).decode('utf-8', 'replace')[-3000:]
    except subprocess.TimeoutExpired:
        result = {'ok': False, 'error': 'it took longer than %d minutes on the graphics card' % (int(job.get('timeout', 1800)) // 60)}
    if result is None:
        try:
            with open(out + '/result.json', encoding='utf-8') as f:
                result = json.load(f)
        except Exception:
            result = {'ok': False, 'error': 'Blender stopped without a result', 'log': tail[-1500:]}
    uploads = job.get('uploads', {})
    for name, url in uploads.items():
        if name == 'result.json':
            continue
        path = os.path.join(out, name)
        if name == 'video.mp4' and result.get('video'):
            path = os.path.join(out, result['video'])
        if os.path.exists(path):
            with open(path, 'rb') as f:
                put(url, f.read(), 'video/mp4' if name.endswith('.mp4') else 'image/jpeg')
    if result.get('video'):
        result['video'] = 'video.mp4'
    put(uploads['result.json'], json.dumps(result).encode('utf-8'), 'application/json')
    shutil.rmtree(work, ignore_errors=True)


def main():
    with open('/ps/config.json', encoding='utf-8') as f:
        cfg = json.load(f)
    started = time.time()
    last = time.time()
    for n, url in enumerate(cfg['slots']):
        while True:
            data = get(url)
            if data:
                break
            now = time.time()
            if now - last > cfg['idleSeconds'] or now - started > cfg['maxSeconds']:
                terminate()
            time.sleep(2)
        job = json.loads(data)
        if job.get('stop'):
            break
        run_job(n, job)
        last = time.time()
    terminate()


if __name__ == '__main__':
    if '--terminate' in sys.argv:
        terminate()
    main()
