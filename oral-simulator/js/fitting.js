/**
 * fitting.js
 * 複数方向から撮った口腔内写真に3Dモデルを当てはめる（多視点フィッティング）。
 *
 * 咬合面観からは歯列弓の形と近遠心幅径しか分からない。
 * 正面観・側方観を加えて「モデルを各写真の向きに投影したシルエット」と
 * 「写真から切り出した歯のシルエット」が一致するようにパラメータを探索すると、
 * 咬合面観だけでは決まらない
 *   ・歯冠長（歯がどれだけ見えているか）
 *   ・オーバーバイト（上顎前歯が下顎前歯を覆う量）
 *   ・スピー彎曲の深さ
 *   ・開口量（口を開けて撮った写真の場合）
 * を写真から求められる。いわゆる analysis-by-synthesis（解析による合成）で、
 * 特徴点の対応づけを必要としないため、歯のように模様の乏しい対象でも安定する。
 *
 * カメラは弱透視投影（scaled orthographic）で近似する。
 * 口腔内の接写では厳密には透視投影だが、焦点距離が未知のまま透視を解くと
 * 不定性が強く出るため、安定性を優先している。
 */

import { overbiteWeight } from './arch.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// フィッティング用のモデル
// ---------------------------------------------------------------------------

/**
 * 構築済みの3Dモデルから、投影計算だけに必要な最小限のデータを取り出す。
 * three.js のオブジェクトに触らずに済むので、計算が軽く、テストもしやすい。
 *
 * @param {{upper: object|null, lower: object|null}} models buildArchModel の結果
 * @param {object} registration setup.computeSetup の registration
 * @returns {{teeth: Array, sMax: number}}
 */
export function buildFitModel(models, registration) {
  const teeth = [];
  let sMax = 1;
  for (const arch of ['upper', 'lower']) {
    const model = models[arch];
    if (!model) continue;
    const reg = registration?.[arch] ?? { y: 0, z: 0 };
    for (const tooth of model.teeth) {
      const geom = tooth.mesh.geometry;
      const pos = geom.getAttribute('position');
      const q = tooth.before.quaternion;
      const p = tooth.before.position;
      // シルエットは凸包で決まるため、全頂点を投影する必要はない。
      // 間引いても輪郭はごくわずかしか縮まず、その差は拡大率に吸収される。
      // シルエットは凸包で決まるので、頂点を増やしても当てはめの精度は
      // 上がらない一方、凸包の計算量だけが増える。歯冠メッシュを
      // 高解像度にしたぶんは間引いて、1歯あたりの点数を一定に保つ。
      const verts = decimate(pos.array, Math.max(2, Math.round(pos.count / 140)));
      const quat = [q.x, q.y, q.z, q.w];
      // 歯冠長の伸縮は局所 y にだけ掛かり、クォータニオンの回転は線形なので
      //   回転(vx, vy·k, vz) = 回転(vx, 0, vz) + k·回転(0, vy, 0)
      // と分けられる。当てはめのたびに何万回も回す内側のループから
      // クォータニオンの計算と配列の確保をなくすため、ここで一度だけ求めておく。
      const base = new Float32Array(verts.length);
      const up = new Float32Array(verts.length);
      const tmp = [0, 0, 0];
      for (let i = 0; i < verts.length; i += 3) {
        let r = applyQuat([verts[i], 0, verts[i + 2]], quat);
        base[i] = r[0]; base[i + 1] = r[1]; base[i + 2] = r[2];
        tmp[0] = 0; tmp[1] = verts[i + 1]; tmp[2] = 0;
        r = applyQuat(tmp, quat);
        up[i] = r[0]; up[i + 1] = r[1]; up[i + 2] = r[2];
      }
      teeth.push({
        arch,
        pos: tooth.pos,
        side: tooth.side,
        s: tooth.sBefore,
        vertexCount: verts.length / 3,
        base,
        up,
        // 傾斜を写真から解くときに、歯ごとの回転をやり直せるようにしておく
        verts,
        quat,
        mdSign: tooth.mdSign ?? 1,
        tilt: { torque: 0, tip: 0 },
        // 凸包の書き出し先。当てはめのたびに確保しないよう歯ごとに持たせる
        hullX: new Float64Array(verts.length / 3),
        hullY: new Float64Array(verts.length / 3),
        hullOrder: Int32Array.from({ length: verts.length / 3 }, (_, i) => i),
        hullN: 0,
        origin: [p.x, p.y + (reg.y ?? 0), p.z + (reg.z ?? 0)],
      });
      sMax = Math.max(sMax, Math.abs(tooth.sBefore));
    }
  }
  return { teeth, sMax };
}

/** 頂点配列を stride 個おきに間引く */
function decimate(arr, stride) {
  const n = Math.floor(arr.length / 3);
  const out = new Float32Array(Math.ceil(n / stride) * 3);
  let k = 0;
  for (let i = 0; i < n; i += stride) {
    out[k++] = arr[i * 3];
    out[k++] = arr[i * 3 + 1];
    out[k++] = arr[i * 3 + 2];
  }
  return out.subarray(0, k);
}

/**
 * 既定の形態パラメータ（写真から求める値）。
 *
 * 歯列弓そのものの形は、ここでは連続値として扱わない。
 * 歯の位置を横方向に伸縮させると隣接歯の接触が壊れてしまううえ、
 * 見かけの大きさ（カメラの距離）とまぎれて写真からは決まらないためである。
 * 咬合面観がない場合は、arch.js のアーチフォーム（テーパード／オボイド／
 * スクエア）を歯列ごと作り直して当てはめ、もっとも合うものを選ぶ
 * （app.js の runFitting を参照）。
 */
export function defaultShape(plan) {
  return {
    crownHeightScale: 1,
    overbiteDelta: 0,   // 現在の設定値からの差(mm)
    speeDelta: 0,       // 現在の設定値からの差(mm)
    archShiftZ: 0,      // 下顎歯列の前後的なずれ(mm, ＋が前方)。オーバージェットに対応
    jawOpening: 0,      // 開口角(度)。開口して撮った写真で使う
    _overbite: plan?.occlusion?.overbite ?? 2.5,
  };
}

/**
 * 既定の視点（写真の種類ごとの初期値）。
 *
 * 咬合位（噛み合わせた状態）と開口位（上下を離した状態）を分けている。
 * 咬合位の写真は上下顎の前後的な関係（オーバージェット・臼歯関係）を、
 * 開口位の写真は上下それぞれの歯列の形を見るのに向く。
 * open は撮影時の開口角の初期値（度）。
 */
export const VIEW_INIT = {
  frontal: { yaw: 0, pitch: 0, roll: 0, open: 0, label: '正面観（咬合位）' },
  rightBuccal: { yaw: 62 * DEG, pitch: 0, roll: 0, open: 0, label: '右側方観（咬合位）' },
  leftBuccal: { yaw: -62 * DEG, pitch: 0, roll: 0, open: 0, label: '左側方観（咬合位）' },
  // 7枚法で加わる真横（90°）。側方観より回り込んでいるぶん、
  // 上下顎の前後的な関係（臼歯関係）がいちばんよく写る。
  rightLateral: { yaw: 90 * DEG, pitch: 0, roll: 0, open: 0, label: '右側方観（真横90°）' },
  leftLateral: { yaw: -90 * DEG, pitch: 0, roll: 0, open: 0, label: '左側方観（真横90°）' },
  frontalOpen: { yaw: 0, pitch: 0, roll: 0, open: 14, label: '正面観（開口位）' },
  rightBuccalOpen: { yaw: 62 * DEG, pitch: 0, roll: 0, open: 14, label: '右側方観（開口位）' },
  leftBuccalOpen: { yaw: -62 * DEG, pitch: 0, roll: 0, open: 14, label: '左側方観（開口位）' },
};

