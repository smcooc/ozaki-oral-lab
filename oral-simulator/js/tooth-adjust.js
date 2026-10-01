/**
 * tooth-adjust.js
 * 歯ごとの「治療前（現在）の位置」を手で直す機能。
 *
 * 咬合面写真からの計測は、歯の重なり・写りの悪さ・境界のずれで
 * 1 歯だけ位置や向きを読み違えることがある。その 1 歯のために撮り直すのは
 * 現実的でないので、読み違えた歯だけを先生が 3D を見ながら直せるようにする。
 *
 * 直した量は state.toothAdjust に持ち、シミュレーションの直前に
 * 計測値の各歯へ t.adjust として付け直す（setup.arrangeBefore が消費する）。
 * 治療後の排列は理想的な歯列弓に並べ直すため、手直しは治療前の状態だけを変える。
 *
 *   labial  … 唇（頬）側へ mm（− は舌側）
 *   distal  … 歯列に沿って遠心へ mm（− は近心）
 *   rotate  … 捻転 度（＋で遠心端が唇頬側へ回る。reconstruct3d と同じ規約）
 *   extrude … 挺出 mm（＋で咬合平面へ近づく。− は圧下）
 */

import { $ } from '../../shared/js/ui.js';
import { toothLabel, parseFdi, TOOTH_NAMES } from './tooth-library.js';

const KEYS = ['labial', 'distal', 'rotate', 'extrude'];

/**
 * 1 歯あたりの手直しの上限。
 * 写真の読み違いを直すための機能なので、これを超える量は入力ミスとみなす
 * （保存データの改ざん・破損で極端な値が入っても歯列が壊れないようにする）。
 */
export const ADJUST_LIMITS = { labial: 8, distal: 8, rotate: 45, extrude: 6 };

/** ボタン 1 回で動かす量 */
export const ADJUST_STEPS = { labial: 0.5, distal: 0.5, rotate: 5, extrude: 0.5 };

export function emptyToothAdjust() {
  return { upper: {}, lower: {} };
}

/** その顎の FDI 番号か（arch 省略時は上下どちらでもよい） */
export function validFdi(num, arch) {
  const n = Number(num);
  if (!Number.isInteger(n)) return false;
  const q = Math.floor(n / 10);
  const pos = n % 10;
  if (pos < 1 || pos > 8) return false;
  if (arch === 'upper') return q === 1 || q === 2;
  if (arch === 'lower') return q === 3 || q === 4;
  return q >= 1 && q <= 4;
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 1 歯ぶんの手直しを検証する。有限の数値だけを採り、上限で切る。
 * すべて 0（＝手直しなし）なら null を返す。
 */
export function sanitizeAdjust(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let any = false;
  for (const k of KEYS) {
    const v = raw[k];
    // 文字列の数値などは受け付けない（保存データの破損を見逃さないため）
    const val = typeof v === 'number' && Number.isFinite(v)
      ? Math.max(-ADJUST_LIMITS[k], Math.min(ADJUST_LIMITS[k], round2(v)))
      : 0;
    out[k] = val === 0 ? 0 : val;   // -0 を 0 にそろえる
    if (val !== 0) any = true;
  }
  return any ? out : null;
}

/** 片顎ぶん（{ fdi: adjust }）を検証する。その顎の歯でないものは捨てる。 */
export function sanitizeArchAdjust(raw, arch) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!validFdi(key, arch)) continue;
    const adj = sanitizeAdjust(val);
    if (adj) out[Number(key)] = adj;
  }
  return out;
}

/** 上下顎ぶんを検証する */
export function sanitizeToothAdjust(raw) {
  return {
    upper: sanitizeArchAdjust(raw?.upper, 'upper'),
    lower: sanitizeArchAdjust(raw?.lower, 'lower'),
  };
}

/** 手直しした歯の数 */
export function countAdjusted(toothAdjust) {
  return ['upper', 'lower']
    .reduce((n, arch) => n + Object.keys(toothAdjust?.[arch] ?? {}).length, 0);
}

/**
 * 手直しを計測値の各歯へ付け直す。
 *
 * 計測値は再計測・再検出・歯冠長の反映のたびに作り直され、そのたびに
 * t.adjust は消える。computeSetup の直前に毎回これを呼べば、どの経路で
 * 計測が変わっても手直しが漏れたり、消したはずの手直しが残ったりしない。
 */
export function applyToothAdjust(measurements, toothAdjust) {
  for (const arch of ['upper', 'lower']) {
    const m = measurements?.[arch];
    if (!m) continue;
    const map = toothAdjust?.[arch] ?? {};
    for (const t of m.teeth) {
      const a = map[t.fdi];
      if (a) t.adjust = { ...a };
      else delete t.adjust;
    }
  }
}

