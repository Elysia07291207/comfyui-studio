/**
 * lib/styles.mjs — 风格配方表（管线侧的唯一权威）。
 *
 * 分工（见 风格预设.md §3）：界面**只传 id**；id → 正/负向串的解算**只在这一处**。
 *
 * ── 一条配方是什么（A 路 · 2026-10-12 订正）────────────────────────
 *   配方 = **正向后缀骨架** + **负向串版本**（= 从默认 21 词里删掉哪几个）。
 *   ⚠️ 机制订正：默认图走 **cfg = 1.0**，采样里负向那一支被乘 0 ——
 *   **负向串当前完全不起作用，正向骨架才是唯一杠杆**。
 *   `dropNeg` 字段**保留、不删**：它是文档，将来若走 B 路（抬 cfg 让负向真生效）要用。
 *   实测（同 seed 三张，厚涂）：A 骨架+全负向 vs B 骨架+删词后 → 逐像素平均差 0.00；
 *   A vs C 无骨架+删词后 → 平均差 55.58、最大差 242。复现：_studio_preview/probe_ab_negative.mjs。
 *
 * ── 两层分类 + 筛选 ──────────────────────────────────────────────
 *   第一层 `cat`  大类：媒介与技法 / 光影与氛围 / 流派与年代 / 题材与版式 / 交付与用途
 *   第二层 `sub`  子类：大类内的分组（如 媒介 → 手绘 / 数字 / 传统）
 *   筛选 `tags`   跨类维度：强度 strength / 贴合 fit / 色相 tone / 额外节点 need / 把握 confidence
 *   外加 `status` 状态 —— 界面靠它决定「能不能拿出去见人」。
 *
 * ── 状态 ────────────────────────────────────────────────────────
 *   verified  已实测，有样图可看
 *   candidate 机制推演过，未实跑 —— **还没人看过画出来什么样**
 *   blocked   骨架未写、或已判定做不出 —— 选它等于选默认（不许假装它是新风格）
 *   baseline  对照组
 *   pending   条目录进去了，但**删词与骨架还没填**（等丹青）——不许当成品用
 *
 * ⚠️ 除 `default` 一行外，**全表零实测**。样图落在 `styles/<id>.<n>.png`。
 */

import { DEFAULT_NEGATIVE } from "./graph.mjs";

/** 默认负向串拆成词表（解算按词删，不做字符串替换） */
export const NEG_WORDS = DEFAULT_NEGATIVE.split("，").map((w) => w.trim()).filter(Boolean);

/* ── 第一层：大类 ─────────────────────────────────────────────────── */

export const CATS = [
  { id: "medium", name: "媒介与技法", hint: "用什么画的：笔、颜料、材料" },
  { id: "light", name: "光影与氛围", hint: "光怎么打、空气是什么味道" },
  { id: "school", name: "流派与年代", hint: "哪一代人的味道" },
  { id: "subject", name: "题材与版式", hint: "画什么、怎么摆" },
  { id: "delivery", name: "交付与用途", hint: "给谁用：头像、封面、贴图" },
];

/* ── 第二层：子类 ─────────────────────────────────────────────────── */

export const SUBS = {
  medium: ["手绘", "数字", "传统工艺"],
  light: ["自然光", "人造光", "色调与质感"],
  school: ["动画史", "设计运动", "东方", "绘画流派"],
  subject: ["人物与场景", "构图"],   // 「文字与版式」2026-10-13 下线：它的三条（poem/seal/poster）已删
  delivery: ["社交向", "页面向"],
};

/* ── 筛选维度（跨类） ─────────────────────────────────────────────── */

export const FILTERS = [
  { key: "strength", name: "改动幅度", values: ["轻", "中", "重"] },
  { key: "fit", name: "贴合度", values: ["高", "中", "低"] },
  { key: "tone", name: "色相", values: ["暖", "冷", "中性"] },
  { key: "need", name: "额外节点", values: ["无", "需要"] },
  { key: "confidence", name: "把握", values: ["高", "中", "低"] },
  // ⚠️ 「状态」这一维有两套口径，都留着：
  //    ① 这里（管线侧）= raw enum（verified/candidate/blocked/pending/baseline），
  //       由 taxonomy().filters.status 计数；
  //    ② 界面侧另行派生一套中文词表（有样图/待跑样图/已验证/已判死/对照基线，判据含“有没有样图”）。
  //    两套口径不同、各有用途 —— 后来者别再照着这里再派一遍。
  { key: "status", name: "状态", values: ["verified", "candidate", "blocked", "pending", "baseline"] },
];

