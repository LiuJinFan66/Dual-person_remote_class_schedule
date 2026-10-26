// Cloudflare Pages Function: /api/recognize
// 接收 base64 图片，调用智谱视觉模型识别课表，返回结构化课程数组
// 依次尝试多个模型（免费优先、更强优先），直到拿到可解析结果
//
// 设计要点（解决「连堂被截断」问题）：
//   不让模型直接输出 start/end，而是要求它把色块纵向压住的【每一个行号】都列进 rows。
//   模型漏行的概率远低于「把 5-8 读成 5-6」，因为列举是一项逐项检查的动作。
//   服务端再把 rows 归一化成连续的 start/end，必要时合并被拆开的相邻色块。

// 模型尝试顺序：先强（thinking），再稳（flash）。都可免费额度内使用；
// 若某个模型不可用（4xx/额度），自动降级到下一个。
const MODELS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];

const PROMPT = `这是一张中国大学的周课表截图。请把表格里每一个「彩色课块」逐个找出来，输出 JSON 数组。

【表格结构】
- 表头一行是 7 列：一 二 三 四 五 六 日（星期一到星期日）。列头上方还有 26、27、28 这类日期数字，那是日期，直接忽略。
- 最左边一列是行号（节次）：1、2、3 …… 一直到最后一节。常见是 11 行或 12 行，请以截图里实际显示的最大行号为准，不要预设只有 11 行。
  这一列里还写着 07:40-08:25 这类上课时间，忽略时间，只取行号数字。
- 顶部「第X周」是当前查看第几周，不是课程的周次。

【最重要：连堂色块要覆盖全部行】
一门连着上几节的课，在课表里是一个纵向很高的色块，可能占 2 行、3 行、4 行。
请贴着这个色块的上边缘和下边缘，数清楚它纵向压住了哪几行，然后把压住的每一个行号都写进 rows 数组：
- 色块顶在「5」这一行、底在「8」这一行 → rows = [5,6,7,8]，四个数字都要写，不能只写 [5,6]，也不能只写 [5]。
- 晚上的课占 9、10、11 三行 → rows = [9,10,11]；只占 9、10 两行 → rows = [9,10]。
- 只占一行的课 → rows = [5] 这样的单元素数组。
- 判断方法：色块高度大约是单行高度的几倍，rows 就应该有几个数字。一个明显是 4 倍行高的色块，rows 必须有 4 个数字。
- 输出前请对每个色块再数一次行数，确认没有漏掉中间的行和最后一行。

【每个对象的字段】
- name: 课程名（色块里第一行文字，别把老师、地点混进去）
- day: 该色块所在列的星期，整数，一=1 二=2 三=3 四=4 五=5 六=6 日=7
- rows: 该色块纵向覆盖的全部行号，升序整数数组，例如 [5,6,7,8]
- loc: 地点，取「@(海甸)」后面那一串教室名（"(海甸)"是校区，既不是地点也不是老师）；没有就空字符串
- teacher: 老师，没有就空字符串
- weekStart/weekEnd/weekType: 看色块里的文字，如「1-16周」→ 1,16,"all"；「3-8周」→ 3,8,"all"；含「单」→ weekType="odd"；含「双」→ weekType="even"；完全没写 → 1,16,"all"

【硬性要求】
1. 星期只看表头「一~日」，绝对不要把日期数字（26/27/30/1…）当成星期。
2. 节次只看左侧行号 1~N，绝对不要把上课时间（07:40、14:30…）当成节次。
3. rows 必须完整覆盖色块的高度，这一条是本次识别的关键。
4. 每个有课的色块都要输出一条；同一门课出现在不同星期或不同节次，要分别输出多条。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块。

格式示例：
[{"name":"大学物理实验","day":3,"rows":[5,6,7,8],"loc":"物理实验中心-201","teacher":"","weekStart":3,"weekEnd":8,"weekType":"all"},
 {"name":"大学英语","day":5,"rows":[1,2],"loc":"5教-302","teacher":"","weekStart":1,"weekEnd":16,"weekType":"all"}]`;

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

    let lastDetail = '';
    for (const model of MODELS) {
      try {
        const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                { type: 'image_url', image_url: { url: image } },
              ],
            }],
          }),
        });

        if (!resp.ok) {
          const txt = await resp.text();
          lastDetail = `${model} HTTP ${resp.status}: ${txt.slice(0, 200)}`;
          continue; // 换下一个模型
        }

        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const raw = extractJsonArray(content);
        if (raw && raw.length) {
          const courses = buildCourses(raw);
          if (courses.length) return json({ courses, model, rawCount: raw.length });
          lastDetail = `${model} 有 JSON 但无有效课程：${JSON.stringify(raw).slice(0, 200)}`;
          continue;
        }
        lastDetail = `${model} 无有效 JSON: ${String(content).slice(0, 200)}`;
      } catch (e) {
        lastDetail = `${model} 异常: ${String(e && e.message ? e.message : e)}`;
      }
    }

    return json({ error: '识别失败：模型未返回可解析的课程数据', detail: lastDetail }, 502);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
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

