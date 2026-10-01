/**
 * tooth-library.js
 * 歯種ごとの標準寸法（近遠心幅径・頬舌径・歯冠長）と、
 * パラメトリックな歯冠サーフェスの生成。
 *
 * 歯冠の形は歯種ごとの標準形（解剖学的なテンプレート）で作り、写真からは
 * 大きさ（近遠心幅径・頬舌径・歯冠長）だけを取る。写真の検出のわずかな誤りを
 * 形へ写すと「ありえない形の歯」になるため、形そのものは写真に頼らない。
 * 生成される歯冠は口腔内スキャナの STL と同様、歯根を持たないサーフェスである。
 *
 * 歯の局所座標系（mm）:
 *   +x : 遠心（distal）方向
 *   +z : 頬側・唇側（buccal / labial）方向
 *   +y : 歯頸部（cervical）方向  … y=0 が咬合面・切縁の最突出面
 *   角度 θ は +x（遠心）から +z（頬側）へ向かって測る
 *     θ=0°   遠心
 *     θ=90°  頬側
 *     θ=180° 近心
 *     θ=270° 舌側・口蓋側
 */

/** FDI 歯式番号を作る（arch: 'upper'|'lower', side: 'R'|'L', pos: 1-8） */
export function fdi(arch, side, pos) {
  const q = arch === 'upper' ? (side === 'R' ? 1 : 2) : (side === 'L' ? 3 : 4);
  return q * 10 + pos;
}

/** FDI 番号を { arch, side, pos } に分解する */
export function parseFdi(num) {
  const q = Math.floor(num / 10);
  const pos = num % 10;
  return {
    arch: q === 1 || q === 2 ? 'upper' : 'lower',
    side: q === 1 || q === 4 ? 'R' : 'L',
    pos,
  };
}

/** 表示用の歯式ラベル（例: 上顎右側第一小臼歯 → 「右上4」） */
export function toothLabel(num) {
  const { arch, side, pos } = parseFdi(num);
  const v = side === 'R' ? '右' : '左';
  const h = arch === 'upper' ? '上' : '下';
  return `${v}${h}${pos}`;
}

export const TOOTH_NAMES = {
  1: '中切歯', 2: '側切歯', 3: '犬歯', 4: '第一小臼歯',
  5: '第二小臼歯', 6: '第一大臼歯', 7: '第二大臼歯', 8: '第三大臼歯',
};

/** 歯種クラス（歯冠形態の生成に使う） */
export const CLASS = {
  CENTRAL: 'central',
  LATERAL: 'lateral',
  CANINE: 'canine',
  PREMOLAR1: 'premolar1',
  PREMOLAR2: 'premolar2',
  MOLAR1: 'molar1',
  MOLAR2: 'molar2',
};

/**
 * 標準歯冠寸法（永久歯・日本人平均に近い代表値, mm）
 *   md     近遠心幅径
 *   bl     頬舌径
 *   height 歯冠長（歯頸線〜咬合面／切縁）
 *   torque 唇舌的歯軸傾斜（度, MBT系の代表値。+が唇側/頬側傾斜）
 *   tip    近遠心的歯軸傾斜（度, +が歯冠近心傾斜。MBT と同じ）
 *   cuspOffset 咬合平面からの咬頭頂の相対高さ（+で低位。スピー彎曲の基準に加算）
 */
export const STANDARD_TEETH = {
  upper: {
    1: { md: 8.5, bl: 7.1, height: 10.5, torque: 12, tip: 4, cls: CLASS.CENTRAL },
    2: { md: 6.8, bl: 6.3, height: 9.2, torque: 8, tip: 8, cls: CLASS.LATERAL },
    3: { md: 7.8, bl: 8.1, height: 10.3, torque: 0, tip: 8, cls: CLASS.CANINE },
    4: { md: 7.1, bl: 9.3, height: 8.5, torque: -7, tip: 0, cls: CLASS.PREMOLAR1 },
    5: { md: 6.7, bl: 9.2, height: 7.6, torque: -7, tip: 0, cls: CLASS.PREMOLAR2 },
    6: { md: 10.4, bl: 11.1, height: 7.2, torque: -14, tip: 0, cls: CLASS.MOLAR1 },
    7: { md: 9.8, bl: 10.9, height: 7.0, torque: -14, tip: 0, cls: CLASS.MOLAR2 },
    8: { md: 8.8, bl: 10.2, height: 6.6, torque: -14, tip: 0, cls: CLASS.MOLAR2 },
  },
  lower: {
    1: { md: 5.4, bl: 6.0, height: 9.0, torque: -6, tip: 0, cls: CLASS.CENTRAL },
    2: { md: 6.0, bl: 6.3, height: 9.5, torque: -6, tip: 0, cls: CLASS.LATERAL },
    3: { md: 6.9, bl: 7.6, height: 11.0, torque: -6, tip: 3, cls: CLASS.CANINE },
    4: { md: 7.2, bl: 7.9, height: 8.6, torque: -12, tip: 2, cls: CLASS.PREMOLAR1 },
    5: { md: 7.3, bl: 8.5, height: 8.0, torque: -17, tip: 2, cls: CLASS.PREMOLAR2 },
    6: { md: 11.2, bl: 10.5, height: 7.5, torque: -22, tip: 2, cls: CLASS.MOLAR1 },
    7: { md: 10.6, bl: 10.2, height: 7.2, torque: -30, tip: 2, cls: CLASS.MOLAR2 },
    8: { md: 10.0, bl: 9.8, height: 6.8, torque: -30, tip: 2, cls: CLASS.MOLAR2 },
  },
};

