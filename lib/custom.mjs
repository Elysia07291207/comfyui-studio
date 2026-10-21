/**
 * lib/custom.mjs — 自定义配方（用户自己加的，落盘 JSON）。
 *
 * ── 为什么不塞进 styles.mjs ─────────────────────────────────────────
 *   内置那 60 条是**常量**（写在源码里，只有改代码才能变）；自定义是**数据**（点一下就写盘）。
 *   两样混在一个文件里，迟早会冒出「哪一份说了算」的问题 —— 这个项目在
 *   「线上还是旧 15 条 / 源码 63 条」上已经亏过一次。所以切干净：
 *     · 内置表 → styles.mjs（唯一权威，这份代码一个字节都不碰它）
 *     · 自定义  → 这里
 *
 * ── 唯一解算处：resolveAny() ───────────────────────────────────────
 *   内置 id 原样交给 styles.mjs 的 resolveStyle；自定义 id 在这里解算。
 *   界面/路由只跟 id 打交道，不关心它是哪一档。
 *
 * ── 三条写死的规矩 ────────────────────────────────────────────────
 *   1. **只能新增，不能改内置**：id 前缀 `u-`，且 addCustom 会拒绝与内置 id 撞。
 *   2. **不碰负向串**：cfg = 1.0 下负向支被乘 0，删词对画面零影响（同 seed 逐像素差 0.00）。
 *      所以字段里干脆没有 dropNeg —— 给一个不生效的开关，等于教人用它。
 *      **骨架（posSuffix）是唯一杠杆，也是唯一要填的东西。**
 *   3. **id 生成后不许改**：账本里 `params.style` 存的就是它，改名不要紧，改 id 会断链。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STYLES, NEG_WORDS, resolveStyle } from "./styles.mjs";
import { DEFAULT_NEGATIVE } from "./graph.mjs";

let dataDir = "";

/** 由 index.js 在 apply() 时调用（和 jobs.mjs 用同一个数据目录）。 */
export function bindDataDir(dir) {
  dataDir = String(dir || "");
}

function file() {
  if (!dataDir) throw new Error("数据目录未绑定");
  return path.join(dataDir, "custom_recipes.json");
}

/** id 的形状钉死：`u-` + 6 位十六进制。也顺手满足 /style-image 的字符白名单。 */
const ID_RE = /^u-[0-9a-f]{6}$/;
const MAX_NAME = 24;
const MAX_SKELETON = 240;
const MAX_ITEMS = 200;

const clip = (s, n) => String(s ?? "").trim().slice(0, n);

/**
 * 读表。**坏条目逐条丢，不整表丢** —— 这个文件是可以被手改坏的，
 * 坏一条不该毁掉整张表（也不该让 App 起不来）。
 */
export function listCustom() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf-8"));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter((s) => {
      if (!s || !ID_RE.test(String(s.id || ""))) return false;
      if (typeof s.name !== "string" || !s.name.trim()) return false;
      if (typeof s.posSuffix !== "string" || !s.posSuffix.trim()) return false;
      return true;
    });
  } catch {
    return [];   // 文件不在 / 是空的 / 坏了：当空表，不抛
  }
}

/** 写表：先写 .tmp 再改名。写一半断电不该把整表变成半个 JSON。 */
function save(items) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), "utf-8");
  fs.renameSync(tmp, file());
  return items;
}

/** 生成一个不与现有自定义、也不与内置相撞的 id。 */
function newId(items) {
  for (let i = 0; i < 50; i++) {
    const id = "u-" + crypto.randomBytes(3).toString("hex");
    if (!items.some((s) => s.id === id) && !STYLES.some((s) => s.id === id)) return id;
  }
  throw new Error("id 连撞 50 次，不对劲");
}

/**
 * 新增一条。名字与骨架都必填 —— 名字是给人认的，骨架是唯一会让画面变的东西。
 * 两条都不给或给一半，存下去只会得到一条「选了等于没选」的配方。
 */
