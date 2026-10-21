/**
 * lib/jobs.mjs — 出图任务表（落盘 JSON，重启不丢）。
 *
 * 一张图在本机要 3~6.5 分钟，远超一次工具调用的合理等待时间。
 * 所以出图拆成两段：comfy_draw 提交并记账，comfy_result 回查并取图。
 * 这里就是那本账。
 */

import fs from "node:fs";
import path from "node:path";

let dataDir = "";

export function bindDataDir(dir) {
  dataDir = String(dir || "");
}

function file() {
  if (!dataDir) throw new Error("数据目录未绑定");
  return path.join(dataDir, "jobs.json");
}

/** 任务表按时间倒序返回，最多保留 200 条。 */
export function loadJobs() {
  try {
    const raw = fs.readFileSync(file(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

/** 单条 graph 的体积护栏：正常一张 3~6 KB，防的是有人往提示词里塞巨物。 */
const MAX_GRAPH_BYTES = 64 * 1024;

function graphBytes(graph) {
  try { return JSON.stringify(graph).length; } catch { return Number.POSITIVE_INFINITY; }
}

export function saveJobs(jobs) {
  const trimmed = jobs.slice(0, 200);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, jobs: trimmed }, null, 2), "utf-8");
  } catch {
    /* 记账失败不能反过来影响出图 */
  }
  return trimmed;
}

export function newJob({ promptId, prompt, params, graph }) {
  const job = {
    id: promptId,
    prompt: String(prompt || "").slice(0, 500),
    params: params || {},
    // 收到的节点图原样存一份：丢过一张精修图之后才知道这个字段要留。
    // 不按条数砍老图 —— 那会让 40 条以前的「照原样再跑」悄悄退成重建，
    // 而这个字段的初衷就是别再丢图。只有超大的才不收。
    graph: graph && typeof graph === "object" && graphBytes(graph) <= MAX_GRAPH_BYTES ? graph : null,
    status: "running",
    submittedAt: new Date().toISOString(),
    completedAt: null,
    images: [],
    files: [],
    error: null,
  };
  const jobs = loadJobs();
  jobs.unshift(job);
  saveJobs(jobs);
  return job;
}

export function updateJob(id, patch) {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...patch };
  saveJobs(jobs);
  return jobs[idx];
}

export function findJob(id) {
  return loadJobs().find((j) => j.id === id) || null;
}

/** 风格样图目录（App 数据目录内）。样图是批量跑出来的，不是用户传的。 */
export function styleDir() {
  const dir = path.join(dataDir, "styles");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就让调用方看到空目录 */
  }
  return dir;
}

/** 图落盘目录（App 数据目录内，宿主允许写）。 */
export function imageDir() {  const dir = path.join(dataDir, "images");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

/** 把取到的图片字节写进数据目录，返回绝对路径。 */
export function writeImage(filename, bytes) {
  const target = path.join(imageDir(), filename);
  fs.writeFileSync(target, Buffer.from(bytes));
  return target;
}

/** 从 fd 里读一段字节；不够长就回 null（不去读半截东西）。 */
function readAt(fd, offset, len) {
  const buf = Buffer.alloc(len);
  return fs.readSync(fd, buf, 0, len, offset) === len ? buf : null;
}

function webpSize(fd, head) {
  const chunk = head.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    const b = readAt(fd, 26, 4);                 // 有损：0x9d012a 之后是 14 位宽高
    if (!b) return null;
    return { width: b.readUInt16LE(0) & 0x3fff, height: b.readUInt16LE(2) & 0x3fff, format: "webp/vp8" };
  }
  if (chunk === "VP8L") {
    // 签名 0x2f 在 payload 首字节（偏移 20），尺寸位从 21 起 ——
    // 别把签名和尺寸位看串了（我第一版看串了，单测当场回 null）。
    if (head[20] !== 0x2f) return null;
    const b = readAt(fd, 21, 4);                 // 14 位宽-1 + 14 位高-1，小端打包
    if (!b) return null;
    const bits = b.readUInt32LE(0);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp/vp8l" };
  }
  if (chunk === "VP8X") {
    const b = readAt(fd, 24, 6);                 // 扩展：canvas 宽高各 24 位小端，存的是「减一」
    if (!b) return null;
    return {
      width: 1 + (b[0] | (b[1] << 8) | (b[2] << 16)),
      height: 1 + (b[3] | (b[4] << 8) | (b[5] << 16)),
      format: "webp/vp8x",
    };
  }
  return null;
}

function jpegSize(fd) {
  let off = 2;
  for (let i = 0; i < 64; i++) {
    const m = readAt(fd, off, 4);
    if (!m || m[0] !== 0xff) return null;
    const marker = m[1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    const len = m.readUInt16BE(2);
    if (len < 2) return null;
    // SOFn 里才有尺寸；C4(DHT) / C8(JPG) / CC(DAC) 不是 SOF，得跳过
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const seg = readAt(fd, off + 4, 5);        // 精度(1) + 高(2) + 宽(2)
      if (!seg) return null;
      return { width: seg.readUInt16BE(3), height: seg.readUInt16BE(1), format: "jpeg" };
    }
    off += 2 + len;
  }
  return null;
}

/**
 * 读图片的真实像素。认 PNG / WebP / JPEG —— 因为 /image 路由是按扩展名发这三种 MIME 的。
 * 只认 PNG 也行“今天”，但那是个看不出来的坏：字段在、值永远空。换一天存了 webp，
 * 实出尺寸就会恒为 null，而没有任何地方会报错。认不出就回 null，不猜。
 */
export function imageSize(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(32);
      const n = fs.readSync(fd, head, 0, 32, 0);
      if (n < 16) return null;
      if (head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
        if (n < 24) return null;                   // PNG：IHDR 宽高在第 16/20 字节，大端
        return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), format: "png" };
      }
      if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
        return webpSize(fd, head);
      }
      if (head[0] === 0xff && head[1] === 0xd8) return jpegSize(fd);
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