// ---------------------------------------------------------------------------
// 歯冠形態テンプレート
// ---------------------------------------------------------------------------
//
// 歯冠は次の 3 つの面をつないだ閉じたメッシュとして作る。
//   側面           歯頸線（t=1）から咬合縁・切縁（t=0）まで積み重ねた断面リング
//   咬合面キャップ 咬合縁（t=0 のリング）の内側の起伏（咬頭・隆線・裂溝・窩）
//   歯頸部キャップ 歯頸線の内側を塞ぐ面（STL を閉じた立体にするため）
//
// 断面は近心・遠心・頬側・舌側の 4 方向の張り出しを別々に持つスーパー楕円で、
// 高さ t ごとの張り出しを制御点 [t, 値] でなめらかにつなぐ。
// 4 方向を分けるのは、歯種の特徴の多くが「どの面の、どの高さが最も張り出すか」
// だからである（例: 臼歯の最大豊隆は頬側では歯頸側 1/3、舌側では中央 1/3。
// 近心の接触点は遠心より咬合面寄り。切歯は唇側がふくらみ舌側がくぼむ）。
//
// 以前は 4 方向とも同じ比率の断面を上下に縮めていたため、切歯の切縁が
// 3mm 幅の台地になり、臼歯は咬頭が外周に乗った饅頭形で、どの角度から見ても
// 歯には見えなかった。
//
// 形は各歯種の標準の大きさ（STANDARD_TEETH）で作り、最後に要求された
// 近遠心径・頬舌径・歯冠長へ伸縮する。溝の幅や咬頭の高さを mm で書けるうえ、
// 患者の歯の大きさが違っても歯種ごとの比率（切歯は薄く、臼歯は四角い）が崩れない。
//
// 断面の張り出しの値は「最大豊隆を 1」とする比率。制御点の t は 0 = 咬合縁・切縁、
// 1 = 歯頸線。値どうしの比だけが意味を持つ（最後に外形を md・bl に合わせるため）。
// スーパー楕円の指数 n は 2 以上にする。2 未満にすると断面の端（隣接面の中央や
// 基底結節）の曲率が無限大になり、歯冠に刃物のような稜線が立つ。
// 舌側へ三角形にすぼまる形は、指数ではなく lingualTaper で作る。
//
// 前歯（type: 'incisor' / 'canine'）
//   t=0 の断面は厚さ 1mm 前後の細長い帯（切縁・尖頭の稜線）で、その上の
//   咬合面キャップは切縁の丸みだけを持つ。舌側面窩・辺縁隆線・基底結節は
//   側面の舌側の起伏（relief）とプロファイルで作る。
//   edge.mesial / edge.distal … 切縁隅角の丸み（start から先で lift mm だけ歯頸側へ回り込む）
//   cusp … 犬歯の尖頭（tip: 近遠心位置の比率, 負が近心。slope: 尖頭隆線の傾き）
// 臼歯（type: 'posterior'）
//   咬合面の起伏を「咬頭（先の丸い円錐）・隆線・溝・小窩」の組み合わせで作る。
//   円錐どうしが出会う谷がそのまま溝になるので、溝の位置が咬頭の配置と食い違わない。
//   座標は咬合縁（t=0 の断面）に対する比率 [x, z]（+x 遠心・+z 頬側, ±1 が咬合縁）。
//   cusps  … { at, h: 窩底からの高さ(mm), slope: [咬合縁に沿う傾き, 中心へ向かう傾き,
//              外側への傾き], round: 先端の丸み(mm) }
//   ridges … 辺縁隆線・斜走隆線 { from, to, h, h1?(to 側の高さ), dip?(中央のくぼみ), slope, round }
//   grooves… 中心溝・頬側溝など（谷をさらに細く刻む）{ path, depth, w }
//   pits   … 小窩 { at, depth, w }
// 共通
//   relief … 側面の起伏 { side: 'b'|'l', kind: 'ridge'|'groove'|'fossa', at, width, depth(mm),
//             t0, t1, fade? }（fade: t0→t1 で消える。無指定なら t0〜t1 の山形）
//   scallop… 歯頸線の隣接面での立ち上がり（mm）。唇頬側・舌側の中央は y = 歯冠長のまま。
//            解剖学的には切歯 2.5〜3mm・犬歯 2mm・小臼歯 1.5mm・大臼歯 1mm ほどあるが、
//            歯肉（reconstruct3d.buildGingiva）は歯頸線の波形をたどらず歯間乳頭も
//            1〜2mm しか盛り上がらないので、解剖どおりにすると正面観で歯間に隙間が開き、
//            下顎前歯が牙のように尖って見えた。そのため半分ほどに抑えてある
//   shear  … 咬合面観の菱形（上顎大臼歯: 舌側半分が遠心へずれる）
//   lingualTaper / distalTaper … 舌側・遠心へ向かって幅が狭まる割合（数値か [t, 値] の制御点）
//   proximalShift … 前歯の近遠心の最大豊隆（接触点）を唇側へずらす量（頬舌径の半分に対する比率）

// 臼歯の咬頭の傾きの既定値 [咬合縁に沿う, 中心へ, 外側へ]（高さ / 水平距離）
const SHARP = [0.55, 0.9, 1.3];   // 尖った咬頭（上顎大臼歯の頬側咬頭・下顎の舌側咬頭など）
const BLUNT = [0.5, 0.72, 1.1];   // 丸い咬頭（下顎大臼歯の頬側咬頭。咬耗しやすく低い）

// 臼歯の頬側面・舌側面の張り出し（t: 0 = 咬合縁 … 1 = 歯頸線）。
// 頬側の最大豊隆は歯頸側 1/3、舌側は中央 1/3。咬合縁から最大豊隆までは
// ほぼまっすぐに広がる（途中で急に張り出すと、近心から見て箱形になる）。
// 下顎の頬側は歯冠が舌側へ傾くぶん咬合面寄りが細く、舌側はまっすぐに近い。
const UPPER_BUCCAL = [[0, 0.68], [0.1, 0.76], [0.2, 0.83], [0.35, 0.9], [0.5, 0.95], [0.65, 0.99], [0.75, 1.0], [0.88, 0.98], [1, 0.9]];
const UPPER_LINGUAL = [[0, 0.68], [0.1, 0.77], [0.2, 0.85], [0.3, 0.91], [0.4, 0.96], [0.5, 0.99], [0.6, 1.0], [0.75, 0.98], [0.9, 0.93], [1, 0.87]];
const LOWER_BUCCAL = [[0, 0.64], [0.1, 0.74], [0.22, 0.83], [0.36, 0.9], [0.5, 0.95], [0.62, 0.98], [0.74, 1.0], [0.88, 0.99], [1, 0.91]];
const LOWER_LINGUAL = [[0, 0.76], [0.12, 0.84], [0.25, 0.91], [0.38, 0.96], [0.5, 0.99], [0.6, 1.0], [0.75, 0.99], [0.9, 0.95], [1, 0.9]];

