# Pre-build findings (verified 2026-11-20)

## Repository / Arena compatibility

| Item | Result |
| --- | --- |
| `jomeswang/agnes-ai-skill` | Public, exists, default branch `main`, last push 2026-06-13 |
| Workspace checkout | `habib007D/agnes-ai-skill` — a **fork** of `jomeswang/agnes-ai-skill` |
| Root `SKILL.md` | Read in full, v1.2.2, CLI-first design |
| `README.md` | Read in full |
| Arena Agent Mode compatibility | **Compatible** — a plain `SKILL.md` + shell-executable skill is exactly what Agent Mode consumes |
| Companion CLI `agnes-ai-cli` | Published, latest `0.1.6`, inside the skill's supported range `>=0.1.0 <0.2.0` |

## Blocker 1 — `agnes-video-v2.0` is retired

The official page `https://agnes-ai.com/doc/agnes-video-v20` now reads:

> Agnes Video v2.0 (`agnes-video-v2.0`) was retired on **September 25, 2026, at
> 23:59:59 (UTC+8)**. Please migrate your applications and API calls to the
> Agnes Video 2.5 series.

So requirement #6 (use `agnes-video-v2.0`) **cannot be satisfied** — the model no
longer exists. Current documented models:

| Model | 720P | 1080P / 1K | 2K | Free? |
| --- | --- | --- | --- | --- |
| `agnes-video-2.5` | $0.025/s | $0.040/s | $0.055/s | No |
| `agnes-video-2.5-flash` | $0.025/s list, **Angel User Trial $0/s** | not supported (720P only) | not supported | Trial-priced $0 for `default` accounts |

`agnes-video-2.5-flash` is the only path that honours "never use paid credits".

The repo's own CLI is also stale here: `dist/video/normalizeVideoRequest.js`
hardcodes `model: "agnes-video-v2.0"` plus the retired parameters
`width`, `height`, `num_frames`, `frame_rate` — all of which Video 2.5 rejects
with HTTP 400. Its poller also omits the now-required `model_name` query
parameter for `keyframe`/`reference` tasks. **The upstream CLI video path is
dead; this integration implements the 2.5 contract directly.**

## Blocker 2 — there is no public quota / balance API

Docs (`/docs/faqs`, `/docs/pricing`) say to check usage in the platform
dashboard under "Usage"/"Billing". The only in-band quota signals are HTTP
`402` (insufficient balance/credits) and `429` (RPM / subscription quota
exceeded). Grepping `agnes-ai-cli@0.1.6` for `quota|balance|credit|usage|billing`
returns nothing.

**Requirement #11 ("check my actual free quota before every generation") is not
directly supportable.** Simplest alternative implemented here: an automatic
preflight call on every generation that detects `401/402/403/429`, a published
price table, a local generation ledger, and a hard consent gate for anything
that is not the $0 trial model.

## Blocker 3 — sandbox egress is allowlisted

From this sandbox, `apihub.agnes-ai.com`, `agnes-ai.com`, `wiki.agnes-ai.com`,
`platform.agnes-ai.com`, `litterbox.catbox.moe` and `0x0.st` all fail at TLS
(`SSL_ERROR_SYSCALL` / HTTP 000). `github.com`, `api.github.com`,
`registry.npmjs.org`, `pypi.org` return 200.

**No live Agnes request can be executed from this sandbox**, so no live video
generation can be demonstrated here. Verification is therefore done against a
byte-level mock of the documented protocol (create → poll → download), plus a
one-command live smoke test the user runs where egress exists. No success is
claimed without that live run.

## Media-URL caveat

Agnes requires **publicly reachable** media URLs for `first_frame`, `last_frame`
and `images`. The upstream CLI and `scripts/agnes-media-url.sh` both bridge
local files through **Litterbox (catbox.moe)** — a third-party public host with
a 1h–72h TTL. That silently publishes the user's image to a public URL. This
integration keeps that as an *opt-in* provider and defaults to asking for a
public URL or a user-owned uploader.
