/**
 * arrange.js
 * 歯を「写真で測った位置」に置いたとき、隣り合う歯冠どうしが
 * 食い込まないように少しずつ押し分ける。
 *
 * 叢生の歯列では、歯は弧に沿って詰まりきれず、唇側（八重歯）や
 * 舌側（口蓋側の側切歯・舌側の下顎切歯）へ逃げている。写真から測った
 * 位置は数 mm の精度しかないので、そのまま置くと歯冠が互いに
 * めり込み、3D が一目で壊れて見える。
 *
 * ここでは各歯冠を咬合面から見た「向きのある超楕円」とみなし、
 * 重なった組を押し分ける。押す向きは、2 本がすでに唇舌的にずれて
 * いればその向き（叢生の見え方を強める向き）、並んでいれば弧に沿う向き。
 * 動かす量には上限があり、測った配置を大きく崩すことはない。
 */

/** 超楕円の指数（歯冠の咬合面外形に近い角の丸み） */
const N_EXP = 2.5;

/**
 * 点 (px, pz) が歯冠 t の外形のどれだけ内側にあるか。
 * 0 以下なら外側、正なら内側で、値はおおよその食い込み量(mm)。
 */
function insideDepth(t, px, pz) {
  const dx = px - t.x, dz = pz - t.z;
  const c = Math.cos(t.angle), s = Math.sin(t.angle);
  const u = dx * c + dz * s;       // 近遠心方向
  const v = -dx * s + dz * c;      // 頬舌方向
  const a = t.md / 2, b = t.bl / 2;
  const f = Math.pow(Math.abs(u) / a, N_EXP) + Math.pow(Math.abs(v) / b, N_EXP);
  if (f >= 1) return 0;
  const r = Math.hypot(u, v);
  // 半径方向に外形まで出るのに必要な距離（超楕円を半径方向に縮めた比で近似）
  return r * (Math.pow(f, -1 / N_EXP) - 1);
}

/** 歯冠 a の外周を K 点でたどり、b への最大の食い込み量を返す */
function penetration(a, b, K = 28) {
  const c = Math.cos(a.angle), s = Math.sin(a.angle);
  const ra = a.md / 2, rb = a.bl / 2;
  let best = 0;
  for (let k = 0; k < K; k++) {
    const th = (k / K) * Math.PI * 2;
    const ct = Math.cos(th), st = Math.sin(th);
    const u = ra * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / N_EXP);
    const v = rb * Math.sign(st) * Math.pow(Math.abs(st), 2 / N_EXP);
    const px = a.x + u * c - v * s;
    const pz = a.z + u * s + v * c;
    best = Math.max(best, insideDepth(b, px, pz));
  }
  return best;
}

/**
 * 重なった歯冠を押し分ける。
 *
 * @param {Array<{x:number, z:number, md:number, bl:number, angle:number,
 *                nx:number, nz:number, tx:number, tz:number,
 *                mobility?:number}>} items
 *   angle は近遠心軸の向き（ワールド xz 平面、ラジアン）。
 *   (nx, nz) はその位置での歯列弓の頬側向き単位ベクトル、
 *   (tx, tz) は弧に沿う向き。mobility は動かしやすさ（0〜1、大臼歯は小さく）。
 * @param {Array<[number, number]>} pairs 押し分けを調べる組（添字）
 * @param {object} [opt]
 * @param {number} [opt.iterations] 反復回数
 * @param {number} [opt.clearance]  残してよい食い込み(mm)
 * @param {number} [opt.maxShift]   1 歯を元の位置から動かしてよい上限(mm)
 * @returns {{items: Array, residual: number, moved: number}}
 *   items は x, z を更新した写し。residual は残った最大の食い込み(mm)
 */
export function relaxCollisions(items, pairs, opt = {}) {
  const iterations = opt.iterations ?? 60;
  const clearance = opt.clearance ?? 0.15;
  const maxShift = opt.maxShift ?? 2.5;
  const out = items.map((t) => ({ ...t, x0: t.x, z0: t.z }));
  let residual = 0;

  for (let it = 0; it < iterations; it++) {
    residual = 0;
    let any = false;
    for (const [i, j] of pairs) {
      const a = out[i], b = out[j];
      const reach = Math.max(a.md, a.bl) / 2 + Math.max(b.md, b.bl) / 2;
      if (Math.hypot(a.x - b.x, a.z - b.z) > reach) continue;
      const d = Math.max(penetration(a, b), penetration(b, a));
      if (d <= clearance) continue;
      residual = Math.max(residual, d);
      any = true;

      // 押す向き: 2 本の唇舌的なずれが大きければ唇舌方向、そうでなければ弧に沿う方向
      const nx = (a.nx + b.nx) / 2, nz = (a.nz + b.nz) / 2;
      const tx = (a.tx + b.tx) / 2, tz = (a.tz + b.tz) / 2;
      const dx = a.x - b.x, dz = a.z - b.z;
      const along = dx * tx + dz * tz;
      const across = dx * nx + dz * nz;
      let ux, uz;
      if (Math.abs(across) > 0.8 || Math.abs(across) > Math.abs(along) * 0.6) {
        const sg = across >= 0 ? 1 : -1;
        ux = nx * sg; uz = nz * sg;
      } else {
        const sg = along >= 0 ? 1 : -1;
        ux = tx * sg; uz = tz * sg;
      }
      const len = Math.hypot(ux, uz) || 1;
      ux /= len; uz /= len;

      const ma = a.mobility ?? 1, mb = b.mobility ?? 1;
      const sum = ma + mb || 1;
      // 1 回で全部押さず半分ずつ詰める（組が連鎖していても振動しない）
      const step = (d - clearance) * 0.5;
      a.x += ux * step * (ma / sum); a.z += uz * step * (ma / sum);
      b.x -= ux * step * (mb / sum); b.z -= uz * step * (mb / sum);
    }
    // 上限を超えて動いた歯は元の位置の周りに引き戻す
    for (const t of out) {
      const sx = t.x - t.x0, sz = t.z - t.z0;
      const m = Math.hypot(sx, sz);
      if (m > maxShift) {
        t.x = t.x0 + (sx / m) * maxShift;
        t.z = t.z0 + (sz / m) * maxShift;
      }
    }
    if (!any) break;
  }
  const moved = Math.max(0, ...out.map((t) => Math.hypot(t.x - t.x0, t.z - t.z0)));
  return { items: out.map(({ x0, z0, ...rest }) => rest), residual, moved };
}

/**
 * 片顎の歯（弧長 s の順に並べたもの）から、押し分けを調べる組を作る。
 * 隣り合う歯に加えて 1 本とばしの組も見る（転位歯が隣の隣と重なることがあるため）。
 */
export function neighbourPairs(sortedCount) {
  const pairs = [];
  for (let i = 0; i < sortedCount; i++) {
    if (i + 1 < sortedCount) pairs.push([i, i + 1]);
    if (i + 2 < sortedCount) pairs.push([i, i + 2]);
  }
  return pairs;
}
