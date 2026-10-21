/**
 * lib/routes.mjs — 卡片要调的后端路由（进度可视化用）。
 *
 * 公开 URL 前缀：/api/apps/comfyui-studio/routes
 *
 * 放在 lib/ 而不是顶级 routes/：v2 把顶级 routes/ 当成另一种路由来源，
 * 与 ctx.routes.register() 互斥 —— 两边同时存在会让整个应用装载失败。
 *
 * 进度怎么算：ComfyUI 只在 WebSocket 上推步数，Host 侧的 fetch 够不着；
 * 所以用「提交时刻 + 步数 × 单步耗时」估一个百分比。
 *
 * running 以**账本**为准，不看 ComfyUI 的 /queue —— 实测：任务刚提交时
 * /queue 里会短暂看不到它（正在加载模型那一段），照 /queue 判会把进度条判丢。
 *
 * 但「哪一条在跑」得问 /queue 的 queue_running：同时投两张时，只看账本会指错人，
 * 取消就会掐错。所以：有没有在跑问账本，在跑的是哪一条问队列。
 */

import { health, queue, history, fetchImage, submit, objectInfo, nodeNames, nodeSpec, interrupt, freeMemory, deleteQueued } from "./comfy.mjs";
import { loadJobs, updateJob, writeImage, newJob, findJob, imageSize, styleDir } from "./jobs.mjs";
import { buildGraph, buildGraphForPlan, DEFAULT_LINE } from "./graph.mjs";
import { inspect as adaptInspect, reachReport } from "./adapt.mjs";
import { stylesForUi, batches as styleBatches, resolveStyle, taxonomy, NEG_WORDS } from "./styles.mjs";
import { listCustom, addCustom, updateCustom, removeCustom, customForUi, resolveAny, isCustom, markSample, randomSamplePrompt, SAMPLE_PROMPTS, SAMPLE_PROMPT_DEFAULT } from "./custom.mjs";
import { reviewForUi, setVerdict, VERDICT_LABEL, sampleBaseTextFor } from "./review.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 单步耗时估算（秒）。实测：1024×1024 / 20 步 ≈ 69 秒（~3.4 s/步）；
 *  768×832 / 20 步 ≈ 48 秒。取 4.0 比实测略保守，含一次模型加载的余地。
 *  ⚠️ 面积线性折算只在 1024² 附近成得准：1536² 以上是**超线性**的
 *  （精修那张 3072² 实测 39 s/步），那一带不归这个公式管。 */
const SEC_PER_STEP = 4.0;

/** 最短预计时长（秒），免得一两步的任务进度条瞬间跑满、看不出东西。 */
const MIN_EXPECTED_SEC = 30;

/** 未完成时进度条最多走到这里，剩下那截留给「完成」本身。 */
const CAP_WHILE_RUNNING = 96;

/** 超出预计时长这么多倍（再加 90 秒余量）才去对账，避免误判还在跑的任务。 */
const OVERDUE_FACTOR = 2.5;

function expectedSeconds(job) {
  const steps = Number(job?.params?.steps) || 20;
  // 尺寸进来了就算面积 —— 竖图比方形慢一半，统一按方形估是对竖图撒谎。
  const w = Number(job?.params?.width);
  const h = Number(job?.params?.height);
  const mp = (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) ? (w * h) / (1024 * 1024) : 1;
  return Math.max(MIN_EXPECTED_SEC, Math.round(steps * SEC_PER_STEP * mp));
}

function safeFilename(name, jobId) {
  const base = String(name || "").split(/[\\/]/).pop() || "image.png";
  return `${String(jobId).slice(0, 8)}_${base}`.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, "_");
}

/** 只把真数字当数字。null / "" / undefined 一律返回 null —— 不猜。 */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * 从自己组装的节点图里抽 尺寸 / 步数 / seed / 采样段数。
 * 抽不到就留 null（归丹青的约定：不猜）。
 * 多段精修图取节点号最小的那个 KSampler —— 基底那一段排在最前。
 */
