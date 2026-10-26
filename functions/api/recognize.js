// Cloudflare Pages Function: /api/recognize
// 接收 base64 图片，调用智谱视觉模型识别课表，返回结构化课程数组
//
// 三路定位 + 双遍核对（针对「整列被识别到后一天」）：
//   让模型对每一门课给出三个彼此独立的坐标读数，服务端再投票：
//     ① colDate —— 该列顶部印的日期数字（如 "28"），与表头日期序列做字符串匹配得到列号
//     ② dayChar —— 该列顶部印的星期汉字（如 "三"），直接查表得到列号
//     ③ day     —— 模型自己数出来的列号（不主动要求，模型自愿给才用）
//   这三者中任意一个出错的方式不同（数格子 / 转数字 / 对齐表头），投票能纠正个别偏差；
//   三者不一致时给 dayConflict=true，前端把该行标黄，让用户只复核这些行。
//
//   第 2 遍：把原图和第一遍结果一起再问一次，只核对星期列与 rows 行数，条数不符则丢弃。

const MODELS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];
const API = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const PROMPT_MAIN = `这是一张中国大学的周课表截图。请先抄表头，再逐个找彩色课块。只输出一个 JSON 对象。

【第一步：抄表头】
- 表头有两行：一行是 7 个星期汉字（一 二 三 四 五 六 日），一行是 7 个日期数字（26、27… 或 10/26、10/27…）。
  不同 App 里这两行谁上谁下不一定，按你实际看到的写，不要脑补。
  请把日期那一行的 7 个数字原样照抄成字符串数组 headerDates，例如 ["26","27","28","29","30","31","1"]；
  写成 10/26 的就照抄成 "10/26"。某个列没有日期就写 ""。必须凑齐 7 项，顺序不能乱，也不要漏掉最后一列。
- 日期和星期的对应关系就是列的对应关系（同一条竖线上的两个读数属于同一天）。

【第二步：逐个彩色课块】
每一门课都要填两个坐标读数，都要"照抄"，不许自己推算：
- colDate: 这门课所在列的顶部那个日期数字，照抄（如 "28"）。看不清就写 ""，绝对不要猜。
- dayChar: 这门课所在列顶部的星期汉字，只写一个字（一/二/三/四/五/六/日）。

定位方法：从色块的正中间垂直往上，一直看到表头，读出那一列顶上的日期和汉字。
两个坑必须避开：
- 最左边那一列写着 1节、2节…（可能还带 07:40 这类时间），那是节次列，头顶没有日期也没有星期汉字，绝不算作一列。
- 色块左边紧挨节次列的，就是第一列（周一），不要往右挪一天。
- 如果截图最左边有被裁掉一半的列，不要当成独立的一天。

【连堂色块要覆盖全部行】
一门连着上几节的课是纵向很高的色块，可能占 2、3、4 行。请贴着色块上下边缘数清它压住的行，全部写进 rows：
- 顶在 5 行、底在 8 行 → rows = [5,6,7,8]
- 晚上占 9、10、11 → [9,10,11]；只占 9、10 → [9,10]；单行 → [5]
- 色块高度是单行的几倍，rows 就该有几个数字。
- 左侧节次列有几节就是几节（有的学校 10 节、有的 11 节、有的 12 节），按实际看到的算，不要假设满 12 节。

【每门课的字段】
- name: 课程名（色块第一行文字，别混入老师、地点）
- colDate / dayChar: 见上
- rows: 该块纵向覆盖的全部行号，升序数组
- loc: 地点，「@(海甸)」后面那串教室名（"(海甸)"是校区）
- teacher: 老师，没有就空字符串
- weekStart/weekEnd/weekType: 「1-16周」→1,16,"all"；「3-8周」→3,8,"all"；含「单」→"odd"；含「双」→"even"；没写→1,16,"all"

【硬性要求】
1. 星期只靠 colDate 和 dayChar 照抄，绝不用日期去推算星期，也绝不靠数第几列。
2. 节次只认左侧行号，绝不把上课时间当节次。
3. rows 必须完整覆盖色块高度。
4. 每个有课的块都要一条；同课名在不同星期或不同节次，分别输出。
   即使两个色块课名一样、颜色一样，只要它们在图上彼此分开（中间有明显空隙），也要各自输出一条。
5. 【输出顺序很重要】必须先按色块最上面那一行的行号从小到大排；行号相同的，从左到右排（周一在左、周日在右）。这个顺序会被用来和课表版式一一对应，顺序错了整张表就会串位。
6. 只输出 JSON 对象，不要解释、不要 markdown 代码块。

格式：
{"headerDates":["26","27","28","29","30","31","1"],
 "courses":[{"name":"大学物理实验","colDate":"28","dayChar":"三","rows":[5,6,7,8],"loc":"物理实验中心-201","teacher":"","weekStart":3,"weekEnd":8,"weekType":"all"},
            {"name":"大学英语","colDate":"30","dayChar":"五","rows":[1,2],"loc":"5教-302","teacher":"","weekStart":1,"weekEnd":16,"weekType":"all"}]}`;

