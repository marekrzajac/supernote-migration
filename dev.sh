#!/bin/bash
# Build the plugin and push it to both Supernote devices.
#
# Wraps the official buildPlugin.sh, which needs the `zip` binary for its final
# packaging step. If `zip` is missing we do that step with python3 instead, so
# the build is never blocked on it.
#
# Usage:
#   ./dev.sh            build + push to both devices
#   ./dev.sh build      build only
#   ./dev.sh push       push the existing .snplg
#   ./dev.sh log nomad  stream logs from the Nomad
#   ./dev.sh log manta  stream logs from the Manta

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# adb serials of your two devices. Both report model "Supernote Nomad", so
# they're identified by serial: `adb devices` lists them, and `adb -s <serial>
# shell wm size` tells them apart (Nomad 1404x1872, Manta 1920x2560).
# Put them in dev.local.sh (not committed) or export NOMAD / MANTA.
[[ -f dev.local.sh ]] && source dev.local.sh
: "${NOMAD:?set NOMAD to your Nomad's adb serial (see dev.local.sh.example)}"
: "${MANTA:?set MANTA to your Manta's adb serial (see dev.local.sh.example)}"

NAME="$(python3 -c "import json;print(json.load(open('package.json'))['name'])")"
# buildPlugin.sh names its output after the package (the internal key,
# NomadManta). The file people install is named after the plugin's display name
# instead; the device reads the plugin's identity from PluginConfig.json inside,
# not from the file name.
BUILT="build/outputs/$NAME.snplg"
SNPLG="build/outputs/Migration.snplg"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk}"

# Supernote's plugin manager appears to skip re-installing a plugin whose
# pluginID and versionCode are unchanged — you re-add it and silently keep the
# old build. Bumping versionCode every build makes updates always take effect.
bump_version() {
    python3 - <<'PY'
import json
p = "PluginConfig.json"
with open(p) as f:
    cfg = json.load(f)
code = int(cfg.get("versionCode", "0") or 0) + 1
cfg["versionCode"] = str(code)
# Keep versionName in step so the device UI shows something distinguishable.
cfg["versionName"] = f"0.0.{code}"
with open(p, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f">>> versionCode -> {code} (versionName {cfg['versionName']})")
PY
}

do_build() {
    echo ">>> building $NAME"
    bump_version
    # buildPlugin.sh returns non-zero from its zip step when zip is absent;
    # the bundle and config are already written by then, so tolerate it.
    ./buildPlugin.sh || true

    if [[ ! -f "$BUILT" ]] || [[ build/generated -nt "$BUILT" ]]; then
        echo ">>> packaging with python3 (zip binary not used)"
        mkdir -p build/outputs
        python3 - "$BUILT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
src = "build/generated"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, src))
print(f"packaged {out} ({os.path.getsize(out)} bytes)")
PY
    fi

    cp "$BUILT" "$SNPLG"
    echo ">>> contents:"
    unzip -l "$SNPLG" | sed 's/^/    /'
}

do_push() {
    [[ -f "$SNPLG" ]] || { echo "no $SNPLG — run ./dev.sh build first" >&2; exit 1; }
    for s in "$NOMAD" "$MANTA"; do
        printf '>>> pushing to %s ... ' "$s"
        adb -s "$s" push "$SNPLG" /storage/emulated/0/MyStyle/ >/dev/null && echo "ok"
    done
    echo
    echo "Now install on each device: Settings > Apps > Plugins > Add Plugin"
}

do_log() {
    case "${1:-}" in
        nomad) s="$NOMAD" ;;
        manta) s="$MANTA" ;;
        *) echo "usage: ./dev.sh log {nomad|manta}" >&2; exit 1 ;;
    esac
    adb -s "$s" logcat -c
    echo ">>> streaming ReactNativeJS from $1 ($s) — Ctrl-C to stop"
    adb -s "$s" logcat -s ReactNativeJS:V
}

case "${1:-all}" in
    all)   do_build; do_push ;;
    build) do_build ;;
    push)  do_push ;;
    log)   do_log "${2:-}" ;;
    *)     echo "usage: ./dev.sh [all|build|push|log {nomad|manta}]" >&2; exit 1 ;;
esac
