// Cloudflare Pages Function: /api/room
// 用 Cloudflare KV 按 roomId 存两人课表（蓝/粉）
// GET  /api/room?room=xxx  -> { blue:[...], pink:[...] }
// POST /api/room           -> { room, side:'blue'|'pink', courses:[...] }

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
  return json({ blue: (data && data.blue) || [], pink: (data && data.pink) || [] });
}

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }
  const { room, side, courses } = body;
  if (!room || !['blue', 'pink'].includes(side)) {
    return json({ error: '参数错误：需要 room 与 side(blue|pink)' }, 400);
  }
  const raw = await env.SCHEDULE_KV.get(room);
  const data = raw ? safeParse(raw) : { blue: [], pink: [] };
  data.blue = data.blue || [];
  data.pink = data.pink || [];
  data[side] = Array.isArray(courses) ? courses : [];
  data.updatedAt = Date.now();
  await env.SCHEDULE_KV.put(room, JSON.stringify(data));
  return json({ ok: true });
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