/** 咬合位（噛み合わせた状態）で撮った視点か */
export function isOccludedView(key) {
  return !!VIEW_INIT[key] && (VIEW_INIT[key].open ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// 投影とラスタライズ
// ---------------------------------------------------------------------------

/** クォータニオンをその場で適用する（[x,y,z,w]） */
function applyQuat(v, q) {
  const [qx, qy, qz, qw] = q;
  const ix = qw * v[0] + qy * v[2] - qz * v[1];
  const iy = qw * v[1] + qz * v[0] - qx * v[2];
  const iz = qw * v[2] + qx * v[1] - qy * v[0];
  const iw = -qx * v[0] - qy * v[1] - qz * v[2];
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/**
 * その歯の「原点のずれ」を形態パラメータから求める（頂点によらない定数）。
 *
 * スピー彎曲・オーバーバイト・上下顎の前後関係は、いずれも歯を丸ごと
 * 平行移動させるだけなので、頂点ごとに計算する必要がない。
 */
function toothOffset(out, tooth, shape, sMax) {
  let dy = 0;
  let dz = 0;
  const u = Math.min(1, Math.abs(tooth.s) / sMax);
  // スピー彎曲の深さの変化（上下顎とも咬合面が同じだけ動く）
  if (shape.speeDelta) dy -= shape.speeDelta * 4 * u * (1 - u);
  // オーバーバイトの変化（上顎前歯だけが下方に伸びる。歯種ごとの効き方は setup と同じ）
  if (shape.overbiteDelta && tooth.arch === 'upper') {
    dy -= shape.overbiteDelta * overbiteWeight(tooth.pos);
  }
  // 上下顎の前後的な関係（オーバージェット・臼歯関係）。
  // 側方から撮った写真では、上下の歯列の前後のずれとして直接見える。
  if (shape.archShiftZ && tooth.arch === 'lower') dz += shape.archShiftZ;
  out[0] = tooth.origin[0];
  out[1] = tooth.origin[1] + dy;
  out[2] = tooth.origin[2] + dz;
}

/**
 * 投影に使う「視点の行列」を歯列ごとに作る。
 *
 * 開口は下顎を顆頭まわりに回す剛体運動なので、視点の回転とまとめて
 * 1つの 3x3 行列＋平行移動に畳み込める。こうすると内側のループでは
 * 頂点あたり 9 回の積和だけで済み、開口の有無で分岐しなくてよくなる。
 *
 * @returns {{m: number[], c: number[]}} X = m[0..2]·w + c[0], Y = m[3..5]·w + c[1],
 *   depth = m[6..8]·w + c[2]
 */
function viewTransform(R, jawOpening) {
  if (!jawOpening) return { m: R, c: [0, 0, 0] };
  const a = jawOpening * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const hy = 35;
  const hz = -95;      // 顆頭のおおよその位置（切縁を原点とした mm）
  // 開口の回転（y-z 平面）: y' = ca·y − sa·z, z' = sa·y + ca·z, 平行移動 t
  const t = [0, hy - (ca * hy - sa * hz), hz - (sa * hy + ca * hz)];
  const m = new Array(9);
  for (let r = 0; r < 3; r++) {
    const r0 = R[r * 3];
    const r1 = R[r * 3 + 1];
    const r2 = R[r * 3 + 2];
    m[r * 3] = r0;
    m[r * 3 + 1] = r1 * ca + r2 * sa;
    m[r * 3 + 2] = -r1 * sa + r2 * ca;
  }
  const c = [
    R[0] * t[0] + R[1] * t[1] + R[2] * t[2],
    R[3] * t[0] + R[4] * t[1] + R[5] * t[2],
    R[6] * t[0] + R[7] * t[1] + R[8] * t[2],
  ];
  return { m, c };
}

/** 姿勢（オイラー角）から回転行列を作る: R = Rz(roll)·Rx(pitch)·Ry(yaw) */
function rotationMatrix(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // Ry
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  // Rx
  const rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  // Rz
  const rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  return mul3(rz, mul3(rx, ry));
}

function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

/**
 * モデルのシルエットを描く（歯冠のみ。写真側のマスクも歯だけなので対応する）。
 *
 * 歯ごとに投影点の凸包を求めて塗りつぶす。歯冠を正面や側方から見た輪郭は
 * ほぼ凸なので、三角形を1枚ずつ塗るより速く、画素の取りこぼしも起きない。
 *
 * 上顎・下顎を別々のマスクとしても返す。両者の境界（咬合線）の位置は
 * オーバーバイトとスピー彎曲によって決まるため、合成したシルエットだけを
 * 比べていてもこの2つは求まらない。
 *
 * さらに、隣り合う歯どうしの境目（隣接面：写真では暗い縦線として写る）を
 * `edges` として返す。シルエットの外形は上下の歯列を前後にすべらせても
 * ほとんど変わらないため、上下顎の前後的な関係はこの縦線の並びでしか
 * 見分けられない。臼歯関係を目で読むときに咬頭と溝の位置を見るのと同じ。
 *
 * @returns {{union: Uint8Array, upper: Uint8Array, lower: Uint8Array,
 *            edges: Uint8Array, label: Int16Array, order: Int32Array, depths: Float64Array}}
 */
export function rasterizeArches(fitModel, pose, shape, W, H) {
  const R = rotationMatrix(pose.yaw, pose.pitch, pose.roll);
  // 開口量は写真ごとの撮影状態なので姿勢側に持つ（形態側は後方互換のための控え）
  const open = pose.jawOpening ?? shape.jawOpening ?? 0;
  const view = { upper: viewTransform(R, 0), lower: viewTransform(R, open) };
  const off = [0, 0, 0];
  const teeth = fitModel.teeth;
  const nT = teeth.length;
  const k = shape.crownHeightScale;
  const { tx, ty, scale } = pose;
  const depths = scratchDepths(nT);
  const order = new Int32Array(nT);

  for (let t = 0; t < nT; t++) {
    const tooth = teeth[t];
    const { base, up, vertexCount: n, hullX, hullY } = tooth;
    const { m, c } = view[tooth.arch];
    toothOffset(off, tooth, shape, fitModel.sMax);
    const ox = off[0], oy = off[1], oz = off[2];
    const [px, py] = scratchPoints(n);
    let depth = 0;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const wx = base[j] + k * up[j] + ox;
      const wy = base[j + 1] + k * up[j + 1] + oy;
      const wz = base[j + 2] + k * up[j + 2] + oz;
      const X = m[0] * wx + m[1] * wy + m[2] * wz + c[0];
      const Y = m[3] * wx + m[4] * wy + m[5] * wz + c[1];
      depth += m[6] * wx + m[7] * wy + m[8] * wz + c[2];
      px[i] = tx + scale * X;
      py[i] = ty - scale * Y;
    }
    tooth.hullN = convexHullFlat(px, py, n, hullX, hullY, tooth.hullOrder);
    depths[t] = depth / Math.max(1, n);
    order[t] = t;
  }

  // 奥にある歯から手前の歯へ順に塗る（画家のアルゴリズム）。
  // 「上顎がいつも手前」と決めてしまうと、下顎が前に出ている症例
  // （反対咬合・骨格性III級）で前後関係が写真から求まらなくなる。
  // 側方から見たときに手前側の歯列が奥側を隠すのも、これで自然に再現される。
  order.sort((a, b) => depths[a] - depths[b]);
  const label = new Int16Array(W * H);
  const archOf = new Uint8Array(nT + 1);
  const painted = new Uint8Array(W * H);
  for (let i = 0; i < nT; i++) {
    const t = order[i];
    const tooth = teeth[t];
    archOf[t + 1] = tooth.arch === 'upper' ? 1 : 2;
    fillConvex(painted, W, H, tooth.hullX, tooth.hullY, tooth.hullN, label, t + 1);
  }

  // 隣り合う画素のラベルを比べ、同じ歯列の中の境目（隣接面）と
  // 上下の歯列の境目（咬合線）を分ける。咬合線は写真では暗い隙間なので、
  // シルエットからは取り除いておく。
  // 隣り合う画素のラベルを比べて、隣接面（同じ歯列）と咬合線（上下の境）に分ける。
  // 画素ごとに関数を呼ぶと当てはめ全体の負担になるため、ここは展開して書いてある。
  const edges = new Uint8Array(W * H);
  const seam = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const last = y + 1 < H;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const a = label[i];
      if (!a) continue;
      const archA = archOf[a];
      if (x + 1 < W) {
        const b = label[i + 1];
        if (b && b !== a) {
          if (archOf[b] === archA) { edges[i] = 1; edges[i + 1] = 1; } else { seam[i] = 1; seam[i + 1] = 1; }
        }
      }
      if (last) {
        const j = i + W;
        const b = label[j];
        if (b && b !== a) {
          if (archOf[b] === archA) { edges[i] = 1; edges[j] = 1; } else { seam[i] = 1; seam[j] = 1; }
        }
      }
    }
  }

  const upper = new Uint8Array(W * H);
  const lower = new Uint8Array(W * H);
  const union = new Uint8Array(W * H);
  for (let i = 0; i < label.length; i++) {
    const a = label[i];
    if (!a || seam[i]) continue;
    if (archOf[a] === 1) upper[i] = 1; else lower[i] = 1;
    union[i] = 1;
  }
  return { union, upper, lower, edges, label, order, depths: depths.slice(0, nT) };
}

/** 1画素だけ膨張させる（咬合線のぶんの隙間を作る） */
function dilate1(mask, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      out[i] = 1;
      if (x > 0) out[i - 1] = 1;
      if (x < W - 1) out[i + 1] = 1;
      if (y > 0) out[i - W] = 1;
      if (y < H - 1) out[i + W] = 1;
    }
  }
  return out;
}

/** 合成したシルエットだけが必要な場合 */
export function rasterize(fitModel, pose, shape, W, H) {
  return rasterizeArches(fitModel, pose, shape, W, H).union;
}

/**
 * 投影されたモデルの範囲を返す（scale=1, tx=ty=0 のとき）。
 * 初期の拡大率と位置を決めるのに使う。
 */
export function projectBounds(fitModel, pose, shape) {
  const R = rotationMatrix(pose.yaw, pose.pitch, pose.roll);
  const open = pose.jawOpening ?? shape.jawOpening ?? 0;
  const view = { upper: viewTransform(R, 0), lower: viewTransform(R, open) };
  const off = [0, 0, 0];
  const k = shape.crownHeightScale;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let sx = 0, sy = 0, n = 0;
  for (const tooth of fitModel.teeth) {
    const { base, up } = tooth;
    const { m, c } = view[tooth.arch];
    toothOffset(off, tooth, shape, fitModel.sMax);
    for (let i = 0; i < base.length; i += 3) {
      const wx = base[i] + k * up[i] + off[0];
      const wy = base[i + 1] + k * up[i + 1] + off[1];
      const wz = base[i + 2] + k * up[i + 2] + off[2];
      const X = m[0] * wx + m[1] * wy + m[2] * wz + c[0];
      const Y = -(m[3] * wx + m[4] * wy + m[5] * wz + c[1]);
      if (X < minX) minX = X;
      if (X > maxX) maxX = X;
      if (Y < minY) minY = Y;
      if (Y > maxY) maxY = Y;
      sx += X; sy += Y; n++;
    }
  }
  if (!n) return null;
  return { cx: sx / n, cy: sy / n, width: maxX - minX, height: maxY - minY };
}

/**
 * 2次元の凸包（Andrew のモノトーンチェーン法）。
 *
 * 当てはめのたびに歯の数だけ呼ばれるため、点を配列の配列で持つと
 * 1回の投影で数千個の小さな配列ができてしまう。座標は平らな数値配列で受け渡し、
 * 作業用の領域は使い回して確保をなくしてある。
 *
 * @returns {number} 凸包の頂点数（hx/hy の先頭から詰めて書き込む）
 */
