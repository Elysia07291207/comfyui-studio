/**
 * comfyui-studio/index.js — v2 App 入口。
 *
 * 分工：
 *   ┌─ AppHost（宿主进程），本应用只做三件事 ────────────────┐
 *   │  · ctx.tools.register()  四个工具                       │
 *   │  · ctx.network.fetch     直连本机 ComfyUI（manifest 已声明 │
 *   │                          allowLocalhost + allowedHosts） │
 *   │  · 把出好的图取回、写进自己的数据目录                    │
 *   └───────────────────────────────────────────────────────┘
 *
 * 与图库那类 App 不同，这里**不需要**受管运行时：不读用户的任意目录，
 * 只跟 127.0.0.1:8188 说话，图也是走 HTTP /view 取回来的。
 *
 * 出图拆成两段（一张要 3~6.5 分钟，一次调用等不完）：
 *   comfy_draw(prompt)   → 提交，立刻返回 job id
 *   comfy_result(job)    → 回查；完成就把图拉回本地并给出路径
 */

import { buildGraph, DEFAULT_NEGATIVE, DEFAULTS, WEIGHTS } from "./lib/graph.mjs";
import { bindNetwork, health, submit, history, fetchImage, queue, nodeNames, nodeSpec } from "./lib/comfy.mjs";
import { bindDataDir, loadJobs, newJob, updateJob, findJob, writeImage, imageSize } from "./lib/jobs.mjs";
// 自定义配方单独一份数据（custom_recipes.json），用同一个数据目录，但模块分开：
// 内置表是常量、自定义是数据，不能混在一起（见 lib/custom.mjs 文件头）。
import { bindDataDir as bindCustomDataDir } from "./lib/custom.mjs";
// 过审记录（review.json）也是数据，单独一份
import { bindDataDir as bindReviewDataDir } from "./lib/review.mjs";
import { registerRoutes } from "./lib/routes.mjs";

export const name = "comfyui-studio";

/** v2 工具的返回值约定：{ content: [...] }；失败时带 isError，让模型知道这不是正常结果。 */
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const bad = (message) => ({
  content: [{ type: "text", text: `错误：${String(message)}` }],
  isError: true,
});

function safeFilename(name, promptId) {
  const base = String(name || "").split(/[\\/]/).pop() || "image.png";
  return `${promptId.slice(0, 8)}_${base}`.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, "_");
}