function extractParams(graph) {
  const out = { width: null, height: null, steps: null, seed: null, stages: 0 };
  if (!graph || typeof graph !== "object") return out;
  const ids = Object.keys(graph).sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  for (const id of ids) {
    const node = graph[id];
    const t = String(node?.class_type || "");
    const inp = node?.inputs || {};
    if (/^Empty\w*Latent/.test(t)) {
      if (out.width === null) out.width = num(inp.width);
      if (out.height === null) out.height = num(inp.height);
    }
    if (/^KSampler/.test(t)) {
      out.stages += 1;
      if (out.steps === null) out.steps = num(inp.steps);
      if (out.seed === null) out.seed = num(inp.seed) ?? num(inp.noise_seed);
    }
  }
  return out;
}

function view(job, now) {
  const expected = expectedSeconds(job);
  const startedAt = job.submittedAt ? Date.parse(job.submittedAt) : now;
  // 已完成的用「完成时刻 - 提交时刻」，别拿「到现在」充数。
  const endedAt = job.completedAt ? Date.parse(job.completedAt) : now;
  const elapsed = Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, Math.round((endedAt - startedAt) / 1000))
    : 0;
  const done = job.status === "success";
  const percent = done
    ? 100
    : Math.min(CAP_WHILE_RUNNING, Math.round((elapsed / expected) * 100));

  // 自定义图（comfy_run 提交的）账本里只有 {steps, custom:true}，没有尺寸。
  // 不能把 undefined 拼进字符串 —— 卡片上会真的显示 "undefinedxundefined"。
  const p = job?.params || {};
  const hasSize = Number.isFinite(p.width) && Number.isFinite(p.height);

  return {
    job: job.id,
    prompt: job.prompt,
    steps: p.steps ?? null,
    size: hasSize ? `${p.width}x${p.height}` : null,
    // 配方条要回显「这张用了什么」：尺寸/步数/seed/配方名/负向版本。
    // 数字型字段单独给，别让界面去 parse 那个 "1024x1024" 字符串。
    width: hasSize ? p.width : null,
    height: hasSize ? p.height : null,
    seed: p.seed ?? null,
    recipe: p.recipe ?? null,
    style: p.style ?? null,
    negative: p.negative ?? null,
    stages: p.stages ?? null,
    // 原图还在不在账本里 —— 卡片靠它决定「照原样再跑」是重投还是重建
    hasGraph: Boolean(job.graph && typeof job.graph === "object" && Object.keys(job.graph).length),
    // 实出尺寸：落图后读 PNG 头得到的真实像素，跟提交尺寸是两回事，分开给
    actualWidth: job.actual?.width ?? null,
    actualHeight: job.actual?.height ?? null,
    actualSize: job.actual ? `${job.actual.width}x${job.actual.height}` : null,
    status: job.status,
    elapsedSec: elapsed,
    expectedSec: expected,
    percent,
    files: (job.files || []).map((f) => ({ name: f.name, path: f.path, bytes: f.bytes })),
    error: job.error || null,
    submittedAt: job.submittedAt || null,
    completedAt: job.completedAt || null,
  };
}

/**
 * 还在跑、但可能已经结束的任务，去 ComfyUI 问一次真实状态并落账。
 *
 * 两种情况会触发：
 *   a) 队列已经空了（且这个任务已经提交超过 30 秒）—— 说明它跑完了；
 *   b) 耗时远远超过预计（2.5 倍 + 90 秒）—— 锘死了也得有个交代。
 * 刚开始的头 30 秒不动：那时候队列可能暂时看不到它（正在加载模型）。
 */
async function reconcile(jobs, now, queueEmpty) {
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const started = job.submittedAt ? Date.parse(job.submittedAt) : now;
    const ageSec = Number.isFinite(started) ? (now - started) / 1000 : 0;
    if (ageSec < 30) continue;

    const overdue = ageSec > expectedSeconds(job) * OVERDUE_FACTOR + 90;
    if (!overdue && !queueEmpty) continue;

    try {
      const h = await history(job.id);
      if (!h) continue;
      if (h.status === "success") {
        const files = [];
        for (const img of h.images || []) {
          try {
            const bytes = await fetchImage(img);
            files.push({ name: img.filename, path: writeImage(safeFilename(img.filename, job.id), bytes), bytes: bytes.length });
          } catch { /* 单张取失败不影响状态落账 */ }
        }
        // 顺手把真实像素记下来：图片自己带着答案，不用去问生成它的人
        const actual = files.length ? imageSize(files[0].path) : null;
        updateJob(job.id, { status: "success", completedAt: new Date().toISOString(), images: h.images || [], files, actual: actual || null });
      } else if (h.done) {
        updateJob(job.id, { status: "failed", completedAt: new Date().toISOString(), error: h.errorMessage || "ComfyUI 未给出原因" });
      }
    } catch { /* 对账失败不能反过来影响出图 */ }
  }
}