function convexHullFlat(px, py, n, hx, hy, order) {
  if (n < 3) {
    for (let i = 0; i < n; i++) { hx[i] = px[i]; hy[i] = py[i]; }
    return n;
  }
  sortByProjection(order, px, py, n);

  const stack = scratchStack(n * 2 + 1);
  const cross = (o, a, b) =>
    (px[a] - px[o]) * (py[b] - py[o]) - (py[a] - py[o]) * (px[b] - px[o]);

  let k = 0;
  for (let ii = 0; ii < n; ii++) {
    const q = order[ii];
    while (k >= 2 && cross(stack[k - 2], stack[k - 1], q) <= 0) k--;
    stack[k++] = q;
  }
  const lowerEnd = k + 1;
  for (let ii = n - 2; ii >= 0; ii--) {
    const q = order[ii];
    while (k >= lowerEnd && cross(stack[k - 2], stack[k - 1], q) <= 0) k--;
    stack[k++] = q;
  }
  k--;   // 最後の点は最初の点と同じ
  for (let i = 0; i < k; i++) {
    const q = stack[i];
    hx[i] = px[q];
    hy[i] = py[q];
  }
  return k;
}

/**
 * 凸包のための並べ替え（x 昇順、同値なら y 昇順）。
 *
 * 比較関数を渡す `sort` は要素ごとに関数呼び出しが入るため、
 * 歯の数だけ毎回呼ぶとここが当てはめ全体の律速になる。
 * 最適化の途中では姿勢がわずかずつしか変わらず、前回の並び順がほぼそのまま
 * 使えるので、その順を初期値にした挿入ソートにしてある
 * （ほぼ整列済みの配列に対しては要素数に比例した手間で済む）。
 */
function sortByProjection(order, px, py, n) {
  for (let i = 1; i < n; i++) {
    const v = order[i];
    const kx = px[v];
    const ky = py[v];
    let j = i - 1;
    while (j >= 0) {
      const u = order[j];
      const ux = px[u];
      if (ux < kx || (ux === kx && py[u] <= ky)) break;
      order[j + 1] = u;
      j--;
    }
    order[j + 1] = v;
  }
}

// 投影と凸包で使い回す作業用の領域（呼び出しごとに確保しないため）
let _stack = new Int32Array(0);
let _px = new Float64Array(0);
let _py = new Float64Array(0);
const scratchStack = (n) => {
  if (_stack.length < n) _stack = new Int32Array(n);
  return _stack;
};
const scratchPoints = (n) => {
  if (_px.length < n) { _px = new Float64Array(n); _py = new Float64Array(n); }
  return [_px, _py];
};
let _depths = new Float64Array(0);
const scratchDepths = (n) => {
  if (_depths.length < n) _depths = new Float64Array(n);
  return _depths;
};

/** 凸多角形を塗りつぶす（走査線ごとに左右の交点を求める） */
function fillConvex(mask, W, H, hx, hy, hn, label, labelId) {
  if (hn < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < hn; i++) {
    if (hy[i] < minY) minY = hy[i];
    if (hy[i] > maxY) maxY = hy[i];
  }
  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(H - 1, Math.floor(maxY - 0.5));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < hn; i++) {
      const k = (i + 1) % hn;
      const ay = hy[i], by = hy[k];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
        const t = (cy - ay) / (by - ay);
        const x = hx[i] + t * (hx[k] - hx[i]);
        if (x < xl) xl = x;
        if (x > xr) xr = x;
      }
    }
    if (xl > xr) continue;
    const x0 = Math.max(0, Math.ceil(xl - 0.5));
    const x1 = Math.min(W - 1, Math.floor(xr - 0.5));
    const row = y * W;
    for (let x = x0; x <= x1; x++) {
      mask[row + x] = 1;
      if (label) label[row + x] = labelId;
    }
  }
}

/** 2つのマスクの IoU（Jaccard 係数） */
export function iou(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x | y) uni++;
    if (x & y) inter++;
  }
  return uni === 0 ? 0 : inter / uni;
}

/**
 * 写真の歯のマスクを上顎・下顎に分ける。
 *
 * 正面観・側方観では上下の歯列の間に咬合線（暗い線）が入るため、
 * 行ごとの被覆率がもっとも低くなる高さで切り分けられる。
 * はっきりした切れ目がない場合は null を返し、合成シルエットだけで比較する。
 *
 * @returns {{upper: Uint8Array, lower: Uint8Array, splitY: number}|null}
 */
export function splitByArch(mask, W, H) {
  const rows = new Int32Array(H);
  let top = -1, bottom = -1;
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) c++;
    rows[y] = c;
    if (c > 0) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0 || bottom - top < 6) return null;

  // 上下の歯列の境目は中央付近にあるはずなので、真ん中 50% の範囲で探す
  const lo = Math.round(top + (bottom - top) * 0.25);
  const hi = Math.round(top + (bottom - top) * 0.75);
  let best = -1, bestVal = Infinity;
  for (let y = lo; y <= hi; y++) {
    if (rows[y] < bestVal) { bestVal = rows[y]; best = y; }
  }
  if (best < 0) return null;

  // 切れ目がはっきりしない（くびれていない）場合は分割しない
  const peak = Math.max(...rows.slice(top, bottom + 1));
  if (bestVal > peak * 0.62) return null;

  const upper = new Uint8Array(W * H);
  const lower = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const target = y <= best ? upper : lower;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) target[y * W + x] = 1;
  }
  return { upper, lower, splitY: best };
}

/** マスクの重心と広がり（初期姿勢の推定に使う） */
export function maskStats(mask, W, H) {
  let n = 0, sx = 0, sy = 0, minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      n++; sx += x; sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (n === 0) return null;
  return { n, cx: sx / n, cy: sy / n, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ---------------------------------------------------------------------------
// Nelder-Mead 法による最適化
// ---------------------------------------------------------------------------

/**
 * 導関数を使わない多次元最適化（Nelder-Mead の滑降シンプレックス法）。
 * シルエットの重なり具合は微分できないため、この方法を使う。
 *
 * @param {number[]} x0 初期値
 * @param {number[]} step 各次元の初期歩幅
 * @param {(x: number[]) => number} fn 最小化する関数
 * @param {{maxIter?: number, tol?: number}} [opts]
 */
export function nelderMead(x0, step, fn, opts = {}) {
  const maxIter = opts.maxIter ?? 220;
  const tol = opts.tol ?? 1e-4;
  const n = x0.length;

  const simplex = [{ x: [...x0], f: fn(x0) }];
  for (let i = 0; i < n; i++) {
    const x = [...x0];
    x[i] += step[i];
    simplex.push({ x, f: fn(x) });
  }

  const centroid = (exclude) => {
    const c = new Array(n).fill(0);
    let cnt = 0;
    for (let i = 0; i < simplex.length; i++) {
      if (i === exclude) continue;
      for (let j = 0; j < n; j++) c[j] += simplex[i].x[j];
      cnt++;
    }
    return c.map((v) => v / cnt);
  };
  const combine = (a, b, t) => a.map((v, i) => v + t * (b[i] - v));

  for (let iter = 0; iter < maxIter; iter++) {
    simplex.sort((a, b) => a.f - b.f);
    if (Math.abs(simplex[simplex.length - 1].f - simplex[0].f) < tol) break;

    const worst = simplex.length - 1;
    const c = centroid(worst);
    const xr = combine(simplex[worst].x, c, 2);       // 反射
    const fr = fn(xr);

    if (fr < simplex[0].f) {
      const xe = combine(simplex[worst].x, c, 3);     // 拡張
      const fe = fn(xe);
      simplex[worst] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr };
    } else if (fr < simplex[worst - 1].f) {
      simplex[worst] = { x: xr, f: fr };
    } else {
      const xc = combine(simplex[worst].x, c, 1.5);   // 収縮
      const fc = fn(xc);
      if (fc < simplex[worst].f) {
        simplex[worst] = { x: xc, f: fc };
      } else {
        // 縮小
        for (let i = 1; i < simplex.length; i++) {
          const x = combine(simplex[0].x, simplex[i].x, 0.5);
          simplex[i] = { x, f: fn(x) };
        }
      }
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  return { x: simplex[0].x, f: simplex[0].f };
}

// ---------------------------------------------------------------------------
// フィッティングの実行
// ---------------------------------------------------------------------------

/**
 * 各列（x ごと）の縦方向のプロファイルを取り出す。
 *   top    もっとも上の歯の画素
 *   bottom もっとも下の歯の画素
 *   gap    上下の歯列の間にある隙間（咬合線）の中央
 * 咬合線の位置はオーバーバイトとスピー彎曲で決まるので、
 * ここを直接比べると、面積の重なりだけでは分からない差が見える。
 */
function columnProfile(mask, W, H) {
  const top = new Float32Array(W).fill(NaN);
  const bottom = new Float32Array(W).fill(NaN);
  const gap = new Float32Array(W).fill(NaN);
  for (let x = 0; x < W; x++) {
    let first = -1, last = -1, runEnd = -1, gapFound = false;
    let prev = 0;
    for (let y = 0; y < H; y++) {
      const v = mask[y * W + x];
      if (v) {
        if (first < 0) first = y;
        last = y;
        if (!prev && runEnd >= 0 && !gapFound) {
          gap[x] = (runEnd + y) / 2;
          gapFound = true;
        }
      } else if (prev) {
        runEnd = y - 1;
      }
      prev = v;
    }
    if (first >= 0) { top[x] = first; bottom[x] = last; }
  }
  return { top, bottom, gap };
}

/** 2つのプロファイルの食い違い（画素数、H で正規化） */
function profileCost(a, b, W, H) {
  let sum = 0, n = 0;
  const add = (p, q) => {
    for (let x = 0; x < W; x++) {
      if (Number.isNaN(p[x]) || Number.isNaN(q[x])) continue;
      sum += Math.abs(p[x] - q[x]);
      n++;
    }
  };
  add(a.top, b.top);
  add(a.bottom, b.bottom);
  // 咬合線は重み 2（オーバーバイト・スピー彎曲を決める手がかりのため）
  for (let k = 0; k < 2; k++) add(a.gap, b.gap);
  if (n === 0) return 1;
  return Math.min(1, (sum / n) / (H * 0.25));
}

/**
 * 写真の中の「暗い縦線」の強さを 0〜1 で返す（隣接面の手がかり）。
 *
 * 横方向の2階微分をとり、まわりより暗い画素だけを残す。咬合線のように
 * 横に走る線には反応しないので、隣接面（縦線）だけを拾える。
 * そのあと軽くぼかして、最適化のときに山が滑らかになるようにする。
 */
function ridgeMap(imageData, W, H, mask) {
  const { data } = imageData;
  const L = new Float32Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    L[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
  }
  const raw = new Float32Array(W * H);
  const band = dilate1(dilate1(mask, W, H), W, H);
  let maxV = 0;
  const vals = [];
  for (let y = 0; y < H; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (!band[i]) continue;
      const v = (L[i - 2] + L[i + 2]) / 2 - L[i];
      if (v > 0) {
        raw[i] = v;
        vals.push(v);
        if (v > maxV) maxV = v;
      }
    }
  }
  if (vals.length < 16) return raw;
  // 上位 10% を 1 とみなして正規化する（写真ごとの明るさの差を吸収）
  vals.sort((a, b) => a - b);
  const hi = Math.max(1e-4, vals[Math.floor(vals.length * 0.90)]);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.min(1, raw[i] / hi);
  return blur3(blur3(raw, W, H), W, H);
}

/** 3x3 の平均でぼかす */
function blur3(src, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          sum += src[yy * W + xx];
          n++;
        }
      }
      out[y * W + x] = sum / n;
    }
  }
  return out;
}