const PROFILES = {
  upper: {
    // 上顎中切歯: 近心切縁隅角はほぼ直角、遠心切縁隅角は丸い。舌側面窩と基底結節が明瞭
    1: {
      type: 'incisor',
      mesial: [[0, 0.95], [0.08, 0.99], [0.18, 1.0], [0.45, 0.96], [0.75, 0.87], [1, 0.8]],
      distal: [[0, 0.8], [0.1, 0.92], [0.22, 0.98], [0.34, 1.0], [0.6, 0.93], [1, 0.79]],
      buccal: [[0, 0.14], [0.04, 0.25], [0.12, 0.41], [0.25, 0.6], [0.42, 0.8], [0.58, 0.93], [0.7, 1.0], [0.85, 0.98], [1, 0.9]],
      lingual: [[0, 0.14], [0.06, 0.24], [0.2, 0.4], [0.4, 0.57], [0.6, 0.76], [0.75, 0.92], [0.86, 1.0], [1, 0.9]],
      nBuccal: [[0, 2.0], [0.25, 2.5], [1, 2.3]],
      nLingual: [[0, 2.0], [0.25, 2.3], [1, 2.2]],
      lingualTaper: [[0, 0], [0.3, 0.3], [0.8, 0.36], [1, 0.3]],
      proximalShift: [[0, 0], [0.25, 0.14], [0.6, 0.18], [1, 0.12]],
      edge: { round: 0.25, mesial: { start: 0.78, lift: 0.2 }, distal: { start: 0.45, lift: 0.95 } },
      relief: [
        { side: 'l', kind: 'fossa', at: 0, width: 0.72, depth: 0.75, t0: 0.08, t1: 0.8 },
        // 唇側面の 3 つの発育葉の境（ごく浅い縦のくぼみ）
        { side: 'b', kind: 'groove', at: -0.34, width: 0.14, depth: 0.08, t0: 0, t1: 0.55, fade: true },
        { side: 'b', kind: 'groove', at: 0.34, width: 0.14, depth: 0.08, t0: 0, t1: 0.55, fade: true },
      ],
      scallop: 1.4,
    },
    // 上顎側切歯: 中切歯より小さく丸い。遠心切縁隅角はさらに丸く、舌側面窩が深い
    2: {
      type: 'incisor',
      mesial: [[0, 0.9], [0.1, 0.98], [0.22, 1.0], [0.5, 0.94], [0.8, 0.83], [1, 0.76]],
      distal: [[0, 0.72], [0.12, 0.88], [0.26, 0.97], [0.38, 1.0], [0.62, 0.92], [1, 0.75]],
      buccal: [[0, 0.15], [0.04, 0.26], [0.12, 0.42], [0.25, 0.61], [0.42, 0.81], [0.58, 0.94], [0.7, 1.0], [0.85, 0.98], [1, 0.9]],
      lingual: [[0, 0.15], [0.06, 0.25], [0.2, 0.41], [0.4, 0.58], [0.6, 0.77], [0.75, 0.93], [0.86, 1.0], [1, 0.9]],
      nBuccal: [[0, 2.0], [0.25, 2.6], [1, 2.4]],
      nLingual: [[0, 2.0], [0.25, 2.2], [1, 2.1]],
      lingualTaper: [[0, 0], [0.3, 0.3], [0.8, 0.38], [1, 0.3]],
      proximalShift: [[0, 0], [0.25, 0.14], [0.6, 0.18], [1, 0.12]],
      edge: { round: 0.25, mesial: { start: 0.62, lift: 0.4 }, distal: { start: 0.3, lift: 1.35 } },
      relief: [
        { side: 'l', kind: 'fossa', at: 0, width: 0.7, depth: 0.85, t0: 0.08, t1: 0.8 },
      ],
      scallop: 1.3,
    },
    // 上顎犬歯: 尖頭は中央よりやや近心。近心尖頭隆線は短く、遠心は長い。
    // 唇側面の中央に唇側隆線、舌側に舌側隆線と近遠心の舌側窩
    3: {
      type: 'canine',
      mesial: [[0, 0.88], [0.12, 0.98], [0.2, 1.0], [0.5, 0.93], [0.8, 0.8], [1, 0.74]],
      distal: [[0, 0.84], [0.15, 0.95], [0.3, 1.0], [0.55, 0.93], [0.82, 0.8], [1, 0.72]],
      buccal: [[0, 0.19], [0.05, 0.3], [0.15, 0.46], [0.3, 0.63], [0.5, 0.81], [0.7, 0.95], [0.8, 1.0], [0.92, 0.98], [1, 0.9]],
      lingual: [[0, 0.19], [0.06, 0.3], [0.2, 0.47], [0.4, 0.65], [0.6, 0.84], [0.78, 0.98], [0.86, 1.0], [1, 0.88]],
      nBuccal: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      nLingual: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      lingualTaper: [[0, 0], [0.3, 0.28], [0.8, 0.34], [1, 0.28]],
      proximalShift: [[0, 0], [0.25, 0.1], [0.6, 0.14], [1, 0.1]],
      cusp: { tip: -0.08, mesialSlope: 0.58, distalSlope: 0.66, round: 0.55 },
      edge: { round: 0.2 },
      relief: [
        { side: 'b', kind: 'ridge', at: -0.08, width: 0.28, depth: 0.3, t0: 0, t1: 0.75, fade: true },
        { side: 'l', kind: 'ridge', at: -0.08, width: 0.22, depth: 0.3, t0: 0, t1: 0.8, fade: true },
        { side: 'l', kind: 'fossa', at: -0.5, width: 0.28, depth: 0.35, t0: 0.08, t1: 0.75 },
        { side: 'l', kind: 'fossa', at: 0.38, width: 0.3, depth: 0.35, t0: 0.08, t1: 0.75 },
      ],
      scallop: 1.2,
    },
    // 上顎第一小臼歯: 頬側咬頭が舌側咬頭より約 1mm 高い。頬側咬頭頂はわずかに遠心寄り。
    // 咬合面観は頬側が広く舌側へ狭まる六角形。中心溝が長く、近心辺縁隆線を溝が横切る
    4: {
      type: 'posterior',
      mesial: [[0, 0.86], [0.1, 0.95], [0.22, 1.0], [0.5, 0.93], [0.8, 0.79], [1, 0.72]],
      distal: [[0, 0.84], [0.12, 0.94], [0.3, 1.0], [0.55, 0.93], [0.82, 0.8], [1, 0.72]],
      buccal: UPPER_BUCCAL,
      lingual: UPPER_LINGUAL,
      nBuccal: [[0, 2.4], [1, 2.3]],
      nLingual: [[0, 2.2], [1, 2.2]],
      lingualTaper: 0.16,
      cusps: [
        { at: [0.1, 0.84], h: 2.6, slope: [0.62, 0.9, 1.3], round: 0.35 },
        { at: [-0.1, -0.82], h: 1.7, slope: [0.55, 0.72, 1.2], round: 0.4 },
      ],
      ridges: [
        { from: [-0.84, 0.8], to: [-0.84, -0.75], h: 1.5, slope: 1.0, round: 0.35 },
        { from: [0.84, 0.8], to: [0.84, -0.75], h: 1.4, slope: 1.0, round: 0.35 },
      ],
      grooves: [
        { path: [[-0.6, -0.1], [0.58, -0.1]], depth: 0.3, w: 0.34 },
        { path: [[-0.6, -0.1], [-0.98, 0.08]], depth: 0.22, w: 0.3 },   // 近心辺縁溝
      ],
      pits: [{ at: [-0.6, -0.1], depth: 0.35, w: 0.45 }, { at: [0.58, -0.1], depth: 0.35, w: 0.45 }],
      relief: [
        { side: 'b', kind: 'ridge', at: 0.1, width: 0.3, depth: 0.22, t0: 0, t1: 0.7, fade: true },
      ],
      scallop: 0.8,
    },
    // 上顎第二小臼歯: 頬舌の咬頭がほぼ同じ高さ。中心溝が短く、咬合面観は丸みのある楕円
    5: {
      type: 'posterior',
      mesial: [[0, 0.87], [0.1, 0.96], [0.22, 1.0], [0.5, 0.94], [0.8, 0.8], [1, 0.73]],
      distal: [[0, 0.86], [0.12, 0.95], [0.3, 1.0], [0.55, 0.94], [0.82, 0.81], [1, 0.73]],
      buccal: UPPER_BUCCAL,
      lingual: UPPER_LINGUAL,
      nBuccal: [[0, 2.2], [1, 2.2]],
      nLingual: [[0, 2.1], [1, 2.1]],
      lingualTaper: 0.05,
      cusps: [
        { at: [0.0, 0.84], h: 2.3, slope: [0.58, 0.85, 1.3], round: 0.4 },
        { at: [0.0, -0.82], h: 2.1, slope: [0.55, 0.8, 1.2], round: 0.4 },
      ],
      ridges: [
        { from: [-0.84, 0.78], to: [-0.84, -0.75], h: 1.45, slope: 1.0, round: 0.35 },
        { from: [0.84, 0.78], to: [0.84, -0.75], h: 1.4, slope: 1.0, round: 0.35 },
      ],
      grooves: [{ path: [[-0.44, 0.0], [0.44, 0.0]], depth: 0.28, w: 0.34 }],
      pits: [{ at: [-0.48, 0.0], depth: 0.3, w: 0.42 }, { at: [0.48, 0.0], depth: 0.3, w: 0.42 }],
      relief: [
        { side: 'b', kind: 'ridge', at: 0, width: 0.3, depth: 0.15, t0: 0, t1: 0.6, fade: true },
      ],
      scallop: 0.8,
    },
    // 上顎第一大臼歯: 近心頬側・遠心頬側・近心舌側（最大）・遠心舌側（最小）の 4 咬頭。
    // 近心舌側咬頭と遠心頬側咬頭を斜走隆線が結ぶ。咬合面観は菱形（近心頬側と
    // 遠心舌側の隅角が鋭角）で、頬側溝が頬側面へ、遠心舌側溝が舌側面へ続く
    6: {
      type: 'posterior',
      mesial: [[0, 0.88], [0.1, 0.96], [0.22, 1.0], [0.5, 0.96], [0.8, 0.86], [1, 0.8]],
      distal: [[0, 0.86], [0.12, 0.95], [0.3, 1.0], [0.55, 0.95], [0.82, 0.86], [1, 0.8]],
      buccal: UPPER_BUCCAL,
      lingual: UPPER_LINGUAL,
      nBuccal: [[0, 2.8], [0.5, 2.7], [1, 2.3]],
      nLingual: [[0, 2.5], [0.5, 2.4], [1, 2.2]],
      shear: -0.12,
      distalTaper: 0.08,
      cusps: [
        { at: [-0.5, 0.84], h: 2.4, slope: SHARP, round: 0.45 },   // 近心頬側
        { at: [0.45, 0.84], h: 2.2, slope: SHARP, round: 0.45 },   // 遠心頬側
        { at: [-0.3, -0.82], h: 2.6, slope: [0.5, 0.8, 1.2], round: 0.6 }, // 近心舌側（最大）
        { at: [0.62, -0.72], h: 1.8, slope: SHARP, round: 0.4 },   // 遠心舌側（最小）
      ],
      ridges: [
        // 斜走隆線（近心舌側咬頭 → 遠心頬側咬頭）
        { from: [-0.3, -0.7], to: [0.45, 0.7], h: 1.95, h1: 1.75, dip: 0.45, slope: 0.6, round: 0.9 },
        { from: [-0.9, 0.78], to: [-0.9, -0.76], h: 1.6, slope: 1.0, round: 0.35 },
        { from: [0.9, 0.74], to: [0.9, -0.62], h: 1.4, slope: 1.0, round: 0.35 },
      ],
      grooves: [
        { path: [[-0.72, 0.05], [-0.18, 0.1]], depth: 0.3, w: 0.34 },               // 中心溝
        { path: [[-0.18, 0.1], [-0.04, 1.1]], depth: 0.3, w: 0.34 },                // 頬側溝
        { path: [[0.56, -0.12], [0.26, -0.5], [0.2, -1.1]], depth: 0.3, w: 0.34 },  // 遠心舌側溝
      ],
      pits: [
        { at: [-0.18, 0.1], depth: 0.4, w: 0.5 },
        { at: [-0.72, 0.05], depth: 0.3, w: 0.42 },
        { at: [0.56, -0.12], depth: 0.35, w: 0.45 },
      ],
      relief: [
        { side: 'b', kind: 'groove', at: -0.04, width: 0.12, depth: 0.25, t0: 0, t1: 0.5, fade: true },
        { side: 'l', kind: 'groove', at: 0.2, width: 0.12, depth: 0.2, t0: 0, t1: 0.45, fade: true },
      ],
      scallop: 0.6,
    },
    // 上顎第二大臼歯: 第一大臼歯に似るが遠心舌側咬頭が小さく、菱形と遠心の狭まりが強い
    7: {
      type: 'posterior',
      mesial: [[0, 0.88], [0.1, 0.96], [0.22, 1.0], [0.5, 0.96], [0.8, 0.86], [1, 0.8]],
      distal: [[0, 0.84], [0.12, 0.94], [0.3, 1.0], [0.55, 0.95], [0.82, 0.85], [1, 0.79]],
      buccal: UPPER_BUCCAL,
      lingual: UPPER_LINGUAL,
      nBuccal: [[0, 2.7], [0.5, 2.6], [1, 2.3]],
      nLingual: [[0, 2.4], [0.5, 2.3], [1, 2.1]],
      shear: -0.15,
      distalTaper: 0.14,
      cusps: [
        { at: [-0.45, 0.84], h: 2.4, slope: SHARP, round: 0.45 },
        { at: [0.5, 0.82], h: 2.1, slope: SHARP, round: 0.45 },
        { at: [-0.2, -0.82], h: 2.5, slope: [0.5, 0.8, 1.2], round: 0.6 },
        { at: [0.66, -0.66], h: 1.4, slope: SHARP, round: 0.4 },
      ],
      ridges: [
        { from: [-0.2, -0.68], to: [0.5, 0.68], h: 1.8, h1: 1.6, dip: 0.45, slope: 0.6, round: 0.9 },
        { from: [-0.9, 0.78], to: [-0.9, -0.76], h: 1.55, slope: 1.0, round: 0.35 },
        { from: [0.88, 0.72], to: [0.88, -0.55], h: 1.3, slope: 1.0, round: 0.35 },
      ],
      grooves: [
        { path: [[-0.72, 0.05], [-0.06, 0.1]], depth: 0.3, w: 0.34 },
        { path: [[-0.06, 0.1], [0.04, 1.1]], depth: 0.3, w: 0.34 },
        { path: [[0.56, -0.1], [0.36, -0.46], [0.3, -1.1]], depth: 0.28, w: 0.34 },
      ],
      pits: [
        { at: [-0.06, 0.1], depth: 0.4, w: 0.5 },
        { at: [-0.72, 0.05], depth: 0.3, w: 0.42 },
        { at: [0.56, -0.1], depth: 0.3, w: 0.42 },
      ],
      relief: [
        { side: 'b', kind: 'groove', at: 0.04, width: 0.12, depth: 0.22, t0: 0, t1: 0.45, fade: true },
      ],
      scallop: 0.6,
    },
  },
  lower: {
    // 下顎中切歯: 小さく左右対称。切縁は薄く、近遠心の隅角はほぼ直角。舌側はなめらかで浅い。
    // 切縁は歯根の軸よりわずかに舌側にある（唇側の張り出しを舌側より大きくして表す）
    1: {
      type: 'incisor',
      mesial: [[0, 0.97], [0.12, 1.0], [0.3, 0.98], [0.6, 0.89], [1, 0.74]],
      distal: [[0, 0.96], [0.15, 0.995], [0.3, 1.0], [0.6, 0.9], [1, 0.74]],
      buccal: [[0, 0.14], [0.04, 0.22], [0.15, 0.37], [0.35, 0.58], [0.6, 0.83], [0.8, 0.97], [0.88, 1.0], [1, 0.95]],
      lingual: [[0, 0.14], [0.06, 0.21], [0.25, 0.38], [0.5, 0.6], [0.75, 0.82], [0.88, 0.87], [1, 0.82]],
      nBuccal: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      nLingual: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      lingualTaper: [[0, 0], [0.4, 0.2], [1, 0.22]],
      edge: { round: 0.2, mesial: { start: 0.85, lift: 0.12 }, distal: { start: 0.82, lift: 0.18 } },
      relief: [{ side: 'l', kind: 'fossa', at: 0, width: 0.7, depth: 0.3, t0: 0.08, t1: 0.75 }],
      scallop: 1.0,
    },
    // 下顎側切歯: 中切歯よりわずかに大きく、遠心切縁隅角が丸い
    2: {
      type: 'incisor',
      mesial: [[0, 0.96], [0.12, 1.0], [0.3, 0.98], [0.6, 0.89], [1, 0.74]],
      distal: [[0, 0.88], [0.15, 0.97], [0.32, 1.0], [0.6, 0.9], [1, 0.74]],
      buccal: [[0, 0.14], [0.04, 0.22], [0.15, 0.37], [0.35, 0.58], [0.6, 0.83], [0.8, 0.97], [0.88, 1.0], [1, 0.95]],
      lingual: [[0, 0.14], [0.06, 0.21], [0.25, 0.38], [0.5, 0.6], [0.75, 0.82], [0.88, 0.87], [1, 0.82]],
      nBuccal: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      nLingual: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      lingualTaper: [[0, 0], [0.4, 0.2], [1, 0.22]],
      edge: { round: 0.2, mesial: { start: 0.82, lift: 0.18 }, distal: { start: 0.6, lift: 0.5 } },
      relief: [{ side: 'l', kind: 'fossa', at: 0, width: 0.7, depth: 0.35, t0: 0.08, t1: 0.75 }],
      scallop: 1.0,
    },
    // 下顎犬歯: 上顎犬歯より細長い。尖頭はより近心で、近心尖頭隆線が短く緩やか。
    // 近心の輪郭は歯根へまっすぐ続く。舌側の隆線・窩は控えめ
    3: {
      type: 'canine',
      mesial: [[0, 0.93], [0.1, 0.99], [0.18, 1.0], [0.5, 0.95], [0.8, 0.84], [1, 0.76]],
      distal: [[0, 0.82], [0.15, 0.94], [0.3, 1.0], [0.55, 0.93], [0.82, 0.8], [1, 0.74]],
      buccal: [[0, 0.17], [0.05, 0.28], [0.15, 0.43], [0.3, 0.6], [0.5, 0.79], [0.7, 0.94], [0.8, 1.0], [0.92, 0.99], [1, 0.91]],
      lingual: [[0, 0.17], [0.06, 0.27], [0.2, 0.43], [0.4, 0.61], [0.6, 0.78], [0.78, 0.9], [0.88, 0.92], [1, 0.86]],
      nBuccal: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      nLingual: [[0, 2.0], [0.3, 2.2], [1, 2.2]],
      lingualTaper: [[0, 0], [0.3, 0.22], [1, 0.25]],
      cusp: { tip: -0.2, mesialSlope: 0.4, distalSlope: 0.62, round: 0.6 },
      edge: { round: 0.2 },
      relief: [
        { side: 'b', kind: 'ridge', at: -0.18, width: 0.3, depth: 0.2, t0: 0, t1: 0.7, fade: true },
        { side: 'l', kind: 'ridge', at: -0.18, width: 0.25, depth: 0.18, t0: 0, t1: 0.75, fade: true },
        { side: 'l', kind: 'fossa', at: 0.3, width: 0.32, depth: 0.22, t0: 0.08, t1: 0.7 },
      ],
      scallop: 1.1,
    },
    // 下顎第一小臼歯: 大きな頬側咬頭と、小さく低い舌側咬頭。頬側咬頭頂は歯の中央寄り
    // （歯冠が舌側へ傾いているため）。頬側咬頭頂から舌側咬頭へ横走隆線が走り、
    // その近遠心に小窩がある。近心舌側溝が舌側へ抜ける
    4: {
      type: 'posterior',
      mesial: [[0, 0.84], [0.1, 0.95], [0.22, 1.0], [0.5, 0.93], [0.8, 0.8], [1, 0.72]],
      distal: [[0, 0.84], [0.12, 0.95], [0.3, 1.0], [0.55, 0.93], [0.82, 0.8], [1, 0.72]],
      buccal: LOWER_BUCCAL,
      lingual: [[0, 0.6], [0.12, 0.78], [0.28, 0.92], [0.45, 0.99], [0.55, 1.0], [0.75, 0.97], [1, 0.89]],
      nBuccal: [[0, 2.2], [1, 2.2]],
      nLingual: [[0, 2.0], [1, 2.0]],
      lingualTaper: 0.22,
      cusps: [
        { at: [-0.04, 0.6], h: 2.8, slope: [0.62, 0.85, 1.1], round: 0.4 },
        { at: [-0.1, -0.84], h: 1.1, slope: [0.5, 0.6, 1.1], round: 0.35 },
      ],
      ridges: [
        // 横走隆線（頬側咬頭 → 舌側咬頭）
        { from: [-0.04, 0.45], to: [-0.1, -0.7], h: 2.25, h1: 1.0, slope: 0.9, round: 0.45 },
        { from: [-0.86, 0.5], to: [-0.84, -0.62], h: 1.3, slope: 1.0, round: 0.35 },
        { from: [0.86, 0.5], to: [0.84, -0.62], h: 1.4, slope: 1.0, round: 0.35 },
      ],
      grooves: [{ path: [[-0.5, -0.12], [-0.58, -1.05]], depth: 0.28, w: 0.34 }],
      pits: [{ at: [-0.5, -0.12], depth: 0.45, w: 0.45 }, { at: [0.48, -0.12], depth: 0.45, w: 0.48 }],
      relief: [
        { side: 'b', kind: 'ridge', at: -0.04, width: 0.3, depth: 0.15, t0: 0, t1: 0.6, fade: true },
      ],
      scallop: 0.8,
    },
    // 下顎第二小臼歯: 頬側咬頭と近心舌側・遠心舌側の 3 咬頭（Y 字の溝）
    5: {
      type: 'posterior',
      mesial: [[0, 0.86], [0.1, 0.96], [0.22, 1.0], [0.5, 0.94], [0.8, 0.81], [1, 0.74]],
      distal: [[0, 0.86], [0.12, 0.95], [0.3, 1.0], [0.55, 0.94], [0.82, 0.81], [1, 0.74]],
      buccal: LOWER_BUCCAL,
      lingual: LOWER_LINGUAL,
      nBuccal: [[0, 2.3], [1, 2.2]],
      nLingual: [[0, 2.4], [1, 2.2]],
      cusps: [
        { at: [0.0, 0.76], h: 2.5, slope: [0.58, 0.85, 1.2], round: 0.4 },
        { at: [-0.45, -0.8], h: 1.9, slope: SHARP, round: 0.4 },
        { at: [0.5, -0.78], h: 1.6, slope: SHARP, round: 0.4 },
      ],
      ridges: [
        { from: [-0.86, 0.72], to: [-0.86, -0.7], h: 1.4, slope: 1.0, round: 0.35 },
        { from: [0.86, 0.72], to: [0.86, -0.7], h: 1.35, slope: 1.0, round: 0.35 },
      ],
      grooves: [
        { path: [[-0.58, 0.0], [0.04, -0.14], [0.58, 0.0]], depth: 0.28, w: 0.34 },
        { path: [[0.04, -0.14], [0.08, -1.08]], depth: 0.28, w: 0.34 },
      ],
      pits: [
        { at: [0.04, -0.14], depth: 0.38, w: 0.45 },
        { at: [-0.58, 0.0], depth: 0.28, w: 0.4 },
        { at: [0.58, 0.0], depth: 0.28, w: 0.4 },
      ],
      relief: [
        { side: 'b', kind: 'ridge', at: 0, width: 0.3, depth: 0.12, t0: 0, t1: 0.6, fade: true },
      ],
      scallop: 0.8,
    },
    // 下顎第一大臼歯: 頬側に近心頬側・遠心頬側・遠心の 3 咬頭、舌側に近心舌側・遠心舌側の
    // 2 咬頭（計 5 咬頭）。舌側咬頭が頬側咬頭より高く尖る。歯冠は舌側へ傾き、
    // 頬側面は歯頸側 1/3 で強く張り出す。溝は中心溝・近心頬側溝・遠心頬側溝・舌側溝
    6: {
      type: 'posterior',
      mesial: [[0, 0.88], [0.1, 0.96], [0.22, 1.0], [0.5, 0.96], [0.8, 0.87], [1, 0.82]],
      distal: [[0, 0.85], [0.12, 0.95], [0.3, 1.0], [0.55, 0.95], [0.82, 0.86], [1, 0.8]],
      buccal: LOWER_BUCCAL,
      lingual: LOWER_LINGUAL,
      nBuccal: [[0, 2.6], [0.5, 2.6], [1, 2.3]],
      nLingual: [[0, 2.6], [0.5, 2.5], [1, 2.3]],
      lingualTaper: 0.06,
      distalTaper: 0.08,
      cusps: [
        { at: [-0.56, 0.86], h: 1.9, slope: BLUNT, round: 0.6 },   // 近心頬側
        { at: [0.04, 0.9], h: 1.8, slope: BLUNT, round: 0.6 },     // 遠心頬側
        { at: [0.66, 0.6], h: 1.4, slope: BLUNT, round: 0.5 },     // 遠心
        { at: [-0.45, -0.84], h: 2.6, slope: SHARP, round: 0.4 },  // 近心舌側（最も高い）
        { at: [0.36, -0.84], h: 2.4, slope: SHARP, round: 0.4 },   // 遠心舌側
      ],
      ridges: [
        { from: [-0.9, 0.78], to: [-0.9, -0.76], h: 1.5, slope: 1.0, round: 0.35 },
        { from: [0.9, 0.5], to: [0.9, -0.7], h: 1.3, slope: 1.0, round: 0.35 },
      ],
      grooves: [
        { path: [[-0.7, 0.0], [-0.26, 0.06], [-0.05, -0.04], [0.36, 0.06], [0.66, 0.0]], depth: 0.3, w: 0.34 },
        { path: [[-0.26, 0.06], [-0.26, 1.1]], depth: 0.3, w: 0.34 },   // 近心頬側溝
        { path: [[0.36, 0.06], [0.4, 1.1]], depth: 0.25, w: 0.3 },      // 遠心頬側溝
        { path: [[-0.05, -0.04], [-0.06, -1.1]], depth: 0.3, w: 0.34 }, // 舌側溝
      ],
      pits: [
        { at: [-0.05, -0.04], depth: 0.4, w: 0.5 },
        { at: [-0.7, 0.0], depth: 0.3, w: 0.42 },
        { at: [0.66, 0.0], depth: 0.3, w: 0.42 },
      ],
      relief: [
        { side: 'b', kind: 'groove', at: -0.26, width: 0.12, depth: 0.25, t0: 0, t1: 0.5, fade: true },
        { side: 'b', kind: 'groove', at: 0.4, width: 0.1, depth: 0.18, t0: 0, t1: 0.35, fade: true },
        { side: 'l', kind: 'groove', at: -0.06, width: 0.12, depth: 0.2, t0: 0, t1: 0.35, fade: true },
      ],
      scallop: 0.6,
    },
    // 下顎第二大臼歯: 4 咬頭。中心溝・頬側溝・舌側溝が十字に交わる。咬合面観は長方形
    7: {
      type: 'posterior',
      mesial: [[0, 0.88], [0.1, 0.96], [0.22, 1.0], [0.5, 0.96], [0.8, 0.87], [1, 0.82]],
      distal: [[0, 0.86], [0.12, 0.95], [0.3, 1.0], [0.55, 0.95], [0.82, 0.86], [1, 0.8]],
      buccal: LOWER_BUCCAL,
      lingual: LOWER_LINGUAL,
      nBuccal: [[0, 2.8], [0.5, 2.7], [1, 2.3]],
      nLingual: [[0, 2.7], [0.5, 2.6], [1, 2.3]],
      distalTaper: 0.06,
      cusps: [
        { at: [-0.5, 0.86], h: 1.9, slope: BLUNT, round: 0.6 },
        { at: [0.5, 0.86], h: 1.8, slope: BLUNT, round: 0.6 },
        { at: [-0.48, -0.84], h: 2.5, slope: SHARP, round: 0.4 },
        { at: [0.5, -0.82], h: 2.3, slope: SHARP, round: 0.4 },
      ],
      ridges: [
        { from: [-0.9, 0.78], to: [-0.9, -0.76], h: 1.45, slope: 1.0, round: 0.35 },
        { from: [0.9, 0.76], to: [0.9, -0.74], h: 1.3, slope: 1.0, round: 0.35 },
      ],
      grooves: [
        { path: [[-0.7, 0.0], [0.7, 0.0]], depth: 0.3, w: 0.34 },
        { path: [[0.0, 0.0], [0.02, 1.1]], depth: 0.3, w: 0.34 },
        { path: [[0.0, 0.0], [-0.02, -1.1]], depth: 0.28, w: 0.34 },
      ],
      pits: [
        { at: [0.0, 0.0], depth: 0.4, w: 0.5 },
        { at: [-0.7, 0.0], depth: 0.3, w: 0.42 },
        { at: [0.7, 0.0], depth: 0.3, w: 0.42 },
      ],
      relief: [
        { side: 'b', kind: 'groove', at: 0.02, width: 0.12, depth: 0.22, t0: 0, t1: 0.45, fade: true },
        { side: 'l', kind: 'groove', at: -0.02, width: 0.12, depth: 0.16, t0: 0, t1: 0.35, fade: true },
      ],
      scallop: 0.6,
    },
  },
};

