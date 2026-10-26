// ===== 配置 =====
const SLOTS = [
  { n: 1,  t: '08:00' }, { n: 2,  t: '08:55' }, { n: 3,  t: '10:00' },
  { n: 4,  t: '10:55' }, { n: 5,  t: '14:00' }, { n: 6,  t: '14:55' },
  { n: 7,  t: '16:00' }, { n: 8,  t: '16:55' }, { n: 9,  t: '19:00' },
  { n: 10, t: '19:55' }, { n: 11, t: '20:50' }, { n: 12, t: '21:45' },
];
const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEK_TYPES = ['all', 'odd', 'even'];

// ===== 状态 =====
const state = {
  roomId: '',
  role: 'blue',
  blue: { startDate: null, courses: [] },
  pink: { startDate: null, courses: [] },
  showBlue: true,
  showPink: true,
  viewDate: todayStr(),
  preview: [],
  imageData: null,
  editingExisting: false, // true = 正在编辑已保存的课表（允许保存空列表 = 清空）
};

// ===== 通用工具 =====
function $(id) { return document.getElementById(id); }
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function randRoom() {
  const s = 'abcdefghijkmnpqrstuvwxyz23456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}

// ===== 日期工具 =====
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return fmtDate(new Date()); }
function parseDate(s) {
  if (!s) return null;
  const p = String(s).split('-').map(Number);
  if (p.length !== 3 || p.some(isNaN)) return null;
  return new Date(p[0], p[1] - 1, p[2]);
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7; // 0=周一
  x.setDate(x.getDate() - wd);
  return x;
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function md(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }
// 真实日期 -> 该侧的教学周次（1 起）；未设开学日期返回 null
function teachingWeek(startDateStr, viewDateStr) {
  const s = parseDate(startDateStr);
  const v = parseDate(viewDateStr);
  if (!s || !v) return null;
  const sm = mondayOf(s).getTime();
  const vm = mondayOf(v).getTime();
  return Math.round((vm - sm) / (86400000 * 7)) + 1;
}

// ===== 房间 =====
function initRoom() {
  const params = new URLSearchParams(location.search);
  let r = params.get('r');
  if (!r) {
    r = randRoom();
    params.set('r', r);
    history.replaceState(null, '', '?' + params.toString());
  }
  state.roomId = r;
  $('roomId').textContent = r;
}
async function shareRoom() {
  const url = location.origin + location.pathname + '?r=' + state.roomId;
  try {
    await navigator.clipboard.writeText(url);
    toast('房间链接已复制，发给对象即可共用');
  } catch (e) {
    prompt('复制下面的链接发给对象：', url);
  }
}

// ===== 身份选择 =====
function bindRole() {
  document.querySelectorAll('.seg-btn[data-role]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn[data-role]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.role = btn.dataset.role;
      // 切换身份时，带出该侧已保存的开学日期
      $('startDateInput').value = state[state.role].startDate || '';
      // 正在编辑「已保存课表」时切了身份，就改为载入另一侧已保存的课
      if (state.editingExisting) openSavedEditor();
    });
  });
}