export async function apply(ctx) {
  const log = ctx?.logger ?? console;
  const dataDir = ctx?.dataDir || "";

  bindDataDir(dataDir);
  bindCustomDataDir(dataDir);
  bindReviewDataDir(dataDir);
  const { hasFetch } = bindNetwork(ctx);
  if (ctx?.config?.get) {
    // 设置里没暴露端口，先留默认；以后要改就加一项 settings。
  }

  log.info?.("comfyui-studio loaded", { dataDir, hasFetch });

  const tools = [
    {
      name: "comfy_health",
      description:
        "检查本机 ComfyUI（127.0.0.1:8188）是否在线，顺带报版本、显卡与显存空闲。" +
        "出图前先调一次：不在线就别提交，先让用户把 ComfyUI 起起来（python main.py --lowvram）。",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        if (!hasFetch) return bad("宿主未提供网络出口，无法访问本机 ComfyUI");
        try {
          const [h, q] = await Promise.all([health(), queue().catch(() => null)]);
          return ok({ ...h, queue: q, endpoint: "http://127.0.0.1:8188" });
        } catch (e) {
          return bad(`连不上 ComfyUI：${e?.message || e}。先确认它已启动（--lowvram）。`);
        }
      },
    },

    {
      name: "comfy_draw",
      description:
        "把提示词提交给本机 ComfyUI 出图（工作流固定在应用内：Qwen-Image-2.1）。" +
        "**提交即返回，不等图**——一张要 3~6.5 分钟。拿到 job 之后过几分钟用 comfy_result 取结果。" +
        "参数全都可省：默认 1024x1024、40 步、cfg 1.0；探路可用 steps=20（约 3 分钟），定稿用 40（约 6.5 分钟）。" +
        "想一次出多张就多调几次、给不同 seed。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "正向提示词（必填）" },
          negative: { type: "string", description: "负向提示词；不给就用内置那串反像素风/反 AI 味词" },
          width: { type: "number", description: "宽，默认 1024（8 的倍数，256-2048）" },
          height: { type: "number", description: "高，默认 1024" },
          steps: { type: "number", description: "步数：20 探路，40 定稿；默认 40" },
          cfg: { type: "number", description: "引导强度，这套模型用 1.0" },
          seed: { type: "number", description: "随机种子；不传则每次不同" },
          prefix: { type: "string", description: "ComfyUI output 下的文件名前缀，默认 hana/comfy" },
        },
        required: ["prompt"],
      },
      async execute(input = {}) {
        if (!hasFetch) return bad("宿主未提供网络出口，无法访问本机 ComfyUI");
        let built;
        try {
          // 工具参数叫 prompt，而 buildGraph 读的是 positive —— 不改名就得显式接一下，
          // 否则 positive 为空会直接抛「提示词是空的」。
          built = buildGraph({ ...input, positive: input.prompt });
        } catch (e) {
          return bad(e?.message || e);
        }
        try {
          const promptId = await submit(built.graph);
          const job = newJob({
            promptId,
            prompt: input.prompt,
            params: { width: built.width, height: built.height, steps: built.steps, cfg: built.cfg, seed: built.seed },
          });
          return ok({
            job: promptId,
            seed: built.seed,
            size: `${built.width}x${built.height}`,
            steps: built.steps,
            hint: `已入队。约 ${built.steps <= 20 ? "3" : "6"} 分钟后用 comfy_result({ job: "${promptId}" }) 取结果。`,
          });
        } catch (e) {
          return bad(e?.message || e);
        }
      },
    },

    {
      name: "comfy_result",
      description:
        "查一个出图任务的结果。完成时会把图片从 ComfyUI 取回应用数据目录，返回本地绝对路径（可直接交付/预览）。" +
        "没完成就返回 running，隔一会儿再问。失败会带出 ComfyUI 的原始报错。",
      parameters: {
        type: "object",
        properties: {
          job: { type: "string", description: "comfy_draw 返回的 job id（即 prompt_id）" },
        },
        required: ["job"],
      },
      async execute(input = {}) {
        const jobId = String(input.job || "").trim();
        if (!jobId) return bad("缺 job id");
        if (!hasFetch) return bad("宿主未提供网络出口，无法访问本机 ComfyUI");

        let entry;
        try {
          entry = await history(jobId);
        } catch (e) {
          return bad(e?.message || e);
        }

        if (!entry) return ok({ job: jobId, status: "running", note: "还在跑，或者刚提交还没进历史。" });

        if (entry.status !== "success") {
          if (entry.done) {
            updateJob(jobId, { status: "failed", completedAt: new Date().toISOString(), error: entry.errorMessage });
            return ok({ job: jobId, status: "failed", error: entry.errorMessage || "ComfyUI 未给出原因" });
          }
          return ok({ job: jobId, status: entry.status });
        }

        const known = findJob(jobId);
        if (known?.files?.length) {
          return ok({ job: jobId, status: "success", files: known.files, cached: true });
        }

        const files = [];
        for (const img of entry.images) {
          try {
            const bytes = await fetchImage(img);
            const localPath = writeImage(safeFilename(img.filename, jobId), bytes);
            files.push({ name: img.filename, path: localPath, bytes: bytes.length });
          } catch (e) {
            files.push({ name: img.filename, path: null, error: String(e?.message || e) });
          }
        }

        updateJob(jobId, { status: "success", completedAt: new Date().toISOString(), images: entry.images, files, actual: files.length && files[0].path ? imageSize(files[0].path) : null });
        return ok({ job: jobId, status: "success", files });
      },
    },

    {
      name: "comfy_jobs",
      description:
        "翻账本。不传参数：列出最近提交的任务（提示词、状态、产出文件路径、参数、是否还存着原图）。" +
        "传 id：只要那一条的完整记录 —— 包括当初提交的节点图 graph（自定义管线的图已经丢过一张，所以现在都存）。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "返回几条，默认 10；传了 id 就忽略它" },
          id: { type: "string", description: "要查的那条 job id（即 prompt_id），传了就只回这一条" },
        },
        required: [],
      },
      async execute(input = {}) {
        const id = String(input.id || "").trim();
        if (id) {
          const job = findJob(id);
          if (!job) return bad(`账本里没有这条记录：${id}`);
          return ok(job);
        }
        const limit = Math.min(50, Math.max(1, Number(input.limit) || 10));
        return ok({ jobs: loadJobs().slice(0, limit) });
      },
    },

    {
      name: "comfy_nodes",
      description:
        "查本机 ComfyUI 有哪些节点、或某个节点的参数规格。" +
        "不传参数：只回节点总数和前若干类别（全表 3MB，不能直接吐）。" +
        "keyword：按关键词模糊找节点（如 Upscale / ControlNet / Lora）。" +
        "name：给出该节点的输入规格（类型、默认值、可选模型列表），照着它就能自己组一条管线。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "按关键词找节点名（不区分大小写）" },
          name: { type: "string", description: "要看规格的节点名（精确）" },
          limit: { type: "number", description: "keyword 最多回几个，默认 20" },
        },
        required: [],
      },
      async execute(input = {}) {
        try {
          if (input.name) {
            const spec = await nodeSpec(String(input.name));
            if (!spec) return bad(`没有这个节点：${input.name}`);
            return ok(spec);
          }
          const all = await nodeNames();
          const kw = String(input.keyword || "").trim().toLowerCase();
          if (!kw) {
            const cats = {};
            return ok({ total: all.length, hint: "给 keyword 或 name 再看细节", sample: all.slice(0, 40), categories: cats });
          }
          const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
          const hit = all.filter((n) => n.toLowerCase().includes(kw)).slice(0, limit);
          return ok({ keyword: kw, matched: hit.length, nodes: hit });
        } catch (e) {
          return bad(e?.message || e);
        }
      },
    },

    {
      name: "comfy_run",
      description:
        "直接跑一份自己组装的节点图（API 格式：{ \"1\": { class_type, inputs }, ... }）。" +
        "这是「自己安排管线」的入口：先用 comfy_nodes 查清节点参数，再组图——加超分、加精修、串联多个采样器都行。" +
        "提交即返回 job id，用法与 comfy_draw 一致，同样进账本、卡片看得到进度。" +
        "先用 comfy_nodes 把每个节点的输入弄清楚；图不合法时 ComfyUI 会把原因写在报错里。",
      parameters: {
        type: "object",
        properties: {
          graph: { type: "object", description: "完整的 API 格式节点图（必填）" },
          label: { type: "string", description: "给这张图起个名字，只用于账本与卡片显示" },
          steps: { type: "number", description: "总步数，只用于进度估算；不传按 20 算" },
        },
        required: ["graph"],
      },
      async execute(input = {}) {
        if (!hasFetch) return bad("宿主未提供网络出口，无法访问本机 ComfyUI");
        const graph = input.graph;
        if (!graph || typeof graph !== "object" || Array.isArray(graph)) return bad("graph 必须是一个对象");
        if (Object.keys(graph).length === 0) return bad("graph 是空的");
        try {
          const promptId = await submit(graph);
          newJob({
            promptId,
            prompt: String(input.label || "(自定义管线)"),
            params: { steps: Number(input.steps) || 20, custom: true },
          });
          return ok({ job: promptId, label: input.label || null, nodes: Object.keys(graph).length });
        } catch (e) {
          return bad(e?.message || e);
        }
      },
    },
  ];

  const disposers = [];

  for (const tool of tools) {
    try {
      ctx.tools.register(tool);
    } catch (e) {
      log.error?.(`工具注册失败: ${tool.name}`, { error: e?.message || String(e) });
    }
  }

  // 卡片要看的进度路由。注册失败不该拖垮整个应用。
  try {
    const offRoutes = await registerRoutes(ctx);
    if (typeof offRoutes === "function") disposers.push(offRoutes);
  } catch (e) {
    log.error?.("路由注册失败", { error: e?.message || String(e) });
  }

  return () => {
    for (const off of disposers) {
      try {
        off();
      } catch {
        /* teardown */
      }
    }
  };
}

export const __internals = { buildGraph, DEFAULT_NEGATIVE, DEFAULTS, WEIGHTS };