/** 歯種のテンプレート（第三大臼歯は第二大臼歯の形を使う） */
function profileFor(arch, pos) {
  const table = PROFILES[arch === 'lower' ? 'lower' : 'upper'];
  return table[Math.min(7, Math.max(1, pos))];
}

/**
 * 単調 3 次エルミート補間（Fritsch–Carlson）。制御点 [[t, v], ...] から t の関数を作る。
 * 制御点のあいだで行き過ぎ（オーバーシュート）が起きないので、
 * 「最大豊隆を 1」とした値が 1 を超えて膨らんだり、断面が波打ったりしない。
 */
function smoothCurve(pts) {
  if (typeof pts === 'number') return () => pts;
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (n === 1) return () => ys[0];
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  return (t) => {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && t > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const s = (t - xs[i]) / h;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * m[i]
      + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h * m[i + 1];
  };
}

const curveCache = new Map();
function curvesFor(prof) {
  let c = curveCache.get(prof);
  if (!c) {
    c = {
      mesial: smoothCurve(prof.mesial), distal: smoothCurve(prof.distal),
      buccal: smoothCurve(prof.buccal), lingual: smoothCurve(prof.lingual),
      nB: smoothCurve(prof.nBuccal), nL: smoothCurve(prof.nLingual),
      lingualTaper: smoothCurve(prof.lingualTaper ?? 0),
      distalTaper: smoothCurve(prof.distalTaper ?? 0),
      proximalShift: smoothCurve(prof.proximalShift ?? 0),
    };
    curveCache.set(prof, c);
  }
  return c;
}

