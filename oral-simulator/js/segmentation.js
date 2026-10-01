/**
 * segmentation.js
 * 口腔内写真（咬合面観）から歯列を検出し、歯ごとの位置・幅径・捻転を計測する。
 *
 * 処理の流れ:
 *   1. 歯／歯肉の分離        … 輝度と赤み（歯肉・粘膜）のスコア + 大津の二値化
 *   2. モルフォロジー処理    … 隣接歯間の暗線を埋めて歯列帯を1つの塊にする
 *   3. 極座標展開            … 「正中」「左右の最後方歯」の3点を基準に U 字を展開
 *   4. 歯の分離              … 隣接面（暗く・狭い）のスコアと標準幅径を使った
 *                              動的計画法で歯の境界を決める
 *   5. 歯ごとの計測          … 近遠心幅径・頬舌径・捻転角・平均色
 *
 * 自動検出は補助であり、3点のハンドルと歯の境界は画面上で手直しできる。
 * （editor2d.js が担当）
 */

import { luma, otsuThreshold } from '../../shared/js/imaging.js';
import { STANDARD_TEETH, RELIEF_SEG, RELIEF_RINGS } from './tooth-library.js';

/** 捻転角の分解能（これ未満は 0 とみなす, 度） */
export const ROTATION_FLOOR_DEG = 6;
/**
 * 捻転を測るのに必要な領域の細長さ（長径／短径）。
 * 上顎中切歯の咬合面観は 8.5 × 7.1mm で約 1.2、上顎小臼歯は 9.2 × 6.7mm で約 1.37。
 * これより丸い領域では主軸の向きが写真の揺らぎで決まってしまう。
 */
const ROTATION_MIN_ELONGATION = 1.15;
/** これを超える捻転の読みは信用しない（度） */
const ROTATION_MAX_TRUST_DEG = 30;

// ---------------------------------------------------------------------------
// 1. 歯のマスク
// ---------------------------------------------------------------------------

/**
 * 歯らしさのスコア画像（0-255）を作る。
 *
 * 決め手は **正規化した緑成分 g = G/(R+G+B)** である。
 * 歯肉・口唇・口蓋はヘモグロビンが緑を強く吸収するため g が低く、
 * 歯（エナメル質・象牙質）は g が高い。実際の口腔内写真で測ると:
 *
 *   歯     g = 0.317〜0.351
 *   口蓋   g = 0.251〜0.290
 *   歯肉   g = 0.257〜0.261
 *
 * 以前は彩度で見分けていたが、口腔内カメラは色温度が暖色に寄ることが多く、
 * 黄ばんだ歯では彩度が 0.34〜0.52 と歯肉（0.40〜0.56）に重なってしまい、
 * 実際の症例写真で歯列がまったく取れなかった。
 * g は明るさで割っているため、露出や色温度の違いにも強い。
 *
 * 顔の皮膚も g は歯に近いが、これは連結成分の選び方（中央への近さ・
 * 画像の縁への掛かり・U 字らしさ）で除く。
 */
export function toothScoreImage(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const sum = r + g + b;
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const v = max / 255;
    // 正規化した緑成分。0.29 以下は軟組織、0.32 以上は歯。
    const gn = sum > 12 ? g / sum : 0;
    const greenTerm = smoothStep(0.288, 0.324, gn);
    // 明るさ: 暗い口腔内の影を除く
    const valTerm = smoothStep(0.22, 0.42, v);
    out[p] = Math.round(255 * greenTerm * valTerm);
  }
  return out;
}

/**
 * その画素が歯の色かどうか（歯肉・舌・影を色づけに使わないための判定）。
 * toothScoreImage と同じ「正規化した緑成分」で見る。
 */
export function isToothColor(r, g, b) {
  const sum = r + g + b;
  if (sum < 60) return false;                 // 暗すぎる（影）
  return g / sum >= 0.300;
}

/** 0→1 になめらかに変化する窓 */
function smoothStep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}

/** 配列の分位点（しきい値の下限を決めるのに使う） */
function percentile(arr, q) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[arr[i]]++;
  const target = arr.length * q;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/**
 * 歯のマスクを作る（1 = 歯）。
 *
 * 返り値の mask は隣接面の暗線をクロージングで埋めて歯列を1つの帯に
 * つないだもの（歯列の連続性の判定に使う）。raw はクロージング前の
 * 二値化結果で、こちらは歯の実際の輪郭に忠実なので、頬舌径や
 * 帯の中心の計測にはこちらを使う。
 * （クロージングは歯列弓の凹側を埋めるため、曲率の大きい前歯部では
 *   帯の中心が舌側へずれてしまう。）
 */
export function buildToothMask(imageData, opts = {}) {
  const { width, height } = imageData;
  const score = toothScoreImage(imageData);

  // 大津の二値化は「暗部」と「それ以外」で切れてしまうことがあるため、
  // 画像中の最も歯らしい画素を基準にした下限を併用する。
  // （暗い口腔内・皮膚・歯 の3群があると、大津だけでは皮膚が残ってしまう）
  const bright = percentile(score, 0.985);
  const floor = Math.max(40, Math.round(bright * 0.42));
  const th = Math.max(floor, otsuThreshold(score));

  const raw0 = new Uint8Array(width * height);
  for (let p = 0; p < raw0.length; p++) raw0[p] = score[p] >= th ? 1 : 0;

  const rOpen = Math.max(1, opts.openRadius ?? 2);
  const open = (r) => dilate(erode(raw0, width, height, r), width, height, r);
  // 隣接面の暗線を埋めて歯列をつなぐ（クロージング）
  const rClose = Math.max(2, Math.round(width * 0.010));

  // 咬合面観では歯列がひとつながりになるので1つの成分を選ぶ。
  // 正面観・側方観では上下顎が別々の塊になるため、
  // 一定の大きさ以上の成分をすべて残す（largestOnly: false）。
  let raw;
  let picked;
  if (opts.largestOnly === false) {
    // 正面観・側方観では「閉じる前に」成分を選ぶ。閉じてから選ぶと、
    // 太らせる処理でリトラクタと歯が溶接されてひとつの成分になり、
    // 顔の皮膚まで歯として残ってしまう（実症例で、正面観のマスクの
    // 半分近くが皮膚になっていた）。閉じるのは選んだあとで行う。
    //
    // それでもリトラクタが歯に接して写っている写真では、両者が最初から
    // ひとつの成分になっている。その場合は縁に接する成分として丸ごと
    // 捨てられ、歯が消えてしまう。結果が歯列としてありえない小ささの
    // ときは、オープニングの半径を上げて細いつながりを切り、選び直す。
    // （実症例の左側方観では半径 2〜6 で 0.2%、8 で 11.1% と回復した。
    //   歯列は口腔内写真のおよそ 10% を占めるので 2% を下限とする。）
    const minKeep = width * height * 0.02;
    let sel = null;
    for (const k of [1, 2, 3, 4, 5]) {
      raw = open(rOpen * k);
      sel = componentsAbove(raw, width, height, (width * height) * 0.0006);
      if (sel.area >= minKeep) break;
    }
    picked = {
      mask: erode(dilate(sel.mask, width, height, rClose), width, height, rClose),
      area: sel.area,
    };
  } else {
    raw = open(rOpen);
    const closed = erode(dilate(raw, width, height, rClose), width, height, rClose);
    picked = bestArchComponent(closed, width, height);
  }

  // raw も歯列の範囲に限定しておく（頬粘膜やリトラクタの写り込みを除く）
  const rawInBand = new Uint8Array(width * height);
  for (let p = 0; p < rawInBand.length; p++) {
    rawInBand[p] = picked.mask[p] === 1 && raw[p] === 1 ? 1 : 0;
  }
  return { mask: picked.mask, raw: rawInBand, area: picked.area, threshold: th, score };
}

/**
 * 歯列らしい連結成分を1つ選ぶ。
 *
 * 単純に最大の成分を採ると、フレームの縁に広がった顔の皮膚が選ばれてしまう。
 * 口腔内写真では歯列は画面の中央寄りにあり、フレームの縁には接しないので、
 * 面積に「中央への近さ」と「縁に接していないこと」を掛けて選ぶ。
 */
function bestArchComponent(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const cx = w / 2, cy = h / 2;
  const diag = Math.hypot(w, h);
  const marginX = Math.max(2, Math.round(w * 0.04));
  const marginY = Math.max(2, Math.round(h * 0.04));

  const comps = [];
  let cur = 0;
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (mask[p0] !== 1 || label[p0] !== -1) continue;
    let sp = 0, area = 0, sx = 0, sy = 0, edge = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    stack[sp++] = p0;
    label[p0] = cur;
    while (sp > 0) {
      const q = stack[--sp];
      const x = q % w, y = (q / w) | 0;
      area++; sx += x; sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < marginX || x >= w - marginX || y < marginY || y >= h - marginY) edge++;
      if (x > 0 && mask[q - 1] === 1 && label[q - 1] === -1) { label[q - 1] = cur; stack[sp++] = q - 1; }
      if (x < w - 1 && mask[q + 1] === 1 && label[q + 1] === -1) { label[q + 1] = cur; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - w] === 1 && label[q - w] === -1) { label[q - w] = cur; stack[sp++] = q - w; }
      if (y < h - 1 && mask[q + w] === 1 && label[q + w] === -1) { label[q + w] = cur; stack[sp++] = q + w; }
    }
    const gx = sx / area, gy = sy / area;
    const dist = Math.hypot(gx - cx, gy - cy);
    const centerWeight = 1 / (1 + Math.pow(dist / (diag * 0.22), 2));
    // フレームの縁にかかる画素が多い成分は歯列ではない（皮膚・頬粘膜）
    const edgeRatio = edge / area;
    const edgeWeight = edgeRatio > 0.30 ? 0.05 : 1 - edgeRatio * 2;
    // 歯列は U 字なので、外接矩形の面積に対する占有率が低い（おおむね 0.35〜0.65）。
    // 口角鉤・ミラーの縁・頬粘膜のような塊や細長い帯はここから外れる。
    const boxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    const fill = area / boxArea;
    const shapeWeight = Math.max(0.25, 1 - Math.abs(fill - 0.5) / 0.5);
    comps.push({
      label: cur, area, gx, gy, dist, edgeRatio,
      score: area * centerWeight * Math.max(0.02, edgeWeight) * shapeWeight,
    });
    cur++;
  }

  const out = new Uint8Array(w * h);
  if (!comps.length) return { mask: out, area: 0 };
  comps.sort((a, b) => b.score - a.score);
  const best = comps[0];

  // 歯列はひとつながりとは限らない。隣接面の暗線・金属修復・写真の切れ方で
  // 左右が分かれることは普通にあり、最大の成分だけを残すと
  // 片側の歯列しか取れない（実際の症例写真でそうなった）。
  // 最良の成分と同程度に「歯らしい」成分はまとめて残す。
  const keep = new Set([best.label]);
  let area = best.area;
  for (const c of comps) {
    if (keep.has(c.label)) continue;
    if (c.area < Math.max(24, best.area * 0.06)) continue;   // ごま塩は捨てる
    if (c.edgeRatio > 0.30) continue;                        // 画像の縁にかかるものは捨てる
    if (c.dist > diag * 0.42) continue;                      // 中央から離れすぎ
    keep.add(c.label);
    area += c.area;
  }
  for (let p = 0; p < out.length; p++) out[p] = keep.has(label[p]) ? 1 : 0;
  return { mask: out, area };
}

