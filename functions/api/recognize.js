// Cloudflare Pages Function: /api/recognize
// 接收 base64 图片，调用智谱视觉模型识别课表，返回结构化课程数组
// 依次尝试多个模型（免费优先、更强优先），直到拿到可解析结果

// 模型尝试顺序：先强（thinking），再稳（flash）。都可免费额度内使用；
// 若某个模型不可用（4xx/额度），自动降级到下一个。
const MODELS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];

const PROMPT = `你是课程表识别助手。请仔细阅读这张大学课程表截图，把每一门课转录为 JSON 数组。
只输出 JSON 数组本身：不要解释、不要 markdown 代码块、不要多余文字。

每个课程对象的字段（全部必填）：
- name: 课程名（字符串）
- day: 星期几，整数 1-7（1=周一、2=周二 …… 7=周日）
- start: 开始节次，整数（第几节开始，如第1节填 1）
- end: 结束节次，整数（只占一节时与 start 相同）
- loc: 上课地点/教室（字符串，没有就空字符串）
- teacher: 教师（字符串，没有就空字符串）
- weekStart: 起始周，整数（"1-16周"则填 1；没写默认 1）
- weekEnd: 结束周，整数（"1-16周"则填 16；没写默认 16）
- weekType: "all" | "odd" | "even"（全周=all、单周=odd、双周=even；没说明用 all）

规则：
1. 表格里每一门有课的格子都要输出一条，不要遗漏，也不要编造没上的课。
2. 节次一律用"第几节"的整数，不要填具体时间（如 08:00）。
3. 一门课若连占多节，用 start/end 表示区间（如 1-2 节 → start=1,end=2）。
4. 一门课若周次写成"1-16周(单)"，则 weekStart=1, weekEnd=16, weekType="odd"。
5. 只输出 JSON 数组，例如：
[{"name":"高等数学","day":1,"start":1,"end":2,"loc":"A201","teacher":"","weekStart":1,"weekEnd":16,"weekType":"all"}]`;

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
        const courses = extractJsonArray(content);
        if (courses && courses.length) {
          return json({ courses, model });
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