const smoothstep01 = (x) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/**
 * 側面の起伏（舌側面窩・辺縁隆線・唇側隆線・頬側溝など）による z 方向のずれ(mm)。
 * C は断面上の近遠心方向の位置（-1 近心端 … +1 遠心端）、S は頬舌方向（+1 頬側 … -1 舌側）。
 */
function sideRelief(prof, C, S, t) {
  if (!prof.relief) return 0;
  let dz = 0;
  for (const f of prof.relief) {
    const onBuccal = f.side === 'b';
    if (onBuccal ? S <= 0 : S >= 0) continue;
    let across;
    if (f.kind === 'fossa') {
      const v = (C - f.at) / f.width;
      across = Math.abs(v) < 1 ? (1 - v * v) ** 2 : 0;
    } else {
      across = Math.exp(-(((C - f.at) / f.width) ** 2));
    }
    if (across < 1e-4) continue;
    let along;
    if (f.fade) {
      along = 1 - smoothstep01((t - f.t0) / (f.t1 - f.t0));
    } else {
      const u = (t - f.t0) / (f.t1 - f.t0);
      along = u > 0 && u < 1 ? Math.sin(Math.PI * u) ** 2 : 0;
    }
    // 隣接面（|S| が小さいところ）では消す: 近心・遠心の輪郭は動かさない
    const side = Math.min(1, Math.abs(S) * 1.6);
    const outward = f.kind === 'ridge' ? 1 : -1;
    dz += (onBuccal ? 1 : -1) * outward * f.depth * across * along * side;
  }
  return dz;
}

