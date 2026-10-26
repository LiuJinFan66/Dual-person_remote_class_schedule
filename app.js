// ===== 配置 =====
const SLOTS = [
  { n: 1,  t: '08:00' }, { n: 2,  t: '08:55' }, { n: 3,  t: '10:00' },
  { n: 4,  t: '10:55' }, { n: 5,  t: '14:00' }, { n: 6,  t: '14:55' },
  { n: 7,  t: '16:00' }, { n: 8,  t: '16:55' }, { n: 9,  t: '19:00' },
  { n: 10, t: '19:55' }, { n: 11, t: '20:50' }, { n: 12, t: '21:45' },
];
const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEK_OPTS = ['all', 'odd', 'even'];

// ===== 状态 =====
const state = {
  roomId: '',
  role: 'blue',
  blue: [],
  pink: [],
  showBlue: true,
  showPink: true,
  week: 'all',
  preview: [],
  imageData: null,
};

// ===== 工具 =====
function $(id) { return document.getElementById(id); }
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}
function randRoom() {
  const s = 'abcdefghijkmnpqrstuvwxyz23456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
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
    });
  });
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
    $('recognizeBtn').disabled = true;
    $('recognizeBtn').textContent = '识别中…';
    try {
      const resp = await fetch('/api/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: state.imageData }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.courses) throw new Error(data.error || '识别失败');
      state.preview = data.courses.map(normCourse);
      renderPreview();
      toast('识别完成，请核对后保存');
    } catch (e) {
      toast('识别失败：' + e.message + '（可手动添加）');
      state.preview = [emptyCourse()];
      renderPreview();
    } finally {
      $('recognizeBtn').disabled = false;
      $('recognizeBtn').textContent = '识别课表';
    }
  });
}

function emptyCourse() {
  return { name: '', day: 1, start: 1, end: 2, loc: '', teacher: '', week: 'all' };
}
function normCourse(c) {
  return {
    name: String(c.name || '').trim(),
    day: clampInt(c.day, 1, 7, 1),
    start: clampInt(c.start, 1, 12, 1),
    end: clampInt(c.end, 1, 12, 2),
    loc: String(c.loc || c.location || '').trim(),
    teacher: String(c.teacher || '').trim(),
    week: WEEK_OPTS.includes(c.week) ? c.week : 'all',
  };
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ===== 预览表格（可编辑）=====
function renderPreview() {
  const card = $('previewCard');
  card.hidden = false;
  const body = $('previewBody');
  body.innerHTML = '';
  state.preview.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input data-i="${i}" data-k="name" value="${esc(c.name)}" placeholder="课程名"/></td>
      <td><select data-i="${i}" data-k="day">${DAYS.map((d, di) => `<option value="${di + 1}" ${c.day === di + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></td>
      <td><input data-i="${i}" data-k="start" type="number" min="1" max="12" value="${c.start}"/></td>
      <td><input data-i="${i}" data-k="end" type="number" min="1" max="12" value="${c.end}"/></td>
      <td><input data-i="${i}" data-k="loc" value="${esc(c.loc)}" placeholder="地点"/></td>
      <td><select data-i="${i}" data-k="week">${WEEK_OPTS.map(w => `<option value="${w}" ${c.week === w ? 'selected' : ''}>${weekLabel(w)}</option>`).join('')}</select></td>
      <td><button class="row-del" data-del="${i}">✕</button></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('input,select').forEach(el => {
    el.addEventListener('change', () => {
      const i = +el.dataset.i, k = el.dataset.k;
      state.preview[i][k] = (k === 'day' || k === 'start' || k === 'end') ? parseInt(el.value, 10) : el.value;
    });
  });
  body.querySelectorAll('.row-del').forEach(b => {
    b.addEventListener('click', () => {
      state.preview.splice(+b.dataset.del, 1);
      renderPreview();
    });
  });
}
function weekLabel(w) { return w === 'all' ? '全周' : w === 'odd' ? '单周' : '双周'; }
function esc(s) { return String(s).replace(/"/g, '&quot;'); }

function bindPreviewActions() {
  $('addRowBtn').addEventListener('click', () => {
    if ($('previewCard').hidden) { state.preview = []; }
    state.preview.push(emptyCourse());
    renderPreview();
  });
  $('cancelBtn').addEventListener('click', () => {
    $('previewCard').hidden = true;
    state.preview = [];
    state.imageData = null;
    $('fileInput').value = '';
    $('recognizeBtn').disabled = true;
    $('uploadHint').textContent = '支持教务系统 / 超级课表的截图，自动识别课程名、时间、地点。';
  });
  $('confirmBtn').addEventListener('click', async () => {
    const courses = state.preview.filter(c => c.name);
    if (!courses.length) { toast('没有可保存的课程'); return; }
    $('confirmBtn').disabled = true;
    try {
      const resp = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: state.roomId, side: state.role, courses }),
      });
      if (!resp.ok) throw new Error((await resp.json()).error || '保存失败');
      toast('已保存，合并课表已更新');
      $('previewCard').hidden = true;
      state.preview = [];
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

// ===== 云端读写 =====
async function loadRoom() {
  try {
    const resp = await fetch('/api/room?room=' + encodeURIComponent(state.roomId));
    if (!resp.ok) throw new Error('读取失败');
    const data = await resp.json();
    state.blue = (data.blue || []).map(normCourse);
    state.pink = (data.pink || []).map(normCourse);
    renderGrid();
  } catch (e) {
    toast('同步失败：' + e.message);
  }
}

// ===== 合并网格 =====
function weekVisible(c) {
  return state.week === 'all' || c.week === 'all' || c.week === state.week;
}
function courseAt(list, day, slot) {
  if (!state.showBlue && list === state.blue) return null;
  if (!state.showPink && list === state.pink) return null;
  return list.find(c => c.day === day && weekVisible(c) && slot >= c.start && slot <= c.end) || null;
}
function renderGrid() {
  const grid = $('scheduleGrid');
  grid.innerHTML = '';
  // 表头
  grid.appendChild(cell('head', '节'));
  DAYS.forEach(d => grid.appendChild(cell('head', d)));
  // 时间行
  SLOTS.forEach(s => {
    grid.appendChild(cell('time', s.n + '<br>' + s.t));
    DAYS.forEach((_, di) => {
      const day = di + 1;
      const b = courseAt(state.blue, day, s.n);
      const p = courseAt(state.pink, day, s.n);
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
    });
  });
}
function cell(cls, html) {
  const d = document.createElement('div');
  d.className = 'cell ' + cls;
  d.innerHTML = html;
  return d;
}

// ===== 视图控制 =====
function bindControls() {
  $('shareBtn').addEventListener('click', shareRoom);
  $('refreshBtn').addEventListener('click', loadRoom);
  $('tgBlue').addEventListener('change', e => { state.showBlue = e.target.checked; renderGrid(); });
  $('tgPink').addEventListener('change', e => { state.showPink = e.target.checked; renderGrid(); });
  document.querySelectorAll('.seg-btn[data-week]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn[data-week]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.week = btn.dataset.week;
      renderGrid();
    });
  });
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
