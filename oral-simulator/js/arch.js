/**
 * arch.js
 * 歯列弓（アーチフォーム）の数学モデル。
 *
 * アーチ座標系（mm）:
 *   +x : 患者の左側      （正中が x=0）
 *   +z : 前方（唇側）    （後方が −z）
 *   +y : 上方            （咬合平面が y=0）
 *
 * 歯列弓は歯冠中心を通る対称な4次曲線で表す（矯正学で用いられる
 * beta curve / catenary の近似）:
 *
 *   z(x) = zAnt − a·x² − b·x⁴      （a, b ≥ 0）
 *
 * zAnt は正中における前方位置（＝中切歯の唇舌的位置）で、
 * 前歯の前後的移動量はこの zAnt の差として表される。
 */

const X_MAX = 42;       // 片側の最大 x（mm）
const X_STEP = 0.1;     // 弧長テーブルの刻み

export class ArchCurve {
  /**
   * @param {number} zAnt 正中における前方位置(mm)
   * @param {number} a    2次係数
   * @param {number} b    4次係数
   */
  constructor(zAnt, a, b) {
    this.zAnt = zAnt;
    this.a = Math.max(0, a);
    this.b = Math.max(0, b);
    this._buildTable();
  }

  _buildTable() {
    const n = Math.round(X_MAX / X_STEP) + 1;
    const s = new Float64Array(n);
    let acc = 0;
    let prevD = this._slope(0);
    for (let i = 1; i < n; i++) {
      const x = i * X_STEP;
      const d = this._slope(x);
      // 台形則で ∫ sqrt(1 + z'^2) dx
      acc += (Math.sqrt(1 + prevD * prevD) + Math.sqrt(1 + d * d)) / 2 * X_STEP;
      s[i] = acc;
      prevD = d;
    }
    this._sTable = s;
  }

  _slope(x) {
    return -(2 * this.a * x + 4 * this.b * x * x * x);
  }

  /** x における前後位置 */
  z(x) {
    const ax = Math.abs(x);
    return this.zAnt - this.a * ax * ax - this.b * Math.pow(ax, 4);
  }

  /** 正中からの符号付き弧長（+ が患者左側） */
  arcAt(x) {
    const ax = Math.min(X_MAX, Math.abs(x));
    const i = ax / X_STEP;
    const i0 = Math.min(this._sTable.length - 2, Math.floor(i));
    const f = i - i0;
    const v = this._sTable[i0] * (1 - f) + this._sTable[i0 + 1] * f;
    return Math.sign(x) * v;
  }

  /** 符号付き弧長 s に対応する x */
  xAt(s) {
    const as = Math.abs(s);
    const tbl = this._sTable;
    const last = tbl[tbl.length - 1];
    if (as >= last) return Math.sign(s) * X_MAX;
    // 単調増加なので二分探索
    let lo = 0, hi = tbl.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tbl[mid] <= as) lo = mid; else hi = mid;
    }
    const span = tbl[hi] - tbl[lo];
    const f = span > 1e-9 ? (as - tbl[lo]) / span : 0;
    return Math.sign(s) * (lo + f) * X_STEP;
  }

  /** 弧長 s の位置（接線方向が必要な場合は frameAt() を使う） */
  pointAt(s) {
    const x = this.xAt(s);
    return { x, z: this.z(x) };
  }

  /** 弧長 s における歯列弓の幅径（左右対称とみなした 2|x|） */
  widthAt(s) {
    return 2 * Math.abs(this.xAt(s));
  }

  /** 正中位置だけを変えた新しい曲線 */
  withAnterior(zAnt) {
    return new ArchCurve(zAnt, this.a, this.b);
  }

  toJSON() {
    return { zAnt: this.zAnt, a: this.a, b: this.b };
  }
}

/**
 * 接線方向（歯の近遠心軸）の単位ベクトルと頬側法線を返す。
 * @param {ArchCurve} curve
 * @param {number} s 符号付き弧長
 * @returns {{x, z, tx, tz, nx, nz}} t = 遠心方向の単位ベクトル, n = 頬側方向
 */
