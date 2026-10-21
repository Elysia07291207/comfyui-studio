/**
 * lib/graph.mjs — 出图工作流。
 *
 * 从前这份图是**写死**的：Qwen-Image-2.1（GGUF 量化 DiT + w4a8 文本编码器 + bf16 VAE），
 * 连权重名都钉死在本机 `models/` 下的实际文件名上。换台机器第一行就崩。
 *
 * 现在分成两层：
 *   · `buildGraph(o)`        —— 默认线（Qwen GGUF），**逐字节保持原样**，不冒险。
 *   · `buildGraphForPlan(p)` —— 按适配内核判出来的线拼图。
 *
 * 适配内核（`lib/adapt.mjs`）负责"该用哪条线、哪些加载器、哪些权重"；
 * 这里只负责**按决定拼图**。两边的分工是：
 *   内核判定 → 这份拼图 → 提交。
 *
 * 哪些线能拼、哪些还不能，见 `buildGraphForPlan` 里的分派与注释。
 * 拼不了的一律**明确报错**，不猜着拼一张错的图出来。
 */

/** 默认负向词（照搬她的脚本，反像素风/反 AI 味那一串）。 */
export const DEFAULT_NEGATIVE =
  "光滑渐变，抗锯齿，模糊，景深虚化，柔光，3D渲染，写实，摄影，油画，水彩，扁平矢量，厚涂，赛璐璐，插画感，低分辨率放大，糊边，AI感，噪点，网点，杂色，压缩噪点";

/** 本机默认线（Qwen-Image-2.1 GGUF）用到的三个权重，名称必须与 models/ 下的实际文件名一致。
    别的线由适配内核（lib/adapt.mjs）从 /object_info 里反查，不写在这儿。 */
export const WEIGHTS = {
  unet: "qwen_image_2.1-Q4_K.gguf",
  clip: "qwen3vl_8b_w4a8.safetensors",
  clipType: "qwen_image",
  vae: "qwen_image_2.1_vae_bf16.safetensors",
};

/** 默认线 id：与改造前一模一样的那条。界面上不选线、或选了它就等于走原路。 */
export const DEFAULT_LINE = "qwen-image-gguf";
export const DEFAULTS = {
  width: 1024,
  height: 1024,
  steps: 40,
  cfg: 1.0,
  sampler: "euler",
  scheduler: "simple",
  prefix: "hana/comfy",
};

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 把一份"线的决定"规范成拼图需要的字段，省得每个分支各写一遍。 */
function normalize(o = {}) {
  const positive = String(o.positive ?? "").trim();
  if (!positive) throw new Error("提示词是空的");
  return {
    positive,
    negative: String(o.negative ?? DEFAULT_NEGATIVE),
    width: clampInt(o.width, DEFAULTS.width, 256, 2048),
    height: clampInt(o.height, DEFAULTS.height, 256, 2048),
    steps: clampInt(o.steps, DEFAULTS.steps, 1, 100),
    cfg: clampNum(o.cfg, DEFAULTS.cfg, 0, 20),
    sampler: String(o.sampler ?? DEFAULTS.sampler),
    scheduler: String(o.scheduler ?? DEFAULTS.scheduler),
    seed: Number.isFinite(Number(o.seed)) ? Number(o.seed) : Math.floor(Math.random() * 1e15),
    prefix: String(o.prefix ?? DEFAULTS.prefix),
    refImages: Array.isArray(o.refImages) ? o.refImages.filter((r) => r && r.name) : [],
  };
}

/* ── 默认线：Qwen-Image-2.1（GGUF） ────────────────────────────────────
   行为与改造前**完全一致**（含节点号、输入、Qwen 专用编码节点）。 */

function qwenGraph(o = {}, weights = WEIGHTS, ditNode = "UnetLoaderGGUF") {
  const { positive, negative, width, height, steps, cfg, sampler, scheduler, seed, prefix, refImages } = normalize(o);

  const graph = {
    1: { class_type: ditNode, inputs: { unet_name: weights.unet } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: weights.clip, type: weights.clipType } },
    3: { class_type: "VAELoader", inputs: { vae_name: weights.vae } },
    5: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    7: { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
    8: { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: prefix } },
  };

  const encode = {
    clip: ["2", 0],
    prompt: positive,
    negative_prompt: negative,
    resolution: 1024,
  };

  if (refImages.length > 0) {
    encode.vae = ["3", 0];
    refImages.forEach((ref, index) => {
      const nodeId = String(10 + index);
      graph[nodeId] = { class_type: "LoadImage", inputs: { image: String(ref.name) } };
      encode[`images.image_${index + 1}`] = [nodeId, 0];
    });
  }

  graph[4] = { class_type: "TextEncodeQwenImage21", inputs: encode };
  graph[6] = {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      positive: ["4", 0],
      negative: ["4", 1],
      latent_image: ["5", 0],
      denoise: 1.0,
    },
  };

  return { graph, seed, width, height, steps, cfg, prefix };
}

/**
 * 默认线：Qwen-Image-2.1（GGUF 量化）。
 * 这个函数的输出**不许变**——它是当前唯一实跑确认过的那条路。
 */
