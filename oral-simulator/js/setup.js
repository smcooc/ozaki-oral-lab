/**
 * setup.js
 * 治療方針（抜歯部位・固定源・IPR・側方拡大・外科手術）から
 * 排列後（セットアップ）の歯の位置を計算する。
 *
 * 考え方は模型上のセットアップ（診断用ワックスアップ）と同じで、
 *   1. 現在の歯列弓に対称なアーチフォームをフィットする
 *   2. アーチ長（正中〜大臼歯近心）と歯冠幅径の合計を比較して
 *      アーチレングスディスクレパンシー（ALD）を求める
 *   3. 抜歯・IPR・側方拡大・遠心移動で得られるスペースを加え、
 *      固定源の設定（前歯後退と臼歯近心移動の分担）に従って
 *      前歯の前後的位置（アーチフォームの前方位置 zAnt）を解く
 *   4. 新しいアーチフォーム上に歯を近心から順に隙間なく並べる
 *
 * 外科手術は上下顎の歯列全体の剛体移動として扱う。
 */

import {
  ArchCurve, archPlausibility, curveFromWidths, templateCurve, fitArchCurve,
  ARCH_TEMPLATES, frameAt, overbiteWeight,
} from './arch.js';
import { STANDARD_TEETH, fdi, estimateCrownHeight } from './tooth-library.js';
import { relaxCollisions, neighbourPairs } from './arrange.js';

/** 治療方針プリセット */
export const PLAN_PRESETS = {
  nonext: {
    label: '非抜歯',
    desc: 'IPR・側方拡大・臼歯遠心移動で叢生を解消します。',
    extraction: { 1: 0, 2: 0, 3: 0, 4: 0 },
  },
  ext4: {
    label: '上下顎 第一小臼歯抜歯（4本）',
    desc: '上下顎4番を抜歯。前歯の後退量が最も大きく、口元の突出感が改善します。',
    extraction: { 1: 4, 2: 4, 3: 4, 4: 4 },
  },
  ext45: {
    label: '上顎4番・下顎5番抜歯',
    desc: '上顎の後退を大きく、下顎は小さくしたい場合（上顎前突の非対称な要求）。',
    extraction: { 1: 4, 2: 4, 3: 5, 4: 5 },
  },
  ext5: {
    label: '上下顎 第二小臼歯抜歯（4本）',
    desc: '前歯の後退を抑え、臼歯の近心移動でスペースを閉じます（最小固定）。',
    extraction: { 1: 5, 2: 5, 3: 5, 4: 5 },
  },
  extUpper: {
    label: '上顎のみ 小臼歯抜歯（2本）',
    desc: '上顎のみ4番を抜歯し上顎前歯を後退。下顎は非抜歯で排列します。',
    extraction: { 1: 4, 2: 4, 3: 0, 4: 0 },
  },
  extLower: {
    label: '下顎のみ 小臼歯抜歯（2本）',
    desc: '下顎のみ4番を抜歯し下顎前歯を後退させます。',
    extraction: { 1: 0, 2: 0, 3: 4, 4: 4 },
  },
  extIncisor: {
    label: '下顎切歯 1歯抜歯',
    desc: '下顎前歯部の叢生とトゥースサイズディスクレパンシーへの対応。',
    extraction: { 1: 0, 2: 0, 3: 1, 4: 0 },
  },
  surgeryBimax: {
    label: '外科矯正（両顎手術）',
    desc: 'Le Fort I 型骨切り術＋下顎枝矢状分割術。歯列全体を骨ごと移動します。',
    extraction: { 1: 0, 2: 0, 3: 0, 4: 0 },
    surgery: { enabled: true, mxAdvance: 2, mxImpaction: 2, mdSetback: 5 },
  },
  surgeryMand: {
    label: '外科矯正（下顎のみ SSRO）',
    desc: '下顎骨のみを後退／前進させます。',
    extraction: { 1: 0, 2: 0, 3: 0, 4: 0 },
    surgery: { enabled: true, mxAdvance: 0, mxImpaction: 0, mdSetback: 6 },
  },
  surgeryExt: {
    label: '外科矯正＋上下顎小臼歯抜歯',
    desc: '術前矯正で歯列を整えたうえで両顎手術を行う想定。',
    extraction: { 1: 4, 2: 4, 3: 4, 4: 4 },
    surgery: { enabled: true, mxAdvance: 2, mxImpaction: 2, mdSetback: 5 },
  },
};

/** 既定の治療方針 */
export function defaultPlan() {
  return {
    presetId: 'ext4',
    extraction: { 1: 4, 2: 4, 3: 4, 4: 4 },
    anchorage: { upper: 0.85, lower: 0.70 },
    ipr: { upper: 0, lower: 0 },
    expansion: { upperCanine: 0, upperMolar: 0, lowerCanine: 0, lowerMolar: 0 },
    distalization: { upper: 0, lower: 0 },
    archForm: 'patient',
    surgery: { enabled: false, mxAdvance: 0, mxImpaction: 0, mdSetback: 0, genioAdvance: 0 },
    // overjet/overbite は治療前（写真に合わせると更新される）、
    // overjetAfter/overbiteAfter は治療後の目標値
    occlusion: {
      overjet: 3.0, overbite: 2.5, speeBefore: 2.0, speeAfter: 0.5,
      overjetAfter: 2.5, overbiteAfter: 2.0,
    },
  };
}

/**
 * 中切歯の唇側面の前後位置(mm)。上下顎の位置合わせの基準にする。
 * 中切歯が欠損している場合は、もっとも前方にある歯で代用する。
 */
function incisalLabialZ(setupArch) {
  const centrals = setupArch.before.filter((p) => p.pos === 1 && !p.willExtract);
  const src = centrals.length ? centrals : setupArch.before;
  let z = -Infinity;
  for (const p of src) z = Math.max(z, p.z + (p.blMm ?? 0) / 2);
  return Number.isFinite(z) ? z : setupArch.metrics.zAntBefore;
}

/** (arch, side) → FDI の象限番号 */
export function quadrantOf(arch, side) {
  if (arch === 'upper') return side === 'R' ? 1 : 2;
  return side === 'L' ? 3 : 4;
}

// ---------------------------------------------------------------------------
// アーチフォームの1径数族
// ---------------------------------------------------------------------------
/**
 * 形態比（b/a）と大臼歯の位置を保ったまま、正中の前後位置 zAnt を変えた曲線。
 * 前歯の唇舌的移動＝アーチ長の変化を表すための族。
 */
function curveWithAnterior(shapeRatio, molarX, molarZ, zAnt) {
  const x2 = molarX * molarX;
  const denom = x2 + shapeRatio * x2 * x2;
  const a = denom > 1e-9 ? (zAnt - molarZ) / denom : 0.02;
  return new ArchCurve(zAnt, Math.max(1e-4, a), Math.max(0, shapeRatio * Math.max(1e-4, a)));
}

/** A(zAnt) = 正中から大臼歯中心までの弧長 */
function arcToMolar(shapeRatio, molarX, molarZ, zAnt) {
  return Math.abs(curveWithAnterior(shapeRatio, molarX, molarZ, zAnt).arcAt(molarX));
}

