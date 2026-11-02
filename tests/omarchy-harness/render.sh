#!/usr/bin/env bash
#
# Render the AI Usage panel offscreen to PNGs, against fixture records, with
# Omarchy's real Commons/Ui components and the current (or a light) theme.
#
# Nothing here touches the running Omarchy shell: the harness is a separate
# Quickshell instance on the offscreen platform, with HOME and XDG_STATE_HOME
# pointed at a throwaway directory, so it reads only fixtures and writes only
# under that directory.
#
#   tests/omarchy-harness/render.sh [out-dir] [--light] [--records <dir>] [--scenarios a,b,...]
#
# Omarchy's shell components come from $OMARCHY_SHELL (default
# ~/.local/share/omarchy/shell); the built-in Agents plugin for the
# side-by-side "builtin" scenarios from $OMARCHY_SHELL/plugins/agents.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$HERE/../.." && pwd)"
OUT="${1:-/tmp/pi-usage-harness-out}"
shift || true
LIGHT=false
RECORDS=""
SCENARIOS="default,all-collapsed,all-expanded,scroll-middle,scroll-bottom,cursor,keys,builtin,builtin-2,builtin-3"
while (( $# > 0 )); do
  case "$1" in
    --light) LIGHT=true ;;
    --records) RECORDS="$2"; shift ;;
    --scenarios) SCENARIOS="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

OMARCHY_SHELL="${OMARCHY_SHELL:-$HOME/.local/share/omarchy/shell}"
REAL_HOME="$HOME"
WORK="$(mktemp -d /tmp/pi-usage-harness-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

ROOT="$WORK/root"
FAKE_HOME="$WORK/home"
STATE="$FAKE_HOME/.local/state"
USAGE="$STATE/omarchy/agents/usage"
mkdir -p "$ROOT" "$USAGE" "$WORK/no-omarchy/bin" "$STATE/omarchy/current" "$FAKE_HOME/.config" "$OUT"

ln -s "$OMARCHY_SHELL/Commons" "$ROOT/Commons"
ln -s "$OMARCHY_SHELL/Ui" "$ROOT/Ui"
ln -s "$REPO/omarchy/cad0p.pi-usage" "$ROOT/plugin"
cp "$HERE/shell.qml" "$ROOT/shell.qml"

# The built-in panel without its popup: KeyboardPanel becomes a plain Item that
# fills the card, and its Panel root exposes the content height.
mkdir -p "$ROOT/builtin"
cp -R "$OMARCHY_SHELL/plugins/agents/." "$ROOT/builtin/"
python3 - "$ROOT/builtin/Panel.qml" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
start = s.index("  KeyboardPanel {")
end = s.index("    PanelKeyCatcher {", start)
s = s[:start] + "  readonly property real panelContentHeight: column.implicitHeight\n  Item {\n    id: panel\n    anchors.fill: parent\n\n" + s[end:]
s = s.replace("  visible: providers.length > 0\n", "")
s = s.replace("  BarIconButton {\n    id: button\n    anchors.fill: parent\n", "  BarIconButton {\n    id: button\n    visible: false\n")
open(path, "w").write(s)
PY

# Theme: the user's current one, or a light palette. The generated shell.toml
# carries the current palette as literal hex values, so for --light every
# colour is translated key by key (foreground, background, accent, ...) from
# the current colors.toml to flexoki-light's.
THEME="$STATE/omarchy/current/theme"
mkdir -p "$THEME"
CURRENT_THEME="$REAL_HOME/.local/state/omarchy/current/theme"
cp "$CURRENT_THEME/shell.toml" "$THEME/" 2>/dev/null || true
if [[ "$LIGHT" == "true" ]]; then
  LIGHT_COLORS="$REAL_HOME/.local/share/omarchy/themes/flexoki-light/colors.toml"
  cp "$LIGHT_COLORS" "$THEME/colors.toml"
  if [[ -f "$THEME/shell.toml" ]]; then
    python3 - "$CURRENT_THEME/colors.toml" "$LIGHT_COLORS" "$THEME/shell.toml" <<'PY'
import re, sys
def palette(path):
    out = {}
    for line in open(path):
        m = re.match(r'\s*([a-z_]+)\s*=\s*"(#[0-9A-Fa-f]{6})"', line)
        if m: out[m.group(1)] = m.group(2)
    return out
dark, light = palette(sys.argv[1]), palette(sys.argv[2])
mapping = {}
for key in ("foreground", "background", "accent"):
    if key in dark and key in light: mapping[dark[key].lower()] = light[key]
for key, value in dark.items():
    if key in light: mapping.setdefault(value.lower(), light[key])
path = sys.argv[3]
text = open(path).read()
text = re.sub(r'#[0-9A-Fa-f]{6}', lambda m: mapping.get(m.group(0).lower(), m.group(0)), text)
open(path, "w").write(text)
PY
  fi
else
  cp "$REAL_HOME/.local/state/omarchy/current/theme/colors.toml" "$THEME/colors.toml"
fi
# The shell font is fontconfig's monospace alias, configured per user.
if [[ -d "$REAL_HOME/.config/fontconfig" ]]; then ln -s "$REAL_HOME/.config/fontconfig" "$FAKE_HOME/.config/fontconfig"; fi

if [[ -n "$RECORDS" ]]; then
  cp "$RECORDS"/*.json "$USAGE/"
else
  node "$HERE/fixtures.mjs" "$USAGE" >/dev/null
fi

PREFIX=""
if [[ "$LIGHT" == "true" ]]; then PREFIX="light-"; fi

# OMARCHY_PATH points at an empty directory: the built-in Main.qml runs
# omarchy-agent-usage-update on start, which runs every
# $OMARCHY_PATH/bin/omarchy-agent-usage-* collector (an empty OMARCHY_PATH
# would make that /bin, where Omarchy installs them), so with none there it
# writes nothing over the fixtures. The display
# variables are dropped so nothing can reach the running compositor.
env -u WAYLAND_DISPLAY -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u QS_CONFIG_PATH \
  -u QT_QPA_PLATFORMTHEME -u QT_IM_MODULE -u GDK_BACKEND \
  HOME="$FAKE_HOME" XDG_STATE_HOME="$STATE" XDG_CONFIG_HOME="$FAKE_HOME/.config" \
  XDG_CACHE_HOME="$WORK/cache" OMARCHY_PATH="$WORK/no-omarchy" PI_QUOTA_OMARCHY_DIR="$USAGE" \
  QT_QPA_PLATFORM=offscreen HARNESS_OUT="$OUT" HARNESS_SCENARIOS="$SCENARIOS" HARNESS_PREFIX="$PREFIX" \
  timeout 60 qs -p "$ROOT" 2>&1 | tee "$OUT/${PREFIX}harness.log" || true
