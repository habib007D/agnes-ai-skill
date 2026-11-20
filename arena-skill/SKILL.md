---
name: agnes-video
version: 1.0.0
description: "Turn a video idea or an uploaded image into a finished MP4 with Agnes AI video generation. Use when the user wants an AI video, image-to-video, text-to-video, ad film, storyboard, or multi-shot sequence. Handles the whole pipeline: research, script, scene plan, generation, polling, download."
tags:
  - agnes
  - agnes-ai
  - video-generation
  - ai-video-generation
  - image-to-video
  - text-to-video
  - multimodal-ai
  - agent-skill
  - storyboard
  - video-production
metadata:
  arena:
    emoji: "🎬"
    homepage: "https://github.com/jomeswang/agnes-ai-skill"
    requires:
      bins: [node]
      node: ">=18"
    primaryEnv: AGNES_API_KEY
    envVars:
      - name: AGNES_API_KEY
        required: true
        secret: true
        description: Agnes API key. Read from the environment only. Never write it to a file in this repository.
      - name: AGNES_ALLOW_PAID
        required: false
        description: Set to 1 to permit non-free models. Hard-blocks paid use when absent.
      - name: AGNES_UPLOAD_PROVIDER
        required: false
        description: Set to litterbox to allow local files to be published to a temporary public URL. Off by default.
---

# Agnes Video — idea in, MP4 out

You are operating a video production pipeline. The user says something like
*"make me a 5 second ad for my perfume brand"* or *"animate this photo"*. Your
job is to go from that sentence to a downloaded MP4 without making them write
commands, JSON, or scripts.

**Everything runs through one command:** `bin/agnes-video.mjs`.
Use `node bin/agnes-video.mjs ...` unless `agnes-video` is on PATH.

---

## Hard constraints (read before every generation)

1. **Never print, echo, log, or commit `AGNES_API_KEY`.** Verify with
   `doctor`, which reports only presence, length, and a 3-character prefix.
2. **`agnes-video-v2.0` does not exist any more.** It was retired on
   **2026-09-25**. The script refuses it. Use `agnes-video-2.5-flash`.
3. **Default to the free model.** `agnes-video-2.5-flash` is the only model
   whose Angel User Trial price is `$0/second`. Anything else is billed.
4. **Never spend money without explicit permission.** The script refuses any
   non-free payload unless BOTH `--allow-paid` is passed and
   `AGNES_ALLOW_PAID=1` is set. Do not set that env var yourself. Do not pass
   `--allow-paid` "to test". Ask the user first, quote the estimate, wait.
5. **Never guess an API result.** If a call fails, report the error verbatim.
   Do not claim a video was made unless you have a file path and a non-zero
   byte count.

---

## The default flow

### Step 0 — one-time check (once per session)

```bash
node bin/agnes-video.mjs doctor
```

- exit `2` → no key. Go to **Missing key** below.
- exit `3` → key rejected. Ask the user to re-check it; do not retry blindly.
- exit `4` → no network route to `apihub.agnes-ai.com`. Do not generate; see
  **Sandbox egress limitation** below.
- exit `0` → ready.

### Step 1 — understand the ask

You need only four things, and you can infer all of them:

| Thing | Default if the user says nothing |
| --- | --- |
| Idea / subject | required, ask only if truly absent |
| Duration | 5 s |
| Aspect | 16:9 (use 9:16 for Reels/TikTok/Shorts, 1:1 for feed) |
| Visual style | match the brand/product; else `cinematic` |

If the user uploads an image, that image is the first frame → image-to-video.
If they describe only a scene → text-to-video. **Do not ask which; infer it.**

### Step 2 — research and shape the idea (only when it earns its keep)

Skip this for simple requests — it is not free of the user's time.

Run it when the video is for marketing, a real product, or a factual subject:

- Use web search for brand facts, product claims, competitor ad angles, or
  anything you would otherwise invent.
- Never put a claim in a prompt that you have not verified.

Then compile the prompt in the order Agnes documents
(subject → action → camera → style/light → sound → consistency):

```bash
node bin/agnes-video.mjs prompt \
  --prompt "perfume bottle on travertine, dawn light" \
  --camera pushin --style cinematic --motion subtle \
  --sound "soft room tone, distant birds" \
  --consistency "keep the bottle silhouette and label identical"
```