/**
 * モデルの隣接面の線が、写真の暗い縦線にどれだけ乗っているか。
 * 0 が完全一致、1 がまったく乗っていない状態。
 * 手がかりのない写真（縦線が写っていない）では値がほぼ一定になるため、
 * 最適化の向きを狂わせることはない。
 */
function ridgeCost(edges, ridge) {
  let sum = 0, n = 0;
  for (let i = 0; i < edges.length; i++) {
    if (!edges[i]) continue;
    sum += ridge[i];
    n++;
  }
  if (n < 8) return 0.5;
  return 1 - sum / n;
}

/**
 * シルエットの一致度からコストを作る。
 *
 * 合成シルエットの IoU に加え、上下顎それぞれの IoU も見る。
 * こうしないと、上顎前歯が下顎前歯を覆う量（オーバーバイト）や
 * スピー彎曲のように「上下の境界だけを動かす」パラメータが決まらない。
 * さらに隣接面の縦線の一致も見る。上下の歯列を前後にすべらせても外形は
 * ほとんど変わらないので、上下顎の前後的な関係（臼歯関係・オーバージェット）は
 * この項がないと決まらない。
 * 最後に、撮影時の開口量は 0 に近いほうを優先する弱い罰則を置き、
 * 他の誤差を開口で吸収してしまうのを防ぐ。
 */
function viewCost(fitModel, view, pose, shape) {
  const r = rasterizeArches(fitModel, pose, shape, view.W, view.H);
  const overlap = 1 - iou(r.union, view.mask);
  const profile = view.profile
    ? profileCost(columnProfile(r.union, view.W, view.H), view.profile, view.W, view.H)
    : 0;
  const ridge = view.ridge ? ridgeCost(r.edges, view.ridge) : 0.5;
  const open = pose.jawOpening ?? 0;
  return 0.52 * overlap + 0.33 * profile + 0.15 * ridge
    + 0.004 * (open / 10) * (open / 10);
}

const SHAPE_KEYS = ['crownHeightScale', 'overbiteDelta', 'speeDelta', 'archShiftZ'];

/** 姿勢の値を丸めて物理的にありえる範囲に収める */
function clampPose(p) {
  return {
    ...p,
    scale: Math.max(0.2, p.scale),
    jawOpening: Math.max(0, Math.min(35, p.jawOpening ?? 0)),
  };
}

function clampShape(s) {
  return {
    ...s,
    crownHeightScale: Math.max(0.55, Math.min(1.8, s.crownHeightScale)),
    overbiteDelta: Math.max(-4, Math.min(5, s.overbiteDelta)),
    speeDelta: Math.max(-2.5, Math.min(3.5, s.speeDelta)),
    archShiftZ: Math.max(-6, Math.min(6, s.archShiftZ ?? 0)),
  };
}

/**
 * 指定したパラメータだけを Nelder-Mead で最適化する。
 *
 * 角度（ラジアン）・位置（画素）・拡大率は桁がまったく違うので、
 * それぞれの探索幅を 1 とする正規化座標に直してから解く。
 * こうしないとシンプレックスの形が偏り、局所解に落ちやすい。
 */
function optimizeSubset(keys, start, steps, costOf, maxIter) {
  const x0 = keys.map((k) => start[k] ?? 0);
  const st = keys.map((k) => steps[k]);
  const expand = (xn) => {
    const out = { ...start };
    keys.forEach((k, i) => { out[k] = x0[i] + xn[i] * st[i]; });
    return out;
  };
  const res = nelderMead(
    new Array(keys.length).fill(0),
    new Array(keys.length).fill(1),
    (xn) => costOf(expand(xn)),
    { maxIter });
  return { value: expand(res.x), cost: res.f };
}

/**
 * 写真のマスクに合うように、その視点のカメラ姿勢を推定する。
 *
 * いきなり全パラメータを動かすと局所解に落ちるため、
 *   1. 位置と大きさ  2. 向きを追加  3. 開口量を追加
 * の順に自由度を増やしていく。
 *
 * @param {object} fitModel
 * @param {Uint8Array} target 写真から作った歯のマスク
 * @param {number} W @param {number} H
 * @param {string} viewKey 'frontal' | 'rightBuccal' | 'leftBuccal'
 * @param {object} shape 形態パラメータ
 */
export function fitPose(fitModel, target, W, H, viewKey, shape, opts = {}) {
  const init = VIEW_INIT[viewKey] ?? VIEW_INIT.frontal;
  const stats = maskStats(target, W, H);
  if (!stats) return null;

  const base = clampPose({
    yaw: init.yaw, pitch: init.pitch, roll: init.roll,
    tx: 0, ty: 0, scale: 1, jawOpening: init.open ?? 0,
  });
  const bounds = projectBounds(fitModel, base, shape);
  if (!bounds) return null;
  const scale = Math.max(0.2,
    Math.sqrt((stats.width * stats.height) / Math.max(1e-6, bounds.width * bounds.height)));
  base.scale = scale;
  base.tx = stats.cx - scale * bounds.cx;
  base.ty = stats.cy - scale * bounds.cy;

  const view = {
    mask: target, W, H,
    profile: opts.profile ?? columnProfile(target, W, H),
    ridge: opts.ridge,
  };
  const costOf = (pose) => viewCost(fitModel, view, clampPose(pose), shape);
  const steps = {
    yaw: 10 * DEG, pitch: 8 * DEG, roll: 6 * DEG,
    tx: Math.max(2, W * 0.04), ty: Math.max(2, H * 0.04),
    scale: scale * 0.10,
    jawOpening: 5,
  };
  const iter = opts.maxIter ?? 1;

  // 撮影した向きは写真ごとにまちまちなので、いくつかの初期角度から
  // 軽く当てにいって、もっとも見込みのあるものから本番の探索を始める。
  // （規格写真は約60°だが、スマートフォンでの自撮りはもっと浅いことが多い）
  const seeds = opts.seeds ?? (Math.abs(init.yaw) > 0.3 ? [-25 * DEG, 0, 22 * DEG] : [0]);
  let best = null;
  for (const dy of seeds) {
    const seed = clampPose({ ...base, yaw: base.yaw + dy });
    const b2 = projectBounds(fitModel, seed, shape);
    if (b2) {
      const sc = Math.max(0.2,
        Math.sqrt((stats.width * stats.height) / Math.max(1e-6, b2.width * b2.height)));
      seed.scale = sc;
      seed.tx = stats.cx - sc * b2.cx;
      seed.ty = stats.cy - sc * b2.cy;
    }
    const v = optimizeSubset(['tx', 'ty', 'scale'], seed, steps, costOf, 40);
    if (!best || v.cost < best.cost) best = v;
  }

  let cur = best.value;
  cur = optimizeSubset(['tx', 'ty', 'scale'], cur, steps, costOf, Math.round(60 * iter)).value;
  cur = optimizeSubset(['yaw', 'pitch', 'roll', 'tx', 'ty', 'scale'], cur, steps, costOf,
    Math.round(150 * iter)).value;
  if (opts.allowOpening !== false) {
    cur = optimizeSubset(['jawOpening', 'yaw', 'pitch', 'tx', 'ty', 'scale'], cur, steps, costOf,
      Math.round(90 * iter)).value;
  }
  const pose = clampPose(cur);
  return { pose, cost: costOf(pose) };
}

/**
 * いまの姿勢から少しだけ動かして合わせ直す。
 * 形態パラメータの候補を比べるときに、カメラの向きや位置がその値に
 * 合わせられる余地を与えるためのもの（プロファイル尤度の考え方）。
 */