/** 指定面積以上の連結成分をすべて残す */
function componentsAbove(mask, w, h, minArea) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const out = new Uint8Array(w * h);
  const kept = [];
  const rejected = [];
  let total = 0;
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (mask[p0] !== 1 || label[p0] !== -1) continue;
    let sp = 0, area = 0;
    let onL = 0, onR = 0, onT = 0, onB = 0;
    const members = [];
    stack[sp++] = p0;
    label[p0] = 1;
    while (sp > 0) {
      const q = stack[--sp];
      area++;
      members.push(q);
      const x = q % w, y = (q / w) | 0;
      if (x === 0) onL++;
      if (x === w - 1) onR++;
      if (y === 0) onT++;
      if (y === h - 1) onB++;
      if (x > 0 && mask[q - 1] === 1 && label[q - 1] === -1) { label[q - 1] = 1; stack[sp++] = q - 1; }
      if (x < w - 1 && mask[q + 1] === 1 && label[q + 1] === -1) { label[q + 1] = 1; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - w] === 1 && label[q - w] === -1) { label[q - w] = 1; stack[sp++] = q - w; }
      if (y < h - 1 && mask[q + w] === 1 && label[q + w] === -1) { label[q + w] = 1; stack[sp++] = q + w; }
    }
    if (area < minArea) continue;
    // 顔の皮膚・リトラクタを落とす。
    //
    // 正面観・側方観には患者の顔とリトラクタが大きく写り込む。実症例で
    // 画素値を測ったところ、皮膚・リトラクタと歯は色ではまったく分けられない
    // （正規化した緑成分は 歯 0.316 / 皮膚 0.322 / リトラクタ 0.321 で、
    // 皮膚のほうがわずかに緑が強いほど近い）。そのため色ではなく位置で分ける。
    //
    // 口腔内写真では、歯とフレームの縁のあいだに必ず口唇・頬・リトラクタが
    // 入るので、歯の成分はフレームの縁にかからない（実測 edgeRatio = 0.000）。
    // 顔の皮膚はフレームを取り囲むので必ずかかる（実測 0.18〜0.31）。
    let edge = 0;
    const mX = Math.max(2, Math.round(w * 0.04));
    const mY = Math.max(2, Math.round(h * 0.04));
    for (const q of members) {
      const x = q % w, y = (q / w) | 0;
      if (x < mX || x >= w - mX || y < mY || y >= h - mY) edge++;
    }
    const spansFrame = (onL > 0 && onR > 0) || (onT > 0 && onB > 0);
    if (spansFrame || edge / area > 0.05) { rejected.push(members); continue; }
    kept.push(members);
    for (const q of members) out[q] = 1;
    total += area;
  }
  // 全部落ちてしまった場合（極端に寄って撮った写真など）は、
  // 落とした中でいちばん大きいものを戻す。歯が消えるよりはよい。
  if (!kept.length && rejected.length) {
    let best = rejected[0];
    for (const m of rejected) if (m.length > best.length) best = m;
    for (const q of best) out[q] = 1;
    total = best.length;
  }
  return { mask: out, area: total };
}

/**
 * マスクを内側へ縮める。
 * 写真から色を拾うとき、歯と歯肉の境目の画素を拾うと歯がピンクに濁るため、
 * 輪郭から数画素内側だけを使う目的で公開している。
 */
export function erodeMask(mask, w, h, r) {
  return erode(mask, w, h, r);
}

