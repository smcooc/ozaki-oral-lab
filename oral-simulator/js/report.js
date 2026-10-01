/**
 * report.js
 * 診断値の集計、患者説明用の比較画像（Before / After）の作成、
 * 計測値の CSV 書き出し。
 */

import { PLAN_PRESETS } from './setup.js';
import { toothLabel, TOOTH_NAMES } from './tooth-library.js';

const mm = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);
const abs = (v, d = 1) => Math.abs(v).toFixed(d);

/** 画面表示用の診断値テーブルを作る */
export function buildReportSections(setup, plan) {
  const sections = [];

  for (const arch of ['upper', 'lower']) {
    const a = setup[arch];
    if (!a) continue;
    const m = a.metrics;
    const label = arch === 'upper' ? '上顎' : '下顎';
    const rows = [
      ['歯冠幅径の合計（検出歯）', `${m.sumMd.toFixed(1)} mm`],
      ['アーチレングスディスクレパンシー', `${mm(m.ald)} mm（${m.ald < 0 ? '叢生' : '空隙'}）`],
      ['　右側 / 左側', `${mm(m.aldRight)} / ${mm(m.aldLeft)} mm`],
      ['抜歯により得られるスペース', `${m.extractionSpace.toFixed(1)} mm`],
      ['IPR（ディスキング）', `${m.ipr.toFixed(1)} mm`],
      ['犬歯間幅径', `${m.canineWidthBefore.toFixed(1)} → ${m.canineWidthAfter.toFixed(1)} mm`],
      ['大臼歯間幅径', `${m.molarWidthBefore.toFixed(1)} → ${m.molarWidthAfter.toFixed(1)} mm`],
      ['前歯の前後的変化', `${mm(m.incisorChange)} mm（＋唇側 / −舌側）`],
      [`${m.anchorPos}番の近遠心的移動`, `${mm(-m.molarMesialization)} mm（＋遠心 / −近心）`],
      ['固定源（前歯後退の分担率）', `${Math.round(m.anchorage * 100)} %`],
    ];
    if (a.fromTemplate) {
      // 標準値で組み立てた歯列では、歯冠幅径の合計も叢生量も実測ではない。
      // 数値だけが独り歩きしないよう、表の先頭で断る。
      rows.unshift(['⚠ 計測の出どころ',
        '咬合面観がないため、歯冠幅径は標準値です。以下の叢生量・必要スペースは実測ではありません']);
    }
    sections.push({ title: `${label}の分析`, rows });
  }

  if (setup.occlusion) {
    const o = setup.occlusion;
    const rows = [
      ['オーバージェット', `${o.overjetBefore.toFixed(1)} → ${o.overjetAfter.toFixed(1)} mm`],
      ['オーバーバイト', `${o.overbiteBefore.toFixed(1)} → ${o.overbiteAfter.toFixed(1)} mm`],
      ['臼歯関係の変化', `${mm(o.molarRelChange)} mm（＋は上顎が相対的に前方）`],
    ];
    if (plan.surgery.enabled) {
      rows.push(['上顎骨 前方移動（Le Fort I）', `${mm(plan.surgery.mxAdvance)} mm`]);
      rows.push(['上顎骨 圧下（Le Fort I）', `${plan.surgery.mxImpaction.toFixed(1)} mm`]);
      rows.push(['下顎骨 後退（SSRO）', `${mm(plan.surgery.mdSetback)} mm`]);
    }
    sections.push({ title: '咬合関係', rows });
  }

  if (setup.bolton) {
    const b = setup.bolton;
    sections.push({
      title: 'Bolton 分析',
      rows: [
        ['前歯比（標準 77.2%）', `${b.anteriorRatio.toFixed(1)} %`],
        ['　下顎前歯の過不足', `${mm(b.anteriorExcessLower)} mm`],
        ['全歯比（標準 91.3%）', `${b.overallRatio.toFixed(1)} %`],
        ['　下顎の過不足', `${mm(b.overallExcessLower)} mm`],
      ],
    });
  }

  return sections;
}

