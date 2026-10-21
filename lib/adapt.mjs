/**
 * lib/adapt.mjs — 让出图台在**别人的** ComfyUI 上自己认路。
 *
 * 设计稿：`创作奇匠\_studio_preview\设计_适配内核.md`（丹青）
 *          `创作奇匠\_studio_preview\设计_适配内核_算法细则.md`（阈值/降权/伪码）
 * 实测真值：`创作奇匠\_studio_preview\comfy_家底_20261008.md`（10 节）
 *
 * 这个模块只做**判定**，不做提交、不拼节点图、不碰网络。
 * 输入：宿主 `/object_info` 的原样 JSON（也可以是磁盘上的快照，便于离线测）。
 * 输出：一份 LinePlan（用哪条线、哪些加载器、哪些权重、什么参数、缺什么、凭什么）。
 *
 * 三条不越的线（细则 §10）：
 *   1. 判据抄 ComfyUI 自己的（model_detection.py / supported_models.py），不自己编"文件名特征表"。
 *   2. 架构语义查不出来时**留空**，不套现成模板。
 *   3. 可达路径可自动，架构语义交模板 + 试跑 + 用户。
 *
 * v0.1 范围：枚举口普查 → 口级分类 → 可达反查 → 机器指纹 → 判线 R0–R7 → 兜底 B1–B5。
 * 还没做（下一步 B5/B6）：按 LinePlan 拼节点图、KSampler 参数的落地校验。
 */

export const VERSION = "0.1.0";

/* ── 常量 ──────────────────────────────────────────────────────────── */

/** 权重类扩展名（判定"这个枚举值像不像一个模型文件"） */
const WEIGHT_EXT = [".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".ggml", ".onnx"];
/** 媒体类扩展名（LoadImage 这类口的值）——也归"像文件"，但不是权重口 */
const MEDIA_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
                   ".mp4", ".webm", ".mov", ".mkv", ".avi", ".mp3", ".wav", ".flac", ".ogg", ".m4a"];

/** 核心加载节点：同一文件多路可达时优先它 */
const CORE_LOADERS = new Set([
  "CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader", "UnetLoaderGGUF", "UnetLoaderGGUFAdvanced",
  "CLIPLoader", "CLIPLoaderGGUF", "DualCLIPLoader", "DualCLIPLoaderGGUF",
  "TripleCLIPLoader", "TripleCLIPLoaderGGUF", "QuadrupleCLIPLoader", "QuadrupleCLIPLoaderGGUF",
  "VAELoader", "LoraLoader", "LoraLoaderModelOnly", "ControlNetLoader", "StyleModelLoader",
  "CLIPVisionLoader", "UpscaleModelLoader",
]);
/** 视频/专品 wrapper：一般不用，除非唯一可达 */
const WRAPPER_HINT = /WanVideo|MultiTalk|Fantasy|Lynx|Ovi|SeedVR2|SAM3D|VHS_|Meshy|FrameInterpolation|OpticalFlow|AudioEncoder/;
/** 第三方合集：可用但次之 */
const THIRDPARTY_HINT = /KJ$|rgthree|IPAdapter|Impact|AILab|PhotoMaker|GLIGEN/;

const ROLE_W = { core: 1.0, thirdparty: 0.7, wrapper: 0.4 };

/* ── 小工具 ────────────────────────────────────────────────────────── */

const re = (s) => (s instanceof RegExp ? s : new RegExp(String(s), "i"));
const base = (p) => String(p).replace(/\\/g, "/").split("/").pop();
const hasExt = (v, exts) => typeof v === "string" && exts.some((e) => v.toLowerCase().endsWith(e));
const isWeightFile = (v) => hasExt(v, WEIGHT_EXT);
const isMediaFile = (v) => hasExt(v, MEDIA_EXT);

function roleOf(nodeName) {
  if (CORE_LOADERS.has(nodeName)) return "core";
  if (WRAPPER_HINT.test(nodeName)) return "wrapper";
  if (THIRDPARTY_HINT.test(nodeName)) return "thirdparty";
  return "thirdparty"; // 不认识的第三方节点，一律当次优，别让它盖过核心
}

/* ── ① 枚举口普查 ──────────────────────────────────────────────────── */