/** 正方形構造要素による膨張（分離可能） */
function dilate(mask, w, h, r) {
  return sepMorph(mask, w, h, r, Math.max);
}
function erode(mask, w, h, r) {
  return sepMorph(mask, w, h, r, Math.min);
}
function sepMorph(mask, w, h, r, op) {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = mask[row + x];
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let i = x0; i <= x1; i++) v = op(v, mask[row + i]);
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let i = y0; i <= y1; i++) v = op(v, tmp[i * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 3点ハンドルの自動推定
// ---------------------------------------------------------------------------

/**
 * 歯列帯マスクから「正中（前方中央）」「左右の最後方」の3点を推定する。
 * 画像の向き（前歯が上／下／左／右）も自動判定する。
 *
 * 判定は歯列帯の外接矩形の中だけで行う（写真の余白の影響を受けないようにする）。
 * U 字の開いている側では1行あたりの連続領域が2つ（左右の臼歯部）になり、
 * 閉じている側（前歯部）では1つになることを利用する。
 *
 * @returns {{mid, right, left, orientation}|null} 写真ピクセル座標
 */
export function guessHandles(mask, w, h) {
  const bbox = maskBBox(mask, w, h);
  if (!bbox) return null;

  let best = null;
  for (const name of ['up', 'down', 'left', 'right']) {
    const central = centralReach(mask, w, bbox, name);
    if (!Number.isFinite(central)) continue;
    // 正中付近に歯があるのは前歯部だけ、というのが主な手がかり。
    // 僅差のときだけ、ラン数の増え方（U 字の開き方）で決める。
    const score = (1 - central) + 0.3 * orientationScore(mask, w, bbox, name);
    if (!best || score > best.score) best = { name, score };
  }
  if (!best) return null;

  const anterior = anteriorHandle(mask, w, bbox, best.name);
  const posterior = anterior
    ? posteriorHandles(mask, w, bbox, best.name, anterior)
    : null;

  // 患者の右側がどちら側に写るかは写真の向きで決まる
  // （前歯が上の標準的な向きでは、画面左が患者の右側）
  const rightIsSmaller = best.name === 'up' || best.name === 'right';

  const guess = (anterior && posterior) ? {
    mid: anterior,
    right: rightIsSmaller ? posterior.low : posterior.high,
    left: rightIsSmaller ? posterior.high : posterior.low,
    orientation: best.name,
    uncertain: false,
  } : null;

  // 推定できなかった場合や、基準点どうしが近すぎて歯列弓として
  // ありえない場合は、外接矩形からの既定位置に置く。
  // ここで null を返してしまうと STEP2 に何も出ず、手で直すこともできなくなる。
  if (guess && plausibleHandles(guess, bbox)) return guess;
  return { ...defaultHandles(bbox, best.name, rightIsSmaller), orientation: best.name, uncertain: true };
}

/** 基準3点が歯列弓としてありうる配置か */
function plausibleHandles(h, bbox) {
  const diag = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  const dR = Math.hypot(h.right.x - h.mid.x, h.right.y - h.mid.y);
  const dL = Math.hypot(h.left.x - h.mid.x, h.left.y - h.mid.y);
  const sep = Math.hypot(h.right.x - h.left.x, h.right.y - h.left.y);
  return dR > diag * 0.2 && dL > diag * 0.2 && sep > diag * 0.25;
}

/** 外接矩形から作る既定の基準3点（手で動かす出発点） */
function defaultHandles(bbox, name, rightIsSmaller) {
  const it = bandIterator(bbox, name);
  const at = (d, c) => it.at(Math.round(d), Math.round(c));
  const mid = at(it.depth * 0.06, it.cross * 0.5);
  const low = at(it.depth * 0.92, it.cross * 0.16);
  const high = at(it.depth * 0.92, it.cross * 0.84);
  return {
    mid: { x: mid.x, y: mid.y },
    right: rightIsSmaller ? { x: low.x, y: low.y } : { x: high.x, y: high.y },
    left: rightIsSmaller ? { x: high.x, y: high.y } : { x: low.x, y: low.y },
  };
}

/**
 * 正中の基準点を、歯列の**左右対称軸**として求める。
 *
 * 「前方 10% の帯の重心」を使う以前の方法は、写真の隅に写り込んだ
 * 光の反射・頬粘膜・口角鉤に重心を引っぱられて大きく外れた
 * （実際の症例写真で、正中が右上の隅に置かれた）。
 *
 * 歯列弓は正中に対してほぼ左右対称なので、
 * 「その位置で折り返したときにマスクがもっとも重なる」位置を探すほうがはるかに強い。
 * 隅の写り込みのような片側だけの塊は、折り返すと重ならないため効かない。
 */
function anteriorHandle(mask, w, bbox, name) {
  const it = bandIterator(bbox, name);
  const step = Math.max(1, Math.round(it.cross / 160));
  const dStep = Math.max(1, Math.round(it.depth / 120));

  // 深さごとのマスクの有無を粗い格子にまとめてから対称性を測る
  const nc = Math.floor(it.cross / step);
  const nd = Math.floor(it.depth / dStep);
  if (nc < 8 || nd < 8) return null;
  const grid = new Uint8Array(nc * nd);
  for (let di = 0; di < nd; di++) {
    for (let ci = 0; ci < nc; ci++) {
      const p = it.at(di * dStep, ci * step);
      if (mask[p.y * w + p.x] === 1) grid[di * nc + ci] = 1;
    }
  }

  let bestC = -1;
  let bestScore = -1;
  const lo = Math.floor(nc * 0.30);
  const hi = Math.ceil(nc * 0.70);
  for (let c0 = lo; c0 <= hi; c0++) {
    let inter = 0;
    let uni = 0;
    for (let di = 0; di < nd; di++) {
      const row = di * nc;
      for (let k = 1; k < nc; k++) {
        const a = c0 - k, b = c0 + k;
        if (a < 0 || b >= nc) break;
        const va = grid[row + a];
        const vb = grid[row + b];
        if (va && vb) inter++;
        if (va || vb) uni++;
      }
    }
    const score = uni > 0 ? inter / uni : 0;
    if (score > bestScore) { bestScore = score; bestC = c0; }
  }
  if (bestC < 0) return null;

  // 対称軸の近くで、もっとも前方にあるマスク画素の重心を正中とする
  const half = Math.max(2, Math.round(nc * 0.06));
  let firstD = -1;
  for (let di = 0; di < nd && firstD < 0; di++) {
    for (let ci = Math.max(0, bestC - half); ci <= Math.min(nc - 1, bestC + half); ci++) {
      if (grid[di * nc + ci]) { firstD = di; break; }
    }
  }
  if (firstD >= 0) {
    const span = Math.max(1, Math.round(nd * 0.06));
    let sx = 0, sy = 0, n = 0;
    for (let di = firstD; di < Math.min(nd, firstD + span); di++) {
      for (let ci = Math.max(0, bestC - half); ci <= Math.min(nc - 1, bestC + half); ci++) {
        if (!grid[di * nc + ci]) continue;
        const p = it.at(di * dStep, ci * step);
        sx += p.x; sy += p.y; n++;
      }
    }
    if (n) return { x: sx / n, y: sy / n };
  }

  // 正中付近に歯が写っていない場合（前歯が写真の外・ミラーや口唇で隠れている）。
  // 対称軸の上で、歯列全体のもっとも前方の深さに置く。
  let anyD = -1;
  for (let di = 0; di < nd && anyD < 0; di++) {
    for (let ci = 0; ci < nc; ci++) if (grid[di * nc + ci]) { anyD = di; break; }
  }
  if (anyD < 0) return null;
  const p = it.at(anyD * dStep, bestC * step);
  return { x: p.x, y: p.y };
}

/**
 * 左右それぞれの最後方歯の位置を求める。
 *
 * 「後方 20% の帯を最大の隙間で2つに割る」方法だと、片側の臼歯が欠けている
 * 症例（すでに抜歯済み、7番が未萌出など）で帯に片側の歯しか入らず、
 * 2つとも同じ側に置かれてしまう。正中を境に左右を分け、
 * **それぞれの側で一番後方にある部分**を見るようにすると、
 * 左右で歯列の長さが違っていても正しい位置に置ける。
 */
function posteriorHandles(mask, w, bbox, name, mid) {
  const it = bandIterator(bbox, name);
  const midCross = (name === 'up' || name === 'down')
    ? mid.x - bbox.minX
    : mid.y - bbox.minY;
  const span = Math.max(2, Math.round(it.depth * 0.12));
  const out = {};

  for (const key of ['low', 'high']) {
    const onSide = key === 'low'
      ? (c) => c < midCross
      : (c) => c > midCross;

    let deepest = -1;
    for (let d = it.depth - 1; d >= 0 && deepest < 0; d--) {
      for (let c = 0; c < it.cross; c++) {
        if (!onSide(c)) continue;
        const p = it.at(d, c);
        if (mask[p.y * w + p.x] === 1) { deepest = d; break; }
      }
    }
    if (deepest < 0) return null;

    let sx = 0, sy = 0, n = 0;
    for (let d = deepest; d > deepest - span && d >= 0; d--) {
      for (let c = 0; c < it.cross; c++) {
        if (!onSide(c)) continue;
        const p = it.at(d, c);
        if (mask[p.y * w + p.x] !== 1) continue;
        sx += p.x; sy += p.y; n++;
      }
    }
    if (!n) return null;
    out[key] = { x: sx / n, y: sy / n };
  }
  return out;
}

/**
 * 正中付近に歯の画素がどこまで（前方からどれだけ深く）あるか。0〜1。
 *
 * 咬合面観では、正中のあたりに歯があるのは前歯部だけで、
 * 臼歯部の正中側は口蓋（舌）で歯がない。したがってこの値がもっとも小さい向きが前方。
 * 歯が1本欠けていても、歯列がやや傾いていても崩れない手がかりである。
 */
function centralReach(mask, w, bbox, name) {
  const it = bandIterator(bbox, name);
  const c0 = Math.floor(it.cross * 0.42);
  const c1 = Math.min(it.cross - 1, Math.ceil(it.cross * 0.58));
  for (let d = it.depth - 1; d >= 0; d--) {
    for (let c = c0; c <= c1; c++) {
      const p = it.at(d, c);
      if (mask[p.y * w + p.x] === 1) return d / Math.max(1, it.depth - 1);
    }
  }
  return Infinity;
}

/**
 * その向きを「前方」と仮定したときの、U 字の開き方の強さ。
 *
 * 歯列を前方から後方へ走査すると、前歯部では連続領域（ラン）が1本、
 * 臼歯部では左右に分かれて2本になる。深さに対するラン数の回帰の傾きを見れば、
 * どちら向きが前方かが決まる。
 *
 * 以前は「浅い帯」と「深い帯」の平均を比べていたが、それだと片側の臼歯が
 * 欠けている症例（抜歯済み・7番が未萌出など）で一番深い帯に片側しか入らず、
 * 前後を取り違えることがあった。全体の傾きで見ると、
 * 片側が少し短いくらいでは判定が揺らがない。
 */
function orientationScore(mask, w, bbox, name) {
  const it = bandIterator(bbox, name);
  const minRun = Math.max(2, Math.round(it.cross * 0.02));
  const runs = [];
  const depths = [];
  for (let d = 0; d < it.depth; d++) {
    let run = 0, count = 0, any = 0;
    for (let c = 0; c < it.cross; c++) {
      const p = it.at(d, c);
      if (mask[p.y * w + p.x] === 1) { run++; any++; } else { if (run >= minRun) count++; run = 0; }
    }
    if (run >= minRun) count++;
    if (any > 0) {
      runs.push(count);
      depths.push(d / Math.max(1, it.depth - 1));
    }
  }
  if (runs.length < 8) return -Infinity;
  const mr = runs.reduce((a, b) => a + b, 0) / runs.length;
  const md = depths.reduce((a, b) => a + b, 0) / depths.length;
  let cov = 0, vd = 0;
  for (let i = 0; i < runs.length; i++) {
    cov += (runs[i] - mr) * (depths[i] - md);
    vd += (depths[i] - md) * (depths[i] - md);
  }
  return vd > 0 ? cov / vd : 0;
}

/** マスクの外接矩形 */
function maskBBox(mask, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 外接矩形の中で「前方 → 後方」の向きに走査するための添字変換。
 * depth は前方からの距離、cross はそれに直交する方向。
 */
function bandIterator(bbox, name) {
  const { minX, minY, maxX, maxY } = bbox;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  switch (name) {
    case 'up':   return { depth: bh, cross: bw, at: (d, c) => ({ x: minX + c, y: minY + d }) };
    case 'down': return { depth: bh, cross: bw, at: (d, c) => ({ x: minX + c, y: maxY - d }) };
    case 'left': return { depth: bw, cross: bh, at: (d, c) => ({ x: minX + d, y: minY + c }) };
    default:     return { depth: bw, cross: bh, at: (d, c) => ({ x: maxX - d, y: minY + c }) };
  }
}



// ---------------------------------------------------------------------------
// 3. 極座標展開
// ---------------------------------------------------------------------------

/**
 * 3点ハンドルを基準に歯列帯を展開する。
 *
 * 歯列帯のマスク画素に 4 次多項式 z = c0 + c1u + c2u² + c3u³ + c4u⁴
 * （u は正中方向を 0 とした側方座標）を最小二乗でフィットし、
 * その曲線を歯列の中心線として弧長でサンプリングする。
 * 深い U 字や左右非対称な歯列弓でも、弧長＝アーチ長が正しく求まる。
 *
 * @param {Uint8Array} mask
 * @param {ImageData} imageData
 * @param {{mid, right, left}} handles  写真ピクセル座標
 * @returns {{origin, fwd, left, samples}|null}
 *   samples[i] = { s, px, py, dx, dy, r, rIn, rOut, width, luma }
 *     s        正中を 0 とする符号付き弧長（+ が患者左側・単位はピクセル）
 *     px, py   歯列帯の中心点
 *     dx, dy   頬側向きの単位法線
 *     rIn/rOut/r  中心線からの法線方向のオフセット（内側/外側/帯の中央）
 */
export function unrollArch(mask, imageData, handles) {
  const { width: W, height: H, data } = imageData;
  const O = {
    x: (handles.right.x + handles.left.x) / 2,
    y: (handles.right.y + handles.left.y) / 2,
  };
  let fx = handles.mid.x - O.x;
  let fy = handles.mid.y - O.y;
  const flen = Math.hypot(fx, fy) || 1;
  fx /= flen; fy /= flen;
  // 患者左方向の単位ベクトル
  let lx = -fy, ly = fx;
  if (lx * (handles.left.x - O.x) + ly * (handles.left.y - O.y) < 0) { lx = -lx; ly = -ly; }

  const toFrame = (px, py) => {
    const dx = px - O.x, dy = py - O.y;
    return { x: dx * lx + dy * ly, z: dx * fx + dy * fy };
  };
  const toImage = (x, z) => ({ x: O.x + z * fx + x * lx, y: O.y + z * fy + x * ly });

  // --- 歯列の範囲は最後方歯の基準点で決める -------------------------
  // マスクの端までたどると、口角鉤・頬粘膜・光の反射といった歯列の外の
  // 写り込みまで歯列としてなぞってしまう（実際の症例写真で、患者左側の弧が
  // 最後方歯を越えて画像の隅まで伸び、臼歯部に歯番が割り当たらなくなった）。
  // 2つの青い基準点は「歯列がここで終わる」という指定なので、それに従う。
  const xR = toFrame(handles.right.x, handles.right.y).x;
  const xL = toFrame(handles.left.x, handles.left.y).x;
  const span = Math.abs(xL - xR);
  const margin = Math.max(4, span * 0.18);
  const xLo = Math.min(xR, xL) - margin;
  const xHi = Math.max(xR, xL) + margin;

  // --- マスク画素を歯列弓の座標系へ ---------------------------------
  const pts = [];
  let xMin = Infinity, xMax = -Infinity;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (mask[y * W + x] !== 1) continue;
      const f = toFrame(x, y);
      if (f.x < xLo || f.x > xHi) continue;
      pts.push(f);
      if (f.x < xMin) xMin = f.x;
      if (f.x > xMax) xMax = f.x;
    }
  }
  if (pts.length < 50) return null;

  // --- 4次多項式のフィット（数値安定のため側方座標を正規化）---------
  const xScale = Math.max(1, Math.max(Math.abs(xMin), Math.abs(xMax)));
  const rows = pts.map((p) => {
    const u = p.x / xScale;
    return [1, u, u * u, u * u * u, u * u * u * u];
  });
  const coef = solveNormalEquations(rows, pts.map((p) => p.z), 5);
  if (coef.some((c) => !Number.isFinite(c))) return null;
  const zOf = (x) => {
    const u = x / xScale;
    return coef[0] + coef[1] * u + coef[2] * u * u + coef[3] * u ** 3 + coef[4] * u ** 4;
  };

  // --- 1回目: フィットした曲線を画像座標のポリラインにする -----------
  const STEP = 0.5;
  const coarse = [];
  for (let x = xMin; x <= xMax; x += STEP) {
    coarse.push(toImage(x, zOf(x)));
  }
  if (coarse.length < 20) return null;

  // --- 2回目: 帯の中心（中心軸）を求めて中心線を作り直す --------------
  // 4次曲線のフィットは z 方向の残差を最小化するため、歯列弓が急峻になる
  // 臼歯部で中心からずれる。実際に帯を走査して中心を取り直すことで、
  // 弧長＝アーチ長が正しく求まるようにする。
  const maxHalf = Math.min(W, H) * 0.12;
  const centers = [];
  for (let i = 0; i < coarse.length; i++) {
    const n = normalAt(coarse, i, O);
    const band = scanBand(mask, W, H, coarse[i], n, maxHalf);
    if (!band) continue;
    centers.push({
      x: coarse[i].x + n.x * band.mid,
      y: coarse[i].y + n.y * band.mid,
    });
  }
  if (centers.length < 20) return null;
  const rawCenterline = smoothPolyline(centers, 6);
  // 捻転の計測用に、個々の歯の凹凸をならした「理想的な歯列弓」を作る。
  // 単純な移動平均では前歯部の曲率まで失われて系統誤差が出るため、
  // 2次の局所回帰（Savitzky-Golay）で曲率を保ったまま平滑化する。
  const reference = smoothPolylineQuadratic(rawCenterline, 40);

  // 弧長（歯の幅径・境界の座標）を測る中心線は、弧長で等間隔に取り直してから
  // 画素単位の窓でならしたものを使う。
  //
  // 走査で求めた帯の中心は、マスクの欠け（小臼歯が一部しか取れない等）や
  // 隣接面の暗部で 1 本ごとに跳ね、ジグザグになる。以前の 6 点の移動平均は
  // x 方向に等間隔の点に掛けていたため、前歯部ではほとんど効かなかった。
  // ジグザグの長さがそのまま弧長に乗り、実症例では弧長が歯列の実際の道のりより
  // 7〜20% 長くなっていた（上顎右側 753px 対 626px）。弧長で測る幅径と
  // 画素/mm がそろって膨らむため、画素座標で測る歯列弓の寸法が相対的に縮み、
  // 叢生量の過大評価や 5 番と 6 番の区切りのずれの原因になっていた。
  const centerline = smoothByArc(rawCenterline);

  // --- 弧長テーブル ---------------------------------------------------
  const arc = [0];
  for (let i = 1; i < centerline.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(
      centerline[i].x - centerline[i - 1].x,
      centerline[i].y - centerline[i - 1].y));
  }
  const arcTotal = arc[arc.length - 1];
  if (arcTotal < 20) return null;

  // 正中（mid ハンドル）に最も近い点を弧長 0 にする
  let zeroI = 0, zeroD = Infinity;
  for (let i = 0; i < centerline.length; i++) {
    const d = Math.hypot(centerline[i].x - handles.mid.x, centerline[i].y - handles.mid.y);
    if (d < zeroD) { zeroD = d; zeroI = i; }
  }
  const s0 = arc[zeroI];

  // 最後方歯の基準点に対応する弧長を求め、そこから少しだけ遠心までを
  // 歯列の範囲とする。マスクの端までなぞると、口角鉤・頬粘膜・光の反射を
  // 歯列として拾い、臼歯部に歯番が割り当たらなくなる。
  const arcNear = (pt) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < centerline.length; i++) {
      const d = Math.hypot(centerline[i].x - pt.x, centerline[i].y - pt.y);
      if (d < bd) { bd = d; bi = i; }
    }
    return arc[bi];
  };
  const aR = arcNear(handles.right);
  const aL = arcNear(handles.left);
  // 基準点は最後方歯の「中央」に置かれるので、半歯ぶん遠心へ広げる
  const tail = Math.max(8, Math.abs(aL - aR) * 0.055);
  const aLo = Math.max(0, Math.min(aR, aL) - tail);
  const aHi = Math.min(arcTotal, Math.max(aR, aL) + tail);

  // --- 弧長で等間隔にサンプリングし、帯の範囲と輝度を測る -------------
  const SAMPLE = 1.2;
  const samples = [];
  for (let a = aLo; a <= aHi; a += SAMPLE) {
    const i0 = Math.max(0, Math.min(centerline.length - 2, lowerBound(arc, a)));
    const span = arc[i0 + 1] - arc[i0] || 1;
    const t = (a - arc[i0]) / span;
    const center = {
      x: centerline[i0].x + (centerline[i0 + 1].x - centerline[i0].x) * t,
      y: centerline[i0].y + (centerline[i0 + 1].y - centerline[i0].y) * t,
    };
    const n = normalAt(centerline, i0, O);
    const band = scanBand(mask, W, H, center, n, maxHalf);
    if (!band) continue;

    // 帯を横断する輝度のうち暗いほうから 30% の平均を採る。
    // 隣接面（コンタクトポイントと鼓形空隙）は帯を横切る暗い線として現れるので、
    // 平均輝度より暗部に着目したほうが境界が出やすい。
    const lums = [];
    const lo = band.rIn + band.width * 0.08;
    const hi = band.rOut - band.width * 0.08;
    for (let r = lo; r <= hi; r += 1) {
      const px = Math.round(center.x + n.x * r);
      const py = Math.round(center.y + n.y * r);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const idx = (py * W + px) * 4;
      lums.push(luma(data[idx], data[idx + 1], data[idx + 2]));
    }
    lums.sort((a2, b2) => a2 - b2);
    const take = Math.max(1, Math.round(lums.length * 0.3));
    const darkMean = lums.length
      ? lums.slice(0, take).reduce((a2, b2) => a2 + b2, 0) / take
      : 0;
    // 帯を横断する輝度の上位 30% 点。
    //
    // 隣接面（鼓形空隙）では帯の断面が「端から端まで」暗くなるので、
    // 明るいほうの分位点まで落ちる。いっぽう大臼歯の小窩裂溝は溝の底だけが
    // 暗く、両側の咬頭は明るいままなので、この分位点はほとんど下がらない。
    // 暗部の平均（darkMean）では裂溝と隣接面が区別できず、境界が歯の
    // 真ん中に落ちることがあった。
    const bright = lums.length ? lums[Math.min(lums.length - 1, Math.floor(lums.length * 0.70))] : 0;

    // 平滑化した基準弓からの頬舌的なずれ（歯の転位・捻転の計測に使う）
    const ref = reference[Math.min(reference.length - 1, i0)];
    const bandCx = center.x + n.x * band.mid;
    const bandCy = center.y + n.y * band.mid;
    const offset = (bandCx - ref.x) * n.x + (bandCy - ref.y) * n.y;

    samples.push({
      s: a - s0,
      px: bandCx,
      py: bandCy,
      dx: n.x,
      dy: n.y,
      r: band.mid,
      rIn: band.rIn,
      rOut: band.rOut,
      width: band.width,
      luma: darkMean,
      bright,
      offset,
    });
  }
  if (samples.length < 12) return null;

  // 帯の半径（中心・内縁・外縁）を弧長方向にならす。
  //
  // 走査は1本ずつ独立に行うので、唾液の反射・裂溝・マスクの欠けで
  // 隣り合う走査線の結果が 1〜2mm も食い違うことがある。実症例では帯の
  // 中心線がぎざぎざに蛇行し、歯の中心・頬舌径・捻転角がその雑音を
  // そのまま拾っていた（3Dの歯列が不自然にV字になる一因でもあった）。
  // 実際の歯列帯は弧に沿ってなめらかに変わるので、ここでならす。
  // 窓は歯列全体の 2%（成人の全歯列がおよそ 100mm なので 2mm 前後）。
  // 画素/mm を知らなくても歯列の長さに比例して決まる。
  const winR = Math.max(2, Math.round(samples.length * 0.02));
  // 叢生が強い前歯部では、走査線が唇側に並ぶ歯と舌側に並ぶ歯のあいだを
  // 行き来して、中心線が輪を描くように折り返すことがある。こうした飛びは
  // 平均では消えないので、まず中央値で外れ値を落としてから平均でならす。
  const sm3 = (key) => {
    const src = samples.map((x) => x[key]);
    const n2 = src.length;
    const med = src.map((_, i) => {
      const w = [];
      for (let j = Math.max(0, i - winR); j <= Math.min(n2 - 1, i + winR); j++) w.push(src[j]);
      w.sort((a, b) => a - b);
      return w[w.length >> 1];
    });
    return med.map((_, i) => {
      let sum = 0, k = 0;
      for (let j = Math.max(0, i - winR); j <= Math.min(n2 - 1, i + winR); j++) { sum += med[j]; k++; }
      return sum / k;
    });
  };
  const sR = sm3('r');
  const sIn = sm3('rIn');
  const sOut = sm3('rOut');
  for (let i = 0; i < samples.length; i++) {
    const sm = samples[i];
    // 中心線が動くので、画素座標も引き直す
    sm.px += sm.dx * (sR[i] - sm.r);
    sm.py += sm.dy * (sR[i] - sm.r);
    sm.r = sR[i];
    sm.rIn = sIn[i];
    sm.rOut = sOut[i];
    sm.width = sOut[i] - sIn[i];
  }

  return { origin: O, fwd: { x: fx, y: fy }, left: { x: lx, y: ly }, samples };
}