/** 歯ごとの計測値テーブル */
export function buildToothTable(measurements) {
  const rows = [];
  for (const arch of ['upper', 'lower']) {
    const meas = measurements[arch];
    if (!meas) continue;
    for (const t of [...meas.teeth].sort((a, b) => a.fdi - b.fdi)) {
      rows.push({
        fdi: t.fdi,
        label: toothLabel(t.fdi),
        name: TOOTH_NAMES[t.pos],
        md: t.mdMm,
        bl: t.blMm,
        height: t.heightMm,
        rotation: t.rotationDeg,
      });
    }
  }
  return rows;
}

/** 計測値 CSV */
export function toothCsv(measurements) {
  const head = '歯式,歯種,近遠心幅径mm,頬舌径mm,歯冠長mm,捻転角deg';
  const lines = buildToothTable(measurements).map((r) =>
    [r.label, r.name, r.md.toFixed(2), r.bl.toFixed(2), r.height.toFixed(2), r.rotation.toFixed(1)].join(','));
  return [head, ...lines].join('\n');
}

/** 抜歯部位の説明文 */
export function extractionSummary(plan) {
  const names = [];
  for (const [q, pos] of Object.entries(plan.extraction)) {
    if (!Number(pos)) continue;
    names.push(toothLabel(Number(q) * 10 + Number(pos)));
  }
  return names.length ? names.join('・') : '抜歯なし';
}

/**
 * 患者説明用の比較画像を描画する。
 * @param {HTMLCanvasElement} canvas
 * @param {{before: HTMLCanvasElement, after: HTMLCanvasElement}} views
 * @param {object} ctxInfo { plan, setup, viewLabel }
 */
export function renderComparison(canvas, views, ctxInfo) {
  const { before, after } = views;
  const W = Math.max(before.width, after.width);
  const H = Math.max(before.height, after.height);
  const GAP = Math.round(W * 0.02);
  const fs = Math.max(16, Math.round(W * 0.042));
  const small = Math.max(12, Math.round(W * 0.027));
  const HEADER = Math.round(fs * 1.9);
  const lines = summaryLines(ctxInfo);
  const FOOTER = Math.round(small * 1.55 * (lines.length + 0.8));

  canvas.width = W * 2 + GAP;
  canvas.height = H + HEADER + FOOTER;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.drawImage(before, 0, HEADER, W, H);
  ctx.drawImage(after, W + GAP, HEADER, W, H);

  ctx.fillStyle = '#1f2937';
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('現在（Before）', W / 2, HEADER - fs * 0.45);
  ctx.fillText('治療後の予測（After）', W + GAP + W / 2, HEADER - fs * 0.45);

  ctx.font = `${small}px sans-serif`;
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.fillStyle = i === lines.length - 1 ? '#6b7280' : '#1f2937';
    ctx.fillText(line, Math.round(W * 0.02), H + HEADER + small * 1.55 * (i + 1));
  });
  return canvas;
}

function summaryLines({ plan, setup, viewLabel }) {
  const preset = PLAN_PRESETS[plan.presetId];
  const date = new Date().toLocaleDateString('ja-JP');
  const lines = [];
  lines.push(`治療方針: ${preset ? preset.label : plan.presetId}　抜歯部位: ${extractionSummary(plan)}　（${date}${viewLabel ? ' / ' + viewLabel : ''}）`);

  const parts = [];
  for (const arch of ['upper', 'lower']) {
    const a = setup[arch];
    if (!a) continue;
    const label = arch === 'upper' ? '上顎' : '下顎';
    const m = a.metrics;
    parts.push(`${label}: 叢生 ${mm(m.ald)}mm / 前歯 ${mm(m.incisorChange)}mm`);
  }
  if (parts.length) lines.push(parts.join('　'));

  if (setup.occlusion) {
    const o = setup.occlusion;
    lines.push(`オーバージェット ${o.overjetBefore.toFixed(1)}→${o.overjetAfter.toFixed(1)}mm　オーバーバイト ${o.overbiteBefore.toFixed(1)}→${o.overbiteAfter.toFixed(1)}mm`);
  }
  if (plan.surgery.enabled) {
    lines.push(`外科手術: 上顎 前方 ${mm(plan.surgery.mxAdvance)}mm / 圧下 ${abs(plan.surgery.mxImpaction)}mm　下顎 後退 ${mm(plan.surgery.mdSetback)}mm`);
  }
  lines.push('※本画像は治療方針の説明を補助する参考シミュレーションであり、実際の治療結果を保証するものではありません。尾崎矯正歯科クリニック');
  return lines;
}