/**
 * 把 object_info 里所有节点的所有**枚举输入**摊成一张表。
 * @returns {{total:number, sites:{node:string,key:string,group:string,options:string[]}[]}}
 */
export function census(objectInfo) {
  const sites = [];
  let total = 0;
  for (const [node, spec] of Object.entries(objectInfo || {})) {
    for (const group of ["required", "optional"]) {
      const src = spec?.input?.[group];
      if (!src) continue;
      for (const [key, def] of Object.entries(src)) {
        const t = Array.isArray(def) ? def[0] : def;
        if (!Array.isArray(t)) continue;
        total++;
        sites.push({ node, key, group, options: t });
      }
    }
  }
  return { total, sites };
}

/* ── ② 口级分类（细则 §3：口级，不是值级） ─────────────────────────── */

export const THETA_STRONG = 0.5; // 像文件名的占比 ≥ 此值 → 强加载口
export const THETA_WEAK = 0.2;   // ≥ 此值且有目录线索 → 弱加载口（降权）

/**
 * 一个枚举口是不是"加载口"。
 * 必须按**整口**判定：VAELoader.vae_name 里的 pixel_space 没有扩展名，
 * 但它和权重同处一口 —— 整口定性为加载口，它就跟着归加载域，不会被误当配置项。
 * 反过来 VHS_LoadVideo.format 整口都是格式名、AIO_Preprocessor.preprocessor 整口都是预处理器名，整口定性为配置口。
 */
export function classifyPorts(sites, { dirHint = null } = {}) {
  const ports = [];
  for (const s of sites) {
    const vals = s.options.filter((v) => typeof v === "string");
    if (!vals.length) continue;
    const weightHits = vals.filter(isWeightFile);
    const mediaHits = vals.filter(isMediaFile);
    const anyFile = weightHits.length + mediaHits.length;
    const ratio = anyFile / vals.length;
    const kind = weightHits.length >= mediaHits.length ? "weight" : "media";
    if (ratio >= THETA_STRONG) ports.push({ ...s, kind, fileRatio: ratio, strength: "strong" });
    else if (ratio >= THETA_WEAK && dirHint) ports.push({ ...s, kind, fileRatio: ratio, strength: "weak" });
  }
  return ports;
}

/* ── ③ 可达反查（细则 §5） ─────────────────────────────────────────── */

/**
 * 手上有一个磁盘文件名，算出它该用哪些加载节点、有多少条路可达，并排序。
 * @returns {{node:string,key:string,kind:string,score:number,role:string,strength:string}[]}
 */
export function reach(fileName, loaderPorts) {
  const target = base(fileName).toLowerCase();
  const out = [];
  for (const p of loaderPorts) {
    const hitExact = p.options.some((v) => typeof v === "string" && v === fileName);
    const hitBase = p.options.some((v) => typeof v === "string" && base(v).toLowerCase() === target);
    if (!hitExact && !hitBase) continue;
    const role = roleOf(p.node);
    const wPort = p.strength === "strong" ? 1.0 : 0.5;
    const wName = hitExact ? 1.0 : 0.9;
    out.push({ node: p.node, key: p.key, kind: p.kind, role, strength: p.strength,
               score: Number((wPort * ROLE_W[role] * wName).toFixed(3)) });
  }
  out.sort((a, b) => b.score - a.score || a.node.localeCompare(b.node));
  return out;
}

/* ── ④ 机器指纹（细则 §4） ─────────────────────────────────────────── */