export function addCustom({ name, posSuffix, samplePrompt } = {}) {
  const nm = clip(name, MAX_NAME);
  const sk = clip(posSuffix, MAX_SKELETON);
  if (!nm) throw new Error("名字是空的");
  if (!sk) throw new Error("骨架是空的 —— 自定义配方只有骨架这一个杠杆，不能空");

  const items = listCustom();
  if (items.length >= MAX_ITEMS) throw new Error(`自定义配方最多 ${MAX_ITEMS} 条`);
  if (items.some((s) => s.name === nm)) throw new Error(`已经有一条叫「${nm}」的了`);

  const row = {
    id: newId(items),
    name: nm,
    posSuffix: sk,
    // 空字符串 = **每次跑样图都随机挑一句**；非空 = 用户锁定了这一句
    samplePrompt: clip(samplePrompt, 200),
    createdAt: new Date().toISOString(),
  };
  items.unshift(row);
  save(items);
  return row;
}

/**
 * 改一条。只能改自定义的 —— 传内置 id 直接拒，这是「只能新增不能改内置」那条不变量的门。
 * 为何要有改：骨架是个自由文本框，打错一个字就逼人「删了重建」，
 * 而删会把那条的样图一起带走（再跑一张又是 45 秒）。
 */
export function updateCustom(id, { name, posSuffix, samplePrompt } = {}) {
  const items = listCustom();
  const idx = items.findIndex((s) => s.id === String(id || ""));
  if (idx === -1) {
    if (STYLES.some((s) => s.id === id)) throw new Error("内置配方不能改 —— 自定义只能新增");
    throw new Error("没有这条自定义配方");
  }
  const nm = clip(name, MAX_NAME);
  const sk = clip(posSuffix, MAX_SKELETON);
  if (!nm) throw new Error("名字是空的");
  if (!sk) throw new Error("骨架是空的 —— 自定义配方只有骨架这一个杠杆，不能空");
  if (items.some((s) => s.name === nm && s.id !== items[idx].id)) throw new Error(`已经有一条叫「${nm}」的了`);

  items[idx] = {
    ...items[idx],
    name: nm,
    posSuffix: sk,
    // undefined = 这次不改它（改名字的时候不该顺手把锁着的底句抹了）；空串 = 改回随机
    samplePrompt: samplePrompt === undefined ? (items[idx].samplePrompt || "") : clip(samplePrompt, 200),
    updatedAt: new Date().toISOString(),
  };
  save(items);
  return items[idx];
}

/**
 * 记下这条配方最近一张样图用的是哪句底句。
 * 为何要记：底句是随机的，不在界面上写清楚，看的人只会好奇「为什么是狐狸」——
 * 那张图到底演示了什么，得知道它压在什么东西上才算数。
 */
export function markSample(id, prompt) {
  const items = listCustom();
  const idx = items.findIndex((s) => s.id === String(id || ""));
  if (idx === -1) return null;
  items[idx] = { ...items[idx], samplePromptUsed: clip(prompt, 200), sampleAt: new Date().toISOString() };
  save(items);
  return items[idx];
}

export function removeCustom(id) {
  const items = listCustom();
  const next = items.filter((s) => s.id !== id);
  if (next.length === items.length) return null;
  save(next);
  return id;
}

export function customById(id) {
  const key = String(id || "");
  if (!ID_RE.test(key)) return null;        // 前缀不对就不必读盘
  return listCustom().find((s) => s.id === key) || null;
}

export function isCustom(id) {
  return Boolean(customById(id));
}

/**
 * 给界面看的形状：字段对齐 stylesForUi()，界面才好把两档合到一起渲染。
 * `status: "custom"` 是**新的一档**，不是 candidate ——
 * 「用户随手写的一条」和「丹青填过、跑过的 58 条」不该长一个样。
 */
export function customForUi() {
  return listCustom().map((s) => ({
    id: s.id,
    name: s.name,
    cat: null,
    catName: "我的配方",
    sub: null,
    tags: {},
    status: "custom",
    dropNeg: [],
    posSuffix: s.posSuffix,
    keepNeg: NEG_WORDS.length,
    semi: [],
    note: "自定义配方 · 未实测。骨架是这套栈唯一的风格杠杆（cfg 1.0 下负向不生效）。",
    // 空串 = 样图底句每次随机；非空 = 用户锁了一句
    samplePrompt: s.samplePrompt || "",
    // 最近那张样图实际用的底句（给对比视图写清楚它在演什么）
    samplePromptUsed: s.samplePromptUsed || "",
    createdAt: s.createdAt || null,
  }));
}

