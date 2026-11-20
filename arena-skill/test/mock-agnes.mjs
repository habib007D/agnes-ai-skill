/**
 * Mock Agnes Video 2.5 API for end-to-end tests.
 *
 * Implements only what the official docs specify, and enforces the documented
 * validation rules so that a payload the real API would reject also fails here:
 *   - POST /v1/videos           create a task
 *   - GET  /agnesapi?video_id=&model_name=   progress + result
 *   - GET  /files/<id>.mp4      fake MP4 bytes
 *   - GET  /_recorded           test-only: captured requests
 *
 * Run standalone:  node test/mock-agnes.mjs --port 8788
 */

import http from "node:http";

const MP4_STUB = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from("isomiso2avc1mp41", "ascii"),
  Buffer.alloc(64 * 1024, 0x21),
]);

const ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const MODELS = {
  "agnes-video-2.5-flash": { sizes: ["720P"], maxImages: 5, maxAudios: 3, videoRef: false },
  "agnes-video-2.5": { sizes: ["720P", "1080P", "1K", "2K"], maxImages: 8, maxAudios: 3, videoRef: true },
};
const DISALLOWED = ["width", "height", "fps", "num_frames", "quality", "num_inference_steps",
  "input_reference", "reference_url", "video_url", "video_path", "video_reference"];

export function createMock({ apiKey = "test-key-abc123", pollDelayMs = 60 } = {}) {
  const tasks = new Map();
  const recorded = [];
  let seq = 0;

  const send = (res, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization || "";

    if (url.pathname === "/_recorded") return send(res, 200, recorded);

    if (url.pathname === "/files" || url.pathname.startsWith("/files/")) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": MP4_STUB.length });
      return res.end(MP4_STUB);
    }

    if (auth !== `Bearer ${apiKey}`) {
      return send(res, 401, { error: { message: "Invalid API key" } });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: Object.keys(MODELS).map((id) => ({ id, object: "model" })) });
    }

    if (req.method === "POST" && url.pathname === "/v1/videos") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body;
      try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: { message: "Invalid JSON" } }); }
      recorded.push({ kind: "create", body });

      const fail = (msg) => send(res, 400, { error: { message: msg } });

      const model = MODELS[body.model];
      if (!model) return fail(`model ${body.model} is not available`);
      if (typeof body.prompt !== "string" || !body.prompt.trim()) return fail("prompt is required");
      if (typeof body.seconds !== "string") return fail("seconds must be a string");
      const sec = Number(body.seconds);
      if (!(sec >= 4 && sec <= 12)) return fail("seconds must be between 4 and 12");
      if (!MODELS[body.model].sizes.includes(body.size)) {
        return fail(body.model === "agnes-video-2.5-flash" ? "size must be 720P" : `unsupported size ${body.size}`);
      }
      if (body.aspect_ratio !== undefined && !ASPECTS.includes(body.aspect_ratio)) return fail("unsupported aspect_ratio");
      if (body.n !== undefined && body.n !== 1) return fail("n must be 1");
      for (const field of DISALLOWED) {
        if (field in body) return fail(`${field} is not supported`);
      }

      const mode = body.mode;
      if (!["text", "keyframe", "reference"].includes(mode)) return fail("mode must be text, keyframe, or reference");

      if (mode === "text") {
        for (const f of ["first_frame", "last_frame", "images", "audios", "videos"]) {
          if (body[f] !== undefined) return fail(`${f} is not allowed in text mode`);
        }
      } else if (mode === "keyframe") {
        if (!body.first_frame && !body.last_frame) return fail("keyframe mode requires first_frame or last_frame");
        for (const f of ["images", "audios", "videos"]) {
          if (body[f] !== undefined) return fail(`${f} is not allowed in keyframe mode`);
        }
      } else {
        if (body.first_frame || body.last_frame) return fail("first_frame/last_frame not allowed in reference mode");
        const imgs = body.images || [];
        const auds = body.audios || [];
        const vids = body.videos || [];
        if (!imgs.length && !auds.length && !vids.length) return fail("reference mode requires media");
        if (imgs.length > model.maxImages) return fail(`images length must not exceed ${model.maxImages}`);
        if (auds.length > model.maxAudios) return fail(`audios length must not exceed ${model.maxAudios}`);
        if (vids.length && !model.videoRef) return fail("videos is not supported");
        for (const u of [...imgs, ...auds]) {
          if (!/^https?:\/\//.test(u)) return fail(`media url must be publicly reachable: ${u}`);
        }
      }

      seq += 1;
      const taskId = `task_mock${String(seq).padStart(4, "0")}`;
      const videoId = `video_mock${String(seq).padStart(4, "0")}`;
      tasks.set(videoId, {
        model: body.model, mode, created: Date.now(), seconds: body.seconds,
        polled: 0, vid: videoId, taskId,
      });
      return send(res, 200, {
        id: taskId, task_id: taskId, video_id: videoId, object: "video",
        model: body.model, status: "queued", progress: 0,
        created_at: Math.floor(Date.now() / 1000), seconds: body.seconds, size: body.size,
      });
    }

    if (req.method === "GET" && url.pathname === "/agnesapi") {
      const videoId = url.searchParams.get("video_id");
      const modelName = url.searchParams.get("model_name");
      recorded.push({ kind: "poll", videoId, modelName });
      const t = tasks.get(videoId);
      if (!t) return send(res, 404, { error: { message: "video not found" } });

      // Documented rule: model_name is optional only for mode:"text".
      if (!modelName && t.mode !== "text") {
        return send(res, 400, { error: { message: "model_name is required for non-text tasks" } });
      }
      if (modelName && modelName !== t.model) {
        return send(res, 404, { error: { message: "video not found for this model" } });
      }

      t.polled += 1;
      const elapsed = Date.now() - t.created;
      const done = elapsed >= pollDelayMs;
      if (!done) {
        return send(res, 200, {
          id: t.taskId, video_id: videoId, object: "video", model: t.model,
          status: t.polled > 1 ? "in_progress" : "queued",
          progress: Math.min(90, t.polled * 30), url: null, error: null,
        });
      }
      const host = req.headers.host;
      return send(res, 200, {
        id: t.taskId, object: "video", status: "completed", progress: 100,
        internal_status: "pending", internal_progress: 0,
        quality: "standard", seconds: t.seconds, size: "720P",
        created_at: Math.floor(t.created / 1000),
        started_at: Math.floor(t.created / 1000),
        completed_at: Math.floor(Date.now() / 1000),
        expires_at: null, remixed_from_video_id: null, error: null,
        url: `http://${host}/files/${videoId}.mp4`,
      });
    }

    return send(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });

  return {
    server,
    tasks,
    recorded,
    listen(port = 0) {
      return new Promise((res) => server.listen(port, "0.0.0.0", () => res(server.address().port)));
    },
    close() {
      return new Promise((res) => server.close(res));
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith("mock-agnes.mjs")) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8788;
  const mock = createMock();
  mock.listen(port).then((p) => console.log(`mock Agnes listening on http://0.0.0.0:${p}`));
}