export function frameAt(curve, s) {
  const eps = 0.25;
  const x0 = curve.xAt(s - eps);
  const x1 = curve.xAt(s + eps);
  const p0 = { x: x0, z: curve.z(x0) };
  const p1 = { x: x1, z: curve.z(x1) };
  let tx = p1.x - p0.x;
  let tz = p1.z - p0.z;
  const len = Math.hypot(tx, tz) || 1;
  tx /= len; tz /= len;
  // s が増える向き（患者左→後方）が「遠心」。法線は外向き（頬側）。
  // 歯列弓は上に凸（前方が +z）なので、外向き法線は (tz, -tx) を
  // 原点から離れる向きに整える。
  let nx = tz;
  let nz = -tx;
  const x = curve.xAt(s);
  const z = curve.z(x);
  const cz = curve.zAnt - 25; // 歯列弓のおおよその中心
  if (nx * (x - 0) + nz * (z - cz) < 0) { nx = -nx; nz = -nz; }
  return { x, z, tx, tz, nx, nz };
}

/**
 * 計測した歯冠中心点群に対称な4次曲線を最小二乗フィットする。
 * @param {{x:number, z:number}[]} pts
 * @returns {ArchCurve}
 */
export function fitArchCurve(pts) {
  // z = zAnt·1 + a·(−x²) + b·(−x⁴) → 3変数の線形最小二乗
  const basis = pts.map((p) => {
    const x2 = p.x * p.x;
    return [1, -x2, -x2 * x2];
  });
  const coef = solveLeastSquares(basis, pts.map((p) => p.z), 3);
  let [zAnt, a, b] = coef;
  if (!Number.isFinite(zAnt)) return new ArchCurve(25, 0.022, 2e-6);
  // 係数が異常な場合（点数が少ない・並びが直線的）は4次項を落として再フィット
  if (!(a > 0) || !Number.isFinite(a) || b < -1e-5) {
    const basis2 = pts.map((p) => [1, -p.x * p.x]);
    const c2 = solveLeastSquares(basis2, pts.map((p) => p.z), 2);
    zAnt = c2[0];
    a = Math.max(0.005, c2[1]);
    b = 0;
  }
  // 係数の下限は「人の歯列弓としてありうる曲がり」に合わせる。
  // 0.004 では臼歯部でも深さが 2mm 程度にしかならず、
  // 検出が乱れた写真で「歯が一直線に並んだ」模型ができてしまっていた。
  return new ArchCurve(zAnt, Math.max(0.018, a), Math.max(0, b));
}

/**
 * 当てはめた歯列弓が人のものとしてありうる形かを調べる。
 *
 * 検出が乱れた写真では歯の中心が直線的に並び、最小二乗が
 * ほとんど曲がっていない弓を返すことがある。そのまま3Dにすると
 * 「歯が一直線に並んだ」模型になるため、ここで弾いて標準形に差し替える。
 *
 * @param {ArchCurve} curve
 * @param {{x:number, z:number}[]} pts
 * @returns {{ok: boolean, depth: number, xMax: number, rms: number}}
 */
export function archPlausibility(curve, pts) {
  let xMax = 0;
  for (const p of pts) xMax = Math.max(xMax, Math.abs(p.x));
  const depth = curve.z(0) - curve.z(xMax);
  let sum = 0;
  for (const p of pts) {
    const d = p.z - curve.z(p.x);
    sum += d * d;
  }
  const rms = pts.length ? Math.sqrt(sum / pts.length) : Infinity;
  // 最後方歯の位置での深さは、その半幅と同程度（おおむね 0.8〜1.3 倍）になる。
  // 半分を下回るものは歯列弓として認めない。
  const ok = xMax > 8 && depth >= xMax * 0.5 && rms < 7;
  return { ok, depth, xMax, rms };
}

/**
 * 犬歯部・大臼歯部の幅径と深径からアーチフォームを作る。
 * @param {object} p
 * @param {number} p.zAnt      正中の前方位置(mm)
 * @param {number} p.canineHalf 犬歯部の片側幅(mm)
 * @param {number} p.canineDepth 正中〜犬歯の前後的深さ(mm)
 * @param {number} p.molarHalf  大臼歯部の片側幅(mm)
 * @param {number} p.molarDepth 正中〜大臼歯の前後的深さ(mm)
 */
