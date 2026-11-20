#!/usr/bin/env bash
# Live Agnes verification — run this where you have real internet egress.
#
#   export AGNES_API_KEY='...'
#   ./live-smoke-test.sh
#
# Costs: the cheapest possible real generation on the free model, 4 seconds at
# 720P. On the trial tier that is $0. It never touches a paid model.
#
# Steps: reachability -> key validity -> payload dry run -> one real 4s video
#        -> poll -> download -> byte check.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="node $HERE/bin/agnes-video.mjs"
OUT="${AGNES_GENERATED_DIR:-$HOME/.agnes-arena}/smoke"
pass=0; fail=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [[ -z "${AGNES_API_KEY:-}" ]]; then
  echo "AGNES_API_KEY is not set in this shell."
  echo "  export AGNES_API_KEY='...'   # https://platform.agnes-ai.com/settings/apiKeys"
  echo "Refusing to continue: this script only tests with your own key, and never prints it."
  exit 2
fi

step "1. reachability + key validity (doctor)"
if $CLI doctor; then ok "doctor returned healthy"; else
  bad "doctor failed — either no egress to apihub.agnes-ai.com, or the key was rejected"
  echo
  echo "If the message says 'Could not reach', this environment has no route to Agnes."
  echo "Run this script somewhere with normal internet access. Nothing was charged."
  exit 1
fi

step "2. payload construction (no request sent)"
if $CLI produce --prompt "smoke test" --seconds 4 --dry-run --json >/tmp/agnes_dryrun.json 2>/dev/null; then
  ok "dry run built a payload"
  node -e '
    const p = require("/tmp/agnes_dryrun.json").payload;
    const bad = ["num_frames","frame_rate","width","height"].filter(k => k in p);
    if (bad.length) { console.error("  retired params present: " + bad.join(",")); process.exit(1); }
    if (p.seconds !== "4") { console.error("  seconds must be a string"); process.exit(1); }
    if (p.model !== "agnes-video-2.5-flash") { console.error("  wrong model"); process.exit(1); }
  ' && ok "payload matches the 2.5 contract" || bad "payload shape is wrong"
else
  bad "dry run failed"
fi

step "3. one real 4s generation on the free model"
mkdir -p "$OUT"
if $CLI produce \
  --prompt "A single soap bubble drifting across a sunlit window, slow camera push in, soft daylight, subtle motion" \
  --seconds 4 --aspect 16:9 --out "$OUT" --timeout 900 --json >/tmp/agnes_live.json 2>/tmp/agnes_live.err; then
  ok "generation completed and downloaded"
  node -e '
    const r = require("/tmp/agnes_live.json");
    console.log("  video_id  " + r.videoId);
    console.log("  url       " + r.url);
    console.log("  saved     " + r.localPath + " (" + (r.bytes/1048576).toFixed(2) + " MB)");
    console.log("  cost      $" + r.estimatedTrialUsd + (r.free ? " (free tier)" : " (PAID)"));
    if (!r.free) { console.error("  !! a paid model was used"); process.exit(1); }
    if (!r.bytes || r.bytes < 10000) { console.error("  !! downloaded file looks empty"); process.exit(1); }
  ' && ok "MP4 is real, non-empty, and was free" || bad "result failed verification"
else
  bad "generation failed"
  sed -n '1,40p' /tmp/agnes_live.err | sed 's/^/    /'
fi

step "summary"
echo "  $pass passed, $fail failed"
[[ $fail -eq 0 ]] && { echo "  Live integration verified end to end."; exit 0; } || exit 1