function refinePose(fitModel, view, pose, shape, iters = 40) {
  const steps = {
    yaw: 4 * DEG, pitch: 3 * DEG, roll: 3 * DEG,
    tx: Math.max(1.5, view.W * 0.02), ty: Math.max(1.5, view.H * 0.02),
    scale: Math.max(1e-3, pose.scale * 0.04), jawOpening: 2,
  };
  const costOf = (p) => viewCost(fitModel, view, clampPose(p), shape);
  return optimizeSubset(['tx', 'ty', 'scale', 'yaw'], pose, steps, costOf, iters);
}

/**
 * 複数の視点をまとめて当てはめる。
 * 姿勢（視点ごと）と形態（上下顎で共通）を交互に最適化する。
 *
 * @param {object} fitModel buildFitModel の結果
 * @param {Array<{key: string, mask: Uint8Array, W: number, H: number}>} views
 * @param {object} shape0 defaultShape() の結果
 * @param {{rounds?: number, onProgress?: Function}} [opts]
 * @returns {{poses: object, shape: object, quality: object, mean: number}}
 */
export async function fitViews(fitModel, views, shape0, opts = {}) {
  const rounds = opts.rounds ?? 5;
  let shape = { ...shape0 };
  let prev = null;
  const poses = {};
  const quality = {};
  for (const v of views) {
    if (v.profile === undefined) v.profile = columnProfile(v.mask, v.W, v.H);
  }

  for (let round = 0; round < rounds; round++) {
    // --- 視点ごとの姿勢 ---
    for (const v of views) {
      const r = fitPose(fitModel, v.mask, v.W, v.H, v.key, shape, {
        maxIter: round === 0 ? 1 : 0.55,
        profile: v.profile,
        ridge: v.ridge,
        // 咬合位（噛み合わせた状態）の写真では開口を動かさない。
        // 数度の「開口」は下顎前歯を下後方へ動かすので、オーバーバイトと
        // オーバージェットのずれをほぼただで説明できてしまい、実症例では
        // 切端咬合の写真からオーバージェット 6mm が求まっていた。
        allowOpening: !isOccludedView(v.key),
      });
      if (!r) continue;
      poses[v.key] = r.pose;
      quality[v.key] = iou(rasterize(fitModel, r.pose, shape, v.W, v.H), v.mask);
      opts.onProgress?.(v.key, quality[v.key]);
      // 計算のあいだ画面が固まらないよう、視点ごとに制御を返す
      if (opts.yield) await opts.yield();
    }
    if (!Object.keys(poses).length) break;

    // --- 上下顎で共通の形態（歯冠長・オーバーバイト・スピー彎曲）---
    const usable = views.filter((v) => poses[v.key]);
    if (!usable.length) break;
    const shapeCost = (cand) => {
      const sc = clampShape(cand);
      let sum = 0;
      for (const v of usable) sum += viewCost(fitModel, v, poses[v.key], sc);
      return sum / usable.length;
    };
    // 上下顎の前後的な関係（archShiftZ）は、歯列がそれ自身の長手方向へ
    // すべる動きなので、外形の変化がとても小さく山が浅い。しかも、ずらした
    // ぶんをカメラの向きや位置が肩代わりできてしまうため、姿勢を止めたまま
    // 走査すると答えがいつも 0 のほうへ引っ張られる。
    // そこで候補の値ごとに姿勢を合わせ直しながら粗く走査する。
    if (opts.scanShift !== false && usable.some((v) => isOccludedView(v.key))) {
      let bestZ = shape.archShiftZ ?? 0;
      let bestC = Infinity;
      let bestPoses = null;
      // 1巡目は全域を粗く、2巡目以降はいまの値のまわりだけを細かく見る
      const wide = round === 0;
      const z0 = wide ? -3 : (shape.archShiftZ ?? 0) - 0.6;
      const z1 = wide ? 3 : (shape.archShiftZ ?? 0) + 0.6;
      const dz = wide ? 0.6 : 0.3;
      for (let z = z0; z <= z1 + 1e-3; z += dz) {
        const cand = clampShape({ ...shape, archShiftZ: z });
        let sum = 0;
        const cur = {};
        for (const v of usable) {
          const r = refinePose(fitModel, v, poses[v.key], cand, wide ? 40 : 24);
          cur[v.key] = clampPose(r.value);
          sum += r.cost;
        }
        const c = sum / usable.length;
        if (c < bestC) { bestC = c; bestZ = z; bestPoses = cur; }
        if (opts.yield) await opts.yield();
      }
      shape = { ...shape, archShiftZ: bestZ };
      if (bestPoses) Object.assign(poses, bestPoses);
    }

    shape = clampShape(optimizeSubset(
      SHAPE_KEYS, shape,
      { crownHeightScale: 0.10, overbiteDelta: 0.7, speeDelta: 0.5, archShiftZ: 0.8 },
      shapeCost, 160).value);

    // 姿勢と形態は互いに影響し合うので、交互に解き直して落ち着くまで繰り返す。
    // とくに上下顎の前後関係はカメラの向きとまぎれやすく、1〜2回では
    // 真の値の半分ほどしか戻らない。動かなくなった時点で打ち切る。
    if (prev && shapeSettled(prev, shape)) break;
    prev = shape;
  }

  // 形態パラメータが写真から本当に決まったのかを確かめる。
  // シルエットは歯冠長にはよく反応するが、オーバーバイトやスピー彎曲は
  // カメラの位置や拡大率とまぎれやすく、決まらないことがある。
  // 決まらなかった値で入力値を上書きしないよう、ここで判定する。
  const determined = assessShape(fitModel, views, poses, shape, shape0);

  const vals = Object.values(quality);
  return {
    poses,
    shape,
    determined,
    quality,
    mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
  };
}

/** 形態パラメータがもう動いていないか（反復の打ち切り判定） */
const SETTLE = { crownHeightScale: 0.008, overbiteDelta: 0.08, speeDelta: 0.08, archShiftZ: 0.08 };
function shapeSettled(a, b) {
  return SHAPE_KEYS.every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) <= SETTLE[k]);
}

/** 形態パラメータを動かしたときにコストがどれだけ改善したかを調べる */
function assessShape(fitModel, views, poses, shape, shape0) {
  const usable = views.filter((v) => poses[v.key]);
  const out = {};
  if (!usable.length) {
    for (const k of SHAPE_KEYS) out[k] = { determined: false, gain: 0 };
    return out;
  }
  const costWith = (override) => {
    const sc = clampShape({ ...shape, ...override });
    let sum = 0;
    for (const v of usable) sum += viewCost(fitModel, v, poses[v.key], sc);
    return sum / usable.length;
  };
  const best = costWith({});
  const probe = {
    crownHeightScale: 0.08, overbiteDelta: 0.6, speeDelta: 0.5, archShiftZ: 0.7,
  };
  const MIN_GAIN = 0.004;   // これ未満の改善は「決まらなかった」とみなす

  for (const k of SHAPE_KEYS) {
    const atInitial = costWith({ [k]: shape0[k] });
    const gain = atInitial - best;
    // 周囲より確かに低い（＝はっきりした最小値になっている）かも確かめる
    const up = costWith({ [k]: shape[k] + probe[k] });
    const down = costWith({ [k]: shape[k] - probe[k] });
    const isMinimum = up > best + MIN_GAIN * 0.5 && down > best + MIN_GAIN * 0.5;
    out[k] = { determined: gain > MIN_GAIN && isMinimum, gain };
  }
  return out;
}

/**
 * 当てはめたモデルのシルエットを、確認用に写真の上へ重ねて描く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} fitModel @param {object} pose @param {object} shape
 * @param {number} W @param {number} H 写真の画素数
 * @param {number} fitW フィッティングに使った作業解像度の幅
 */