/** ポリラインの i 番目における外向き（歯列弓の外側）単位法線 */
function normalAt(poly, i, inner) {
  const a = poly[Math.max(0, i - 3)];
  const b = poly[Math.min(poly.length - 1, i + 3)];
  let tx = b.x - a.x, ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;
  let nx = -ty, ny = tx;
  const p = poly[i];
  if (nx * (p.x - inner.x) + ny * (p.y - inner.y) < 0) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}

/**
 * 局所多項式回帰によるポリラインの平滑化（Savitzky-Golay 型）。
 * 各点まわりの窓で x(t), y(t) を2次式に当てはめ、中心 t=0 の値を返す。
 * 移動平均と違い曲率が保たれるので、歯列弓の「理想形」の基準に使える。
 */
function smoothPolylineQuadratic(poly, r) {
  const out = new Array(poly.length);
  for (let i = 0; i < poly.length; i++) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(poly.length - 1, i + r);
    const rows = [];
    const xs = [];
    const ys = [];
    for (let j = lo; j <= hi; j++) {
      const t = (j - i) / r;
      rows.push([1, t, t * t]);
      xs.push(poly[j].x);
      ys.push(poly[j].y);
    }
    const cx = solveNormalEquations(rows, xs, 3);
    const cy = solveNormalEquations(rows, ys, 3);
    out[i] = Number.isFinite(cx[0]) && Number.isFinite(cy[0])
      ? { x: cx[0], y: cy[0] }
      : { x: poly[i].x, y: poly[i].y };
  }
  return out;
}

/**
 * 折れ線を弧長 1px 間隔で取り直し、弧長で決めた窓で 2 回ならす。
 * 窓は全長の 4%（片顎の全歯列がおよそ 100mm なので 4mm 前後）。
 * 帯の中心のジグザグ（1 歯より短い周期）を消し、歯列弓の曲がり
 * （犬歯部の曲率半径は 15mm 前後）はほとんど削らない大きさ。
 * 実写で 1.5〜6% を試し、4% で上顎の全歯と下顎右側の全歯が正しい歯に
 * 載ることを写真への重ね描きで確認した（2.5% では下顎の 43/44 が重なった）。
 */
function smoothByArc(poly) {
  if (poly.length < 3) return poly;
  const out = [poly[0]];
  let carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    let t = 1 - carry;
    while (t <= seg) {
      const f = seg > 0 ? t / seg : 0;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      t += 1;
    }
    carry = seg - (t - 1);
  }
  const win = Math.max(4, Math.round(out.length * 0.04));
  return smoothPolyline(smoothPolyline(out, win), win);
}

/** ポリラインの移動平均による平滑化 */
function smoothPolyline(poly, r) {
  return poly.map((_, i) => {
    let sx = 0, sy = 0, c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(poly.length - 1, i + r); j++) {
      sx += poly[j].x; sy += poly[j].y; c++;
    }
    return { x: sx / c, y: sy / c };
  });
}