// ===== 把模型的原始输出整理成课程 =====

// rows -> 连续区间 -> 按「天+课名」合并相邻块 -> 输出 start/end
function buildCourses(raw) {
  const flat = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = str(pick(item, ['name', '课程', '课程名', 'course', 'courseName']));
    const day = toDayNum(pick(item, ['day', '星期', '周几', '星期几', 'weekday']));
    const rows = toRows(item);
    if (!name || !day || !rows.length) continue;
    flat.push({
      name,
      day,
      min: rows[0],
      max: rows[rows.length - 1],
      loc: str(pick(item, ['loc', 'location', '地点', '教室', 'room'])),
      teacher: str(pick(item, ['teacher', '教师', '老师'])),
      weekStart: weekRange(item).start,
      weekEnd: weekRange(item).end,
      weekType: weekRange(item).type,
    });
  }

  // 同一门课在同一天可能被模型拆成两个相邻色块（如 [5,6] + [7,8]），这里合并回 5-8
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

// 从对象里取出该色块覆盖的行号集合（容错多种字段名与写法）
function toRows(c) {
  let rows = [];
  const v = pick(c, ['rows', 'row', 'periods', 'sections', 'sectionList', '节次列表', '节次']);
  if (Array.isArray(v)) {
    rows = v.map(x => toInt(x)).filter(n => n != null);
  } else if (v != null && v !== '') {
    rows = (String(v).match(/\d+/g) || []).map(Number);
  }

  // 没有 rows 就退回 start/end 兼容模式
  if (!rows.length) {
    const s = toInt(pick(c, ['start', '开始节', '起节', 'startPeriod', 'startSlot']));
    let e = toInt(pick(c, ['end', '结束节', '止节', 'endPeriod', 'endSlot']));
    if (s != null) {
      if (e == null || e < s) e = s;
      for (let i = s; i <= e; i++) rows.push(i);
    }
  }

  rows = Array.from(new Set(rows.filter(n => n >= 1 && n <= 20))).sort((a, b) => a - b);
  return rows;
}

function weekRange(c) {
  let start = toInt(pick(c, ['weekStart', '起始周', '开始周', 'startWeek']));
  let end = toInt(pick(c, ['weekEnd', '结束周', 'stopWeek', 'endWeek']));
  if (start == null) start = 1;
  if (end == null) end = 16;

  let type = 'all';
  const wt = String(pick(c, ['weekType', '周次类型', '周类型', 'week']) || '');
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

function locOk(a, b) {
  if (!a || !b) return true;
  return a === b;
}

function toDayNum(v) {
  if (typeof v === 'number' && v >= 1 && v <= 7) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const n = s.match(/\d+/);
  if (n) {
    const x = Number(n[0]);
    if (x === 0 || x === 7) return 7;
    if (x >= 1 && x <= 6) return x;
  }
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  for (const k of Object.keys(map)) if (s.includes(k)) return map[k];
  const en = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const low = s.toLowerCase();
  for (let i = 0; i < en.length; i++) if (low.includes(en[i])) return i + 1;
  return 0;
}

function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const m = String(v == null ? '' : v).match(/-?\d+/);
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