/**
 * 高さ t の断面上の点（角度パラメータ θ）。
 * 4 方向の張り出しを別々に持つスーパー楕円。θ は +x（遠心）から +z（頬側）へ測る。
 */
function sectionPoint(prof, cv, theta, t, rMd, rBl) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // 頬側と舌側・近心と遠心の張り出し（と指数）は、境目（隣接面の中央・頬舌の中央）の
  // 前後でなめらかに切り替える。境目でぱっと切り替えると、そこで曲率が跳び、
  // 隣接面や唇側面の中央に縦の筋（稜線のような光の線）が出ていた。
  const wB = smoothstep01((s + 0.35) / 0.7);
  const wD = smoothstep01((c + 0.35) / 0.7);
  const n = cv.nL(t) + (cv.nB(t) - cv.nL(t)) * wB;
  const p = 2 / n;
  const C = Math.sign(c) * Math.abs(c) ** p;
  const S = Math.sign(s) * Math.abs(s) ** p;
  const A = (cv.mesial(t) + (cv.distal(t) - cv.mesial(t)) * wD) * rMd;
  const B = (cv.lingual(t) + (cv.buccal(t) - cv.lingual(t)) * wB) * rBl;
  let x = A * C;
  let z = B * S;
  // 舌側・遠心へのすぼまり。隣接面・頬舌の中央（S=0, C=0）で傾きも曲率も
  // 有限になるよう 2 乗で効かせる（1.5 乗では曲率が無限大になり、
  // 隣接面の中央に縦の稜線が立っていた）
  if (S < 0) x *= 1 - cv.lingualTaper(t) * S * S;
  if (C > 0) z *= 1 - cv.distalTaper(t) * C * C;
  // 前歯の近遠心の最大豊隆（接触点）は切縁の線より唇側にある。断面の近遠心端を
  // 唇側へずらし、隣接面の中央に出ていた鋭い曲がり角を近心唇側・遠心唇側の
  // 隅角（線角）の位置へ移す。(1 - S²)² は S=0 で 1、頬舌の中央で 0 になり、
  // どこでも傾きが連続する
  const shift = cv.proximalShift(t);
  if (shift) z += shift * rBl * (1 - S * S) ** 2;
  z += sideRelief(prof, C, S, t);
  return { x, z, C, S };
}