// ===== 课程数据结构 =====
function emptyCourse() {
  return { name: '', day: 1, start: 1, end: 2, loc: '', teacher: '', weekStart: 1, weekEnd: 16, weekType: 'all' };
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function pick(o, keys) {
  for (const k of keys) { if (o[k] != null && o[k] !== '') return o[k]; }
  return undefined;
}
function parseNums(v) {
  if (v == null) return [];
  const m = String(v).match(/\d+/g);
  return m ? m.map(Number) : [];
}
function toDay(v) {
  if (v == null || v === '') return 1;
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    let n = parseInt(v, 10);
    if (n === 0) n = 7; // 0 视为周日
    return clampInt(n, 1, 7, 1);
  }
  const s = String(v);
  const cn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  const m = s.match(/[一二三四五六日天]/);
  if (m) return cn[m[0]] || 1;
  const en = { sun: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const em = s.toLowerCase().match(/sun|mon|tue|wed|thu|fri|sat/);
  if (em) return en[em[0]] || 1;
  return 1;
}
function normWeekType(v) {
  if (v == null || v === '') return 'all';
  const s = String(v).toLowerCase();
  if (s.includes('单') || s === 'odd') return 'odd';
  if (s.includes('双') || s === 'even') return 'even';
  return 'all';
}
function normCourse(c) {
  c = c || {};
  const name = String(pick(c, ['name', '课程', '课程名', 'course', 'courseName']) || '').trim();
  const day = toDay(pick(c, ['day', '星期', '周几', '星期几', 'weekday']));
  const loc = String(pick(c, ['loc', 'location', '地点', '教室', 'room']) || '').trim();
  const teacher = String(pick(c, ['teacher', '教师', '老师']) || '').trim();

  // 节次：可能是分开的 start/end，也可能是一个 "1-2节" 的合并字段
  let startV = pick(c, ['start', '开始节', '起节', 'startPeriod', 'startSlot']);
  let endV = pick(c, ['end', '结束节', '止节', 'endPeriod', 'endSlot']);
  if (startV == null && endV == null) {
    const ns = parseNums(pick(c, ['period', '节次', '时间', 'time']));
    if (ns.length) { startV = ns[0]; endV = ns[ns.length - 1]; }
  }
  let start = clampInt(parseNums(startV)[0], 1, 12, 1);
  let end = clampInt(parseNums(endV).slice(-1)[0], 1, 12, start);
  if (end < start) end = start;

  // 周次
  let ws = clampInt(parseNums(pick(c, ['weekStart', '起始周', '开始周', 'startWeek']))[0], 1, 30, 1);
  let we = clampInt(parseNums(pick(c, ['weekEnd', '结束周', 'stopWeek', 'endWeek'])).slice(-1)[0], 1, 30, 16);
  let weekType = normWeekType(pick(c, ['weekType', '周次类型', '周类型', 'week']));
  const weeksRaw = pick(c, ['weeks', '周次']);
  if (Array.isArray(weeksRaw) && weeksRaw.length) {
    const nums = weeksRaw.map(Number).filter(n => !isNaN(n));
    if (nums.length) {
      ws = Math.min(...nums); we = Math.max(...nums);
      if (nums.every(n => n % 2 === 1)) weekType = 'odd';
      else if (nums.every(n => n % 2 === 0)) weekType = 'even';
    }
  } else if (typeof weeksRaw === 'string' && weeksRaw) {
    const nums = parseNums(weeksRaw);
    if (nums.length) { ws = Math.min(...nums); we = Math.max(...nums); }
    const wt = normWeekType(weeksRaw);
    if (wt !== 'all') weekType = wt;
  }
  if (we < ws) we = ws;

  return {
    name, day, start, end, loc, teacher, weekStart: ws, weekEnd: we, weekType,
    dayConflict: !!c.dayConflict,   // 三路读数不一致，前端标 ⚠ 提醒核对
    colDate: c.colDate || '',
  };
}
function normalizeSide(v) {
  if (Array.isArray(v)) return { startDate: null, courses: v.map(normCourse) };
  if (v && typeof v === 'object') return { startDate: v.startDate || null, courses: (v.courses || []).map(normCourse) };
  return { startDate: null, courses: [] };
}

// ===== 上传与识别 =====
function bindUpload() {
  const input = $('fileInput');
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.imageData = reader.result;
      $('recognizeBtn').disabled = false;
      $('uploadHint').textContent = '已选择：' + file.name + '（点击「识别课表」）';
    };
    reader.readAsDataURL(file);
  });

  $('recognizeBtn').addEventListener('click', async () => {
    if (!state.imageData) return;
    const btn = $('recognizeBtn');
    btn.disabled = true;
    btn.textContent = '识别中…';
    // 两遍识别比较慢，过一会儿给个进度提示，避免以为卡死
    let phase = 0;
    const timer = setInterval(() => {
      phase++;
      btn.textContent = phase === 1 ? '正在核对星期…' : '还在核对，请稍等…';
    }, 9000);
    try {
      const resp = await fetch('/api/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: state.imageData }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.courses) {
        const msg = (data.error || '识别失败') + (data.detail ? '｜' + String(data.detail).slice(0, 90) : '');
        throw new Error(msg);
      }
      state.preview = data.courses.map(normCourse);
      state.editingExisting = false; // 新识别的结果，不属于「已保存课表」
      renderPreview();
      const fixed = data.verified ? (data.changed > 0 ? `，已自动校正 ${data.changed} 处` : '，已复核') : '';
      const conf = data.conflicts > 0 ? `；${data.conflicts} 行星期读数不一致已标 ⚠，请重点核对` : '';
      toast('识别完成' + fixed + conf + '，确认后保存');
    } catch (e) {
      toast('识别失败：' + e.message + '（可手动添加）');
      if (!state.preview.length) { state.preview = [emptyCourse()]; renderPreview(); }
    } finally {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = '识别课表';
    }
  });
}