/** A(zAnt) = target となる zAnt を二分法で解く */
function solveAnterior(shapeRatio, molarX, molarZ, zAnt0, target) {
  let lo = zAnt0 - 14;
  let hi = zAnt0 + 14;
  const f = (z) => arcToMolar(shapeRatio, molarX, molarZ, z) - target;
  if (f(lo) > 0) return lo;
  if (f(hi) < 0) return hi;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// スピー彎曲（咬合平面からの垂直位置）
// ---------------------------------------------------------------------------
/**
 * 弧長 s における咬合平面の垂直位置（上下顎で共通）。
 * 切縁（s=0）と最後方歯を通る平面からの落ち込みを深さ depth で表す。
 * 上顎の代償彎曲は下顎のスピー彎曲と噛み合うので同じ曲線を使い、
 * 上下の歯列がこの面で接触するようにする。
 */
function speeY(s, sMax, depth) {
  if (sMax <= 0) return 0;
  const u = Math.min(1, Math.abs(s) / sMax);
  // 4u(1-u) は u=0.5 で最大 1 → 小臼歯〜第一大臼歯付近が最深部
  return -depth * 4 * u * (1 - u);
}

/**
 * 歯列の垂直位置。
 *
 * 上顎前歯はオーバーバイトのぶん咬合平面より下方へ伸びる（歯種ごとの効き方は
 * arch.overbiteWeight）。オーバーバイトが負のとき（開咬）は上方へ離れ、
 * 上下の前歯のあいだに隙間ができる。以前は負の値を 0 として扱っていたため、
 * 開咬の患者でも前歯が切端で接して見えていた。
 */
function occlusalY(arch, s, sMax, speeDepth, overbite, pos) {
  const base = speeY(s, sMax, speeDepth);
  return arch === 'upper' ? base - overbite * overbiteWeight(pos) : base;
}

// ---------------------------------------------------------------------------
// 計測結果の構築
// ---------------------------------------------------------------------------
/**
 * segmentation.measureTeeth の結果をアーチ座標（mm）の計測値に変換する。
 * @param {object} detection detectArch の戻り値
 * @param {Array} rawTeeth measureTeeth の戻り値
 * @param {'upper'|'lower'} arch
 * @param {number} pxPerMm
 * @param {number} heightScale 正面写真等から求めた歯冠長の補正係数
 */
export function buildMeasurement(detection, rawTeeth, arch, pxPerMm, heightScale = 1) {
  const { origin, fwd, left } = detection.unrolled;
  const wb = whiteBalanceGains(rawTeeth);

  // --- 歯冠幅径をありうる範囲に収める --------------------------------
  //
  // 幅径は歯列帯を弧長で切った幅から測っている。境界が1歯ぶんずれると、
  // 中切歯が 4.9mm（小さすぎ）や 11.8mm（隣を飲み込んだ）になり、3Dでは
  // 大小がばらばらの歯が並ぶ。歯の大きさは人によって違っても、同じ口の中で
  // 歯種ごとの比率が大きく崩れることはない。
  //
  // そこで、その患者の歯の大きさ（標準に対する比の中央値）を先に求め、
  // 各歯の幅径をその ±20% に収める。患者固有の大小は残しつつ、
  // 検出の失敗が歯列全体の見た目を壊さないようにする。
  const sizeRatios = [];
  for (const t of rawTeeth) {
    const std = STANDARD_TEETH[arch][t.pos]?.md;
    const w = t.mdPx / pxPerMm;
    if (std > 0 && w > 0) sizeRatios.push(w / std);
  }
  let sizeK = 1;
  if (sizeRatios.length >= 4) {
    sizeRatios.sort((a, b) => a - b);
    const mid = sizeRatios.length >> 1;
    sizeK = sizeRatios.length % 2
      ? sizeRatios[mid] : (sizeRatios[mid - 1] + sizeRatios[mid]) / 2;
  }
  sizeK = Math.max(0.85, Math.min(1.18, sizeK));
  const bandK = sizeK;

  // --- 歯の大きさを「臼歯部の歯の間隔」から求め直す ----------------------
  //
  // 帯の弧長を歯種の比率で分けた幅は、叢生のある歯列では実際の歯冠より
  // 小さく出る。歯が重なって写るぶん、帯が歯の幅の合計より短くなるためである。
  // そのまま標準形の歯冠を実測位置に置くと、叢生の患者なのに歯のあいだに
  // 隙間が空いた 3D になっていた（実症例で確認）。
  //
  // 小臼歯〜大臼歯はほとんどの患者で隣と接触して並んでいるので、
  // 隣り合う歯の中心どうしの距離は「2 本の幅の半分ずつの和」にほぼ等しい。
  // この比の中央値を患者の歯の大きさとして使う。犬歯は八重歯で離れて
  // いることが多いので含めない。
  const photoXZ = (t) => {
    const hasRegion = Number.isFinite(t.rcx) && Number.isFinite(t.rcy);
    const px = hasRegion ? t.rcx : t.cx;
    const py = hasRegion ? t.rcy : t.cy;
    const dx = px - origin.x, dy = py - origin.y;
    return { x: (dx * left.x + dy * left.y) / pxPerMm, z: (dx * fwd.x + dy * fwd.y) / pxPerMm };
  };
  const contactRatios = [];
  for (const side of ['R', 'L']) {
    const quad = rawTeeth.filter((t) => t.side === side).sort((a, b) => a.pos - b.pos);
    for (let i = 0; i + 1 < quad.length; i++) {
      const a = quad[i], b = quad[i + 1];
      if (a.pos < 4 || b.pos !== a.pos + 1) continue;
      const pa = photoXZ(a), pb = photoXZ(b);
      const expected = (STANDARD_TEETH[arch][a.pos].md + STANDARD_TEETH[arch][b.pos].md) / 2;
      // 歯の中心は頬舌的に互い違いにずれるので、直線距離はそのぶん長く出る
      // （実症例で 1 割以上）。前後の歯を結ぶ向き（歯列の向き）に沿った成分だけを測る。
      const pPrev = photoXZ(quad[Math.max(0, i - 1)]);
      const pNext = photoXZ(quad[Math.min(quad.length - 1, i + 2)]);
      let ux = pNext.x - pPrev.x, uz = pNext.z - pPrev.z;
      const ul = Math.hypot(ux, uz);
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      let along = Math.hypot(dx, dz);
      if (ul > 1e-6) { ux /= ul; uz /= ul; along = Math.abs(dx * ux + dz * uz); }
      const r = along / expected;
      if (r > 0.7 && r < 1.45) contactRatios.push(r);
    }
  }
  //
  // 写真には長さの基準がないので、mm の目盛りは「歯の大きさは標準
  // （STEP2 の基準幅径で補正した値）」という仮定で決まっている。
  // ここで分かるのは「歯に対して歯列が何倍に写っているか」なので、
  // 歯の大きさは変えずに画素/mm のほうを直す（歯列弓が歯に合わせて縮む）。
  let sizeFrom = 'band';
  let scaleFix = 1;
  if (contactRatios.length >= 3) {
    contactRatios.sort((a, b) => a - b);
    const mid = contactRatios.length >> 1;
    const k = contactRatios.length % 2
      ? contactRatios[mid] : (contactRatios[mid - 1] + contactRatios[mid]) / 2;
    scaleFix = Math.max(0.85, Math.min(1.35, k / bandK));
    pxPerMm *= scaleFix;
    sizeFrom = 'contact';
  }

  const teeth = rawTeeth.map((t) => {
    const dx = t.cx - origin.x;
    const dy = t.cy - origin.y;
    const x = (dx * left.x + dy * left.y) / pxPerMm;
    const z = (dx * fwd.x + dy * fwd.y) / pxPerMm;
    // 歯そのものの位置（領域の重心）。取れなかった歯は帯の上の位置で代用する
    const hasRegion = Number.isFinite(t.rcx) && Number.isFinite(t.rcy);
    const rdx = hasRegion ? t.rcx - origin.x : dx;
    const rdy = hasRegion ? t.rcy - origin.y : dy;
    const xPhoto = (rdx * left.x + rdy * left.y) / pxPerMm;
    const zPhoto = (rdx * fwd.x + rdy * fwd.y) / pxPerMm;
    const std = STANDARD_TEETH[arch][t.pos];
    const mdRaw = t.mdPx / pxPerMm;
    // 1 歯ごとの差は帯の縮尺（補正前）で測った幅で比べる。補正後の縮尺で割ると
    // 比がそのぶん小さくなり、叢生の症例で全歯が下限（0.90）に張り付いて
    // 歯が 1 割小さくなっていた（接触が開き、補正の意味がなくなる）。
    const mdBand = mdRaw * scaleFix;
    const expect = std.md * sizeK;
    // 歯の大きさは患者全体の大きさ（sizeK）を基本にし、1 歯ごとの差は ±10% に収める。
    // 3D の歯冠は標準形なので、1 歯だけ極端に大きい・小さい歯は作らない。
    // 1 歯ごとの差は、帯で測った幅の「帯全体の大きさ（bandK）に対する比」で表す。
    const rel = Math.max(0.90, Math.min(1.10, mdBand / (std.md * bandK)));
    const mdMm = expect * rel;
    // 頬舌径（measureTeeth が補正前の縮尺で mm にしたもの）も同じ縮尺へ直す
    const blRaw = Number.isFinite(t.blMm) ? t.blMm / scaleFix : t.blMm;
    const blExpect = std.bl * sizeK;
    const blMm = Number.isFinite(blRaw)
      ? Math.max(blExpect * 0.78, Math.min(blExpect * 1.25, blRaw)) : blExpect;
    const mdRatio = mdMm / std.md;
    return {
      fdi: fdi(arch, t.side, t.pos),
      side: t.side,
      pos: t.pos,
      x, z,
      xPhoto, zPhoto,
      photoPosition: hasRegion,
      sMm: t.sCenterPx / pxPerMm,
      mdMm,
      blMm,
      mdRaw,
      rotationDeg: t.rotationDeg,
      color: { r: t.color.r, g: t.color.g * wb.g, b: t.color.b * wb.b },
      // 咬合面写真から実測した、その歯そのものの輪郭（標準形の代わりに使う）
      outline: t.outline ?? null,
      relief: t.relief ?? null,
      heightMm: estimateCrownHeight(arch, t.pos, mdMm, heightScale),
      mdRatio,
    };
  });
  // --- 歯列弓を「ありうる形」の範囲に収める --------------------------
  //
  // これまでは実測した歯の重心に4次曲線を最小二乗で当てはめ、明らかに
  // おかしいときだけテンプレートに差し替えていた。しかし検出が数歯ぶん
  // ずれる程度の乱れでは判定を通ってしまい、V字に狭い歯列弓や、
  // 下顎が上顎より深い（解剖学的にありえない）歯列弓がそのまま3Dになっていた。
  //
  // ここでは常に、その患者の歯の大きさに合わせて伸縮させたテンプレートを
  // 基準にし、実測から求めた幅径・深径をその ±18% に収めたうえで
  // 曲線を組み立て直す。実測に従いつつ、歯列弓として破綻しないことを保証する。
  const pts = teeth.map((t) => ({ x: t.x, z: t.z }));

  // 歯列弓のテンプレートも、上で求めた患者の歯の大きさ sizeK で伸縮させる
  const tpl = ARCH_TEMPLATES.ovoid[arch];

  // 実測の半幅（その歯が検出できていれば使う）
  const halfOf = (pos) => {
    const l = teeth.filter((t) => t.pos === pos).map((t) => Math.abs(t.x));
    return l.length ? l.reduce((a, b) => a + b, 0) / l.length : null;
  };
  const clampTo = (v, ref, lo, hi) => {
    if (!Number.isFinite(v) || !(v > 0)) return ref;
    return Math.max(ref * lo, Math.min(ref * hi, v));
  };
  const refCanineHalf = (tpl.canineW / 2) * sizeK;
  const refMolarHalf = (tpl.molarW / 2) * sizeK;
  const canineHalf = clampTo(halfOf(3), refCanineHalf, 0.82, 1.18);
  const molarHalf = clampTo(halfOf(6) ?? halfOf(7), refMolarHalf, 0.82, 1.18);

  // 深径（正中から犬歯・大臼歯までの前後距離）も実測から取り、同じく収める。
  //
  // 深さの基準となる正中の前後位置は、曲線に渡す zAnt と必ず同じものを使う。
  // 別々にすると曲線の曲がり方が実測とずれ、上顎が浅く下顎が深いといった
  // 解剖学的にありえない歯列弓ができる（実際に x=20mm で上顎16mm・
  // 下顎32mm という逆転が出ていた）。
  // 歯列弓の前端は「中切歯の重心」で測る。
  //
  // 歯の幅（近遠心幅）は歯の重心を結ぶ線に沿って測っているので、
  // 歯列弓の周長も同じ重心の線で測らないと両者の物差しが食い違う。
  // 以前は深さが浅く出る（22mm 対 本来 26mm 前後）のを補うために
  // 切歯の唇側面まで前へ出していたが、浅く出ていた本当の原因は
  // segmentation.js の弧長 s の水増し（ジグザグの中心線で 7〜20%）で、
  // それを直した後も唇側面を使うと片側 3mm ほど周長が長くなり、
  // 叢生が空隙に反転した（ALD −15mm → +5mm）。そのため重心に戻した。
  const incisors = teeth.filter((t) => t.pos === 1);
  const zAnt = incisors.length
    ? incisors.reduce((a, b) => a + b.z, 0) / incisors.length
    : Math.max(...teeth.map((t) => t.z));
  const depthOf = (pos) => {
    const l = teeth.filter((t) => t.pos === pos);
    if (!l.length) return null;
    return zAnt - l.reduce((a, b) => a + b.z, 0) / l.length;
  };
  const canineDepth = clampTo(depthOf(3), tpl.canineD * sizeK, 0.7, 1.4);
  const molarDepth = clampTo(depthOf(6) ?? depthOf(7), tpl.molarD * sizeK, 0.85, 1.15);

  let curve = curveFromWidths({
    zAnt, canineHalf, canineDepth, molarHalf, molarDepth,
  });
  // 組み立てた曲線が破綻していないかを最後に確かめ、だめならテンプレートそのもの
  const shapedPlaus = archPlausibility(curve, pts);
  if (!shapedPlaus.ok) {
    curve = curveFromWidths({
      zAnt,
      canineHalf: refCanineHalf, canineDepth: tpl.canineD * sizeK,
      molarHalf: refMolarHalf, molarDepth: tpl.molarD * sizeK,
    });
  }

  // 警告は「実際に3Dに使う曲線」がテンプレートに差し替わったときだけ出す。
  //
  // 以前は、使わない生の4次曲線（raw）の当てはめが悪いだけで
  // 「直線的に並んでいます。標準的な形で代用しています」と出していた。
  // 実症例では歯が正しく検出され、実測の幅径・深径から組んだ曲線が
  // 歯の重心から平均 3.3mm に収まっていた（代用もしていない）のに、
  // 4次式が臼歯部の平行な並びに合わず（ずれ 9.2mm）警告が出ていた。
  // 検出が本当に直線的に乱れたときは、組み立てた曲線（深さは標準の
  // 85% 以上に収める）からも歯が大きく外れるので、ここで確実に捕まる。
  let archWarning = null;
  if (!shapedPlaus.ok) {
    // 理由は歯の重心そのものの広がりで述べる（組み立てた曲線の深さは
    // 標準の 85% 以上に収めてあるので、直線的かどうかの判定には使えない）
    const zs = pts.map((p) => p.z);
    const spread = Math.max(...zs) - Math.min(...zs);
    const why = spread < shapedPlaus.xMax * 0.5
      ? `歯の中心が直線的に並んでいます：最後方の半幅 ${shapedPlaus.xMax.toFixed(0)}mm に対し`
        + `前後の広がり ${spread.toFixed(0)}mm`
      : `歯の中心が歯列弓から平均 ${shapedPlaus.rms.toFixed(1)}mm 外れています`;
    archWarning = `${arch === 'upper' ? '上顎' : '下顎'}の歯列弓が写真からは求まりませんでした`
      + `（${why}）。標準的な歯列弓の形で代用しています。`
      + 'STEP2 の基準3点（正中・左右の最後方歯）を写真に合わせて置き直してください。';
  }
  return { arch, pxPerMm, curve, teeth, detection, archWarning, sizeK, sizeFrom, scaleFix };
}

/**
 * 口腔内カメラ・ミラーの色かぶりを補正する係数を求める。
 *
 * 口腔内写真は暖色に寄ることが多く（ミラーの色・リングフラッシュ・
 * 口腔内の反射）、そのまま色として使うと歯冠全体が橙色に転ぶ。
 * もっとも明るい歯（＝汚れや影の影響がいちばん小さい歯）の色が
 * エナメル質らしい比率になるよう、緑と青の係数を求めて全歯に同じだけ掛ける。
 *
 * **歯ごとの色の違いはそのまま残る**（全歯に同じ係数を掛けるだけなので、
 * 変色歯・修復物・着色はそのまま反映される）。
 * 効きすぎないよう 70% の強さにし、係数は 1.0〜1.30 に収める。
 */
function whiteBalanceGains(teeth) {
  let best = null;
  for (const t of teeth) {
    const c = t.color;
    if (!c) continue;
    const l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    if (!best || l > best.l) best = { c, l };
  }
  if (!best || best.c.r < 40) return { g: 1, b: 1 };
  // エナメル質のおおよその比率
  const TARGET_G = 0.955;
  const TARGET_B = 0.900;
  const gainOf = (v, target) => {
    const cur = v / best.c.r;
    if (!(cur > 0.2)) return 1;
    const full = target / cur;
    const soft = 1 + (full - 1) * 0.7;
    return Math.max(1, Math.min(1.30, soft));
  };
  return { g: gainOf(best.c.g, TARGET_G), b: gainOf(best.c.b, TARGET_B) };
}

/**
 * 咬合面観がない場合（スマートフォンで撮影したときなど）に、
 * 標準的なアーチフォームと標準幅径から歯列を組み立てる。
 *
 * この歯列を出発点として、正面観・斜め観の写真に当てはめる
 * （fitting.js）ことで、患者ごとの歯列弓の幅・深さ・歯冠長に近づける。
 * ただし臼歯部は写真にほとんど写らないため、標準形態のままになる。
 *
 * @param {'upper'|'lower'} arch
 * @param {object} opts
 * @param {number} opts.centralMd 上顎中切歯の近遠心幅径(mm)。全体の大きさの基準
 * @param {number[]} opts.positions 各側に並べる歯の番号
 * @param {number} [opts.heightScale] 歯冠長の補正係数
 * @param {string} [opts.archForm] アーチフォームのテンプレート名
 * @param {number} [opts.archWidthScale] 歯列弓の幅の倍率（写真から求める）
 * @param {number} [opts.archDepthScale] 歯列弓の深さの倍率（写真から求める）
 */
export function buildTemplateMeasurement(arch, opts) {
  const {
    centralMd, positions,
    heightScale = 1, archForm = 'ovoid',
    archWidthScale = 1, archDepthScale = 1,
  } = opts;

  // 上顎中切歯の幅径を基準に、歯も歯列弓も同じ比率で拡大縮小する
  const k = centralMd / STANDARD_TEETH.upper[1].md;
  const t = (ARCH_TEMPLATES[archForm] ?? ARCH_TEMPLATES.ovoid)[arch]
    ?? ARCH_TEMPLATES.ovoid[arch];
  const curve = curveFromWidths({
    zAnt: 0,
    canineHalf: (t.canineW / 2) * k * archWidthScale,
    canineDepth: t.canineD * k * archDepthScale,
    molarHalf: (t.molarW / 2) * k * archWidthScale,
    molarDepth: t.molarD * k * archDepthScale,
  });

  const teeth = [];
  for (const side of ['R', 'L']) {
    const dir = side === 'L' ? 1 : -1;
    // 欠損・未萌出は左右で違うため、側ごとの歯番を受け取れるようにする
    const list = Array.isArray(positions) ? positions : (positions?.[side] ?? []);
    let s = 0;
    for (const pos of list) {
      const std = STANDARD_TEETH[arch][pos];
      const mdMm = std.md * k;
      const sc = dir * (s + mdMm / 2);
      s += mdMm;
      const f = frameAt(curve, sc === 0 ? 0.01 : sc);
      teeth.push({
        fdi: fdi(arch, side, pos),
        side, pos,
        x: f.x, z: f.z,
        sMm: sc,
        mdMm,
        blMm: std.bl * k,
        rotationDeg: 0,
        color: { r: 228, g: 221, b: 206 },
        heightMm: estimateCrownHeight(arch, pos, mdMm, heightScale),
        mdRatio: mdMm / std.md,
      });
    }
  }
  return {
    arch,
    pxPerMm: 1,
    curve,
    teeth,
    detection: null,     // 咬合面観がないことの目印
    fromTemplate: true,
  };
}

// ---------------------------------------------------------------------------
// セットアップ計算
// ---------------------------------------------------------------------------

/** 片顎のセットアップを計算する */
function setupArch(meas, plan) {
  const arch = meas.arch;
  const teeth = meas.teeth;
  const warnings = [];

  // --- アーチフォームを決める ---------------------------------------
  let base = meas.curve;
  if (plan.archForm !== 'patient') {
    const t = templateCurve(plan.archForm, arch, base.zAnt);
    if (t) base = t;
  }
  // 側方拡大を反映（犬歯部・大臼歯部の幅径を増やす）
  const expC = plan.expansion[arch === 'upper' ? 'upperCanine' : 'lowerCanine'] ?? 0;
  const expM = plan.expansion[arch === 'upper' ? 'upperMolar' : 'lowerMolar'] ?? 0;

  const anchorPos = pickAnchorPos(teeth, plan, arch);

  // 診断値（叢生量など）は、その患者の歯が実際にある位置から求める。
  //
  // 並べ直しに使う歯列弓（base）の上の位置を使ってはいけない。Before は
  // 歯冠幅径を積み上げた弧長に歯を並べているので、歯列弓が歯の合計幅で
  // 定義されてしまい、叢生量が必ず 0 になる（実際にそうなっていた）。
  const halfMeasured = (pos) => {
    const xs = teeth.filter((t) => t.pos === pos).map((t) => Math.abs(t.x));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const zMeasured = (pos) => {
    const zs = teeth.filter((t) => t.pos === pos).map((t) => t.z);
    return zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
  };
  const canineHalf = halfMeasured(3) ?? 14;
  const molarHalf = halfMeasured(anchorPos) ?? 22;
  const molarZ = zMeasured(anchorPos) ?? base.z(molarHalf);

  // 治療後の歯列弓は「理想的な形」を、患者の大臼歯部の幅と深さに合わせて作る。
  //
  // 以前は治療前に測った犬歯の位置も通るようにしていたため、八重歯（唇側に
  // 出た犬歯）があると治療後の歯列弓まで前歯部が広がった V 字になっていた。
  // 大臼歯部の幅と深さは叢生の影響をほとんど受けない、いちばん安定した実測値である。
  const idealId = plan.archForm !== 'patient' && ARCH_TEMPLATES[plan.archForm]
    ? plan.archForm : 'ovoid';
  const T = ARCH_TEMPLATES[idealId][arch];
  const kW = molarHalf / (T.molarW / 2);
  const kD = Math.max(0.7, Math.min(1.4, (base.zAnt - molarZ) / T.molarD));
  let shaped = curveFromWidths({
    zAnt: base.zAnt,
    canineHalf: (T.canineW / 2) * kW + expC / 2,
    canineDepth: T.canineD * kD,
    molarHalf: molarHalf + expM / 2,
    molarDepth: base.zAnt - molarZ,
  });
  const shapeRatio = shaped.a > 1e-9 ? shaped.b / shaped.a : 0;
  const molarXNew = molarHalf + expM / 2;
  const molarZNew = shaped.z(molarXNew);

  // --- スペース分析 -------------------------------------------------
  const perSide = {};
  for (const side of ['R', 'L']) {
    const q = quadrantOf(arch, side);
    const extracted = Number(plan.extraction[q] ?? 0);
    const quad = teeth.filter((t) => t.side === side).sort((a, b) => a.pos - b.pos);
    const anchor = quad.find((t) => t.pos === anchorPos);
    const mesialTeeth = quad.filter((t) => t.pos < anchorPos && t.pos !== extracted);
    const distalTeeth = quad.filter((t) => t.pos > anchorPos);
    const iprPerSide = (plan.ipr[arch] ?? 0) / 2;
    const required = mesialTeeth.reduce((s, t) => s + t.mdMm, 0) - iprPerSide;
    const anchorMd = anchor?.mdMm ?? STANDARD_TEETH[arch][anchorPos].md;
    const A0 = arcToMolar(shapeRatio, molarXNew, molarZNew, base.zAnt);
    const space = A0 - anchorMd / 2 - required;
    perSide[side] = {
      extracted, quad, anchor, mesialTeeth, distalTeeth,
      required, anchorMd, A0, space, iprPerSide,
    };
  }

  // --- 前歯位置を解く（左右の平均で対称に扱う）-----------------------
  const alpha = plan.anchorage[arch] ?? 0.8;
  const dist = plan.distalization[arch] ?? 0;
  const E = (perSide.R.space + perSide.L.space) / 2;
  const anchorMdAvg = (perSide.R.anchorMd + perSide.L.anchorMd) / 2;
  const requiredAvg = (perSide.R.required + perSide.L.required) / 2;
  const m = (1 - alpha) * E - dist;                 // 臼歯の近心移動量（− は遠心移動）
  const targetA = requiredAvg + anchorMdAvg / 2 + m;
  const zAntNew = solveAnterior(shapeRatio, molarXNew, molarZNew, base.zAnt, targetA);
  const curveAfter = curveWithAnterior(shapeRatio, molarXNew, molarZNew, zAntNew);
  const incisorChange = zAntNew - base.zAnt;         // + が唇側移動

  // --- 歯を並べる ---------------------------------------------------
  const placements = packAlong(arch, curveAfter, perSide, plan);

  // --- Before（写真で測った位置に置く）-------------------------------
  //
  // 以前は、実測した歯冠幅径を近心から積み上げた弧長に歯を並べ、
  // 唇舌的なずれだけを「隣とならして ±1.2mm に収めて」足し戻していた。
  // これでは八重歯（唇側に 3〜5mm 出た犬歯）も、口蓋側に入った側切歯も、
  // 隣の歯とならされて消え、どの患者も「きれいに並んだ歯列」になっていた。
  //
  // ここでは、咬合面写真で測った歯そのものの位置（領域の重心）に歯を置く。
  // 唇舌的なずれは ±6mm まで認め、ならさない。重なった歯冠は
  // arrange.relaxCollisions で押し分ける（押す量には上限がある）。
  const beforePose = arrangeBefore(arch, teeth, base);
  const sMaxBefore = Math.max(...[...beforePose.values()].map((b) => Math.abs(b.s)), 1);

  const before = teeth.map((t) => {
    const bp = beforePose.get(t.fdi);
    const adj = t.adjust ?? {};
    // 歯ごとの高さ: 写真から求めたずれ（dyMm、上方が＋）と手動の挺出・圧下。
    // 挺出は咬合平面へ近づく向きなので、上顎では下方、下顎では上方になる。
    const extrude = Number(adj.extrude) || 0;
    const dy = (Number(t.dyMm) || 0) + (arch === 'upper' ? -extrude : extrude);
    const p = {
      fdi: t.fdi, side: t.side, pos: t.pos,
      x: bp.x, z: bp.z,
      offsetMm: bp.dev,
      y: occlusalY(arch, bp.s, sMaxBefore, plan.occlusion.speeBefore, plan.occlusion.overbite, t.pos) + dy,
      dyMm: dy,
      s: bp.s,
      rotationDeg: bp.rotationDeg,
      // 歯軸の傾き（トルク・アンギュレーション）は咬合面観にはほとんど写らず、
      // 正面観・側方観のシルエットからも解けない（10° 傾けても作業解像度で
      // 1 画素に満たない。handoff 04 Finding 3）。歯種ごとの標準値を使う。
      torque: Number.isFinite(t.torqueDeg) ? t.torqueDeg : STANDARD_TEETH[arch][t.pos].torque,
      tip: Number.isFinite(t.tipDeg) ? t.tipDeg : STANDARD_TEETH[arch][t.pos].tip,
      mdMm: t.mdMm, blMm: t.blMm, heightMm: t.heightMm,
      color: t.color,
      extracted: false,
    };
    const q = quadrantOf(arch, t.side);
    p.willExtract = Number(plan.extraction[q] ?? 0) === t.pos;
    return p;
  });

  // --- 指標 ---------------------------------------------------------
  const extractedTeeth = before.filter((p) => p.willExtract);
  // 抜歯を行わない場合の ALD（叢生量）
  const aldNoExt = ['R', 'L'].map((side) => {
    const ps = perSide[side];
    const ex = before.find((p) => p.side === side && p.willExtract);
    return ps.space - (ex ? ex.mdMm : 0);
  });

  const metrics = {
    arch,
    ald: aldNoExt[0] + aldNoExt[1],
    aldRight: aldNoExt[0],
    aldLeft: aldNoExt[1],
    extractionSpace: extractedTeeth.reduce((s, t) => s + t.mdMm, 0),
    ipr: plan.ipr[arch] ?? 0,
    expansionCanine: expC,
    expansionMolar: expM,
    incisorChange,
    retraction: -incisorChange,
    molarMesialization: m,
    anchorage: alpha,
    anchorPos,
    sumMd: teeth.reduce((s, t) => s + t.mdMm, 0),
    sumMd33: sumRange(teeth, 1, 3),
    sumMd66: sumRange(teeth, 1, 6),
    curveBefore: base,
    curveAfter,
    zAntBefore: base.zAnt,
    zAntAfter: zAntNew,
    canineWidthBefore: canineHalf * 2,
    canineWidthAfter: (canineHalf + expC / 2) * 2,
    molarWidthBefore: molarHalf * 2,
    molarWidthAfter: molarXNew * 2,
  };

  if (Math.abs(expM) > 4) {
    warnings.push(`${archLabel(arch)}の大臼歯間拡大が ${expM.toFixed(1)}mm です。歯槽骨からの逸脱・後戻りに注意してください。`);
  }
  if (incisorChange > 2.5) {
    warnings.push(`${archLabel(arch)}前歯が ${incisorChange.toFixed(1)}mm 唇側傾斜します。歯肉退縮・後戻りのリスクを検討してください。`);
  }
  if (m < -2.5) {
    warnings.push(`${archLabel(arch)}臼歯の遠心移動量が ${(-m).toFixed(1)}mm です。矯正用アンカースクリュー等の追加固定が必要になる可能性があります。`);
  }
  // --- 叢生量（ALD）の信頼性を確かめる --------------------------------
  //
  // 叢生量は「歯列弓が与える周長」と「歯冠幅径の合計」の差で求めている。
  // 周長は歯の重心に当てはめた曲線の弧長、幅径は検出した歯列帯に沿った
  // 弧長なので、帯の検出が蛇行すると帯だけが長くなり、その差がそのまま
  // 叢生量に化ける。実症例では、正中から第一大臼歯までの長さが
  // 帯で 42.1mm・曲線で 34.5mm と 7.6mm 食い違い、叢生量が片側 8mm
  // （左右で −17mm）という写真とかけ離れた値になっていた。
  //
  // 臨床的にありうる叢生量は片顎でおよそ 12mm までなので、それを超えたら
  // 数値を出さずに「信頼できない」と伝える。誤った数値を自信をもって
  // 表示するより、求まらなかったと言うほうが安全である。
  const aldTotal = aldNoExt[0] + aldNoExt[1];
  if (aldTotal < -12) {
    warnings.push(`${archLabel(arch)}の叢生量が ${aldTotal.toFixed(1)}mm と算出されましたが、`
      + 'この値は信頼できません（歯列帯の検出が蛇行しているか、最後方歯の位置がずれている'
      + '可能性があります）。STEP2 で基準3点と歯の境界を確認してください。'
      + '排列の3Dは表示されますが、叢生量・必要スペースの数値は診断に使わないでください。');
  }

  if ((plan.ipr[arch] ?? 0) > 6) {
    warnings.push(`${archLabel(arch)}の IPR 総量が ${plan.ipr[arch].toFixed(1)}mm です。1接触あたり 0.5mm を超えないか確認してください。`);
  }

  return { arch, before, after: placements, metrics, warnings, curveAfter, curveBefore: base,
    perSide,
    // 咬合面観がなく標準値で組み立てた歯列かどうか。
    // レポートの叢生量などはこの場合「実測」ではないので、必ず明示する。
    fromTemplate: !!meas.fromTemplate };
}

/**
 * 治療後の歯を歯列弓 curve の上に、正中から遠心へ隙間なく並べる。
 * 歯冠幅径（IPR のぶんを引いたもの）を弧長として積み上げる。
 */
function packAlong(arch, curve, perSide, plan) {
  const placements = [];
  const sMaxBySide = {};
  // 左右それぞれ、正中から遠心へ並べる歯と幅
  const rows = {};
  for (const side of ['R', 'L']) {
    const ps = perSide[side];
    const ordered = [...ps.mesialTeeth];
    if (ps.anchor && ps.anchor.pos !== ps.extracted) ordered.push(ps.anchor);
    ordered.push(...ps.distalTeeth.filter((t) => t.pos !== ps.extracted));
    rows[side] = ordered.map((t) => {
      const iprShare = ps.iprPerSide > 0 && t.pos <= 5
        ? ps.iprPerSide / Math.max(1, ps.mesialTeeth.length)
        : 0;
      return { t, w: Math.max(1, t.mdMm - iprShare) };
    });
  }
  // 切歯を抜歯した（片側だけ前歯が 1 本少ない）ときは、残った前歯の中央を
  // 正中に置く。両側とも正中から並べると、犬歯が左右で 1 歯ぶん食い違っていた。
  const antLen = (side) => rows[side].filter((r) => r.t.pos <= 3).reduce((a, r) => a + r.w, 0);
  const diff = antLen('L') - antLen('R');
  const shift = Math.abs(diff) > 2 ? diff / 2 : 0;
  for (const side of ['R', 'L']) {
    const dir = side === 'L' ? 1 : -1;
    let s = 0;
    for (const { t, w } of rows[side]) {
      const sc = s + w / 2;
      placements.push(makePlacement(arch, t, curve, dir * sc - shift, w, plan, true));
      s += w;
    }
    sMaxBySide[side] = s + Math.abs(shift);
  }
  const sMax = Math.max(sMaxBySide.R, sMaxBySide.L, 1);
  const ob = plan.occlusion.overbiteAfter ?? 2.0;
  for (const p of placements) {
    p.y = occlusalY(arch, p.s, sMax, plan.occlusion.speeAfter, ob, p.pos);
  }
  return placements;
}

/** 唇舌的なずれとして認める上限(mm)。八重歯・口蓋側転位はおよそこの範囲に入る */
const BEFORE_OFFSET_MAX = 6;
/** 捻転として認める上限(度) */
const BEFORE_ROTATION_MAX = 40;

/**
 * 点 (x, z) にもっとも近い歯列弓上の点を探し、その弧長 s と
 * 頬側向きのずれ dev（＋が唇頬側）を返す。side で左右どちらの枝かを決める。
 */
export function projectOnCurve(curve, x, z, side) {
  const sgn = side === 'L' ? 1 : -1;
  let bestU = 0, bestD = Infinity;
  for (let u = 0; u <= 42; u += 0.25) {
    const px = sgn * u;
    const d = (px - x) ** 2 + (curve.z(px) - z) ** 2;
    if (d < bestD) { bestD = d; bestU = u; }
  }
  for (let u = Math.max(0, bestU - 0.3); u <= bestU + 0.3; u += 0.02) {
    const px = sgn * u;
    const d = (px - x) ** 2 + (curve.z(px) - z) ** 2;
    if (d < bestD) { bestD = d; bestU = u; }
  }
  const px = sgn * Math.max(0.01, bestU);
  const s = curve.arcAt(px);
  const f = frameAt(curve, s);
  const dev = (x - f.x) * f.nx + (z - f.z) * f.nz;
  return { s, dev };
}

/**
 * 治療前の歯の配置（写真で測った位置）を決める。
 *
 * 1. 各歯の位置（咬合面写真の領域の重心）を歯列弓に投影し、弧長 s と
 *    唇舌的なずれ dev に分ける。ずれは ±6mm に収める。
 * 2. 歯の並び順（中切歯→最後方歯）と弧長の順が食い違ったら順に直す
 *    （投影の誤差で隣の歯と入れ替わると歯列が壊れて見える）。
 * 3. 重なった歯冠を押し分ける。
 * 4. 手動の補正（近遠心・唇舌・捻転）を足す（押し分けのあと。指定どおりに動かすため）。
 *
 * @returns {Map<number, {x, z, s, dev, rotationDeg}>}
 */
function arrangeBefore(arch, teeth, base) {
  const items = [];
  for (const side of ['R', 'L']) {
    const dir = side === 'L' ? 1 : -1;
    const quad = teeth.filter((t) => t.side === side).sort((a, b) => a.pos - b.pos);
    let prevAbs = 0;
    let prevMd = 0;
    for (const t of quad) {
      const px = Number.isFinite(t.xPhoto) ? t.xPhoto : t.x;
      const pz = Number.isFinite(t.zPhoto) ? t.zPhoto : t.z;
      const pr = projectOnCurve(base, px, pz, side);
      // 順序を守る: 前の歯の中心から、2 本の幅の和の 35% 以上は遠心に置く
      const minAbs = prevAbs + (prevMd / 2 + t.mdMm / 2) * 0.35;
      const sAbs = Math.max(0.3, Math.abs(pr.s), prevAbs === 0 ? 0.5 : minAbs);
      const dev = Math.max(-BEFORE_OFFSET_MAX, Math.min(BEFORE_OFFSET_MAX, pr.dev));
      const rotationDeg = Math.max(-BEFORE_ROTATION_MAX, Math.min(BEFORE_ROTATION_MAX,
        Number(t.rotationDeg) || 0));
      prevAbs = sAbs;
      prevMd = t.mdMm;
      const s = dir * sAbs;
      const f = frameAt(base, s);
      // 歯冠の近遠心軸の向き。捻転は「＋で遠心端が頬側へ回る」
      // （reconstruct3d.placementTransform と同じ規約）
      const a = rotationDeg * Math.PI / 180;
      const dx0 = f.tx * dir, dz0 = f.tz * dir;          // 遠心向き
      const rx = dx0 * Math.cos(a) + f.nx * Math.sin(a);
      const rz = dz0 * Math.cos(a) + f.nz * Math.sin(a);
      const std = STANDARD_TEETH[arch][t.pos];
      items.push({
        fdi: t.fdi, side, pos: t.pos, s, rotationDeg, adjust: t.adjust ?? null,
        x: f.x + f.nx * dev, z: f.z + f.nz * dev,
        md: t.mdMm, bl: std.bl * (t.mdMm / std.md),
        angle: Math.atan2(rz, rx),
        nx: f.nx, nz: f.nz, tx: f.tx, tz: f.tz,
        // 大臼歯は歯列の支えなので動かしにくくする
        mobility: t.pos >= 6 ? 0.35 : t.pos >= 4 ? 0.8 : 1,
      });
    }
  }
  // 右の最後方歯 → 正中 → 左の最後方歯 の順に並べ、隣どうし（と 1 本とばし）を調べる
  items.sort((a, b) => a.s - b.s);
  const relaxed = relaxCollisions(items, neighbourPairs(items.length),
    { maxShift: 2.5, clearance: 0.2 }).items;

  // 手動の補正（近遠心・唇舌・捻転）は押し分けのあとに足す。先に足すと、
  // 押し分けで補正の量が変わり、ボタン 1 回が 0.5mm にならなかった。
  // 補正は先生が画面を見ながら決めた位置なので、そのまま使う。
  const out = new Map();
  for (const it of relaxed) {
    const pr = projectOnCurve(base, it.x, it.z, it.side);
    // 押し分けで弧長の順が入れ替わらないよう、元の s の符号と順序を保つ
    const sgn = Math.sign(it.s) || 1;
    let sAbs = Math.max(0.3, Math.abs(pr.s));
    let dev = pr.dev;
    let rotationDeg = it.rotationDeg;
    let { x, z } = it;
    const adj = it.adjust;
    if (adj && (adj.distal || adj.labial)) {
      sAbs = Math.max(0.3, sAbs + (Number(adj.distal) || 0));
      dev = Math.max(-BEFORE_OFFSET_MAX, Math.min(BEFORE_OFFSET_MAX, dev + (Number(adj.labial) || 0)));
      const f = frameAt(base, sgn * sAbs);
      x = f.x + f.nx * dev;
      z = f.z + f.nz * dev;
    }
    if (adj?.rotate) {
      rotationDeg = Math.max(-BEFORE_ROTATION_MAX, Math.min(BEFORE_ROTATION_MAX,
        rotationDeg + Number(adj.rotate)));
    }
    out.set(it.fdi, { x, z, s: sgn * sAbs, dev, rotationDeg });
  }
  return out;
}

/**
 * 上顎の治療後の歯列を、下顎の治療後の歯列に噛み合うように並べ直す。
 *
 * 下顎の歯列弓（歯冠中心を通る線）を外側へずらした線に上顎の歯冠中心を置く。
 * ずらす量は
 *   前歯: オーバージェットの目標値 ＋（上顎切歯と下顎切歯の頬舌径の差）/ 2
 *   犬歯: 2.8mm、小臼歯〜大臼歯: 2.0mm（上顎の口蓋側咬頭が下顎の中心窩に入る）
 * とし、なめらかにつなぐ。上顎の歯はこの線の上に正中から隙間なく並べる。
 * 上顎大臼歯の前後位置はその結果として決まり、I 級からのずれを診断値に出す。
 */
function coordinateUpper(out, plan) {
  const U = out.upper, L = out.lower;
  const regU = out.registration.upper, regL = out.registration.lower;
  const lc = L.curveAfter;
  const ojT = plan.occlusion.overjetAfter ?? 2.5;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const blOf = (arr, pos, arch) => {
    const l = arr.filter((p) => p.pos === pos).map((p) => p.blMm).filter(Number.isFinite);
    return l.length ? avg(l) : STANDARD_TEETH[arch][pos].bl;
  };
  const halfX = (pos) => {
    const l = L.after.filter((p) => p.pos === pos).map((p) => Math.abs(p.x));
    return l.length ? avg(l) : null;
  };
  // オーバージェットは唇側面どうしの距離（incisalLabialZ と同じく z + 頬舌径/2）。
  // 歯冠中心どうしの距離に直すと OJ −（上顎切歯と下顎切歯の頬舌径の差）/ 2。
  const dInc = ojT - (blOf(U.before, 1, 'upper') - blOf(L.before, 1, 'lower')) / 2;
  // 側方拡大: 下顎の拡大は下顎の歯列弓に入っているので、上顎との差だけを足す
  const ex = plan.expansion ?? {};
  const addC = ((ex.upperCanine ?? 0) - (ex.lowerCanine ?? 0)) / 2;
  const addM = ((ex.upperMolar ?? 0) - (ex.lowerMolar ?? 0)) / 2;
  const xC = halfX(3) ?? 13;
  const xP = Math.max(xC + 2, halfX(5) ?? halfX(4) ?? xC + 6);
  const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
  const dAt = (x) => (x <= 2 ? dInc
    : x <= xC ? lerp(dInc, 2.8 + addC, (x - 2) / (xC - 2))
      : x <= xP ? lerp(2.8 + addC, 2.0 + addM, (x - xC) / (xP - xC)) : 2.0 + addM);
  const xEnd = Math.max(...L.after.map((p) => Math.abs(p.x))) + 3;
  const pts = [];
  for (let x = 0; x <= xEnd; x += 0.5) {
    for (const sg of x === 0 ? [1] : [-1, 1]) {
      const f = frameAt(lc, lc.arcAt(sg * Math.max(0.01, x)));
      const d = dAt(x);
      // 下顎の座標 → 世界 → 上顎の座標（治療後の位置合わせ）
      pts.push({ x: f.x + f.nx * d, z: f.z + f.nz * d + regL.zAfter - regU.zAfter });
    }
  }
  let curve = fitArchCurve(pts);
  U.after = packAlong('upper', curve, U.perSide, plan);
  U.curveAfter = curve;

  // 犬歯を I 級に合わせる。上下の前歯の幅の比（Bolton 比）が標準から
  // ずれていると、オーバージェットだけで合わせた上顎は犬歯が I 級から
  // 前後にずれる。仕上がりの目標は犬歯 I 級なので、上顎の歯列全体を
  // 前後に動かして犬歯を合わせ、そのぶんオーバージェットが変わるのを
  // 1.5〜4mm の範囲で認める（範囲を超える分は犬歯のずれとして残す）。
  let ojAfter = ojT;
  for (let it = 0; it < 3; it++) {
    const cls = anteroposteriorClass(out, 'after');
    const cs = ['R', 'L'].map((sd) => cls[sd].canine).filter(Number.isFinite);
    if (!cs.length) break;
    const c = avg(cs);
    if (Math.abs(c) < 0.2) break;
    const u3 = U.after.find((p) => p.pos === 3);
    const tz = u3 ? Math.abs(frameAt(curve, u3.s).tz) : 0.6;
    let delta = -c / Math.max(0.4, tz);
    delta = Math.max(1.5 - ojAfter, Math.min(4 - ojAfter, delta));
    if (Math.abs(delta) < 0.05) break;
    ojAfter += delta;
    curve = new ArchCurve(curve.zAnt + delta, curve.a, curve.b);
    U.after = packAlong('upper', curve, U.perSide, plan);
    U.curveAfter = curve;
  }
  U.metrics.curveAfter = curve;
  U.metrics.zAntAfter = curve.zAnt;
  U.metrics.incisorChange = curve.zAnt - U.metrics.zAntBefore;
  U.metrics.retraction = -U.metrics.incisorChange;
  // 上顎の固定源（第一大臼歯）が前後にどれだけ動くか（＋ が近心）
  const anchorZ = (arr) => {
    const l = arr.filter((p) => p.pos === U.metrics.anchorPos).map((p) => p.z);
    return l.length ? avg(l) : null;
  };
  const zb = anchorZ(U.before), za = anchorZ(U.after);
  if (zb !== null && za !== null) U.metrics.molarMesialization = za - zb;
  U.metrics.coordinated = true;
  U.metrics.overjetAfter = ojAfter;
  const halfU = (pos) => {
    const l = U.after.filter((p) => p.pos === pos).map((p) => Math.abs(p.x));
    return l.length ? avg(l) : null;
  };
  const cw = halfU(3), mw = halfU(U.metrics.anchorPos);
  if (cw !== null) U.metrics.canineWidthAfter = cw * 2;
  if (mw !== null) U.metrics.molarWidthAfter = mw * 2;
  // setupArch が噛み合わせる前の値で出した上顎の警告は、ここで出し直す
  U.warnings = U.warnings.filter((w) => !w.startsWith('上顎前歯が') && !w.startsWith('上顎臼歯の遠心移動量'));
  if (U.metrics.incisorChange > 2.5) {
    U.warnings.push(`上顎前歯が ${U.metrics.incisorChange.toFixed(1)}mm 唇側へ動きます。歯肉退縮・後戻りのリスクを検討してください。`);
  }
  const m = U.metrics.molarMesialization;
  if (m < -2.5) {
    U.warnings.push(`下顎に噛み合わせると、上顎臼歯を ${(-m).toFixed(1)}mm 遠心へ動かす必要があります。`
      + '矯正用アンカースクリューなどの固定、または上顎の抜歯を検討してください。');
  } else if (m > 7) {
    U.warnings.push(`下顎に噛み合わせると、上顎臼歯が ${m.toFixed(1)}mm 近心へ動きます。`
      + '抜歯の方針（上顎の抜歯部位）を見直してください。');
  }
}

/**
 * 犬歯・第一大臼歯の前後関係（Angle 分類）を mm で返す。＋ が II 級方向。
 *   大臼歯: 上顎 6 の近心頬側咬頭（歯冠中心から近心へ幅の 1/4）が、
 *           下顎 6 の頬側溝（歯冠中心のやや近心）に来れば 0（I 級）
 *   犬歯:   上顎 3 の尖頭が下顎 3 と遠心隣在歯のあいだに来れば 0
 * 上顎の歯は下顎の歯列弓へ投影し、歯列弓に沿った位置（弧長）で比べる。
 * 前後（z）だけで比べると、犬歯部のように歯列弓が斜めに走るところでは
 * 上顎が外側にあるぶん前方に見え、II 級側へ偏る。
 */
function anteroposteriorClass(out, stage) {
  const U = out.upper, L = out.lower;
  const reg = out.registration;
  const dz = stage === 'after'
    ? reg.upper.zAfter - reg.lower.zAfter
    : reg.upper.z - reg.lower.z;
  const lc = stage === 'after' ? L.curveAfter : L.curveBefore;
  const sOnLower = (p) => Math.abs(projectOnCurve(lc, p.x, p.z + dz, p.side).s);
  const sLower = (p) => Math.abs(projectOnCurve(lc, p.x, p.z, p.side).s);
  const res = {};
  for (const side of ['R', 'L']) {
    const up = U[stage].filter((p) => p.side === side);
    const lo = L[stage].filter((p) => p.side === side);
    const u6 = up.find((p) => p.pos === 6);
    const l6 = lo.find((p) => p.pos === 6);
    const molar = u6 && l6
      ? (sLower(l6) - 0.5) - (sOnLower(u6) - u6.mdMm / 4) : null;
    const u3 = up.find((p) => p.pos === 3);
    const l3 = lo.find((p) => p.pos === 3);
    const lNext = lo.filter((p) => p.pos > 3).sort((a, b) => a.pos - b.pos)[0];
    const canine = u3 && l3 && lNext
      ? (sLower(l3) + sLower(lNext)) / 2 - sOnLower(u3) : null;
    res[side] = {
      molar: molar === null ? null : Math.round(molar * 10) / 10,
      canine: canine === null ? null : Math.round(canine * 10) / 10,
    };
  }
  return res;
}

function archLabel(arch) { return arch === 'upper' ? '上顎' : '下顎'; }

function sumRange(teeth, from, to) {
  return teeth.filter((t) => t.pos >= from && t.pos <= to).reduce((s, t) => s + t.mdMm, 0);
}

function pickAnchorPos(teeth, plan, arch) {
  // 固定源となる最後方の歯（通常は第一大臼歯。抜歯・欠損時は次の歯）
  const has = (pos) => teeth.some((t) => t.pos === pos);
  const extracted = new Set(['R', 'L'].map((s) => Number(plan.extraction[quadrantOf(arch, s)] ?? 0)));
  for (const pos of [6, 7, 5, 4]) {
    if (has(pos) && !extracted.has(pos)) return pos;
  }
  return 6;
}

function makePlacement(arch, tooth, curve, s, md, plan, ideal) {
  const x = curve.xAt(s);
  const std = STANDARD_TEETH[arch][tooth.pos];
  return {
    fdi: tooth.fdi, side: tooth.side, pos: tooth.pos,
    s, x, z: curve.z(x), y: 0,
    rotationDeg: ideal ? 0 : tooth.rotationDeg,
    torque: ideal ? std.torque : 0,
    tip: ideal ? std.tip : 0,
    mdMm: md, blMm: tooth.blMm, heightMm: tooth.heightMm,
    color: tooth.color,
    extracted: false,
  };
}

// ---------------------------------------------------------------------------
// 全体（上下顎＋咬合関係＋手術）
// ---------------------------------------------------------------------------

/**
 * 上下顎のセットアップを計算する。
 * @param {{upper?: object, lower?: object}} measurements buildMeasurement の結果
 * @param {object} plan
 */
export function computeSetup(measurements, plan) {
  const out = { upper: null, lower: null, warnings: [] };
  if (measurements.upper) out.upper = setupArch(measurements.upper, plan);
  if (measurements.lower) out.lower = setupArch(measurements.lower, plan);

  // --- 上下顎の位置合わせ（オーバージェットで登録）--------------------
  const oj = plan.occlusion.overjet;
  const ob = plan.occlusion.overbite;

  // 上顎中切歯の唇側面を z=0、下顎中切歯の唇側面を z=−オーバージェット に置く。
  // 歯列弓の式の zAnt（正中への外挿値）を基準にすると、叢生で中切歯が
  // 舌側に入っている症例で上下の前後関係が数 mm ずれてしまう。
  const regUpper = out.upper ? -incisalLabialZ(out.upper) : 0;
  const regLower = out.lower ? -incisalLabialZ(out.lower) - oj : 0;

  // --- 外科手術の剛体移動 --------------------------------------------
  const sg = plan.surgery;
  const mx = sg.enabled ? sg : { mxAdvance: 0, mxImpaction: 0, mdSetback: 0 };
  const upperShift = { z: (mx.mxAdvance ?? 0), y: (mx.mxImpaction ?? 0) };
  // 上顎の圧下により下顎は自転（オートローテーション）し、前上方へ移動する
  const autoRotZ = (mx.mxImpaction ?? 0) * 0.6;
  const lowerShift = {
    z: autoRotZ - (mx.mdSetback ?? 0),
    y: (mx.mxImpaction ?? 0),
  };

  out.registration = {
    upper: { z: regUpper, y: 0, zAfter: regUpper + upperShift.z, yAfter: upperShift.y },
    lower: { z: regLower, y: 0, zAfter: regLower + lowerShift.z, yAfter: lowerShift.y },
  };

  // --- 上下の歯列を噛み合わせる（治療後）--------------------------------
  //
  // 以前は上下顎を別々に並べ、治療後のオーバージェットは「結果」として
  // 表示するだけだったため、方針によっては −4mm（反対咬合）や +9mm に
  // なり、3D でも上下の歯が食い込んだり離れたりしていた。
  // 下顎を基準にし、上顎の歯列弓を下顎に沿わせて（前歯はオーバージェットの
  // 目標値、臼歯は上顎の口蓋側咬頭が下顎の中心窩に入る位置）並べ直す。
  const coordinated = !!(out.upper && out.lower);
  if (coordinated) coordinateUpper(out, plan);
  // 警告は噛み合わせたあとの値で集める（coordinateUpper が上顎の警告を出し直す）
  out.warnings = [...(out.upper?.warnings ?? []), ...(out.lower?.warnings ?? [])];

  // --- 咬合関係の予測 -------------------------------------------------
  const dU = (out.upper?.metrics.incisorChange ?? 0) + upperShift.z;
  const dL = (out.lower?.metrics.incisorChange ?? 0) + lowerShift.z;
  const ojAfter = coordinated ? out.upper.metrics.overjetAfter : oj + dU - dL;
  const obAfter = coordinated
    ? (plan.occlusion.overbiteAfter ?? 2.0)
    : ob + ((mx.mxImpaction ?? 0) * 0.15);
  const molarRelChange = upperShift.z - lowerShift.z
    + ((out.upper?.metrics.molarMesialization ?? 0) - (out.lower?.metrics.molarMesialization ?? 0));

  // --- Bolton 分析 ----------------------------------------------------
  let bolton = null;
  if (measurements.upper && measurements.lower) {
    const u33 = out.upper.metrics.sumMd33;
    const l33 = out.lower.metrics.sumMd33;
    const u66 = out.upper.metrics.sumMd66;
    const l66 = out.lower.metrics.sumMd66;
    const antRatio = u33 > 0 ? (l33 / u33) * 100 : 0;
    const allRatio = u66 > 0 ? (l66 / u66) * 100 : 0;
    bolton = {
      anteriorRatio: antRatio,
      overallRatio: allRatio,
      anteriorExcessLower: l33 - u33 * 0.772,
      overallExcessLower: l66 - u66 * 0.913,
    };
    if (Math.abs(bolton.anteriorExcessLower) > 1.5) {
      out.warnings.push(
        `Bolton 前歯比 ${antRatio.toFixed(1)}%（標準 77.2%）: ` +
        `${bolton.anteriorExcessLower > 0 ? '下顎' : '上顎'}前歯に ` +
        `${Math.abs(bolton.anteriorExcessLower).toFixed(1)}mm の過剰があります。IPR等での調整を検討してください。`);
    }
  }

  out.occlusion = {
    overjetBefore: oj, overjetAfter: ojAfter,
    overbiteBefore: ob, overbiteAfter: obAfter,
    molarRelChange,
    upperShift, lowerShift,
    // 治療後の犬歯・大臼歯の前後関係（mm、＋ が II 級方向）。
    // 治療前の値は出さない: 上下の咬合面写真はそれぞれ別の縮尺で測っており、
    // 上下の前後関係は写真からは確かめられない（実症例で 8〜14mm という
    // ありえない値になった）。治療前の前後関係は側方観の重ね合わせで確認する。
    classAfter: coordinated ? anteroposteriorClass(out, 'after') : null,
  };
  out.bolton = bolton;

  if (ojAfter < 0.5) {
    out.warnings.push(`予測オーバージェットが ${ojAfter.toFixed(1)}mm です。切端咬合・反対咬合となる可能性があります。`);
  }
  if (ojAfter > 6) {
    out.warnings.push(`予測オーバージェットが ${ojAfter.toFixed(1)}mm です。上顎前歯の後退量または固定源の設定を見直してください。`);
  }

  // --- 顔貌シミュレータへ渡す数値 --------------------------------------
  out.link = {
    u1retract: Math.max(0, out.upper?.metrics.retraction ?? 0),
    l1retract: Math.max(0, out.lower?.metrics.retraction ?? 0),
    u1change: out.upper?.metrics.incisorChange ?? 0,
    l1change: out.lower?.metrics.incisorChange ?? 0,
    mxAdvance: mx.mxAdvance ?? 0,
    mxImpaction: mx.mxImpaction ?? 0,
    mdSetback: mx.mdSetback ?? 0,
    genioAdvance: sg.genioAdvance ?? 0,
    overjetAfter: ojAfter,
    planId: plan.presetId,
  };

  return out;
}
