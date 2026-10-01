/**
 * reconstruct3d.js
 * 計測結果とセットアップ結果から、3D の歯列モデル（歯冠＋歯肉）を構築する。
 *
 * 口腔内スキャナの STL と同じく歯根は持たず、歯冠と歯肉のサーフェスのみを作る。
 * 各歯は剛体として Before / After の2つの姿勢を持ち、モーフ値 t で
 * 位置を線形補間・姿勢を球面線形補間して連続的に動かす。
 *
 * 歯冠は歯種ごとの標準形（テンプレート）を患者の大きさに合わせて使う。
 * 写真から歯の外形や起伏を写し取ると、検出のわずかな誤りがそのまま
 * 「ありえない形の歯」になるため、形は標準形に任せ、写真からは
 * 歯の並び（位置・唇舌的なずれ・捻転・高さ）だけを取る。
 *
 * 色も写真の画素を頂点に写すのをやめ、患者の歯の代表色を標準的な
 * エナメル質の色へ寄せた 1 色を基に、歯頸部の黄み・切縁の透明感・
 * 裂溝の陰影を付ける。写真の影や唾液の反射がまだらに写り込まない。
 */

import * as THREE from '../../vendor/three.module.min.js';
import { buildCrown, STANDARD_TEETH } from './tooth-library.js';
import { frameAt } from './arch.js';

const DEG = Math.PI / 180;

/**
 * 写真ピクセル ↔ アーチ座標(mm) の相互変換器を作る。
 * @param {object} detection segmentation.detectArch の戻り値
 * @param {number} pxPerMm
 */
export function makeProjector(detection, pxPerMm) {
  const { origin, fwd, left } = detection.unrolled;
  return {
    /** アーチ座標(mm) → 写真ピクセル */
    toPixel(x, z) {
      return {
        px: origin.x + (z * fwd.x + x * left.x) * pxPerMm,
        py: origin.y + (z * fwd.y + x * left.y) * pxPerMm,
      };
    },
    /** 写真ピクセル → アーチ座標(mm) */
    toArch(px, py) {
      const dx = px - origin.x;
      const dy = py - origin.y;
      return {
        x: (dx * left.x + dy * left.y) / pxPerMm,
        z: (dx * fwd.x + dy * fwd.y) / pxPerMm,
      };
    },
  };
}

/**
 * 歯の配置から剛体変換（位置と回転）を作る。
 * 歯の局所座標: +x 遠心 / +y 歯頸方向 / +z 頬側
 */
