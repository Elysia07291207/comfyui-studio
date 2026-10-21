/**
 * lib/review.mjs — 过审记录：人对「这张样图像不像这条配方」的判定。
 *
 * ── 为什么要单独一份，且不写进 styles.mjs ────────────────────────────
 *   判定是**关于表的观察**，不是表本身。内置表仍是唯一权威（丹青的地盘），
 *   这里只记「谁在什么时候看过、判了什么」。落盘 `app-data/.../review.json`。
 *
 * ── 两条轴，别混 ──────────────────────────────────────────────────
 *   `status`  = 骨架写没写、能不能用（管线侧的事）
 *   `review`  = 人看过那张样图没有、判像不像（这的事）
 *   58 条 candidate 本来只是「有样图」，不等于「有人判过」。
 *
 * ── 三档判定 ─────────────────────────────────────────────────────
 *   ok     像
 *   no     不像
 *   unsure 说不好
 *   判定可以撤（撤销 = 恢复「没判过」）。判「不像」不自动改任何东西 ——
 *   改骨架还是删条目是另一个决定，得看清楚再动手。
 */

import fs from "node:fs";
import path from "node:path";

let dataDir = "";

/** 由 index.js 在 apply() 时调用（和 jobs / custom 用同一个数据目录）。 */
export function bindDataDir(dir) {
  dataDir = String(dir || "");
}

function file() {
  if (!dataDir) throw new Error("数据目录未绑定");
  return path.join(dataDir, "review.json");
}

export const VERDICTS = ["ok", "no", "unsure"];
export const VERDICT_LABEL = { ok: "像", no: "不像", unsure: "说不好" };

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_NOTE = 120;

/**
 * 读记录。坏条目逐条丢（和 custom 那边同一个理由：这文件可以被人手改坏，
 * 坏一条不该毁掉整份记录，更不该让 App 起不来）。
 */
export function loadReviews() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf-8"));
    const items = parsed && typeof parsed.items === "object" && parsed.items ? parsed.items : {};
    const out = {};
    for (const [id, v] of Object.entries(items)) {
      if (!ID_RE.test(id)) continue;
      if (!v || !VERDICTS.includes(v.verdict)) continue;
      out[id] = {
        verdict: v.verdict,
        at: typeof v.at === "string" ? v.at : null,
        note: typeof v.note === "string" ? v.note.slice(0, MAX_NOTE) : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

function save(items) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), "utf-8");
  fs.renameSync(tmp, file());
  return items;
}

/** 记一条判定。verdict 传空串 = 撤销。只收三档值，别的直接拒。 */
export function setVerdict(id, verdict, note = "") {
  const key = String(id || "");
  if (!ID_RE.test(key)) throw new Error("id 不合法");
  const v = String(verdict || "");
  const items = loadReviews();
  if (!v) {
    delete items[key];
    save(items);
    return null;
  }
  if (!VERDICTS.includes(v)) throw new Error(`判定只能是 ${VERDICTS.join(" / ")}（收到「${v}」）`);
  items[key] = { verdict: v, at: new Date().toISOString(), note: String(note || "").trim().slice(0, MAX_NOTE) };
  save(items);
  return items[key];
}

/** 给界面：记录本身 + 三个计数（自己数，免得界面再遍历一遍）。 */
export function reviewForUi() {
  const items = loadReviews();
  const counts = { ok: 0, no: 0, unsure: 0 };
  for (const v of Object.values(items)) counts[v.verdict]++;
  return { items, counts, total: Object.keys(items).length };
}

/* ── 样图底句：**这条规则两边必须一致** ──────────────────────────────
 *   batch 跑样图（probe_style_samples.mjs）和界面上的标签共用它。
 *   放在 lib 里而不是各写一份，就是为了不让「界面写的」和「真跑时的」分叉。
 *
 *   规则：构图类与交付类的骨架会被场景压过去（头像出来还是「一只猫在窗台上」），
 *   所以这两类用不含场景的那句；其余用带场景的那句。
 */
export const BASE_SCENE = "一只猫坐在木桌上，旁边一只茶杯，窗外的雨";
export const BASE_PLAIN = "一只猫";

/**
 * 例外：**主体本身就是画面主体**的那几条 —— 内置那两句都给不了它要的东西。
 *
 * food 是 2026-10-13 过审时发现的：它的骨架说「食物特写 / 俯拍 / 热气油光」，
 * 而底句是「一只猫坐在木桌上…」—— 画面里连食物都没有，这张样图从头就不在演这条配方。
 * 那是**测试设计的错**，不是骨架的错。这类条目得自带底句。
 */
export const BASE_OVERRIDE = {
  food: "桌上一碗热汤面，旁边一双筷子，几碟小菜",
  // 暖褐奶油白的主色是暖调，而内置那句「窗外的雨」是冷调 —— 会和这条配色打架
  cream: "一只猫窝在奶油白的沙发上，暖褐木地板，午后阳光",
};

/** 这一条的内置样图实际用哪句底句（唯一权威，跑样图与界面都走它）。 */
export function basePromptOf(s) {
  if (!s) return BASE_SCENE;
  if (BASE_OVERRIDE[s.id]) return BASE_OVERRIDE[s.id];
  return sampleBaseFor(s) === "plain" ? BASE_PLAIN : BASE_SCENE;
}

/** 一条内置配方的样图用哪一类底句。自定义配方用的是随机池（返回 "pool"）。 */
export function sampleBaseFor(s) {
  if (!s) return null;
  if (s.status === "custom") return "pool";
  if (s.cat === "delivery") return "plain";
  if (s.cat === "subject" && s.sub === "构图") return "plain";
  return "scene";
}

/**
 * 给人看的那句话。**直接给句子**，不再让界面自己拼 ——
 * 界面手里那份措辞会跟这里分叉（这轮已经因为“白名单 map 丢字段”吃过一次亏）。
 */
export function sampleBaseTextFor(s) {
  if (!s) return "";
  if (s.status === "custom") return "随机底句（每次跑现场从池子里挑一句）";
  if (BASE_OVERRIDE[s.id]) return "这条特设的底句「" + BASE_OVERRIDE[s.id] + "」（主体本身就得是画面主体，内置那两句给不了）";
  if (sampleBaseFor(s) === "plain") return "无场景句「" + BASE_PLAIN + "」（构图与交付类用这句，骨架才不会被场景压过去）";
  return "带场景句「" + BASE_SCENE + "」";
}

/** 兼容旧名（外部若还在调的话）。 */
export function sampleBaseText(kind) {
  if (kind === "plain") return sampleBaseTextFor({ cat: "delivery" });
  if (kind === "pool") return sampleBaseTextFor({ status: "custom" });
  if (kind === "scene") return sampleBaseTextFor({ cat: "medium" });
  return "";
}