/** 点 (px, pz) から線分 a-b までの距離と、線分上の位置（0〜1） */
function segDistance(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const L2 = vx * vx + vz * vz || 1e-9;
  const u = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / L2));
  return { d: Math.hypot(px - (ax + vx * u), pz - (az + vz * u)), u };
}

/** 先の丸い円錐の落ち込み量(mm)。距離 0 で 0、遠くでは傾き 1 で増える */
const roundedCone = (q, r) => Math.sqrt(q * q + r * r) - r;

/**
 * 咬合面・切縁の高さ関数 y(x, z, u) を作る（y=0 側が咬合面、+y が歯頸側）。
 * u はキャップ上の半径方向の位置（1 = 咬合縁, 0 = 中心）。
 * rimExt は t=0 断面の張り出し(mm) { m, d, b, l }。
 */
function makeOcclusalSurface(prof, rimExt, rMd) {
  if (prof.type === 'incisor') {
    // 切縁: 中央は一直線で、隅角の近くだけ歯頸側へ回り込む（遠心ほど丸い）。
    // 切縁の厚み方向の丸みは u² で付ける（咬合縁で round mm 下がる）
    const e = prof.edge;
    return (x, z, u) => {
      const side = x >= 0 ? e.distal : e.mesial;
      const a = x >= 0 ? rimExt.d : rimExt.m;
      const w = Math.min(1, Math.abs(x) / a);
      const r = Math.max(0, (w - side.start) / (1 - side.start));
      return side.lift * r * r + e.round * u * u;
    };
  }
  if (prof.type === 'canine') {
    // 尖頭から近心・遠心へ下る尖頭隆線（頂点は半径 round の丸み）
    const k = prof.cusp;
    const tipX = k.tip * rMd;
    return (x, z, u) => {
      const dx = x - tipX;
      const slope = dx < 0 ? k.mesialSlope : k.distalSlope;
      return roundedCone(slope * dx, k.round) + prof.edge.round * u * u;
    };
  }

  // 臼歯: 咬頭（先の丸い円錐）と隆線の高さのなめらかな最大値を取り、溝と小窩を刻む。
  // 円錐どうしが出会うところが V 字の谷（発育溝）になり、咬頭の内斜面は
  // まっすぐな斜面（三角隆線）になる。ガウス分布の山を重ねると饅頭形になり、
  // 辺縁隆線が咬頭から切り離された棒のように見えていた。
  const toMm = ([xn, zn]) => [
    xn * (xn >= 0 ? rimExt.d : rimExt.m),
    zn * (zn >= 0 ? rimExt.b : rimExt.l),
  ];
  const cusps = prof.cusps.map((c) => {
    const [cx, cz] = toMm(c.at);
    const len = Math.hypot(cx, cz) || 1;
    return { ...c, cx, cz, ux: cx / len, uz: cz / len };
  });
  const ridges = (prof.ridges ?? []).map((r) => {
    const [ax, az] = toMm(r.from);
    const [bx, bz] = toMm(r.to);
    return { ...r, ax, az, bx, bz };
  });
  const grooves = (prof.grooves ?? []).map((g) => ({ ...g, pts: g.path.map(toMm) }));
  const pits = (prof.pits ?? []).map((p) => ({ ...p, pt: toMm(p.at) }));
  const SOFT = 0.18;  // なめらかな最大値の丸み(mm)。溝の底が咬合面の格子より細い折れ線にならない程度
  // 窩の底の下限。以前は 0 にしていたため咬頭の斜面が途中で平らな床に当たり、
  // 咬合面の中央が四角い平地に見えた。斜面どうしが V 字で出会うように低くしておく
  const FLOOR = -0.8;

  const elevation = (x, z) => {
    const vals = [FLOOR];
    for (const c of cusps) {
      const dx = x - c.cx, dz = z - c.cz;
      const dr = dx * c.ux + dz * c.uz;     // + が外側（咬合縁側）
      const dt = -dx * c.uz + dz * c.ux;    // 咬合縁に沿う向き
      const sr = dr < 0 ? c.slope[1] : c.slope[2];
      vals.push(c.h - roundedCone(Math.hypot(dt * c.slope[0], dr * sr), c.round));
    }
    for (const r of ridges) {
      const { d, u } = segDistance(x, z, r.ax, r.az, r.bx, r.bz);
      const h = r.h + ((r.h1 ?? r.h) - r.h) * u - (r.dip ?? 0) * 4 * u * (1 - u);
      vals.push(h - roundedCone(d * r.slope, r.round));
    }
    let mx = -Infinity;
    for (const v of vals) mx = Math.max(mx, v);
    let sum = 0;
    for (const v of vals) sum += Math.exp((v - mx) / SOFT);
    let e = mx + SOFT * Math.log(sum);
    for (const g of grooves) {
      let d = Infinity;
      for (let i = 0; i < g.pts.length - 1; i++) {
        const [ax, az] = g.pts[i];
        const [bx, bz] = g.pts[i + 1];
        d = Math.min(d, segDistance(x, z, ax, az, bx, bz).d);
      }
      e -= g.depth * Math.exp(-((d / g.w) ** 2));
    }
    for (const p of pits) {
      const d = Math.hypot(x - p.pt[0], z - p.pt[1]);
      e -= p.depth * Math.exp(-((d / p.w) ** 2));
    }
    return e;
  };
  return (x, z) => -elevation(x, z);
}

// 歯冠メッシュの分割数（どの歯種も 1 歯あたり 48 × 29 + 2 = 1,394 頂点）。
// 前歯は形の特徴が側面（切縁の丸み・舌側面窩・基底結節）にあるので側面を細かく、
// 臼歯は咬合面（咬頭・溝・窩）にあるのでキャップを細かく割る。
// 臼歯の溝は幅 0.3mm 程度しかなく、キャップが粗いと溝が階段状にギザギザになる。
const SEG = 48;                                     // 周方向の分割数
const RINGS = { anterior: 19, posterior: 15 };      // 側面のリング数（t = 0 … 1）
const CAP_RINGS = { anterior: 10, posterior: 14 };  // 咬合面キャップの同心リング数

/**
 * 咬合面の起伏（明暗）を測る極座標グリッドの大きさ。
 * segmentation.js の occlusalRelief がこの形で配列を作る
 * （歯冠の形には使っていないが、計測値の一部として残している）。
 */
export const RELIEF_SEG = 64;
export const RELIEF_RINGS = 16;

/**
 * 歯冠サーフェスを生成する。
 *
 * 形は歯種ごとの標準形（テンプレート）で、写真からは大きさだけを取る。
 * 写真から歯の外形や起伏を写し取ると、検出のわずかな誤りがそのまま
 * 「ありえない形の歯」になるため、outline / relief は受け取っても使わない
 * （呼び出し側の互換のために引数としては残す）。
 *
 * @param {object} spec
 * @param {'upper'|'lower'} spec.arch
 * @param {number} spec.pos  1-8
 * @param {number} spec.md   近遠心幅径(mm)。最大豊隆での x 方向の外形がこの値になる
 * @param {number} spec.bl   頬舌径(mm)。最大豊隆での z 方向の外形がこの値になる
 * @param {number} spec.height 歯冠長(mm)。y は 0（咬頭頂・切縁）〜 height（唇頬側・舌側の歯頸線）
 * @param {*} [spec.outline] 使わない（互換のため）
 * @param {*} [spec.relief]  使わない（互換のため）
 * @param {boolean} [spec.mirror] 近遠心を反転する（局所 +x が近心を向く象限の歯）
 * @returns {{positions: Float32Array, indices: Uint32Array, tParam: Float32Array}}
 *   positions は歯の局所座標（+x 遠心・+z 頬側・+y 歯頸方向）。閉じた外向きのメッシュ。
 *   tParam は各頂点の t（0 = 咬合面・切縁 … 1 = 歯頸部）。咬合面キャップの頂点は 0.05 以下
 */
