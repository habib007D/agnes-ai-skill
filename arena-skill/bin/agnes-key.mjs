#!/usr/bin/env node
/**
 * agnes-key — local API key vault for the Agnes video skill.
 *
 * Design goals, in order:
 *   1. The key must never appear in the chat, in git, or in any tracked file.
 *   2. The key must never be written into a shell rc file by default, because
 *      Arena snapshots the HOME directory, which would put it in the artifact.
 *   3. Typing the key must not be visible on screen or in the shell log.
 *   4. The key must be usable by later commands in the same session.
 *
 * Security model, stated honestly:
 *   - The vault is a file with mode 0600 holding the raw key.
 *   - It is protected by filesystem permissions, NOT by encryption. Encryption
 *     with a key stored next to it would be theatre.
 *   - It is created OUTSIDE the repo by default so it can never be committed.
 *   - The skill refuses to load a vault that lives inside a git working tree.
 *
 * Commands:
 *   agnes-key set      read the key from a masked prompt, or from stdin
 *   agnes-key status   is a key configured, and where from (never prints it)
 *   agnes-key env      print a shell snippet to export it (for eval)
 *   agnes-key clear    delete the vault
 *   agnes-key where    print the vault location
 */

import { promises as fs, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const DEFAULT_VAULT = process.env.AGNES_KEY_FILE || join(homedir(), ".agnes-arena", "key");
const MIN_LEN = 16;
const MAX_LEN = 4096;

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

function gitTopLevel(path) {
  try {
    const out = execFileSync("git", ["-C", dirname(path), "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Refuse to store a secret inside a repository: it could be committed or snapshotted. */
function assertOutsideRepo(path) {
  const root = gitTopLevel(path);
  if (root) {
    die(
      `Refusing to write the key inside a git repository.\n` +
        `  vault path : ${path}\n` +
        `  repo root  : ${root}\n` +
        `A key inside the repo can be committed, pushed, or captured in a workspace snapshot.\n` +
        `Unset AGNES_KEY_FILE, or point it outside the repo, e.g. $HOME/.agnes-arena/key`,
    );
  }
}

function looksLikeKey(v) {
  if (!v) return false;
  if (v.length < MIN_LEN || v.length > MAX_LEN) return false;
  if (/\s/.test(v)) return false;
  return true;
}

async function readAllStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Masked prompt with no echo.
 *
 * Deliberately does NOT use `read -s`, because that puts the secret in the
 * command line and therefore in shell history / process listings. Instead we
 * flip the terminal out of echo mode in this process, read one line, restore.
 */
async function promptHidden(promptText) {
  process.stderr.write(promptText);
  const { stdin, stdout } = process;
  const isTTY = stdin.isTTY;
  if (isTTY && stdin.setRawMode) stdin.setRawMode(true);
  if (isTTY) stdin.resume();

  return new Promise((res, rej) => {
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (isTTY && stdin.setRawMode) stdin.setRawMode(false);
      if (isTTY) stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") { cleanup(); return res(buf.trim()); }
        if (ch === "\u0003") { cleanup(); return rej(new Error("cancelled")); }  // Ctrl-C
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; } // backspace
        buf += ch;
      }
    };
    stdin.on("data", onData);
    if (!isTTY) { cleanup(); return res(""); }
  });
}

async function writeVault(path, key) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Write to a 0600 temp file in the same dir, then rename: never a window where
  // the file is world-readable.
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${key}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, path);
  await fs.chmod(path, 0o600);
}