export function drawFitOverlay(ctx, fitModel, pose, shape, W, H, fitW) {
  const k = W / fitW;
  const scaled = { ...pose, tx: pose.tx * k, ty: pose.ty * k, scale: pose.scale * k };
  const mask = rasterize(fitModel, scaled, shape, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    img.data[i] = img.data[i] * 0.45 + 56 * 0.55;
    img.data[i + 1] = img.data[i + 1] * 0.45 + 220 * 0.55;
    img.data[i + 2] = img.data[i + 2] * 0.45 + 240 * 0.55;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 写真から1歯ずつの歯冠長を測る。
 *
 * 当てはめが済むと、写真のどこにどの歯が写っているかが分かる。
 * そこで列ごとに「モデルでその歯が占める高さ」と「写真で歯が写っている高さ」を
 * 比べ、歯ごとの歯冠長の比を求める。歯頸線の高さは歯ごとに違い
 * （短い側切歯、咬耗した切歯、歯肉退縮など）、ここは個人差が大きい。
 *
 * 全体の倍率（crownHeightScale）を反映させたあとの「残りのずれ」を測るので、
 * 解剖学的歯冠と臨床的歯冠の差のような全体に共通する偏りは相殺される。
 *
 * @returns {Map<number, {ratio: number, cols: number}>} 歯の番号(1始まり) → 比
 */
export function measureToothHeights(fitModel, pose, shape, view) {
  const { W, H, mask } = view;
  const r = rasterizeArches(fitModel, pose, shape, W, H);
  const label = r.label;
  const n = fitModel.teeth.length;
  const top = new Int32Array(n);
  const bot = new Int32Array(n);
  const cnt = new Int32Array(n);
  const sumModel = new Float64Array(n);
  const sumPhoto = new Float64Array(n);
  const cols = new Int32Array(n);

  for (let x = 0; x < W; x++) {
    top.fill(-1); bot.fill(-1); cnt.fill(0);
    // その列で上顎・下顎それぞれが占める範囲（咬合線の位置を知るため）
    let upBot = -1;
    let loTop = -1;
    for (let y = 0; y < H; y++) {
      const L = label[y * W + x];
      if (!L) continue;
      const t = L - 1;
      if (top[t] < 0) top[t] = y;
      bot[t] = y;
      cnt[t]++;
      if (fitModel.teeth[t].arch === 'upper') upBot = y;
      else if (loTop < 0) loTop = y;
    }
    // 作業解像度まで縮めると咬合線の隙間はつぶれ、写真では上下の歯列が
    // ひとつながりに写る。モデルが示す咬合線の位置で切って、
    // その歯が属する歯列だけを測る。
    const cut = (upBot >= 0 && loTop >= 0) ? (upBot + loTop) / 2 : -1;

    for (let t = 0; t < n; t++) {
      if (cnt[t] < 3) continue;
      const isUpper = fitModel.teeth[t].arch === 'upper';
      const modelExtent = bot[t] - top[t] + 1;
      const mid = (top[t] + bot[t]) >> 1;
      if (mask[mid * W + x] !== 1) continue;
      // 写真側で、その位置を含むひとつながりの歯の範囲
      let pTop = mid;
      while (pTop > 0 && mask[(pTop - 1) * W + x] === 1) pTop--;
      let pBot = mid;
      while (pBot < H - 1 && mask[(pBot + 1) * W + x] === 1) pBot++;
      if (cut >= 0) {
        if (isUpper) pBot = Math.min(pBot, Math.max(pTop, Math.round(cut)));
        else pTop = Math.max(pTop, Math.min(pBot, Math.round(cut)));
      }
      const photoExtent = pBot - pTop + 1;
      // それでも上下がつながっている列は使わない
      if (photoExtent > modelExtent * 1.8) continue;
      sumModel[t] += modelExtent;
      sumPhoto[t] += photoExtent;
      cols[t]++;
    }
  }

  const out = new Map();
  for (let t = 0; t < n; t++) {
    if (cols[t] < 4 || sumModel[t] <= 0) continue;
    out.set(t, { ratio: sumPhoto[t] / sumModel[t], cols: cols[t] });
  }
  return out;
}

/**
 * 歯ごとの「高さのずれ」を写真のシルエットから求める。
 *
 * 八重歯（高位の犬歯）や、咬合平面に届いていない歯・飛び出した歯は、
 * 正面観・側方観でその歯だけが上下にずれて写る。以前はこれを歯冠長の
 * 伸び縮み（measureToothHeights）として扱っていたため、高位の犬歯は
 * 「短い犬歯」になり、尖頭は咬合平面に残ったままだった。
 *
 * ここでは歯冠の形と長さは変えず、歯を丸ごと上下に動かして、
 * その歯のまわりでシルエットがもっとも写真に合う位置を探す。
 * 世界座標で y 方向に動かしても、弱透視投影では画面上の輪郭が
 * 平行移動するだけなので、3D の再投影をせず凸包をずらして比べられる。
 *
 * - 他の歯に隠れている画素は、動かしても一致度が変わらないので自然に無視される
 * - 前後の重なりと上下の境目を保って比較し、隠れた歯は動かさない
 * - 各候補の改善/悪化を全視点で合計する（見えている画素数で重み付け）
 * - 全体の上下（オーバーバイト・スピー彎曲）はすでに形態パラメータで合わせてあるので、
 *   歯列ごとの中央値を引き、歯ごとの「残りのずれ」だけを返す
 *
 * @param {{teeth: Array, sMax: number}} fitModel buildFitModel の結果（現在の配置）
 * @param {Object<string, object>} poses 視点ごとの姿勢
 * @param {object} shape 形態パラメータ
 * @param {Array<{key, W, H, mask}>} views
 * @param {{maxMm?: number, stepMm?: number}} [opt]
 * @returns {Map<number, {dy: number, weight: number}>} 歯の添字 → 上方向のずれ(mm)
 */
export function estimateToothShifts(fitModel, poses, shape, views, opt = {}) {
  const maxMm = opt.maxMm ?? 4;
  const stepMm = opt.stepMm ?? 0.5;
  const nT = fitModel.teeth.length;
  const candidates = [];
  for (let dy = -maxMm; dy <= maxMm + 1e-9; dy += stepMm) candidates.push(dy);
  const acc = Array.from({ length: nT }, () => ({ gains: new Float64Array(candidates.length), den: 0 }));
  // 写真で評価できた歯（動かしても良くならなかった歯＝ずれ 0 も含む）
  const evaluated = new Set();

  for (const v of views) {
    const pose = poses[v.key];
    if (!pose) continue;
    const { W, H, mask } = v;
    const projected = rasterizeArches(fitModel, pose, shape, W, H);
    const R = rotationMatrix(pose.yaw, pose.pitch, pose.roll);
    const open = pose.jawOpening ?? shape.jawOpening ?? 0;
    const views2 = { upper: viewTransform(R, 0).m, lower: viewTransform(R, open).m };

    // 歯ごとの投影画素（遮蔽前）
    const scratch = new Uint8Array(W * H);
    const pix = [];
    for (let t = 0; t < nT; t++) {
      const tooth = fitModel.teeth[t];
      const list = [];
      if (tooth.hullN >= 3) {
        fillConvex(scratch, W, H, tooth.hullX, tooth.hullY, tooth.hullN, null, 0);
        for (let i = 0; i < scratch.length; i++) {
          if (!scratch[i]) continue;
          list.push(i);
          scratch[i] = 0;
        }
      }
      pix.push(list);
    }

    for (let t = 0; t < nT; t++) {
      const list = pix[t];
      if (list.length < 12) continue;
      // 隠れている歯を、手前の歯の誤差に合わせて動かさない。
      const visible = list.reduce((n, i) => n + (projected.label[i] === t + 1 ? 1 : 0), 0);
      if (visible < 12) continue;
      const tooth = fitModel.teeth[t];
      const m = views2[tooth.arch];
      // 世界座標で上へ 1mm 動かしたときの画面上の移動量
      const sx = pose.scale * m[1];
      const sy = -pose.scale * m[4];
      if (Math.hypot(sx, sy) < 0.4) continue;       // 上下の動きが写らない視点
      const reach = Math.ceil(Math.hypot(sx, sy) * maxMm) + 2;
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      for (const i of list) {
        const x = i % W, y = (i / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      x0 = Math.max(0, x0 - reach); x1 = Math.min(W - 1, x1 + reach);
      y0 = Math.max(0, y0 - reach); y1 = Math.min(H - 1, y1 + reach);
      const ww = x1 - x0 + 1, hh = y1 - y0 + 1;
      // この歯を除いた「最も手前の歯」。単なる被覆数では、咬合線が消え、
      // 隠れた歯まで写真の外形に合わせて動かしてしまう。
      const rest = new Int16Array(ww * hh);
      for (const other of projected.order) {
        if (other === t) continue;
        for (const i of pix[other]) {
          const x = i % W - x0, y = ((i / W) | 0) - y0;
          if (x >= 0 && y >= 0 && x < ww && y < hh) rest[y * ww + x] = other + 1;
        }
      }
      const own = new Uint8Array(ww * hh);
      const labels = new Int16Array(ww * hh);
      const hx = new Float64Array(tooth.hullN), hy = new Float64Array(tooth.hullN);
      const archOf = L => L ? fitModel.teeth[L - 1].arch : null;
      const score = (dy) => {
        own.fill(0);
        for (let i = 0; i < tooth.hullN; i++) {
          hx[i] = tooth.hullX[i] + sx * dy - x0;
          hy[i] = tooth.hullY[i] + sy * dy - y0;
        }
        fillConvex(own, ww, hh, hx, hy, tooth.hullN, null, 0);
        const depth = projected.depths[t] + m[7] * dy;
        for (let i = 0; i < labels.length; i++) {
          const other = rest[i] - 1;
          const inFront = other < 0 || depth > projected.depths[other]
            || (depth === projected.depths[other] && t > other);
          labels[i] = own[i] && inFront ? t + 1 : rest[i];
        }
        let inter = 0, uni = 0;
        for (let y = 0; y < hh; y++) {
          for (let x = 0; x < ww; x++) {
            const k = y * ww + x;
            const L = labels[k], arch = archOf(L);
            // rasterizeArches と同じ上下境界（両側 1px）を取り除く。
            // 同じ顎の歯の境界は塗ったままにする。
            const seam = L && ((x > 0 && labels[k - 1] && archOf(labels[k - 1]) !== arch)
              || (x + 1 < ww && labels[k + 1] && archOf(labels[k + 1]) !== arch)
              || (y > 0 && labels[k - ww] && archOf(labels[k - ww]) !== arch)
              || (y + 1 < hh && labels[k + ww] && archOf(labels[k + ww]) !== arch));
            const a = L && !seam ? 1 : 0;
            const b = mask[(y + y0) * W + (x + x0)] === 1 ? 1 : 0;
            if (a | b) uni++;
            if (a & b) inter++;
          }
        }
        return uni ? inter / uni : 0;
      };
      const base = score(0);
      for (let i = 0; i < candidates.length; i++) {
        const dy = candidates[i];
        // 動かすほど少しずつ不利にする（写真が示さないずれは作らない）
        const sc = score(dy) - 0.002 * dy * dy;
        // 良くなった写真だけを集めない。正面で矛盾する動きを、側方面の
        // 重なりによる見かけ上の改善だけで採用しないよう全写真を比較する。
        acc[t].gains[i] += (sc - base) * visible;
      }
      evaluated.add(t);
      acc[t].den += visible;
    }
  }

  // 歯列ごとの中央値を引いて「歯ごとの残りのずれ」にする
  const raw = new Map();
  for (let t = 0; t < nT; t++) {
    if (acc[t].den <= 0) continue;
    let best = -1, gain = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (acc[t].gains[i] > gain + 1e-9) { gain = acc[t].gains[i]; best = i; }
    }
    if (best >= 0 && gain / acc[t].den > 0.004)
      raw.set(t, { dy: candidates[best], weight: gain });
  }
  // 中央値は、評価できたすべての歯（ずれ 0 の歯を含む）で取る。
  // ずれた歯だけで取ると、4 本以上ずれている歯列ではその歯自身のずれが
  // 中央値になって打ち消され、ほかの歯が逆向きに押される。
  for (const arch of ['upper', 'lower']) {
    const ds = [...evaluated].filter((t) => fitModel.teeth[t].arch === arch)
      .map((t) => raw.get(t)?.dy ?? 0);
    if (ds.length < 4) continue;
    ds.sort((a, b) => a - b);
    const mid = ds.length >> 1;
    const med = ds.length % 2 ? ds[mid] : (ds[mid - 1] + ds[mid]) / 2;
    for (const [t, d] of raw) {
      if (fitModel.teeth[t].arch === arch) d.dy -= med;
    }
  }
  return raw;
}

/**
 * 正面観で、上顎前歯の切縁と下顎前歯のあいだに「暗い隙間」があるかを測る（開咬の検出）。
 *
 * シルエットの当てはめ（作業解像度 128px）では、上下の前歯の境目が
 * 1 画素に満たず、オーバーバイトは写真から決まらない（決まらなかった値は
 * 反映しない）。ところが開咬・切端咬合では、上下の前歯のあいだに口腔の
 * 暗い隙間がはっきり写る。これを元の解像度で直接測る。
 *
 * - 列の位置と上顎切縁のおおよその高さは、当てはめたモデルの投影から取る
 * - 写真の歯のマスク（閉じる前のもの）を縦にたどり、上顎の歯の下端と
 *   その下の歯の上端のあいだの隙間を測る
 * - 隙間の画素が本当に暗いこと（歯の明るさの半分未満）を確かめる。
 *   切縁の透けたエナメル質や影は中間の明るさなので隙間とみなさない
 *
 * @param {object} fitModel
 * @param {object} pose 正面観の姿勢（作業解像度）
 * @param {object} shape
 * @param {{W: number, H: number}} view 作業解像度の大きさ
 * @param {{raw: Uint8Array, luma: Float32Array, width: number, height: number}} full
 *   元の解像度の歯のマスク（閉じる前）と輝度
 * @returns {{cols: number, darkCols: number, frac: number, gapMm: number}|null}
 */
export function measureIncisalGap(fitModel, pose, shape, view, full) {
  const { W, H } = view;
  const k = full.width / W;
  const { label } = rasterizeArches(fitModel, pose, shape, W, H);
  const isInc = (L) => {
    const t = fitModel.teeth[L - 1];
    return t && t.arch === 'upper' && t.pos <= 2;
  };
  const pxPerMm = pose.scale * k;
  if (!(pxPerMm > 0)) return null;
  const win = Math.round(6 * pxPerMm);
  const gaps = [];
  let cols = 0;
  for (let x = 0; x < W; x++) {
    let ub = -1;
    for (let y = 0; y < H; y++) {
      const L = label[y * W + x];
      if (L && isInc(L)) ub = y;
    }
    if (ub < 0) continue;
    const step = Math.max(1, Math.round(k / 3));
    for (let X = Math.floor(x * k); X < Math.floor((x + 1) * k); X += step) {
      if (X < 0 || X >= full.width) continue;
      const y0 = Math.max(0, Math.round((ub + 0.5) * k) - win);
      const y1 = Math.min(full.height - 1, Math.round((ub + 0.5) * k) + win);
      const at = (Y) => full.raw[Y * full.width + X] === 1;
      // 上顎の歯の区間: 窓の上端から下へ、最初の歯の区間の下端
      let Y = y0;
      while (Y <= y1 && !at(Y)) Y++;
      if (Y > y1) continue;
      let lumSum = 0, lumN = 0;
      while (Y <= y1 && at(Y)) { lumSum += full.luma[Y * full.width + X]; lumN++; Y++; }
      const yb = Y - 1;
      if (Y > y1) { cols++; gaps.push(0); continue; }     // 窓のなかで途切れない＝隙間なし
      let gapLum = 0, gapN = 0;
      while (Y <= y1 && !at(Y)) { gapLum += full.luma[Y * full.width + X]; gapN++; Y++; }
      if (Y > y1) continue;                               // 下の歯が窓に入らない列は使わない
      cols++;
      const dark = gapN > 0 && lumN > 0 && (gapLum / gapN) < 0.5 * (lumSum / lumN);
      gaps.push(dark ? (Y - yb - 1) / pxPerMm : 0);
    }
  }
  if (!cols) return null;
  const darkGaps = gaps.filter((g) => g >= 0.5).sort((a, b) => a - b);
  return {
    cols,
    darkCols: darkGaps.length,
    frac: darkGaps.length / cols,
    gapMm: darkGaps.length ? darkGaps[darkGaps.length >> 1] : 0,
  };
}

/**
 * 写真からフィッティング用のマスクを作る。
 * 計算量を抑えるため、作業解像度（既定で幅128px）に縮小してから二値化する。
 *
 * @param {HTMLCanvasElement} photo
 * @param {(imageData: ImageData) => {mask: Uint8Array}} maskFn 歯のマスクを作る関数
 * @param {number} [fitWidth]
 * @returns {{mask: Uint8Array, W: number, H: number}|null}
 */
export function buildTargetMask(photo, maskFn, fitWidth = 128) {
  const W = Math.min(fitWidth, photo.width);
  const H = Math.max(2, Math.round((photo.height / photo.width) * W));
  const small = document.createElement('canvas');
  small.width = W;
  small.height = H;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photo, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H);
  const { mask } = maskFn(id);
  const stats = maskStats(mask, W, H);
  if (!stats || stats.n < W * H * 0.01) return null;
  return { mask, W, H, ridge: ridgeMap(id, W, H, mask) };
}

/**
 * 1枚の写真について「そのまま当てはめた場合」と「左右逆向きに当てはめた場合」の
 * 合わなさを測る。
 *
 * インカメラで撮った写真が鏡像になるかどうかは端末・ブラウザ・設定によって
 * まちまちで、画像自体には手がかりがない。しかし斜めから撮った写真であれば、
 * どちら側の歯列が手前に写っているかがモデルの当てはめで分かる。
 * 右斜めとして取り込んだ写真が左向きにしか当てはまらないなら、それは鏡像である。
 *
 * 判定そのものは呼び出し側で、すべての斜めの写真を合わせて行う
 * （同じカメラで撮った写真は反転の有無も同じはずで、1枚ずつ決めるより確かなため）。
 *
 * @returns {{costNormal: number, costFlipped: number}|null}
 *   正面観のように左右がほぼ対称な視点では null（判定に使えない）
 */
export function mirrorCosts(fitModel, view, shape) {
  const init = VIEW_INIT[view.key];
  if (!init || Math.abs(init.yaw) < 0.3) return null;

  // 「向きを逆に当てにいく」のではなく「写真を左右反転して同じ条件で当てる」。
  // 探索の初期値も進み方も両者でまったく同じになるので、比較が公平になる。
  const flippedMask = mirrorMask(view.mask, view.W, view.H);
  const flippedRidge = view.ridge ? mirrorFloat(view.ridge, view.W, view.H) : undefined;
  const run = (mask, ridge) => fitPose(fitModel, mask, view.W, view.H, view.key, shape, {
    maxIter: 0.7,
    profile: columnProfile(mask, view.W, view.H),
    ridge,
  });
  const normal = run(view.mask, view.ridge);
  const flipped = run(flippedMask, flippedRidge);
  if (!normal || !flipped) return null;
  return { costNormal: normal.cost, costFlipped: flipped.cost };
}

/** マスクを左右反転する */
export function mirrorMask(mask, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) out[row + x] = mask[row + (W - 1 - x)];
  }
  return out;
}

