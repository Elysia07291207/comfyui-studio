/**
 * lib/comfy.mjs — 本机 ComfyUI 的 HTTP 客户端。
 *
 * 网络出口走宿主给的受管 fetch（manifest 里声明了 allowLocalhost + allowedHosts）。
 * 这里保留一个兼容层：不同版本宿主可能把通道挂在 ctx.network.fetch、ctx.fetch，
 * 或者干脆允许全局 fetch —— 三者取其一，避免因为名字不对而整块不可用。
 */

let netFetch = null;
let baseUrl = "http://127.0.0.1:8188";
let log = console;

/** 由 index.js 在 apply() 时调用，把宿主的 fetch 与本应用上下文钉进来。 */
export function bindNetwork(ctx) {
  const candidates = [
    ctx?.network?.fetch && ctx.network.fetch.bind(ctx.network),
    ctx?.fetch && ctx.fetch.bind(ctx),
    typeof globalThis.fetch === "function" && globalThis.fetch.bind(globalThis),
  ];
  netFetch = candidates.find((fn) => typeof fn === "function") || null;
  if (ctx?.logger) log = ctx.logger;
  return { hasFetch: Boolean(netFetch) };
}

export function setBaseUrl(url) {
  if (typeof url === "string" && url.trim()) baseUrl = url.trim().replace(/\/+$/, "");
}

export function getBaseUrl() {
  return baseUrl;
}

async function request(pathname, { method = "GET", body, timeoutMs = 60000 } = {}) {
  if (!netFetch) throw new Error("宿主没有给出网络出口（ctx.network.fetch 不可用）");
  const url = `${baseUrl}${pathname}`;
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body);
  }
  if (timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    init.signal = ac.signal;
    try {
      return await netFetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }
  return netFetch(url, init);
}

