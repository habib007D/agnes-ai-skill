# Agnes Video for Arena Agent Mode

Idea or image in, finished MP4 out — on Agnes AI's free video tier.

This is an adaptation of [`jomeswang/agnes-ai-skill`](https://github.com/jomeswang/agnes-ai-skill)
(MIT) for Arena Agent Mode. The upstream skill is a good `SKILL.md`, but its
video path no longer works, and its assumptions do not hold on today's API. See
[`FINDINGS.md`](./FINDINGS.md) for the evidence behind every change.

---

## What changed vs upstream, and why

| Upstream | Reality (verified 2026-11-20) | Here |
| --- | --- | --- |
| Uses `agnes-video-v2.0` | **Retired 2026-09-25**; the model no longer exists | Refuses `v2.0`, uses `agnes-video-2.5-flash` |
| Sends `width`, `height`, `num_frames`, `frame_rate` | Video 2.5 returns **HTTP 400** for all of them | Sends the documented 2.5 schema (`seconds`, `size`, `aspect_ratio`, `mode`) |
| Polls `/agnesapi?video_id=…` only | `model_name` is **required** for `keyframe`/`reference` | Always sends `model_name` |
| `agnes-ai-cli@0.1.6` still hardcodes v2.0 | The published CLI's video path is dead | Own zero-dependency implementation |
| Assumes broad free access | Only `agnes-video-2.5-flash` has a `$0/s` trial price | Hard-block on anything not free |
| Uploads local files to catbox.moe silently | That publishes your image publicly | Opt-in only, refused by default |

## Install

```bash
cd arena-skill
./install.sh                # or: ./install.sh /path/to/skills
```

Or run it in place — nothing needs installing beyond Node 18+:

```bash
node arena-skill/bin/agnes-video.mjs doctor
```

## Configure the key (once)

Arena Agent Mode has **no secrets manager or environment-variable screen** — so
there is nothing to configure in the UI. Use the vault:

```bash
node bin/agnes-key.mjs set      # hidden prompt; nothing is echoed or logged
node bin/agnes-video.mjs doctor
```

Get the key at <https://platform.agnes-ai.com/settings/apiKeys> (shown once).

The vault is a `0600` file outside the repo. `agnes-key` refuses to store a key
inside a git repository, never takes the key as a command-line argument, and
says plainly that the file is permission-protected rather than encrypted.
`AGNES_API_KEY` in the environment still works and takes precedence.

Phone-friendly walkthrough: [`KEY-SETUP.md`](./KEY-SETUP.md).

## Use

You type an idea. That is the whole interface.

```bash
# text-to-video
node bin/agnes-video.mjs produce --prompt "a neon jellyfish drifting through a rainy Tokyo alley" --seconds 5

# image-to-video (the image becomes the first frame)
node bin/agnes-video.mjs produce --prompt "slow push in, hair moves in the breeze, keep the face identical" \
  --image https://your-host/portrait.png --seconds 5

# two images = first and last frame
node bin/agnes-video.mjs produce --prompt "morph between" --image https://a.png --image https://b.png

# a 4-shot, 20-second ad
node bin/agnes-video.mjs plan --prompt "a diver in a flooded cathedral" --shots 4 --out plan.json
node bin/agnes-video.mjs storyboard plan.json
```

Each `produce` creates the task, polls with the required `model_name`, detects
`completed`/`failed`, downloads the MP4, and records it in the ledger.

## The cost guard

`agnes-video-2.5-flash` is the only model with a `$0/second` trial price. It is
the default. Anything else needs **two** independent opt-ins:

```bash
AGNES_ALLOW_PAID=1 node bin/agnes-video.mjs produce --prompt "..." \
  --model agnes-video-2.5 --size 2K --seconds 12 --allow-paid
```

Without both, the script exits before any request is sent. Estimated cost is
printed in the error so you can decide. `--dry-run` shows the payload and price
and sends nothing.

## Quota, honestly

Agnes has **no quota or balance API** — no endpoint, nothing in the published
CLI. So "check quota before every generation" is implemented as:

1. an automatic preflight on every generation (validates the key, surfaces the
   documented `402` no-credit / `429` rate-limit states),
2. a published price table with an up-front estimate,
3. a local ledger of every run,
4. a hard block on any non-free payload.

The authoritative balance lives at `platform.agnes-ai.com → Usage`. The skill
says this rather than pretending to know your balance.

## Test

```bash
node bin/agnes-video.mjs doctor      # environment
node test/run-tests.mjs              # 101 protocol + safety + vault tests, no network
```

The test suite runs the real CLI against a mock that enforces the documented
2.5 validation rules, so a payload the real API would reject also fails here.

## Files

```
SKILL.md              the skill an agent reads
bin/agnes-video.mjs   the implementation (zero dependencies)
bin/agnes-key.mjs     local key vault (masked input, mode 600)
KEY-SETUP.md          phone-friendly key setup guide
lib/prompt.mjs        prompt compiler + scene planner (offline)
test/                 protocol-conformance and safety suite
FINDINGS.md           verified evidence for the claims above
plugin.json           Agent Plugins 1.0 manifest
.claude-plugin/       Claude Code plugin + marketplace manifests
```

## Limits worth knowing

- **12 seconds max per video.** Longer pieces are multi-shot.
- **720P only on the free model.**
- **Media must be publicly reachable** by Agnes; local paths need an opt-in
  bridge (off by default).
- **No on-screen text** — generative models mangle typography; composite it.
- **Poll, don't regenerate.** A timeout means the task is still running; use
  `poll`, or you will queue (and possibly pay for) a second video.