/* ── 配方表 ─────────────────────────────────────────────────────────
 * 字段：id / name / cat / sub / tags / dropNeg / posSuffix / status / note / batch(可选，老的跑图批次)
 *      / semi(可选，数组，元素取 POSTPROCESS 里的 id —— 这条「提示词只做了一半、另一半得靠后处理」，
 *        顺序按实际执行顺序；stylesForUi() 原样透传，界面只读这一项，渲染成「半后处理 · 还差：…」。
 *        缺的是哪一步、用哪个脚本，写在自己的 note 末尾。)
 * default 实测；其余所有条目已由管线侧填上「正向骨架」（A 路：骨架是唯一杠杆），状态 candidate（未实跑）；
 * `dropNeg` 全表保留但**当前不生效**（cfg 1.0 下负向被乘 0），只作记录 —— 将来走 B 路再用。
 * 2026-10-13：**已删三条**（竖排诗笺 poem / 题款印章 seal / 字体海报 poster）。
 *   它们是本表唯一被「判死」的条目，理由不是难，是**结构性**：三条的成立要件都是
 *   「可读的字」（符号属性），而骨架是视觉层、本栈对字形零控制（icon「无文字」、
 *   cover「后置排版」都是回避写字的做法）。东篱听完理由后决定「直接删除」而不是留在表里当死条。
 *   哪个字怎么想将来要翻案：跑一张「提示词里写明文字」的探针；三条原来的 note 全文在
 *   `styles.mjs.bak-20261013-删判死三条` 里。
 * ------------------------------------------------------------------ */

const S = (id, name, cat, sub, tags, extra = {}) => ({ id, name, cat, sub, tags, dropNeg: [], posSuffix: "", status: "pending", note: "", ...extra });