Optional but useful: `--dry-run` on `produce` prints the exact JSON payload
and the cost estimate, sends nothing, and charges nothing. Use it whenever you
are unsure about a parameter, or when the user asks "what will this cost?".

### Step 3 — generate, poll, download (one command)

```bash
node bin/agnes-video.mjs produce \
  --prompt "<compiled prompt>" \
  --seconds 5 --aspect 16:9 --json
```

Image-to-video (the user's uploaded image is the first frame):

```bash
node bin/agnes-video.mjs produce \
  --prompt "slow push in, hair moves in the breeze, keep the face identical" \
  --image "<public https URL of the user's image>" \
  --seconds 5 --json
```

The command creates the task, polls every 2 s with the required `model_name`,
detects `completed`/`failed`, downloads the MP4, and prints JSON:

```json
{ "ok": true, "videoId": "video_...", "status": "completed",
  "url": "https://.../video.mp4", "localPath": "/root/.agnes-arena/videos/....mp4",
  "bytes": 4123456, "free": true, "estimatedTrialUsd": 0 }
```

If it prints `POLL_TIMEOUT`, the task is still alive. Resume it — do not
re-generate (that would queue and bill a second video):

```bash
node bin/agnes-video.mjs poll <videoId> --model agnes-video-2.5-flash --timeout 900
node bin/agnes-video.mjs download "<url>" --out output/clip.mp4
```

### Step 4 — deliver

- Copy or generate the MP4 into the workspace with `--out output/<name>.mp4`
  so it can be presented, or uploaded to Google Drive if connected.
- `present_file` the video so the user does not have to hunt for it.
- Report: model used, duration, resolution, aspect, cost (normally `$0`), and
  the local path.

---

## Multi-shot production (ads, stories, sequences)

One video call caps at 12 s, so anything longer is several shots. Plan first:

```bash
node bin/agnes-video.mjs plan --prompt "a diver in a flooded cathedral" \
  --shots 4 --seconds 5 --out output/plan.json
```

This is free and offline. Review the beat list with the user, edit the JSON if
their taste says so, then produce all shots:

```bash
node bin/agnes-video.mjs storyboard output/plan.json --json
```

Each shot is a separate `produce`; the manifest records every `videoId` and
`localPath`. Keep shots consistent by carrying the same style, lighting and a
`--consistency` line across shots, and by feeding the last frame of one shot as
the first frame of the next.

**Length is a cost decision.** 4 shots × 5 s = 20 s of video. On the free
model that is still $0. Say the total out loud before you start a long
storyboard.

---

## Prompting rules that actually change the output

Agnes video is weaker at implied motion than at stated motion. For every shot
say what moves, what stays still, and how the camera behaves.

- **Text-to-video:** subject and setting, then action, then camera, then light
  and style, then sound.
- **Image-to-video:** what should move, what must stay identical (face, logo,
  wardrobe, framing), and how subtle the motion is. "Subtle" prevents warping.
- **Keyframes (two images):** describe the transition and what must remain
  continuous between them.
- **Reference mode:** name each input explicitly, e.g. "use `<Picture 1>` as the
  character reference and follow the rhythm of `<Audio 1>`". Unnamed media is
  ignored or applied arbitrarily.

Avoid in prompts: on-screen text (models mangle it — add text in an editor
instead), exact brand logos, more than one camera move per shot, and more than
one location per shot.

---

## Cost and quota (requirement: check before every generation)

Agnes publishes **no quota or balance API**. Do not invent one, and do not
claim you checked a server-side balance. What is actually available:

```bash
node bin/agnes-video.mjs quota --json
```

returns a real preflight (key validity, and the documented `402` no-credit and
`429` rate-limit signals) plus the local generation ledger. Every `produce`
runs this preflight automatically before it creates a task, so "quota checked
before every generation" is true by construction. It is a health check, not a
balance read-out. For an authoritative balance, point the user at
`platform.agnes-ai.com → Usage` / `Billing`.

Published prices, verified 2026-11-20:

| Model | 720P | 1080P / 1K | 2K | Notes |
| --- | --- | --- | --- | --- |
| `agnes-video-2.5-flash` | $0.025/s list, **$0/s trial** | not supported | not supported | default; free tier |
| `agnes-video-2.5` | $0.025/s | $0.040/s | $0.055/s | paid, needs consent |

Trial pricing applies to default-tier accounts; the platform bill is the final
word. Input images: first 5 free, then $0.005 each.

---

## Missing key

Do not proceed with live calls. Tell the user:

1. Create a key at <https://platform.agnes-ai.com/settings/apiKeys>
   (Settings → API Keys → Create new secret key). It is shown once.
2. Put it in the environment of the shell that runs the generation:

   ```bash
   export AGNES_API_KEY='...'   # their own terminal, not a repo file
   ```

   or in Arena, add it as a secret/env var in the session settings.
3. Re-run `doctor`.

Never ask them to paste the key into chat, and never write it into a tracked
file. If they do paste it, use it for the session, and tell them to rotate it.

---

## Local images need a public URL

Agnes fetches `first_frame` / `images` over the public internet. A workspace
file path is not reachable, so the script refuses local paths by default.

Offer, in this order:

1. **The image already has a public URL** — use it (best).
2. **Upload it somewhere the user controls** — Google Drive with a public link,
   an S3/CDN URL, their own host. Ask before publishing anything.
3. **Opt in to the built-in bridge** — `AGNES_UPLOAD_PROVIDER=litterbox`
   publishes the file to catbox.moe for 1–72 h. Tell the user plainly that this
   makes their image publicly reachable to a third party, and get a yes first.

---

## Failure playbook

| Symptom | Cause | Do this |
| --- | --- | --- |
| `AUTH_MISSING` | no `AGNES_API_KEY` in this shell | Missing key section |
| `AUTH_INVALID` / HTTP 401 | bad, deleted, or wrong-type key | Ask for a re-check or a new key |
| HTTP 402 | no balance / trial exhausted | Stop. Report. Do not enable paid |
| HTTP 429 | RPM or quota window | Back off, tell the user, retry later |
| `NETWORK` | sandbox has no route to `apihub.agnes-ai.com` | Run from an environment with egress; see below |
| `MODE_INVALID` | media does not match mode | One image → keyframe; 2+ → reference or keyframe pair |
| `SIZE_UNSUPPORTED` | asked 1080P/2K on Flash | Flash is 720P only; use the paid model only with consent |
| `TASK_FAILED` | Agnes rejected the content | Read `error.message`, simplify the prompt, retry once |
| `POLL_TIMEOUT` | task slower than budget | `poll <videoId>`, never re-create |
| `UPLOAD_DISABLED` | local image, no bridge | Public URL section |

### Sandbox egress limitation

If `doctor` reports `Could not reach https://apihub.agnes-ai.com/v1`, this
environment has no network route to Agnes. That is a sandbox restriction, not
a bug and not a key problem. Say so explicitly, and hand the user the exact
command to run somewhere with egress. Never claim a video was produced in that
state.

---

## Honesty rules for reporting results

These exist because it is easy to be plausible and wrong here:

- Only say a video exists if you have a `localPath` and `bytes > 0` from a
  `produce`/`poll` result.
- If `doctor` exits `4` or a call fails with `NETWORK`, say plainly: "this
  environment cannot reach Agnes, so nothing was generated". Do not soften it.
- Never present a mock, a plan, a compiled prompt, or a `--dry-run` payload as
  a generated video. They are previews; label them as previews.
- Distinguish "the code is verified" (protocol tests pass) from "the live
  integration is verified" (a real MP4 came back). Those are different claims.

## Reference

```
doctor                    key + preflight health
quota                     preflight + local ledger (not a server balance)
prompt                    compile a brief into one Agnes prompt (offline)
plan                      scene plan / storyboard scaffold (offline)
produce | create          full pipeline; create stops after queueing
storyboard <plan.json>    produce every shot in a plan
poll <video_id>           resume polling
download <url>            fetch an MP4
ledger                    local generation history
--dry-run                 show the payload + cost, send nothing
--json                    machine-readable output
```

Environment: `AGNES_API_KEY`, `AGNES_BASE_URL`,
`AGNES_POLL_BASE_URL`, `AGNES_ALLOW_PAID`, `AGNES_UPLOAD_PROVIDER`,
`AGNES_GENERATED_DIR`.

Source of truth: <https://agnes-ai.com/doc/agnes-video-25> and
<https://agnes-ai.com/doc/agnes-video-25-flash>. Verify before quoting prices.
