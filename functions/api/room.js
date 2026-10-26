// Cloudflare Pages Function: /api/room
// 用 Cloudflare KV 按 roomId 存两人课表：每侧 = { startDate, courses }
// GET  /api/room?room=xxx  -> { blue:{startDate,courses}, pink:{startDate,courses} }
// POST /api/room           -> { room, side:'blue'|'pink', startDate, courses }

export async function onRequest({ request, env }) {
  if (request.method === 'GET') return handleGet(request, env);
  if (request.method === 'POST') return handlePost(request, env);
  return json({ error: '不支持的请求方法' }, 405);
}

async function handleGet(request, env) {
  const url = new URL(request.url);
  const room = url.searchParams.get('room');
  if (!room) return json({ error: '缺少 room 参数' }, 400);
  const raw = await env.SCHEDULE_KV.get(room);
  const data = raw ? safeParse(raw) : null;
  return json({
    blue: normalizeSide(data && data.blue),
    pink: normalizeSide(data && data.pink),
  });
}

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }
  const { room, side, startDate, courses } = body;
  if (!room || !['blue', 'pink'].includes(side)) {
    return json({ error: '参数错误：需要 room 与 side(blue|pink)' }, 400);
  }
  const raw = await env.SCHEDULE_KV.get(room);
  const data = raw ? safeParse(raw) : null;
  const next = {
    blue: normalizeSide(data && data.blue),
    pink: normalizeSide(data && data.pink),
    updatedAt: Date.now(),
  };
  // 支持只更新开学日期：请求里不带 courses 字段时保留原有课程，避免误清空
  const prev = normalizeSide(data && data[side]);
  next[side] = {
    startDate: startDate === undefined ? prev.startDate : (startDate || null),
    courses: Array.isArray(courses) ? courses : prev.courses,
  };
  await env.SCHEDULE_KV.put(room, JSON.stringify(next));
  return json({ ok: true });
}

// 兼容旧结构：旧版直接存数组 [course,...]
function normalizeSide(v) {
  if (Array.isArray(v)) return { startDate: null, courses: v };
  if (v && typeof v === 'object') {
    return { startDate: v.startDate || null, courses: Array.isArray(v.courses) ? v.courses : [] };
  }
  return { startDate: null, courses: [] };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
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