/** 実数のマップを左右反転する */
function mirrorFloat(src, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) out[row + x] = src[row + (W - 1 - x)];
  }
  return out;
}

/** 調査用（テストから山の形を見るため） */
export const __viewCost = viewCost;

// ---------------------------------------------------------------------------
// 歯ごとの傾斜（トルク・アンギュレーション）を写真から解く
// ---------------------------------------------------------------------------
//
// 咬合面観は歯を真上から見ているため、歯軸の傾きはほとんど写らない。
// 傾きが見えるのは正面観・側方観で、しかも「どの写真にどちらの傾きが
// 写るか」は歯の位置によって変わる（正面から見た前歯はアンギュレーションが
// 画面内に出るがトルクは奥行き方向に消える。側方観ではその逆になる）。
//
// そこで、どの視点がどちらの傾きを見ているかを人間が決め打ちせず、
// 「その歯を実際に振ってみて、シルエットがどれだけ動いたか」を数値微分で
// 測り、その感度で重みづけて解く。感度がほぼ 0 の視点は自動的に効かなくなる
// ので、写らない傾きを推定値で上書きしてしまうことがない。

const TILT_PROBE = 8;          // 数値微分の振り幅(度)
const TILT_RIDGE = 0.25;       // 正則化。写真から決まらない歯は標準値のまま残す
const TILT_MAX_TORQUE = 10;    // 1回の補正で動かす上限(度)
const TILT_MAX_TIP = 7;

/** クォータニオンの積（[x,y,z,w]） */
function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 軸まわりの回転クォータニオン */
function quatAxis(ax, ay, az, angle) {
  const h = angle / 2;
  const s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
}

/**
 * 1歯だけに追加の傾きを与えて、投影用の頂点配列を作り直す。
 *
 * 符号の規約は reconstruct3d.placementTransform と同じ
 * （トルク＋＝歯冠唇頬側、アンギュレーション＋＝歯冠近心）。
 * ただし placementTransform は臼歯部のトルクを半分にし、歯冠の中央を中心に
 * 回す。この関数は咬合面の原点まわりに全量を回すので、値をそのまま
 * 足し込むことはできない（2026-09-26 以降、app からは使っていない）。
 * こうしておくと、ここで解いた値をそのまま placement.torque / placement.tip に
 * 足し込める。
 */