function placementTransform(arch, placement, curve) {
  const f = frameAt(curve, placement.s === 0 ? 0.01 : placement.s);
  const sideSign = placement.s >= 0 ? 1 : -1;
  // s が増える向き＝患者左方向。遠心方向は右側では −s 方向になる
  const distal = new THREE.Vector3(f.tx * sideSign, 0, f.tz * sideSign).normalize();
  const buccal = new THREE.Vector3(f.nx, 0, f.nz).normalize();
  const cervical = new THREE.Vector3(0, arch === 'upper' ? 1 : -1, 0);

  // 頬側（外向き）と歯頸方向は象限によらず決まるので、この2つを基準にし、
  // 近遠心軸は外積で作って基底を必ず右手系にする。
  // 接線の向きをそのまま使うと、4つの象限のうち2つで行列が左手系になり、
  // THREE.Quaternion.setFromRotationMatrix が単位長でない値を返して
  // 歯が半分の大きさに潰れてしまう（上顎右側・下顎右側で実際に起きていた）。
  const xAxis = new THREE.Vector3().crossVectors(cervical, buccal).normalize();
  const m = new THREE.Matrix4().makeBasis(xAxis, cervical, buccal);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);

  // この局所 x 軸が遠心を向く象限と近心を向く象限がある（歯冠形態を左右で
  // ミラーしているため）。トルクとアンギュレーションの向きが左右で
  // 食い違わないよう、遠心向きを正として符号をそろえる。
  const mdSign = xAxis.dot(distal) >= 0 ? 1 : -1;

  // 捻転（長軸まわり）・トルク（近遠心軸まわり）・アンギュレーション（頬舌軸まわり）
  //
  // 符号の規約（4 象限すべてで同じ意味になるようにする）:
  //   rotationDeg > 0 … 遠心端が頬側へ回る（segmentation.measureTeeth と同じ）
  //   torque > 0      … 歯冠が唇頬側へ傾く（MBT と同じ）
  //   tip > 0         … 歯冠が近心へ傾く（MBT と同じ。歯頸部が切縁より遠心）
  // 以前は捻転が患者左側で、トルクが右上・左下で、アンギュレーションが全歯で
  // 逆向きになっていた（実コードで各象限を確かめて直した）。
  const local = new THREE.Quaternion();
  const qy = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), -(placement.rotationDeg ?? 0) * DEG * mdSign);
  // 臼歯部のトルクは、ブラケットの溝の角度（MBT の値）であって歯冠そのものの
  // 傾きではない。そのまま歯冠を回すと下顎第二大臼歯（−30°）では咬頭が 2.5mm
  // 上下し、上下の歯が食い込んでいた。臼歯部は半分だけ回す。
  const torqueGeom = (placement.torque ?? 0) * (placement.pos >= 4 ? 0.5 : 1);
  const qx = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0), -torqueGeom * DEG);
  const qz = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), -(placement.tip ?? 0) * DEG * mdSign);
  local.multiply(qy).multiply(qx).multiply(qz);
  const qBase = q.clone();
  q.multiply(local);

  // 傾き（トルク・アンギュレーション）は歯冠の中央を中心に回す。
  // 咬合面（歯の原点）を中心に回すと、傾けた歯の咬頭が咬合平面を突き抜け、
  // 犬歯の最大豊隆部が隣の小臼歯へはみ出していた。
  const c = new THREE.Vector3(0, (placement.heightMm ?? 8) * 0.45, 0);
  const pivotShift = c.clone().applyQuaternion(qBase).sub(c.clone().applyQuaternion(q));

  return {
    position: new THREE.Vector3(placement.x, placement.y, placement.z).add(pivotShift),
    quaternion: q,
    // 傾斜（トルク・アンギュレーション）の符号は象限によって反転する。
    // 写真から傾斜を解くときに同じ規約を使う必要があるため外へ出す。
    mdSign,
  };
}

/** 写真から色をサンプリングするヘルパ */
function makeSampler(imageData, mask) {
  const { width, height, data } = imageData;
  return (px, py) => {
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const p = y * width + x;
    const i = p * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], inMask: mask ? mask[p] === 1 : true };
  };
}

/**
 * 歯列モデルを構築する。
 * @param {object} opts
 * @param {'upper'|'lower'} opts.arch
 * @param {object} opts.measurement buildMeasurement の結果
 * @param {object} opts.setupArch   setup.computeSetup の upper/lower
 * @param {ImageData} opts.imageData 咬合面写真
 * @returns {{group: THREE.Group, teeth: Array, gingiva: object|null}}
 */
