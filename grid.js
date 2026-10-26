// grid.js —— 从课表截图的像素里直接算出「星期」和「节次」
//
// 思路：星期/节次不让视觉模型去"数格子"，而由几何计算得出，模型只负责读文字。
// 这样对截图版式（单行"N节" / 三行"节次+时间"、8~16 节、有无边框）都不敏感。
//
// 纯函数：输入 RGBA 像素数组 + 宽高，输出 { ok, cols, pitch, nRow, blocks, reason }
//
// 流程：
//   1) 表头 7 列：在图片上部找"7 个等距文字簇"（星期汉字行 / 日期数字行都符合），取间距最均匀的一行
//   2) 行高：左侧节次列的文字按纵向分组，找出最长的等间距序列，取其中位相邻间隔作为行高
//   3) 色块上下边界：逐列扫描"彩色像素占比"，连续占比高的一段就是一个色块（不看文字）
//   4) 行边界相位：色块边界必须落在"行边界格点"上，据此定出第 1 节的上边界
//   5) 行号：第 k 节取整行主色，同一色块内相隔 >=8 的颜色变化切成两门课
(function (root) {
  'use strict';

  function lumOf(r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; }

  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // 变异系数：等间距序列的"整齐程度"，越小越整齐
  function cvg(seq) {
    if (seq.length < 2) return 9;
    const g = [];
    for (let i = 1; i < seq.length; i++) g.push(seq[i] - seq[i - 1]);
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    if (m <= 0) return 9;
    const v = g.reduce((a, b) => a + (b - m) * (b - m), 0) / g.length;
    return Math.sqrt(v) / m;
  }

  // ===== 1) 表头 7 列 =====
  function findHeaderColumns(data, w, h) {
    let best = null;
    const stepY = Math.max(3, Math.round(h * 0.004));
    const band = Math.max(8, Math.round(h * 0.009));
    const yFrom = Math.round(h * 0.03), yTo = Math.round(h * 0.45);

    for (let y = yFrom; y < yTo; y += stepY) {
      const y1 = Math.min(h, y + band);
      const pr = new Int32Array(w);
      for (let yy = y; yy < y1; yy++) {
        const base = yy * w;
        for (let x = 0; x < w; x++) {
          const i = (base + x) * 4;
          if (lumOf(data[i], data[i + 1], data[i + 2]) < 215) pr[x]++;
        }
      }
      // 连续段 + 合并近邻
      const runs = [];
      let s = -1;
      for (let x = 0; x < w; x++) {
        if (pr[x] > 0 && s < 0) s = x;
        if (pr[x] === 0 && s >= 0) { runs.push([s, x - 1]); s = -1; }
      }
      if (s >= 0) runs.push([s, w - 1]);
      const merged = [];
      for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last && r[0] - last[1] <= 12) last[1] = r[1];
        else merged.push([r[0], r[1]]);
      }
      const keep = merged.filter(r => r[1] - r[0] >= 3);
      if (keep.length < 7) continue;

      const cs = keep.map(r => (r[0] + r[1]) / 2);
      for (let a = 0; a + 6 < cs.length; a++) {
        const win = cs.slice(a, a + 7);
        const span = win[6] - win[0];
        const gap = span / 6;
        if (gap < w * 0.06 || span < w * 0.45) continue;
        const cv = cvg(win);
        if (cv > 0.15) continue;
        const score = span / w - cv * 2 - (y / h) * 2;
        if (!best || score > best.score) best = { score, cols: win, y };
      }
    }
    return best;
  }

  // ===== 2) 行高：左侧节次标签的等间距序列 =====
  function labelLines(data, w, h, x0, x1) {
    const pr = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      const base = y * w;
      for (let x = x0; x < x1; x++) {
        const i = (base + x) * 4;
        if (lumOf(data[i], data[i + 1], data[i + 2]) < 200) c++;
      }
      pr[y] = c;
    }
    const out = [];
    let s = -1;
    for (let y = 0; y < h; y++) {
      if (pr[y] > 0 && s < 0) s = y;
      if (pr[y] === 0 && s >= 0) {
        if (y - s >= 5) out.push((s + y - 1) / 2);
        s = -1;
      }
    }
    if (s >= 0 && h - s >= 5) out.push((s + h - 1) / 2);
    return out;
  }

  function groupCenters(cs, thr) {
    if (!cs.length) return [];
    const g = [[cs[0]]];
    for (let i = 1; i < cs.length; i++) {
      if (cs[i] - g[g.length - 1][g[g.length - 1].length - 1] > thr) g.push([]);
      g[g.length - 1].push(cs[i]);
    }
    return g.map(a => a.reduce((x, y) => x + y, 0) / a.length);
  }

  // 以 p 为步长、从每个点向两侧扩展出最长的等差链
  function chainOf(cs, p, tol) {
    const t = tol || 0.20;
    const out = [];
    for (let i = 0; i < cs.length; i++) {
      const run = [cs[i]];
      let e = cs[i] + p, k = i + 1;
      while (k < cs.length) {
        if (Math.abs(cs[k] - e) <= t * p) { run.push(cs[k]); e += p; k++; }
        else if (cs[k] < e - t * p) k++;
        else break;
      }
      e = cs[i] - p; k = i - 1;
      while (k >= 0) {
        if (Math.abs(cs[k] - e) <= t * p) { run.unshift(cs[k]); e -= p; k--; }
        else if (cs[k] > e + t * p) k--;
        else break;
      }
      out.push(run);
    }
    return out;
  }

  function labelInfo(cs, h) {
    if (cs.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < cs.length; i++) gaps.push(cs[i] - cs[i - 1]);
    const med = median(gaps);
    const thrs = [0, med * 1.6, med * 2.2, med * 3.0];
    let best = null;
    for (const thr of thrs) {
      const gc = groupCenters(cs, thr);
      if (gc.length < 5 || gc.length > 30) continue;
      for (let i = 0; i < gc.length; i++) {
        for (let j = i + 1; j < Math.min(gc.length, i + 5); j++) {
          const p = (gc[j] - gc[i]) / (j - i);
          if (p < h * 0.025) continue;
          for (const run of chainOf(gc, p)) {
            if (run.length < 5) continue;
            const gg = [];
            for (let k = 1; k < run.length; k++) gg.push(run[k] - run[k - 1]);
            const score = run.length * 1000 - cvg(run) * 1000;
            if (!best || score > best.score) best = { score, labels: run, pitch: median(gg) };
          }
        }
      }
    }
    return best;
  }

  // ===== 3) 色块纵向边界：彩色像素占比 =====
  function dayXRange(cols, colW, day) {
    const left = day === 0 ? cols[0] - colW / 2 : (cols[day - 1] + cols[day]) / 2;
    const right = day === 6 ? cols[6] + colW / 2 : (cols[day] + cols[day + 1]) / 2;
    // 必须是整数：Canvas 像素数组用小数下标取不到值
    return [Math.round(left + colW * 0.12), Math.round(right - colW * 0.12)];
  }

  function isColorPixel(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return (mx - mn) >= 11 && (765 - (r + g + b)) >= 20;
  }

  function runsOfDay(data, w, h, xa, xb, yTop, yBot, pitch) {
    const step = Math.max(2, Math.round(pitch / 60));
    const sx = Math.max(1, Math.floor((xb - xa) / 40));
    const ys = [], fr = [];
    for (let y = yTop; y < yBot; y += step) {
      let n = 0, c = 0;
      const y1 = Math.min(yBot, y + step);
      for (let yy = y; yy < y1; yy++) {
        const base = yy * w;
        for (let x = xa; x < xb; x += sx) {
          const i = (base + x) * 4;
          n++;
          if (isColorPixel(data[i], data[i + 1], data[i + 2])) c++;
        }
      }
      ys.push(y); fr.push(n ? c / n : 0);
    }
    // 只容忍很窄的空隙（横线/文字导致），真正的两个块之间会有明显缝隙
    const gapTol = Math.floor((pitch * 0.04) / step) + 1;
    const out = [];
    let i = 0;
    while (i < ys.length) {
      if (fr[i] < 0.42) { i++; continue; }
      let j = i, miss = 0, k = i + 1;
      while (k < ys.length) {
        if (fr[k] >= 0.42) { j = k; miss = 0; }
        else {
          miss++;
          if (miss > gapTol) break;
        }
        k++;
      }
      if (ys[j] + step - ys[i] >= pitch * 0.5) out.push([ys[i], ys[j] + step]);
      i = k;
    }
    return out;
  }

  // 整行主色：取出现最多的量化颜色（文字是白/深色，不会成为主体）
  function rowColor(data, w, xa, xb, y0, y1) {
    const buckets = new Map();
    const sy = Math.max(1, Math.floor((y1 - y0) / 60));
    const sx = Math.max(1, Math.floor((xb - xa) / 30));
    let total = 0;
    for (let y = y0; y < y1; y += sy) {
      const base = y * w;
      for (let x = xa; x < xb; x += sx) {
        const i = (base + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = (r >> 4) + '_' + (g >> 4) + '_' + (b >> 4);
        let e = buckets.get(key);
        if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, e); }
        e.n++; e.r += r; e.g += g; e.b += b; total++;
      }
    }
    let top = null;
    for (const e of buckets.values()) if (!top || e.n > top.n) top = e;
    if (!top) return { c: [255, 255, 255], on: false };
    const c = [Math.round(top.r / top.n), Math.round(top.g / top.n), Math.round(top.b / top.n)];
    const on = (765 - (c[0] + c[1] + c[2])) >= 22 && (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) >= 11;
    return { c, on };
  }

  function colorDist(a, b) {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  }

  // ===== 主流程 =====
  function detect(data, w, h) {
    const out = { ok: false, reason: '', cols: [], pitch: 0, nRow: 0, blocks: [] };
    if (!data || !w || !h) { out.reason = '无像素数据'; return out; }

    const hd = findHeaderColumns(data, w, h);
    if (!hd) { out.reason = '未找到表头 7 列'; return out; }
    const cols = hd.cols;
    const colW = (cols[6] - cols[0]) / 6;
    out.cols = cols;

    const x0 = Math.max(0, Math.round(cols[0] - colW * 1.05));
    const x1 = Math.round(cols[0] - colW * 0.32);
    const info = labelInfo(labelLines(data, w, h, x0, x1), h);
    if (!info) { out.reason = '未找到左侧节次行'; return out; }
    const pitch = info.pitch;
    out.pitch = pitch;

    // 各天的色块纵向区间
    const yTop = Math.max(0, Math.round(info.labels[0] - pitch * 1.6));
    const perDay = [];
    for (let day = 0; day < 7; day++) {
      const [xa, xb] = dayXRange(cols, colW, day);
      if (xb - xa < 4) { perDay.push([]); continue; }
      perDay.push(runsOfDay(data, w, h, xa, xb, yTop, h, pitch));
    }
    const edges = [];
    for (const rs of perDay) for (const r of rs) { edges.push(r[0]); edges.push(r[1]); }
    if (edges.length < 2) { out.reason = '未检测到彩色课块'; return out; }

    // 行边界格点的相位（模 pitch）
    let bestPhase = null;
    const nP = Math.max(1, Math.round(pitch));
    for (let it = 0; it < nP; it++) {
      const res = edges
        .map(e => Math.abs(e - (it + Math.round((e - it) / pitch) * pitch)))
        .sort((a, b) => a - b);
      const sc = median(res);
      if (!bestPhase || sc < bestPhase.sc) bestPhase = { sc, phi: it };
    }
    const phi0 = bestPhase.phi;

    // 节次标签相对行边界的偏移取众数（用来估总节数，同时剔除表头里的其他文字）
    const offs = info.labels.map(l => ((l - phi0) % pitch + pitch) % pitch);
    let bestOff = null;
    for (const o of offs) {
      let cnt = 0;
      for (const x of offs) {
        const dd = Math.min(Math.abs(x - o), pitch - Math.abs(x - o));
        if (dd <= pitch * 0.06) cnt++;
      }
      if (!bestOff || cnt > bestOff.cnt) bestOff = { cnt, off: o };
    }
    const alignedLabels = bestOff.cnt;

    // 第 1 节的上边界：最上面的色块边界；若表头下面还有整行空白，则往上补
    const topEdge = Math.min.apply(null, edges);
    let phi = phi0 + pitch * Math.round((topEdge - phi0) / pitch);
    if (phi - hd.y > pitch * 1.2) {
      const extra = Math.round((phi - hd.y) / pitch - 0.5);
      if (extra >= 1 && extra <= 4) phi -= extra * pitch;
    }
    let nRow = Math.max(Math.round((Math.max.apply(null, edges) - phi) / pitch), alignedLabels, 10);
    nRow = Math.min(nRow, 16);

    // 逐节取整行主色，再按颜色变化切分成不同课程
    const blocks = [];
    for (let day = 0; day < 7; day++) {
      const rs = perDay[day];
      if (!rs.length) continue;
      const [xa, xb] = dayXRange(cols, colW, day);
      for (const [a, b] of rs) {
        if (b < phi + pitch * 0.3) continue;
        const k0 = Math.max(0, Math.round((a - phi) / pitch));
        const k1 = Math.min(nRow - 1, Math.round((b - phi) / pitch) - 1);
        if (k1 < k0) continue;
        let cur = null;
        for (let k = k0; k <= k1; k++) {
          const y0 = Math.round(phi + k * pitch + pitch * 0.13);
          const y1 = Math.round(phi + (k + 1) * pitch - pitch * 0.13);
          if (y1 > h || y0 >= y1) break;
          const rc = rowColor(data, w, xa, xb, y0, y1);
          if (!rc.on) {
            if (cur) { blocks.push(cur); cur = null; }
            continue;
          }
          if (cur && colorDist(rc.c, cur.c) < 8) cur.end = k + 1;
          else {
            if (cur) blocks.push(cur);
            cur = { day: day + 1, start: k + 1, end: k + 1, c: rc.c };
          }
        }
        if (cur) blocks.push(cur);
      }
    }
    for (const b of blocks) delete b.c;
    blocks.sort((a, b) => a.start - b.start || a.day - b.day);

    out.blocks = blocks;
    out.nRow = nRow;
    out.phase = phi;
    out.ok = blocks.length >= 3;
    if (!out.ok) out.reason = '未检测到彩色课块';
    return out;
  }

  // ===== 把模型读到的文字按顺序贴到像素色块上 =====
  // 位置全部以像素为准。三级兜底，任何一级对不上都不会比"纯 AI 读数"更差：
  //   1) 按「起始节」分档（模型判起始节最稳）
  //   2) 按「起止节」分档
  //   3) 条数相同时按输出顺序一一对应（模型可能把节次读错，但先后顺序通常是对的）
  function applyToCourses(courses, grid) {
    if (!grid || !grid.ok || !grid.blocks.length || !courses || !courses.length) {
      return { applied: 0, mode: 'none' };
    }
    const tryAssign = (keyFn) => {
      const bm = new Map();
      for (const b of grid.blocks) {
        const k = keyFn(b);
        if (!bm.has(k)) bm.set(k, []);
        bm.get(k).push(b);
      }
      const cm = new Map();
      for (const c of courses) {
        const k = keyFn(c);
        if (!cm.has(k)) cm.set(k, []);
        cm.get(k).push(c);
      }
      for (const [k, list] of cm) {
        const bl = bm.get(k);
        if (!bl || bl.length !== list.length) return null;
      }
      let n = 0;
      for (const [k, list] of cm) {
        const bl = bm.get(k).slice().sort((a, b) => a.day - b.day);
        for (let i = 0; i < list.length; i++) {
          list[i].day = bl[i].day;
          list[i].start = bl[i].start;
          list[i].end = bl[i].end;
          list[i].fromPixel = true;
          n++;
        }
      }
      return n;
    };

    let n = tryAssign(c => String(c.start));
    if (n !== null) return { applied: n, mode: 'start' };
    n = tryAssign(c => c.start + '-' + c.end);
    if (n !== null) return { applied: n, mode: 'range' };

    if (grid.blocks.length === courses.length) {
      for (let i = 0; i < courses.length; i++) {
        const b = grid.blocks[i];
        courses[i].day = b.day;
        courses[i].start = b.start;
        courses[i].end = b.end;
        courses[i].fromPixel = true;
      }
      return { applied: courses.length, mode: 'order' };
    }
    return { applied: 0, mode: 'mismatch' };
  }

  const api = { detect, applyToCourses, median, cvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GridDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