async function requestJson(pathname, opts) {
  const res = await request(pathname, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ComfyUI ${opts?.method || "GET"} ${pathname} 返回 ${res.status}：${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`ComfyUI ${pathname} 返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

/** 服务是否在线，顺带报版本与显存。 */
export async function health() {
  const stats = await requestJson("/system_stats", { timeoutMs: 8000 });
  const dev = Array.isArray(stats?.devices) ? stats.devices[0] : null;
  return {
    online: true,
    version: stats?.system?.comfyui_version ?? null,
    python: stats?.system?.python_version ?? null,
    device: dev?.name ?? null,
    vramFreeGb: dev ? Math.round((dev.vram_free / 1024 ** 3) * 100) / 100 : null,
    vramTotalGb: dev ? Math.round((dev.vram_total / 1024 ** 3) * 100) / 100 : null,
  };
}

/** 提交一份节点图，返回 prompt_id。校验不通过时 ComfyUI 会把原因写在 body 里。 */
export async function submit(graph) {
  const res = await requestJson("/prompt", { method: "POST", body: { prompt: graph }, timeoutMs: 30000 });
  if (!res?.prompt_id) throw new Error(`提交未返回 prompt_id：${JSON.stringify(res).slice(0, 200)}`);
  return res.prompt_id;
}

/** 查一次历史。返回 null 表示还没跑完。 */
export async function history(promptId) {
  const all = await requestJson(`/history/${encodeURIComponent(promptId)}`, { timeoutMs: 15000 });
  const entry = all?.[promptId];
  if (!entry) return null;

  const status = entry?.status?.status_str ?? "unknown";
  const images = [];
  const outputs = entry?.outputs ?? {};
  for (const nodeId of Object.keys(outputs)) {
    const list = outputs[nodeId]?.images;
    if (!Array.isArray(list)) continue;
    for (const img of list) {
      images.push({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
    }
  }

  let errorMessage = null;
  if (status !== "success" && Array.isArray(entry?.status?.messages)) {
    for (const m of entry.status.messages) {
      const s = JSON.stringify(m);
      if (s.includes("exception_message")) errorMessage = s.slice(0, 600);
    }
  }

  return { status, done: status === "success" || status === "error", images, errorMessage };
}

/** 队列概况：正在跑几个、排队几个，并带上 prompt_id 列表（进度条要靠它认人）。 */
export async function queue() {
  const q = await requestJson("/queue", { timeoutMs: 10000 });
  const running = Array.isArray(q?.queue_running) ? q.queue_running : [];
  const pending = Array.isArray(q?.queue_pending) ? q.queue_pending : [];
  const idOf = (item) => {
    if (Array.isArray(item)) return item[1] ?? null;
    return item?.prompt_id ?? null;
  };
  return {
    running: running.length,
    pending: pending.length,
    runningIds: running.map(idOf).filter(Boolean),
    pendingIds: pending.map(idOf).filter(Boolean),
  };
}

/** 节点目录（3MB 级），进程内缓存一次。 */
let objectInfoCache = null;
export async function objectInfo(force = false) {
  if (!objectInfoCache || force) {
    objectInfoCache = await requestJson("/object_info", { timeoutMs: 90000 });
  }
  return objectInfoCache;
}

/** 节点名清单。 */
export async function nodeNames() {
  const oi = await objectInfo();
  return Object.keys(oi || {});
}

/** 一个节点的输入规格，精简过（去掉 tooltip 之类）。 */
export async function nodeSpec(name) {
  const oi = await objectInfo();
  const node = oi?.[name];
  if (!node) return null;
  const out = {
    name,
    category: node.category || null,
    outputs: node.output || [],
    required: {},
    optional: {},
  };
  for (const group of ["required", "optional"]) {
    const src = node.input?.[group] || {};
    for (const key of Object.keys(src)) {
      const spec = src[key];
      const t = Array.isArray(spec) ? spec[0] : spec;
      const meta = Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? spec[1] : {};
      const entry = { type: Array.isArray(t) ? "ENUM" : t };
      if (Array.isArray(t)) entry.options = t.slice(0, 80);
      if (meta.default !== undefined) entry.default = meta.default;
      if (meta.min !== undefined) entry.min = meta.min;
      if (meta.max !== undefined) entry.max = meta.max;
      out[group][key] = entry;
    }
  }
  return out;
}

/** 把一张出好的图取成字节（走 /view，不碰文件系统）。 */
export async function fetchImage({ filename, subfolder = "", type = "output" }) {
  const qs = new URLSearchParams({ filename, subfolder, type });
  const res = await request(`/view?${qs.toString()}`, { timeoutMs: 60000 });
  if (!res.ok) throw new Error(`取图失败 ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/* ── 中止这条线（实测过：两个端点都吃空 body，都返回 200） ────────── */

/** 打断当前正在跑的那一条。没在跑时调用也返回 200，是安全的。 */
export async function interrupt() {
  const res = await request("/interrupt", { method: "POST", body: {}, timeoutMs: 15000 });
  if (!res.ok) throw new Error(`interrupt 返回 ${res.status}`);
  return true;
}

/**
 * 显式清一次显存。
 * 8 GB 卡上打断之后照例留有残留，不先清一下，下一张容易 OOM。
 * 默认只放缓存、不卸载权重 —— unload_models 会让下一张多等一次模型加载，
 * 除非确实腾不出地方，否则不白花这个时间。
 */
export async function freeMemory({ unloadModels = false, freeCache = true } = {}) {
  const res = await request("/free", {
    method: "POST",
    body: { unload_models: !!unloadModels, free_memory: !!freeCache },
    timeoutMs: 20000,
  });
  if (!res.ok) throw new Error(`free 返回 ${res.status}`);
  return true;
}

/** 从队列里删掉一条还没开始跑的。已经在跑的那条删不掉，只能用 interrupt。 */
export async function deleteQueued(promptId) {
  const res = await request("/queue", {
    method: "POST",
    body: { delete: [String(promptId)] },
    timeoutMs: 15000,
  });
  if (!res.ok) throw new Error(`删队列项返回 ${res.status}`);
  return true;
}