/** 前歯は「唇側」、臼歯は「頬側」と呼ぶ */
function faceWord(pos) {
  return pos <= 3 ? '唇側' : '頬側';
}

const fmtMm = (v) => `${Math.abs(v).toFixed(1)}mm`;

/**
 * 操作盤の各行。minus / plus はボタン（− 側 / ＋ 側）の表記、
 * value は現在値の表記。w は「唇側」「頬側」のどちらか。
 */
const ROWS = {
  labial: {
    minus: () => ['舌側へ', '0.5mm'],
    plus: (w) => [`${w}へ`, '0.5mm'],
    value: (v, w) => (v > 0 ? `${w} ${fmtMm(v)}` : `舌側 ${fmtMm(v)}`),
  },
  distal: {
    minus: () => ['近心へ', '0.5mm'],
    plus: () => ['遠心へ', '0.5mm'],
    value: (v) => (v > 0 ? `遠心 ${fmtMm(v)}` : `近心 ${fmtMm(v)}`),
  },
  rotate: {
    minus: (w) => ['捻転 −5°', `近心を${w}へ`],
    plus: (w) => ['捻転 +5°', `遠心を${w}へ`],
    value: (v, w) => (v > 0 ? `遠心が${w}へ ${Math.abs(v)}°` : `近心が${w}へ ${Math.abs(v)}°`),
  },
  extrude: {
    minus: () => ['圧下', '0.5mm'],
    plus: () => ['挺出', '0.5mm'],
    value: (v) => (v > 0 ? `挺出 ${fmtMm(v)}` : `圧下 ${fmtMm(v)}`),
  },
};

/** 一覧の並び（歯式と同じく 右上8 → 右上1・左上1 → 左上8、下顎も右から） */
function chartOrder(arch, teeth) {
  const q = arch === 'upper' ? [1, 2] : [4, 3];
  return [...teeth].sort((a, b) => {
    const qa = Math.floor(a.fdi / 10), qb = Math.floor(b.fdi / 10);
    if (qa !== qb) return q.indexOf(qa) - q.indexOf(qb);
    // 右側は奥歯から、左側は前歯から並べる
    return qa === q[0] ? b.pos - a.pos : a.pos - b.pos;
  });
}

/**
 * 3D ビューの下に置く手直しの操作盤。
 *
 * 歯は 3D 上でタップ（クリック）するか一覧から選ぶ。操作すると
 * 治療前（排列 0%）の表示に切り替え、直している位置がその場で見えるようにする。
 */
export class ToothAdjustUI {
  /**
   * @param {object} deps
   * @param {object} deps.state       アプリの状態（toothAdjust / measurements / setup / fitting）
   * @param {object} deps.viewer      OralViewer3D
   * @param {Function} deps.rerun     手直しを反映して 3D を作り直す
   * @param {Function} deps.showBefore 治療前（t=0）の表示に切り替える
   */
  constructor({ state, viewer, rerun, showBefore }) {
    this.state = state;
    this.viewer = viewer;
    this.rerun = rerun;
    this.showBefore = showBefore;
    this.selected = null;
    this.message = '';   // 一時的な知らせ（当てはめ中で操作できない、など）

    this.root = $('tooth-adjust');
    this.select = $('ta-select');
    this.panel = $('ta-panel');
    this.summary = $('ta-summary');
    this.hint = $('ta-hint');
    this.badge = $('ta-badge');

    this.select.addEventListener('change', () => {
      const v = Number(this.select.value);
      this.selectTooth(Number.isFinite(v) && v > 0 ? v : null);
    });
    this.root.querySelectorAll('[data-adj]').forEach((btn) => {
      btn.addEventListener('click', () => this.nudge(btn.dataset.adj, Number(btn.dataset.dir)));
    });
    $('ta-reset-tooth').addEventListener('click', () => this.resetTooth());
    $('ta-reset-all').addEventListener('click', () => this.resetAll());
    $('ta-close').addEventListener('click', () => this.selectTooth(null));

    // 3D 上のタップで歯を選ぶ。何もない所のタップでは選択を外さない
    // （回転させようとして指が少し触れただけで選択が消えると使いにくいため）。
    viewer.onPick = (num) => {
      if (num == null) return;
      this.selectTooth(num, { reveal: true });
    };
    this.refresh();
  }