// raw 模式专用提示词：星期/节次前端已经用像素算出来了，这里只要"文字"
// 故意不问 rows（节次）——那是模型最容易读错、也最没必要读的东西
// expect：前端像素已经数出图上共有几个彩色色块，直接告诉模型，条数就几乎不会错
const PROMPT_RAW = (expect) => `这是一张中国大学的周课表截图。请把每个彩色课块里的课程文字读出来，只输出 JSON。
${expect > 0 ? `\n【数量】图上用像素扫描出**${expect} 个彩色色块**，所以 courses 数组必须有且只有 ${expect} 条。
注意：同一门课（课名一样、颜色一样）在同一列里上下分成两块，那是两个块，要各写一条。
输出前自己数一遍条数，不足就重新扫描补全，多了就删。\n` : ''}
【顺序很重要】按色块"最上面那一行的位置"从上到下排；高度相同的，从左到右排（周一在左、周日在右）。
这个顺序会被程序用来和图片上的色块一一对应，乱了整张表就会串位。

【不需要做的事】
- 不要数第几列、不要判断星期几（前端用像素自己算）。
- 不要判断第几节、不要统计色块高度（前端用像素自己算）。
- 不要因为"这看起来像同一门课"就合并两条。

【每个色块一条，一条都不能省】
即使两个色块课名一样、颜色一样，只要图上彼此分开（中间有空隙），就各写一条。
看不清文字的块也要写一条，name 填 "(未识别)"，绝对不能跳过。

【字段】
- name: 课程名（色块第一行文字，别混入老师、地点）
- dayChar: 该色块所在列顶部那个星期汉字，只写一个字（一/二/三/四/五/六/日）。只是照抄列头，别数第几列；看不清写 ""。
- loc: 地点，「@(海甸)」后面那串教室名（"(海甸)"是校区）
- teacher: 老师，没有就空字符串
- weekStart/weekEnd/weekType: 「1-16周」→1,16,"all"；「3-8周」→3,8,"all"；含「单」→"odd"；含「双」→"even"；没写→1,16,"all"

只输出 JSON 对象，不要解释、不要 markdown 代码块。

格式：
{"courses":[{"name":"大学物理实验","dayChar":"三","loc":"物理实验中心-201","teacher":"","weekStart":3,"weekEnd":8,"weekType":"all"},
            {"name":"大学英语","dayChar":"五","loc":"5教-302","teacher":"","weekStart":1,"weekEnd":16,"weekType":"all"}]}`;