export function setToothTilt(tooth, torqueDeg, tipDeg) {
  let q = tooth.quat;
  const ms = tooth.mdSign ?? 1;
  if (torqueDeg) q = quatMul(q, quatAxis(1, 0, 0, -torqueDeg * DEG));
  if (tipDeg) q = quatMul(q, quatAxis(0, 0, 1, -tipDeg * DEG * ms));
  const { verts, base, up } = tooth;
  const tmp = [0, 0, 0];
  for (let i = 0; i < verts.length; i += 3) {
    let r = applyQuat([verts[i], 0, verts[i + 2]], q);
    base[i] = r[0]; base[i + 1] = r[1]; base[i + 2] = r[2];
    tmp[0] = 0; tmp[1] = verts[i + 1]; tmp[2] = 0;
    r = applyQuat(tmp, q);
    up[i] = r[0]; up[i + 1] = r[1]; up[i + 2] = r[2];
  }
  tooth.tilt = { torque: torqueDeg, tip: tipDeg };
}

/**
 * 視点ごとに、歯の「歯頸側の縁」と「咬合側の縁」が画像のどこに出ているかを、
 * モデルと写真の双方について測る。
 *
 * 歯冠長（measureToothHeights）は上下の縁の「差」しか見ないが、
 * 傾きは縁そのものの位置を動かすので、ここでは差ではなく位置を返す。
 *
 * @returns {Map<number, {mTop,mBot,pTop,pBot,cols}>} 歯の添字 → 画像行(px)
 */
export function measureToothEdges(fitModel, pose, shape, view) {
  const { W, H, mask } = view;
  const { label } = rasterizeArches(fitModel, pose, shape, W, H);
  const n = fitModel.teeth.length;
  const top = new Int32Array(n);
  const bot = new Int32Array(n);
  const cnt = new Int32Array(n);
  const sMT = new Float64Array(n);
  const sMB = new Float64Array(n);
  const sPT = new Float64Array(n);
  const sPB = new Float64Array(n);
  const cols = new Int32Array(n);

  for (let x = 0; x < W; x++) {
    top.fill(-1); bot.fill(-1); cnt.fill(0);
    let upBot = -1;
    let loTop = -1;
    for (let y = 0; y < H; y++) {
      const L = label[y * W + x];
      if (!L) continue;
      const t = L - 1;
      if (top[t] < 0) top[t] = y;
      bot[t] = y;
      cnt[t]++;
      if (fitModel.teeth[t].arch === 'upper') upBot = y;
      else if (loTop < 0) loTop = y;
    }
    // 写真では上下の歯列がつながって写るので、モデルが示す咬合線で切る
    const cut = (upBot >= 0 && loTop >= 0) ? (upBot + loTop) / 2 : -1;

    for (let t = 0; t < n; t++) {
      if (cnt[t] < 3) continue;
      const isUpper = fitModel.teeth[t].arch === 'upper';
      const mid = (top[t] + bot[t]) >> 1;
      if (mask[mid * W + x] !== 1) continue;
      let pTop = mid;
      while (pTop > 0 && mask[(pTop - 1) * W + x] === 1) pTop--;
      let pBot = mid;
      while (pBot < H - 1 && mask[(pBot + 1) * W + x] === 1) pBot++;
      if (cut >= 0) {
        if (isUpper) pBot = Math.min(pBot, Math.max(pTop, Math.round(cut)));
        else pTop = Math.max(pTop, Math.min(pBot, Math.round(cut)));
      }
      if ((pBot - pTop + 1) > (bot[t] - top[t] + 1) * 1.8) continue;
      sMT[t] += top[t]; sMB[t] += bot[t];
      sPT[t] += pTop; sPB[t] += pBot;
      cols[t]++;
    }
  }

  const out = new Map();
  for (let t = 0; t < n; t++) {
    if (cols[t] < 4) continue;
    const k = cols[t];
    out.set(t, {
      mTop: sMT[t] / k, mBot: sMB[t] / k,
      pTop: sPT[t] / k, pBot: sPB[t] / k,
      cols: k,
    });
  }
  return out;
}

/**
 * 全視点から、歯ごとのトルク／アンギュレーションの補正量(度)を解く。
 *
 * 使う手がかりは「歯肉縁（歯と歯肉の境目）が画像のどこに出ているか」だけに絞る。
 * 咬合縁の側はモデルが決めた咬合線で切っているため、モデルを振ると切る位置も
 * 一緒に動いてしまい、感度が自分自身に依存してしまう（循環参照になる）。
 * 歯肉縁は写真の色の変わり目そのものなので、その心配がない。
 *
 * 各視点で 3 回だけラスタライズする（基準・トルクを振った状態・
 * アンギュレーションを振った状態）。全歯を同時に振るので、
 * 1 回の描画で全歯ぶんの感度が一度に取れる。
 *
 * 視点ごと・歯列ごとに残差の中央値を引いてから解く。こうしないと、
 * モデル全体の上下のずれ（カメラの当てはめ誤差）を歯の傾きのせいにして
 * 全歯が同じ方向に倒れてしまう。
 *
 * 解は歯ごとの 2x2 正規方程式に正則化(TILT_RIDGE)を入れて求める。
 * その歯の傾きがどの写真にも写っていなければ感度が小さく、
 * 正則化項が効いて補正量はほぼ 0 になる ＝ 標準値のまま残る。
 *
 * @returns {Map<number, {torque:number, tip:number, weight:number, views:number}>}
 */
export function estimateToothTilts(fitModel, poses, shape, views) {
  const n = fitModel.teeth.length;
  const A11 = new Float64Array(n);
  const A12 = new Float64Array(n);
  const A22 = new Float64Array(n);
  const b1 = new Float64Array(n);
  const b2 = new Float64Array(n);
  const wSum = new Float64Array(n);
  const nView = new Int32Array(n);

  const restore = fitModel.teeth.map((t) => ({ ...(t.tilt ?? { torque: 0, tip: 0 }) }));
  const setAll = (tq, tp) => { for (const t of fitModel.teeth) setToothTilt(t, tq, tp); };
  // 上顎は歯肉縁が上に、下顎は下に出る
  const gingival = (t, e) => (fitModel.teeth[t].arch === 'upper' ? e.mTop : e.mBot);
  const gingivalPhoto = (t, e) => (fitModel.teeth[t].arch === 'upper' ? e.pTop : e.pBot);

  try {
    for (const v of views) {
      const pose = poses[v.key];
      if (!pose) continue;
      setAll(0, 0);
      const g0 = measureToothEdges(fitModel, pose, shape, v);
      if (g0.size < 4) continue;
      setAll(TILT_PROBE, 0);
      const gq = measureToothEdges(fitModel, pose, shape, v);
      setAll(0, TILT_PROBE);
      const gp = measureToothEdges(fitModel, pose, shape, v);

      // 歯列ごとに残差の中央値を求める（モデル全体の位置ずれを取り除くため）
      const med = {};
      for (const arch of ['upper', 'lower']) {
        const rs = [];
        for (const [t, e] of g0) {
          if (fitModel.teeth[t].arch !== arch) continue;
          rs.push(gingivalPhoto(t, e) - gingival(t, e));
        }
        rs.sort((a, b) => a - b);
        med[arch] = rs.length ? rs[rs.length >> 1] : 0;
      }

      for (const [t, e] of g0) {
        const q = gq.get(t);
        const p = gp.get(t);
        if (!q || !p) continue;
        const base = gingival(t, e);
        // 感度（1度あたり歯肉縁が何 px 動くか）
        const jq = (gingival(t, q) - base) / TILT_PROBE;
        const jp = (gingival(t, p) - base) / TILT_PROBE;
        // 残差（写真 − モデル）から、その歯列の中央値を引く
        const r = (gingivalPhoto(t, e) - base) - med[fitModel.teeth[t].arch];
        // その視点がこの歯の傾きをまったく見ていなければ使わない
        if (Math.abs(jq) < 0.02 && Math.abs(jp) < 0.02) continue;
        const w = e.cols;
        A11[t] += w * jq * jq;
        A12[t] += w * jq * jp;
        A22[t] += w * jp * jp;
        b1[t] += w * jq * r;
        b2[t] += w * jp * r;
        wSum[t] += w;
        nView[t]++;
      }
    }
  } finally {
    for (let i = 0; i < fitModel.teeth.length; i++) {
      setToothTilt(fitModel.teeth[i], restore[i].torque, restore[i].tip);
    }
  }

  const out = new Map();
  for (let t = 0; t < n; t++) {
    // 1視点しか見ていない歯は、その視点の当てはめ誤差と区別がつかない
    if (wSum[t] < 8 || nView[t] < 3) continue;
    const lam = TILT_RIDGE * (A11[t] + A22[t]) + 1e-9;
    const a11 = A11[t] + lam;
    const a22 = A22[t] + lam;
    const det = a11 * a22 - A12[t] * A12[t];
    if (!(Math.abs(det) > 1e-12)) continue;
    const torque = (a22 * b1[t] - A12[t] * b2[t]) / det;
    const tip = (a11 * b2[t] - A12[t] * b1[t]) / det;
    if (!Number.isFinite(torque) || !Number.isFinite(tip)) continue;
    out.set(t, {
      torque: Math.max(-TILT_MAX_TORQUE, Math.min(TILT_MAX_TORQUE, torque)),
      tip: Math.max(-TILT_MAX_TIP, Math.min(TILT_MAX_TIP, tip)),
      weight: wSum[t],
      views: nView[t],
    });
  }
  return out;
}
