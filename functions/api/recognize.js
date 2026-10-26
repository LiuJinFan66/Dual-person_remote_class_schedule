// Cloudflare Pages Function: /api/recognize
// 接收 base64 图片，调用智谱视觉模型识别课表，返回结构化课程数组
//
// 两遍识别（解决「有课被识别到后一天」）：
//   第 1 遍：抽取课程。星期不让模型写数字，而是让它【照抄该列顶部印着的汉字】（一/二/三…）。
//            照抄是转录任务，「三→3」是转换任务，后者容易错位；服务端再做汉字→数字。
//   第 2 遍：把第 1 遍结果连同原图再发一次，只核对「星期列」和「节次行数」，
//            这是链式校验：手里已有答案再做局部核对，比一次成型准确得多。
//   第 2 遍失败或结构不一致就丢弃，用第 1 遍结果，保证不倒退。

const MODELS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];
const API = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const PROMPT_MAIN = `这是一张中国大学的周课表截图。请把表格里每一个「彩色课块」逐个找出来，输出 JSON 数组。

【表格结构】
- 表头一行是 7 列，每列顶部印着一个汉字：一 二 三 四 五 六 日（星期一到星期日）。
- 这 7 个汉字上方还有 26、27、28 这类日期数字。日期和星期没有固定关系，绝不要用日期去推算星期，只认列顶部的汉字。
- 最左边一列是节次列，写着 1、2、3 …… 一直到最后一节，还夹着 07:40-08:25 这样的时间。这一列是节次，不是星期一。请以截图里实际显示的最大行号为准，不要预设只有 11 行。
- 顶部「第X周」是当前查看第几周，不是课程的周次。

【最容易错的地方：星期列】
- 每一门课都必须从它所在块的【正中间垂直往上】看，看到表头那一列顶部的汉字，然后把这个汉字照抄到 dayChar 里。
- 最左边那一列（写 1、2、3 和时间的）是节次列，它头顶上没有星期汉字。绝不许把节次列算作第一列，也绝不许因为"块挨着节次列就往右挪一天"。
- 如果星期块左边紧挨着的就是节次列，那它就在【第一列，周一】。
- 如果截图最左边有被裁掉一半的列，不要把它当成独立的一天。
- 允许 dayChar 和 day 同时输出，但 dayChar 必须是你照抄的汉字，不许凭数字推。

【连堂色块要覆盖全部行】
一门连着上几节的课是一个纵向很高的色块，可能占 2 行、3 行、4 行。
请贴着色块的上边缘和下边缘，数清它压住了哪几行，把每一个行号都写进 rows：
- 顶在「5」行、底在「8」行 → rows = [5,6,7,8]，四个数字都要写。
- 晚上占 9、10、11 → [9,10,11]；只占 9、10 → [9,10]；只占一行 → [5]。
- 判断方法：色块高度大约是单行高度的几倍，rows 就该有几个数字。

【字段】
- name: 课程名（色块第一行文字，别混入老师、地点）
- dayChar: 该块所在列顶部的汉字，只写一个字：一/二/三/四/五/六/日
- rows: 该块纵向覆盖的全部行号，升序数组
- loc: 地点，「@(海甸)」后面那串教室名（"(海甸)"是校区）
- teacher: 老师，没有就空字符串
- weekStart/weekEnd/weekType: 「1-16周」→1,16,"all"；「3-8周」→3,8,"all"；含「单」→"odd"；含「双」→"even"；没写→1,16,"all"

【硬性要求】
1. 星期只认列顶部的汉字，并且是照抄，不是推算。
2. 节次只认左侧行号，绝不把上课时间当节次。
3. rows 必须完整覆盖色块高度。
4. 每个有课的块都要一条；同课名在不同星期或不同节次，分别输出。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块。

示例：
[{"name":"大学物理实验","dayChar":"三","rows":[5,6,7,8],"loc":"物理实验中心-201","teacher":"","weekStart":3,"weekEnd":8,"weekType":"all"},
 {"name":"大学英语","dayChar":"五","rows":[1,2],"loc":"5教-302","teacher":"","weekStart":1,"weekEnd":16,"weekType":"all"}]`;

