// Cloudflare Pages Function: /api/recognize
// 接收 base64 图片，调用智谱 GLM-4V-Flash 识别课表，返回结构化课程数组

const PROMPT = `这是一张大学课程表截图。请识别并仅输出一个 JSON 数组，每个元素含字段：name(课程名)、day(星期1-7的整数)、start(开始节次整数)、end(结束节次整数)、loc(上课地点)、teacher(教师，未知留空)、week(周次类型: all/odd/even，依据"单周/双周/单双周"判断，无说明则为 all)。不要输出多余解释，只输出 JSON。`;

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

    const upstream = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'glm-4v-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: image } },
          ],
        }],
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return json({ error: `GLM 接口错误 ${upstream.status}: ${txt.slice(0, 300)}` }, 502);
    }

    const data = await upstream.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const courses = parseCourses(content);
    if (!courses) {
      return json({ error: '无法从模型返回中解析出课程 JSON', raw: content.slice(0, 500) }, 422);
    }
    return json({ courses });
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

function parseCourses(text) {
  try {
    let t = String(text).trim();
    // 去掉可能的 ```json 围栏
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const s = t.indexOf('[');
    const e = t.lastIndexOf(']');
    if (s === -1 || e === -1 || e <= s) return null;
    const arr = JSON.parse(t.slice(s, e + 1));
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch {
    return null;
  }
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