export function buildArchModel({ arch, measurement, setupArch, imageData, shade: shadeIn }) {
  const group = new THREE.Group();
  group.name = `arch-${arch}`;
  const pxPerMm = measurement.pxPerMm;
  // 写真は歯肉の色を拾うのにだけ使う（歯の色は代表色から作る）
  const hasOcclusal = !!(measurement.detection && imageData);
  const proj = hasOcclusal ? makeProjector(measurement.detection, pxPerMm) : null;
  const sample = hasOcclusal ? makeSampler(imageData, measurement.detection.mask) : null;
  // 上下で同じ色にする（顎ごとに写真の写りが違い、上が灰色・下が黄色に分かれていた）
  const shade = shadeIn ?? enamelShade(setupArch.before);

  const beforeByFdi = new Map(setupArch.before.map((p) => [p.fdi, p]));
  const afterByFdi = new Map(setupArch.after.map((p) => [p.fdi, p]));

  const teeth = [];
  for (const bp of setupArch.before) {
    const ap = afterByFdi.get(bp.fdi) ?? null;
    const std = STANDARD_TEETH[arch][bp.pos];
    const tBefore = placementTransform(arch, bp, setupArch.curveBefore);
    // 歯冠形態は局所 +x を遠心として作ってある。配置の局所 x 軸が近心を向く
    // 象限（mdSign < 0）でだけ左右反転すると、4 象限とも近心・遠心が正しくなる。
    // （以前は反対の象限を反転していて、大臼歯の近心頬側咬頭が遠心に来ていた）
    const mirror = tBefore.mdSign < 0;
    const md = clamp(bp.mdMm, std.md * 0.8, std.md * 1.25);
    // 標準形の歯冠。頬舌径と歯冠長も近遠心幅径と同じ比で合わせ、
    // 歯種ごとの比率（切歯は薄く、臼歯は四角い）を崩さない。
    const crown = buildCrown({
      arch,
      pos: bp.pos,
      md,
      bl: std.bl * (md / std.md),
      height: bp.heightMm,
      outline: null,
      relief: null,
      mirror,
    });

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(crown.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(crown.indices, 1));

    const colors = shadeCrown(crown, arch, bp.pos, shade);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.computeVertexNormals();

    // 濡れたエナメル質のつやをクリアコートで出す（色むらではなく光沢で質感を作る）
    const material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.42,
      metalness: 0.0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.28,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = `tooth-${bp.fdi}`;
    mesh.position.copy(tBefore.position);
    mesh.quaternion.copy(tBefore.quaternion);
    group.add(mesh);

    const tAfter = ap
      ? placementTransform(arch, ap, setupArch.curveAfter)
      : extractedTransform(tBefore, arch, bp.heightMm);

    teeth.push({
      fdi: bp.fdi, side: bp.side, pos: bp.pos, mesh,
      before: tBefore, after: tAfter,
      mdSign: tBefore.mdSign,
      extracted: !ap,
      mdMm: bp.mdMm,
      heightMm: bp.heightMm,
      sBefore: bp.s,
      sAfter: ap ? ap.s : bp.s,
    });
  }

  const gingiva = buildGingiva({ arch, measurement, setupArch, proj, sample, teeth });
  if (gingiva) group.add(gingiva.mesh);

  return { group, teeth, gingiva, beforeByFdi, afterByFdi };
}

/**
 * 抜歯する歯の最終位置: その歯の長軸に沿って歯肉の中へ沈める。
 *
 * 以前は世界座標の上下に 14mm 動かしていたため、傾いた小臼歯は斜めに
 * 抜けて見えた。歯冠長＋3mm だけ根尖側へ動かすと、ちょうど歯肉に隠れる。
 */