const PROMPT_VERIFY = (courses) => `还是同一张课表截图。下面是第一遍识别的结果：

${JSON.stringify(courses.map(c => ({
  name: c.name,
  dayChar: c.dayChar,
  rows: c.rows,
  loc: c.loc,
  weekStart: c.weekStart,
  weekEnd: c.weekEnd,
  weekType: c.weekType,
})))}

请只核对两件事，逐条检查每一门课：
（1）星期列有没有错位。方法是：从这门课的色块正中间垂直往上，看表头那一列顶部印的汉字，和你记的 dayChar 是否一致。
      特别注意两个坑：① 最左边写 1、2、3 和时间的列是节次列，不是星期一，不能算进星期列；
      ② 色块左边紧挨节次列的，就是第一列「一」（周一），不要往右挪一天。
（2）rows 的行数是否等于色块高度。色块跨 4 行就必须有 4 个行号。

规则：
- 没有错的条目原样保留，课程名、地点、周次一个字都不许改。
- 只修明确错位的 dayChar 和 rows。
- 输出完整的 JSON 数组，字段与输入完全一致，不要解释、不要代码块。`;

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

    // ===== 第 1 遍：抽取 =====
    let first = null, usedModel = '', lastDetail = '';
    for (const model of MODELS) {
      try {
        const arr = await callModel(model, key, PROMPT_MAIN, image);
        if (arr && arr.length) {
          const courses = buildCourses(arr);
          if (courses.length) { first = courses; usedModel = model; break; }
          lastDetail = `${model} 有 JSON 但无有效课程`;
        } else {
          lastDetail = `${model} 无有效 JSON`;
        }
      } catch (e) {
        lastDetail = `${model} 异常: ${msgOf(e)}`;
      }
    }
    if (!first) {
      return json({ error: '识别失败：模型未返回可解析的课程数据', detail: lastDetail }, 502);
    }

    // ===== 第 2 遍：核对星期与行数（失败则沿用第 1 遍）=====
    let final = first, verified = false, changed = 0;
    const order = [usedModel, ...MODELS.filter(m => m !== usedModel)];
    for (const model of order) {
      try {
        const arr = await callModel(model, key, PROMPT_VERIFY(first), image);
        if (!arr || !arr.length) continue;
        const second = buildCourses(arr);
        if (second.length !== first.length) continue; // 条数对不上说明这遍跑偏了，不采用
        changed = countDiff(first, second);
        final = second;
        verified = true;
        break;
      } catch { /* 核对失败不影响主流程 */ }
    }

    return json({ courses: final, model: usedModel, verified, changed });
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

// 调一次模型，返回解析出的 JSON 数组
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
  return extractJsonArray(content);
}

// ===== 把模型的原始输出整理成课程 =====

function buildCourses(raw) {
  const flat = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = str(pick(item, ['name', '课程', '课程名', 'course', 'courseName']));
    const day = resolveDay(item);
    const rows = toRows(item);
    if (!name || !day || !rows.length) continue;
    const wk = weekRange(item);
    flat.push({
      name, day,
      dayChar: charDay(pick(item, ['dayChar', 'dayLabel', 'weekdayChar', '星期字'])) || '',
      min: rows[0],
      max: rows[rows.length - 1],
      loc: str(pick(item, ['loc', 'location', '地点', '教室', 'room'])),
      teacher: str(pick(item, ['teacher', '教师', '老师'])),
      weekStart: wk.start,
      weekEnd: wk.end,
      weekType: wk.type,
    });
  }

  // 同一门课在同一天可能被拆成相邻两个块（[5,6] + [7,8]），合并回 5-8
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
  return merged.map(c => {
    const rows = [];
    for (let i = c.min; i <= c.max; i++) rows.push(i);
    return {
      name: c.name,
      day: c.day,
      dayChar: c.dayChar,
      rows,
      start: c.min,
      end: c.max,
      loc: c.loc,
      teacher: c.teacher,
      weekStart: c.weekStart,
      weekEnd: c.weekEnd,
      weekType: c.weekType,
    };
  });
}

// 星期：优先用模型照抄的汉字，其次才是数字
function resolveDay(c) {
  const byChar = charDay(pick(c, ['dayChar', 'dayLabel', 'weekdayChar', '星期字']));
  const byNum = toDayNum(pick(c, ['day', '星期', '周几', '星期几', 'weekday']));
  if (byChar && byNum && byChar !== byNum) return byChar; // 汉字来自列头，可信度更高
  return byChar || byNum || 0;
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
  const byChar = charDay(s);
  if (byChar) return byChar;
  return 0;
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

// 统计两遍结果里星期/行数不一致的条数，用于给用户反馈「自动修正了几处」
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

// 从模型输出文本里稳健地提取第一个能解析的 JSON 数组（可夹杂思考文字）
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
          const sub = s.slice(i, j + 1);
          try {
            const arr = JSON.parse(sub);
            if (Array.isArray(arr) && arr.length) return arr;
          } catch { /* 尝试下一个起点 */ }
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