/** 中心点から法線方向に走査し、歯列帯の内外の縁を求める */
function scanBand(mask, W, H, center, n, maxHalf) {
  const runs = [];
  let start = null;
  for (let r = -maxHalf; r <= maxHalf; r += 1) {
    const px = Math.round(center.x + n.x * r);
    const py = Math.round(center.y + n.y * r);
    const inside = px >= 0 && py >= 0 && px < W && py < H && mask[py * W + px] === 1;
    if (inside && start === null) start = r;
    if ((!inside || r + 1 > maxHalf) && start !== null) {
      runs.push({ rIn: start, rOut: r, width: r - start });
      start = null;
    }
  }
  if (runs.length === 0) return null;
  // 中心線（r=0）を含む区間を優先し、無ければ最も近い区間を採る
  let best = runs.find((run) => run.rIn <= 0 && run.rOut >= 0);
  if (!best) {
    best = runs.reduce((a, b) =>
      Math.abs((b.rIn + b.rOut) / 2) < Math.abs((a.rIn + a.rOut) / 2) ? b : a);
  }
  if (best.width < 3) return null;
  return { ...best, mid: (best.rIn + best.rOut) / 2 };
}

/** 昇順配列 arr で arr[i] <= v < arr[i+1] となる i を返す */
function lowerBound(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid;
  }
  return lo;
}

/** 正規方程式による線形最小二乗 */
function solveNormalEquations(rows, ys, k) {
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let r = 0; r < rows.length; r++) {
    const br = rows[r];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += br[i] * br[j];
      A[i][k] += br[i] * ys[r];
    }
  }
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

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------------------
// 4. 歯の境界検出（動的計画法）
// ---------------------------------------------------------------------------

/**
 * 隣接面らしさのスコアを弧長方向に計算する（0-1、大きいほど隣接面らしい）。
 */
function separationScore(samples) {
  // 隣接面では帯の断面が端から端まで暗くなる（bright が落ちる）。
  // 裂溝は溝の底だけが暗く、咬頭は明るいままなので bright は落ちない。
  // 以前は暗部の平均（luma）を使っていたため、裂溝を隣接面と取り違えて
  // 歯の真ん中に境界が落ちることがあった。
  const brt = samples.map((s) => s.bright ?? s.luma);
  const wid = samples.map((s) => s.width);
  const nb = normalize(brt);
  const nw = normalize(wid);
  const raw = samples.map((_, i) => 0.75 * (1 - nb[i]) + 0.25 * (1 - nw[i]));
  return smooth(raw, 3);
}

function normalize(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  const d = hi - lo || 1;
  return arr.map((v) => clamp01((v - lo) / d));
}

function smooth(arr, r) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(arr.length - 1, i + r); j++) { s += arr[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

/**
 * 片側の歯列について、歯の境界となる弧長を動的計画法で決定する。
 * @param {Array} samples unrollArch の samples
 * @param {number[]} expectedWidthsPx 近心から遠心への期待幅径（px）
 * @param {number} side +1 = 患者左, -1 = 患者右
 * @returns {{bounds: number[], cost: number}|null}
 *   bounds は境界の弧長（|s| の昇順、長さ = 歯数 + 1、先頭は 0）
 */
function solveQuadrant(samples, expectedWidthsPx, side) {
  const pts = samples
    .filter((sm) => (side > 0 ? sm.s >= 0 : sm.s <= 0))
    .map((sm) => ({ s: Math.abs(sm.s), sep: sm.sep }))
    .sort((a, b) => a.s - b.s);
  if (pts.length < 8) return null;

  const total = pts[pts.length - 1].s;
  const G = 160;
  const grid = Array.from({ length: G + 1 }, (_, i) => (total * i) / G);
  const sepAt = grid.map((s) => interpAt(pts, s));

  const K = expectedWidthsPx.length;
  const INF = 1e18;
  // dp[k][g] = 歯 k 本を並べ終えた境界が g にあるときの最小コスト
  const dp = Array.from({ length: K + 1 }, () => new Float64Array(G + 1).fill(INF));
  const from = Array.from({ length: K + 1 }, () => new Int32Array(G + 1).fill(-1));
  dp[0][0] = 0;

  for (let k = 1; k <= K; k++) {
    const E = expectedWidthsPx[k - 1];
    const minW = E * 0.62, maxW = E * 1.55;
    for (let g = 1; g <= G; g++) {
      const sHere = grid[g];
      let best = INF, bestPrev = -1;
      for (let p = 0; p < g; p++) {
        if (dp[k - 1][p] >= INF) continue;
        const wpx = sHere - grid[p];
        if (wpx < minW || wpx > maxW) continue;
        const dev = (wpx - E) / E;
        // 写真に写っている隣接面を主、標準幅径を従として重み付けする。
        //
        // 以前は 26 : 1.2 で標準幅径が 20 倍以上効いており、境界は事実上
        // 「平均的な歯の幅」で決まっていた。実症例では歯の並びが 1 本ぶん
        // ずれ、下顎左側の 7 歯すべてが隣の歯に割り当てられていた。
        // 幅径の範囲（0.62〜1.55 倍）でありえない分割は依然として除かれる
        // ので、標準値は「範囲の制約」として残り、位置決めは画像が行う。
        // 重みは実測で決めた。隣接面スコアの作り方を「帯の断面が端から端まで
        // 暗いか」に変えたうえで 2〜26 × 1.2〜20 を振ったところ、もとの
        // 26 : 1.2 がもっとも多くの歯で2次元領域と一致した（20/28）。
        // 画像側の重みだけを強めても改善しなかった。基準点が正しくても、
        // 終端を自由にすると最後方歯を取り残すため、下の終端制約も必要。
        const cost = dp[k - 1][p] + 26 * dev * dev - 1.2 * sepAt[g];
        if (cost < best) { best = cost; bestPrev = p; }
      }
      dp[k][g] = best;
      from[k][g] = bestPrev;
    }
  }

  // 最後方の基準点で切り出した歯列帯を、最後の歯まで使い切る。
  // 以前は帯の 55% までで終了でき、縮小した標準幅を並べるだけで低コストに
  // なった。末端からの距離の罰則は小さく、正しい7番の基準点があっても
  // 6番付近で終了し、途中の歯を二分して7歯と数えてしまった。
  // マスク端の欠け・平滑化の誤差には5%の余裕を残すが、1歯ぶんの放棄は許さない。
  let endG = -1, endCost = INF;
  for (let g = Math.floor(G * 0.95); g <= G; g++) {
    if (dp[K][g] >= INF) continue;
    const tailPenalty = 12 * Math.pow((total - grid[g]) / Math.max(1, total), 2);
    const c = dp[K][g] + tailPenalty;
    if (c < endCost) { endCost = c; endG = g; }
  }
  if (endG < 0) return null;

  const bounds = new Array(K + 1);
  let g = endG;
  for (let k = K; k >= 0; k--) {
    bounds[k] = grid[g];
    g = from[k][g];
    if (g < 0 && k > 0) return null;
  }
  return { bounds, cost: endCost };
}

function interpAt(pts, s) {
  if (s <= pts[0].s) return pts[0].sep;
  if (s >= pts[pts.length - 1].s) return pts[pts.length - 1].sep;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s <= s) lo = mid; else hi = mid;
  }
  const span = pts[hi].s - pts[lo].s || 1;
  const f = (s - pts[lo].s) / span;
  return pts[lo].sep * (1 - f) + pts[hi].sep * f;
}

// ---------------------------------------------------------------------------
// 5. 全体の実行
// ---------------------------------------------------------------------------

/**
 * 咬合面写真から歯列を検出する。
 * @param {ImageData} imageData
 * @param {object} opts
 * @param {'upper'|'lower'} opts.arch
 * @param {{mid, right, left}} opts.handles 写真ピクセル座標の3点
 * @param {number[]} opts.positions 各側に存在する歯の番号（近心から, 例 [1,2,3,4,5,6,7]）
 * @returns {object|null} 検出結果
 */
export function detectArch(imageData, opts) {
  const { arch, handles } = opts;
  // 歯の欠損・未萌出は左右で違うため、存在する歯番は側ごとに受け取る
  // （配列で渡された場合は左右とも同じとみなす）
  const posOf = (side) => (Array.isArray(opts.positions)
    ? opts.positions
    : (opts.positions?.[side] ?? []));
  if (!posOf('R').length || !posOf('L').length) return null;

  const { mask, raw } = buildToothMask(imageData);
  const unrolled = unrollArch(mask, imageData, handles);
  if (!unrolled) return null;

  const sep = separationScore(unrolled.samples);
  unrolled.samples.forEach((sm, i) => { sm.sep = sep[i]; });

  // スケールのブートストラップ: 片側の弧長 ÷ その側に存在する歯の標準幅径の合計
  const stdOf = (side) => posOf(side).map((p) => STANDARD_TEETH[arch][p].md);
  const sumOf = (side) => stdOf(side).reduce((a, b) => a + b, 0);
  const sMin = Math.min(...unrolled.samples.map((s) => s.s));
  const sMax = Math.max(...unrolled.samples.map((s) => s.s));
  const armOf = { R: Math.abs(sMin), L: Math.abs(sMax) };
  const pxPerMm0 = (armOf.R / Math.max(1e-6, sumOf('R'))
    + armOf.L / Math.max(1e-6, sumOf('L'))) / 2;

  // ブートストラップのスケールには誤差があるため、倍率を振って
  // もっとも当てはまりのよいものを選ぶ
  const result = { mask, raw, unrolled, pxPerMm: pxPerMm0, arch,
    handles: { mid: { ...handles.mid }, right: { ...handles.right }, left: { ...handles.left } }, sides: {} };
  let bestScale = 1, bestCost = Infinity, bestSolutions = null;
  for (let f = 0.82; f <= 1.201; f += 0.03) {
    const sols = {};
    let total = 0, ok = true;
    for (const side of ['R', 'L']) {
      const expected = stdOf(side).map((w) => w * pxPerMm0 * f);
      const sol = solveQuadrant(unrolled.samples, expected, side === 'L' ? 1 : -1);
      if (!sol) { ok = false; break; }
      sols[side] = sol;
      total += sol.cost;
    }
    if (ok && total < bestCost) { bestCost = total; bestScale = f; bestSolutions = sols; }
  }
  for (const side of ['R', 'L']) {
    const sol = bestSolutions?.[side];
    result.sides[side] = {
      bounds: sol ? sol.bounds : fallbackBounds(stdOf(side).map((w) => w * pxPerMm0)),
      positions: [...posOf(side)],
    };
  }
  result.fitScale = bestScale;

  // 画素/mm を、検出できた「すべての歯」から求める。
  //
  // 以前は中切歯 2 本の幅だけで歯列全体のスケールを決めていた。下顎中切歯は
  // 歯列でもっとも小さく（標準 5.4mm）、叢生で捻転していることも多いので、
  // 0.5mm の検出誤差がそのまま 9% のスケール誤差になる。実症例では
  // 下顎が上顎より 8.7% 大きいスケールと判定され、下顎歯列弓の幅径が
  // 3〜5mm 狭く出ていた（第一大臼歯間 35.2mm／標準 38〜42mm）。
  //
  // 歯ごとの「検出幅 ÷ 標準幅」の中央値を採る。合計の比ではなく中央値に
  // するのは、境界がずれた 1〜2 歯に引きずられないようにするため。
  const ratios = [];
  for (const side of ['R', 'L']) {
    const b = result.sides[side].bounds;
    const ps = result.sides[side].positions;
    for (let i = 0; i < ps.length && i + 1 < b.length; i++) {
      const std = STANDARD_TEETH[arch][ps[i]]?.md;
      const wpx = b[i + 1] - b[i];
      if (!(std > 0) || !(wpx > 0)) continue;
      ratios.push(wpx / std);
    }
  }
  if (ratios.length >= 4) {
    ratios.sort((a, b2) => a - b2);
    const mid = ratios.length >> 1;
    result.pxPerMm = ratios.length % 2
      ? ratios[mid]
      : (ratios[mid - 1] + ratios[mid]) / 2;
  } else {
    result.pxPerMm = pxPerMm0;
  }
  result.scaleSamples = ratios.length;
  return result;
}