export const STYLES = [
  /* ── 基准 ──────────────────────────────────────────────────────── */
  {
    id: "default", name: "默认 · 平涂色块硬边", cat: "medium", sub: "数字",
    tags: { strength: "轻", fit: "高", tone: "中性", need: "无", confidence: "高" },
    status: "verified", batch: 0, posSuffix: "", dropNeg: [],
    note: "现行串原样（无骨架、不改负向）。R1 不挂 / R2 挂 3.1 都测过。唯一可以写死进任何地方的一条。",
  },
  {
    id: "flat", name: "平涂基线（对照）", cat: "medium", sub: "数字",
    tags: { strength: "轻", fit: "高", tone: "中性", need: "无", confidence: "高" },
    status: "baseline", batch: 2, posSuffix: "", dropNeg: [],
    note: "第 2 批的对照组 = 默认那套（无骨架、无删词）。A 路下与 default 等价；保留作历史对照。",
  },

  /* ── 大类 1 · 媒介与技法（21） ─────────────────────────────────── */
  { id: "lineart", name: "白描", cat: "medium", sub: "手绘", tags: { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, status: "candidate", batch: 2, dropNeg: [], posSuffix: "白描，细匀墨线勾形，几乎不上色，只在暗处施一层淡墨，线条走向清楚，纸面留白", note: "2026-10-21 重写：原名「线稿」，骨架要「无填充色块」—— 模型总会留一层淡调，过审判了「不像」。改成中式白描：**允许淡墨**，只要求线是主角。骨架是唯一杠杆。" },
  S("pencil", "铅笔素描", "medium", "手绘", { strength: "中", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变"], posSuffix: "铅笔素描，石墨排线，笔触可见，纸面颗粒", note: "A 路：骨架＝铅笔素描/石墨排线/纸面颗粒（唯一杠杆）。删词仅记录。把握：中，未测。" }),
  S("charcoal", "炭笔", "medium", "手绘", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变", "抗锯齿"], posSuffix: "炭笔，粗颗粒，浓淡晕染，深黑，纸面粗糙", note: "A 路：骨架＝炭笔/粗颗粒/浓淡晕染/纸面粗糙。删词仅记录。把握：低 —— 颗粒会不会被读成噪点没底，实跑看。" }),
  S("pen", "钢笔速写", "medium", "手绘", { strength: "中", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变"], posSuffix: "钢笔速写，墨线勾勒，线条锐利，排线，黑白", note: "A 路：骨架＝钢笔速写/墨线勾勒/线条锐利/排线。删词仅记录。把握：中，与线稿同族。" }),
  S("ink", "水墨写意", "medium", "传统工艺", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", batch: 3, dropNeg: [], posSuffix: "水墨写意，湿墨晕染，浓淡分明，墨色边缘自然渗开，宣纸纤维可见，大片留白", note: "2026-10-21 重写：原名「水墨」，骨架要「飞白」—— 那是笔毫的物理轨迹，提示词给不了，过审判了「不像」。删掉飞白，只留模型真能给的三件（晕染/浓淡/渗开）。" }),
  S("wc", "水彩", "medium", "传统工艺", { strength: "重", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", batch: 3, dropNeg: ["水彩", "厚涂", "扁平矢量", "光滑渐变"], posSuffix: "水彩，湿画晕染，颜料透明叠色，边缘自然渗开，纸纹可见，浅淡透亮", note: "A 路：骨架＝水彩/湿画晕染/透明叠色/纸纹可见。删词仅记录。把握：中。" }),
  S("oil", "油画", "medium", "传统工艺", { strength: "重", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", batch: 3, dropNeg: ["油画", "厚涂", "扁平矢量", "光滑渐变", "3D渲染"], posSuffix: "油画，油彩堆叠，笔触厚重可见，颜料肌理，层次丰富，画布质感", note: "A 路：骨架＝油画/油彩堆叠/笔触厚重/画布质感。删词仅记录。把握：中。" }),
  S("impasto", "厚涂", "medium", "传统工艺", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["厚涂", "扁平矢量", "光滑渐变"], posSuffix: "厚涂，颜料堆叠，笔触肌理明显，油彩质感", note: "A 路：骨架＝厚涂/颜料堆叠/笔触肌理/油彩质感（唯一杠杆）。删词仅记录，cfg 1.0 下不起作用。把握：中。" }),
  S("cel", "赛璐璐", "medium", "数字", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", batch: 3, dropNeg: ["赛璐璐", "插画感", "网点"], posSuffix: "赛璐璐上色，平涂色块，硬边阴影，双层明暗，清晰线稿，限定色板", note: "A 路：骨架＝赛璐璐/平涂色块/硬边阴影/限定色板。删词仅记录。把握：中。" }),
  S("comic", "漫画", "medium", "数字", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", batch: 3, dropNeg: ["网点"], posSuffix: "漫画，网点阴影，黑白线条，粗细线区分，速度线，分镜感", note: "A 路：骨架＝漫画/网点阴影/黑白线条/速度线。删词仅记录。把握：中。" }),
  S("papercut", "纸片拼贴", "medium", "传统工艺", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "低" }, { status: "candidate", batch: 2, dropNeg: [], posSuffix: "纸艺拼贴，硬边色块层层叠压，能看见纸的厚度与投影，单色或双色，边缘裁切整齐", note: "2026-10-21 重写：原名「剪纸」，骨架要「镂空」—— 镂空是 alpha 透明度，属合成层，不是画面内容，过审判了「不像」。改成层叠纸片：把能给的（硬边/厚度/投影）要足。⚠ 当前这张样图仍偏 low-poly、右侧有零散白点，下一版试着改「画面里没有碎点」。" }),
  S("collage", "拼贴", "medium", "传统工艺", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量"], posSuffix: "拼贴，剪切纸片分层，硬边，混合材质，拼合缝", note: "A 路：骨架＝拼贴/剪切纸片分层/硬边/混合材质。删词仅记录。把握：低 —— 拼贴近合成，提示词只做得出「拼贴感」。" }),
  S("crayon", "蜡笔", "medium", "手绘", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变", "抗锯齿"], posSuffix: "蜡笔，蜡质笔触，颗粒，纸面留白，色块粗放", note: "A 路：骨架＝蜡笔/蜡质笔触/颗粒/纸面留白。删词仅记录。把握：中，与炭笔同族。" }),
  S("pastel", "粉彩", "medium", "手绘", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变", "抗锯齿"], posSuffix: "粉彩，粉质笔触，柔和晕染，纸面颗粒", note: "A 路：骨架＝粉彩/粉质笔触/柔和晕染/纸面颗粒。删词仅记录。把握：中，与炭笔/蜡笔同族。" }),
  S("marker", "马克笔", "medium", "手绘", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量"], posSuffix: "马克笔，平头笔触，色块叠加，边缘硬，叠色透光", note: "A 路：骨架＝马克笔/平头笔触/色块叠加/边缘硬/叠色透光。删词仅记录。把握：中。" }),
  S("woodblock", "木刻版画", "medium", "传统工艺", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变", "网点"], posSuffix: "木刻版画，刀刻线条，黑白高对比，刀痕粗犷，油墨压痕", note: "A 路：骨架＝木刻版画/刀刻线条/黑白高对比/油墨压痕。删词仅记录。把握：低。" }),
  S("ukiyoe", "浮世绘套色", "medium", "传统工艺", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", batch: 2, dropNeg: [], posSuffix: "浮世绘木版画，平涂色块，墨线勾边，色版轻微错位，装饰纹样，留白构图", note: "2026-10-21 重写：原名「浮世绘」，过审判了「说不好」。木版画真正的胎记是**套色错位**与墨线勾边——写上它比写「木版套色」这种名词管用；新样图里模型自己盖了个红印。" }),
  S("real", "写实", "medium", "数字", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", batch: 4, dropNeg: ["写实", "摄影", "3D渲染", "AI感", "光滑渐变", "扁平矢量"], posSuffix: "写实，真实材质，细腻光影，自然肤色，照片级细节，浅景深", note: "A 路：骨架＝写实/真实材质/细腻光影/照片级细节。删词仅记录。把握：低 —— 有硬上限（模型底子是插画向）。" }),

  S("inkdraw", "墨线淡彩", "medium", "手绘", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "墨线勾形后施透明淡彩，颜色不盖住线，色调清透，留白多，干净边缘", note: "2026-10-21 新增。它站在「白描」与「水彩」之间 —— 模型对那两头都还行，中间这条最可能稳。⚠ 首版样图偏淡（几乎是白描+一点点色），下一版把「淡彩覆盖画面一半以上、颜色比线稿明显」写进去再试。" }),

  /* ── 大类 2 · 光影与氛围（13） ─────────────────────────────────── */
  S("monet", "印象派笔触", "school", "绘画流派", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", batch: 4, dropNeg: [], posSuffix: "短促破碎的笔触，颜料堆叠可见，光被分解成相邻的小色点，轮廓溶解在光色里，户外空气感", note: "2026-10-21 重写：原名「莫奈 · 印象派」，过审判了「说不好」—— 「朦胧」容易被读成糊。这版把笔触写实、把「溶解」写在**轮廓**上而不是整体。归类仍是流派与年代·绘画流派。" }),
  S("backlight", "逆光", "light", "自然光", { strength: "中", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "光滑渐变"], posSuffix: "逆光，轮廓光只在外沿，主体保留暗部细节与色彩，不压成剪影，空气透亮，光晕", note: "已按 A 路重写，待重跑：旧骨架「主体压暗」把主体压成纯剪影、暗部信息全丢；改为保留暗部细节与色彩、轮廓光只在外沿。骨架是唯一杠杆。" }),
  S("silhouette", "剪影", "light", "自然光", { strength: "重", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变"], posSuffix: "剪影，纯黑主体，高对比逆光，明亮背景，无内部细节", note: "A 路：骨架＝剪影/纯黑主体/高对比逆光/无内部细节。删词仅记录。把握：中。" }),
  S("neon", "霓虹", "light", "人造光", { strength: "重", fit: "低", tone: "冷", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光"], posSuffix: "霓虹，发光灯管，高饱和光色，暗背景，湿面反光", note: "A 路：骨架＝霓虹/发光灯管/高饱和光色/湿面反光。删词仅记录。把握：低。" }),
  S("golden", "黄昏 · 金色时刻", "light", "自然光", { strength: "中", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "光滑渐变"], posSuffix: "黄昏，金色时刻，暖调侧光，长阴影，暖雾薄光", note: "A 路：骨架＝黄昏/金色时刻/暖调侧光/长阴影/暖雾薄光。删词仅记录。把握：中。" }),
  S("rainynight", "雨夜", "light", "自然光", { strength: "重", fit: "中", tone: "冷", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "模糊", "景深虚化"], posSuffix: "雨夜，雨丝，湿润地面反光，路灯晕光，冷蓝调", note: "A 路：骨架＝雨夜/雨丝/湿润地面反光/路灯晕光/冷蓝调。删词仅记录。把握：中 —— 过糊风险高。" }),
  S("snownight", "雪夜", "light", "自然光", { strength: "重", fit: "中", tone: "冷", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "景深虚化"], posSuffix: "雪夜，飘雪，雪地反光，冷蓝月光，雾霭", note: "A 路：骨架＝雪夜/飘雪/雪地反光/冷蓝月光/雾霭。删词仅记录。把握：中。" }),
  S("mist", "晨雾", "light", "自然光", { strength: "中", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "模糊", "景深虚化"], posSuffix: "晨雾，晨光侧逆穿入，暖灰调，近景清晰，远景化开，光有方向，层次递减", note: "已按 A 路重写，待重跑：旧骨架的「低饱和冷调」与暖褐体系冲突、雾无方向；改为暖灰调＋晨光侧逆＋近实远虚（tags.tone 同步改暖）。骨架是唯一杠杆。" }),
  S("candle", "烛光", "light", "人造光", { strength: "重", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "景深虚化"], posSuffix: "烛光，暖黄光源，明暗强对比，光晕，暗部深", note: "A 路：骨架＝烛光/暖黄光源/明暗强对比/光晕/暗部深。删词仅记录。把握：中。" }),
  S("moonlight", "月光", "light", "自然光", { strength: "重", fit: "中", tone: "冷", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "景深虚化"], posSuffix: "月光，冷银调，夜雾，明暗对比，清冷柔光", note: "A 路：骨架＝月光/冷银调/夜雾/明暗对比/清冷柔光。删词仅记录。把握：中，与烛光镜像（冷/暖）。" }),
  S("vaporwave", "蒸汽波", "light", "色调与质感", { strength: "重", fit: "低", tone: "冷", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变", "3D渲染"], semi: ["palette"], posSuffix: "蒸汽波，粉紫渐变，霓虹网格，罗马雕塑，90年代数码怀旧", note: "A 路：骨架＝蒸汽波/粉紫渐变/霓虹网格/罗马雕塑。删词仅记录。把握：低 —— 元素堆叠＋色板，给的是「像」不是「是」；色板本身更该走 palette_lock（见 POSTPROCESS）。半后处理：还差色板锁死（palette_lock.py）—— 粉紫青那套锁死，骨架只给「像」。" }),
  S("filmgrain", "胶片颗粒", "light", "色调与质感", { strength: "轻", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["写实", "摄影", "噪点", "杂色"], semi: ["grain"], posSuffix: "35mm 胶片颗粒，颗粒细密均匀，轻微暗角，色调偏移，低对比", note: "已按 A 路重写，待重跑：颗粒写细（35mm/细密均匀/暗角/色调偏移）；真颗粒建议走后处理叠一层（脚本待写）。骨架是唯一杠杆。半后处理：还差叠颗粒（grain）—— POSTPROCESS 里已立此条，脚本还没有；提示词写 dithering 会招来满屏噪点（踩过），别试。" }),
  S("noir", "纯黑白", "light", "色调与质感", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], semi: ["palette"], posSuffix: "纯黑白，中间灰极少，硬光把画面切成明暗两半，深黑阴影，画面里没有任何彩色", note: "2026-10-21 重写：原名「高对比黑白」，过审判了「说不好」。这版把「不许有彩色」直接写进骨架、把灰阶压到最少；新样图确实读成了黑白。semi 仍保留（锁灰阶色板）—— 换个提示词仍可能漏色，保守标着。" }),

  S("cream", "暖褐奶油白", "light", "色调与质感", { strength: "轻", fit: "高", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "暖褐与奶油白为主的低饱和配色，淡粉点缀，光线柔和，干净边缘，大量留白", note: "2026-10-21 新增。主色取自东篱反复在用的那套（暖褐 / 奶油白 / 淡粉）。注：内置样图那一批里它的底句单独换成暖场景（「窗外的雨」是冷调，会和这条配色打架）。" }),

  /* ── 大类 3 · 流派与年代（11） ─────────────────────────────────── */
  S("showa", "昭和动画", "school", "动画史", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量", "赛璐璐", "3D渲染"], posSuffix: "昭和动画，复古赛璐璐，有限色板，手绘线条，轻微颗粒", note: "A 路：骨架＝昭和动画/复古赛璐璐/有限色板/手绘线条。删词仅记录。把握：中，与「赛璐璐」同族。" }),
  S("retro80", "80s 复古", "school", "动画史", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量", "3D渲染", "柔光"], posSuffix: "80年代复古，霓虹色，赛璐璐动画，颗粒感，合成器浪潮", note: "A 路：骨架＝80年代复古/霓虹色/赛璐璐动画/合成器浪潮。删词仅记录。把握：中。" }),
  S("anime90", "90s 赛璐璐动画", "school", "动画史", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量", "赛璐璐", "网点"], posSuffix: "90年代赛璐璐动画，手绘线条，限定色，柔和阴影，轻微噪点", note: "A 路：骨架＝90年代赛璐璐动画/手绘线条/限定色/柔和阴影。删词仅记录。把握：中。" }),
  S("y2k", "Y2K", "school", "设计运动", { strength: "重", fit: "低", tone: "冷", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "3D渲染", "光滑渐变"], semi: ["palette"], posSuffix: "Y2K，金属质感，铬色渐变，数码未来感，高光", note: "A 路：骨架＝Y2K/金属质感/铬色渐变/数码未来感。删词仅记录。把握：低 —— 元素堆叠＋色板，给「像」不是「是」。半后处理：还差色板锁死（palette_lock.py）—— 铬色/金属那套色板锁死。" }),
  S("nouveau", "新艺术", "school", "设计运动", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "网点"], posSuffix: "新艺术运动，蜿蜒藤蔓线条，装饰边框，平涂色块，金色描线", note: "A 路：骨架＝新艺术运动/蜿蜒藤蔓线条/装饰边框/金色描线。删词仅记录。把握：低。" }),
  S("deco", "装饰艺术", "school", "设计运动", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "网点"], posSuffix: "装饰艺术，几何对称，金属线条，放射纹样，奢华平面", note: "A 路：骨架＝装饰艺术/几何对称/金属线条/放射纹样。删词仅记录。把握：低，与新艺术同族（几何 vs 曲线）。" }),
  S("bauhaus", "包豪斯", "school", "设计运动", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量"], posSuffix: "包豪斯，几何基本形，红黄蓝三色，无衬线排版，功能主义平面", note: "A 路：骨架＝包豪斯/几何基本形/红黄蓝三色/无衬线排版。删词仅记录。把握：低 —— 三色板属色彩约束，骨架不一定镇得住。" }),
  S("rococo", "洛可可", "school", "设计运动", { strength: "重", fit: "低", tone: "暖", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "柔光"], posSuffix: "洛可可，繁复装饰，粉彩色调，金箔描边，柔和卷曲纹样", note: "A 路：骨架＝洛可可/繁复装饰/粉彩色调/金箔描边/柔和卷曲纹样。删词仅记录。把握：低。" }),
  S("song", "宋画", "school", "东方", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变", "抗锯齿"], posSuffix: "宋画，绢本设色，淡墨晕染，留白，细腻笔意，古朴", note: "A 路：骨架＝宋画/绢本设色/淡墨晕染/留白/细腻笔意。删词仅记录。把握：低 —— 「淡雅」很靠骨架，吃不吃得住要实跑。" }),
  S("constructivism", "构成主义", "school", "设计运动", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量"], posSuffix: "构成主义，斜向构图，红黑几何，粗排版，工业感平面", note: "A 路：骨架＝构成主义/斜向构图/红黑几何/粗排版。删词仅记录。把握：低 —— 和包豪斯撞脸，靠色彩与构图区分。" }),

  /* ── 大类 4 · 题材与版式（9） ─────────────────────────────────────
     原 12 条，2026-10-13 删了三条（poem / seal / poster）—— 见文件头那段。
     子类「文字与版式」随之下线（那三条是它全部成员）。 */
  S("tachie", "角色立绘", "subject", "人物与场景", { strength: "轻", fit: "高", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "角色立绘，全身或半身，正面，干净背景，站姿", note: "A 路：骨架＝角色立绘/全身或半身/正面/干净背景（唯一杠杆）。删词仅记录。把握：中。" }),
  S("scene", "场景插画", "subject", "人物与场景", { strength: "轻", fit: "高", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "场景插画，广角，环境叙事，层次分明，氛围光", note: "A 路：骨架＝场景插画/广角/环境叙事/层次分明/氛围光。删词仅记录。把握：中。" }),
  S("food", "食物特写", "subject", "人物与场景", { strength: "轻", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["柔光", "景深虚化"], posSuffix: "食物特写，俯拍或 45 度，浅景深，热气油光，暖调", note: "A 路：骨架＝食物特写/俯拍或 45 度/浅景深/热气油光/暖调。删词仅记录。把握：中。" }),
  S("facade", "建筑立面", "subject", "人物与场景", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "建筑立面，正视平拍，对称，几何线条，结构清晰", note: "A 路：骨架＝建筑立面/正视平拍/对称/几何线条/结构清晰。删词仅记录。把握：中。" }),
  S("mecha", "机械设定", "subject", "人物与场景", { strength: "中", fit: "中", tone: "冷", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "插画感"], posSuffix: "机械设定，三视图，线条稿，金属分件，冷色调", note: "A 路：骨架＝机械设定/三视图/线条稿/金属分件/冷色调。删词仅记录。把握：低 —— 细节能不能立住要实跑。" }),
  S("whitespace", "留白版式", "subject", "构图", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量"], posSuffix: "大量留白，极简构图，主体偏置，负空间，干净背景", note: "A 路：骨架＝大量留白/极简构图/主体偏置/负空间。删词仅记录。把握：中。" }),
  S("symmetry", "对称构图", "subject", "构图", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "绝对对称，居中构图，镜像，轴线平衡", note: "A 路：骨架＝绝对对称/居中构图/镜像/轴线平衡。删词仅记录。把握：中。" }),
  S("closeup", "特写大头", "subject", "构图", { strength: "轻", fit: "高", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["景深虚化"], posSuffix: "面部特写，大头，占满画面，背景虚化或极简", note: "A 路：骨架＝面部特写/大头/占满画面/背景虚化或极简。删词仅记录。把握：中。" }),
  S("birdseye", "俯视", "subject", "构图", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "俯视角度，鸟瞰，垂直向下，平面化构图", note: "A 路：骨架＝俯视角度/鸟瞰/垂直向下/平面化构图。删词仅记录。把握：中。" }),

  /* ── 大类 5 · 交付与用途（8） ──────────────────────────────────── */
  S("avatar", "头像", "delivery", "社交向", { strength: "轻", fit: "高", tone: "中性", need: "无", confidence: "高" }, { status: "candidate", dropNeg: [], posSuffix: "在画面中截取主体头部特写，方形构图，正面居中，肩部以上，主体放大占满画幅，背景简化", note: "已按 A 路重写，待重跑：旧骨架与基准提示词的场景（木桌/茶杯/窗外雨）对撞、骨架没生效；改为在场景内截取头部特写＋主体占满画幅。骨架是唯一杠杆。" }),
  S("sticker", "表情包", "delivery", "社交向", { strength: "中", fit: "中", tone: "暖", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量", "抗锯齿"], semi: ["outline"], posSuffix: "Q版表情，粗描边（均匀 3–5px），平涂色块，夸张表情，奶油白或暖褐色纯色底，主体居中，四边留白充足", note: "已按 A 路重写，待重跑：旧骨架「纯色背景」没点颜色、模型自挑满血红、构图顶边；改为点名底色（奶油白/暖褐）＋四边留白＋描边粗细（tags.tone 同步改暖）。透明底属后处理（抠图），不在提示词。半后处理：还差抠透明底＋描边 —— 走 outline.py（从 alpha 算轮廓）。" }),
  S("icon", "图标", "delivery", "页面向", { strength: "重", fit: "低", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: ["扁平矢量", "光滑渐变", "3D渲染"], semi: ["upscale"], posSuffix: "图标，极简，单色或双色，居中，圆角方底，无文字", note: "A 路：骨架＝图标/极简/单色或双色/圆角方底/无文字。删词仅记录。把握：低 —— 半后处理，要「干净可缩放」还得矢量描摹/放大，小尺寸常糊。半后处理：还差放大精修（两段链）—— 提示词给不出可缩放性，小尺寸要清晰得先放大再缩；矢量描摹那步本栈没有脚本。" }),
  S("cover", "封面", "delivery", "页面向", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "封面构图，竖版，上半留白放标题，视觉主体居中偏下", note: "A 路：骨架＝封面构图/竖版/上半留白放标题/主体居中偏下。删词仅记录。把握：中 —— 标题文字模型写不好，应后置排版。" }),
  S("cardface", "卡面", "delivery", "页面向", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], posSuffix: "卡面构图，竖版边框，主体居中，上下留出信息条", note: "A 路：骨架＝卡面构图/竖版边框/主体居中/上下留信息条。删词仅记录。把握：中。" }),
  S("chatsticker", "聊天贴图", "delivery", "社交向", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: ["扁平矢量", "抗锯齿"], semi: ["outline"], posSuffix: "聊天贴图，Q版，粗描边，纯色背景，留白边距", note: "A 路：骨架＝聊天贴图/Q版/粗描边/纯色背景/留白边距。删词仅记录。把握：中，与「表情包」同一套骨架、弱一点。半后处理：还差抠透明底＋描边 —— 走 outline.py（从 alpha 算轮廓），同「表情包」。" }),
  S("thumb", "缩略图", "delivery", "页面向", { strength: "轻", fit: "中", tone: "中性", need: "无", confidence: "中" }, { status: "candidate", dropNeg: [], semi: ["upscale"], posSuffix: "缩略图，主体居中放大，强对比，元素少，远看可辨", note: "A 路：骨架＝缩略图/主体居中放大/强对比/元素少。删词仅记录。把握：低 —— 它是尺寸/可读性问题，真实可读性得缩图后看。半后处理：还差放大精修（两段链）—— 成品是缩出来的，底子先放大再缩才不糊；缩图那一步不在 POSTPROCESS 四词里。" }),
  S("standee", "立牌", "delivery", "社交向", { strength: "中", fit: "中", tone: "中性", need: "无", confidence: "低" }, { status: "candidate", dropNeg: [], semi: ["outline"], posSuffix: "角色立绘，全身站姿，正侧面对镜头，纯色或透明背景", note: "A 路：骨架＝角色立绘/全身站姿/正侧面对镜头/纯色或透明背景。删词仅记录。把握：低 —— 半后处理：立牌＝立绘＋透明底＋物理呈现，提示词只做前半。还差哪一步：抠透明底（alpha → outline.py）；物理呈现（底座/投影）本栈没有脚本。" }),
];

/* ── 不走提示词的（不进配方表，但必须写下来免得被误当成一条风格） ─────
   这套栈里「像素风」那类质感**不是模型给的，是后处理给的** ——
   像素化 / 色板锁死 / 描边 / 放大精修都在管线后处理里，不在提示词里。
   谁把它们当配方加进来，谁就会得到一张"隔着纱窗看照片"。 */

export const POSTPROCESS = [
  { id: "pixelate", name: "像素化（网格）", tool: "pixelate.py", note: "网格甜区 480–600；360 会糊脸、720 失去颗粒" },
  { id: "palette", name: "色板锁死", tool: "palette_lock.py", note: "48 色平衡最好；16 色会把色阶砍太多" },
  { id: "outline", name: "描边", tool: "outline.py", note: "要从 alpha 算轮廓补，顺序在像素化之前" },
  { id: "upscale", name: "放大精修", tool: "两段链", note: "LatentUpscale 的宽高是潜空间值不是像素" },
  // tool: null 是有意的，不是漏填 —— 界面会显示「叠颗粒（还没有脚本）」，缺口自己会说话。
  { id: "grain", name: "叠颗粒", tool: null,
    note: "脚本还没有 —— 提示词里写 dithering 会招来满屏噪点（踩过）；这一步要单独写一个叠颗粒脚本" },
];

/* ── 解算 ─────────────────────────────────────────────────────────── */

export function resolveStyle(styleId, prompt, negativeOverride = "") {
  const s = styleById(styleId);
  const base = String(prompt || "").trim();
  if (!base) throw new Error("提示词是空的");

  if (negativeOverride && negativeOverride.trim()) {
    return { positive: base, negative: negativeOverride.trim(), styleId: s.id, note: "负向词被高级区 override 了" };
  }
  if (s.status === "blocked") {
    return { positive: base, negative: DEFAULT_NEGATIVE, styleId: s.id, note: `${s.name} 未实测（骨架未写或已判死），按默认串跑` };
  }
  if (s.status === "pending") {
    // 删词/骨架还没填 —— 不许假装它已经是一条配方
    return { positive: base, negative: DEFAULT_NEGATIVE, styleId: s.id, note: `${s.name} 的删词与骨架还没填，按默认串跑（等于没换风格）` };
  }
  const drop = new Set(s.dropNeg || []);
  const kept = NEG_WORDS.filter((w) => !drop.has(w));
  const positive = s.posSuffix ? `${base}，${s.posSuffix}` : base;
  return {
    positive,
    negative: kept.join("，"),
    styleId: s.id,
    note: s.status === "verified" ? null : `${s.name} 未实测，骨架是唯一杠杆（cfg 1.0 下负向不生效）`,
  };
}

export function styleById(id) {
  return STYLES.find((s) => s.id === id) || STYLES[0];
}

/** 给界面看的表：分类、标签、状态、以及"解算后会变成什么样"的预览 */
export function stylesForUi() {
  return STYLES.map((s) => {
    const drop = s.dropNeg || [];
    return {
      id: s.id, name: s.name,
      cat: s.cat, catName: (CATS.find((c) => c.id === s.cat) || {}).name || s.cat,
      sub: s.sub || "",
      tags: s.tags || {},
      status: s.status,
      dropNeg: drop,
      semi: s.semi || [],
      posSuffix: s.posSuffix || "",
      keepNeg: s.status === "pending" || s.status === "blocked" ? NEG_WORDS.length : NEG_WORDS.length - drop.length,
      note: s.note || "",
    };
  });
}

/** 分类树 + 计数，给"大类 / 子类 / 筛选"三层界面用 */
export function taxonomy() {
  const tree = CATS.map((c) => {
    const inCat = STYLES.filter((s) => s.cat === c.id);
    return {
      id: c.id, name: c.name, hint: c.hint,
      count: inCat.length,
      subs: (SUBS[c.id] || []).map((sub) => ({ name: sub, count: inCat.filter((s) => s.sub === sub).length })),
    };
  });
  const byTag = {};
  for (const f of FILTERS) {
    // 订正（2026-10-13）：状态那一维原先按 s.tags.status 数 —— status 不在 tags 里，恒为 0。
    // 它取的是顶层 s.status（raw enum），不是 tags 里的键，所以单开一支。
    // 口径说明见 FILTERS 里 status 那条：这里是 raw enum 计数，界面另有一套派生词表，别混。
    byTag[f.key] = f.values.map((v) => ({
      value: v,
      count: STYLES.filter((s) => (f.key === "status" ? s.status : (s.tags || {})[f.key]) === v).length,
    }));
  }
  const status = {};
  for (const s of STYLES) status[s.status] = (status[s.status] || 0) + 1;
  return { total: STYLES.length, cats: tree, filters: byTag, status, postprocess: POSTPROCESS };
}

/** 老的"按批跑样图"仍然要能用 */
export function batches() {
  const out = {};
  for (const s of STYLES) {
    if (!s.batch || s.status === "baseline" || s.status === "pending") continue;
    (out[s.batch] ||= []).push(s.id);
  }
  return out;
}