// 条数对不上时的重扫提示词：告诉模型「应有几条 / 你给了几条」，并点出最容易漏的情形
const PROMPT_FIX = (names, expect) => `这是一张大学课表截图，图上一共有 ${expect} 个彩色色块。

上一遍只读出了 ${names.length} 条：
${JSON.stringify(names)}

数量对不上。请**从头重新扫描整张图**（不要沿用上面的答案，也不要只做增删），
按「最上面那一行从上到下排、同一高度从左到右排」的顺序重新输出，必须正好 ${expect} 条。

最容易漏掉的情形：同一门课（课名一样、颜色一样）在同一列里上下分成两块，那是两个块，必须各写一条。
看不清文字的块也要写一条，name 填 "(未识别)"，不许跳过。

字段格式同前：
{"courses":[{"name":"课程名","dayChar":"三","loc":"地点","teacher":"","weekStart":1,"weekEnd":16,"weekType":"all"}]}

只输出 JSON 对象，不要解释、不要代码块。`;

const PROMPT_VERIFY = (courses, headerDates) => `还是同一张课表截图。

表头日期（从左到右 7 列）：${JSON.stringify(headerDates && headerDates.length ? headerDates : '（请你自己重新抄一遍）')}

第一遍的识别结果：
${JSON.stringify(courses.map(c => ({
  name: c.name,
  colDate: c.colDate,
  dayChar: c.dayChar,
  rows: c.rows,
  loc: c.loc,
  weekStart: c.weekStart,
  weekEnd: c.weekEnd,
  weekType: c.weekType,
})))}

请逐条核对两件事：
（1）星期列是否错位。方法：从这门课的色块正中间垂直往上，看它所在列顶部的日期数字和星期汉字，与 colDate、dayChar 是否一致。
      注意：最左边写 1、2、3 和时间的列是节次列，不是星期一，不能算进星期列；色块紧挨节次列的就是第一列（周一）。
（2）rows 的行数是否等于色块高度。

规则：
- 没错的条目原样保留，课程名、地点、周次一个字都不许改。
- 只修明确错位的 colDate、dayChar 和 rows。
- 输出 {"headerDates":[...7项...],"courses":[...]} 完整对象，不要解释、不要代码块。`;

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const image = body.image;
    if (!image || typeof image !== 'string') {
      return json({ error: '缺少图片数据（image 字段应为 base64 dataURL）' }, 400);
    }
    const key = env.ZHIPUAI_API_KEY;
    if (!key) {
      return json({ error: '服务端未配置 ZHIPUAI_API_KEY，请在环境变量中设置' }, 500);
    }
    // raw=true：前端已用像素定位星期/节次，这里只要文字，且必须保持模型输出的原始顺序（用于按序配对）
    const wantRaw = body.raw === true;

    // ===== 第 1 遍：抽取 =====
    // raw 模式用简版提示词（只要文字），因为它不需要星期/节次，成功率高得多
    // body.expect：前端像素已数出图上色块数量，直接告诉模型，条数基本不会错
    const expect = Number(body.expect) | 0;
    const prompt1 = wantRaw ? PROMPT_RAW(expect) : PROMPT_MAIN;
    let first = null, headerDates = [], usedModel = '', lastDetail = '';
    for (const model of MODELS) {
      try {
        const payload = await callModel(model, key, prompt1, image);
        const courses = buildCourses(payload.items, payload.headerDates, { noMerge: wantRaw });
        if (courses.length) {
          first = courses;
          headerDates = payload.headerDates;
          usedModel = model;
          break;
        }
        // 把模型的原始输出带一小段回去，便于定位是"字段名不对"还是"根本没读出来"
        lastDetail = `${model} 有 JSON 但无有效课程（${payload.items.length} 条原始项）：${payload.raw.slice(0, 260)}`;
      } catch (e) {
        lastDetail = `${model} 异常: ${msgOf(e)}`;
      }
    }
    if (!first) {
      return json({ error: '识别失败：模型未返回可解析的课程数据', detail: lastDetail }, 502);
    }

    // raw 模式：像素已经数出准确条数，对不上就重扫一遍（同名同色的两块最容易漏）
    let rescanned = false;
    if (wantRaw && expect > 0 && first.length !== expect) {
      try {
        const p2 = await callModel(usedModel, key, PROMPT_FIX(first.map(c => c.name), expect), image);
        const c2 = buildCourses(p2.items, [], { noMerge: true });
        if (c2.length && Math.abs(c2.length - expect) < Math.abs(first.length - expect)) {
          first = c2;
          rescanned = true;
        }
      } catch { /* 重扫失败就用第一遍 */ }
    }

    if (wantRaw) {
      return json({
        courses: first, model: usedModel, verified: false, changed: 0, raw: true,
        expect, rescanned,
      });
    }

    // ===== 第 2 遍：核对星期与行数（失败则沿用第 1 遍）=====
    let final = first, verified = false, changed = 0;
    const order = [usedModel, ...MODELS.filter(m => m !== usedModel)];
    for (const model of order) {
      try {
        const payload = await callModel(model, key, PROMPT_VERIFY(first, headerDates), image);
        if (!payload.items.length) continue;
        const hdr = payload.headerDates.length >= 5 ? payload.headerDates : headerDates;
        const second = buildCourses(payload.items, hdr);
        if (second.length !== first.length) continue; // 条数对不上说明这遍跑偏了，不采用
        changed = countDiff(first, second);
        final = second;
        verified = true;
        break;
      } catch { /* 核对失败不影响主流程 */ }
    }

    // 仍有三路读数不一致的行 → 把候选值一起返回，前端标黄让用户只复核这些
    const conflicts = final.filter(c => c.dayConflict).length;
    return json({ courses: final, model: usedModel, verified, changed, headerDates, conflicts });
  } catch (e) {
    return json({ error: msgOf(e) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// 调一次模型，返回 { headerDates, items }
async function callModel(model, key, prompt, image) {
  const resp = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image } },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 160)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const out = extractPayload(content);
  out.raw = String(content).replace(/\s+/g, ' ').slice(0, 300);
  return out;
}