// ===== 预览表格（可编辑）=====
function renderPreview() {
  const card = $('previewCard');
  card.hidden = false;
  const body = $('previewBody');
  body.innerHTML = '';
  state.preview.forEach((c, i) => {
    const tr = document.createElement('tr');
    if (c.dayConflict) tr.className = 'conflict-row';
    tr.innerHTML = `
      <td class="td-del"><button class="row-del" data-del="${i}" title="删除这一行">✕</button></td>
      <td><input data-i="${i}" data-k="name" value="${esc(c.name)}" placeholder="课程名"/></td>
      <td class="day-cell">${c.dayConflict ? '<span class="warn" title="星期读数不一致，请核对这一行">⚠</span>' : ''}<select data-i="${i}" data-k="day">${DAYS.map((d, di) => `<option value="${di + 1}" ${c.day === di + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></td>
      <td><input data-i="${i}" data-k="start" type="number" min="1" max="12" value="${c.start}"/></td>
      <td><input data-i="${i}" data-k="end" type="number" min="1" max="12" value="${c.end}"/></td>
      <td><input data-i="${i}" data-k="loc" value="${esc(c.loc)}" placeholder="地点"/></td>
      <td><input data-i="${i}" data-k="weekStart" type="number" min="1" max="30" value="${c.weekStart}"/></td>
      <td><input data-i="${i}" data-k="weekEnd" type="number" min="1" max="30" value="${c.weekEnd}"/></td>
      <td><select data-i="${i}" data-k="weekType">${WEEK_TYPES.map(w => `<option value="${w}" ${c.weekType === w ? 'selected' : ''}>${weekLabel(w)}</option>`).join('')}</select></td>`;
    body.appendChild(tr);
  });
  const intKeys = ['day', 'start', 'end', 'weekStart', 'weekEnd'];
  body.querySelectorAll('input,select').forEach(el => {
    el.addEventListener('change', () => {
      const i = +el.dataset.i, k = el.dataset.k;
      state.preview[i][k] = intKeys.includes(k) ? parseInt(el.value, 10) : el.value;
      // 用户手动改过星期就不再算「读数冲突」
      if (k === 'day') {
        state.preview[i].dayConflict = false;
        const tr = el.closest('tr');
        if (tr) {
          tr.classList.remove('conflict-row');
          const w = tr.querySelector('.warn');
          if (w) w.remove();
        }
      }
    });
  });
  body.querySelectorAll('.row-del').forEach(b => {
    b.addEventListener('click', () => {
      state.preview.splice(+b.dataset.del, 1);
      renderPreview();
      toast(state.preview.length ? '已删除一行' : '已清空，可点「＋ 加一行」手动录入');
    });
  });
  $('previewCount') && ($('previewCount').textContent = String(state.preview.length));
  if (!state.preview.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="td-del"></td><td colspan="8" class="empty-row">暂无课程，点右上「＋ 加一行」手动添加</td>`;
    body.appendChild(tr);
  }
}
function weekLabel(w) { return w === 'all' ? '全周' : w === 'odd' ? '单周' : '双周'; }

// ===== 保存 =====
async function postSide(side, startDate, courses) {
  const resp = await fetch('/api/room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: state.roomId, side, startDate: startDate || null, courses }),
  });
  if (!resp.ok) throw new Error((await resp.json()).error || '保存失败');
}

function bindPreviewActions() {
  $('addRowBtn').addEventListener('click', () => {
    if ($('previewCard').hidden) { state.preview = []; $('previewCard').hidden = false; }
    state.preview.push(emptyCourse());
    renderPreview();
  });

  // 清空全部识别结果
  $('clearAllBtn').addEventListener('click', () => {
    if (!state.preview.length) { toast('已经是空的了'); return; }
    if (!confirm('清空当前这 ' + state.preview.length + ' 条课程？')) return;
    state.preview = [];
    renderPreview();
    toast('已清空，可点「＋ 加一行」手动录入');
  });

  // 编辑已保存的课表（识别的课存错了也能在这里删掉）
  $('editSavedBtn').addEventListener('click', openSavedEditor);

  // 星期错位一键平移：可只动某一天，也可整表动
  const shiftBy = (delta) => {
    if (!state.preview.length) { toast('还没有课程'); return; }
    const scope = $('shiftScope').value;
    const only = scope === 'all' ? 0 : parseInt(scope, 10);
    let n = 0;
    state.preview.forEach(c => {
      if (only && c.day !== only) return;
      c.day = ((c.day - 1 + delta + 7) % 7) + 1;
      n++;
    });
    if (!n) { toast(DAYS[only - 1] + '没有课，没动'); return; }
    renderPreview();
    toast((only ? DAYS[only - 1] : '全部') + '的 ' + n + ' 门课已' + (delta > 0 ? '推后' : '提前') + '一天');
  };
  $('shiftBack').addEventListener('click', () => shiftBy(-1));
  $('shiftFwd').addEventListener('click', () => shiftBy(1));

  $('cancelBtn').addEventListener('click', () => {
    $('previewCard').hidden = true;
    state.preview = [];
    state.editingExisting = false;
    state.imageData = null;
    $('fileInput').value = '';
    $('recognizeBtn').disabled = true;
    $('uploadHint').textContent = '支持教务系统 / 超级课表的截图，自动识别课程名、星期、节次、周次、地点。';
  });

  // 只改开学日期（已存在该侧课表时即时保存）
  $('startDateInput').addEventListener('change', async () => {
    const val = $('startDateInput').value || null;
    state[state.role].startDate = val;
    const cur = state[state.role].courses;
    if (cur && cur.length) {
      try { await postSide(state.role, val, cur); toast('开学日期已更新'); await loadRoom(); }
      catch (e) { toast('保存失败：' + e.message); }
    }
  });

  $('confirmBtn').addEventListener('click', async () => {
    // 只保留课表需要的字段，别把识别过程中的临时标记（dayConflict/colDate）存进云端
    const courses = state.preview
      .filter(c => c.name)
      .map(c => ({
        name: c.name, day: c.day, start: c.start, end: c.end, loc: c.loc, teacher: c.teacher,
        weekStart: c.weekStart, weekEnd: c.weekEnd, weekType: c.weekType,
      }));
    if (!courses.length) {
      if (!state.editingExisting) { toast('没有可保存的课程'); return; }
      // 编辑已保存课表时允许存成空 → 等于把这一侧清空
      if (!confirm('当前没有课程，保存后会清空「' + (state.role === 'blue' ? '蓝（我）' : '粉（对象）') + '」的全部课程，确定吗？')) return;
    }
    const startDate = $('startDateInput').value || null;
    if (!startDate && courses.length) toast('提示：未填开学日期，将按「全周固定」显示');
    $('confirmBtn').disabled = true;
    try {
      await postSide(state.role, startDate, courses);
      toast(courses.length ? '已保存，合并课表已更新' : '已清空该侧课程');
      $('previewCard').hidden = true;
      state.preview = [];
      state.editingExisting = false;
      state.imageData = null;
      $('fileInput').value = '';
      await loadRoom();
    } catch (e) {
      toast('保存失败：' + e.message);
    } finally {
      $('confirmBtn').disabled = false;
    }
  });
}

// 载入某一侧已保存的课程到预览表，可逐条修改/删除后重新保存
function openSavedEditor() {
  const side = state[state.role];
  const list = (side && side.courses) || [];
  state.editingExisting = true;
  state.preview = list.map(c => ({ ...c }));
  $('startDateInput').value = (side && side.startDate) || $('startDateInput').value || '';
  renderPreview();
  $('previewCard').hidden = false;
  $('previewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(list.length ? '已载入' + list.length + ' 条已保存课程，可删除或修改' : '这一侧还没有保存课程，可点「＋ 加一行」手动录入');
}

// ===== 云端读写 =====
async function loadRoom() {
  try {
    const resp = await fetch('/api/room?room=' + encodeURIComponent(state.roomId));
    if (!resp.ok) throw new Error('读取失败');
    const data = await resp.json();
    state.blue = normalizeSide(data.blue);
    state.pink = normalizeSide(data.pink);
    // 同步当前身份的开学日期输入框
    if (!$('startDateInput').value) $('startDateInput').value = state[state.role].startDate || '';
    renderGrid();
  } catch (e) {
    toast('同步失败：' + e.message);
  }
}

// ===== 合并网格 =====
function courseActive(c, tw) {
  if (tw == null) return true;            // 未设开学日：不过滤周次
  if (tw < c.weekStart || tw > c.weekEnd) return false;
  if (c.weekType === 'odd') return tw % 2 === 1;
  if (c.weekType === 'even') return tw % 2 === 0;
  return true;
}
function findCourse(person, day, period, tw, visible) {
  if (!visible) return null;
  return person.courses.find(c => c.day === day && period >= c.start && period <= c.end && courseActive(c, tw)) || null;
}
function cell(cls, html) {
  const d = document.createElement('div');
  d.className = 'cell ' + cls;
  d.innerHTML = html;
  return d;
}
function renderGrid() {
  const grid = $('scheduleGrid');
  grid.innerHTML = '';
  const vd = parseDate(state.viewDate) || new Date();
  const monday = mondayOf(vd);
  const today = todayStr();

  const twB = teachingWeek(state.blue.startDate, state.viewDate);
  const twP = teachingWeek(state.pink.startDate, state.viewDate);

  // 表头：周一..周日 + 真实日期
  grid.appendChild(cell('head', '节'));
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const isToday = fmtDate(d) === today;
    grid.appendChild(cell('head' + (isToday ? ' today' : ''), DAYS[i] + '<br><span class="date">' + md(d) + '</span>'));
  }

  // 节次行（只显示节次号，不显示具体时间：两校上课时间可能不同，统一按节次对齐）
  SLOTS.forEach(s => {
    grid.appendChild(cell('time', String(s.n)));
    for (let i = 0; i < 7; i++) {
      const day = i + 1;
      const b = findCourse(state.blue, day, s.n, twB, state.showBlue);
      const p = findCourse(state.pink, day, s.n, twP, state.showPink);
      let cls = 'empty', inner = '';
      if (b && p) {
        cls = 'both';
        inner = `<span class="cname">${esc(b.name)}</span><span class="cname">${esc(p.name)}</span>`;
      } else if (b) {
        cls = 'blue';
        inner = `<span class="cname">${esc(b.name)}</span>${b.loc ? `<span class="cloc">${esc(b.loc)}</span>` : ''}`;
      } else if (p) {
        cls = 'pink';
        inner = `<span class="cname">${esc(p.name)}</span>${p.loc ? `<span class="cloc">${esc(p.loc)}</span>` : ''}`;
      }
      grid.appendChild(cell(cls, inner));
    }
  });

  // 顶部信息
  $('rangeText').textContent = md(monday) + ' 周一 – ' + md(addDays(monday, 6)) + ' 周日';
  $('badgeBlue').textContent = twB == null ? '蓝 · 未设开学日' : '蓝 · 第' + twB + '周';
  $('badgePink').textContent = twP == null ? '粉 · 未设开学日' : '粉 · 第' + twP + '周';
}

// ===== 视图控制 =====
function setViewDate(s) {
  state.viewDate = s;
  $('viewDate').value = s;
  renderGrid();
}
function bindControls() {
  $('shareBtn').addEventListener('click', shareRoom);
  $('refreshBtn').addEventListener('click', loadRoom);
  $('tgBlue').addEventListener('change', e => { state.showBlue = e.target.checked; renderGrid(); });
  $('tgPink').addEventListener('change', e => { state.showPink = e.target.checked; renderGrid(); });

  $('viewDate').value = state.viewDate;
  $('viewDate').addEventListener('change', e => { if (e.target.value) setViewDate(e.target.value); });
  $('prevWeek').addEventListener('click', () => {
    const d = parseDate(state.viewDate) || new Date();
    setViewDate(fmtDate(addDays(d, -7)));
  });
  $('nextWeek').addEventListener('click', () => {
    const d = parseDate(state.viewDate) || new Date();
    setViewDate(fmtDate(addDays(d, 7)));
  });
  $('todayBtn').addEventListener('click', () => setViewDate(todayStr()));
}

// ===== 启动 =====
function main() {
  initRoom();
  bindRole();
  bindUpload();
  bindPreviewActions();
  bindControls();
  renderGrid();
  loadRoom();
  setInterval(loadRoom, 10000); // 10s 轮询同步
}
main();
