// grid.js —— 从课表截图的像素里检测「星期列」和「节次行」
//
// 目的：星期/节次不再让视觉模型去"数格子"，而是由几何计算得出，模型只负责读文字。
// 纯函数：输入 RGBA 像素数组 + 宽高，输出 { ok, cols, rows, bounds, blocks, reason }
//
// 三步：
//   1) 表头锚点：在图片上部找一行"7 个等距文字簇"（星期汉字行 / 日期数字行都符合）
//   2) 行边界：左侧节次列的文字按 y 分组，每组是一节（组内是"节次号+开始时间+结束时间"三行）
//   3) 格子占用：逐格取中位色，非白色且有饱和度 = 有课；同一列连续占用的行合并成一个色块
(function (root) {
  'use strict';

  function lumOf(r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; }

  // 某一行的深色像素连续段
  function darkRuns(data, w, y, x0, x1, thr, minRun) {
    const mr = minRun || 2;
    const runs = [];
    let s = -1;
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const dark = lumOf(data[i], data[i + 1], data[i + 2]) < thr;
      if (dark && s < 0) s = x;
      if (!dark && s >= 0) { if (x - s >= mr) runs.push([s, x - 1]); s = -1; }
    }
    if (s >= 0 && x1 - s >= mr) runs.push([s, x1 - 1]);
    return runs;
  }

  // 把间隔很小的连续段合并（"2""8" 这种数字内部间隙）
  function mergeRuns(runs, gap) {
    const out = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && r[0] - last[1] <= gap) last[1] = r[1];
      else out.push([r[0], r[1]]);
    }
    return out;
  }

  function centersOf(runs) { return runs.map(r => (r[0] + r[1]) / 2); }

  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // ===== 1) 表头：找 7 个等距文字簇 =====
  // 星期汉字行（一~日）和日期数字行都与 7 列对齐，任意一行都能当锚点。
  // 汉字是浅灰细笔画，阈值要放宽到 215 才抓得全。
  function findHeaderColumns(data, w, h, cfg) {
    cfg = cfg || { minRun: 2, mergeGap: 6 };
    const x0 = Math.round(w * 0.08), x1 = w - 2;
    let best = null;
    const yMax = Math.round(h * 0.34);
    for (let y = Math.round(h * 0.03); y < yMax; y += 1) {
      const runs = mergeRuns(darkRuns(data, w, y, x0, x1, cfg.darkThr || 215, cfg.minRun), cfg.mergeGap);
      if (runs.length !== 7) continue;
      const cs = centersOf(runs);
      const gaps = [];
      for (let i = 1; i < 7; i++) gaps.push(cs[i] - cs[i - 1]);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (mean < w * 0.05) continue;
      const dev = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length) / mean;
      if (dev > 0.28) continue;
      if (cs[0] < w * 0.06 || cs[6] < w * 0.7) continue;
      const score = (cs[6] - cs[0]) / w - dev;
      if (!best || score > best.score) best = { y, cs, score };
    }
    if (!best) return null;

    // 在该行上下 ±6px 内再取几行做平均，抵消单行噪点
    const acc = [0, 0, 0, 0, 0, 0, 0];
    let n = 0;
    for (let y = best.y - 6; y <= best.y + 6; y++) {
      if (y < 1 || y >= h) continue;
      const runs = mergeRuns(darkRuns(data, w, y, x0, x1, cfg.darkThr || 215, cfg.minRun), cfg.mergeGap);
      if (runs.length !== 7) continue;
      const cs = centersOf(runs);
      let ok = true;
      for (let i = 0; i < 7; i++) if (Math.abs(cs[i] - best.cs[i]) > 8) ok = false;
      if (!ok) continue;
      for (let i = 0; i < 7; i++) acc[i] += cs[i];
      n++;
    }
    if (!n) return null;
    return acc.map(v => v / n);
  }

  // ===== 2) 行：左侧节次列的文字分组 =====
  // 左侧每节有 3 行文字（节次号 + 开始时间 + 结束时间），组内间隙小、组间间隙大。
  // 表头上方还有"第9周""10月"之类的文字，会被误当成行，
  // 所以从最底部往回找一段"间距均匀"的连续行，这才是真正的节次行（课表一直延伸到图片底部）。
  function findRows(data, w, h, cols, cfg) {
    cfg = cfg || { minRun: 2 };
    const colW = (cols[6] - cols[0]) / 6;
    const x0 = Math.max(2, Math.round(w * 0.02));
    const x1 = Math.max(x0 + 6, Math.round(cols[0] - colW * 0.45));
    const yTop = Math.round(h * 0.06);

    const lines = [];
    let s = -1;
    for (let y = yTop; y < h; y++) {
      let dark = 0;
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (lumOf(data[i], data[i + 1], data[i + 2]) < 175) dark++;
      }
      if (dark > 0 && s < 0) s = y;
      if (dark === 0 && s >= 0) { if (y - s >= 4) lines.push([s, y - 1]); s = -1; }
    }
    if (s >= 0 && h - s >= 4) lines.push([s, h - 1]);
    if (lines.length < 20) return null;

    // 组内小间隙合并成一节
    const lc = centersOf(lines);
    const gaps = [];
    for (let i = 1; i < lc.length; i++) gaps.push(lc[i] - lc[i - 1]);
    const thr = Math.max(median(gaps) * 2.2, 10);

    const groups = [[lc[0]]];
    for (let i = 1; i < lc.length; i++) {
      if (lc[i] - lc[i - 1] > thr) groups.push([]);
      groups[groups.length - 1].push(lc[i]);
    }
    if (groups.length < 9) return null;

    const gc = groups.map(g => g.reduce((a, b) => a + b, 0) / g.length);

    // 在所有连续窗口里挑"间距最均匀"的一段（节次行严格等间距，表头行间距不齐）
    const cvOf = (arr) => {
      const g = [];
      for (let i = 1; i < arr.length; i++) g.push(arr[i] - arr[i - 1]);
      const m = g.reduce((a, b) => a + b, 0) / g.length;
      if (!m) return 99;
      return Math.sqrt(g.reduce((a, b) => a + (b - m) * (b - m), 0) / g.length) / m;
    };
    let bestWin = null;
    for (let a = 0; a < gc.length; a++) {
      for (let b = a + 8; b < gc.length; b++) {
        const win = gc.slice(a, b + 1);
        const cv = cvOf(win);
        // 先满足"足够均匀"，再取最长
        const flat = cv <= 0.02;
        const score = (flat ? 1e6 : 0) + win.length * 1000 - cv * 10000;
        if (!bestWin || score > bestWin.score) bestWin = { win, cv, score };
      }
    }
    if (!bestWin) return null;
    const centers = bestWin.win;
    if (centers.length < 9 || centers.length > 14) return null;

    // 用等间距的期望值微调，抵消文字高度带来的中心偏移
    const pitch = median(centers.slice(1).map((c, i) => c - centers[i]));
    if (pitch < h * 0.02) return null;

    const bounds = [centers[0] - pitch / 2];
    for (let i = 0; i < centers.length - 1; i++) bounds.push((centers[i] + centers[i + 1]) / 2);
    bounds.push(centers[centers.length - 1] + pitch / 2);
    return { centers, bounds, pitch };
  }

  // ===== 3) 色块 =====
  // 逐格取"主色"（出现最多的量化颜色），比中位色更抗文字干扰：
  // 文字像素颜色分散，背景色永远落在同一个桶里最多。
  function dominantColor(data, w, x0, x1, y0, y1) {
    const buckets = new Map();
    const sx = Math.max(1, Math.floor((x1 - x0) / 40));
    const sy = Math.max(1, Math.floor((y1 - y0) / 40));
    for (let y = y0; y <= y1; y += sy) {
      for (let x = x0; x <= x1; x += sx) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const k = (r >> 4) + '_' + (g >> 4) + '_' + (b >> 4);
        let e = buckets.get(k);
        if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(k, e); }
        e.n++; e.r += r; e.g += g; e.b += b;
      }
    }
    let top = null;
    for (const e of buckets.values()) if (!top || e.n > top.n) top = e;
    if (!top) return [255, 255, 255];
    const mr = top.r / top.n, mg = top.g / top.n, mb = top.b / top.n;
    // 把色差很小的像素一起平均，消除量化桶边界造成的跳变
    let n = 0, ar = 0, ag = 0, ab = 0;
    for (const e of buckets.values()) {
      const d = Math.abs(e.r / e.n - mr) + Math.abs(e.g / e.n - mg) + Math.abs(e.b / e.n - mb);
      if (d <= 30) { n += e.n; ar += e.r; ag += e.g; ab += e.b; }
    }
    if (!n) return [Math.round(mr), Math.round(mg), Math.round(mb)];
    return [Math.round(ar / n), Math.round(ag / n), Math.round(ab / n)];
  }

  // 与白色的距离 + 彩度，判断这格是不是"有课的彩色块"
  function isOccupied(rgb) {
    const mx = Math.max(rgb[0], rgb[1], rgb[2]);
    const mn = Math.min(rgb[0], rgb[1], rgb[2]);
    const distWhite = 765 - (rgb[0] + rgb[1] + rgb[2]);
    return distWhite >= 20 && (mx - mn) >= 8;
  }

  function colorDist(a, b) {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  }

  // 按「行」为单位取色：色块永远对齐行边界，所以只在行与行之间按颜色变化切分，
  // 不会切出半行碎片。
  function findBlocks(data, w, h, cols, rowInfo) {
    const colW = (cols[6] - cols[0]) / 6;
    const inset = Math.round(colW * 0.2);
    const bounds = rowInfo.bounds;
    const nRow = rowInfo.centers.length;
    const yInset = Math.round(rowInfo.pitch * 0.08);

    const blocks = [];
    for (let d = 0; d < 7; d++) {
      const left = d === 0 ? cols[0] - colW / 2 : (cols[d - 1] + cols[d]) / 2;
      const right = d === 6 ? cols[6] + colW / 2 : (cols[d] + cols[d + 1]) / 2;
      const xa = Math.max(1, Math.round(left + inset));
      const xb = Math.min(w - 2, Math.round(right - inset));
      if (xb <= xa) continue;

      const cell = [];
      for (let r = 0; r < nRow; r++) {
        const ya = Math.max(1, Math.round(bounds[r] + yInset));
        const yb = Math.min(h - 2, Math.round(bounds[r + 1] - yInset));
        if (yb <= ya) { cell.push({ on: false, c: [255, 255, 255] }); continue; }
        const c = dominantColor(data, w, xa, xb, ya, yb);
        cell.push({ on: isOccupied(c), c });
      }

      let r = 0;
      while (r < nRow) {
        if (!cell[r].on) { r++; continue; }
        let e = r;
        while (e + 1 < nRow && cell[e + 1].on && colorDist(cell[e].c, cell[e + 1].c) < 12) e++;
        blocks.push({ day: d + 1, start: r + 1, end: e + 1 });
        r = e + 1;
      }
    }

    // 阅读顺序：先按起始节，再按星期（同一高度从左到右）
    blocks.sort((a, b) => a.start - b.start || a.day - b.day);
    return blocks;
  }

  function detect(data, w, h) {
    const out = { ok: false, reason: '', cols: [], rows: [], bounds: [], blocks: [] };
    if (!data || !w || !h) { out.reason = '无像素数据'; return out; }
    // 像素阈值随图片尺寸缩放：手机截图比桌面截图宽得多，笔画也更粗
    const scale = w / 700;
    const cfg = {
      minRun: Math.max(2, Math.round(2 * scale)),
      mergeGap: Math.max(4, Math.round(6 * scale)),
      darkThr: 215,
    };
    const cols = findHeaderColumns(data, w, h, cfg);
    if (!cols) { out.reason = '未找到表头 7 列'; return out; }
    const rowInfo = findRows(data, w, h, cols, cfg);
    if (!rowInfo) { out.reason = '未找到左侧节次行'; return out; }
    const blocks = findBlocks(data, w, h, cols, rowInfo);
    out.cols = cols;
    out.rows = rowInfo.centers;
    out.bounds = rowInfo.bounds;
    out.blocks = blocks;
    out.ok = blocks.length >= 3;
    if (!out.ok) out.reason = '未检测到彩色课块';
    return out;
  }

  // 把模型给的文字按顺序贴到像素检出的色块上：星期/节次全部以像素为准
  // 先按「起始节」分档（模型判起始节比判结束节稳），对不上再按「起止」分档；
  // 某一档条数对不上就整体放弃，保留 AI 读数，绝不让结果更差。
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
    let mode = 'start';
    if (n === null) { n = tryAssign(c => c.start + '-' + c.end); mode = 'range'; }
    if (n === null) return { applied: 0, mode: 'mismatch' };
    return { applied: n, mode };
  }

  const api = { detect, applyToCourses, findHeaderColumns, findRows, findBlocks, isOccupied, dominantColor, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GridDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