/**
 * 拼正向串。首尾的逗号/空白去掉，相接处不出现两个逗号 ——
 * 人在输入框里很容写「，琥珀色调，」，拼起来就变成「一只猫，，琥珀色调，」。
 */
function joinPositive(base, skeleton) {
  const sk = String(skeleton || "").replace(/^[，,\s]+/, "").replace(/[，,\s]+$/, "");
  if (!sk) return base;
  if (/[，,]\s*$/.test(base)) return base.replace(/[，,]\s*$/, "，") + sk;
  return `${base}，${sk}`;
}

/**
 * 唯一的解算处。返回形状与 styles.mjs 的 resolveStyle 完全一致：
 * { positive, negative, styleId, note }。
 */
export function resolveAny(styleId, prompt, negativeOverride = "") {
  const id = String(styleId || "");
  const c = customById(id);
  if (!c) return resolveStyle(id, prompt, negativeOverride);   // 不是自定义 → 原路交给内置那处

  const base = String(prompt || "").trim();
  if (!base) throw new Error("提示词是空的");
  const positive = joinPositive(base, c.posSuffix);
  if (negativeOverride && negativeOverride.trim()) {
    return {
      positive,
      negative: negativeOverride.trim(),
      styleId: id,
      note: "负向词被高级区 override 了（自定义配方本来也不动负向）",
    };
  }
  return {
    positive,
    negative: DEFAULT_NEGATIVE,      // 自定义不碰负向串，原样用内置那串
    styleId: id,
    note: `自定义配方「${c.name}」· 未实测（骨架是唯一杠杆）`,
  };
}

/** 给样图用的底句：**随机挑**，不固定。
 *
 *  为什么随机（东篱 2026-10-13 定的）：固定一句的话，一条讲「留白」的配方
 *  和一条讲「厚涂」的配方跑出来都是同一只猫坐在同一张桌子上，
 *  你看不出骨架到底做了什么。换主体、换环境，才看得出**骨架**是那个变量。
 *
 *  要求：① 风格中立（不带平涂/油画/逆光/留白这类词）—— 否则底句会和骨架打架；
 *          ② 有主体也有环境 —— 不然「特写」「俯视」「留白版式」这类骨架没东西可作用。
 *  想要固定的话，用户自己在表单里锁一句（存进 item.samplePrompt）。
 */
export const SAMPLE_PROMPTS = [
  "一只狐狸趴在旧书堆上",
  "雾里的灯塔，礁石上停着海鸟",
  "窗台上的一只搪瓷杯，杯口冒着热气",
  "桌上一台老相机，旁边散着几张底片",
  "沼泽边的白鹭，水面浮着浮萍",
  "一辆旧自行车靠在爬满藤的墙上",
  "深夜便利店的柜台，灯管很亮",
  "山道上的石阶，两侧长满青苔",
  "一把木椅放在空旷的房间里",
  "藤篮里的三颗柠檬，旁边一把小刀",
  "雨天公交站的广告牌，玻璃上有水痕",
  "一只瓷猫摆件立在书架顶端",
  "集市摊上的陶罐与干辣椒",
  "铁轨伸进雾里，枕木盖着薄雪",
  "桌上摊着半局围棋，旁边一只茶盏",
  "一只橘猫蜷在暖气片上",
];

/** 随便挑一句。传 exclude 可以避开上一句（连拍两张不想撞上同一个主体）。 */
export function randomSamplePrompt(exclude = "") {
  const pool = SAMPLE_PROMPTS.filter((p) => p !== exclude);
  const list = pool.length ? pool : SAMPLE_PROMPTS;
  return list[crypto.randomInt(list.length)];
}

/** 给样图用的基准提示词（历史字段）：没指定、池子也空了才用到它。 */
export const SAMPLE_PROMPT_DEFAULT = SAMPLE_PROMPTS[0];
