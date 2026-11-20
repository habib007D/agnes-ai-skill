/**
 * End-to-end tests for agnes-video against the documented Agnes Video 2.5
 * protocol (mock server). No network access required.
 *
 *   node test/run-tests.mjs
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMock } from "./mock-agnes.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "agnes-video.mjs");
const TMP = join(HERE, ".tmp");

const KEY = "test-key-abc123";
const GENERATED = join(HERE, ".tmp", "generated");
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; failures.push(`${name}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

async function cli(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      timeout: 60000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  await fs.rm(GENERATED, { recursive: true, force: true });
  await fs.mkdir(GENERATED, { recursive: true });
  const img = join(TMP, "frame.png");
  await fs.writeFile(img, PNG);

  const mock = createMock({ apiKey: KEY, pollDelayMs: 120 });
  const port = await mock.listen(0);
  const base = `http://127.0.0.1:${port}/v1`;
  const pollBase = `http://127.0.0.1:${port}`;
  const env = {
    AGNES_API_KEY: KEY,
    AGNES_BASE_URL: base,
    AGNES_POLL_BASE_URL: pollBase,
    AGNES_GENERATED_DIR: GENERATED,
  };
  console.log(`\nmock Agnes on ${pollBase}\n`);

  /* ---------------------------------------------------------------- doctor */
  console.log("doctor / auth");
  {
    const r = await cli(["doctor", "--json"], env);
    const out = JSON.parse(r.stdout);
    check("doctor exits 0 with a valid key", r.code === 0, r.stderr);
    check("doctor reports preflight ok", out.preflight?.verdict === "ok", JSON.stringify(out.preflight));
    check("doctor marks key present", String(out.key).startsWith("present"));
    check("doctor never prints the full key", !r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  }
  {
    const r = await cli(["doctor"], { ...env, AGNES_API_KEY: "wrong-key-zzz999" });
    check("bad key is detected (exit 3)", r.code === 3, `code=${r.code} ${r.stderr}`);
    check("bad key is not echoed", !r.stdout.includes("wrong-key-zzz999"));
  }
  {
    const r = await cli(["doctor"], { ...env, AGNES_API_KEY: "" });
    check("missing key exits 2", r.code === 2);
  }

  /* ----------------------------------------------------- text-to-video E2E */
  console.log("\ntext-to-video (full produce pipeline)");
  {
    const outDir = join(TMP, "out-text");
    const r = await cli(["produce", "--prompt", "A neon jellyfish drifting through a rainy Tokyo alley",
      "--seconds", "4", "--out", outDir, "--interval", "0.1", "--json"], env);
    check("produce exits 0", r.code === 0, r.stderr);
    if (r.code === 0) {
      const out = JSON.parse(r.stdout);
      check("status is completed", out.status === "completed", out.status);
      check("model defaults to the free trial model", out.model === "agnes-video-2.5-flash", out.model);
      check("declares itself free", out.free === true);
      check("estimated cost is $0", out.estimatedTrialUsd === 0);
      check("video_id captured", /^video_mock/.test(out.videoId), out.videoId);
      check("url returned", /\/files\/video_mock\d+\.mp4$/.test(out.url || ""), out.url);
      check("mp4 actually written to disk", out.localPath && await fs.stat(out.localPath).then((s) => s.size > 1000).catch(() => false));
    }
    const rec = mock.recorded.filter((x) => x.kind === "create").at(-1);
    check("payload sends seconds as a string", typeof rec.body.seconds === "string", typeof rec.body.seconds);
    check("payload uses size tier not pixels", rec.body.size === "720P", rec.body.size);
    check("payload never sends retired params", !("num_frames" in rec.body) && !("frame_rate" in rec.body));
    check("payload mode is text", rec.body.mode === "text");

    const polls = mock.recorded.filter((x) => x.kind === "poll");
    check("polling happened more than once", polls.length >= 2, `polls=${polls.length}`);
    check("polling passes model_name", polls.every((p) => p.modelName === "agnes-video-2.5-flash"));
  }

  /* ------------------------------------------------- image-to-video E2E */
  console.log("\nimage-to-video (keyframe mode)");
  {
    const outDir = join(TMP, "out-img");
    const r = await cli(["produce", "--prompt", "Slow camera push in, hair moves in the breeze",
      "--image", "https://example.com/portrait.png", "--seconds", "4",
      "--out", outDir, "--interval", "0.1", "--json"], env);
    check("img2video exits 0", r.code === 0, r.stderr);
    if (r.code === 0) {
      const out = JSON.parse(r.stdout);
      check("img2video mode is keyframe", out.mode === "keyframe", out.mode);
      check("img2video completes", out.status === "completed");
    }
    const rec = mock.recorded.filter((x) => x.kind === "create").at(-1);
    check("one image becomes first_frame", rec.body.first_frame === "https://example.com/portrait.png", JSON.stringify(rec.body.first_frame));
    check("keyframe mode sends no images array", rec.body.images === undefined);
    check("first/last frame not sent as last_frame", rec.body.last_frame === undefined);
  }
  {
    const r = await cli(["produce", "--prompt", "Morph between the two frames",
      "--image", "https://example.com/a.png", "--image", "https://example.com/b.png",
      "--seconds", "4", "--interval", "0.1", "--json", "--out", join(TMP, "out-kf2")], env);
    check("two images produce a keyframe task", r.code === 0, r.stderr);
    const rec = mock.recorded.filter((x) => x.kind === "create").at(-1);
    check("two images map to first_frame+last_frame",
      rec.body.first_frame === "https://example.com/a.png" && rec.body.last_frame === "https://example.com/b.png",
      JSON.stringify([rec.body.first_frame, rec.body.last_frame]));
  }

  /* ---------------------------------------------------------- reference flow */
  console.log("\nreference mode");
  {
    const r = await cli(["produce", "--prompt", "Use <Picture 1> as the character",
      "--image", "https://example.com/c.png", "--image", "https://example.com/d.png",
      "--mode", "reference", "--seconds", "4", "--interval", "0.1", "--json",
      "--out", join(TMP, "out-ref")], env);
    check("reference mode exits 0", r.code === 0, r.stderr);
    const rec = mock.recorded.filter((x) => x.kind === "create").at(-1);
    check("reference mode sends images array", Array.isArray(rec.body.images) && rec.body.images.length === 2);
    check("reference polls with model_name", mock.recorded.filter((x) => x.kind === "poll").at(-1).modelName === "agnes-video-2.5-flash");
  }

  /* ------------------------------------------------------------ free guards */
  console.log("\nquota + paid guards");
  {
    const r = await cli(["quota", "--json"], env);
    const out = JSON.parse(r.stdout);
    check("quota exits 0", r.code === 0, r.stderr);
    check("quota reports preflight ok", out.preflight.verdict === "ok");
    check("quota records local ledger", out.localLedger.generations === 4, String(out.localLedger.generations));
    check("quota counts only free runs so far", out.localLedger.paidGenerations === 0, String(out.localLedger.paidGenerations));
    check("quota estimated spend is 0", out.localLedger.estimatedSpendUsd === 0);
    check("quota states the API limitation honestly", /no quota/i.test(out.note));
  }
  {
    const r = await cli(["produce", "--prompt", "paid test", "--model", "agnes-video-2.5",
      "--size", "2K", "--seconds", "12", "--interval", "0.1"], env);
    check("paid model blocked without consent", r.code === 1 && /PAID_BLOCKED/.test(r.stderr), r.stderr.slice(0, 300));
    check("block message states the estimate", /\$0\.\d+/.test(r.stderr));
  }
  {
    const r = await cli(["produce", "--prompt", "paid test", "--model", "agnes-video-2.5", "--size", "720P",
      "--seconds", "4", "--allow-paid", "--interval", "0.1", "--json", "--out", join(TMP, "out-paid")], env);
    check("--allow-paid alone is not enough (needs env opt-in)", r.code === 1 && /PAID_BLOCKED/.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    const r = await cli(["produce", "--prompt", "paid test", "--model", "agnes-video-2.5", "--size", "720P",
      "--seconds", "4", "--allow-paid", "--interval", "0.1", "--json", "--out", join(TMP, "out-paid")],
      { ...env, AGNES_ALLOW_PAID: "1" });
    check("explicit double opt-in allows paid model", r.code === 0, r.stderr.slice(0, 300));
    if (r.code === 0) {
      const out = JSON.parse(r.stdout);
      check("paid run is recorded as not free", out.free === false);
      check("paid estimate is correct for 4s 720P", out.estimatedTrialUsd === 0.1, String(out.estimatedTrialUsd));
    }
  }

  /* --------------------------------------------------------- retired model */
  console.log("\nretired model + validation");
  {
    const r = await cli(["produce", "--prompt", "x", "--model", "agnes-video-v2.0"], env);
    check("agnes-video-v2.0 is refused", r.code === 1 && /MODEL_RETIRED/.test(r.stderr), r.stderr.slice(0, 200));
    check("retirement message names the date", /2026-09-25/.test(r.stderr));
  }
  {
    const r = await cli(["produce", "--prompt", "x", "--seconds", "30"], env);
    check("seconds outside 4-12 rejected", r.code === 1 && /SECONDS_INVALID/.test(r.stderr));
  }
  {
    const r = await cli(["produce", "--prompt", "x", "--size", "1080P"], env);
    check("flash rejects non-720P locally", r.code === 1 && /SIZE_UNSUPPORTED/.test(r.stderr));
  }
  {
    const r = await cli(["produce", "--prompt", "x", "--aspect", "auto"], env);
    check("aspect_ratio auto rejected", r.code === 1 && /ASPECT_UNSUPPORTED/.test(r.stderr));
  }
  {
    const r = await cli(["produce"], env);
    check("missing prompt rejected", r.code === 1 && /PROMPT_MISSING/.test(r.stderr));
  }

  /* ------------------------------------------------------------ local file */
  console.log("\nlocal file handling");
  {
    const r = await cli(["produce", "--prompt", "x", "--image", img, "--interval", "0.1"], env);
    check("local image refused by default", r.code === 1 && /UPLOAD_DISABLED/.test(r.stderr), r.stderr.slice(0, 300));
    check("refusal names the opt-in env var", /AGNES_UPLOAD_PROVIDER/.test(r.stderr));
    check("refusal explains the public-URL risk", /catbox|public/i.test(r.stderr));
  }
  {
    const r = await cli(["produce", "--prompt", "x", "--image", "./nope.png"], env);
    check("missing file gives a clear error", r.code === 1 && /INPUT_NOT_FOUND/.test(r.stderr));
  }

  /* --------------------------------------------------------- create / poll */
  console.log("\nresumable create -> poll -> download");
  {
    const r = await cli(["create", "--prompt", "resume me", "--seconds", "4", "--no-poll", "--json"], env);
    check("create --no-poll exits 0", r.code === 0, r.stderr);
    const out = JSON.parse(r.stdout);
    check("create returns a video_id to resume", /^video_mock/.test(out.videoId));
  }
  {
    const r = await cli(["poll", "video_mock0009", "--timeout", "3", "--interval", "0.1"], env);
    check("polling a bogus id fails cleanly", r.code === 1 && /TASK_NOT_FOUND/.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    const r = await cli(["download", `http://127.0.0.1:${port}/files/x.mp4`, "--out", join(TMP, "direct.mp4"), "--json"], env);
    check("standalone download works", r.code === 0 && JSON.parse(r.stdout).bytes > 1000, r.stderr);
  }

  /* ------------------------------------------------------------- storyboard */
  console.log("\nstoryboard (multi-shot production)");
  {
    const plan = join(TMP, "plan.json");
    await fs.writeFile(plan, JSON.stringify({
      title: "perfume launch",
      shots: [
        { prompt: "Macro bottle detail on a travertine pedestal", seconds: 4 },
        { prompt: "Camera pulls back revealing the full set", seconds: 4,
          image: "https://example.com/hero.png" },
      ],
    }));
    const r = await cli(["storyboard", plan, "--interval", "0.1", "--json"], env);
    check("storyboard exits 0", r.code === 0, r.stderr.slice(0, 400));
    if (r.code === 0) {
      const m = JSON.parse(r.stdout);
      check("storyboard produced 2 shots", m.shots.length === 2, String(m.shots.length));
      check("storyboard uses the free model", m.model === "agnes-video-2.5-flash");
      check("shots recorded distinct video ids", m.shots[0].videoId !== m.shots[1].videoId);
    }
  }
  {
    const plan = join(TMP, "paid-plan.json");
    await fs.writeFile(plan, JSON.stringify({ shots: [{ prompt: "a", seconds: 4 }] }));
    const r = await cli(["storyboard", plan, "--model", "agnes-video-2.5", "--size", "2K"], env);
    check("storyboard blocks paid models without consent", r.code === 1 && /PAID_BLOCKED/.test(r.stderr));
  }
  {
    const r = await cli(["storyboard", join(TMP, "missing.json")], env);
    check("missing plan file fails cleanly", r.code === 1 && /PLAN_INVALID/.test(r.stderr));
  }

  /* ------------------------------------------- prompt / plan / dry-run */
  console.log("\nprompt compiler, scene planner, dry run");
  {
    const r = await cli(["prompt", "--prompt", "a perfume bottle", "--camera", "pushin",
      "--style", "cinematic", "--sound", "room tone"], env);
    const p = r.stdout.trim();
    check("prompt compiler emits a single prompt", r.code === 0 && p.length > 20);
    check("compiled prompt follows documented order",
      p.indexOf("Subject") < p.indexOf("Camera") && p.indexOf("Camera") < p.indexOf("Style"), p);
    check("camera preset expanded", /dolly push-in/.test(p), p);
    check("prompt compile needs no API key", (await cli(["prompt", "--prompt", "x"], { ...env, AGNES_API_KEY: "" })).code === 0);
  }
  {
    const r = await cli(["plan", "--prompt", "a diver in a flooded cathedral", "--shots", "4", "--json"], env);
    check("plan exits 0", r.code === 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    check("plan builds the requested shot count", plan.shots.length === 4, String(plan.shots.length));
    check("plan defaults to the free model", plan.model === "agnes-video-2.5-flash", plan.model);
    check("plan estimate is free", plan.estimate.free === true);
    check("every planned shot has a prompt", plan.shots.every((x) => x.prompt.length > 30));
  }
  {
    const out = join(TMP, "plan-out.json");
    const r = await cli(["plan", "--prompt", "x", "--shots", "2", "--out", out], env);
    check("plan --out writes the file", r.code === 0 && await fs.stat(out).then(() => true).catch(() => false));
  }
  {
    const before = mock.recorded.filter((x) => x.kind === "create").length;
    const r = await cli(["produce", "--prompt", "dry run shot", "--image", "https://example.com/z.png",
      "--dry-run", "--json"], env);
    const after = mock.recorded.filter((x) => x.kind === "create").length;
    check("dry run exits 0", r.code === 0, r.stderr);
    check("dry run sends no create request", before === after, `${before} -> ${after}`);
    const out = JSON.parse(r.stdout);
    check("dry run shows the payload", out.payload.model === "agnes-video-2.5-flash");
    check("dry run shows the poll url with model_name", /model_name=agnes-video-2.5-flash/.test(out.poll));
    check("dry run never sends retired params", !("num_frames" in out.payload) && !("frame_rate" in out.payload));
  }

  /* -------------------------------------------------------------- security */
  console.log("\nkey hygiene");
  {
    const r = await cli(["produce", "--prompt", "x", "--interval", "0.1", "--json"], env);
    check("key never appears on stdout", !r.stdout.includes(KEY));
    check("key never appears on stderr", !r.stderr.includes(KEY));
    // The mock key legitimately appears in this test file, so scan everything else.
    const root = join(HERE, "..");
    const files = await fs.readdir(root, { recursive: true }).catch(() => []);
    const offenders = [];
    for (const f of files) {
      const p = join(root, f);
      if (p.includes(`${join("test", ".tmp")}`) || p.endsWith("mock-agnes.mjs") || p.endsWith("run-tests.mjs")) continue;
      if (/\.(png|jpg|jpeg|mp4|gif|webp)$/i.test(p)) continue;
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isFile() || st.size > 2e6) continue;
      const c = await fs.readFile(p, "utf8").catch(() => "");
      if (c.includes(KEY)) offenders.push(f);
    }
    check("key is not persisted anywhere in the plugin tree", offenders.length === 0, offenders.join(", "));
    const home = join(process.env.HOME || "/root", ".agnes-arena");
    const homeFiles = await fs.readdir(home, { recursive: true }).catch(() => []);
    let homeLeak = false;
    for (const f of homeFiles) {
      const p = join(home, f);
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isFile() || st.size > 2e6) continue;
      const c = await fs.readFile(p, "utf8").catch(() => "");
      if (c.includes(KEY)) homeLeak = true;
    }
    check("key is not written to the generated-artifacts dir", !homeLeak);
  }

  await mock.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