// ===== 解析模型输出：优先 {headerDates, courses} 对象，退化到纯数组 =====

function extractPayload(text) {
  const s = String(text);
  const obj = extractJsonObject(s);
  if (obj) {
    const items = firstArray(
      obj.courses || obj.blocks || obj.list || obj.data || obj['课程'] || obj['课表']
    );
    if (items && items.length) {
      return { items, headerDates: toStringArray(obj.headerDates || obj.dates || obj.header) };
    }
  }
  return { items: extractJsonArray(s) || [], headerDates: [] };
}

function firstArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) if (Array.isArray(v[k]) && v[k].length) return v[k];
  }
  return null;
}

function toStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => (x && typeof x === 'object' ? String(pick(x, ['date', 'day', 'd', 'text']) || '') : str(x)));
}

// 找出文本里第一个「含有数组字段」的 JSON 对象
function extractJsonObject(text) {
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
              if (firstArray(obj)) return obj;
            }
          } catch { /* 换下一个起点 */ }
          break;
        }
      }
    }
  }
  return null;
}

// ===== 把模型的原始输出整理成课程 =====

function buildCourses(raw, headerDates, opts) {
  const noMerge = !!(opts && opts.noMerge);
  const hdr = (headerDates || []).map(normDateNum);
  const flat = [];
  for (const item of raw || []) {
    // 模型有时直接吐 ["高数","英语"] 这种纯字符串数组
    if (typeof item === 'string') {
      const n = str(item);
      if (n) {
        flat.push({ name: n, day: 0, dayHint: 0, dayConflict: false, dayChar: '', colDate: '',
          min: 0, max: 0, loc: '', teacher: '', weekStart: 1, weekEnd: 16, weekType: 'all' });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const name = str(pick(item, ['name', '课程', '课程名', 'course', 'courseName']));
    if (!name) continue;
    const pos = resolveDay(item, hdr);
    const rows = toRows(item);
    // raw 模式：星期/节次由前端像素定位给出，模型只要读出课名就算有效
    // （以前这里强制要求 day 和 rows，模型稍有偏差整张图就一条都留不下，直接 502）
    if (!noMerge && (!pos.day || !rows.length)) continue;
    const wk = weekRange(item);
    flat.push({
      name,
      day: pos.day,
      dayHint: pos.byChar || 0,
      dayConflict: pos.conflict,
      dayChar: charName(pos.byChar),
      colDate: str(pick(item, ['colDate', 'columnDate', 'date', '日期数字'])),
      min: rows.length ? rows[0] : 0,
      max: rows.length ? rows[rows.length - 1] : 0,
      loc: str(pick(item, ['loc', 'location', '地点', '教室', 'room'])),
      teacher: str(pick(item, ['teacher', '教师', '老师'])),
      weekStart: wk.start,
      weekEnd: wk.end,
      weekType: wk.type,
    });
  }

  const shape = (c) => {
    const rows = [];
    for (let i = c.min; i <= c.max; i++) rows.push(i);
    return {
      name: c.name,
      day: c.day,
      dayHint: c.dayHint,
      dayChar: c.dayChar,
      colDate: c.colDate,
      dayConflict: c.dayConflict,
      rows,
      start: c.min,
      end: c.max,
      loc: c.loc,
      teacher: c.teacher,
      weekStart: c.weekStart,
      weekEnd: c.weekEnd,
      weekType: c.weekType,
    };
  };

  // raw 模式：保持模型输出的先后顺序，不合并不排序（前端要按顺序和像素色块一一配对）
  if (noMerge) return flat.map(shape);

  // 同一门课在同一天可能被拆成相邻两块（[5,6] + [7,8]），合并回 5-8
  const buckets = new Map();
  for (const c of flat) {
    const k = c.day + '|' + c.name;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(c);
  }

  const merged = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.min - b.min);
    let cur = null;
    for (const c of arr) {
      const canMerge = cur && c.min <= cur.max + 1 && locOk(cur.loc, c.loc);
      if (canMerge) {
        cur.max = Math.max(cur.max, c.max);
        cur.loc = cur.loc || c.loc;
        cur.teacher = cur.teacher || c.teacher;
        cur.weekStart = Math.min(cur.weekStart, c.weekStart);
        cur.weekEnd = Math.max(cur.weekEnd, c.weekEnd);
        if (cur.weekType !== c.weekType) cur.weekType = 'all';
      } else {
        if (cur) merged.push(cur);
        cur = { ...c };
      }
    }
    if (cur) merged.push(cur);
  }

  merged.sort((a, b) => a.day - b.day || a.min - b.min);
  return merged.map(shape);
}