export function buildGraph(o = {}) {
  return qwenGraph(o, WEIGHTS, "UnetLoaderGGUF");
}

/* ── 通用：DiT 拆分式（一个 DiT + 一个文本塔 + 一个 VAE 分开加载） ──────
   anima 实测走的就是这个形状（2026-10-09，256²/4 步/6.1s 通过）。
   编码用**通用** CLIPTextEncode，不是 Qwen 那个专用节点。 */

function splitDitGraph(o, line) {
  const { positive, negative, width, height, steps, cfg, sampler, scheduler, seed, prefix } = normalize(o);
  const ditNode = line.loader?.dit?.node || "UNETLoader";
  const clipNode = line.loader?.clip?.node || "CLIPLoader";
  const vaeNode = line.loader?.vae?.node || "VAELoader";
  const clipType = line.loader?.clip?.type || "stable_diffusion";

  // 各加载器的必填口不一样：UNETLoader 还要一个 weight_dtype（UnetLoaderGGUF 不要）。
  // 少一个就得 ComfyUI 吃 400 —— 宁在这儿写清楚，不留到提交时才发现。
  const ditInputs = { unet_name: line.weights.dit };
  if (ditNode === "UNETLoader") ditInputs.weight_dtype = "default";

  const graph = {
    1: { class_type: ditNode, inputs: ditInputs },
    2: { class_type: clipNode, inputs: { clip_name: line.weights.clip || "", type: clipType } },
    3: { class_type: vaeNode, inputs: { vae_name: line.weights.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["2", 0] } },
    5: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    6: {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], seed, steps, cfg,
        sampler_name: sampler, scheduler,
        positive: ["4", 0], negative: ["4", 0],
        latent_image: ["5", 0], denoise: 1.0,
      },
    },
    7: { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
    8: { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: prefix } },
  };
  return { graph, seed, width, height, steps, cfg, prefix, note: "通用 CLIPTextEncode（单口正负共用）" };
}

/* ── 通用：经典一体式 ckpt（一个文件顶 MODEL + CLIP + VAE） ──────────── */

function classicGraph(o, line) {
  const { positive, negative, width, height, steps, cfg, sampler, scheduler, seed, prefix } = normalize(o);
  const enc = line.encNode || "CLIPTextEncode";

  // SDXL 的编码节点要多几个入口（text_g/text_l + 尺寸），不是简单换个 class_type。
  const encInputs = enc === "CLIPTextEncodeSDXL"
    ? { text_g: positive, text_l: positive, clip: ["1", 1], width, height, crop_w: 0, crop_h: 0, target_width: width, target_height: height }
    : { text: positive, clip: ["1", 1] };

  const graph = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: line.weights.dit } },
    2: { class_type: enc, inputs: encInputs },
    3: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    4: {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], seed, steps, cfg,
        sampler_name: sampler, scheduler,
        positive: ["2", 0], negative: ["2", 0],
        latent_image: ["3", 0], denoise: 1.0,
      },
    },
    5: { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
    6: { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: prefix } },
  };
  return { graph, seed, width, height, steps, cfg, prefix, note: "经典一体式 ckpt；负向入口暂与正向同源（未接负向编码节点）" };
}

/* ── 按线拼图 ──────────────────────────────────────────────────────── */

/** 能拼的线。没列在这儿的一律明确报错，不猜着拼。 */
export const COMPOSABLE_LINES = ["qwen-image-gguf", "qwen-image-full", "anima", "sdxl", "sd15"];

/**
 * @param {object} line 适配内核判出来的一条候选线（含 loader / weights / encNode / params）
 * @param {object} o    本次出图的参数（positive 必填）
 */
export function buildGraphForPlan(line, o = {}) {
  const id = line?.id;
  if (!id) throw new Error("没有给出线路（line 为空）");

  if (id === "qwen-image-gguf") {
    // 默认线：走原路，一个字节都不改
    return buildGraph(o);
  }

  if (id === "qwen-image-full") {
    return qwenGraph(
      o,
      { unet: line.weights.dit, clip: line.weights.clip, clipType: line.loader?.clip?.type || "qwen_image", vae: line.weights.vae },
      line.loader?.dit?.node || "UNETLoader"
    );
  }

  if (id === "anima") {
    if (!line.weights?.clip) throw new Error("anima 线缺文本塔权重");
    return splitDitGraph(o, line);
  }

  if (id === "sdxl" || id === "sd15") {
    return classicGraph(o, line);
  }

  // Flux.1 / Flux.2：要 DualCLIPLoader + CLIPTextEncodeFlux（clip_l/t5xxl/guidance）+ ModelSamplingFlux，
  // 换的不只是加载器。本机没有权重可验，所以**不拼**——拼一张没验过的图比报错更糟。
  if (id === "flux1" || id === "flux2") {
    throw new Error(`${id} 线的拼图还没接上（要 DualCLIPLoader + CLIPTextEncodeFlux + ModelSamplingFlux，换的不只是加载器）。先别用这条线。`);
  }

  throw new Error(`这条线还不会拼图：${id}`);
}