async function cmdSet() {
  const path = resolve(DEFAULT_VAULT);
  assertOutsideRepo(path);

  let key = (await readAllStdin())?.trim();
  if (key !== null && key !== "" && !process.stdin.isTTY) {
    // piped input (e.g. from a password manager)
  } else {
    key = await promptHidden("Paste your Agnes API key (input is hidden, then press Enter): ");
    if (!key) die("No key entered. Nothing was saved.");
    const again = await promptHidden("Paste it once more to confirm: ");
    if (again !== key) die("The two entries did not match. Nothing was saved.");
  }

  if (!looksLikeKey(key)) {
    die(
      `That does not look like an API key (length ${key.length}, spaces: ${/\s/.test(key)}).\n` +
        "Expected a single token of 16-4096 characters with no spaces.\nNothing was saved.",
    );
  }

  await writeVault(path, key);

  let st;
  try { st = await fs.stat(path); } catch { die("Wrote the vault but cannot read it back."); }
  if ((st.mode & 0o777) !== 0o600) {
    die(`Saved, but permissions are ${(st.mode & 0o777).toString(8)}, not 600. Delete and retry.`);
  }

  console.log("Key saved.");
  console.log(`  location : ${path}`);
  console.log("  mode     : 600 (owner read/write only)");
  console.log("  contents : not encrypted; a file permission is the protection");
  console.log("  in git   : no (vault is outside any repository)");
  console.log("");
  console.log("The skill reads it automatically. Verify with: node bin/agnes-video.mjs doctor");
}

async function cmdStatus() {
  const path = resolve(DEFAULT_VAULT);
  const envKey = process.env.AGNES_API_KEY;
  const fileExists = existsSync(path);

  console.log("Agnes key status");
  console.log(`  AGNES_API_KEY env : ${envKey ? `set (${envKey.trim().length} chars)` : "not set"}`);
  console.log(`  vault file        : ${fileExists ? path : "not created"}`);

  if (fileExists) {
    const st = await fs.stat(path);
    const mode = (st.mode & 0o777).toString(8);
    console.log(`  vault mode        : ${mode}${mode === "600" ? " (ok)" : "  !! should be 600"}`);
    const root = gitTopLevel(path);
    console.log(`  vault in a repo   : ${root ? `YES — ${root}  !! move it` : "no"}`);
    const raw = (await fs.readFile(path, "utf8")).trim();
    console.log(`  vault contents    : ${looksLikeKey(raw) ? `present (${raw.length} chars)` : "!! malformed"}`);
  }

  console.log("");
  if (envKey || fileExists) console.log("Ready: a key is available for this session.");
  else console.log("No key configured yet. Run: node bin/agnes-key.mjs set");
}

async function cmdEnv() {
  const path = resolve(DEFAULT_VAULT);
  if (!existsSync(path)) die(`No vault at ${path}. Run: node bin/agnes-key.mjs set`, 2);
  const key = (await fs.readFile(path, "utf8")).trim();
  if (!looksLikeKey(key)) die("Vault is malformed. Re-run: set");
  // Single-quoted, with any quote escaped, so eval cannot break out.
  console.log(`export AGNES_API_KEY='${key.replace(/'/g, `'\\''`)}'`);
}

async function cmdClear() {
  const path = resolve(DEFAULT_VAULT);
  if (!existsSync(path)) { console.log("No vault to delete."); return; }
  await fs.rm(path, { force: true });
  console.log(`Deleted ${path}.`);
  console.log("If you also exported the key in this shell, unset it: unset AGNES_API_KEY");
}

function usage() {
  console.log(`agnes-key — local Agnes API key vault

  node bin/agnes-key.mjs set      store the key (masked prompt, no shell history)
  node bin/agnes-key.mjs status   show whether a key is configured (never the key)
  node bin/agnes-key.mjs env      print an export snippet, for: eval "$(... env)"
  node bin/agnes-key.mjs clear    delete the stored key
  node bin/agnes-key.mjs where    print the vault path

Vault path: ${DEFAULT_VAULT}
Override with AGNES_KEY_FILE — but it must be OUTSIDE any git repository.
`);
}

const cmd = process.argv[2] || "help";
try {
  switch (cmd) {
    case "set": await cmdSet(); break;
    case "status": await cmdStatus(); break;
    case "env": await cmdEnv(); break;
    case "clear": await cmdClear(); break;
    case "where": console.log(resolve(DEFAULT_VAULT)); break;
    case "help": case "-h": case "--help": usage(); break;
    default: usage(); process.exit(1);
  }
} catch (err) {
  die(`agnes-key: ${err.message}`);
}