  /** いまの計測に含まれる歯か */
  _toothOf(num) {
    if (num == null) return null;
    const { arch } = parseFdi(num);
    return this.state.measurements?.[arch]?.teeth.find((t) => t.fdi === num) ?? null;
  }

  /**
   * 歯を選ぶ（null で選択解除）。
   * @param {number|null} num FDI 番号
   * @param {{reveal?: boolean}} [opts]
   *   reveal: 操作ボタンが画面外なら見える所までスクロールする（3D 上でタップしたとき）。
   *   スマートフォンでは 3D と操作盤が縦に並ぶので、ボタンの列だけを最小限の
   *   スクロールで出し、3D の歯ができるだけ見えたまま操作できるようにする。
   */
  selectTooth(num, opts = {}) {
    this.selected = this._toothOf(num) ? num : null;
    this.message = '';
    this.viewer.setHighlight(this.selected);
    if (this.selected != null) this.root.open = true;
    this.render();
    if (opts.reveal && this.selected != null) {
      this.root.querySelector('.ta-grid')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /** 写真への当てはめ中は模型を作り直せない（当てはめが同じ模型を使っているため） */
  _busy() {
    if (!this.state.fitting) return false;
    this.message = '写真への当てはめが終わってから手直ししてください。';
    this.render();
    return true;
  }

  /** 選択中の歯を 1 段階動かす */
  nudge(key, dir) {
    const num = this.selected;
    if (num == null || !KEYS.includes(key) || !(dir === 1 || dir === -1) || this._busy()) return;
    const { arch } = parseFdi(num);
    const map = this.state.toothAdjust[arch];
    const cur = map[num] ?? { labial: 0, distal: 0, rotate: 0, extrude: 0 };
    const next = sanitizeAdjust({ ...cur, [key]: (cur[key] ?? 0) + dir * ADJUST_STEPS[key] });
    const prev = this._placement(num);
    if (next) map[num] = next;
    else delete map[num];
    this._apply();
    this._checkMoved(num, key, (next?.[key] ?? 0) - (cur[key] ?? 0), prev);
  }

  /** 治療前の配置（setup の before）。まだ計算していなければ null */
  _placement(num) {
    const { arch } = parseFdi(num);
    const p = this.state.setup?.[arch]?.before.find((b) => b.fdi === num);
    return p ? { dev: p.offsetMm, s: p.s, rot: p.rotationDeg, y: p.y } : null;
  }

  /**
   * 指定どおりに動いたかを確かめ、動かなかったら理由を知らせる。
   *
   * 治療前の配置では、歯列弓からの唇舌的なずれを ±6mm・捻転を ±40° に収め、
   * 重なった歯冠は押し分けている（setup.arrangeBefore）。そのため値を
   * 増やしても歯が動かないことがあり、黙っていると「ボタンが効かない」
   * 「表示の値と 3D が違う」と受け取られてしまう。
   */
  _checkMoved(num, key, want, prev) {
    const now = this._placement(num);
    if (!prev || !now || want === 0) return;
    const { arch } = parseFdi(num);
    const got = key === 'labial' ? now.dev - prev.dev
      : key === 'distal' ? Math.abs(now.s) - Math.abs(prev.s)
        : key === 'rotate' ? now.rot - prev.rot
          : (arch === 'upper' ? -1 : 1) * (now.y - prev.y);
    const unit = key === 'rotate' ? '°' : 'mm';
    if (Math.abs(got - want) <= (key === 'rotate' ? 1 : 0.2)) return;
    const f = (v) => (key === 'rotate' ? v.toFixed(0) : v.toFixed(1));
    this.message = `指定した ${f(want)}${unit} に対し、実際には ${f(got)}${unit} 動きました。`
      + '治療前の歯は、歯列弓からのずれを ±6mm・捻転を ±40° までとし、'
      + '隣の歯と重なる分は押し戻して並べています。';
    this.render();
  }

  /** 選択中の歯の手直しを取り消す */
  resetTooth() {
    const num = this.selected;
    if (num == null || this._busy()) return;
    const { arch } = parseFdi(num);
    if (!this.state.toothAdjust[arch][num]) return;
    delete this.state.toothAdjust[arch][num];
    this._apply();
  }

  /** すべての歯の手直しを取り消す */
  resetAll() {
    if (!countAdjusted(this.state.toothAdjust) || this._busy()) return;
    this.state.toothAdjust.upper = {};
    this.state.toothAdjust.lower = {};
    this._apply();
  }

  /** 手直しを反映する。直した位置が見えるよう治療前の表示に切り替える。 */
  _apply() {
    this.message = '';
    this.showBefore();
    this.rerun();
    this.render();
  }

  /**
   * 計測・3D が作り直されたあとに呼ぶ。
   * 選んでいた歯が無くなっていたら（欠損に指定した・別の写真にした）選択を外す。
   */
  refresh() {
    if (this.selected != null && !this._toothOf(this.selected)) this.selected = null;
    this.viewer.setHighlight(this.selected);
    this._buildOptions();
    this.render();
  }

  /** 一覧の表記（手直し中の歯には印を付ける） */
  _optionText(num) {
    const { arch, pos } = parseFdi(num);
    const mark = this.state.toothAdjust[arch]?.[num] ? '（手直し中）' : '';
    return `${toothLabel(num)} ${TOOTH_NAMES[pos]}${mark}`;
  }

  _buildOptions() {
    const sel = this.select;
    const keep = this.selected;
    const option = (text, value) => {
      const o = document.createElement('option');
      o.textContent = text;
      o.value = value;
      return o;
    };
    sel.replaceChildren();
    const any = !!(this.state.measurements?.upper || this.state.measurements?.lower);
    sel.appendChild(option(any ? '歯を選ぶ（3Dの歯をタップしても選べます）' : '写真を取り込むと選べます', ''));
    for (const arch of ['upper', 'lower']) {
      const m = this.state.measurements?.[arch];
      if (!m) continue;
      const group = document.createElement('optgroup');
      group.label = arch === 'upper' ? '上顎' : '下顎';
      for (const t of chartOrder(arch, m.teeth)) group.appendChild(option(this._optionText(t.fdi), String(t.fdi)));
      sel.appendChild(group);
    }
    sel.disabled = !any;
    sel.value = keep != null ? String(keep) : '';
  }

  /** 操作盤の表示を状態に合わせる */
  render() {
    const num = this.selected;
    const n = countAdjusted(this.state.toothAdjust);
    this.summary.textContent = n ? `・${n}歯を手直し中` : '';
    $('ta-reset-all').disabled = n === 0;
    this.select.value = num != null ? String(num) : '';
    // 一覧の「（手直し中）」の印を付け直す
    for (const opt of this.select.options) {
      const v = Number(opt.value);
      if (!(v > 0)) continue;
      const text = this._optionText(v);
      if (opt.textContent !== text) opt.textContent = text;
    }

    const resetTooth = $('ta-reset-tooth');
    if (num == null) {
      this.panel.hidden = true;
      this.badge.hidden = true;
      resetTooth.hidden = true;
      const list = ['upper', 'lower'].flatMap((arch) =>
        Object.keys(this.state.toothAdjust[arch] ?? {}).map((k) => toothLabel(Number(k))));
      this.hint.hidden = false;
      this.hint.textContent = this.message || (list.length
        ? `手直し中: ${list.join('・')}。歯を選ぶと内容を確認・変更できます。`
        : '写真からの計測がずれている歯だけ、治療前（現在）の位置を手で直せます。'
          + '3Dの歯をタップするか、一覧から選んでください。治療後の排列は変わりません。');
      return;
    }

    const { arch, pos } = parseFdi(num);
    const w = faceWord(pos);
    const adj = this.state.toothAdjust[arch]?.[num] ?? null;
    this.panel.hidden = false;
    this.badge.hidden = false;
    this.badge.textContent = `${toothLabel(num)} を選択中`;
    $('ta-label').textContent = toothLabel(num);
    $('ta-name').textContent = `${arch === 'upper' ? '上顎' : '下顎'}${TOOTH_NAMES[pos]}`;
    // 選択中は現在値をボタンの間に出すので、説明文は知らせることがあるときだけ出す
    // （スマートフォンで 3D とボタンを同じ画面に収めるため）
    this.hint.hidden = !this.message;
    this.hint.textContent = this.message;
    for (const key of KEYS) {
      const v = adj?.[key] ?? 0;
      const row = ROWS[key];
      const valEl = $(`ta-val-${key}`);
      valEl.textContent = v === 0 ? '±0' : row.value(v, w);
      valEl.classList.toggle('is-set', v !== 0);
      for (const [dir, make] of [[-1, row.minus], [1, row.plus]]) {
        const btn = this.root.querySelector(`[data-adj="${key}"][data-dir="${dir}"]`);
        const [main, sub] = make(w);
        btn.querySelector('.ta-main').textContent = main;
        btn.querySelector('.ta-sub').textContent = sub;
        btn.disabled = dir > 0 ? v >= ADJUST_LIMITS[key] : v <= -ADJUST_LIMITS[key];
      }
    }
    resetTooth.hidden = false;
    resetTooth.disabled = !adj;
  }
}