function extractedTransform(tBefore, arch, heightMm = 8) {
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(tBefore.quaternion);   // 歯頸方向
  const pos = tBefore.position.clone().addScaledVector(axis, heightMm + 3);
  return { position: pos, quaternion: tBefore.quaternion.clone(), faded: true };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

/** 標準的なエナメル質の色（sRGB 0〜255。シェード A1〜A2 のあいだ） */
const STANDARD_ENAMEL = { r: 238, g: 229, b: 208 };

/**
 * 患者の歯の代表色を求める。
 *
 * 各歯の色（咬合面写真で測り、ホワイトバランスを合わせたもの）の中央値を、
 * 標準的なエナメル質の色へ 55% 寄せる。写真の明るさ・色かぶりで
 * 歯が灰色や橙色に転ぶのを防ぎつつ、「白い歯」「黄みの強い歯」といった
 * 患者ごとの印象は残す。
 */
export function enamelShade(placements) {
  const cols = placements.map((p) => p.color).filter((c) => c && c.r > 60);
  if (!cols.length) return { ...STANDARD_ENAMEL };
  const med = (k) => {
    const v = cols.map((c) => c[k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const m = { r: med('r'), g: med('g'), b: med('b') };
  // 明るさを標準に合わせてから色みだけを混ぜる（暗い写真でも歯は暗くしない）
  const lum = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const k = lum(STANDARD_ENAMEL) / Math.max(1, lum(m));
  const W = 0.45;
  const out = {};
  for (const ch of ['r', 'g', 'b']) {
    out[ch] = Math.max(170, Math.min(250, STANDARD_ENAMEL[ch] * (1 - W) + m[ch] * k * W));
  }
  // 黄み（r − b）が強すぎる写真は抑える
  if (out.r - out.b > 42) out.b = out.r - 42;
  return out;
}

/**
 * 歯冠の頂点色を作る。
 *
 * t（0 = 咬合面・切縁 … 1 = 歯頸部）に沿って、
 *   ・歯頸側 1/3 は象牙質が透けて黄みが強くなる
 *   ・前歯の切縁はエナメル質が薄く、わずかに青灰色に透ける
 *   ・臼歯の咬合面は裂溝ほど暗い（写真の影ではなく形から付ける陰影）
 * とする。犬歯は切歯より少し彩度が高い。
 */
export function shadeCrown(crown, arch, pos, shade) {
  const n = crown.positions.length / 3;
  const colors = new Float32Array(n * 3);
  const anterior = pos <= 3;
  const chroma = pos === 3 ? 1.06 : 1;
  let fossaMax = 0;
  for (let i = 0; i < n; i++) {
    if (crown.tParam[i] <= 0.05) fossaMax = Math.max(fossaMax, crown.positions[i * 3 + 1]);
  }
  for (let i = 0; i < n; i++) {
    const t = crown.tParam[i];
    let r = shade.r, g = shade.g, b = shade.b;
    // 彩度（白からの離れ具合）を歯種で少し変える
    r = 255 - (255 - r) * chroma;
    g = 255 - (255 - g) * chroma;
    b = 255 - (255 - b) * chroma;
    // 歯頸部の黄み
    const cerv = smoothstep(0.45, 0.95, t);
    r *= 1 - 0.03 * cerv;
    g *= 1 - 0.07 * cerv;
    b *= 1 - 0.16 * cerv;
    if (anterior) {
      // 切縁の透明感
      const edge = 1 - smoothstep(0.0, 0.16, t);
      r = r * (1 - 0.22 * edge) + 206 * 0.22 * edge;
      g = g * (1 - 0.22 * edge) + 211 * 0.22 * edge;
      b = b * (1 - 0.22 * edge) + 216 * 0.22 * edge;
    } else if (t <= 0.05 && fossaMax > 0.3) {
      // 咬合面: 深いところほど暗く（y は咬頭頂が 0、中心窩ほど大きい）
      const deep = Math.max(0, Math.min(1, crown.positions[i * 3 + 1] / fossaMax));
      const k = 1 - 0.16 * deep * deep;
      r *= k; g *= k; b *= k * 0.97;
    }
    colors[i * 3] = srgbToLinear(Math.min(255, r) / 255);
    colors[i * 3 + 1] = srgbToLinear(Math.min(255, g) / 255);
    colors[i * 3 + 2] = srgbToLinear(Math.min(255, b) / 255);
  }
  return colors;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// ---------------------------------------------------------------------------
// 歯肉
// ---------------------------------------------------------------------------

/** 歯肉断面のプロファイル（頬側→舌側）: [頬舌方向の係数, 歯頸線からの深さmm] */
const GINGIVA_PROFILE = [
  // いちばん根尖側は内側へ巻き込ませる。
  // 一定の深さで切り落とすと、歯肉が「板を立てた」ように見え、
  // 縁が直線のシートとして目立つ（3Dの作り物らしさの大きな原因だった）。
  // 巻き込ませるとシルエットが丸く閉じ、粘膜へ移行したように見える。
  [0.78, 8.8], [1.08, 7.5],
  [1.22, 6.0], [1.12, 2.8], [1.03, 1.0], [0.98, 0.0],
  [0.0, -1.7],
  [-0.98, 0.0], [-1.05, 1.0], [-1.14, 2.8], [-1.24, 6.0],
  [-1.10, 7.5], [-0.80, 8.8],
];

/** 端を折り返して平均する移動平均（歯頸線をなめらかにするのに使う） */
function movingAverage(src, win) {
  const n = src.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let k = 0;
    for (let d = -win; d <= win; d++) {
      let j = i + d;
      if (j < 0) j = -j;
      if (j >= n) j = 2 * n - 2 - j;
      if (j < 0 || j >= n) continue;
      sum += src[j];
      k++;
    }
    out[i] = k ? sum / k : src[i];
  }
  return out;
}

/**
 * 歯列弓に沿った歯肉のサーフェスを作る。
 * 各頂点は最も近い2歯に結び付けられ、歯の移動量の加重平均で一緒に動く。
 */
function buildGingiva({ arch, measurement, setupArch, proj, sample, teeth }) {
  const curve = setupArch.curveBefore;
  const sorted = [...setupArch.before].sort((a, b) => a.s - b.s);
  if (sorted.length < 4) return null;

  const sMin = sorted[0].s - sorted[0].mdMm / 2 - 1.5;
  const sMax = sorted[sorted.length - 1].s + sorted[sorted.length - 1].mdMm / 2 + 1.5;
  const STEP = 0.8;
  const cols = Math.max(4, Math.round((sMax - sMin) / STEP));
  const rows = GINGIVA_PROFILE.length;

  const positions = new Float32Array(cols * rows * 3);
  const colors = new Float32Array(cols * rows * 3);
  const indices = [];
  const up = arch === 'upper' ? 1 : -1;

  // 歯頸線の高さと頬舌径を先に全列ぶん求め、弧に沿ってならす。
  //
  // 2歯の加重平均だけでは、叢生で隣り合う歯の高さが食い違うところに
  // 折れ目が残り、歯肉が裂けたように見える。歯頸線は実際にはなめらかに
  // 連続するので、ここで平滑化しておく（起伏は歯間乳頭として別に足す）。
  const marginRaw = new Float64Array(cols);
  const blRaw = new Float64Array(cols);
  const devRaw = new Float64Array(cols);
  const papillaRaw = new Float64Array(cols);
  const sAt = new Float64Array(cols);
  const nearAt = [];
  for (let c = 0; c < cols; c++) {
    const s = sMin + ((sMax - sMin) * c) / (cols - 1);
    sAt[c] = s;
    const near = nearestTwo(sorted, s);
    nearAt.push(near);
    const t0 = near[0].tooth;
    const t1 = near[1].tooth;
    blRaw[c] = t0.blMm * near[0].w + t1.blMm * near[1].w;
    // 歯の唇舌的なずれ（八重歯・舌側転位）に歯肉も付いていく
    devRaw[c] = (t0.offsetMm ?? 0) * near[0].w + (t1.offsetMm ?? 0) * near[1].w;
    marginRaw[c] = (t0.y + up * t0.heightMm) * near[0].w
                 + (t1.y + up * t1.heightMm) * near[1].w;
    // 歯間乳頭: 隣接面に近いほど歯冠側へ盛り上がる
    papillaRaw[c] = 1.9 * Math.exp(-Math.pow(distanceToBoundary(sorted, s) / 1.6, 2));
  }
  const smoothWin = Math.max(1, Math.round(2.0 / STEP));   // 約 2mm の窓
  const marginS = movingAverage(marginRaw, smoothWin);
  const blS = movingAverage(blRaw, smoothWin);
  // ずれは約 3mm の窓でならす（歯ごとの段差で歯肉が折れないように）
  const devS = movingAverage(devRaw, Math.max(1, Math.round(3.0 / STEP)));

  // 歯肉の色も先に全列ぶん拾い、弧に沿って広めにならす。
  //
  // 列ごとに写真から拾った色をそのまま使うと、口蓋のしわ・唾液の反射・
  // 隣の歯の影を拾って、歯肉に縦縞が出る（作り物らしさの大きな原因だった）。
  // 約 6mm の窓でならしたうえで、歯肉全体の代表色へ 45% 寄せる。
  // 炎症の強さや色の個人差は残り、高い周波数の雑音だけが消える。
  const colRaw = [];
  for (let c = 0; c < cols; c++) {
    const s = sAt[c];
    const f = frameAt(curve, s === 0 ? 0.01 : s);
    let col = null;
    if (proj && sample) {
      const outward = (blS[c] / 2) * 1.25;
      const { px, py } = proj.toPixel(f.x + f.nx * outward, f.z + f.nz * outward);
      const smp = sample(px, py);
      if (smp && !smp.inMask) col = [smp.r, smp.g, smp.b];
    }
    colRaw.push(col ?? [208, 126, 122]);
  }
  const colWin = Math.max(2, Math.round(6.0 / STEP));
  const colS = [0, 1, 2].map((k) => movingAverage(colRaw.map((v) => v[k]), colWin));
  // 代表色（中央値）へ寄せて、残った揺らぎも抑える
  const median = [0, 1, 2].map((k) => {
    const v = [...colS[k]].sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  // 咬合面観から拾えるのは口蓋・舌側の粘膜で、唇頬側の付着歯肉より
  // 暗く赤い。歯肉として見えるのは主に唇頬側なので、明るさを少し上げ、
  // 赤みを弱めて付着歯肉らしい色に寄せる。
  //
  // 列ごとの色の揺らぎ（口蓋のしわ・唾液の反射・隣の歯の影）は
  // ならしても縞として残り、作り物らしさの原因になっていたので、
  // 歯肉は健康な付着歯肉の色に患者の代表色を 1/4 だけ混ぜた 1 色で塗り、
  // 立体感は深さによる陰影だけで出す。咬合面観から拾える粘膜は口蓋側の
  // 暗い赤で、半分混ぜると歯肉が茶色く濁って見えた。
  const LIFT = [1.06, 1.18, 1.20];
  const STANDARD_GINGIVA = [232, 148, 148];
  const one = [0, 1, 2].map((k) => Math.min(245,
    median[k] * LIFT[k] * 0.25 + STANDARD_GINGIVA[k] * 0.75));
  const gcol = [0, 1, 2].map((k) => colS[k].map(() => one[k]));

  for (let c = 0; c < cols; c++) {
    const s = sAt[c];
    const f = frameAt(curve, s === 0 ? 0.01 : s);
    const bl = blS[c];
    const marginY = marginS[c];
    const papilla = papillaRaw[c];

    // 歯列の端では歯肉のリボンをすぼめ、根尖側の縁が羽のように
    // 飛び出さないようにする
    const edge = Math.min(1,
      Math.min(s - sMin, sMax - s) / Math.max(1e-6, (sMax - sMin) * 0.06));
    const taper = 0.25 + 0.75 * Math.max(0, edge);

    for (let r = 0; r < rows; r++) {
      const [offFactor0, depth0] = GINGIVA_PROFILE[r];
      const offFactor = offFactor0 * (0.55 + 0.45 * taper);
      const depth = depth0 * taper;
      const off = (bl / 2) * offFactor;
      // 歯間乳頭は歯冠側だけの起伏で、根尖側へ行くほど消える。
      // 以前は深さによらず同じだけ効かせていたため、いちばん根尖側の縁が
      // 歯のたびに上下し、歯肉が破れたようなギザギザになっていた。
      const papW = Math.max(0, Math.min(1, 1 - Math.max(0, depth) / 2.5));
      const y = marginY + up * (depth - papilla * papW * (Math.abs(offFactor) > 0.5 ? 0.55 : 1));
      const x = f.x + f.nx * (off + devS[c]);
      const z = f.z + f.nz * (off + devS[c]);
      const i = (c * rows + r);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // 色: 弧に沿ってならした歯肉色（上で求めてある）
      const cr = gcol[0][c];
      const cg = gcol[1][c];
      const cb = gcol[2][c];
      // 歯頸部は明るく、根尖側の粘膜へ向かって暗く赤くなる
      const shade = 1 - 0.30 * Math.min(1, Math.abs(depth) / 7.5);
      colors[i * 3] = srgbToLinear((cr * shade) / 255);
      colors[i * 3 + 1] = srgbToLinear((cg * shade) / 255);
      colors[i * 3 + 2] = srgbToLinear((cb * shade) / 255);

    }
  }

  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = c * rows + r;
      const b = c * rows + r + 1;
      const d = (c + 1) * rows + r;
      const e = (c + 1) * rows + r + 1;
      if (up > 0) indices.push(a, d, b, b, d, e);
      else indices.push(a, b, d, b, e, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide,
  }));
  mesh.name = `gingiva-${arch}`;

  return { mesh, basePositions: positions, colS: sAt, rows };
}

function nearestTwo(sorted, s) {
  const ds = sorted.map((p, i) => ({ i, d: Math.abs(p.s - s), p }));
  ds.sort((a, b) => a.d - b.d);
  const a = ds[0], b = ds[1] ?? ds[0];
  const wa = 1 / (a.d + 0.6);
  const wb = 1 / (b.d + 0.6);
  const sum = wa + wb;
  return [
    { index: a.i, tooth: a.p, w: wa / sum },
    { index: b.i, tooth: b.p, w: wb / sum },
  ];
}

function distanceToBoundary(sorted, s) {
  let best = Infinity;
  for (const p of sorted) {
    best = Math.min(best,
      Math.abs(s - (p.s - p.mdMm / 2)),
      Math.abs(s - (p.s + p.mdMm / 2)));
  }
  return best;
}

/**
 * 治療の動きの進み具合（0〜1）を、抜歯と歯の移動の 2 段階に分ける。
 *   抜歯する歯: t = 0〜0.35 で歯肉の中へ沈む（歯肉の線より根尖側は描かない）
 *   ほかの歯:   t = 0.2〜1 でなめらかに動き出して止まる
 * 抜歯した歯が消えきる前に隣の歯が入り込むと、歯冠どうしが重なって見える。
 * t = 0 と 1 の位置は変えない（診断値・STL・比較画像は従来どおり）。
 */
export function morphPhases(t) {
  return {
    extract: smoothstep(0, 0.35, t),
    move: smoothstep(0.2, 1, t),
  };
}

/**
 * 抜歯する歯を、もとの歯頸線（歯肉の縁）の高さの平面で切り取る。
 *
 * 3D には歯槽骨も歯根もないので、歯を根尖側へ沈めると歯冠が歯肉の帯の
 * 向こう側へ突き抜けて見える（治療途中の画面に半透明の歯が浮いていた）。
 * もとの歯頸線より根尖側を描かないようにすると、歯が歯肉の中へ
 * 「すっと沈んで」消えていくように見える。
 * 平面は世界座標で置く必要があるので、歯列ごとの位置合わせを反映して毎回求める。
 */
function clipAtGumLine(tooth, k) {
  const mat = tooth.mesh.material;
  if (k <= 0) {
    if (mat.clippingPlanes?.length) {
      mat.clippingPlanes = [];
      mat.side = THREE.DoubleSide;
      mat.needsUpdate = true;
    }
    tooth.mesh.onBeforeRender = () => {};
    return;
  }
  if (!mat.clippingPlanes?.length) {
    mat.clippingPlanes = [new THREE.Plane()];
    // 切り口から歯冠の内側（裏面）が見えると割れた殻のように見えるので、表面だけ描く
    mat.side = THREE.FrontSide;
    mat.needsUpdate = true;
  }
  const plane = mat.clippingPlanes[0];
  // 平面は世界座標なので、描く直前に歯列の現在の位置（回転・位置合わせ・画面の中心合わせ）
  // から求め直す。applyMorph の時点で求めると、視点を回したときに古い位置のまま残る。
  const axis = new THREE.Vector3();
  const cervical = new THREE.Vector3();
  tooth.mesh.onBeforeRender = () => {
    const parent = tooth.mesh.parent;
    axis.set(0, 1, 0).applyQuaternion(tooth.before.quaternion);   // 歯頸方向
    cervical.copy(tooth.before.position).addScaledVector(axis, tooth.heightMm ?? 8);
    if (parent) {
      cervical.applyMatrix4(parent.matrixWorld);
      axis.transformDirection(parent.matrixWorld);
    }
    // 平面の正の側（咬合面側）だけを描く
    plane.setFromNormalAndCoplanarPoint(axis.negate(), cervical);
  };
}

/**
 * モーフ値 t（0=Before, 1=After）を適用する。
 * 歯は剛体補間、歯肉は歯の移動量を弧長に沿って補間して一緒に動かす。
 */
export function applyMorph(model, t) {
  const ph = morphPhases(t);
  const q = new THREE.Quaternion();
  const moves = [];
  for (const tooth of model.teeth) {
    const k = tooth.extracted ? ph.extract : ph.move;
    tooth.mesh.position.lerpVectors(tooth.before.position, tooth.after.position, k);
    q.copy(tooth.before.quaternion).slerp(tooth.after.quaternion, k);
    tooth.mesh.quaternion.copy(q);
    if (tooth.extracted) {
      // 透明にして消すと、歯肉の外に半透明の板が浮いて見えた。
      // 歯肉の線で切り取るだけにして、沈みきったら隠す。
      tooth.mesh.visible = k < 0.995;
      clipAtGumLine(tooth, k);
      continue;
    }
    moves.push({
      s: tooth.sBefore,
      x: (tooth.after.position.x - tooth.before.position.x) * k,
      y: (tooth.after.position.y - tooth.before.position.y) * k,
      z: (tooth.after.position.z - tooth.before.position.z) * k,
    });
  }

  const g = model.gingiva;
  if (!g || !moves.length) return;
  // 歯肉の各列の移動量は、その列の両側にある（抜歯しない）歯の移動量を
  // 弧長で線形に補間して求める。抜歯した部位の歯肉は、近心と遠心の歯が
  // 寄ってくるのに合わせて縮み、裂け目や折れが出ない。
  moves.sort((a, b) => a.s - b.s);
  const attr = g.mesh.geometry.getAttribute('position');
  const arr = attr.array;
  const cols = g.colS.length;
  let j = 0;
  for (let c = 0; c < cols; c++) {
    const sc = g.colS[c];
    while (j + 1 < moves.length && moves[j + 1].s < sc) j++;
    const a = moves[j];
    const b = moves[Math.min(moves.length - 1, j + 1)];
    let w = 0;
    if (sc <= moves[0].s) w = 0;
    else if (b !== a && b.s > a.s) w = Math.max(0, Math.min(1, (sc - a.s) / (b.s - a.s)));
    const src = sc <= moves[0].s ? moves[0] : sc >= moves[moves.length - 1].s ? moves[moves.length - 1] : null;
    const dx = src ? src.x : a.x + (b.x - a.x) * w;
    const dy = src ? src.y : a.y + (b.y - a.y) * w;
    const dz = src ? src.z : a.z + (b.z - a.z) * w;
    for (let r = 0; r < g.rows; r++) {
      const i = (c * g.rows + r) * 3;
      arr[i] = g.basePositions[i] + dx;
      arr[i + 1] = g.basePositions[i + 1] + dy;
      arr[i + 2] = g.basePositions[i + 2] + dz;
    }
  }
  attr.needsUpdate = true;
  g.mesh.geometry.computeVertexNormals();
}

/**
 * 治療方針だけが変わった場合に、歯冠のジオメトリを作り直さずに
 * Before / After の姿勢だけを更新する（スライダー操作を軽くするため）。
 * @param {object} model buildArchModel の結果
 * @param {'upper'|'lower'} arch
 * @param {object} setupArch setup.computeSetup の upper/lower
 */
export function updateTransforms(model, arch, setupArch) {
  const beforeByFdi = new Map(setupArch.before.map((p) => [p.fdi, p]));
  const afterByFdi = new Map(setupArch.after.map((p) => [p.fdi, p]));
  for (const tooth of model.teeth) {
    const bp = beforeByFdi.get(tooth.fdi);
    const ap = afterByFdi.get(tooth.fdi);
    if (bp) tooth.before = placementTransform(arch, bp, setupArch.curveBefore);
    tooth.after = ap
      ? placementTransform(arch, ap, setupArch.curveAfter)
      : extractedTransform(tooth.before, arch, bp?.heightMm);
    tooth.extracted = !ap;
    tooth.sAfter = ap ? ap.s : tooth.sBefore;
    if (!tooth.extracted) {
      tooth.mesh.visible = true;
      tooth.mesh.material.transparent = false;
      tooth.mesh.material.opacity = 1;
      tooth.mesh.material.depthWrite = true;
      clipAtGumLine(tooth, 0);
    }
  }
  model.beforeByFdi = beforeByFdi;
  model.afterByFdi = afterByFdi;
}