export function curveFromWidths({ zAnt, canineHalf, canineDepth, molarHalf, molarDepth }) {
  const xc = Math.max(1, canineHalf);
  const xm = Math.max(xc + 1, molarHalf);
  const xc2 = xc * xc, xm2 = xm * xm;
  const det = xc2 * xm2 * xm2 - xm2 * xc2 * xc2;
  let a, b;
  if (Math.abs(det) < 1e-9) {
    a = canineDepth / xc2;
    b = 0;
  } else {
    a = (canineDepth * xm2 * xm2 - molarDepth * xc2 * xc2) / det;
    b = (molarDepth * xc2 - canineDepth * xm2) / det;
  }
  if (!(a > 0) || !(b >= 0) || !Number.isFinite(a) || !Number.isFinite(b)) {
    // 与えられた幅径と深さが 4 次曲線（a, b ≥ 0）で表せない場合は
    // 大臼歯部を通る 2 次曲線で近似する
    a = Math.max(0.005, molarDepth / (xm * xm));
    b = 0;
  }
  return new ArchCurve(zAnt, a, Math.max(0, b));
}

/**
 * アーチフォームのテンプレート（歯冠中心を通る曲線の代表値, mm）
 *
 * canineW / molarW : 犬歯中心間・第一大臼歯中心間の幅径
 * canineD / molarD : 中切歯の切縁からの前後的な深さ
 *
 * z(x) = zAnt − a·x² − b·x⁴ を a, b ≥ 0 で満たすには
 * （深さ ÷ 幅の二乗）が犬歯部より大臼歯部で大きい必要がある。
 * 下の値はいずれもこの条件を満たしている。
 */
export const ARCH_TEMPLATES = {
  patient: { label: '患者固有（現在の歯列弓を維持）' },
  tapered: {
    label: 'テーパード（狭窄型）',
    upper: { canineW: 31.0, canineD: 8.2, molarW: 42.0, molarD: 26.0 },
    lower: { canineW: 25.0, canineD: 6.4, molarW: 39.0, molarD: 24.5 },
  },
  ovoid: {
    label: 'オボイド（卵円型）',
    upper: { canineW: 34.0, canineD: 8.6, molarW: 46.0, molarD: 26.0 },
    lower: { canineW: 26.5, canineD: 6.6, molarW: 42.0, molarD: 24.5 },
  },
  square: {
    label: 'スクエア（方形型）',
    upper: { canineW: 37.0, canineD: 9.0, molarW: 50.0, molarD: 26.5 },
    lower: { canineW: 29.0, canineD: 6.8, molarW: 45.0, molarD: 24.5 },
  },
};

/** テンプレートからアーチフォームを作る */
export function templateCurve(templateId, arch, zAnt) {
  const t = ARCH_TEMPLATES[templateId]?.[arch];
  if (!t) return null;
  return curveFromWidths({
    zAnt,
    canineHalf: t.canineW / 2,
    canineDepth: t.canineD,
    molarHalf: t.molarW / 2,
    molarDepth: t.molarD,
  });
}

// ---------------------------------------------------------------------------
// 線形最小二乗（正規方程式 + ガウスの消去法）
// ---------------------------------------------------------------------------
function solveLeastSquares(rows, ys, k) {
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let r = 0; r < rows.length; r++) {
    const br = rows[r];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += br[i] * br[j];
      A[i][k] += br[i] * ys[r];
    }
  }
  // ガウスの消去法
  for (let i = 0; i < k; i++) {
    let piv = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-12) return new Array(k).fill(NaN);
    if (piv !== i) { const t = A[i]; A[i] = A[piv]; A[piv] = t; }
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c];
    }
  }
  return Array.from({ length: k }, (_, i) => A[i][k] / A[i][i]);
}

/**
 * オーバーバイト（上顎前歯が下顎前歯を覆う量）を歯種ごとにどれだけ効かせるか。
 *
 * 切歯は全量、犬歯は半分強、第一小臼歯はわずか、それより後方は 0。
 * 以前は歯列の弧長の割合で減衰させていたため、歯列の長さや叢生の程度で
 * 犬歯・小臼歯まで下がり、下顎の歯とめり込んでいた。
 * setup.js（歯の配置）と fitting.js（写真への当てはめ）で必ず同じ値を使う。
 */
export function overbiteWeight(pos) {
  return pos === 1 || pos === 2 ? 1 : pos === 3 ? 0.6 : pos === 4 ? 0.15 : 0;
}
