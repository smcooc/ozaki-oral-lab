/**
 * editor2d.js
 * 咬合面写真の上で検出結果を確認・手直しするためのエディタ。
 *
 * 自動検出はあくまで補助なので、
 *   ・基準3点（正中 / 右側最後方 / 左側最後方）
 *   ・各歯の隣接面（境界）
 * をドラッグで修正できるようにする。実際の臨床では、この手直しが
 * シミュレーションの精度を決める最も重要な工程になる。
 */


const HANDLE_KEYS = ['mid', 'right', 'left'];
const HANDLE_LABELS = { mid: '正中', right: '右最後方', left: '左最後方' };

export class ArchEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onHandles: Function, onBounds: Function}} callbacks
   */
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;
    this.photo = null;
    this.detection = null;
    this.handles = null;
    this.showMask = false;
    this.drag = null;
    this.hover = null;
    this.edits = new WeakMap();
    this.selected = null;
    this.detailCanvas = null;
    this.detailZoom = 4;
    this._bind();
  }

  setPhoto(photoCanvas) {
    this.photo = photoCanvas;
    this.canvas.width = photoCanvas.width;
    this.canvas.height = photoCanvas.height;
    this.render();
  }

  setDetection(detection, handles) {
    if (this.detection !== detection) this.selected = null;
    this.detection = detection;
    this.handles = handles;
    this.render();
    this.callbacks.onSelection?.();
  }

  clear() {
    this.photo = this.detection = this.handles = this.drag = this.hover = this.selected = null;
    this.render();
    this.callbacks.onSelection?.();
  }

  selectBoundary(side, index) {
    if (!this.detection?.sides[side] || index < 1
        || index >= this.detection.sides[side].bounds.length - 1) return;
    this.selected = { side, index };
    this.render();
    this.callbacks.onSelection?.();
  }

  _snapshot() {
    return Object.fromEntries(['R', 'L'].map(s => [s, [...this.detection.sides[s].bounds]]));
  }

  _restore(snapshot) {
    for (const s of ['R', 'L']) this.detection.sides[s].bounds = [...snapshot[s]];
  }

  _remember(snapshot) {
    if (JSON.stringify(snapshot) === JSON.stringify(this._snapshot())) return false;
    const history = this.edits.get(this.detection) ?? [];
    history.push(snapshot);
    if (history.length > 30) history.shift();
    this.edits.set(this.detection, history);
    return true;
  }

  canUndo() { return !!this.edits.get(this.detection)?.length; }

  undoBoundary() {
    const snapshot = this.edits.get(this.detection)?.pop();
    if (!snapshot) return;
    this._restore(snapshot);
    this.render();
    this.callbacks.onBounds?.(this.detection);
    this.callbacks.onSelection?.();
  }

  nudgeBoundary(direction) {
    if (!this.selected || !this.detection || ![-1, 1].includes(direction)) return;
    const { side, index } = this.selected;
    const b = this.detection.sides[side].bounds;
    const snapshot = this._snapshot();
    // 写真上の1画素ずつ。較正値由来のmmを実測として見せない。
    b[index] = Math.max(b[index - 1] + 1, Math.min(b[index + 1] - 1, b[index] + direction));
    if (!this._remember(snapshot)) return;
    this.render();
    this.callbacks.onBounds?.(this.detection);
    this.callbacks.onSelection?.();
  }

  setShowMask(on) {
    this.showMask = on;
    this.render();
  }

  /** 画面座標 → 画像ピクセル座標 */
  _toImage(ev) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * this.canvas.width,
      y: ((ev.clientY - rect.top) / rect.height) * this.canvas.height,
    };
  }

  _hitRadius() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? this.canvas.width / rect.width : 1;
    return 22 * scale; // 指で触れる大きさ（CSS px 換算で約22px）
  }

  _bind() {
    const down = (ev) => {
      if (!this.detection || !this.handles) return;
      ev.preventDefault();
      this.canvas.setPointerCapture(ev.pointerId);
      const p = this._toImage(ev);
      const r = this._hitRadius();

      // 1) 基準3点
      for (const key of HANDLE_KEYS) {
        const h = this.handles[key];
        if (Math.hypot(h.x - p.x, h.y - p.y) <= r) {
          this.drag = { type: 'handle', key, original: structuredClone(this.handles) };
          return;
        }
      }
      // 2) 歯の境界
      const hit = this._hitBoundary(p, r);
      if (hit) {
        this.drag = { type: 'bound', ...hit, original: this._snapshot() };
        this.selectBoundary(hit.side, hit.index);
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      this.drag = null;
    };

    const move = (ev) => {
      if (!this.drag) {
        // つかめる場所に来たら色を変えて知らせる
        if (!this.detection || !this.handles) return;
        const q = this._toImage(ev);
        const rr = this._hitRadius();
        let h = null;
        for (const key of HANDLE_KEYS) {
          const hh = this.handles[key];
          if (Math.hypot(hh.x - q.x, hh.y - q.y) <= rr) { h = { type: 'handle', key }; break; }
        }
        if (!h) {
          const b = this._hitBoundary(q, rr);
          if (b) h = { type: 'bound', ...b };
        }
        const changed = JSON.stringify(h) !== JSON.stringify(this.hover);
        this.hover = h;
        this.canvas.style.cursor = h ? 'grab' : 'default';
        if (changed) this.render();
        return;
      }
      ev.preventDefault();
      const p = this._toImage(ev);
      if (this.drag.type === 'handle') {
        this.handles[this.drag.key] = { x: p.x, y: p.y };
        this.render();
      } else {
        this._moveBoundary(this.drag, p);
        this.render();
      }
    };

    const up = (ev) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      this.canvas.style.cursor = 'grab';
      if (d.type === 'handle') this.callbacks.onHandles?.(this.handles);
      else if (this._remember(d.original)) this.callbacks.onBounds?.(this.detection);
      this.callbacks.onSelection?.();
      ev.preventDefault();
    };

    const cancel = () => {
      if (!this.drag) return;
      if (this.drag.type === 'handle') Object.assign(this.handles, this.drag.original);
      else this._restore(this.drag.original);
      this.drag = null;
      this.render();
      this.callbacks.onSelection?.();
    };

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', cancel);
    this.canvas.addEventListener('lostpointercapture', cancel);
  }

  /**
   * 画像座標 p に最も近い歯の境界を探す。
   *
   * 境界は歯列帯を横切る1本の線分として描かれているので、
   * 線分のどこをつかんでも反応するように、線分との距離で判定する。
   * （中心の小さなつまみだけを見ていたため、線の端のほうをつかんでも
   *  動かせないという不具合があった）
   */
  _hitBoundary(p, r) {
    const samples = this.detection.unrolled.samples;
    let best = null;
    for (const side of ['R', 'L']) {
      const dir = side === 'L' ? 1 : -1;
      const bounds = this.detection.sides[side].bounds;
      for (let i = 0; i < bounds.length; i++) {
        const sm = nearestSample(samples, bounds[i] * dir);
        if (!sm) continue;
        const seg = boundarySegment(sm);
        const d = distToSegment(p, seg.x0, seg.y0, seg.x1, seg.y1);
        if (d <= r && (!best || d < best.d)) best = { side, index: i, d };
      }
    }
    return best;
  }

  /** 境界を弧長方向に移動する（隣の境界を越えないよう制限） */
  _moveBoundary({ side, index }, p) {
    const samples = this.detection.unrolled.samples;
    const dir = side === 'L' ? 1 : -1;
    // ポインタに最も近いサンプルの弧長を採用
    let best = null;
    for (const sm of samples) {
      if (Math.sign(sm.s || dir) !== dir && sm.s !== 0) continue;
      const d = Math.hypot(sm.px - p.x, sm.py - p.y);
      if (!best || d < best.d) best = { d, s: Math.abs(sm.s) };
    }
    if (!best) return;
    const bounds = this.detection.sides[side].bounds;
    const lo = index > 0 ? bounds[index - 1] + 1 : 0;
    let hi = index < bounds.length - 1 ? bounds[index + 1] - 1 : Infinity;
    if (index === 0) hi = Math.min(hi, this.detection.sides[side === 'R' ? 'L' : 'R'].bounds[1] - 1);
    bounds[index] = Math.max(lo, Math.min(hi, best.s));
    if (index === 0) {
      // 正中側の境界は左右で共有する
      this.detection.sides[side === 'R' ? 'L' : 'R'].bounds[0] = bounds[0];
    }
  }

  render() {
    if (this.detailCanvas) this.detailCanvas.hidden = !this.selected || !this.detection;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (this.photo) ctx.drawImage(this.photo, 0, 0, W, H);
    if (!this.detection || !this.handles) return;

    if (this.showMask) this._drawMask(ctx, W, H);

    const samples = this.detection.unrolled.samples;
    const scale = W / 900;
    const lw = Math.max(1.4, 2.4 * scale);

    // 歯列帯の中心線（1歯ごとの凹凸をならして描く）
    ctx.strokeStyle = 'rgba(56, 220, 240, 0.85)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    smoothPath(samples, 8).forEach((p, i) =>
      (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();

    // 歯の境界と歯番
    const labels = [];
    for (const side of ['R', 'L']) {
      const dir = side === 'L' ? 1 : -1;
      const { bounds, positions } = this.detection.sides[side];
      for (let i = 0; i < bounds.length; i++) {
        const sm = nearestSample(samples, bounds[i] * dir);
        if (!sm) continue;
        const { x0, y0, x1, y1 } = boundarySegment(sm);
        const active = (this.hover?.type === 'bound'
          && this.hover.side === side && this.hover.index === i)
          || (this.selected?.side === side && this.selected.index === i);
        // つかめる範囲を示す太い帯（触れると色が変わる）
        ctx.strokeStyle = active ? 'rgba(56, 220, 240, 0.55)' : 'rgba(255, 255, 255, 0.22)';
        ctx.lineWidth = lw * 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.strokeStyle = i === 0 ? 'rgba(255, 214, 10, 0.95)' : 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = i === 0 ? lw * 1.6 : lw;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        // つまみ（線の両端と中央）
        ctx.fillStyle = active ? 'rgba(56, 220, 240, 0.95)' : 'rgba(255,255,255,0.95)';
        for (const [kx, ky] of [[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2], [x1, y1]]) {
          ctx.beginPath();
          ctx.arc(kx, ky, lw * 2.0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // 歯番ラベルは基準点より前面に描くので、位置だけ控えておく
      for (let i = 0; i < positions.length; i++) {
        const sc = ((bounds[i] + bounds[i + 1]) / 2) * dir;
        const sm = nearestSample(samples, sc);
        if (sm) labels.push({ text: String(positions[i]), x: sm.px, y: sm.py });
      }
    }

    // 基準3点
    for (const key of HANDLE_KEYS) {
      const h = this.handles[key];
      const r = Math.max(8, 13 * scale);
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.fillStyle = key === 'mid' ? 'rgba(255, 214, 10, 0.95)' : 'rgba(14, 116, 144, 0.95)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, 3 * scale);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      const fs = Math.max(11, 15 * scale);
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = fs * 0.3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(HANDLE_LABELS[key], h.x, h.y - r - 3);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(HANDLE_LABELS[key], h.x, h.y - r - 3);
    }

    // 歯番（基準点と重なっても読めるように最後に描く）
    const fsNum = Math.max(11, 17 * scale);
    ctx.font = `bold ${fsNum}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = fsNum * 0.32;
    for (const l of labels) {
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(l.text, l.x, l.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(l.text, l.x, l.y);
    }
    if (this.detailCanvas && this.selected) {
      const { side, index } = this.selected;
      const sm = nearestSample(samples, this.detection.sides[side].bounds[index] * (side === 'R' ? -1 : 1));
      if (sm) {
        const c = this.detailCanvas;
        const sw = Math.min(W, W / this.detailZoom, H * c.width / c.height);
        const sh = sw * c.height / c.width;
        const sx = Math.max(0, Math.min(W - sw, sm.px - sw / 2));
        const sy = Math.max(0, Math.min(H - sh, sm.py - sh / 2));
        c.getContext('2d').drawImage(this.canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
      }
    }
  }

  _drawMask(ctx, W, H) {
    const mask = this.detection.mask;
    if (!mask) return;
    const img = ctx.createImageData(W, H);
    for (let p = 0; p < mask.length; p++) {
      const i = p * 4;
      if (mask[p] === 1) {
        img.data[i] = 56; img.data[i + 1] = 220; img.data[i + 2] = 240; img.data[i + 3] = 70;
      }
    }
    ctx.putImageData(mergeOver(ctx, img, W, H), 0, 0);
  }
}

/** マスクの半透明オーバーレイを既存の描画に重ねる */
function mergeOver(ctx, overlay, W, H) {
  const base = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < base.data.length; i += 4) {
    const a = overlay.data[i + 3] / 255;
    if (a === 0) continue;
    base.data[i] = base.data[i] * (1 - a) + overlay.data[i] * a;
    base.data[i + 1] = base.data[i + 1] * (1 - a) + overlay.data[i + 1] * a;
    base.data[i + 2] = base.data[i + 2] * (1 - a) + overlay.data[i + 2] * a;
  }
  return base;
}

/** 描画用にサンプル点を移動平均で平滑化する */
function smoothPath(samples, r) {
  return samples.map((_, i) => {
    let sx = 0, sy = 0, c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(samples.length - 1, i + r); j++) {
      sx += samples[j].px; sy += samples[j].py; c++;
    }
    return { x: sx / c, y: sy / c };
  });
}

/** 境界の線分（歯列帯を横切る向き）の両端 */
function boundarySegment(sm) {
  return {
    x0: sm.px + sm.dx * (sm.rIn - sm.r),
    y0: sm.py + sm.dy * (sm.rIn - sm.r),
    x1: sm.px + sm.dx * (sm.rOut - sm.r),
    y1: sm.py + sm.dy * (sm.rOut - sm.r),
  };
}

/** 点と線分の距離 */
function distToSegment(p, x0, y0, x1, y1) {
  const ex = x1 - x0;
  const ey = y1 - y0;
  const len2 = ex * ex + ey * ey;
  const t = len2 > 0
    ? Math.max(0, Math.min(1, ((p.x - x0) * ex + (p.y - y0) * ey) / len2))
    : 0;
  return Math.hypot(p.x - (x0 + t * ex), p.y - (y0 + t * ey));
}

function nearestSample(samples, s) {
  let bi = null, bd = Infinity;
  for (const sm of samples) {
    const d = Math.abs(sm.s - s);
    if (d < bd) { bd = d; bi = sm; }
  }
  return bi;
}
