#!/usr/bin/env node
/**
 * agnes-video — Agnes AI video production bridge for Arena Agent Mode.
 *
 * Zero dependencies (Node 18+). Implements the documented Agnes Video 2.5
 * contract: POST /v1/videos -> GET /agnesapi?video_id=..&model_name=.. -> MP4.
 *
 * Safety defaults:
 *   - only the $0 trial model (agnes-video-2.5-flash) is used automatically
 *   - any non-zero-cost model requires --allow-paid plus AGNES_ALLOW_PAID=1
 *   - the API key is never printed or logged
 */

import { promises as fs, createWriteStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, extname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { compilePrompt, planScenes } from "../lib/prompt.mjs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE = "https://apihub.agnes-ai.com/v1";
const DEFAULT_POLL_BASE = "https://apihub.agnes-ai.com";
// Generated media and the ledger live outside the tracked repo tree.
const GENERATED = process.env.AGNES_GENERATED_DIR || join(homedir(), ".agnes-arena");
const OUT_DIR = join(GENERATED, "videos");
const LEDGER = join(GENERATED, "generations.jsonl");

/* ------------------------------------------------------------------ models */

const MODELS = {
  "agnes-video-2.5-flash": {
    id: "agnes-video-2.5-flash",
    label: "Video 2.5 Flash (free trial tier)",
    sizes: ["720P"],
    maxImages: 5,
    maxAudios: 3,
    supportsVideoRef: false,
    pricesPerSecond: { "720P": 0.025 },
    trialPerSecond: { "720P": 0 },
  },
  "agnes-video-2.5": {
    id: "agnes-video-2.5",
    label: "Video 2.5 (paid)",
    sizes: ["720P", "1080P", "1K", "2K"],
    maxImages: 8,
    maxAudios: 3,
    supportsVideoRef: true,
    pricesPerSecond: { "720P": 0.025, "1080P": 0.04, "1K": 0.04, "2K": 0.055 },
    trialPerSecond: { "720P": 0.025, "1080P": 0.04, "1K": 0.04, "2K": 0.055 },
  },
};

const FREE_MODEL = "agnes-video-2.5-flash";
const ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const RETIRED = "agnes-video-v2.0";

/* ------------------------------------------------------------------ helpers */

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const redact = (s) => {
  const key = process.env.AGNES_API_KEY;
  let out = String(s);
  if (key && key.length > 6) out = out.split(key).join("***REDACTED***");
  return out.replace(/\b(sk|ak|key)-[A-Za-z0-9_-]{12,}\b/g, "***REDACTED***");
};

const log = (...a) => console.error(...a);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  // Repeatable flags accumulate into an array; later single values still win.
  const push = (k, v) => {
    if (flags[k] === undefined) flags[k] = v;
    else if (Array.isArray(flags[k])) flags[k].push(v);
    else flags[k] = [flags[k], v];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { flags.help = true; continue; }
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) { push(k, inline); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { push(k, next); i += 1; }
      else flags[k] = true;
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

const num = (v, d) => {
  if (v === undefined || v === true || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function requireKey() {
  const key = process.env.AGNES_API_KEY;
  if (!key || !key.trim()) {
    throw new CliError(
      "AUTH_MISSING",
      "AGNES_API_KEY is not set. Create one at https://platform.agnes-ai.com/settings/apiKeys\n" +
        "then export it in the shell you run this from. The key is never written to this repo.",
    );
  }
  return key.trim();
}

/* ------------------------------------------------------------------- inputs */

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

function classifyMedia(value) {
  if (/^https?:\/\//i.test(value)) {
    const clean = value.split("?")[0].toLowerCase();
    const ext = extname(clean);
    if (AUDIO_EXT.has(ext)) return "audio";
    if (VIDEO_EXT.has(ext)) return "video";
    return "image";
  }
  const ext = extname(value).toLowerCase();
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return "image";
}

/** Resolve one user-supplied media reference to a URL Agnes can reach. */
async function resolveMedia(raw, opts = {}) {
  const value = String(raw).trim();
  if (/^https?:\/\//i.test(value)) return value;

  const path = resolve(value);
  if (!existsSync(path)) {
    throw new CliError("INPUT_NOT_FOUND", `No such file and not an http(s) URL: ${value}`);
  }
  const stat = await fs.stat(path);
  if (stat.size > 15 * 1024 * 1024) {
    throw new CliError("INPUT_TOO_LARGE", `${value} is ${(stat.size / 1048576).toFixed(1)} MB; Agnes caps media at 15 MB.`);
  }

  // Publishing a local file to a third-party host is opt-in only. Default: off.
  const provider = (opts.provider || process.env.AGNES_UPLOAD_PROVIDER || "none").toLowerCase();
  if (provider === "none") {
    throw new CliError(
      "UPLOAD_DISABLED",
      `\`${value}\` is a local file. Agnes needs a public URL.\n` +
        "Either pass a public https URL, or opt in to the temporary upload bridge:\n" +
        "  AGNES_UPLOAD_PROVIDER=litterbox agnes-video ...\n" +
        "That publishes the file to catbox.moe for 1h-72h. It is off by default on purpose.",
    );
  }

  throw new CliError(
    "UPLOAD_UNAVAILABLE",
    `\`${value}\` is a local file. In this environment the public-URL bridge cannot be used.\n` +
      "Pass a public https image URL instead — that is the only fully in-band path.",
  );
}

/* -------------------------------------------------------------------- quota */

/**
 * Preflight. Agnes has no documented quota endpoint, so this is the closest
 * honest thing: authenticate, learn whether the key is usable, and detect the
 * documented 402/429 conditions. Never costs anything for a GET on a bad id.
 */
async function preflight(key, base) {
  const out = { checkedAt: new Date().toISOString(), reachable: false, status: null, verdict: "unknown", detail: "" };
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    out.reachable = true;
    out.status = res.status;
    if (res.ok) {
      out.verdict = "ok";
      out.detail = "Key accepted by the API.";
    } else if (res.status === 401 || res.status === 403) {
      out.verdict = "unauthorized";
      out.detail = "Key rejected (401/403). Check the key and its model access.";
    } else if (res.status === 402) {
      out.verdict = "no_credit";
      out.detail = "Account balance/credits insufficient (402). Free-tier access may be exhausted.";
    } else if (res.status === 429) {
      out.verdict = "rate_limited";
      out.detail = "RPM or subscription quota exceeded (429). Wait for the window to reset.";
    } else {
      out.detail = `Unexpected HTTP ${res.status}; continuing, but the call may fail.`;
    }
  } catch (err) {
    out.reachable = false;
    out.detail = `Could not reach ${base} (${err.name === "TimeoutError" ? "timeout" : err.message}).`;
  }
  return out;
}

function estimateCost(model, size, seconds, imageCount) {
  const m = MODELS[model];
  const listPrice = (m.pricesPerSecond[size] ?? 0) * seconds + Math.max(0, imageCount - 5) * 0.005;
  const trialPrice = (m.trialPerSecond[size] ?? 0) * seconds + Math.max(0, imageCount - 5) * 0.005;
  return { listPrice: round(listPrice), trialPrice: round(trialPrice), free: trialPrice === 0 };
}

const round = (n) => Math.round(n * 10000) / 10000;

async function appendLedger(entry) {
  try {
    await fs.mkdir(dirname(LEDGER), { recursive: true });
    await fs.appendFile(LEDGER, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* ledger is best-effort */
  }
}

async function readLedger() {
  try {
    const text = await fs.readFile(LEDGER, "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- transport */

async function agnesFetch(url, init, label) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  } catch (err) {
    throw new CliError(
      "NETWORK",
      `${label} could not reach ${new URL(url).host}: ${err.message}\n` +
        "If you are inside a restricted sandbox, run this command from a shell with normal internet egress.",
    );
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || body?.raw || "";
    const hint = {
      400: "Request rejected by validation. Check mode/media combination, seconds as a string, and size.",
      401: "Invalid or missing API key.",
      402: "Insufficient balance/credits, or the free pre-request usage check failed.",
      403: "Key not authorized for this model.",
      404: "Video id not found for this model.",
      429: "Rate limit or subscription quota exceeded. Back off.",
    }[res.status];
    throw new CliError(
      `HTTP_${res.status}`,
      `${label} failed: HTTP ${res.status} ${redact(msg)}\n${hint ?? ""}`.trim(),
      { status: res.status, body },
    );
  }
  return body;
}

/* -------------------------------------------------------------------- build */

function buildPayload({ prompt, model, mode, seconds, size, aspect, seed, images, audios, videoRef, firstFrame, lastFrame, ttl }) {
  // In keyframe mode the supplied images are consumed as frames, not references.
  const referenceImages = mode === "keyframe" ? [] : images;
  const m = MODELS[model];
  if (!m) {
    if (String(model).includes(RETIRED)) {
      throw new CliError(
        "MODEL_RETIRED",
        `${RETIRED} was retired on 2026-09-25 and no longer exists.\n` +
          `Use ${FREE_MODEL} (free trial) or agnes-video-2.5 (paid).`,
      );
    }
    throw new CliError("MODEL_UNKNOWN", `Unknown model ${model}. Known: ${Object.keys(MODELS).join(", ")}.`);
  }
  if (!m.sizes.includes(size)) {
    throw new CliError("SIZE_UNSUPPORTED", `${model} supports size ${m.sizes.join("/")}, not ${size}.`);
  }
  if (!ASPECTS.includes(aspect)) {
    throw new CliError("ASPECT_UNSUPPORTED", `aspect_ratio must be one of ${ASPECTS.join(", ")}.`);
  }
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec < 4 || sec > 12) {
    throw new CliError("SECONDS_INVALID", "seconds must be 4-12 (passed as a string to the API).");
  }

  const payload = {
    model,
    prompt,
    seconds: String(sec),
    mode,
    size,
    aspect_ratio: aspect,
    n: 1,
  };
  if (seed !== undefined) payload.seed = seed;

  if (mode === "keyframe") {
    if (!firstFrame && !lastFrame) {
      throw new CliError("MODE_INVALID", "keyframe mode needs --first-frame and/or --last-frame.");
    }
    if (referenceImages.length || audios.length || videoRef.length) {
      throw new CliError("MODE_INVALID", "keyframe mode does not accept images/audios/videos; pass --image twice for first+last frame.");
    }
    if (firstFrame) payload.first_frame = firstFrame;
    if (lastFrame) payload.last_frame = lastFrame;
  } else if (mode === "reference") {
    if (firstFrame || lastFrame) {
      throw new CliError("MODE_INVALID", "reference mode does not accept first_frame/last_frame.");
    }
    if (!referenceImages.length && !audios.length && !videoRef.length) {
      throw new CliError("MODE_INVALID", "reference mode needs at least one image/audio/video reference.");
    }
    if (referenceImages.length > m.maxImages) {
      throw new CliError("MODE_INVALID", `${model} accepts at most ${m.maxImages} reference images.`);
    }
    if (audios.length > m.maxAudios) {
      throw new CliError("MODE_INVALID", `${model} accepts at most ${m.maxAudios} reference audios.`);
    }
    if (videoRef.length && !m.supportsVideoRef) {
      throw new CliError("MODE_INVALID", `${model} does not support video references.`);
    }
    if (referenceImages.length) payload.images = referenceImages;
    if (audios.length) payload.audios = audios;
    if (videoRef.length) payload.videos = videoRef.map((url) => ({ url, start_seconds: 0, require_audio: false }));
  } else if (firstFrame || lastFrame || referenceImages.length || audios.length || videoRef.length) {
    throw new CliError("MODE_INVALID", "text mode accepts no media; use --mode keyframe or --mode reference.");
  }

  void ttl;
  return payload;
}

/* --------------------------------------------------------------------- poll */

async function pollTask({ key, pollBase, videoId, model, timeoutSec, intervalSec, onProgress }) {
  const deadline = Date.now() + timeoutSec * 1000;
  let attempt = 0;
  let backoff = intervalSec * 1000;

  while (Date.now() < deadline) {
    attempt += 1;
    const url = new URL("/agnesapi", pollBase);
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("model_name", model);

    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      log(`  poll #${attempt}: network error (${err.message}), retrying`);
      await sleep(backoff);
      continue;
    }

    if (res.status === 429) {
      log(`  poll #${attempt}: 429 rate limited, backing off`);
      backoff = Math.min(backoff * 2, 15000);
      await sleep(backoff);
      continue;
    }
    if (res.status === 404) {
      throw new CliError("TASK_NOT_FOUND", `Agnes does not know video_id ${videoId} for ${model}.`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new CliError("POLL_FAILED", `Polling failed with HTTP ${res.status}: ${redact(text).slice(0, 400)}`);
    }

    const body = await res.json();
    const status = body.status;
    const progress = typeof body.progress === "number" ? body.progress : 0;
    onProgress?.({ attempt, status, progress });

    if (status === "completed") {
      if (!body.url) {
        throw new CliError("URL_MISSING", "Task completed but no top-level url was returned.", body);
      }
      return body;
    }
    if (status === "failed" || status === "canceled") {
      const message = body?.error?.message || body?.error || "Video generation failed.";
      throw new CliError("TASK_FAILED", `Agnes reported ${status}: ${redact(message)}`, body);
    }
    backoff = intervalSec * 1000;
    await sleep(backoff);
  }
  throw new CliError("POLL_TIMEOUT", `Gave up after ${timeoutSec}s. Task may still complete; resume with:\n  agnes-video poll ${videoId} --model ${model}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, outPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new CliError("DOWNLOAD_FAILED", `Download failed with HTTP ${res.status}.`);
  await fs.mkdir(dirname(outPath), { recursive: true });
  const body = res.body;
  if (!body) {
    await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  } else {
    await pipeline(Readable.fromWeb(body), createWriteStream(outPath));
  }
  const stat = await fs.stat(outPath);
  if (stat.size === 0) throw new CliError("DOWNLOAD_FAILED", "Downloaded file is empty.");
  return { path: outPath, bytes: stat.size };
}

function slug(s) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-${base || "video"}`;
}

/* ------------------------------------------------------------------ commands */

function usage() {
  return `agnes-video — Agnes AI video production for Arena Agent Mode

USAGE
  agnes-video doctor
  agnes-video quota
  agnes-video produce [--prompt "idea"] [--image path-or-url]... [options]
  agnes-video storyboard <plan.json> [options]   multi-shot production
  agnes-video plan --prompt "idea" [--shots 3]   scene plan only (free, no API)
  agnes-video prompt --prompt "idea" [--camera pushin]   compiled prompt only
  agnes-video create  ...same options as produce, but does not poll
  agnes-video poll <video_id> [--model <model>] [--timeout 900]
  agnes-video download <url> [--out output/file.mp4]
  agnes-video ledger

MODES (auto-detected from the media you pass)
  text        prompt only
  keyframe    --image with one file  -> used as first_frame (image-to-video)
  keyframe    --image a --image b    -> first_frame + last_frame
  reference   --image ... --audio ... -> content/style/motion references

CORE OPTIONS
  --prompt <text>       video idea. Use <Picture 1>/<Audio 1> in reference mode
  --script <file>       read the prompt from a file instead
  --image <path|url>    repeatable
  --audio <path|url>    repeatable
  --video-ref <url>     reference video (agnes-video-2.5 only)
  --seconds <4-12>      default 5
  --size <tier>         720P (flash) | 720P,1080P,1K,2K (2.5)
  --aspect <ratio>      ${ASPECTS.join(" ")}   (default 16:9)
  --mode <m>            text|keyframe|reference (default: auto)
  --seed <int>
  --model <id>          default ${FREE_MODEL}
  --allow-paid          required, with AGNES_ALLOW_PAID=1, for non-free models
  --out <dir>           default ./output
  --timeout <sec>       poll budget, default 900
  --interval <sec>      poll interval, default 2
  --json                machine-readable result on stdout
  --dry-run             build and show the exact payload; sends nothing, costs nothing

MODEL SAFETY
  ${FREE_MODEL}  free trial price $0/s (720P only)   <- default
  agnes-video-2.5             $0.025-$0.055 / second  <- needs --allow-paid
  ${RETIRED}          RETIRED 2026-09-25, refused

ENVIRONMENT
  AGNES_API_KEY            required for any live call (never printed)
  AGNES_BASE_URL           default https://apihub.agnes-ai.com/v1
  AGNES_POLL_BASE_URL      default https://apihub.agnes-ai.com
  AGNES_ALLOW_PAID         1 to permit non-free models
  AGNES_UPLOAD_PROVIDER    litterbox to opt in to local-file publishing; default off
`;
}

async function cmdDoctor({ flags }) {
  const key = process.env.AGNES_API_KEY;
  const base = process.env.AGNES_BASE_URL || DEFAULT_BASE;
  const pollBase = process.env.AGNES_POLL_BASE_URL || DEFAULT_POLL_BASE;
  const report = {
    node: process.version,
    key: key ? `present (${key.length} chars, ${key.slice(0, 3)}…)` : "MISSING",
    baseUrl: base,
    pollBaseUrl: pollBase,
    defaultModel: FREE_MODEL,
    allowPaid: process.env.AGNES_ALLOW_PAID === "1",
    uploadProvider: process.env.AGNES_UPLOAD_PROVIDER || "disabled",
    ledgerPath: LEDGER,
  };
  if (key) report.preflight = await preflight(key.trim(), base);
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("Agnes video bridge — doctor");
    console.log(`  node           ${report.node}`);
    console.log(`  API key        ${report.key}`);
    console.log(`  base URL       ${report.baseUrl}`);
    console.log(`  poll base      ${report.pollBaseUrl}`);
    console.log(`  default model  ${report.defaultModel} (free trial)`);
    console.log(`  paid unlocked  ${report.allowPaid ? "YES" : "no (blocked)"}`);
    console.log(`  upload bridge  ${report.uploadProvider}`);
    if (report.preflight) {
      console.log(`  preflight      ${report.preflight.verdict} — ${report.preflight.detail}`);
    }
  }
  // Exit codes: 0 healthy, 2 no key, 3 key rejected, 4 no route to Agnes.
  if (!key) return 2;
  if (report.preflight?.verdict === "unauthorized") return 3;
  if (report.preflight && report.preflight.reachable === false) return 4;
  return 0;
}

async function cmdQuota({ flags }) {
  const key = requireKey();
  const base = process.env.AGNES_BASE_URL || DEFAULT_BASE;
  const pf = await preflight(key, base);
  const history = await readLedger();
  const out = {
    note:
      "Agnes publishes no quota/balance API. This is a preflight health check plus a local ledger, " +
      "not a server-side balance. Authoritative numbers live in platform.agnes-ai.com -> Usage/Billing.",
    preflight: pf,
    localLedger: {
      generations: history.length,
      freeGenerations: history.filter((h) => h.free).length,
      paidGenerations: history.filter((h) => !h.free).length,
      estimatedSpendUsd: round(history.reduce((s, h) => s + (h.estimatedTrialUsd ?? 0), 0)),
      last: history.slice(-5),
    },
  };
  if (flags.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log("Agnes quota check");
    console.log(`  verdict        ${pf.verdict}`);
    console.log(`  detail         ${pf.detail}`);
    console.log(`  local ledger   ${out.localLedger.generations} runs, ${out.localLedger.freeGenerations} free, ` +
      `${out.localLedger.paidGenerations} paid, est. $${out.localLedger.estimatedSpendUsd}`);
    console.log("  server balance is only visible at platform.agnes-ai.com -> Usage");
  }
  return pf.verdict === "unauthorized" ? 3 : 0;
}

function detectMode(flags, images, audios, videoRef) {
  if (flags.mode && flags.mode !== true) return String(flags.mode);
  if (audios.length || videoRef.length) return "reference";
  if (images.length >= 2) return "keyframe";
  if (images.length === 1) return "keyframe";
  return "text";
}

async function cmdCreate({ flags, positional }, opts = {}) {
  const key = requireKey();
  const base = (process.env.AGNES_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
  const pollBase = process.env.AGNES_POLL_BASE_URL || DEFAULT_POLL_BASE;

  let prompt = typeof flags.prompt === "string" ? flags.prompt : "";
  if (typeof flags.script === "string") prompt = (await fs.readFile(flags.script, "utf8")).trim();
  if (!prompt && positional.length) prompt = positional.join(" ");
  if (!prompt) throw new CliError("PROMPT_MISSING", "Pass --prompt \"your video idea\" or --script file.txt.");

  const one = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const imageInputs = one(flags.image);
  const audioInputs = one(flags.audio);
  const videoInputs = one(flags["video-ref"]);

  const mode = detectMode(flags, imageInputs, audioInputs, videoInputs);

  let model = typeof flags.model === "string" ? flags.model : FREE_MODEL;
  if (String(model).includes(RETIRED)) {
    throw new CliError("MODEL_RETIRED", `${RETIRED} was retired 2026-09-25. Use ${FREE_MODEL}.`);
  }
  if (!MODELS[model]) throw new CliError("MODEL_UNKNOWN", `Unknown model ${model}.`);

  const size = typeof flags.size === "string" ? flags.size : "720P";
  const seconds = num(flags.seconds, 5);
  const aspect = typeof flags.aspect === "string" ? flags.aspect : "16:9";
  const seed = flags.seed !== undefined ? num(flags.seed, undefined) : undefined;
  const outDir = typeof flags.out === "string" ? resolve(flags.out) : join(GENERATED, "videos");
  const timeoutSec = num(flags.timeout, 900);
  const intervalSec = num(flags.interval, 2);

  const cost = estimateCost(model, size, seconds, imageInputs.length);
  const allowPaid = process.env.AGNES_ALLOW_PAID === "1" && flags["allow-paid"];
  if (!cost.free && !allowPaid) {
    throw new CliError(
      "PAID_BLOCKED",
      `${model} at ${size} for ${seconds}s is not free (est. $${cost.trialPrice} at trial pricing).\n` +
        `Blocked by default. Use --model ${FREE_MODEL}, or re-run with --allow-paid and AGNES_ALLOW_PAID=1.`,
    );
  }

  const dryRun = Boolean(flags["dry-run"]);

  log(`Agnes video: ${model} | mode=${mode} | ${seconds}s | ${size} | ${aspect}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) {
    const previewImages = imageInputs.map((i) => (/^https?:/i.test(i) ? i : "<local file — needs public URL>"));
    const payload = buildPayload({
      prompt, model, mode, seconds, size, aspect, seed,
      images: previewImages, audios: audioInputs, videoRef: videoInputs,
      firstFrame: mode === "keyframe" ? previewImages[0] : undefined,
      lastFrame: mode === "keyframe" ? previewImages[1] : undefined,
    });
    const preview = {
      dryRun: true,
      endpoint: `POST ${base}/videos`,
      poll: `GET ${pollBase}/agnesapi?video_id=<VIDEO_ID>&model_name=${model}`,
      payload,
      estimate: cost,
      paidAllowed: Boolean(allowPaid),
    };
    if (flags.json) console.log(JSON.stringify(preview, null, 2));
    else {
      console.log(JSON.stringify(payload, null, 2));
      console.log(`\nestimate: $${cost.trialPrice} trial / $${cost.listPrice} list — ${cost.free ? "FREE" : "PAID"}`);
      console.log("dry run: nothing was sent, nothing was charged.");
    }
    return { dryRun: true, phase: "dry", ...preview };
  }
  const pf = await preflight(key, base);
  log(`preflight: ${pf.verdict} — ${pf.detail}`);
  if (pf.verdict === "unauthorized") throw new CliError("AUTH_INVALID", pf.detail);
  if (pf.verdict === "no_credit" && !allowPaid) {
    throw new CliError("NO_CREDIT", `${pf.detail}\nFree tier looks exhausted; paid use is blocked unless you pass --allow-paid with AGNES_ALLOW_PAID=1.`);
  }

  const images = [];
  for (const raw of imageInputs) images.push(await resolveMedia(raw, flags));
  const audios = [];
  for (const raw of audioInputs) audios.push(await resolveMedia(raw, flags));
  const videoRef = [];
  for (const raw of videoInputs) videoRef.push(await resolveMedia(raw, flags));

  void classifyMedia;

  const payload = buildPayload({
    prompt, model, mode, seconds, size, aspect, seed,
    images, audios, videoRef,
    firstFrame: mode === "keyframe" ? images[0] : undefined,
    lastFrame: mode === "keyframe" ? images[1] : undefined,
  });

  const created = await agnesFetch(`${base}/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, "Create video task");

  const videoId = created.video_id || created.id || created.task_id;
  if (!videoId) throw new CliError("NO_VIDEO_ID", "Create response had no video_id.", created);

  await appendLedger({
    at: new Date().toISOString(), model, mode, size, seconds, aspect,
    videoId, free: cost.free, estimatedTrialUsd: cost.trialPrice,
    estimatedListUsd: cost.listPrice, prompt: prompt.slice(0, 200),
    preflight: pf.verdict,
  });

  log(`created video_id=${videoId} status=${created.status ?? "queued"}`);

  const result = {
    ok: true, videoId, model, mode, size, seconds, aspect,
    estimatedTrialUsd: cost.trialPrice, free: cost.free,
    status: "created", url: null, localPath: null,
  };

  if (flags["no-poll"]) {
    return { ...result, phase: "queued" };
  }

  const done = await pollTask({
    key, pollBase, videoId, model, timeoutSec, intervalSec,
    onProgress: ({ attempt, status, progress }) => log(`  poll #${attempt}: ${status} ${progress}%`),
  });

  result.status = done.status;
  result.url = done.url;

  const outPath = join(outDir, `${slug(prompt)}.mp4`);
  const file = await download(done.url, outPath);
  result.localPath = file.path;
  result.bytes = file.bytes;

  return { ...result, phase: "done" };
}

function reportProduce(result, flags) {
  if (result.phase === "dry") return 0;
  if (flags.json) {
    const { phase, ...rest } = result;
    void phase;
    console.log(JSON.stringify(rest, null, 2));
    return 0;
  }
  if (result.phase === "queued") {
    console.log(`Queued. video_id=${result.videoId}\nResume: agnes-video poll ${result.videoId} --model ${result.model}`);
    return 0;
  }
  console.log(`Done: ${result.status}`);
  console.log(`  video_id  ${result.videoId}`);
  console.log(`  url       ${result.url}`);
  console.log(`  saved     ${result.localPath} (${(result.bytes / 1048576).toFixed(2)} MB)`);
  return 0;
}

async function cmdPoll({ positional, flags }) {
  const key = requireKey();
  const videoId = positional[0];
  if (!videoId) throw new CliError("ARGS", "Usage: agnes-video poll <video_id> [--model m]");
  const model = typeof flags.model === "string" ? flags.model : FREE_MODEL;
  const pollBase = process.env.AGNES_POLL_BASE_URL || DEFAULT_POLL_BASE;
  const done = await pollTask({
    key, pollBase, videoId, model,
    timeoutSec: num(flags.timeout, 900),
    intervalSec: num(flags.interval, 2),
    onProgress: ({ attempt, status, progress }) => log(`  poll #${attempt}: ${status} ${progress}%`),
  });
  if (flags.json) console.log(JSON.stringify({ ok: true, videoId, status: done.status, url: done.url }, null, 2));
  else console.log(`${done.status}\n${done.url}`);
  return 0;
}

async function cmdDownload({ positional, flags }) {
  const url = positional[0];
  if (!/^https?:\/\//i.test(url || "")) throw new CliError("ARGS", "Usage: agnes-video download <url> [--out file.mp4]");
  const out = typeof flags.out === "string"
    ? resolve(flags.out)
    : join(GENERATED, "videos", `${slug("video")}.mp4`);
  const file = await download(url, out);
  if (flags.json) console.log(JSON.stringify({ ok: true, ...file }));
  else console.log(`saved ${file.path} (${(file.bytes / 1048576).toFixed(2)} MB)`);
  return 0;
}

async function cmdPrompt({ flags }) {
  const prompt = compilePrompt({
    idea: typeof flags.prompt === "string" ? flags.prompt : "",
    subject: flags.subject, action: flags.action, camera: flags.camera,
    style: flags.style, lighting: flags.lighting, motion: flags.motion,
    sound: flags.sound, consistency: flags.consistency, negatives: flags.negatives,
    mode: typeof flags.mode === "string" ? flags.mode : "text",
  });
  if (!prompt) throw new CliError("PROMPT_MISSING", 'Pass --prompt "your idea".');
  if (flags.json) console.log(JSON.stringify({ prompt }, null, 2));
  else console.log(prompt);
  return 0;
}

async function cmdPlan({ flags }) {
  const idea = typeof flags.prompt === "string" ? flags.prompt : "";
  if (!idea) throw new CliError("PROMPT_MISSING", "Pass --prompt \"your idea\".");
  const plan = planScenes({
    idea,
    shotCount: num(flags.shots, 3),
    beat: num(flags.seconds, 4),
    style: flags.style,
    camera: flags.camera,
    aspect: typeof flags.aspect === "string" ? flags.aspect : "16:9",
  });
  if (typeof flags.out === "string") {
    const path = resolve(flags.out);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(plan, null, 2));
    log(`plan written to ${path}`);
  }
  const est = estimateCost(plan.model, plan.size, plan.shots.reduce((n, s2) => n + s2.seconds, 0), 0);
  const payload = { ...plan, estimate: est };
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`Scene plan: ${plan.title} (${plan.shots.length} shots, ${plan.shots.reduce((n, s2) => n + s2.seconds, 0)}s)`);
    for (const sh of plan.shots) console.log(`  ${sh.shot}. [${sh.beat}] ${sh.prompt}`);
    console.log(`\nmodel ${plan.model} @ ${plan.size} — estimated trial cost $${est.trialPrice}`);
  }
  return 0;
}

/**
 * Multi-shot production. Takes a scene plan and produces each shot in order,
 * reusing the exact same safe path as `produce`.
 *
 * plan.json:
 * {
 *   "title": "perfume launch",
 *   "shots": [
 *     { "prompt": "...", "seconds": 4, "image": "https://..." },
 *     { "prompt": "...", "seconds": 4, "image": "https://...", "last_frame": "https://..." }
 *   ]
 * }
 */
async function cmdStoryboard({ positional, flags }) {
  const file = positional[0];
  if (!file) throw new CliError("ARGS", "Usage: agnes-video storyboard plan.json");
  let plan;
  try {
    plan = JSON.parse(await fs.readFile(resolve(file), "utf8"));
  } catch (err) {
    throw new CliError("PLAN_INVALID", `Could not read scene plan ${file}: ${err.message}`);
  }
  const shots = Array.isArray(plan) ? plan : plan.shots;
  if (!Array.isArray(shots) || !shots.length) {
    throw new CliError("PLAN_INVALID", "Scene plan needs a non-empty shots array.");
  }

  const allowPaid = process.env.AGNES_ALLOW_PAID === "1" && flags["allow-paid"];
  const model = typeof flags.model === "string" ? flags.model : FREE_MODEL;
  const size = typeof flags.size === "string" ? flags.size : "720P";
  const total = shots.reduce((n, s) => n + num(s.seconds, num(flags.seconds, 5)), 0);
  const est = estimateCost(model, size, total, 0);
  if (!est.free && !allowPaid) {
    throw new CliError(
      "PAID_BLOCKED",
      `Storyboard would use ${total}s on ${model} at ${size}: est. $${est.trialPrice} at trial pricing.
` +
        `Blocked. Free path: --model ${FREE_MODEL} (720P).`,
    );
  }

  log(`Storyboard "${plan.title ?? "untitled"}": ${shots.length} shot(s), ${total}s total, model ${model}`);
  const results = [];
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    log(`\n[${i + 1}/${shots.length}] ${String(shot.prompt ?? "").slice(0, 70)}...`);
    const args = [
      "--prompt", shot.prompt,
      "--model", model,
      "--size", size,
      "--seconds", String(num(shot.seconds, num(flags.seconds, 5))),
      "--aspect", String(shot.aspect ?? flags.aspect ?? "16:9"),
      "--interval", String(num(flags.interval, 2)),
      "--timeout", String(num(flags.timeout, 900)),
      "--json",
    ];
    if (shot.image) args.push("--image", shot.image);
    if (shot.last_frame) args.push("--image", shot.last_frame);
    if (shot.mode) args.push("--mode", shot.mode);
    if (flags.out) args.push("--out", flags.out);
    if (allowPaid) args.push("--allow-paid");

    const shotResult = await cmdCreate({ flags: parseArgs(args).flags, positional: [] });
    results.push({
      shot: i + 1, videoId: shotResult.videoId, url: shotResult.url,
      localPath: shotResult.localPath, seconds: shotResult.seconds,
      size: shotResult.size, status: shotResult.status,
    });
  }

  const manifest = { title: plan.title ?? "storyboard", model, size, shots: results, finishedAt: new Date().toISOString() };
  const manifestPath = join(GENERATED, `storyboard-${slug(plan.title ?? "plan")}.json`);
  await fs.mkdir(GENERATED, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  if (flags.json) console.log(JSON.stringify(manifest, null, 2));
  else {
    console.log(`\nStoryboard complete: ${results.length} shot(s)`);
    for (const r of results) console.log(`  shot ${r.shot}: ${r.videoId}`);
    console.log(`  manifest  ${manifestPath}`);
  }
  return 0;
}

async function cmdLedger({ flags }) {
  const rows = await readLedger();
  if (flags.json) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log("No generations recorded yet.");
  else {
    for (const r of rows) {
      console.log(`${r.at}  ${r.model}  ${r.mode}  ${r.seconds}s  ${r.size}  ${r.free ? "FREE" : "PAID"}  ${r.videoId}`);
    }
    console.log(`\n${rows.length} runs, est. $${round(rows.reduce((s, r) => s + (r.estimatedTrialUsd ?? 0), 0))}`);
  }
  return 0;
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift() || "help";
  if (flags.help || cmd === "help") { console.log(usage()); return 0; }

  try {
    switch (cmd) {
      case "doctor": return await cmdDoctor({ flags });
      case "quota": return await cmdQuota({ flags });
      case "create":
      case "produce": {
        const result = await cmdCreate({ flags, positional });
        return reportProduce(result, flags);
      }
      case "poll": return await cmdPoll({ positional, flags });
      case "download": return await cmdDownload({ positional, flags });
      case "storyboard": return await cmdStoryboard({ flags, positional });
      case "plan": return await cmdPlan({ flags });
      case "prompt": return await cmdPrompt({ flags });
      case "ledger": return await cmdLedger({ flags });
      default:
        log(`Unknown command: ${cmd}\n`);
        console.log(usage());
        return 1;
    }
  } catch (err) {
    if (err instanceof CliError) {
      log(`\nerror [${err.code}]: ${redact(err.message)}`);
      return 1;
    }
    log(`\nunexpected error: ${redact(err.stack || err.message)}`);
    return 1;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  log(redact(err?.stack || String(err)));
  process.exit(1);
});

export { buildPayload, estimateCost, pollTask, MODELS, FREE_MODEL };
void basename;