export function buildCrown(spec) {
  const { arch, pos, md, bl, height } = spec;
  const std = STANDARD_TEETH[arch === 'lower' ? 'lower' : 'upper'][Math.min(8, Math.max(1, pos))];
  const prof = profileFor(arch, pos);
  const cv = curvesFor(prof);
  // まず標準の大きさで作り、最後に md・bl・height へ伸縮する
  const rMd = std.md / 2;
  const rBl = std.bl / 2;
  const H = std.height;
  const kind = prof.type === 'posterior' ? 'posterior' : 'anterior';
  const nRings = RINGS[kind];
  const nCap = CAP_RINGS[kind];

  const thetas = [];
  for (let si = 0; si < SEG; si++) thetas.push((si / SEG) * Math.PI * 2);

  // t=0（咬合縁・切縁）の断面と、その張り出し
  const rim = thetas.map((th) => sectionPoint(prof, cv, th, 0, rMd, rBl));
  const rimExt = {
    m: cv.mesial(0) * rMd, d: cv.distal(0) * rMd,
    b: cv.buccal(0) * rBl, l: cv.lingual(0) * rBl,
  };
  const occY = makeOcclusalSurface(prof, rimExt, rMd);

  // 側面の上端（咬合縁）と下端（歯頸線）の高さ。
  // 歯頸線は唇頬側・舌側の中央で y = H、隣接面で scallop だけ咬合面側へ立ち上がる
  const cerv = thetas.map((th) => sectionPoint(prof, cv, th, 1, rMd, rBl));
  const yTop = rim.map((p) => occY(p.x, p.z, 1));
  const yBot = cerv.map((p) => H - prof.scallop * Math.abs(p.C) ** 2);

  const positions = [];
  const tParam = [];
  const indices = [];
  const push = (x, y, z, t) => {
    positions.push(x, y, z);
    tParam.push(t);
    return positions.length / 3 - 1;
  };

  // --- 側面（リング）--------------------------------------------------
  // y は同じ θ の上端〜下端を t で比例配分する。上端より下端が必ず歯頸側にあるので、
  // 各 θ で y が単調に増え、側面が折り返すことはない。
  const ringStart = [];
  for (let ri = 0; ri < nRings; ri++) {
    const t = ri / (nRings - 1);
    ringStart.push(positions.length / 3);
    for (let si = 0; si < SEG; si++) {
      const p = ri === 0 ? rim[si] : ri === nRings - 1 ? cerv[si] : sectionPoint(prof, cv, thetas[si], t, rMd, rBl);
      push(p.x, yTop[si] + (yBot[si] - yTop[si]) * t, p.z, t);
    }
  }
  for (let ri = 0; ri < nRings - 1; ri++) {
    for (let si = 0; si < SEG; si++) {
      const a = ringStart[ri] + si;
      const b = ringStart[ri] + ((si + 1) % SEG);
      const c = ringStart[ri + 1] + si;
      const d = ringStart[ri + 1] + ((si + 1) % SEG);
      indices.push(a, c, b, b, c, d);
    }
  }

  // --- 咬合面キャップ -------------------------------------------------
  // 咬合縁を中心へ向かって相似に縮めたリングを重ねる。xz 平面への投影が
  // 重ならない（高さの関数のグラフになる）ので、起伏をどう付けても自己交差しない。
  const capRings = [ringStart[0]];
  for (let k = 1; k <= nCap; k++) {
    const u = 1 - k / (nCap + 1);
    capRings.push(positions.length / 3);
    for (let si = 0; si < SEG; si++) {
      const x = rim[si].x * u;
      const z = rim[si].z * u;
      push(x, occY(x, z, u), z, 0.02);
    }
  }
  const capCenter = push(0, occY(0, 0, 0), 0, 0.02);
  for (let k = 0; k < capRings.length - 1; k++) {
    for (let si = 0; si < SEG; si++) {
      const a = capRings[k] + si;
      const b = capRings[k] + ((si + 1) % SEG);
      const c = capRings[k + 1] + si;
      const d = capRings[k + 1] + ((si + 1) % SEG);
      indices.push(a, b, c, b, d, c);
    }
  }
  const lastCap = capRings[capRings.length - 1];
  for (let si = 0; si < SEG; si++) {
    indices.push(lastCap + si, lastCap + ((si + 1) % SEG), capCenter);
  }

  // --- 歯頸部キャップ（STL を閉じた面にするため）----------------------
  // 歯頸線は隣接面で立ち上がるので、中心は歯頸線の平均の高さに置く
  const cervStart = ringStart[nRings - 1];
  let cx = 0, cy = 0, cz = 0;
  for (let si = 0; si < SEG; si++) {
    cx += positions[(cervStart + si) * 3];
    cy += positions[(cervStart + si) * 3 + 1];
    cz += positions[(cervStart + si) * 3 + 2];
  }
  const cervCenter = push(cx / SEG, cy / SEG, cz / SEG, 1);
  for (let si = 0; si < SEG; si++) {
    indices.push(cervStart + ((si + 1) % SEG), cervStart + si, cervCenter);
  }

  // --- 大きさを合わせる -----------------------------------------------
  // 咬合面観の菱形（上顎大臼歯）は全体に同じせん断を掛けて作る。
  // 全頂点に同じ線形変換を掛けるだけなので、面が折り返したり交差したりしない。
  const pos32 = new Float32Array(positions);
  const shear = prof.shear ?? 0;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity;
  for (let i = 0; i < pos32.length; i += 3) {
    if (shear) pos32[i] += shear * pos32[i + 2];
    x0 = Math.min(x0, pos32[i]); x1 = Math.max(x1, pos32[i]);
    z0 = Math.min(z0, pos32[i + 2]); z1 = Math.max(z1, pos32[i + 2]);
    y0 = Math.min(y0, pos32[i + 1]);
  }
  // 最大豊隆の外形がちょうど md・bl になり、外接矩形の中心が原点に来るようにする
  // （配置の基準点は咬合面写真で見た歯の外形の中心なので）。
  // y は咬頭頂・切縁を 0、唇頬側の歯頸線を height に合わせる。
  const sx = md / (x1 - x0);
  const sz = bl / (z1 - z0);
  const mx = (x0 + x1) / 2;
  const mz = (z0 + z1) / 2;
  const sy = height / (H - y0);
  const flip = spec.mirror ? -1 : 1;
  for (let i = 0; i < pos32.length; i += 3) {
    pos32[i] = (pos32[i] - mx) * sx * flip;
    pos32[i + 1] = (pos32[i + 1] - y0) * sy;
    pos32[i + 2] = (pos32[i + 2] - mz) * sz;
  }
  if (spec.mirror) {
    // 左右反転で面の向きが裏返るので、三角形の頂点順を反転して外向きを保つ
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
  }

  return {
    positions: pos32,
    indices: new Uint32Array(indices),
    tParam: new Float32Array(tParam),
  };
}

/**
 * 患者の実測幅径から歯冠長を推定する。
 * 実測幅径 / 標準幅径 の比を高さにも適用する（等比スケーリング）。
 * @param {'upper'|'lower'} arch
 * @param {number} pos
 * @param {number} measuredMd 実測近遠心幅径(mm)
 * @param {number} [globalScale] 正面写真から求めた歯冠長の補正係数
 */
export function estimateCrownHeight(arch, pos, measuredMd, globalScale = 1) {
  const std = STANDARD_TEETH[arch][pos];
  const ratio = Math.min(1.25, Math.max(0.8, measuredMd / std.md));
  return std.height * (0.55 + 0.45 * ratio) * globalScale;
}

/**
 * 実測できない頬舌径を推定する。
 * 咬合面観からは頬舌径も計測できるが、歯肉に隠れる部位もあるため
 * 実測値と標準値を重み付き平均する。
 */
export function estimateBl(arch, pos, measuredBl, mdRatio) {
  const std = STANDARD_TEETH[arch][pos];
  const fromStd = std.bl * mdRatio;
  if (!Number.isFinite(measuredBl) || measuredBl <= 0) return fromStd;
  const clamped = Math.min(std.bl * 1.4, Math.max(std.bl * 0.6, measuredBl));
  return clamped * 0.6 + fromStd * 0.4;
}
