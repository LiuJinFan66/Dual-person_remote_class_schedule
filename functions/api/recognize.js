// Cloudflare Pages Function: /api/recognize
// 接收 base64 图片，调用智谱视觉模型识别课表，返回结构化课程数组
// 依次尝试多个模型（免费优先、更强优先），直到拿到可解析结果

// 模型尝试顺序：先强（thinking），再稳（flash）。都可免费额度内使用；
// 若某个模型不可用（4xx/额度），自动降级到下一个。
const MODELS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];

const PROMPT = `这是一张中国大学的周课表截图，请严格按下面的版式规则识别，不要被无关数字误导。

版式说明：
- 顶部一行是 7 个星期列，列头是「一 二 三 四 五 六 日」；列头上方还有日期数字（如 26/27/28/30/31/1），那是日期，不是星期，请忽略。
- 最左侧一列，每行同时写着节次数字 1~11 和一段上课时间（如 07:40-08:25）。请用【节次数字】表示第几节，绝对不要用时间。
- 中间是 7 列 × 11 行的表格。有课的地方是带文字的彩色块，一个色块可能纵向跨多行（表示连上多节）。
- 顶部的「第X周」只是当前查看第几周，不是课程的周次。

请逐个彩色块输出 JSON 数组，每个对象字段：
- name: 课程名（块内第一行文字）
- day: 该块所在列的星期，整数（一=1,二=2,三=3,四=4,五=5,六=6,日=7）
- start: 该块最上面一行的节次数字
- end: 该块最下面一行的节次数字（只占一行则等于 start）
- loc: 地点，取「@(海甸)」后面那一串教室/场地名（"(海甸)"是校区，不是地点、也不是老师）
- teacher: 老师（通常没有，没有就空字符串）
- weekStart/weekEnd/weekType: 该课的周次，看色块里的文字（如"1-16周""3-8周""单周""双周"）；没写就 weekStart=1, weekEnd=16, weekType="all"

必须遵守：
1. 星期一律看顶部「一~日」，绝对不要把日期数字(26/27/30/1…)当星期。
2. 节次一律看左侧行号 1~11，绝对不要把时间(07:40、14:30…)当节次。
3. 跨多行的色块：start=最上行号，end=最下行号。
4. 顶部「第X周」不是课程周次，课程周次按上面规则判断，没写就是全周。
5. 每一门有课的块都要输出；同一课名在不同星期/不同节次出现，要分别输出多条。
6. 只输出 JSON 数组，不要解释、不要代码块。格式示例：
[{"name":"高等数学","day":2,"start":3,"end":4,"loc":"4教-513","teacher":"","weekStart":1,"weekEnd":16,"weekType":"all"}]`;

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
