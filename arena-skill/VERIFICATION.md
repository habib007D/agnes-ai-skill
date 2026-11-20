# Verification report

Date: 2026-11-20 · Node v22.22.3 · branch `arena/0ec9953b-agnes-ai-skill`

Two different claims are made below. They are **not** the same claim.

| Claim | Status |
| --- | --- |
| The integration's protocol handling, safety guards, and file pipeline are implemented and tested | **Verified** — 101 automated tests pass |
| A real Agnes MP4 was generated from this sandbox | **Not verified — impossible here.** Egress to Agnes is blocked |

Do not read the first row as the second.

---

## What was run, and the result

### 1. Automated suite — 101/101

```
node test/run-tests.mjs   ->   101 passed, 0 failed
```

The suite executes the real CLI as a subprocess against
`test/mock-agnes.mjs`, a mock that **rejects anything the documented API would
reject**: retired parameters (`width`, `height`, `num_frames`, `frame_rate`),
`seconds` not sent as a string, unsupported `size`, `aspect_ratio: auto`,
`n != 1`, media in the wrong mode, missing `model_name` on non-text polls, and
media URLs that are not public.

Coverage by area:

| Area | Examples of what is asserted |
| --- | --- |
| Auth | valid/invalid/missing key all distinguished; key never printed |
| Text-to-video E2E | create → poll → completed → download; file > 1 KB on disk |
| Image-to-video | one image becomes `first_frame`, not an `images` array |
| Keyframe pair | two images map to `first_frame` + `last_frame` |
| Reference mode | `images` array sent, poll includes `model_name` |
| Resumable flow | `create --no-poll`, `poll <id>`, standalone `download` |
| Paid guard | blocked with no consent; blocked with only one of two opt-ins; allowed with both; estimate correct |
| Retired model | `agnes-video-v2.0` refused, message names the 2026-09-25 date |
| Validation | seconds 4–12, flash 720P-only, unsupported aspect, missing prompt |
| Local files | refused by default, opt-in env var named, clear public-URL guidance |
| Prompt compiler | documented ordering preserved; camera preset expanded; no key needed |
| Scene planner | shot count, free model default, free estimate |
| Dry run | zero create requests sent; payload and poll URL shown |
| Ledger | run count and spend tracked locally |
| Key hygiene | absent from stdout/stderr, from the plugin tree, and from the artifacts dir |
| Key vault | mode 600; refuses paths inside a git repo; rejects short or spaced keys; `status`/`env`/`clear` never reveal the key; the skill authenticates from the vault with no env var |

### 2. Live probe — documented failure, no false success

A real call with a throwaway key was attempted against
`https://apihub.agnes-ai.com/v1`:

```
$ AGNES_API_KEY=dummy node bin/agnes-video.mjs produce --prompt "egress check" --seconds 4
preflight: unknown — Could not reach https://apihub.agnes-ai.com/v1 (fetch failed).
error [NETWORK]: Create video task could not reach apihub.agnes-ai.com: fetch failed
If you are inside a restricted sandbox, run this command from a shell with normal internet egress.
EXIT=1
```

`doctor` distinguishes this from a key problem: exit `4`, not `0`, so it can
never be mistaken for "ready".

Egress measurement from this sandbox:

| Host | Result |
| --- | --- |
| `apihub.agnes-ai.com` | TLS `SSL_ERROR_SYSCALL`, HTTP 000 (IPv4 and IPv6) |
| `agnes-ai.com`, `wiki.agnes-ai.com`, `platform.agnes-ai.com` | 000 |
| `litterbox.catbox.moe`, `0x0.st` | 000 |
| `api.github.com`, `registry.npmjs.org`, `pypi.org` | 200 |

The allowlist excludes every Agnes host, so no live generation is possible
here. `live-smoke-test.sh` performs that verification wherever egress exists.

### 3. Secrets capability — checked, not assumed

| Checked | Finding |
| --- | --- |
| Arena Agent Mode secrets/env-var UI | No documented feature; Arena's Agent Mode announcement lists only web search, image gen, file upload, coding, bash |
| `~/.arena` or any Arena config in the sandbox | absent |
| `AGNES_API_KEY` injected by the platform | not set (env has only E2B/GitHub variables) |
| Result | No platform secrets store exists to use; the vault in `bin/agnes-key.mjs` is the alternative |

### 4. Installability

`./install.sh /tmp/skilltest` installed the skill (SKILL.md, bin, lib, test,
manifests) and the installed copy ran `doctor` correctly. All manifests parse
as JSON; both `.sh` files pass `bash -n`.

---

## What only the user can confirm

Requirements #11 and the `agnes-video-v2.0` requirement could not be satisfied
as written. Those are findings, not implementation gaps:

1. **`agnes-video-v2.0` is retired.** The official page states retirement on
   2026-09-25. Substituted `agnes-video-2.5-flash`.
2. **No quota API exists.** The docs point to the dashboard; the published CLI
   has no quota command. Substituted an automatic preflight plus a ledger, and
   the skill is instructed to state the limitation rather than invent a balance.

To close the loop on the live path, on a machine with normal internet:

```bash
export AGNES_API_KEY='...'      # never commit this
cd arena-skill && ./live-smoke-test.sh
```

It verifies reachability, key validity, payload conformance, one real 4-second
free generation, polling, download, and file size. It refuses paid models.