function fallbackBounds(expected) {
  const b = [0];
  let s = 0;
  for (const e of expected) { s += e; b.push(s); }
  return b;
}

// ---------------------------------------------------------------------------
// 1歯ずつの2次元領域（分水嶺法）
// ---------------------------------------------------------------------------
//
// これ以前は、歯の輪郭を「歯列帯（弧長ごとの内縁 rIn と外縁 rOut）を
// 弧長で切った薄切り」から作っていた。この作り方では
//
//   ・近心面・遠心面が「弧長で切った位置」という人工的な直線になる
//   ・隣り合う歯の薄切りが重なり、歯どうしが食い込む
//   ・歯1本の2次元の footprint（実際に写っている形）を表せない
//
// という限界があり、実症例では輪郭が隣の歯に大きくかぶっていた。
//
// 咬合面観では隣接面が暗い線としてはっきり写る。そこで「暗さ」を尾根と
// みなした分水嶺法（marker-controlled watershed）で、歯ごとの2次元領域を
// 直接切り出す。種は歯列帯の薄切りの重心に置く（どの歯が何本目かは
// これまでどおり弧長方向の動的計画法で決める）。

/**
 * 咬合面観から歯ごとの2次元領域を切り出す。
 *
 * @returns {Map<string, {pixels:Int32Array, cx:number, cy:number, area:number}>}
 *   キーは `${side}${index}`
 */
function segmentToothRegions(detection, imageData) {
  const { unrolled, mask } = detection;
  const { width: W, height: H, data } = imageData;
  const N = W * H;

  // --- 種（マーカー）------------------------------------------------
  const seed = new Int32Array(N);
  const keys = [];
  for (const side of ['R', 'L']) {
    const dir = side === 'L' ? 1 : -1;
    const { bounds, positions } = detection.sides[side];
    for (let i = 0; i < positions.length; i++) {
      const s0 = bounds[i] * dir;
      const s1 = bounds[i + 1] * dir;
      const seg = unrolled.samples.filter((sm) => (sm.s - s0) * (sm.s - s1) <= 0);
      if (!seg.length) continue;
      // 薄切りの重心（マスクの内側だけ）
      let sx = 0, sy = 0, n = 0;
      for (const sm of seg) {
        for (let R = sm.rIn; R <= sm.rOut; R += 1) {
          const px = Math.round(sm.px + sm.dx * (R - sm.r));
          const py = Math.round(sm.py + sm.dy * (R - sm.r));
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          if (mask[py * W + px] !== 1) continue;
          sx += px; sy += py; n++;
        }
      }
      if (n < 12) continue;
      let cx = Math.round(sx / n);
      let cy = Math.round(sy / n);
      // 帯の末端は平滑化で最後方歯の中央付近まで縮むことがある。
      // 最後の薄切りの重心を種にすると6/7間に落ち、両方へ広がってしまう。
      // 最後方歯を指定した基準点が、現在の境界内かつ実際の歯のマスク内なら
      // その点を種にする。手動境界で範囲外へ出した点は採用しない。
      const anchor = detection.handles?.[side === 'L' ? 'left' : 'right'];
      if (i === positions.length - 1 && anchor) {
        const ax = Math.round(anchor.x), ay = Math.round(anchor.y);
        const nearest = unrolled.samples.reduce((a, b) =>
          Math.hypot(a.px - anchor.x, a.py - anchor.y) < Math.hypot(b.px - anchor.x, b.py - anchor.y) ? a : b);
        if (ax >= 0 && ay >= 0 && ax < W && ay < H && detection.raw?.[ay * W + ax] === 1
            && (nearest.s - s0) * (nearest.s - s1) <= 0) {
          cx = ax; cy = ay;
        }
      }
      const id = keys.length + 1;
      keys.push(`${side}${i}`);
      // 種は点ではなく小さな円にする（1画素だと裂溝の底に落ちて広がらない）
      const rad = Math.max(2, Math.round(Math.sqrt(n) * 0.18));
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const q = y * W + x;
          if (mask[q] !== 1) continue;
          seed[q] = id;
        }
      }
    }
  }
  if (!keys.length) return new Map();

  // --- 標高（暗いほど高い＝隣接面が尾根になる）-----------------------
  const elev = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (mask[p] !== 1) { elev[p] = 255; continue; }
      // 3x3 でならしてから使う（画素のざらつきで偽の尾根ができないように）
      let sum = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const i = (yy * W + xx) * 4;
          sum += luma(data[i], data[i + 1], data[i + 2]);
          k++;
        }
      }
      elev[p] = 255 - Math.max(0, Math.min(255, Math.round(sum / k)));
    }
  }

  const label = priorityFlood(elev, mask, seed, W, H);

  // --- 領域ごとにまとめる --------------------------------------------
  const counts = new Int32Array(keys.length + 1);
  for (let p = 0; p < N; p++) counts[label[p]]++;
  const buf = keys.map((_, i) => new Int32Array(counts[i + 1]));
  const fill = new Int32Array(keys.length + 1);
  const sumX = new Float64Array(keys.length + 1);
  const sumY = new Float64Array(keys.length + 1);
  for (let p = 0; p < N; p++) {
    const id = label[p];
    if (!id) continue;
    buf[id - 1][fill[id]++] = p;
    sumX[id] += p % W;
    sumY[id] += (p / W) | 0;
  }
  const out = new Map();
  for (let i = 0; i < keys.length; i++) {
    const area = counts[i + 1];
    if (area < 30) continue;
    out.set(keys[i], {
      pixels: buf[i], area,
      cx: sumX[i + 1] / area,
      cy: sumY[i + 1] / area,
    });
  }
  return out;
}

/**
 * マーカーからの優先度つき洪水（分水嶺法）。
 * 標高の低いところから順に広げ、別の種から来た水とぶつかったところが境界になる。
 * 標高は 0〜255 なのでバケツ待ち行列で O(画素数) で解ける。
 */
function priorityFlood(elev, mask, seedLabel, W, H) {
  const N = W * H;
  const label = Int32Array.from(seedLabel);
  const bp = Array.from({ length: 256 }, () => []);
  const bl = Array.from({ length: 256 }, () => []);
  const pushNb = (p, lab, lvl) => {
    const x = p % W;
    for (let d = 0; d < 4; d++) {
      const q = d === 0 ? p - 1 : d === 1 ? p + 1 : d === 2 ? p - W : p + W;
      if (q < 0 || q >= N) continue;
      if (d === 0 && x === 0) continue;
      if (d === 1 && x === W - 1) continue;
      if (mask[q] !== 1 || label[q] !== 0) continue;
      const e = elev[q] < lvl ? lvl : elev[q];
      bp[e].push(q); bl[e].push(lab);
    }
  };
  for (let p = 0; p < N; p++) if (label[p] > 0) pushNb(p, label[p], 0);
  for (let lvl = 0; lvl < 256; lvl++) {
    const qs = bp[lvl];
    const ls = bl[lvl];
    for (let i = 0; i < qs.length; i++) {
      const p = qs[i];
      if (label[p] !== 0) continue;
      label[p] = ls[i];
      pushNb(p, ls[i], lvl);
    }
    bp[lvl] = null; bl[lvl] = null;
  }
  return label;
}

/**
 * 切り出した2次元領域から、その歯の局所座標での輪郭 r(θ) を作る。
 *
 * 局所座標は buildCrown と同じ約束: +x が遠心、+z が頬側。
 *
 * @param {Int32Array} pixels 領域の画素添字
 * @param {object} frame {cx, cy, tx, ty, nx, ny} 画素座標での歯の局所軸
 * @returns {{r:Float32Array, mdMm:number, blMm:number}|null}
 */
function regionOutline(pixels, W, frame, pxPerMm) {
  const { cx, cy, tx, ty, nx, ny } = frame;
  const rMax = new Float32Array(OUTLINE_SEG);
  let mdMin = Infinity, mdMax = -Infinity, blMin = Infinity, blMax = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const dx = (p % W) - cx;
    const dy = ((p / W) | 0) - cy;
    const md = (dx * tx + dy * ty) / pxPerMm;
    const bl = (dx * nx + dy * ny) / pxPerMm;
    if (md < mdMin) mdMin = md;
    if (md > mdMax) mdMax = md;
    if (bl < blMin) blMin = bl;
    if (bl > blMax) blMax = bl;
    const r = Math.hypot(md, bl);
    let th = Math.atan2(bl, md);
    if (th < 0) th += Math.PI * 2;
    const k = Math.min(OUTLINE_SEG - 1, Math.floor((th / (Math.PI * 2)) * OUTLINE_SEG));
    if (r > rMax[k]) rMax[k] = r;
  }
  // 空いた方向を埋める（領域が細いと拾えない角度が出る）
  let filled = 0;
  for (let k = 0; k < OUTLINE_SEG; k++) if (rMax[k] > 0) filled++;
  if (filled < OUTLINE_SEG * 0.6) return null;
  for (let k = 0; k < OUTLINE_SEG; k++) {
    if (rMax[k] > 0) continue;
    let a = k, b = k;
    for (let d = 1; d <= OUTLINE_SEG; d++) {
      a = (k - d + OUTLINE_SEG) % OUTLINE_SEG;
      if (rMax[a] > 0) break;
    }
    for (let d = 1; d <= OUTLINE_SEG; d++) {
      b = (k + d) % OUTLINE_SEG;
      if (rMax[b] > 0) break;
    }
    rMax[k] = (rMax[a] + rMax[b]) / 2;
  }
  // 周方向にならす（画素の階段を落とす）。分割数に応じて回数を決める。
  let cur = rMax;
  for (let pass = 0; pass < Math.round(OUTLINE_SEG / 16); pass++) {
    const sm = new Float32Array(OUTLINE_SEG);
    for (let k = 0; k < OUTLINE_SEG; k++) {
      const a = cur[(k - 1 + OUTLINE_SEG) % OUTLINE_SEG];
      const b = cur[k];
      const c = cur[(k + 1) % OUTLINE_SEG];
      sm[k] = (a + 2 * b + c) / 4;
    }
    cur = sm;
  }
  const ranked = Float64Array.from(cur).sort();
  const mn = ranked[Math.floor(ranked.length * 0.05)];
  const mx = ranked[Math.floor(ranked.length * 0.95)];
  if (!(mn > 0.4) || mx / mn > 3.2) return null;
  return { r: cur, mdMm: mdMax - mdMin, blMm: blMax - blMin };
}

