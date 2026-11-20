# Setting up your Agnes API key (phone-friendly)

No secret manager needed. No key in this chat. No key in GitHub.

---

## First, the honest answer about Arena

I checked Arena Agent Mode for a secrets or environment-variables screen.

- **There isn't one documented.** Arena's own Agent Mode announcement lists its
  tools as web search, image generation, file upload, coding help, and a
  sandbox/bash environment. No secrets manager, no env-var settings page.
- **I cannot see your UI** — only the sandbox on the other side of it. I found
  no secrets configuration in the sandbox either: no `.arena` folder, and
  `AGNES_API_KEY` is not injected into the environment.
- So if you looked and found nothing, that matches the evidence. You are not
  missing a button.

That leaves two workable options. Option A is the one I built for you.

---

## Option A — the key vault (recommended)

The key is typed **into the sandbox**, never into the chat. It is stored in a
locked file outside the repo, and the skill picks it up automatically.

### Step 1 — get the key (once, on your phone browser)

1. Open **platform.agnes-ai.com** and sign in.
2. Go to **Settings → API Keys**.
3. Tap **Create new secret key**.
4. Copy it. **It is shown only once.** Paste it into your phone's notes app or
   password manager for a moment — you will need it in step 3.

### Step 2 — tell me to start the setup

Send this message:

> Set up my Agnes key with the vault.

I will run the setup command in the sandbox. It will wait for your key.

### Step 3 — paste the key into the terminal (not the chat)

When I run it, the screen shows:

```
Paste your Agnes API key (input is hidden, then press Enter):
```

Paste, press Enter, paste again to confirm. **Nothing appears on screen** as you
type or paste — that is deliberate.

> **If you cannot reach a terminal:** there is no way to avoid this step
> securely. Sending a key in chat is the one thing that would break your
> requirement. In that case use Option B, or run the whole thing on a computer.

### Step 4 — verify

I will run `doctor`. You want to see:

```
API key        present (NNN chars)
key source     vault:/home/user/.agnes-arena/key
preflight      ok — Key accepted by the API.
```

Then you just say *"make me a video of…"* and it runs.

### What protects the key (and what does not)

| Protection | Status |
| --- | --- |
| Never appears in chat | yes |
| Never in a git commit or file in the repo | yes — the skill **refuses** to store it inside a repository |
| Never in shell history or process list | yes — no `read -s`, no key in any command line |
| File readable only by you | yes — mode `600` |
| Encrypted at rest | **no** — a file permission is the protection. Encryption with a key sitting next to it would be fake security |

---

## Option B — paste it into a shell yourself

If you would rather not have it stored at all. In the Arena terminal:

```bash
export AGNES_API_KEY='paste-your-key-here'
```

That works for the current session only. It disappears when the sandbox
restarts, and the key **is** in your shell history — run
`history -c` afterwards if that matters to you.

---

## Option C — run it on your own computer

Most private option, and the only one that persists across sessions without
storing anything in Arena:

```bash
git clone https://github.com/habib007D/agnes-ai-skill
cd agnes-ai-skill/arena-skill
./install.sh
node bin/agnes-key.mjs set
node live-smoke-test.sh
```

Your key never touches Arena at all.

---

## Things I will never do

- Ask you to paste the key into chat.
- Write it into source code, a commit, a pull request, or a public file.
- Print it in a log or an error message. Every error path runs it through a
  redactor, and the tests assert the key never appears on stdout or stderr.
- Add paid credit logic. The free model is the default; spending money needs
  two separate opt-ins that I will not enable for you.

## If something goes wrong

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `doctor` says exit `2` | no key found | re-run `agnes-key set` |
| `doctor` says exit `3` | key rejected | regenerate the key at platform.agnes-ai.com |
| `doctor` says exit `4` | sandbox cannot reach Agnes | not your key — this sandbox is network-restricted; use Option C |
| "Refusing to write the key inside a git repository" | the vault path is in the repo | that is the guard working; use the default path |

## Rotating the key

1. Delete the old key at **platform.agnes-ai.com → Settings → API Keys**.
2. Create a new one.
3. Run `node bin/agnes-key.mjs set` again.

Nothing else changes.

## Removing the key when you are done

```bash
node bin/agnes-key.mjs clear
```

Also delete the key on the Agnes website if you will not use it again.
