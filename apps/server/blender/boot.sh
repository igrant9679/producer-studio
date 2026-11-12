#!/bin/bash
# Producer Studio: starts a rented RunPod graphics card for Blender scenes. Runs once, as the pod's start command,
# after /ps/config.json, /ps/pod.py and /ps/harness.py were written from the manifest (media/blender/runpod.ts).
# Installs the few system libraries Blender needs, downloads Blender from download.blender.org, checks its SHA-256,
# says it's ready (boot.json, through a presigned upload), then hands over to pod.py, which runs the jobs.
set -euo pipefail
cfg() { python3 -c "import json,sys; print(json.load(open('/ps/config.json'))[sys.argv[1]])" "$1"; }
BOOT_URL="$(cfg bootUrl)"
report() { curl -fsS -m 60 -X PUT -H 'Content-Type: application/json' --data-binary "$1" "$BOOT_URL" >/dev/null || true; }
trap 'report "{\"ok\":false,\"error\":\"the graphics card could not be set up (step at line $LINENO)\"}"; python3 /ps/pod.py --terminate' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends libxi6 libxkbcommon0 libxrender1 libxxf86vm1 libxfixes3 libsm6 libice6 \
  libgl1 libegl1 libglu1-mesa libx11-6 libxext6 xz-utils curl ca-certificates >/dev/null
mkdir -p /opt/blender
cd /opt
curl -fsSL -m 900 -o blender.tar.xz "$(cfg blenderUrl)"
echo "$(cfg blenderSha256)  blender.tar.xz" | sha256sum -c - >/dev/null
tar -xJf blender.tar.xz -C /opt/blender --strip-components=1
rm -f blender.tar.xz
GPU="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1 || echo unknown)"
VERSION="$(/opt/blender/blender -b --factory-startup -noaudio --version 2>/dev/null | head -n1 || echo Blender)"
report "{\"ok\":true,\"gpu\":\"${GPU//\"/}\",\"version\":\"${VERSION//\"/}\"}"
trap - ERR
exec python3 /ps/pod.py