// 三路读数投票：colDate→列号、dayChar→列号、day 数字
function resolveDay(c, hdr) {
  const colDate = normDateNum(pick(c, ['colDate', 'columnDate', 'date', '日期数字']));
  const byChar = charDay(pick(c, ['dayChar', 'dayLabel', 'weekdayChar', '星期字']));
  const byNum = toDayNum(pick(c, ['day', '星期', '周几', '星期几', 'weekday']));

  let byDate = 0;
  if (colDate && hdr.length >= 5) {
    const idx = hdr.findIndex(x => x !== null && x === colDate);
    if (idx >= 0 && idx < 7) byDate = idx + 1;
  }

  const votes = [byDate, byChar, byNum].filter(v => v >= 1 && v <= 7);
  if (!votes.length) return { day: 0, conflict: false, byChar: 0 };

  const tally = new Map();
  for (const v of votes) tally.set(v, (tally.get(v) || 0) + 1);
  let best = 0, bestCount = 0;
  for (const [v, n] of tally) if (n > bestCount) { best = v; bestCount = n; }

  const conflict = votes.length > 1 && new Set(votes).size > 1;
  // 票数打平（比如只有两路且不一致）时，优先信日期匹配，其次汉字
  if (conflict && tally.get(best) === 1) {
    best = byDate || byChar || byNum;
  }
  return { day: best, conflict, byChar };
}

// 日期串 → 日号（"10/26"→26, "26日"→26, "26"→26）
function normDateNum(v) {
  const s = str(v);
  if (!s) return null;
  const nums = s.match(/\d+/g);
  if (!nums || !nums.length) return null;
  const last = Number(nums[nums.length - 1]);
  return Number.isFinite(last) ? last : null;
}

