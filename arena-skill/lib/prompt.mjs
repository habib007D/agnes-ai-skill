/**
 * Deterministic prompt compiler + scene planner.
 *
 * Agnes Video 2.5 documents a specific prompt order:
 *   1 subject & setting  2 action  3 camera  4 style/light  5 sound  6 consistency
 *
 * The agent does the creative thinking; this module makes sure whatever it
 * (or the user's one-line idea) produces lands in that order and never loses a
 * required beat. No model call, no network, fully reproducible.
 */

const CLEAN = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const STYLE_PRESETS = {
  cinematic: "cinematic film still, 35mm anamorphic, shallow depth of field, natural colour grade",
  commercial: "polished commercial product film, clean seamless backdrop, crisp specular highlights",
  editorial: "editorial fashion film, restrained palette, soft directional light, real skin texture",
  anime: "hand-painted animation, expressive linework, painted backgrounds, limited-palette lighting",
  documentary: "observational documentary, available light, handheld realism, unforced framing",
  product: "luxury product hero film, controlled studio lighting, macro detail, reflective surfaces",
};

const CAMERA_PRESETS = {
  pushin: "slow dolly push-in on a 35mm lens",
  pullback: "smooth dolly pull-back revealing the wider set",
  tracking: "low-angle lateral tracking shot",
  orbit: "slow orbital arc around the subject",
  locked: "locked-off tripod shot, no camera movement",
  handheld: "subtle handheld drift with breathing frame",
  tiltup: "slow tilt up from detail to full subject",
};

const MOTION_PRESETS = {
  subtle: "very restrained motion; the composition must stay stable",
  natural: "natural, believable motion at real-world speed",
  dramatic: "bold, high-energy motion with clear acceleration",
  loop: "seamless cyclic motion that returns to the opening frame",
};

function normalise(value, presets, field) {
  if (!value) return undefined;
  const key = String(value).toLowerCase().replace(/[\s_-]/g, "");
  if (presets[key]) return presets[key];
  // Anything not a known preset is treated as free-form direction.
  return CLEAN(value) || undefined;
}

/**
 * Compile a structured brief into a single Agnes-ready prompt.
 * Any part the user supplied is preserved; missing parts are simply omitted
 * so the prompt never invents story content.
 */
export function compilePrompt({
  idea,
  subject,
  action,
  camera,
  style,
  lighting,
  motion,
  sound,
  consistency,
  negatives,
  mode = "text",
} = {}) {
  const parts = [];
  const seen = new Set();
  const add = (value, label) => {
    const v = CLEAN(value);
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(label ? `${label}: ${v}` : v);
  };

  if (subject) add(subject, "Subject");
  if (idea) add(idea, subject ? undefined : "Subject");

  if (action) add(action, "Action");
  const cam = normalise(camera, CAMERA_PRESETS, "camera");
  if (cam) add(cam, "Camera");
  const mo = normalise(motion, MOTION_PRESETS, "motion");
  if (mo) add(mo, "Motion");

  const st = normalise(style, STYLE_PRESETS, "style");
  const li = CLEAN(lighting);
  if (st || li) add([st, li].filter(Boolean).join(", "), "Style and light");
  if (sound) add(sound, "Sound");

  if (mode === "keyframe") {
    add(consistency || "Preserve the first-frame subject identity, wardrobe, framing and colour; motion must not warp the face or product.",
      "Consistency");
  } else if (mode === "reference") {
    add(consistency || "Keep the referenced subject appearance and art direction consistent throughout.",
      "Consistency");
  } else if (consistency) {
    add(consistency, "Consistency");
  }

  if (negatives) add(`Avoid: ${CLEAN(negatives)}`);

  return parts.join(". ").replace(/\.\.+/g, ".") + (parts.length ? "." : "");
}

/**
 * Split a single idea into a shot list. Deliberately simple and transparent:
 * it shapes pacing and provides the scaffold, while the agent fills the
 * creative detail per shot.
 */
export function planScenes({ idea, shotCount = 3, beat = 4, style, camera, aspect = "16:9" } = {}) {
  const n = Math.max(1, Math.min(8, Number(shotCount) || 3));
  const seconds = Math.max(4, Math.min(12, Number(beat) || 4));
  const concept = CLEAN(idea) || "untitled concept";

  const beats = [
    { name: "establish", camera: camera || "pushin", motion: "subtle", note: "Establish the world and the subject." },
    { name: "develop", camera: "tracking", motion: "natural", note: "Introduce movement and the main action." },
    { name: "detail", camera: "orbit", motion: "subtle", note: "Macro detail, texture and material truth." },
    { name: "escalate", camera: "pullback", motion: "dramatic", note: "Widen the scale, raise the energy." },
    { name: "resolve", camera: "locked", motion: "subtle", note: "Land the hero frame and hold." },
  ];

  const shots = [];
  for (let i = 0; i < n; i += 1) {
    const b = beats[Math.min(i, beats.length - 1)];
    shots.push({
      shot: i + 1,
      beat: b.name,
      prompt: compilePrompt({
        idea: `${concept} — ${b.name} beat. ${b.note}`,
        camera: b.camera,
        style,
        motion: b.motion,
      }),
      seconds,
      aspect,
    });
  }

  return { title: concept, model: "agnes-video-2.5-flash", size: "720P", shots };
}

export const PRESETS = { STYLE_PRESETS, CAMERA_PRESETS, MOTION_PRESETS };