/**
 * 検出結果から歯ごとの計測値を取り出す。
 * @param {object} detection detectArch の戻り値（境界を手動修正した後でもよい）
 * @param {ImageData} imageData
 * @param {number} pxPerMm
 * @returns {Array} teeth [{ side, pos, sCenterPx, mdPx, blPx, rotationDeg, color, cx, cy }]
 */
export function measureTeeth(detection, imageData, pxPerMm) {
  const { unrolled, mask } = detection;
  const { width: W, data } = imageData;
  const teeth = [];

  // 歯ごとの2次元領域を先に切り出しておく（分水嶺法）。
  // 輪郭・重心・幅径はこの領域から取る。
  const regions = segmentToothRegions(detection, imageData);

  for (const side of ['R', 'L']) {
    const dir = side === 'L' ? 1 : -1;
    const { bounds, positions } = detection.sides[side];
    for (let i = 0; i < positions.length; i++) {
      const s0 = bounds[i] * dir;
      const s1 = bounds[i + 1] * dir;
      const sc = (s0 + s1) / 2;
      const seg = unrolled.samples.filter((sm) =>
        (sm.s - s0) * (sm.s - s1) <= 0);
      if (seg.length === 0) continue;

      const center = sampleAt(unrolled.samples, sc);
      // 頬舌径は歯冠のもっとも太い断面で決まる。隣接面付近では歯列帯が
      // 細くなるため、平均ではなく上位 15% 点（ほぼ最大幅）を採る。
      const widths = seg.map((sm) => sm.width).sort((a, b) => a - b);
      const blPx = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.85))];

      // 平均色（帯の中央 60% のうち、実際に歯の色をしている画素だけ）
      // マスクはクロージングで隣接面の影や歯肉際をわずかに含むため、
      // そのまま平均すると歯冠が赤褐色に転ぶ。
      const cand = [];
      for (const sm of seg) {
        const a = sm.rIn + sm.width * 0.2;
        const b = sm.rOut - sm.width * 0.2;
        for (let r = a; r <= b; r += 1.5) {
          const px = Math.round(sm.px + (sm.dx * (r - sm.r)));
          const py = Math.round(sm.py + (sm.dy * (r - sm.r)));
          if (px < 0 || py < 0 || px >= imageData.width || py >= imageData.height) continue;
          if (mask[py * imageData.width + px] !== 1) continue;
          const idx = (py * W + px) * 4;
          const cr = data[idx], cg = data[idx + 1], cb = data[idx + 2];
          if (!isToothColor(cr, cg, cb)) continue;
          cand.push({ r: cr, g: cg, b: cb, l: luma(cr, cg, cb) });
        }
      }
      // 影（暗部）と反射（白飛び）を外し、中間の明るさの画素で平均する
      let color = { r: 225, g: 220, b: 210 };
      if (cand.length >= 8) {
        cand.sort((a, b) => a.l - b.l);
        const lo = Math.floor(cand.length * 0.35);
        const hi = Math.max(lo + 1, Math.floor(cand.length * 0.90));
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = lo; i < hi; i++) { sumR += cand[i].r; sumG += cand[i].g; sumB += cand[i].b; }
        const k = hi - lo;
        color = { r: sumR / k, g: sumG / k, b: sumB / k };
      } else if (cand.length) {
        color = { r: cand[0].r, g: cand[0].g, b: cand[0].b };
      }

      // 捻転角: 歯の近遠心にわたる「基準弓からの頬舌的ずれ」の傾き。
      // 捻転した歯は近心側と遠心側で頬舌的位置が食い違うため、
      // その勾配から回転量を推定できる（歯の輪郭が写真から直接は分離
      // できないため、歯列帯の形の変化として捉える）。
      // --- その歯そのものの咬合面輪郭 -------------------------------
      // 歯種ごとの標準形ではなく、写真に写っているこの歯の外形を使う。
      // 帯の内外の縁（rIn / rOut）が、咬合面から見たその歯の輪郭そのもの。
      // --- この歯の2次元領域から、輪郭・重心・幅径を取る ------------
      //
      // 歯列帯を弧長で切った薄切りではなく、写真から直接切り出した
      // その歯の footprint を使う。近心面・遠心面が「切った位置」ではなく
      // 実際の隣接面になり、隣の歯と重ならなくなる。
      const region = regions.get(`${side}${i}`);
      // 局所軸（画素座標）: +x 遠心 / +z 頬側。
      // 頬側は帯の法線 (dx, dy)、遠心は弧長 s が増える向き×sc の符号。
      const eps = Math.max(2, pxPerMm * 0.6);
      const sPrev = sampleAt(unrolled.samples, sc - eps);
      const sNext = sampleAt(unrolled.samples, sc + eps);
      let tx = sNext.px - sPrev.px;
      let ty = sNext.py - sPrev.py;
      const tl = Math.hypot(tx, ty) || 1;
      const dsign = sc >= 0 ? 1 : -1;
      tx = (tx / tl) * dsign;
      ty = (ty / tl) * dsign;

      let outline = null;
      let regionOk = false;
      let cxPx = center.px;
      let cyPx = center.py;
      // 歯そのものの位置（領域の重心）。歯列の再現（3D の治療前の配置）に使う。
      // 下の cx/cy は歯列弓の当てはめを安定させるために帯の中心へ寄せた値。
      let rcx = null;
      let rcy = null;
      if (region) {
        const shape = regionOutline(region.pixels, W, {
          cx: region.cx, cy: region.cy, tx, ty, nx: center.dx, ny: center.dy,
        }, pxPerMm);
        // 切り出した領域が、その歯として妥当な大きさかを確かめる。
        //
        // 種の位置（弧長方向の歯の区切り）がずれていると、分水嶺が隣の歯へ
        // 流れ込んだり、細い切れ端しか取れなかったりする。実症例では
        // 近遠心幅径が 2.2mm（細すぎ）や 11.8mm（隣まで飲み込んだ）という
        // 領域が出た。弧長で測った幅と大きく食い違う領域は使わない。
        const sliceMd = Math.abs(s1 - s0) / pxPerMm;
        const ok = shape && shape.mdMm > sliceMd * 0.62 && shape.mdMm < sliceMd * 1.55;
        if (ok) {
          regionOk = true;
          outline = shape.r;
          // 位置は帯の中心にとどめ、領域の重心へは一部だけ寄せる。
          //
          // 切り出せる領域は「咬合面として見えている部分」で、解剖学的な
          // 歯冠より一回り小さい（隣接面の接触点は影になって写らない）。
          // 重心をそのまま歯の位置にすると隣り合う歯が離れ、歯列に
          // 隙間ができて歯列弓も細くなる。転位のぶんだけを弱く反映する。
          const PULL = 0.45;
          cxPx = center.px + (region.cx - center.px) * PULL;
          cyPx = center.py + (region.cy - center.py) * PULL;
          rcx = region.cx;
          rcy = region.cy;
        }
      }

      // 咬合面の起伏（咬頭が明るく、小窩裂溝が暗く写る）もこの歯のものを使う
      const scC = sc;
      const rcC = center.r + ((cxPx - center.px) * center.dx + (cyPx - center.py) * center.dy);
      const relief = occlusalRelief(seg, scC, rcC, pxPerMm, imageData, mask, outline);

      const { mean } = fitOffsetSlope(seg, sc);
      // 捻転は、この歯の領域の主軸（画素の広がりのいちばん長い向き）から求める。
      //
      // 以前は歯列帯の中心の傾きから求めていたが、帯の中心は隣の歯や
      // 転位歯に引かれて揺れるため、実症例では 28 歯の大半が上限の ±22° に
      // 張り付き、向きも 1 歯ごとに反転していた（存在しない捻転で歯列が乱れて見えた）。
      // 領域の形がはっきり細長い歯（上顎中切歯は近遠心に、小臼歯は頬舌に長い）
      // だけで測り、形が丸い歯（犬歯・下顎切歯・大臼歯）は 0 とする。
      // 大きさの検査で退けた領域（隣を飲み込んだ・細い切れ端）は向きも測らない
      const rotationDeg = region && regionOk
        ? regionRotation(region, W, positions[i], detection.arch, tx, ty, center.dx, center.dy)
        : 0;

      teeth.push({
        side,
        pos: positions[i],
        sCenterPx: sc,
        sStartPx: s0,
        sEndPx: s1,
        mdPx: Math.abs(s1 - s0),
        blPx,
        mdMm: Math.abs(s1 - s0) / pxPerMm,
        blMm: blPx / pxPerMm,
        rotationDeg,
        offsetMm: mean / pxPerMm,
        outline,
        relief,
        color,
        cx: cxPx,
        cy: cyPx,
        rcx,
        rcy,
      });
    }
  }
  return teeth;
}

/** 咬合面輪郭の角度分割数（tooth-library.js の SEG と合わせる） */
export const OUTLINE_SEG = 48;


/**
 * 1歯の咬合面の起伏を、明るさの分布として取り出す。
 *
 * 咬合面観では咬頭のほうが明るく、小窩・裂溝は影になって暗く写る。
 * 口腔内写真のリングフラッシュはレンズとほぼ同軸なので、咬合面を
 * 真上から見たとき明るさはおおむね「面がどれだけこちらを向いているか」を
 * 表し、咬頭頂がもっとも明るく、裂溝がもっとも暗くなる。
 * この明暗を歯冠の局所座標（半径方向 u、周方向 θ）の格子で拾い、
 * その歯の中で 0〜1 に正規化して返す。1 が咬頭側、0 が裂溝側。
 *
 * 格子は RELIEF_RINGS x RELIEF_SEG（16 x 64 = 1,024 点）。大臼歯 1 本は
 * 写真上でおよそ 4,400 画素なので、その 1/4 ほどを拾うことになる。
 * 以前は 5 x 24 = 120 点しか拾っておらず、咬頭・裂溝・辺縁隆線は
 * どうやっても表せなかった。
 *
 * 明暗と深さの対応は厳密なものではないため、これは「どこに咬頭と溝があるか」
 * という配置として使い、深さの目盛りだけを歯種ごとの標準値で与える
 * （tooth-library.js の capY）。
 *
 * @returns {Float32Array|null} 長さ RELIEF_RINGS × RELIEF_SEG（外周→中心の順）
 */