function charName(n) {
  return ['', '一', '二', '三', '四', '五', '六', '日'][n] || '';
}

// 汉字/英文 → 1..7
function charDay(v) {
  const s = str(v);
  if (!s) return 0;
  const m = s.match(/[一二三四五六日天]/);
  if (m) return { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 }[m[0]];
  const low = s.toLowerCase();
  const en = { sun: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  for (const k of Object.keys(en)) if (low.includes(k)) return en[k];
  return 0;
}

function toDayNum(v) {
  if (typeof v === 'number' && v >= 1 && v <= 7) return v;
  const s = str(v);
  if (!s) return 0;
  const n = s.match(/\d+/);
  if (n) {
    const x = Number(n[0]);
    if (x === 0 || x === 7) return 7;
    if (x >= 1 && x <= 6) return x;
  }
  return charDay(s);
}

function toRows(c) {
  let rows = [];
  const v = pick(c, ['rows', 'row', 'periods', 'sections', 'sectionList', '节次列表', '节次']);
  if (Array.isArray(v)) {
    rows = v.map(x => toInt(x)).filter(n => n != null);
  } else if (v != null && v !== '') {
    rows = (String(v).match(/\d+/g) || []).map(Number);
  }
  if (!rows.length) {
    const s = toInt(pick(c, ['start', '开始节', '起节', 'startPeriod', 'startSlot']));
    let e = toInt(pick(c, ['end', '结束节', '止节', 'endPeriod', 'endSlot']));
    if (s != null) {
      if (e == null || e < s) e = s;
      for (let i = s; i <= e; i++) rows.push(i);
    }
  }
  return Array.from(new Set(rows.filter(n => n >= 1 && n <= 20))).sort((a, b) => a - b);
}

function weekRange(c) {
  let start = toInt(pick(c, ['weekStart', '起始周', '开始周', 'startWeek']));
  let end = toInt(pick(c, ['weekEnd', '结束周', 'stopWeek', 'endWeek']));
  if (start == null) start = 1;
  if (end == null) end = 16;

  let type = 'all';
  const wt = str(pick(c, ['weekType', '周次类型', '周类型', 'week']));
  if (/单/.test(wt) || /odd/i.test(wt)) type = 'odd';
  else if (/双/.test(wt) || /even/i.test(wt)) type = 'even';

  const weeksRaw = pick(c, ['weeks', '周次']);
  const nums = Array.isArray(weeksRaw)
    ? weeksRaw.map(Number).filter(n => Number.isFinite(n))
    : (typeof weeksRaw === 'string' ? (weeksRaw.match(/\d+/g) || []).map(Number) : []);
  if (nums.length) {
    start = Math.min(...nums);
    end = Math.max(...nums);
    if (nums.every(n => n % 2 === 1)) type = 'odd';
    else if (nums.every(n => n % 2 === 0)) type = 'even';
  }
  if (end < start) end = start;
  return { start: clampWeek(start), end: clampWeek(end), type };
}

function clampWeek(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.min(30, Math.max(1, Math.round(n)));
}

// 统计两遍结果里星期/行数不一致的条数
function countDiff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (!b[i]) continue;
    if (a[i].day !== b[i].day) { n++; continue; }
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) n++;
  }
  return n;
}

function locOk(a, b) {
  if (!a || !b) return true;
  return a === b;
}

function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const m = str(v).match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

function pick(o, keys) {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
}

function str(v) {
  return v == null ? '' : String(v).trim();
}

function msgOf(e) {
  return String(e && e.message ? e.message : e);
}

// 从文本里提取第一个能解析的 JSON 数组
function extractJsonArray(text) {
  const s = String(text);
  for (let i = s.indexOf('['); i !== -1; i = s.indexOf('[', i + 1)) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const arr = JSON.parse(s.slice(i, j + 1));
            if (Array.isArray(arr) && arr.length) return arr;
          } catch { /* 换下一个起点 */ }
          break;
        }
      }
    }
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