export async function registerRoutes(ctx) {
  const dispose = await ctx.routes.register((app) => {
    app.get("/status", async (c) => {
      const now = Date.now();
      const out = { ok: true, at: new Date(now).toISOString() };

      let q = null;
      try {
        const [h, qq] = await Promise.all([health(), queue()]);
        q = qq;
        out.service = {
          online: true,
          version: h.version,
          device: h.device,
          vramFreeGb: h.vramFreeGb,
          vramTotalGb: h.vramTotalGb,
          running: q.running,
          pending: q.pending,
        };
      } catch (e) {
        out.ok = false;
        out.service = { online: false };
        out.error = String(e?.message || e);
      }

      let jobs = loadJobs();
      if (out.service.online) {
        const queueEmpty = (out.service.running || 0) === 0 && (out.service.pending || 0) === 0;
        await reconcile(jobs, now, queueEmpty);
        jobs = loadJobs();
      }

      // 谁是真在跑的那一条：以 ComfyUI 的 queue_running 认人。
      // 光看「账本里最新的 running」同时投两张时会指错，取消就会掐错人。
      const live = jobs.filter((j) => j.status === "running");
      const runningIds = q?.runningIds || [];
      let runningJob = null;
      for (const id of runningIds) {
        const hit = live.find((j) => j.id === id);
        if (hit) { runningJob = hit; break; }
      }
      // 队列暂时看不见（刚提交、还在加载模型）就退回最老的那条 —— 它最可能正在跑
      if (!runningJob && live.length) runningJob = live[live.length - 1];

      out.running = runningJob ? view(runningJob, now) : null;
      out.pending = live.filter((j) => j.id !== runningJob?.id).map((j) => view(j, now));
      // 已取消的不进成品架：它没有图可看，占一格只会像个坏掉的方块。
      // 它的去处是 comfy_jobs，账本里留着。
      out.recent = jobs
        .filter((j) => j.status === "success" || j.status === "failed")
        .slice(0, 8)
        .map((j) => view(j, now));
      out.total = jobs.length;

      return c.json(out);
    });

    // 体检：这台机器装了什么、我能给它跑哪条线、卡在哪。只读、不出图、不花钱。
    // 卡片首屏和诊断报告都读这一份——人和 agent 共用一份真值，免得两套口径对不上。
    app.get("/env", async (c) => {
      try {
        const oi = await objectInfo();
        const { fingerprint: fp, plan } = adaptInspect(oi);
        const lines = (plan.candidates || []).map((l) => ({
          id: l.id,
          label: l.label,
          completeness: l.completeness,
          confidence: l.confidence,
          encNode: l.encNode,
          dit: l.loader?.dit?.node || null,
          ditName: l.weights?.dit || null,
          clipName: l.weights?.clip || null,
          vaeName: l.weights?.vae || null,
          params: l.params || null,
          evidence: l.evidence || [],
        }));
        const empties = [];
        if (!fp.ckptNames.length) empties.push("checkpoints");
        if (!fp.unetNames.length && !fp.ggufUnetNames.length) empties.push("diffusion_models / unet");
        if (!fp.clipNames.length) empties.push("text_encoders");
        if (!fp.vaeNames.filter((v) => v !== "pixel_space").length) empties.push("vae");
        return c.json({
          ok: true,
          at: new Date().toISOString(),
          chosen: plan.line,
          chosenLabel: plan.label || null,
          state: plan.state,
          blocker: plan.blocker,
          nextAction: plan.nextAction,
          warnings: plan.warnings || [],
          lines,
          machine: {
            nodeCount: fp.nodeCount,
            enumPorts: fp.enumPortTotal,
            loaderPorts: fp.loaderPortTotal,
            counts: {
              checkpoints: fp.ckptNames.length,
              unet: fp.unetNames.length,
              gguf: fp.ggufUnetNames.length,
              textEncoders: fp.clipNames.length,
              vae: fp.vaeNames.filter((v) => v !== "pixel_space").length,
              loras: fp.loraNames.length,
              controlnet: fp.controlNetNames.length,
            },
            emptyDirs: empties,
          },
          reach: reachReport(fp).slice(0, 24),
        });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 502);
      }
    });

    // 样图的两处来源（顺序 = 优先级）：
    //   ① app-data/styles —— 用户自己跑/覆盖的那张，永远优先
    //   ② 包里自带的 assets/styles —— **发给别人时靠它**，
    //      不带的话别人装完看到的是一面没有图的图墙，而配方库的全部价值就是那面墙
    const SAMPLE_KINDS = /\.(png|webp|jpe?g)$/i;
    function sampleDirs() {
      return [styleDir(), fileURLToPath(new URL("../assets/styles/", import.meta.url))];
    }
    /** id → 文件名列表，两处合并；同名以 app-data 那份为准（先去先赢）。 */
    function listSamples() {
      const out = {};
      const seen = new Set();
      for (const dir of sampleDirs()) {
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          if (!SAMPLE_KINDS.test(f) || seen.has(f)) continue;
          seen.add(f);
          const id = f.split(".")[0];
          if (!out[id]) out[id] = [];
          out[id].push(f);
        }
      }
      for (const k of Object.keys(out)) out[k].sort();
      return out;
    }
    /** 第 i 张去哪儿读：先在 app-data 找，找不到再读包里自带的那份。 */
    function sampleFile(id, i) {
      const list = (listSamples()[id] || []);
      const name = list[i];
      if (!name) return null;
      for (const dir of sampleDirs()) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
      }
      return null;
    }

    // 风格配方表 + 已有样图清单。界面只拿 id 与状态；
    // id → 正/负向串的解算在管线侧一处（lib/styles.mjs），界面不另存一份。
    app.get("/styles", async (c) => {
      const dir = styleDir();
      // 两处来源合并（app-data 优先，包里自带那份兜底）—— 见 listSamples 上面的说明
      const samples = listSamples();
      // 连分类树一起给：界面靠它搭「大类 / 子类 / 筛选」三层，不用自己再算一遍
      // negWords：默认负向串的 21 个词。界面对比视图要把「这条配方删掉了哪几个词」
      // 原样摊出来（删词加删除线），没有词表就只能显示一个数字。只发词表，不发解算结果。
      // sampleBaseText：这张样图**实际用的那句话**，直接给字。
      // 过审时要判的就是「这句底句 + 这条骨架」出来的图，不写清楚无法下判。
      // 给字不给类别：界面手里再拼一次螺辞，就是给分叉留门（这轮已经吃过一次）。
      const withBase = (rows) => rows.map((s) => ({ ...s, sampleBaseText: sampleBaseTextFor(s) }));
      return c.json({
        ok: true,
        styles: withBase(stylesForUi()),
        custom: withBase(customForUi()),
        reviews: reviewForUi(),
        samplePrompt: SAMPLE_PROMPT_DEFAULT,
        samplePrompts: SAMPLE_PROMPTS,
        batches: styleBatches(),
        taxonomy: taxonomy(),
        samples,
        negWords: NEG_WORDS,
        dir,
      });
    });

    // 风格样图。没有就 404 —— 界面据此显示「待出样图」占位，不装。
    app.get("/style-image", async (c) => {
      const id = String(c.req.query("id") || "").replace(/[^A-Za-z0-9_-]/g, "");
      const i = Number.parseInt(c.req.query("i") || "0", 10) || 0;
      if (!id) return c.json({ ok: false, error: "缺 id" }, 400);
      const src = sampleFile(id, i);
      if (!src) return c.json({ ok: false, error: "这个风格还没有样图" }, 404);
      try {
        const buf = fs.readFileSync(src);
        const ext = path.extname(src).toLowerCase();
        const mime = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        return c.body(buf, 200, { "Content-Type": mime, "Cache-Control": "no-store" });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 404);
      }
    });

    // ── 自定义配方（用户自己加的）────────────────────────────────────
    // 四条路由，全部只读写 custom_recipes.json，**一个字节都不碰 styles.mjs**。
    // 「内置表是唯一权威」这条不变量就靠这个边界守着：自定义只能新增。

    app.post("/custom", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const row = addCustom({ name: body?.name, posSuffix: body?.posSuffix, samplePrompt: body?.samplePrompt });
        return c.json({ ok: true, item: customForUi().find((s) => s.id === row.id) });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 400);
      }
    });

    app.post("/custom/update", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const row = updateCustom(String(body?.id || ""), { name: body?.name, posSuffix: body?.posSuffix, samplePrompt: body?.samplePrompt });
        return c.json({ ok: true, item: customForUi().find((s) => s.id === row.id) });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 400);
      }
    });

    app.post("/custom/delete", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id || "");
      if (!isCustom(id)) return c.json({ ok: false, error: "没有这条自定义配方" }, 404);
      removeCustom(id);
      // 样图跟着走：配方删了还把样图留在目录里，下次生成同一个 id 会“继承”别人的图。
      const gone = [];
      try {
        for (const f of fs.readdirSync(styleDir())) {
          if (f.startsWith(id + ".") && /\.(png|webp|jpe?g)$/i.test(f)) {
            fs.unlinkSync(path.join(styleDir(), f));
            gone.push(f);
          }
        }
      } catch { /* 没样图很常见 */ }
      return c.json({ ok: true, id, samplesRemoved: gone });
    });

    // 给一条自定义配方跑一张样图："基准句 + 这条骨架"，账本里打上 sampleFor。
    // 提交与落图分两步：一张图 30~45 秒，不能让一个请求干等。
    app.post("/custom/sample", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id || "");
      if (!isCustom(id)) return c.json({ ok: false, error: "没有这条自定义配方" }, 404);
      // 底句：用户锁了就用它；没锁（或根本没说）就**现场随机挑一句** ——
      // 固定一句的话，每条配方的样图都是同一个主体，你看不出骨架做了什么。
      // body.prompt 为空字符串与不传都算“没锁”。
      const wanted = String(body?.prompt || "").trim();
      const item = listCustom().find((s) => s.id === id);
      const pinned = wanted || (item?.samplePrompt || "").trim();
      const prompt = (pinned || randomSamplePrompt(item?.samplePromptUsed || "")).slice(0, 400);
      let resolved, built;
      try {
        resolved = resolveAny(id, prompt);
        built = buildGraph({
          positive: resolved.positive,
          negative: resolved.negative,
          width: 512, height: 512, steps: 20, cfg: 1.0,
        });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 400);
      }
      try {
        const promptId = await submit(built.graph);
        newJob({
          promptId,
          prompt,
          params: {
            width: built.width, height: built.height, steps: built.steps,
            cfg: built.cfg, seed: built.seed,
            recipe: null, style: id, negative: null, stages: 1,
            // 认人用：commit 那一步靠它确认「这个 job 确实是那条配方的样图」
            sampleFor: id,
          },
          graph: built.graph,
        });
        return c.json({ ok: true, job: promptId, id, prompt, size: `${built.width}x${built.height}`, steps: built.steps });
      } catch (e) {
        return c.json({ ok: false, error: `连不上 ComfyUI（127.0.0.1:8188）：${String(e?.message || e)}` }, 502);
      }
    });

    // 落图：把跑完那张抄成 styles/<id>.0.png —— 与内置样图同一套命名规则，
    // /style-image 不用改就能直接吐它。图已经由对账落过盘，这里只拷，不重取。
    app.post("/custom/sample/commit", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id || "");
      const jobId = String(body?.job || "");
      if (!isCustom(id)) return c.json({ ok: false, error: "这条自定义配方不在了" }, 404);
      const job = findJob(jobId);
      if (!job) return c.json({ ok: false, error: "账本里没有这个 job" }, 404);
      if (job.params?.sampleFor !== id) return c.json({ ok: false, error: "这个 job 不是那条配方的样图" }, 400);
      if (job.status !== "success") return c.json({ ok: false, error: `那张还没成（${job.status}）` }, 409);
      const src = job.files?.[0]?.path;
      if (!src) return c.json({ ok: false, error: "那张没有落到本地，取不到图" }, 404);
      try {
        const dir = styleDir();
        // 先清掉这条配方可能残留的其他扩展名，免得多张同名接在一起
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(id + ".") && /\.(png|webp|jpe?g)$/i.test(f) && f !== `${id}.0.png`) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
          }
        }
        const target = path.join(dir, `${id}.0.png`);
        fs.copyFileSync(src, target);
        // 把这张用的底句记在该条配方上（底句是随机的，不写清楚，
        // 看的人只会好奇「为什么是狐狸」）
        try { markSample(id, job.prompt || ""); } catch { /* 记不上不影响图已落盘 */ }
        return c.json({ ok: true, id, file: `${id}.0.png`, bytes: fs.statSync(target).size, from: jobId, samplePrompt: job.prompt || "" });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 500);
      }
    });

    // ── 过审：人对「这张样图像不像这条配方」的判定 ───────────────────
    // 它不改配方表（内置表是唯一权威），只往 review.json 里记一笔。
    app.post("/review", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id || "");
      const verdict = String(body?.verdict ?? "");
      // 撤判定走同一个口：verdict 传空串
      if (verdict && !Object.prototype.hasOwnProperty.call(VERDICT_LABEL, verdict)) {
        return c.json({ ok: false, error: `判定只能是 ok / no / unsure（收到「${verdict}」）` }, 400);
      }
      try {
        const saved = setVerdict(id, verdict, body?.note);
        return c.json({ ok: true, id, verdict: saved ? saved.verdict : null, reviews: reviewForUi() });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 400);
      }
    });

    // 提交：卡片里的输入框与外部脚本走同一条路。
    // 走它才会进账本 —— 只有进了账本，/status 才看得到进度。
    app.post("/submit", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const prompt = String(body?.prompt ?? "").trim();
      if (!prompt) return c.json({ ok: false, error: "提示词是空的" }, 400);

      // 风格：界面只传 id；这里解算出最终的正/负向串。
      // 机制：默认那 21 个负向词就是风格闸门 —— 换风格第一步是「删词」，改正向词没用。
      // 注意：自定义配方走同一条路（resolveAny 内部再分内置/自定义），
      // 界面与外部脚本都不用知道这个 id 是哪一档。
      let resolved;
      try {
        resolved = resolveAny(String(body?.style || "default"), prompt, body?.negative);
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 400);
      }

      // 线路：不传 = 默认线（Qwen GGUF，与改造前一字不改）；
      // 传了 = 用适配内核判出来的那条，图和权重都按它拼。
      const lineId = String(body?.line ?? "").trim();
      const usedLine = lineId || DEFAULT_LINE;
      const graphArgs = { ...body, positive: resolved.positive };
      delete graphArgs.style;
      delete graphArgs.line;
      // 默认风格且没 override：负向留空，让 buildGraph 用它内置的那串
      // （账本里 negative=null 就是「用内置串」的意思，别把它写成一串实在的字）。
      // 自定义同理：它本来就不动负向串，留 null 比把 200 字内置串抄进账本干净。
      const negOverride = Boolean(body?.negative && String(body.negative).trim());
      if ((resolved.styleId === "default" || isCustom(resolved.styleId)) && !negOverride) {
        delete graphArgs.negative;
      } else {
        graphArgs.negative = resolved.negative;
      }
      let built;
      try {
        if (lineId && lineId !== DEFAULT_LINE) {
          const { plan } = adaptInspect(await objectInfo());
          const hit = (plan.candidates || []).find((l) => l.id === lineId);
          if (!hit) {
            const why = (plan.candidates || []).length
              ? `这台机器上探到的线路只有：${plan.candidates.map((l) => l.id).join(" / ")}`
              : (plan.blocker || "这台机器上没探到任何可用的线路");
            return c.json({ ok: false, error: `想用「${lineId}」这条线，但没探到它。${why}` }, 400);
          }
          // 线自带的参数只当兜底：body 里有的优先（她用画幅/步数档改过的，按她的来）
          built = buildGraphForPlan(hit, {
            width: hit.params?.width,
            height: hit.params?.height,
            steps: hit.params?.steps,
            sampler: hit.params?.sampler,
            scheduler: hit.params?.scheduler,
            cfg: hit.params?.cfg,
            ...graphArgs,
            positive: resolved.positive,
          });
        } else {
          built = buildGraph(graphArgs);
        }
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 400);
      }

      // 负向词只在客户端**显式改过**时才落进账本；没改就记 null（= 用内置串），
      // 这样「照原样再跑」拿到的是一条不带 200 字负向串的干净记录。
      // 负向词落账：默认风格且没 override 时记 null（= 用内置串），
      // 换成别的风格或高级区改过就记解算后的实串 —— 不然「照原样再跑」复不出来。
      const negative = graphArgs.negative ? String(graphArgs.negative) : null;

      try {
        const promptId = await submit(built.graph);
        newJob({
          promptId,
          prompt,
          params: {
            width: built.width,
            height: built.height,
            steps: built.steps,
            cfg: built.cfg,
            seed: built.seed,
            recipe: body?.recipe ? String(body.recipe).slice(0, 60) : null,
            // 用了哪条线也要落账：不然「照原样再跑」不知道该按哪条线重拼。
            line: usedLine,
            // 风格 id 也要落账 —— 界面发的是 id（正/负向串由管线侧解算），
            // 只存名字等于把它丢了：等映射表接上，后端找不到该解哪一个。
            style: body?.style ? String(body.style).slice(0, 40) : resolved.styleId,
            styleNote: resolved.note,
            negative,
            negative,
            stages: 1,
          },
          graph: built.graph,
        });
        return c.json({ ok: true, job: promptId, seed: built.seed, size: `${built.width}x${built.height}`, steps: built.steps });
      } catch (e) {
        // 这里失败的原因大多不在 App 身上，而是它够不着 ComfyUI ——
        // 原样透出「fetch failed」会让人以为是 App 挂了（我自己就被骗过一次：
        // 脚本报 fetch failed，我还以为是回环抖动，实际是 8188 已经关了）。
        return c.json({ ok: false, error: `连不上 ComfyUI（127.0.0.1:8188）：${String(e?.message || e)}` }, 502);
      }
    });

    // ⚠ 写剪贴板**不走应用总线**。2026-10-09 实测：
    //   ctx.bus.request("clipboard.writeText", …) → 宿主直接拒，原话是
    //   「clipboard.writeText is not one of the bus request verbs a v2 app may call」。
    //   那条能力对应的是 UI 侧桥（插件 UI 的 sdk.clipboard.writeText），
    //   而这个卡页是手写 fetch 的，没装那套 SDK —— 所以复制得在卡页里自己解决：
    //   execCommand("copy") → navigator.clipboard → 把文本摊出来让人手按 Ctrl+C。
    //   见 ui/panel.html 的 copyText()。这里不再留一个必然 502 的路由。

    // 出好的图：卡片读不到本地文件，所以由应用把字节端出来。
    app.get("/image", async (c) => {
      const jobId = c.req.query("job") || "";
      const index = Number.parseInt(c.req.query("i") || "0", 10) || 0;
      const job = loadJobs().find((j) => j.id === jobId);
      const file = job?.files?.[index];
      if (!file || !file.path) return c.json({ ok: false, error: "没有这张图" }, 404);
      try {
        const buf = fs.readFileSync(file.path);
        const ext = path.extname(file.path).toLowerCase();
        const mime = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        return c.body(buf, 200, { "Content-Type": mime, "Cache-Control": "no-store" });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 404);
      }
    });

    // 节点目录：自己安排管线之前先问清楚有什么。
    app.get("/nodes", async (c) => {
      try {
        const name = c.req.query("name");
        if (name) {
          const spec = await nodeSpec(String(name));
          if (!spec) return c.json({ ok: false, error: `没有这个节点：${name}` }, 404);
          return c.json({ ok: true, spec });
        }
        const all = await nodeNames();
        const kw = String(c.req.query("keyword") || "").trim().toLowerCase();
        if (!kw) return c.json({ ok: true, total: all.length, sample: all.slice(0, 40) });
        const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query("limit") || "30", 10) || 30));
        const hit = all.filter((n) => n.toLowerCase().includes(kw));
        return c.json({ ok: true, keyword: kw, matched: hit.length, nodes: hit.slice(0, limit) });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 502);
      }
    });

    // 跑自己组装的节点图（与 comfy_run 工具同一条路）。
    app.post("/run", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const graph = body?.graph;
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
        return c.json({ ok: false, error: "graph 必须是一个对象" }, 400);
      }
      if (Object.keys(graph).length === 0) return c.json({ ok: false, error: "graph 是空的" }, 400);
      try {
        const promptId = await submit(graph);
        const ex = extractParams(graph);
        newJob({
          promptId,
          prompt: String(body?.label || "(自定义管线)"),
          // 尺寸/seed 从图里抽（拿不到就 null，不猜）；steps 拿不到时留 null，
          // 进度估算会退到 20 —— 宁可估得粗，也不编一个数写进账本。
          params: {
            width: ex.width,
            height: ex.height,
            steps: ex.steps ?? num(body?.steps),
            seed: ex.seed,
            stages: ex.stages || null,
            custom: true,
          },
          graph,
        });
        return c.json({ ok: true, job: promptId, nodes: Object.keys(graph).length, extracted: ex });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 502);
      }
    });

    // 取消：在跑的走 interrupt，排队中的从队列删。只取消一条，不动其他的。
    // 打断之后必须显式清一次显存 —— 8 GB 卡上中断常留残留，不清下一次容易 OOM。
    app.post("/cancel", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const asked = String(body?.job || "").trim();

      let q = null;
      try { q = await queue(); } catch { /* 队列拿不到就退回账本判 */ }
      const runningIds = q?.runningIds || [];
      const pendingIds = q?.pendingIds || [];
      const live = loadJobs().filter((j) => j.status === "running");   // 新的在前

      let mode = null;
      if (asked && runningIds.includes(asked)) mode = "running";
      else if (asked && pendingIds.includes(asked)) mode = "pending";
      else if (!asked && runningIds.length) mode = "running";
      else if (!asked && pendingIds.length) mode = "pending";
      else if (asked && live.some((j) => j.id === asked)) mode = "running";   // 队列看不见，但账本说它在
      else if (!asked && live.length) mode = "running";
      if (!mode) return c.json({ ok: false, error: "队列是空的，没有可取消的" }, 409);

      const targetId = asked || (mode === "pending" ? pendingIds[0] : runningIds[0]) || live[0]?.id || null;

      let interrupted = false;
      let dequeued = false;
      try {
        if (mode === "running") { await interrupt(); interrupted = true; }
        else if (targetId) { await deleteQueued(targetId); dequeued = true; }
      } catch (e) {
        return c.json({ ok: false, mode, error: `取消没成：${e?.message || e}` }, 502);
      }

      // interrupt 是协作式的：它停在下一个步边界，队列要过一下才把人摘掉。
      // 实测：在队列还没放空时就清显存，读回来只有 1.38 GB；等它真停稳了再清，
      // 采样中的 1.55 GB 会回到 6.81 GB，而且模型不用卸载也够。
      // 所以先等队，再清。
      let vramFreed = false;
      let settled = false;
      if (interrupted) {
        for (let i = 0; i < 7; i++) {
          await new Promise((r) => setTimeout(r, 700));
          try {
            const q2 = await queue();
            if (!q2.runningIds.includes(targetId)) { settled = true; break; }
          } catch { break; }
        }
        // 清显存失败不算取消失败 —— 它是善后，不是取消本身。
        try { await freeMemory({ unloadModels: false, freeCache: true }); vramFreed = true; }
        catch { /* 上面那句注释就是这个 catch 的意思 */ }
      }

      // 账本落「已取消」。不落的话这条会永远挂在 running 上 ——
      // history 里不会有它的结果，对账永远等不到。
      const rec = targetId ? findJob(targetId) : null;
      if (rec && rec.status === "running") {
        updateJob(rec.id, { status: "canceled", completedAt: new Date().toISOString() });
      }

      let after = null;
      try { const q2 = await queue(); after = { running: q2.running, pending: q2.pending }; } catch { /* ignore */ }
      return c.json({ ok: true, mode, job: rec?.id || targetId, interrupted, dequeued, settled, vramFreed, queue: after });
    });

    // 照原样再跑：账本里存着原图就原样再投一次；老记录没存才退回照参数重建。
    app.post("/rerun", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const rec = findJob(String(body?.job || "").trim());
      if (!rec) return c.json({ ok: false, error: "账本里没有这条记录" }, 404);
      try {
        let graph;
        let params;
        let mode;
        if (rec.graph && typeof rec.graph === "object" && Object.keys(rec.graph).length) {
          graph = rec.graph;
          params = { ...rec.params };
          mode = "graph";
        } else {
          const built = buildGraph({ ...rec.params, positive: rec.prompt });
          graph = built.graph;
          params = {
            width: built.width, height: built.height, steps: built.steps, cfg: built.cfg,
            seed: built.seed, recipe: rec.params?.recipe ?? null, style: rec.params?.style ?? null,
            negative: rec.params?.negative ?? null, stages: 1,
          };
          mode = "rebuilt";
        }
        const promptId = await submit(graph);
        newJob({ promptId, prompt: rec.prompt, params, graph });
        return c.json({ ok: true, job: promptId, mode, of: rec.id });
      } catch (e) {
        return c.json({ ok: false, error: String(e?.message || e) }, 502);
      }
    });
  });

  ctx.logger?.info?.("出图台后端路由已挂载", { prefix: "/api/apps/comfyui-studio/routes" });
  return dispose;
}