function occlusalRelief(seg, sc, rc, pxPerMm, imageData, mask, outline) {
  if (!outline || seg.length < 4) return null;
  const { width: W, height: H, data } = imageData;
  // 弧長の絶対値で並べておき、二分探索で引く。
  // 格子が 1,024 点に増えたので、毎回の線形探索では重すぎる。
  const sorted = [...seg].sort((a, b) => Math.abs(a.s) - Math.abs(b.s));
  const keys = Float64Array.from(sorted, (c) => Math.abs(c.s));
  const nearest = (target) => {
    let lo = 0;
    let hi = keys.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= target) lo = mid; else hi = mid;
    }
    return Math.abs(keys[lo] - target) <= Math.abs(keys[hi] - target) ? sorted[lo] : sorted[hi];
  };
  const absSc = Math.abs(sc);

  // 輪郭は OUTLINE_SEG 個なので、起伏の角度分割 RELIEF_SEG に補間して使う
  const radiusAt = (th) => {
    const x = (th / (Math.PI * 2)) * outline.length;
    const i = Math.floor(x);
    const f = x - i;
    const a = outline[((i % outline.length) + outline.length) % outline.length];
    const b = outline[((i + 1) % outline.length + outline.length) % outline.length];
    return a * (1 - f) + b * f;
  };

  const out = new Float32Array(RELIEF_RINGS * RELIEF_SEG).fill(NaN);
  const vals = [];
  for (let ri = 0; ri < RELIEF_RINGS; ri++) {
    const u = 1 - ri / (RELIEF_RINGS - 1);      // 1=外周 … 0=中心
    for (let k = 0; k < RELIEF_SEG; k++) {
      const th = (k / RELIEF_SEG) * Math.PI * 2;
      const rr = radiusAt(th);
      const xd = rr * Math.cos(th) * u;   // 遠心方向(mm)
      const zb = rr * Math.sin(th) * u;   // 頬側方向(mm)
      const sm = nearest(absSc + xd * pxPerMm);
      const R = rc + zb * pxPerMm;
      const px = Math.round(sm.px + sm.dx * (R - sm.r));
      const py = Math.round(sm.py + sm.dy * (R - sm.r));
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      if (mask[py * W + px] !== 1) continue;
      const i = (py * W + px) * 4;
      const v = luma(data[i], data[i + 1], data[i + 2]);
      out[ri * RELIEF_SEG + k] = v;
      vals.push(v);
    }
  }
  if (vals.length < RELIEF_SEG) return null;

  // その歯の中で正規化する（写真ごと・部位ごとの明るさの違いを吸収）
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.10)];
  const hi = vals[Math.floor(vals.length * 0.90)];
  if (!(hi - lo > 4)) return null;      // 明暗の差がなければ手がかりにしない
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.isNaN(out[i]) ? 0.5 : Math.max(0, Math.min(1, (out[i] - lo) / (hi - lo)));
  }
  // 画素ごとのざらつき・唾液の反射をならす。
  // 格子を細かくしたぶん 1 点あたりのノイズが効くので、
  // 周方向は巻き込み、半径方向は端を留めて 2 回ならす。
  return smoothPolar(out, RELIEF_RINGS, RELIEF_SEG, 2);
}

/** 極座標グリッドを 3x3 でならす（周方向は巻き込み、半径方向は端を留める） */
function smoothPolar(src, rings, segs, passes) {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(cur.length);
    for (let r = 0; r < rings; r++) {
      const rm = Math.max(0, r - 1);
      const rp = Math.min(rings - 1, r + 1);
      for (let k = 0; k < segs; k++) {
        const km = (k - 1 + segs) % segs;
        const kp = (k + 1) % segs;
        next[r * segs + k] = (
          cur[rm * segs + km] + cur[rm * segs + k] + cur[rm * segs + kp]
          + cur[r * segs + km] + cur[r * segs + k] * 2 + cur[r * segs + kp]
          + cur[rp * segs + km] + cur[rp * segs + k] + cur[rp * segs + kp]
        ) / 10;
      }
    }
    cur = next;
  }
  return cur;
}

/** 弧長 s に最も近いサンプルを返す */
export function sampleAt(samples, s) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(samples[i].s - s);
    if (d < bd) { bd = d; bi = i; }
  }
  return samples[bi];
}

/**
 * 歯の範囲における「基準弓からの頬舌的ずれ」を弧長の1次式で近似し、
 * 傾き（捻転の指標）と平均（頬舌的な転位量）を返す。
 */
/**
 * 歯の領域の主軸から捻転角を求める（＋ で遠心端が頬側へ回る）。
 *
 * 画素の 2 次モーメントの固有ベクトルが主軸。近遠心軸は、近遠心に長い歯
 * （上顎中切歯）では長軸、頬舌に長い歯（小臼歯）では短軸になる。
 * 細長さ（長径／短径）が足りない歯は向きが決まらないので 0 を返す。
 * 捻転の分解能を超える小さな角度も 0 とみなす。
 */
function regionRotation(region, W, pos, arch, tx, ty, nx, ny) {
  const wide = arch === 'upper' ? (pos === 1) : false;           // 近遠心に長い
  const deep = pos === 4 || pos === 5;                            // 頬舌に長い
  if (!wide && !deep) return 0;
  let sxx = 0, syy = 0, sxy = 0;
  const px = region.pixels;
  for (let k = 0; k < px.length; k++) {
    const x = (px[k] % W) - region.cx;
    const y = ((px[k] / W) | 0) - region.cy;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  const tr = sxx + syy;
  const disc = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy);
  const l1 = (tr + disc) / 2, l2 = Math.max(1e-6, (tr - disc) / 2);
  const elong = Math.sqrt(l1 / l2);
  // 小臼歯は咬合面観で頬舌に 1.37 倍ほど長いが、領域に歯肉や影が混ざると
  // 形が崩れやすいので、中切歯よりはっきり細長いときだけ測る
  if (elong < (deep ? ROTATION_MIN_ELONGATION + 0.12 : ROTATION_MIN_ELONGATION)) return 0;
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);               // 長軸の向き
  let ax = Math.cos(th), ay = Math.sin(th);
  if (deep) { const t = ax; ax = -ay; ay = t; }                  // 近遠心軸は短軸
  if (ax * tx + ay * ty < 0) { ax = -ax; ay = -ay; }              // 遠心向きにそろえる
  const deg = Math.atan2(ax * nx + ay * ny, ax * tx + ay * ty) * 180 / Math.PI;
  // 30° を超える読みは、領域の形の崩れ（隣の歯・歯肉の混入）のことが多い。
  // 誤った大きな捻転は歯列を一目で乱すので、測れなかったものとして 0 にする
  // （本当に大きく捻転した歯は、手動の補正で直す）。
  if (Math.abs(deg) > ROTATION_MAX_TRUST_DEG) return 0;
  const mag = Math.abs(deg) - ROTATION_FLOOR_DEG;
  return mag > 0 ? Math.sign(deg) * mag : 0;
}

function fitOffsetSlope(seg, sCenter) {
  const pts = seg.filter((sm) => Number.isFinite(sm.offset));
  if (pts.length < 4) return { slope: 0, mean: 0 };
  // 隣接面では歯列帯が細くなり中心の推定が乱れるため、
  // 帯が最も太い（＝歯冠の中央付近の）サンプルに重みを置く
  const wMax = Math.max(...pts.map((sm) => sm.width)) || 1;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const sm of pts) {
    const w = Math.pow(sm.width / wMax, 6);
    const x = sm.s - sCenter;
    sw += w;
    sx += w * x;
    sy += w * sm.offset;
    sxx += w * x * x;
    sxy += w * x * sm.offset;
  }
  if (sw < 1e-9) return { slope: 0, mean: 0 };
  const denom = sw * sxx - sx * sx;
  const slope = Math.abs(denom) < 1e-9 ? 0 : (sw * sxy - sx * sy) / denom;
  return { slope, mean: sy / sw };
}

// ---------------------------------------------------------------------------
// 写真の写り具合の診断
// ---------------------------------------------------------------------------

/**
 * 取り込んだ写真が解析に耐えるかを調べ、直し方とあわせて返す。
 *
 * 自動検出が失敗したときに「検出できませんでした」とだけ出しても、
 * 撮り直しようがない。何がどう足りないのかを具体的に示すためのもの。
 *
 * @param {ImageData} imageData
 * @param {Uint8Array} [mask] buildToothMask の結果（省略時はここで作る）
 * @returns {{level: 'ok'|'warn'|'err', messages: string[], metrics: object}}
 */
export function assessPhoto(imageData, mask) {
  const { width: W, height: H, data } = imageData;
  const m = mask ?? buildToothMask(imageData).mask;
  const total = W * H;

  let n = 0;
  let edge = 0;
  let sumV = 0;
  const border = Math.max(1, Math.round(Math.min(W, H) * 0.02));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (m[p] !== 1) continue;
      n++;
      if (x < border || y < border || x >= W - border || y >= H - border) edge++;
      const i = p * 4;
      sumV += Math.max(data[i], data[i + 1], data[i + 2]);
    }
  }

  const messages = [];
  const metrics = { coverage: n / total, edgeRatio: n ? edge / n : 0, value: n ? sumV / n / 255 : 0, focus: 0 };
  if (n < total * 0.008) {
    return {
      level: 'err',
      messages: ['歯の領域がほとんど取り出せませんでした。'
        + '明るい場所で、歯列全体がはっきり写るように撮り直してください。'
        + '（暗い・ピンぼけ・歯が小さく写りすぎ、のいずれかのことが多いです）'],
      metrics,
    };
  }

  // ピントは歯の領域のラプラシアンのばらつきで見る。
  // 明るさの違いに左右されないよう、その領域の平均の明るさで正規化する。
  let lap = 0;
  let lapN = 0;
  const lum = (p) => {
    const i = p * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (m[p] !== 1) continue;
      const v = 4 * lum(p) - lum(p - 1) - lum(p + 1) - lum(p - W) - lum(p + W);
      lap += v * v;
      lapN++;
    }
  }
  const meanLum = Math.max(1, (sumV / Math.max(1, n)));
  metrics.focus = lapN ? Math.sqrt(lap / lapN) / meanLum : 0;

  if (metrics.coverage < 0.025) {
    messages.push('歯列が小さく写りすぎています。もう少し近づいて、'
      + '画面いっぱいに歯列が入るように撮ってください。');
  }
  if (metrics.edgeRatio > 0.10) {
    messages.push('歯列が画面からはみ出しています。最後方の歯まで入るように撮り直してください。');
  }
  if (metrics.value < 0.45) {
    messages.push('全体に暗めです。明るい場所で、影が入らないように撮ってください。');
  }
  if (metrics.focus < 0.025) {
    messages.push('ピントが甘いようです（手ブレの可能性）。'
      + '端末を固定し、歯にピントを合わせてから撮ってください。');
  }
  return { level: messages.length ? 'warn' : 'ok', messages, metrics };
}