function enumOf(oi, node, key) {
  const v = oi?.[node]?.input?.required?.[key]?.[0];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/** 只读指纹。判线只看它。 */
export function fingerprint(objectInfo) {
  const nodes = Object.keys(objectInfo || {});
  const nodeSet = new Set(nodes);
  const cen = census(objectInfo);
  const ports = classifyPorts(cen.sites);
  const has = (n) => nodeSet.has(n);
  return {
    nodeCount: nodes.length,
    nodes,
    has,
    ports,
    enumPortTotal: cen.total,
    loaderPortTotal: ports.length,
    ckptNames: enumOf(objectInfo, "CheckpointLoaderSimple", "ckpt_name"),
    unetNames: enumOf(objectInfo, "UNETLoader", "unet_name"),
    ggufUnetNames: enumOf(objectInfo, "UnetLoaderGGUF", "unet_name"),
    clipNames: enumOf(objectInfo, "CLIPLoader", "clip_name"),
    clipTypes: enumOf(objectInfo, "CLIPLoader", "type"),
    dualTypes: enumOf(objectInfo, "DualCLIPLoader", "type"),
    vaeNames: enumOf(objectInfo, "VAELoader", "vae_name"),
    samplers: enumOf(objectInfo, "KSampler", "sampler_name"),
    schedulers: enumOf(objectInfo, "KSampler", "scheduler"),
    loraNames: enumOf(objectInfo, "LoraLoader", "lora_name"),
    controlNetNames: enumOf(objectInfo, "ControlNetLoader", "control_net_name"),
  };
}

const anyMatch = (list, pattern) => list.some((v) => re(pattern).test(v));
const best = (list, pattern, exclude = null) =>
  list.find((v) => re(pattern).test(v) && !(exclude && re(exclude).test(v))) || null;
/** 按先后顺序试多个模式，返回第一个命中（用于"实测过的那个优先"） */
function pickFirst(list, patterns, exclude = null) {
  for (const pat of [].concat(patterns)) {
    const hit = best(list, pat, exclude);
    if (hit) return { value: hit, pattern: String(pat), rank: [].concat(patterns).indexOf(pat) };
  }
  return null;
}

/* ── ⑤ 判线 R0–R7（设计 §7） ───────────────────────────────────────── */

function plan(base) {
  return {
    state: "blocked", line: null, completeness: "unknown", confidence: "待验证",
    loader: {}, weights: {}, params: {}, candidates: [], missing: [],
    blocker: null, nextAction: null, evidence: [], warnings: [],
  };
}

/** 候选线的公共字段：加载器由 reach() 定，权重名给出，编码节点按线选。 */
function splitLine(fp, { id, label, dit, vae, clip, encNode, params, vaeNote }) {
  const reachDit = reach(dit, fp.ports);
  const loaderNode = reachDit[0]?.node || "UNETLoader";
  const vaePick = pickFirst(fp.vaeNames, vae, /^pixel_space$/);
  const vaeName = vaePick?.value || null;
  const clipName = clip ? best(fp.clipNames, clip) : null;
  const evidence = [
    `reach(${dit}) 首选 ${loaderNode}（score ${reachDit[0]?.score ?? "-"}）`,
    vaeName ? `VAE 命中 ${vaeName}（规则 /${vaePick.pattern}/）` : "没有可用的 VAE",
    clipName ? `文本塔命中 ${clipName}` : "没有可用的文本塔",
  ];
  if (vaeNote && vaePick?.rank > 0) evidence.push(vaeNote);
  return {
    id, label,
    completeness: "complete",
    loader: {
      dit: { node: loaderNode, key: reachDit[0]?.key || "unet_name", alternatives: reachDit.slice(1, 4).map((r) => r.node) },
      clip: { node: fp.has("CLIPLoader") ? "CLIPLoader" : null, key: "clip_name" },
      vae: { node: fp.has("VAELoader") ? "VAELoader" : null, key: "vae_name" },
    },
    weights: { dit, clip: clipName, vae: vaeName },
    encNode,
    params,
    evidence,
  };
}

/**
 * 从上到下判线，命中即停（优先级 = 证据强度，不是偏好）。
 * R7（anima）实测已通，但它是"第三方架构"，优先级仍排在所有 complete 之后。
 */
export function decide(fp) {
  const p = plan();
  const lines = [];
  const push = (l) => { lines.push(l); return l; };

  /* R0 · 前置 */
  if (!fp.nodeCount || !fp.enumPortTotal) {
    p.blocker = "/object_info 不完整（拿不到节点表）";
    p.nextAction = "确认 ComfyUI 在跑、端口对得上，再体检一次。";
    return p;
  }

  /* R1 · Qwen-Image GGUF —— 本机唯一已实跑确认的线 */
  if (anyMatch(fp.ggufUnetNames, /qwen.?image/i) && fp.has("TextEncodeQwenImage21") &&
      fp.clipTypes.includes("qwen_image") && fp.has("VAELoader") && best(fp.vaeNames, /qwen/i, /^pixel_space$/)) {
    const dit = best(fp.ggufUnetNames, /qwen.?image/i);
    push(splitLine(fp, {
      id: "qwen-image-gguf", label: "Qwen-Image-2.1（GGUF 量化）",
      dit, vae: /qwen/i, clip: /qwen3vl/i, encNode: "TextEncodeQwenImage21",
      params: { sampler: "euler", scheduler: "simple", cfg: 1.0, steps: 40, stepsFast: 20, width: 1024, height: 1024 },
    }));
  }

  /* R2 · Qwen-Image 完整 safetensors */
  if (anyMatch(fp.unetNames, /qwen.?image/i) && fp.has("TextEncodeQwenImage21") &&
      fp.clipTypes.includes("qwen_image") && fp.has("VAELoader") && best(fp.vaeNames, /qwen/i, /^pixel_space$/)) {
    const dit = best(fp.unetNames, /qwen.?image/i);
    push(splitLine(fp, {
      id: "qwen-image-full", label: "Qwen-Image-2.1（完整 safetensors）",
      dit, vae: /qwen/i, clip: /qwen3vl/i, encNode: "TextEncodeQwenImage21",
      params: { sampler: "euler", scheduler: "simple", cfg: 1.0, steps: 40, stepsFast: 20, width: 1024, height: 1024 },
    }));
  }

  /* R3 · Flux.2 */
  if (fp.has("Flux2Scheduler") && fp.clipTypes.includes("flux2") && anyMatch(fp.unetNames, /flux.?2/i)) {
    const dit = best(fp.unetNames, /flux.?2/i);
    push(splitLine(fp, {
      id: "flux2", label: "Flux.2",
      dit, vae: /flux|vae/i, clip: /flux|t5|clip/i, encNode: "CLIPTextEncode",
      params: { sampler: "euler", scheduler: "simple", cfg: 1.0, steps: 24, stepsFast: 12, width: 1024, height: 1024 },
    }));
  }

  /* R4 · Flux.1 */
  if (fp.dualTypes.includes("flux") && fp.has("DualCLIPLoader") && fp.has("UNETLoader") && anyMatch(fp.unetNames, /flux/i)) {
    const dit = best(fp.unetNames, /flux/i);
    push(splitLine(fp, {
      id: "flux1", label: "Flux.1",
      dit, vae: /flux|vae/i, clip: /flux|t5|clip/i, encNode: "CLIPTextEncodeFlux",
      params: { sampler: "euler", scheduler: "simple", cfg: 1.0, steps: 24, stepsFast: 12, width: 1024, height: 1024 },
    }));
  }

  /* R7 · anima —— 实测已通，第三方架构，排在 complete 之后但仍可自动出图 */
  if (fp.has("AnimaLLLiteApply") || anyMatch(fp.unetNames, /anima/i)) {
    const dit = best(fp.unetNames, /anima/i);
    if (dit) {
      push(splitLine(fp, {
        id: "anima", label: "Anima Base（第三方架构，LLM 文本塔）",
        dit, vae: [/^qwen_image_vae\.safetensors$/i, /qwen/i], clip: /anima/i, encNode: "CLIPTextEncode",
        vaeNote: "实测跑通用的就是 qwen_image_vae.safetensors，所以这个优先于 /qwen/ 的通用匹配",
        params: { sampler: "euler", scheduler: "simple", cfg: 1.0, steps: 30, stepsFast: 8, width: 1024, height: 1024 },
      }));
      const a = lines[lines.length - 1];
      // 实测：文本塔的 clip_type 取值不影响加载（te_model 由 detect_te_model 从权重自己探出）
      a.loader.clip.type = "stable_diffusion";
      a.loader.clip.typeNote = "任取即可（实测 qwen_image / flux2 / stable_diffusion 三值全通）；默认取最省时的 stable_diffusion";
      a.completeness = "complete";
      a.confidence = "已验证";
      a.evidence.push("实测 2026-10-09：整套最小图 6.1s 通过（256²、4 步），VAE 可共用 qwen_image_vae");
    }
  }

  /* R5 · SDXL（经典 ckpt 一体式） */
  if (fp.has("CheckpointLoaderSimple") && anyMatch(fp.ckptNames, /(xl|sdxl)/i)) {
    const ck = best(fp.ckptNames, /(xl|sdxl)/i);
    push({
      id: "sdxl", label: "SDXL（经典 ckpt 一体式）", completeness: "complete", confidence: "可成立",
      loader: { dit: { node: "CheckpointLoaderSimple", key: "ckpt_name" }, clip: { node: "CheckpointLoaderSimple" }, vae: { node: "CheckpointLoaderSimple" } },
      weights: { dit: ck, clip: "(ckpt 自带)", vae: "(ckpt 自带)" },
      encNode: fp.has("CLIPTextEncodeSDXL") ? "CLIPTextEncodeSDXL" : "CLIPTextEncode",
      params: { sampler: "dpmpp_2m", scheduler: "karras", cfg: 7.0, steps: 28, stepsFast: 16, width: 1024, height: 1024 },
      evidence: [`ckpt_names 命中 ${ck}`],
    });
  }

  /* R6 · SD1.5（经典 ckpt，兜底里的兜底） */
  if (fp.has("CheckpointLoaderSimple") && fp.ckptNames.length) {
    const ck = fp.ckptNames[0];
    push({
      id: "sd15", label: "SD1.5（经典 ckpt 一体式）", completeness: "complete", confidence: "可成立",
      loader: { dit: { node: "CheckpointLoaderSimple", key: "ckpt_name" }, clip: { node: "CheckpointLoaderSimple" }, vae: { node: "CheckpointLoaderSimple" } },
      weights: { dit: ck, clip: "(ckpt 自带)", vae: "(ckpt 自带)" },
      encNode: "CLIPTextEncode",
      params: { sampler: "euler", scheduler: "normal", cfg: 7.0, steps: 24, stepsFast: 16, width: 512, height: 512 },
      evidence: [`ckpt_names 非空，取 ${ck}`],
    });
  }

  p.candidates = lines;

  /* B4 · 一个权重都没有 → 拒答，不空跑 */
  if (!lines.length) {
    const noWeights = !fp.ckptNames.length && !fp.ggufUnetNames.length && !fp.unetNames.length;
    if (noWeights) {
      p.blocker = "这台机器上没有可用的图像模型（checkpoints / diffusion_models / unet 都是空的）";
      p.nextAction = "放一套模型进 models/checkpoints/，或者 diffusion_models/ + text_encoders/ + vae/，重启 ComfyUI 再体检。";
    } else {
      p.blocker = "有权重，但没有任何一条已知架构线成立";
      p.nextAction = "把这批权重名发出来，我们按 ComfyUI 的判据补一条线；也可以直接导一份你自己的 API 工作流。";
      if (fp.ckptNames.length) p.warnings.push("B3 可选：退到「最小通用图」（CheckpointLoaderSimple → CLIPTextEncode → KSampler → VAEDecode），保守参数 euler/normal、cfg 7.0、512²。");
    }
    p.warnings.push(...reachReport(fp).slice(0, 8));
    return p;
  }

  /* 选中优先级最高的一条；其余记为备选线 */
  const chosen = lines[0];
  p.state = lines.length > 1 ? "ok" : "ok";
  p.line = chosen.id;
  p.label = chosen.label;
  p.completeness = chosen.completeness;
  p.confidence = chosen.confidence;
  p.loader = chosen.loader;
  p.weights = chosen.weights;
  p.encNode = chosen.encNode;
  p.params = chosen.params;
  p.evidence = chosen.evidence;
  if (lines.length > 1) p.warnings.push(`另有 ${lines.length - 1} 条备选线：${lines.slice(1).map((l) => l.id).join(" / ")}`);
  return p;
}

/** 给诊断报告用：把家底里的权重逐个列出可达的首选加载器 */
export function reachReport(fp) {
  const all = [...new Set([...fp.ckptNames, ...fp.unetNames, ...fp.ggufUnetNames, ...fp.clipNames, ...fp.vaeNames])];
  return all.map((f) => {
    const r = reach(f, fp.ports);
    return `${f} → ${r.length ? `${r[0].node}.${r[0].key}（score ${r[0].score}，共 ${r.length} 路）` : "没有可达的加载口"}`;
  });
}

/** 一步到位：喂 object_info，拿报告。 */
export function inspect(objectInfo) {
  const fp = fingerprint(objectInfo);
  const p = decide(fp);
  return { fingerprint: fp, plan: p };
}
