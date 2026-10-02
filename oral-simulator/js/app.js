/**
 * app.js
 * 口腔内シミュレーションアプリの画面制御。
 *
 *   STEP1 写真取り込み（カメラ / ファイル）
 *   STEP2 歯列の自動検出 → 手直し
 *   STEP3 治療方針の設定（抜歯・固定源・IPR・拡大・アーチフォーム・外科手術）
 *   STEP4 3Dビュー / 診断値 / 比較画像 / STL・CSV 書き出し / 症例連携
 */

import { loadImageFile, toCanvas, getImageData, downloadCanvas, downloadBlob } from '../../shared/js/imaging.js';
import { CameraCapture, streamSupported, preferDeviceCamera, captureWithDeviceCamera, cancelDeviceCamera } from '../../shared/js/camera.js';
import {
  $, makeSlider, setStatus, setEnabled, bindTabs, nextFrame, makeYielder,
} from '../../shared/js/ui.js';
import { listCases, getCase, saveCaseModule, deleteCase } from '../../shared/js/case-store.js';
import { STANDARD_TEETH, TOOTH_NAMES, toothLabel, fdi } from './tooth-library.js';
import { ARCH_TEMPLATES } from './arch.js';
import {
  imageFingerprint, captureCorrection, matchesCorrection, validCorrection,
  restoreToothAdjust, captureAdjustRecord, matchesAdjustRecord,
} from './corrections.js';
import {
  ToothAdjustUI, applyToothAdjust, emptyToothAdjust, sanitizeToothAdjust, countAdjusted,
} from './tooth-adjust.js';
import {
  detectArch, measureTeeth, guessHandles, buildToothMask, assessPhoto,
} from './segmentation.js';
import {
  PLAN_PRESETS, defaultPlan, computeSetup, buildMeasurement,
  buildTemplateMeasurement, quadrantOf,
} from './setup.js';
import { buildArchModel, updateTransforms, morphPhases, enamelShade } from './reconstruct3d.js';
import {
  buildFitModel, buildTargetMask, fitViews, defaultShape, drawFitOverlay,
  projectBounds, mirrorCosts, isOccludedView, estimateToothShifts, measureIncisalGap,
  rasterize, iou, VIEW_INIT,
} from './fitting.js';
import { OralViewer3D, VIEWS } from './viewer3d.js';
import { exportArchStl } from './stl.js';
import { buildReportSections, buildToothTable, toothCsv, renderComparison } from './report.js';
import { postToHub, onHubMessage, caseIdFromUrl, isEmbedded } from '../../shared/js/sync.js';

const NORM_KEY = 'ozaki-oral-norms-v1';
const PLAN_KEY = 'ozaki-oral-plan-v1';
const MAX_PHOTO = 1100;   // 解析に使う画像の最大辺(px)

/**
 * 撮影モードごとの写真構成。
 *
 * clinical … 矯正歯科の規格写真。ミラーで撮った咬合面観から歯列弓を実測できる
 * phone    … スマートフォンでの自撮り。咬合面観が撮れないため、
 *             標準のアーチフォームを出発点に、写真へ当てはめて近づける
 */
const CAPTURE_MODES = {
  clinical: {
    label: '口腔内カメラ・一眼（5枚法）',
    note: '咬合面観から歯列弓と歯の幅径を実測します。印刷物や画面を撮り直した写真でも構いませんが、'
      + '歯列全体が入り、ピントと明るさが確保されたものをお使いください。',
    hint: '<strong>矯正歯科の規格写真（5枚法）がそのまま使えます。</strong>'
      + '正面観・右側方観・左側方観（いずれも咬合位）と、上下顎の咬合面観2枚です。'
      + '開口位の写真は不要です。<br>'
      + '<strong>咬合面観</strong>からは、歯列弓の形と幅径だけでなく'
      + '<strong>1歯ずつの咬合面輪郭（その患者固有の歯の形）</strong>を取り出します。'
      + 'ミラーで撮影した写真は左右が反転しているため、必要に応じて「左右反転」で戻してください。'
      + '前歯が上になるよう回転させると検出が安定します。<br>'
      + '<strong>正面観・側方観</strong>からは、上下顎の前後的な関係'
      + '（オーバージェット・臼歯関係）、オーバーバイト、そして'
      + '<strong>1歯ずつの歯冠長</strong>を測ります。左右の反転は STEP3 で自動判定して直します。',
    slots: [
      { id: 'upper', title: '上顎 咬合面観', required: true,
        note: 'ミラーで口蓋側から撮った上顎の歯列。歯列弓の形と歯の幅径をここから測ります。' },
      { id: 'lower', title: '下顎 咬合面観', required: true,
        note: 'ミラーで舌側から撮った下顎の歯列。前歯が画面の上になる向きが推奨です。' },
      { id: 'frontal', title: '正面観（咬合位）', fit: 'frontal',
        note: '口角鉤をかけ、噛み合わせた状態の正面。オーバーバイトと歯冠長を測ります。' },
      { id: 'rightBuccal', title: '右側方観（咬合位）', fit: 'rightBuccal',
        note: '噛み合わせた状態の右側。上下顎の前後的な関係（臼歯関係）を測ります。' },
      { id: 'leftBuccal', title: '左側方観（咬合位）', fit: 'leftBuccal',
        note: '噛み合わせた状態の左側。' },
    ],
  },
  clinical7: {
    label: '口腔内カメラ・一眼（7枚法）',
    note: '5枚法に、咬合位の真横（90°）から撮った左右2枚を加えた構成です。'
      + '真横の写真は臼歯関係がいちばんよく写るため、上下顎の前後的な関係の精度が上がります。',
    hint: '<strong>矯正歯科の規格写真（7枚法）</strong>です。'
      + '5枚法の構成に、<strong>咬合位の真横（90°）から撮った左右2枚</strong>を加えます。<br>'
      + '真横の写真は側方観（約60°）より回り込んでいるため、'
      + '臼歯関係・オーバージェットの読み取りが安定します。'
      + '5枚法と同じく、咬合面観からは<strong>1歯ずつの咬合面輪郭</strong>を、'
      + '正面観・側方観からは<strong>1歯ずつの歯冠長</strong>を測ります。<br>'
      + 'ミラーで撮影した咬合面観は左右が反転しているため、必要に応じて「左右反転」で戻してください。'
      + '左右の反転は STEP3 で自動判定して直します。',
    slots: [
      { id: 'upper', title: '上顎 咬合面観', required: true,
        note: 'ミラーで口蓋側から撮った上顎の歯列。歯列弓の形と歯の幅径をここから測ります。' },
      { id: 'lower', title: '下顎 咬合面観', required: true,
        note: 'ミラーで舌側から撮った下顎の歯列。前歯が画面の上になる向きが推奨です。' },
      { id: 'frontal', title: '正面観（咬合位）', fit: 'frontal',
        note: '口角鉤をかけ、噛み合わせた状態の正面。オーバーバイトと歯冠長を測ります。' },
      { id: 'rightBuccal', title: '右側方観（咬合位）', fit: 'rightBuccal',
        note: '噛み合わせた状態の右側（約60°）。' },
      { id: 'leftBuccal', title: '左側方観（咬合位）', fit: 'leftBuccal',
        note: '噛み合わせた状態の左側（約60°）。' },
      { id: 'rightLateral', title: '右側方観（真横90°）', fit: 'rightLateral',
        note: '噛み合わせた状態の右側を真横から。臼歯関係をここから測ります。' },
      { id: 'leftLateral', title: '左側方観（真横90°）', fit: 'leftLateral',
        note: '噛み合わせた状態の左側を真横から。' },
    ],
  },
  phone: {
    label: 'スマートフォンで撮影（口角鉤なし）',
    note: '咬合面観がないため、28歯すべての幅径・咬合面の形・歯列弓は標準値になります'
      + '（この患者さん固有の歯の形は再現されません）。写真から合わせられるのは、'
      + '歯冠長・咬み合わせの深さ・上下顎の前後的な関係だけです。'
      + '診断には必ず規格写真（5枚法／7枚法）をお使いください。',
    hint: '明るい場所で、<strong>指で唇を軽く広げ、上下の歯が見えるように</strong>撮ってください。'
      + '<strong>噛み合わせた状態</strong>の正面・右斜め・左斜めがそろうと、'
      + '上下顎の前後的な関係まで測れます。'
      + '<strong>少し口を開けた状態</strong>の斜めも足すと、上下それぞれの歯列の形が安定します。<br>'
      + '<strong>インカメラで撮ったときの左右反転は自動で判定して直します</strong>'
      + '（斜めの写真が1枚以上あるとき）。うまくいかない場合は「⇄ 左右反転」で手動でも直せます。',
    slots: [
      { id: 'frontal', title: '正面（噛み合わせて）', required: true, fit: 'frontal',
        note: '正面から。奥歯を噛み合わせたまま、唇を指で軽く広げて上下の歯を見せます。' },
      { id: 'rightBuccal', title: '右斜め（噛み合わせて）', fit: 'rightBuccal',
        note: '顔を少し左へ向け、自分の右側の歯が見えるように。噛み合わせたまま撮ります。' },
      { id: 'leftBuccal', title: '左斜め（噛み合わせて）', fit: 'leftBuccal',
        note: '顔を少し右へ向け、自分の左側の歯が見えるように。' },
      { id: 'rightBuccalOpen', title: '右斜め（少し開けて）', fit: 'rightBuccalOpen',
        note: '同じ向きで、上下の歯を少し離して撮ります。' },
      { id: 'leftBuccalOpen', title: '左斜め（少し開けて）', fit: 'leftBuccalOpen',
        note: '同じ向きで、上下の歯を少し離して撮ります。' },
    ],
  },
};

/** 現在の撮影モードの写真スロット */
let PHOTO_SLOTS = CAPTURE_MODES.phone.slots;
/** 多視点フィッティングに使う写真（咬合面観以外） */
let FIT_SLOTS = PHOTO_SLOTS.filter((x) => x.fit);

/** フィッティングの作業解像度（幅, px） */
const FIT_WIDTH = 128;

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
const state = {
  captureMode: 'phone',
  photos: {},          // slotId -> 表示用 canvas
  transforms: {},      // slotId -> { rotate, flip }
  mirrorCertain: {},   // slotId -> 左右が確定しているか（false なら写真から自動判定する）
  useSystemCamera: false,  // アプリ内カメラが使えない環境では端末カメラを直接開く
  sources: {},         // slotId -> 元画像（回転前）
  imageData: { upper: null, lower: null },
  handles: { upper: null, lower: null },
  detections: { upper: null, lower: null },
  fingerprints: {},
  savedCorrections: {},
  measurements: { upper: null, lower: null },
  // 歯ごとの治療前の位置の手直し。{ upper: { fdi: {labial, distal, rotate, extrude} }, lower }
  // 計測値そのものは作り直すたびに消えるので、ここに持って runSimulation で付け直す。
  toothAdjust: emptyToothAdjust(),
  models: { upper: null, lower: null },
  lastTooth: 7,
  // 口腔内に存在しない歯（欠損・未萌出・治療前に抜去済み）。FDI 番号 -> true
  absent: {},
  // 基準3点を自動で決められず既定位置に置いた顎
  handlesUncertain: { upper: false, lower: false },
  calib: { centralMd: 8.5, centralHeight: 10.5 },
  plan: defaultPlan(),
  setup: null,
  morphT: 1,
  activeArch: 'upper',
  activeTab: 'tab-3d',
  compareView: 'front',
  overlay: { scale: 1, x: 0, y: 0, opacity: 0.85 },
  fit: null,          // { poses, shape, quality, mean } 多視点フィッティングの結果
  archForm: 'ovoid',  // スマートフォンモードで使う歯列弓の形（写真から選ぶ）
  fitting: false,
  caseId: caseIdFromUrl(),
};

let viewer = null;
let editor = null;
let adjustUI = null;  // 歯ごとの手直しの操作盤（tooth-adjust.js）
let photoSession = 0; // 症例・撮影モード切替前の読み込み結果を破棄する
let camera = null;
let cameraTargetSlot = null;
let cameraRequest = 0;
let norms = loadNorms();

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
async function main() {
  applyNormsToLibrary(norms);
  bindCaptureMode();
  applyCaptureMode(state.captureMode, { silent: true });
  buildPlanCards();
  buildAbsentChart();
  buildDentitionChart();
  buildSpaceParams();
  buildArchFormSelect();
  buildSurgeryParams();
  buildOcclusionParams();
  buildViewPresets();
  buildCompareViewSelect();
  buildStlButtons();
  buildOverlayParams();
  bindArchSwitch();
  bindDetectControls();
  bindFitControls();
  bindResultTabs();
  bindMorphControls();
  bindDisplayToggles();
  bindExports();
  bindSettingsDialog();
  bindCasesDialog();
  bindCamera();
  if (state.caseId) {
    $('in-case-id').value = state.caseId;
    $('in-case-id-dialog').value = state.caseId;
  }

  const { ArchEditor } = await import('./editor2d.js');
  editor = new ArchEditor($('editor-canvas'), {
    onHandles: (h) => { redetect(state.activeArch, h); },
    onBounds: () => { remeasure(state.activeArch); },
    onSelection: () => { refreshBoundaryControls(); },
  });
  editor.detailCanvas = $('boundary-detail');
  $('boundary-zoom').addEventListener('change', e => {
    editor.detailZoom = Number(e.target.value);
    editor.render();
  });
  $('boundary-select').addEventListener('change', e => {
    const [side, index] = e.target.value.split(':');
    editor.selectBoundary(side, Number(index));
  });
  $('boundary-in').addEventListener('click', () => editor.nudgeBoundary(-1));
  $('boundary-out').addEventListener('click', () => editor.nudgeBoundary(1));
  $('boundary-undo').addEventListener('click', () => editor.undoBoundary());

  viewer = new OralViewer3D($('viewer3d'));
  adjustUI = new ToothAdjustUI({
    state,
    viewer,
    // 手直しは治療前の位置を変えるので、歯肉まで含めて作り直す。
    // 視点・拡大率は保つ（1 歯ずつ直しているときに見失わないように）。
    rerun: () => runSimulation(true, { keepView: true }),
    showBefore: () => { $('morph-slider').value = '0'; setMorph(0); },
  });
  restorePlan();
  // 動作確認・不具合調査用の参照（患者データを外部へ出すものではない）
  window.oralSimulator = { state, viewer, runFitting, runSimulation, adjustUI,
    // 開発時の検査用
    _debug: { buildFitModel, estimateToothShifts, rasterize, iou, runSimulation, fitAgreement, redetect } };
  // ビューアを作ってから配線する（統合ハブからの操作が先に届くことがあるため）
  bindHubSync();
}

// ---------------------------------------------------------------------------
// STEP1: 写真取り込み
// ---------------------------------------------------------------------------
function bindCaptureMode() {
  document.querySelectorAll('[data-capture]').forEach((card) => {
    card.addEventListener('click', () => applyCaptureMode(card.dataset.capture));
  });
}

/**
 * 撮影モードを切り替える。
 * 写真スロットの構成・説明文・STEP2（咬合面観の検出）の要否が変わる。
 */
function applyCaptureMode(mode, opts = {}) {
  if (state.fitting) {
    setStatus($('photo-status'), 'warn', '写真への当てはめが終わってから切り替えてください。');
    return;
  }
  const def = CAPTURE_MODES[mode];
  if (!def) return;
  photoSession++;
  stopCamera();
  state.captureMode = mode;
  PHOTO_SLOTS = def.slots;
  FIT_SLOTS = PHOTO_SLOTS.filter((x) => x.fit);

  document.querySelectorAll('[data-capture]').forEach((c) =>
    c.classList.toggle('is-selected', c.dataset.capture === mode));
  $('mode-note').textContent = def.note;
  $('photo-hint').innerHTML = def.hint;

  // モードをまたいで写真を持ち越さない（構成も意味も変わるため）
  state.photos = {};
  state.sources = {};
  state.transforms = {};
  state.mirrorCertain = {};
  state.imageData = { upper: null, lower: null };
  state.detections = { upper: null, lower: null };
  state.fingerprints = {};
  state.savedCorrections = {};
  state.measurements = { upper: null, lower: null };
  state.models = { upper: null, lower: null };
  state.fit = null;
  state.setup = null;
  state.handles = { upper: null, lower: null };
  // 歯ごとの手直しは写真の読み違いを直したもの。別の写真・別の症例へ持ち越さない
  state.toothAdjust = emptyToothAdjust();
  editor?.clear();
  state.handlesUncertain = { upper: false, lower: false };
  for (const id of ['compare-canvas', 'frontal-canvas', 'overlay-canvas']) {
    const canvas = $(id);
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
  for (const id of ['report-sections', 'tooth-table', 'fit-views']) $(id).replaceChildren();
  for (const id of ['fit-status', 'detect-status', 'export-status']) $(id).hidden = true;

  buildPhotoSlots();
  const clinical = mode !== 'phone';
  $('step-detect').hidden = !clinical;
  $('absent-block-phone').hidden = clinical;
  $('detect-mode-note').hidden = clinical;
  setEnabled($('step-detect'), false);
  setEnabled($('step-fit'), false);
  setEnabled($('step-plan'), false);
  setEnabled($('step-result'), false);
  $('photo-status').hidden = true;
  viewer?.clear();
  adjustUI?.refresh();
  updateFitAvailability();
  if (!opts.silent) {
    setStatus($('photo-status'), 'busy',
      `${def.label}のモードに切り替えました。写真を取り込んでください。`);
  }
}

function buildPhotoSlots() {
  const wrap = $('photo-slots');
  wrap.innerHTML = '';
  for (const slot of PHOTO_SLOTS) {
    state.transforms[slot.id] = state.transforms[slot.id] ?? { rotate: 0, flip: false };
    const el = document.createElement('div');
    el.className = 'photo-slot' + (slot.required ? '' : ' is-optional');
    el.id = `slot-${slot.id}`;
    el.innerHTML = `
      <span class="slot-title">${slot.title}<span class="slot-required${slot.required ? '' : ' is-optional'}">${slot.required ? '必須' : '任意'}</span></span>
      <canvas class="slot-thumb" id="thumb-${slot.id}"></canvas>
      <span class="slot-note">${slot.note}</span>
      <div class="slot-actions">
        <button class="btn" data-act="camera">📷 撮影</button>
        <button class="btn" data-act="file">🖼 選択</button>
        <button class="btn" data-act="rotate" hidden>↻ 90°</button>
        <button class="btn" data-act="flip" hidden>⇄ 左右反転</button>
      </div>
      <input type="file" accept="image/*" hidden>`;
    wrap.appendChild(el);

    const fileInput = el.querySelector('input[type="file"]');
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const session = photoSession;
      const img = await loadImageFile(file);
      if (session !== photoSession) return;
      state.sources[slot.id] = img;
      state.transforms[slot.id] = { rotate: 0, flip: false };
      state.mirrorCertain[slot.id] = false;
      await applyPhoto(slot.id);
    });

    el.querySelector('[data-act="file"]').addEventListener('click', () => fileInput.click());
    el.querySelector('[data-act="camera"]').addEventListener('click', () => startCamera(slot));
    el.querySelector('[data-act="rotate"]').addEventListener('click', async () => {
      state.transforms[slot.id].rotate = (state.transforms[slot.id].rotate + 90) % 360;
      await applyPhoto(slot.id);
    });
    el.querySelector('[data-act="flip"]').addEventListener('click', async () => {
      state.transforms[slot.id].flip = !state.transforms[slot.id].flip;
      // 手で直したものは自動判定の対象から外す
      state.mirrorCertain[slot.id] = true;
      await applyPhoto(slot.id);
    });

  }
}

/** 取り込んだ画像に回転・反転を適用し、解析まで進める */
async function applyPhoto(slotId) {
  const session = photoSession;
  const src = state.sources[slotId];
  if (!src) return;
  // 保存済みの補正は同一画像・同じ歯式にだけ戻す。回転前の画素で照合する。
  let restore = null;
  // スマートフォンモードで、歯ごとの手直しが変わったか（戻した・捨てた）
  let adjustNote = '';
  let adjustChanged = false;
  if (slotId === 'upper' || slotId === 'lower') {
    const fingerprint = await imageFingerprint(toCanvas(src, MAX_PHOTO));
    if (session !== photoSession || state.sources[slotId] !== src) return;
    state.fingerprints[slotId] = fingerprint;
    const saved = state.savedCorrections[slotId];
    if (matchesCorrection(saved, fingerprint, positionsBySide(slotId))) {
      restore = saved;
      state.transforms[slotId] = { ...saved.transform };
    }
  } else if (slotId === 'frontal' && state.captureMode === 'phone') {
    // 咬合面観のないスマートフォンモードでは、歯ごとの手直しを必須の正面写真に結び付ける。
    // 保存した症例と同じ写真なら戻し、別の写真に差し替えたら捨てる
    // （回転・反転だけなら回転前の画素は同じなので、手直しはそのまま残る）。
    const hadPhoto = !!state.photos.frontal;
    const prev = state.fingerprints.frontal ?? null;
    const fingerprint = await imageFingerprint(toCanvas(src, MAX_PHOTO));
    if (session !== photoSession || state.sources[slotId] !== src) return;
    state.fingerprints.frontal = fingerprint;
    const saved = state.savedCorrections.frontal;
    if (matchesAdjustRecord(saved, fingerprint)) {
      state.toothAdjust = sanitizeToothAdjust(saved.toothAdjust);
      delete state.savedCorrections.frontal;
      adjustChanged = true;
      adjustNote = `保存した歯の位置の手直し（${countAdjusted(state.toothAdjust)}歯）を復元しました。`;
    } else {
      if (hadPhoto && (!fingerprint || fingerprint !== prev) && countAdjusted(state.toothAdjust)) {
        state.toothAdjust = emptyToothAdjust();
        adjustChanged = true;
        adjustNote = '別の写真に替えたため、歯の位置の手直しを取り消しました。';
      }
      if (saved) adjustNote += '保存した歯の位置の手直しは写真が一致しないため復元していません。';
    }
  }
  const tr = state.transforms[slotId];
  const canvas = toCanvas(src, MAX_PHOTO, { rotate: tr.rotate, flipX: tr.flip });
  state.photos[slotId] = canvas;

  const slotEl = $(`slot-${slotId}`);
  slotEl.classList.add('is-filled');
  slotEl.querySelectorAll('[data-act="rotate"],[data-act="flip"]').forEach((b) => { b.hidden = false; });
  drawThumb($(`thumb-${slotId}`), canvas);

  if (slotId !== 'upper' && slotId !== 'lower') {
    // 当てはめ（歯ごとの高さ・開咬）はこの写真から求めたものなので、写真を替えたら捨てる
    if (state.fit) {
      state.fit = null;
      maybeRunSimulation(true);
    }
    renderFrontalRef();
    renderOverlay();
    if (state.captureMode === 'phone') await ensureTemplateModel();
    if (session !== photoSession) return;
    // 歯列がすでにあれば ensureTemplateModel は作り直さないので、手直しの変化を反映させる
    if (adjustChanged) maybeRunSimulation(true);
    updateFitAvailability();
    const title = PHOTO_SLOTS.find((p) => p.id === slotId).title;
    const q = assessPhoto(getImageData(canvas));
    if (q.level === 'ok') {
      setStatus($('photo-status'), 'ok',
        `${title}を取り込みました。STEP3 の「写真に合わせる」で3D形状を合わせられます。${adjustNote}`);
    } else {
      setStatus($('photo-status'), q.level === 'err' ? 'err' : 'warn',
        `${title}を取り込みました。${q.messages.join(' ')}${adjustNote}`);
    }
    return;
  }

  setStatus($('photo-status'), 'busy', `${slotId === 'upper' ? '上顎' : '下顎'}の歯列を検出しています…`);
  await nextFrame();
  if (session !== photoSession) return;
  state.imageData[slotId] = getImageData(canvas);
  const archName = slotId === 'upper' ? '上顎' : '下顎';
  const quality = assessPhoto(state.imageData[slotId]);
  state.detections[slotId] = null;
  state.measurements[slotId] = null;
  state.models[slotId] = null;
  state.handles[slotId] = null;
  state.fit = null;
  // 歯ごとの手直しは、この写真の読み違いを直したもの。写真を替えた・回転や反転で
  // 検出し直した（左右が入れ替わると同じ歯番が別の歯になる）ときは持ち越さない。
  // 保存した症例と同じ写真なら、境界と一緒に下で戻す。
  state.toothAdjust[slotId] = {};
  let ok = false;
  let restored = false;
  if (quality.level !== 'err' && restore && validCorrection(restore, canvas)) {
    const candidate = detectArch(state.imageData[slotId], {
      arch: slotId, handles: restore.handles, positions: positionsBySide(slotId),
    });
    if (candidate && validCorrection(restore, canvas, candidate)) {
      for (const side of ['R', 'L']) candidate.sides[side].bounds = [...restore.sides[side].bounds];
      state.handles[slotId] = structuredClone(restore.handles);
      state.detections[slotId] = candidate;
      ok = remeasure(slotId, true);
      restored = ok;
      if (restored) state.toothAdjust[slotId] = restoreToothAdjust(restore, slotId);
    }
  }
  if (!restored) ok = quality.level !== 'err' && autoDetect(slotId);
  // 復元は初回の画像読み込みだけ。以後の回転・再検出は利用者の操作を優先。
  if (restore) delete state.savedCorrections[slotId];
  if (!ok) {
    // 何が足りないのかまで示さないと撮り直しようがない
    const why = quality.messages.length
      ? quality.messages.join(' ')
      : '写真の向き（前歯が上）と明るさを確認するか、STEP2 の基準点を手で動かして調整してください。';
    setStatus($('photo-status'), 'err', `${archName}の歯列を自動検出できませんでした。${why}`);
  } else {
    const n = state.measurements[slotId]?.teeth.length ?? 0;
    const head = `${archName}: ${n}歯を検出しました`
      + `（${state.measurements[slotId].pxPerMm.toFixed(1)} px/mm）。`;
    const archWarn = state.handlesUncertain[slotId]
      ? `${archName}の基準3点を自動で決められませんでした。`
        + 'STEP2 で、黄色の点を正中に、青の点を左右それぞれの最後方歯に'
        + 'ドラッグして合わせてください（動かすと自動で検出し直します）。'
      : state.measurements[slotId]?.archWarning;
    if (archWarn) {
      setStatus($('photo-status'), 'warn', `${head}${archWarn}`);
    } else if (quality.level === 'ok') {
      setStatus($('photo-status'), 'ok', `${head}STEP2 で境界を確認してください。`);
    } else {
      setStatus($('photo-status'), 'warn',
        `${head}${quality.messages.join(' ')} STEP2 で境界を確認してください。`);
    }
  }
  if (restored) {
    const nAdj = Object.keys(state.toothAdjust[slotId]).length;
    setStatus($('photo-status'), 'ok', `${archName}: 同じ写真を確認し、保存した基準点と歯の境界を復元しました。`
      + (nAdj ? `歯の位置の手直し（${nAdj}歯）も復元しました。` : ''));
  } else if (state.savedCorrections[slotId] || restore) {
    setStatus($('photo-status'), 'warn', `${archName}: 保存した補正と写真・歯式が一致しないため、補正は復元していません。境界を確認してください。`);
  }
  state.activeArch = slotId;
  syncArchSwitch();
  refreshEditor();
  setEnabled($('step-detect'), true);
  maybeRunSimulation();
}

function drawThumb(canvas, src) {
  const maxW = 420;
  const scale = Math.min(1, maxW / src.width);
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
}

function bindCamera() {
  camera = new CameraCapture($('camera-video'), { facing: 'environment' });
  $('btn-cancel-cam').addEventListener('click', stopCamera);
  $('btn-switch-cam').addEventListener('click', async () => {
    const request = cameraRequest;
    try { await camera.toggleFacing(); }
    catch { if (request === cameraRequest) cameraFallback(); }
  });
  $('btn-shutter').addEventListener('click', async () => {
    const shot = camera.grab(1600);
    if (!shot || !cameraTargetSlot) return;
    const id = cameraTargetSlot.id;
    stopCamera();
    await acceptShot(id, shot);
  });
}

/**
 * スマートフォン・iPad はタップ直後に標準カメラを呼び出す。
 * PC のプレビュー失敗後は、次のタップで標準の撮影・選択画面を開く。
 */
async function startCamera(slot) {
  stopCamera();
  const request = cameraRequest;
  cameraTargetSlot = slot;
  $('camera-target').textContent = slot.title;

  // 一度アプリ内カメラが使えなかった環境では、以後は端末カメラを直接開く
  // （許可ダイアログが一瞬出るのを避けるため）
  if (!preferDeviceCamera() && streamSupported() && !state.useSystemCamera) {
    $('camera-area').hidden = false;
    $('camera-area').scrollIntoView({ block: 'center', behavior: 'smooth' });
    try {
      await camera.start();
      return;
    } catch (err) {
      if (request !== cameraRequest) return;
      console.warn('アプリ内カメラを起動できませんでした:', err);
      cameraFallback();
      return; // 許可待ちで失われたユーザー操作を、次のタップで受け直す。
    }
  }
  await captureWithSystemCamera(slot, request);
}

function cameraFallback() {
  state.useSystemCamera = true;
  stopCamera();
  setStatus($('photo-status'), 'warn',
    'カメラのプレビューを開けませんでした。もう一度「撮影」を押すと端末の撮影・選択画面が開きます。「選択」から撮影済みの写真も使えます。');
  $('photo-status').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** この関数の最初の await より前に専用 input をクリックする。 */
async function captureWithSystemCamera(slot, request) {
  const session = photoSession;
  setStatus($('photo-status'), 'busy',
    `${slot.title}を端末のカメラアプリで撮影します…（カメラアプリ内で前後を切り替えられます）`);
  let shot;
  try {
    shot = await captureWithDeviceCamera($('device-camera-input'),
      state.captureMode === 'phone' ? 'user' : 'environment', 1600);
  } catch {
    if (session !== photoSession || request !== cameraRequest) return;
    cameraTargetSlot = null;
    setStatus($('photo-status'), 'warn', '撮影した写真を読み込めませんでした。もう一度「撮影」するか、「選択」から写真を指定してください。');
    return;
  }
  if (session !== photoSession || request !== cameraRequest) return;
  cameraTargetSlot = null;
  if (!shot) {
    setStatus($('photo-status'), 'warn', '撮影をキャンセルしました。');
    return;
  }
  await acceptShot(slot.id, shot);
}

/** 撮影した1枚を取り込む */
async function acceptShot(slotId, shot) {
  state.sources[slotId] = shot.canvas;
  state.transforms[slotId] = { rotate: 0, flip: false };
  state.mirrorCertain[slotId] = shot.mirrorCertain;
  await applyPhoto(slotId);
}

function stopCamera() {
  cameraRequest++;
  cancelDeviceCamera($('device-camera-input'));
  camera?.stop();
  $('camera-area').hidden = true;
  cameraTargetSlot = null;
}

// ---------------------------------------------------------------------------
// STEP2: 検出
// ---------------------------------------------------------------------------
function positionsList() {
  const last = state.lastTooth;
  const all = [1, 2, 3, 4, 5, 6, 7, 8];
  return all.filter((p) => p <= last);
}

/** その象限に実際に存在する歯番（欠損・未萌出を除いたもの） */
function positionsFor(arch, side) {
  return positionsList().filter((p) => !state.absent[fdi(arch, side, p)]);
}

/** 左右それぞれの存在する歯番 */
function positionsBySide(arch) {
  return { R: positionsFor(arch, 'R'), L: positionsFor(arch, 'L') };
}

/** 欠損の指定を切り替える */
function toggleAbsent(arch, side, pos) {
  const num = fdi(arch, side, pos);
  if (state.absent[num]) delete state.absent[num];
  else state.absent[num] = true;
  // 存在しない歯は抜歯の対象にもならない
  const q = quadrantOf(arch, side);
  if (state.absent[num] && Number(state.plan.extraction[q]) === pos) {
    state.plan.extraction[q] = 0;
  }
  if (positionsFor(arch, side).length < 3) {
    delete state.absent[num];
    setStatus($('detect-status'), 'warn',
      '1つの象限に最低3歯は必要です（スケールと歯列弓が決まらなくなるため）。');
    return;
  }
  buildAbsentChart();
  buildDentitionChart();
  savePlan();
  const what = `${toothLabel(num)}を${state.absent[num] ? '欠損' : '存在'}として`;
  if (state.detections[arch]) {
    if (runDetection(arch)) {
      refreshEditor();
      setStatus($('detect-status'), 'ok', `${what}検出をやり直しました。`);
    } else {
      setStatus($('detect-status'), 'err', '検出できませんでした。基準点の位置を確認してください。');
    }
  } else if (state.captureMode === 'phone') {
    // 咬合面観がないモードでは、標準形態の歯列を組み立て直す
    ensureTemplateModel({ force: true });
  }
}

/** 自動検出（基準3点の推定を含む） */
function autoDetect(arch) {
  const imageData = state.imageData[arch];
  if (!imageData) return false;
  const { mask } = buildToothMask(imageData);
  const guess = guessHandles(mask, imageData.width, imageData.height);
  if (!guess) return false;
  state.handles[arch] = { mid: guess.mid, right: guess.right, left: guess.left };
  state.handlesUncertain[arch] = !!guess.uncertain;
  return runDetection(arch);
}

/** 与えられた基準3点で検出をやり直す */
function redetect(arch, handles) {
  state.handles[arch] = handles;
  if (runDetection(arch)) {
    setStatus($('detect-status'), 'ok', '基準点を変更して再検出しました。');
  } else {
    setStatus($('detect-status'), 'err', '検出できませんでした。基準点の位置を確認してください。');
  }
  refreshEditor();
  maybeRunSimulation();
}

function runDetection(arch) {
  const imageData = state.imageData[arch];
  const handles = state.handles[arch];
  if (!imageData || !handles) return false;
  const det = detectArch(imageData, { arch, handles, positions: positionsBySide(arch) });
  if (!det) return false;
  state.detections[arch] = det;
  return remeasure(arch, true);
}

/** 境界を手直しした後などに計測だけをやり直す */
function remeasure(arch, silent = false) {
  const det = state.detections[arch];
  const imageData = state.imageData[arch];
  if (!det || !imageData) return false;

  // 画素/mm は、検出できたすべての歯の「検出幅 ÷ 期待幅」の中央値で決める。
  //
  // 以前は中切歯 2 本の幅だけで歯列全体のスケールを決めていた。下顎中切歯は
  // 歯列でもっとも小さく（標準 5.4mm）、叢生で捻転していることも多いため、
  // 0.5mm の検出誤差がそのまま 9% のスケール誤差になる。実症例では下顎が
  // 上顎より 8.7% 大きいスケールと判定され、下顎歯列弓の幅径が 3〜5mm 狭く
  // 出ていた（第一大臼歯間 35.2mm／標準 38〜42mm）。
  //
  // 合計の比ではなく中央値を採るのは、境界がずれた 1〜2 歯に
  // 引きずられないようにするため。
  // 基準幅径（上顎中切歯の実測値）は全体の倍率として掛ける。
  const calRatio = state.calib.centralMd / STANDARD_TEETH.upper[1].md;
  const ratios = [];
  for (const side of ['R', 'L']) {
    const b = det.sides[side].bounds;
    const ps = det.sides[side].positions;
    for (let i = 0; i < ps.length && i + 1 < b.length; i++) {
      const stdMm = STANDARD_TEETH[arch][ps[i]]?.md;
      const wpx = b[i + 1] - b[i];
      if (!(stdMm > 0) || !(wpx > 0)) continue;
      ratios.push(wpx / (stdMm * calRatio));
    }
  }
  let pxPerMm = det.pxPerMm;
  if (ratios.length >= 4) {
    ratios.sort((a, b2) => a - b2);
    const mid = ratios.length >> 1;
    pxPerMm = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  }
  det.pxPerMm = pxPerMm;

  const raw = measureTeeth(det, imageData, pxPerMm);
  const heightScale = state.calib.centralHeight / STANDARD_TEETH.upper[1].height;
  const meas = buildMeasurement(det, raw, arch, pxPerMm, heightScale);
  state.measurements[arch] = meas;
  state.models[arch] = null; // ジオメトリを作り直す
  if (meas.archWarning) {
    // 歯列弓が求まらないまま3Dにすると「歯が一直線に並んだ」模型になる。
    // 代用したことを必ず伝える。
    setStatus($('detect-status'), 'warn', meas.archWarning);
    if (!silent) maybeRunSimulation();
    return true;
  }
  if (!silent) {
    setStatus($('detect-status'), 'ok', '境界を更新しました。幅径と叢生量を再計算しています。');
    maybeRunSimulation();
  }
  return true;
}

function refreshEditor() {
  const arch = state.activeArch;
  if (!editor) return;
  const photo = state.photos[arch];
  const det = state.detections[arch];
  if (!photo || !det) { editor.clear(); return; }
  editor.setPhoto(photo);
  editor.setDetection(det, state.handles[arch]);
}

function refreshBoundaryControls() {
  const select = $('boundary-select');
  const det = editor?.detection;
  select.replaceChildren();
  select.add(new Option(det ? '境界を選んでください' : '写真を取り込んでください', ''));
  if (det) for (const side of ['R', 'L']) {
    const positions = det.sides[side].positions;
    for (let i = 1; i < positions.length; i++) {
      select.add(new Option(`${side === 'R' ? '患者右' : '患者左'} ${positions[i - 1]}番と${positions[i]}番`, `${side}:${i}`));
    }
  }
  select.disabled = !det;
  const selected = editor?.selected;
  select.value = selected ? `${selected.side}:${selected.index}` : '';
  $('boundary-in').disabled = !selected;
  $('boundary-out').disabled = !selected;
  $('boundary-undo').disabled = !editor?.canUndo();
}

function bindArchSwitch() {
  document.querySelectorAll('[data-arch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeArch = btn.dataset.arch;
      syncArchSwitch();
      buildAbsentChart();
      refreshEditor();
    });
  });
  $('chk-mask').addEventListener('change', (e) => editor?.setShowMask(e.target.checked));
}

function syncArchSwitch() {
  document.querySelectorAll('[data-arch]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.arch === state.activeArch));
}

function bindDetectControls() {
  $('sel-last-tooth').addEventListener('change', (e) => {
    state.lastTooth = parseInt(e.target.value, 10);
    for (const num of Object.keys(state.absent)) {
      if (Number(String(num).slice(1)) > state.lastTooth) delete state.absent[num];
    }
    buildAbsentChart();
    if (state.captureMode === 'phone') {
      ensureTemplateModel({ force: true });
      return;
    }
    for (const arch of ['upper', 'lower']) {
      if (state.detections[arch]) runDetection(arch);
    }
    buildDentitionChart();
    refreshEditor();
    maybeRunSimulation();
  });
  $('in-central-md').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    state.calib.centralMd = v;
    if (state.captureMode === 'phone') {
      ensureTemplateModel({ force: true });
      return;
    }
    for (const arch of ['upper', 'lower']) if (state.detections[arch]) remeasure(arch, true);
    maybeRunSimulation();
  });
  $('in-central-height').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    state.calib.centralHeight = v;
    if (state.captureMode === 'phone') {
      ensureTemplateModel({ force: true });
      return;
    }
    for (const arch of ['upper', 'lower']) if (state.detections[arch]) remeasure(arch, true);
    maybeRunSimulation();
  });
  $('btn-redetect').addEventListener('click', () => {
    const arch = state.activeArch;
    if (!state.imageData[arch]) return;
    const ok = autoDetect(arch);
    setStatus($('detect-status'), ok ? 'ok' : 'err',
      ok ? '自動検出をやり直しました。' : '自動検出できませんでした。基準点を手で置いてください。');
    refreshEditor();
    maybeRunSimulation();
  });
}

// ---------------------------------------------------------------------------
// STEP3: 治療方針
// ---------------------------------------------------------------------------
function buildPlanCards() {
  const wrap = $('plan-cards');
  wrap.innerHTML = '';
  for (const [id, p] of Object.entries(PLAN_PRESETS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'treatment-card' + (id === state.plan.presetId ? ' is-selected' : '');
    btn.dataset.plan = id;
    btn.innerHTML = `<span class="t-name">${p.label}</span><span class="t-desc">${p.desc}</span>`;
    btn.addEventListener('click', () => applyPreset(id));
    wrap.appendChild(btn);
  }
}

function applyPreset(id) {
  const preset = PLAN_PRESETS[id];
  if (!preset) return;
  state.plan.presetId = id;
  state.plan.extraction = { ...preset.extraction };
  state.plan.surgery = {
    ...state.plan.surgery,
    enabled: false, mxAdvance: 0, mxImpaction: 0, mdSetback: 0,
    ...(preset.surgery ?? {}),
  };
  document.querySelectorAll('[data-plan]').forEach((c) =>
    c.classList.toggle('is-selected', c.dataset.plan === id));
  $('chk-surgery').checked = state.plan.surgery.enabled;
  $('surgery-params').hidden = !state.plan.surgery.enabled;
  buildSurgeryParams();
  buildDentitionChart();
  savePlan();
  maybeRunSimulation();
}

/**
 * 欠損・未萌出の歯を指定する歯式。
 * 規格写真モードでは STEP2 に表示中の顎だけを、
 * スマートフォンモードでは STEP4 に上下両方を出す（STEP2 がないため）。
 */
function buildAbsentChart() {
  renderAbsentInto($('absent-chart'), [state.activeArch]);
  renderAbsentInto($('absent-chart-phone'), ['upper', 'lower']);
}

function renderAbsentInto(wrap, arches) {
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const arch of arches) {
    const row = document.createElement('div');
    row.className = 'dentition-row';
    for (const side of ['R', 'L']) {
      const quad = document.createElement('div');
      quad.className = `dentition-quad ${side === 'R' ? 'is-right' : 'is-left'}`;
      for (const pos of positionsList()) {
        const num = fdi(arch, side, pos);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tooth-btn';
        btn.textContent = String(pos);
        const absent = !!state.absent[num];
        btn.title = `${toothLabel(num)} ${TOOTH_NAMES[pos]}${absent ? '（なし）' : ''}`;
        btn.setAttribute('aria-pressed', absent ? 'true' : 'false');
        if (absent) btn.classList.add('is-absent');
        btn.addEventListener('click', () => toggleAbsent(arch, side, pos));
        quad.appendChild(btn);
      }
      if (side === 'R') {
        const mid = document.createElement('div');
        mid.className = 'dentition-midline';
        quad.appendChild(mid);
      }
      row.appendChild(quad);
    }
    wrap.appendChild(row);
  }
  const note = document.createElement('p');
  note.className = 'hint';
  const list = Object.keys(state.absent).filter((n) => state.absent[n]);
  note.textContent = list.length
    ? `なしに指定中: ${list.map((n) => toothLabel(Number(n))).join('・')}`
    : 'すべての歯が存在する前提で組み立てています。';
  wrap.appendChild(note);
}

function buildDentitionChart() {
  const wrap = $('dentition-chart');
  wrap.innerHTML = '';
  const positions = positionsList();
  for (const arch of ['upper', 'lower']) {
    const row = document.createElement('div');
    row.className = 'dentition-row';
    for (const side of ['R', 'L']) {
      const quad = document.createElement('div');
      quad.className = `dentition-quad ${side === 'R' ? 'is-right' : 'is-left'}`;
      for (const pos of positions) {
        const num = fdi(arch, side, pos);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tooth-btn';
        btn.textContent = String(pos);
        btn.title = `${toothLabel(num)} ${TOOTH_NAMES[pos]}`;
        btn.dataset.fdi = String(num);
        const q = quadrantOf(arch, side);
        if (Number(state.plan.extraction[q]) === pos) btn.classList.add('is-extracted');
        const detected = state.measurements[arch]?.teeth.some((t) => t.fdi === num);
        if (state.measurements[arch] && !detected) btn.classList.add('is-missing');
        if (state.absent[num]) {
          // 口腔内にない歯は抜歯の対象にできない（STEP2 で指定を外す）
          btn.classList.add('is-absent');
          btn.disabled = true;
          btn.title += '（口腔内になし）';
        } else {
          btn.addEventListener('click', () => toggleExtraction(arch, side, pos));
        }
        quad.appendChild(btn);
      }
      if (side === 'R') {
        const mid = document.createElement('div');
        mid.className = 'dentition-midline';
        quad.appendChild(mid);
      }
      row.appendChild(quad);
    }
    wrap.appendChild(row);
  }
  const legend = document.createElement('div');
  legend.className = 'dentition-legend';
  legend.textContent = '上段＝上顎 / 下段＝下顎　左右は患者から見た左右（赤＝抜歯）';
  wrap.appendChild(legend);
}

function toggleExtraction(arch, side, pos) {
  const q = quadrantOf(arch, side);
  state.plan.extraction[q] = Number(state.plan.extraction[q]) === pos ? 0 : pos;
  buildDentitionChart();
  savePlan();
  maybeRunSimulation();
}

function buildSpaceParams() {
  const panel = $('space-params');
  panel.innerHTML = '';
  const defs = [
    { id: 'anchorage.upper', label: '上顎 固定源（前歯後退の分担率）', unit: '%', min: 0, max: 100, step: 5, value: state.plan.anchorage.upper * 100, scale: 0.01 },
    { id: 'anchorage.lower', label: '下顎 固定源（前歯後退の分担率）', unit: '%', min: 0, max: 100, step: 5, value: state.plan.anchorage.lower * 100, scale: 0.01 },
    { id: 'ipr.upper', label: '上顎 IPR（ディスキング）総量', unit: 'mm', min: 0, max: 8, step: 0.5, value: state.plan.ipr.upper },
    { id: 'ipr.lower', label: '下顎 IPR（ディスキング）総量', unit: 'mm', min: 0, max: 8, step: 0.5, value: state.plan.ipr.lower },
    { id: 'expansion.upperCanine', label: '上顎 犬歯間幅径の拡大', unit: 'mm', min: -2, max: 8, step: 0.5, value: state.plan.expansion.upperCanine },
    { id: 'expansion.upperMolar', label: '上顎 大臼歯間幅径の拡大', unit: 'mm', min: -2, max: 10, step: 0.5, value: state.plan.expansion.upperMolar },
    { id: 'expansion.lowerCanine', label: '下顎 犬歯間幅径の拡大', unit: 'mm', min: -2, max: 6, step: 0.5, value: state.plan.expansion.lowerCanine },
    { id: 'expansion.lowerMolar', label: '下顎 大臼歯間幅径の拡大', unit: 'mm', min: -2, max: 8, step: 0.5, value: state.plan.expansion.lowerMolar },
    { id: 'distalization.upper', label: '上顎 臼歯の遠心移動（片側）', unit: 'mm', min: 0, max: 5, step: 0.5, value: state.plan.distalization.upper },
    { id: 'distalization.lower', label: '下顎 臼歯の遠心移動（片側）', unit: 'mm', min: 0, max: 4, step: 0.5, value: state.plan.distalization.lower },
  ];
  for (const def of defs) {
    panel.appendChild(makeSlider(def, (v) => {
      setPlanValue(def.id, def.scale ? v * def.scale : v);
      savePlan();
      maybeRunSimulation();
    }));
  }
}

function buildArchFormSelect() {
  const sel = $('sel-arch-form');
  sel.innerHTML = '';
  for (const [id, t] of Object.entries(ARCH_TEMPLATES)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = t.label;
    sel.appendChild(o);
  }
  sel.value = state.plan.archForm;
  sel.addEventListener('change', () => {
    state.plan.archForm = sel.value;
    savePlan();
    maybeRunSimulation();
  });
}

function buildSurgeryParams() {
  const panel = $('surgery-params');
  panel.innerHTML = '';
  const defs = [
    { id: 'surgery.mxAdvance', label: '上顎骨 前方移動（Le Fort I / −は後方）', unit: 'mm', min: -4, max: 10, step: 0.5, value: state.plan.surgery.mxAdvance },
    { id: 'surgery.mxImpaction', label: '上顎骨 圧下（上方移動）', unit: 'mm', min: 0, max: 8, step: 0.5, value: state.plan.surgery.mxImpaction },
    { id: 'surgery.mdSetback', label: '下顎骨 後退（SSRO / −は前進）', unit: 'mm', min: -8, max: 14, step: 0.5, value: state.plan.surgery.mdSetback },
    { id: 'surgery.genioAdvance', label: 'オトガイ形成 前方移動（顔貌側に連携）', unit: 'mm', min: -6, max: 10, step: 0.5, value: state.plan.surgery.genioAdvance },
  ];
  for (const def of defs) {
    panel.appendChild(makeSlider(def, (v) => {
      setPlanValue(def.id, v);
      savePlan();
      maybeRunSimulation();
    }));
  }
  const chk = $('chk-surgery');
  chk.onchange = () => {
    state.plan.surgery.enabled = chk.checked;
    panel.hidden = !chk.checked;
    savePlan();
    maybeRunSimulation();
  };
  chk.checked = state.plan.surgery.enabled;
  panel.hidden = !state.plan.surgery.enabled;
}

function buildOcclusionParams() {
  const panel = $('occlusion-params');
  panel.innerHTML = '';
  const defs = [
    { id: 'occlusion.overjet', label: '現在のオーバージェット', unit: 'mm', min: -6, max: 14, step: 0.5, value: state.plan.occlusion.overjet },
    { id: 'occlusion.overbite', label: '現在のオーバーバイト', unit: 'mm', min: -6, max: 10, step: 0.5, value: state.plan.occlusion.overbite },
    { id: 'occlusion.speeBefore', label: '現在のスピー彎曲の深さ', unit: 'mm', min: 0, max: 6, step: 0.5, value: state.plan.occlusion.speeBefore },
    { id: 'occlusion.speeAfter', label: '治療後のスピー彎曲（目標）', unit: 'mm', min: 0, max: 3, step: 0.5, value: state.plan.occlusion.speeAfter },
  ];
  for (const def of defs) {
    panel.appendChild(makeSlider(def, (v) => {
      setPlanValue(def.id, v);
      savePlan();
      maybeRunSimulation(true);
      // フィッティング済みなら重ね合わせも描き直す。
      // オーバージェットのように写真からは決まりきらない値を、
      // 写真とモデルを見比べながら合わせられるようにするため。
      scheduleFitOverlayRefresh();
    }));
  }
}

let overlayRefreshTimer = null;
function scheduleFitOverlayRefresh() {
  if (!state.fit) return;
  clearTimeout(overlayRefreshTimer);
  overlayRefreshTimer = setTimeout(() => {
    if (!state.fit || !state.setup) return;
    const fitModel = buildFitModel(state.models, state.setup.registration);
    state.fit.fitModel = fitModel;
    renderFitViews(state.fit.views, fitModel, state.fit, state.fit.drawShape);
    if (state.activeTab === 'tab-overlay') renderOverlay();
  }, 180);
}

function setPlanValue(path, value) {
  const [a, b] = path.split('.');
  if (b === undefined) state.plan[a] = value;
  else state.plan[a][b] = value;
}

// ---------------------------------------------------------------------------
// シミュレーション実行
// ---------------------------------------------------------------------------
let queued = false;
let queuedRebuild = false;

/**
 * @param {boolean} rebuild ジオメトリから作り直すか（歯冠長・スピー彎曲の変更時）
 */
function maybeRunSimulation(rebuild = false) {
  if (!state.measurements.upper && !state.measurements.lower) {
    state.setup = null;
    viewer?.clear();
    for (const id of ['report-sections', 'tooth-table', 'fit-views']) $(id).replaceChildren();
    for (const id of ['compare-canvas', 'frontal-canvas', 'overlay-canvas']) {
      const canvas = $(id);
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
    setEnabled($('step-result'), false);
    adjustUI?.refresh();
    return;
  }
  queuedRebuild = queuedRebuild || rebuild;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    const doRebuild = queuedRebuild;
    queued = false;
    queuedRebuild = false;
    runSimulation(doRebuild);
  });
}

/**
 * @param {boolean} rebuild ジオメトリから作り直すか
 * @param {{keepView?: boolean}} [opts] keepView: 3D の視点・拡大率を保つ（歯の手直し時）
 */
function runSimulation(rebuild, opts = {}) {
  // 写真から求めた歯ごとの高さのずれと、歯ごとの手直しを計測値へ付け直してから
  // 排列を計算する。計測値は再計測・再検出・症例の読み込みのたびに作り直され、
  // そのたびに t.dyMm / t.adjust は消える。すべての経路が通るここで付け直せば漏れがない。
  applyShiftsToMeasurements();
  applyToothAdjust(state.measurements, state.toothAdjust);
  const setup = computeSetup(state.measurements, state.plan);
  state.setup = setup;

  // 歯の色は上下の歯をまとめて 1 色にする
  const shade = enamelShade([...(setup.upper?.before ?? []), ...(setup.lower?.before ?? [])]);
  for (const arch of ['upper', 'lower']) {
    const meas = state.measurements[arch];
    const sa = setup[arch];
    if (!meas || !sa) { state.models[arch] = null; continue; }
    if (!state.models[arch] || rebuild) {
      state.models[arch] = buildArchModel({
        arch, measurement: meas, setupArch: sa, imageData: state.imageData[arch], shade,
      });
    } else {
      updateTransforms(state.models[arch], arch, sa);
    }
  }

  viewer.setModels(
    { upper: state.models.upper, lower: state.models.lower },
    setup.registration, { keepView: !!opts.keepView });
  // 統合ハブで並べているときは、治療方針を変えるたびに顔貌側へ数値を送る
  postToHub('link', { link: setup.link });
  applyDisplayToggles();
  viewer.setMorph(state.morphT);

  setEnabled($('step-plan'), true);
  setEnabled($('step-result'), true);
  updateFitAvailability();
  renderReport();
  buildDentitionChart();
  adjustUI?.refresh();
  if (state.activeTab === 'tab-compare') renderCompare();
  if (state.activeTab === 'tab-overlay') renderOverlay();
}

// ---------------------------------------------------------------------------
// STEP4: 結果表示
// ---------------------------------------------------------------------------
function buildViewPresets() {
  const wrap = $('view-presets');
  wrap.innerHTML = '';
  for (const [id, v] of Object.entries(VIEWS)) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = v.label;
    btn.addEventListener('click', () => {
      // 咬合面観では対顎が手前に重なるので片顎だけを表示する。
      // それ以外の視点では上下とも表示に戻す。
      const only = viewer.setView(id);
      $('chk-show-upper').checked = !only || only === 'upper';
      $('chk-show-lower').checked = !only || only === 'lower';
      applyDisplayToggles();
    });
    wrap.appendChild(btn);
  }
}

function buildCompareViewSelect() {
  const sel = $('sel-compare-view');
  sel.innerHTML = '';
  for (const [id, v] of Object.entries(VIEWS)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = v.label;
    sel.appendChild(o);
  }
  sel.value = state.compareView;
  sel.addEventListener('change', () => {
    state.compareView = sel.value;
    renderCompare();
  });
  $('btn-render-compare').addEventListener('click', () => renderCompare());
}

function bindResultTabs() {
  bindTabs($('step-result'), (tabId) => {
    state.activeTab = tabId;
    if (tabId === 'tab-3d') viewer.resize();
    if (tabId === 'tab-compare') renderCompare();
    if (tabId === 'tab-overlay') renderOverlay();
  });
}

function bindDisplayToggles() {
  for (const id of ['chk-show-upper', 'chk-show-lower', 'chk-show-gingiva', 'chk-show-ghost']) {
    $(id).addEventListener('change', applyDisplayToggles);
  }
}

function applyDisplayToggles() {
  viewer.setVisibility({
    upper: $('chk-show-upper').checked,
    lower: $('chk-show-lower').checked,
    gingiva: $('chk-show-gingiva').checked,
    ghost: $('chk-show-ghost').checked,
  });
}

function bindMorphControls() {
  const slider = $('morph-slider');
  slider.addEventListener('input', () => { stopPlayback(); setMorph(parseInt(slider.value, 10) / 100); });
  $('btn-before').addEventListener('click', () => { stopPlayback(); slider.value = 0; setMorph(0); });
  $('btn-after').addEventListener('click', () => { stopPlayback(); slider.value = 100; setMorph(1); });
  $('btn-play').addEventListener('click', () => (playback ? stopPlayback() : startPlayback()));
}

/**
 * 治療の流れ（現在 → 抜歯した歯が歯肉に沈む → 歯が並んでいく → 治療後）を再生する。
 * 約 4 秒。スライダーやボタンに触れると止まる。
 */
let playback = null;
const PLAY_MS = 4200;
function startPlayback() {
  stopPlayback();
  const slider = $('morph-slider');
  const start = performance.now();
  const btn = $('btn-play');
  btn.textContent = '■ 停止';
  const tick = (now) => {
    const t = Math.min(1, (now - start) / PLAY_MS);
    slider.value = String(Math.round(t * 100));
    setMorph(t, false, true);
    if (t < 1 && playback) playback.raf = requestAnimationFrame(tick);
    else stopPlayback();
  };
  playback = { raf: 0 };
  setMorph(0, false, true);
  playback.raf = requestAnimationFrame(tick);
}
function stopPlayback() {
  if (!playback) return;
  cancelAnimationFrame(playback.raf);
  playback = null;
  const btn = $('btn-play');
  if (btn) btn.textContent = '▶ 再生';
}

function setMorph(t, fromHub = false, fromPlayback = false) {
  // 再生中にほかの操作（スライダー・手直し・統合ハブ）で動かしたら再生を止める
  if (!fromPlayback) stopPlayback();
  state.morphT = t;
  $('morph-value').textContent = `${Math.round(t * 100)}%`;
  $('btn-before').classList.toggle('is-active', t === 0);
  $('btn-after').classList.toggle('is-active', t === 1);
  viewer?.setMorph(t);
  if (state.activeTab === 'tab-overlay') renderOverlay();
  // 統合ハブで並べて表示しているときは、顔貌側のスライダーも一緒に動かす
  // progress は歯の動きの進み方（抜歯のあと動き出す）。顔貌側が歯に合わせたいときに使う
  if (!fromHub) postToHub('morph', { value: t, progress: morphPhases(t).move });
}

// ---------------------------------------------------------------------------
// 統合ハブとの同期
// ---------------------------------------------------------------------------
function bindHubSync() {
  if (!isEmbedded()) return;
  onHubMessage((type, payload) => {
    if (type === 'morph' && Number.isFinite(payload.value)) {
      $('morph-slider').value = String(Math.round(payload.value * 100));
      setMorph(payload.value, true);
    } else if (type === 'case' && typeof payload.caseId === 'string' && payload.caseId) {
      state.caseId = payload.caseId;
      $('in-case-id').value = payload.caseId;
      $('in-case-id-dialog').value = payload.caseId;
    }
  });
  postToHub('ready', { module: 'oral' });
}

function renderReport() {
  const wrap = $('report-sections');
  wrap.innerHTML = '';
  if (!state.setup) return;
  for (const section of buildReportSections(state.setup, state.plan)) {
    const el = document.createElement('div');
    el.className = 'report-section';
    el.innerHTML = `<h3>${section.title}</h3><table><tbody>${
      section.rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
    }</tbody></table>`;
    wrap.appendChild(el);
  }
  if (state.setup.warnings.length) {
    const ul = document.createElement('ul');
    ul.className = 'warn-list';
    for (const w of state.setup.warnings) {
      const li = document.createElement('li');
      li.textContent = `⚠ ${w}`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }

  const rows = buildToothTable(state.measurements);
  $('tooth-table').innerHTML = `
    <table class="data-table">
      <thead><tr><th>歯式</th><th>歯種</th><th>近遠心幅径</th><th>頬舌径</th><th>歯冠長</th><th>捻転</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${r.label}</td><td>${r.name}</td>
          <td class="num">${r.md.toFixed(1)}</td>
          <td class="num">${r.bl.toFixed(1)}</td>
          <td class="num">${r.height.toFixed(1)}</td>
          <td class="num">${r.rotation.toFixed(0)}°</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

/** Before / After の3D表示を並べた比較画像を作る */
function renderCompare() {
  if (!state.setup || !viewer) return;
  const saved = state.morphT;
  viewer.setView(state.compareView, { applyVisibility: false });
  viewer.setMorph(0);
  const before = viewer.snapshot();
  viewer.setMorph(1);
  const after = viewer.snapshot();
  viewer.setMorph(saved);
  renderComparison($('compare-canvas'), { before, after }, {
    plan: state.plan,
    setup: state.setup,
    viewLabel: VIEWS[state.compareView]?.label,
  });
}

function renderFrontalRef() {
  const wrap = $('frontal-ref');
  const photo = state.photos.frontal;
  if (!photo) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const cnv = $('frontal-canvas');
  cnv.width = photo.width;
  cnv.height = photo.height;
  cnv.getContext('2d').drawImage(photo, 0, 0);
}

function buildOverlayParams() {
  const panel = $('overlay-params');
  panel.innerHTML = '';
  const defs = [
    { id: 'scale', label: '大きさ', unit: '', min: 0.3, max: 2.5, step: 0.02, value: 1, format: (v) => v.toFixed(2) },
    { id: 'x', label: '左右の位置', unit: 'px', min: -400, max: 400, step: 2, value: 0 },
    { id: 'y', label: '上下の位置', unit: 'px', min: -400, max: 400, step: 2, value: 0 },
    { id: 'opacity', label: '重ねる濃さ', unit: '', min: 0.2, max: 1, step: 0.05, value: 0.85, format: (v) => v.toFixed(2) },
  ];
  for (const def of defs) {
    panel.appendChild(makeSlider(def, (v) => {
      state.overlay[def.id] = v;
      renderOverlay();
    }));
  }
}

/**
 * 正面の口腔内写真にシミュレーション結果を重ねる。
 *
 * STEP3 でフィッティング済みなら、その視点（向き・倍率・位置）で 3D を描画して
 * 写真にぴったり重ねる。未フィッティングの場合は正面視点のままスライダーで合わせる。
 */
function renderOverlay() {
  const cnv = $('overlay-canvas');
  const photo = state.photos.frontal;
  if (!photo) {
    setStatus($('overlay-status'), 'warn', '正面観の写真を STEP1 で取り込むと、写真の上に重ねて表示できます。');
    cnv.width = 10; cnv.height = 10;
    return;
  }
  if (!state.setup) return;

  cnv.width = photo.width;
  cnv.height = photo.height;
  const ctx = cnv.getContext('2d');
  ctx.drawImage(photo, 0, 0);

  const pose = state.fit?.poses?.frontal ?? null;
  const savedView = { rx: viewer.targetRotX, ry: viewer.targetRotY };

  if (pose) {
    // フィッティングで求めた向きに3Dビューを合わせる
    viewer.targetRotY = pose.yaw;
    viewer.targetRotX = pose.pitch;
    setStatus($('overlay-status'), 'ok',
      `STEP3 のフィッティング結果（一致度 ${(state.fit.quality.frontal * 100).toFixed(0)}%）で自動的に重ねています。`);
  } else {
    viewer.setView('front', { applyVisibility: false });
    setStatus($('overlay-status'), 'warn',
      'STEP3 で「写真に合わせる」を実行すると、写真の見え方に自動で重なります。');
  }
  const render = viewer.snapshot();
  viewer.targetRotX = savedView.rx;
  viewer.targetRotY = savedView.ry;

  const o = state.overlay;
  ctx.globalAlpha = o.opacity;

  if (pose) {
    // 写真側の倍率（フィッティング解像度 → 写真の画素）
    const k = photo.width / FIT_WIDTH;
    const bounds = projectBounds(state.fit.fitModel, pose, state.fit.shape);
    const cx = (pose.tx + pose.scale * bounds.cx) * k;
    const cy = (pose.ty + pose.scale * bounds.cy) * k;
    const drawScale = (pose.scale * k) / viewer.pixelsPerMm();
    const w = render.width * drawScale * o.scale;
    const h = render.height * drawScale * o.scale;
    ctx.save();
    ctx.translate(cx + o.x, cy + o.y);
    if (pose.roll) ctx.rotate(-pose.roll);
    ctx.drawImage(render, -w / 2, -h / 2, w, h);
    ctx.restore();
  } else {
    const w = photo.width * 0.9 * o.scale;
    const h = render.height * (w / render.width);
    ctx.drawImage(render, (photo.width - w) / 2 + o.x, (photo.height - h) / 2 + o.y, w, h);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------
function buildStlButtons() {
  const wrap = $('stl-buttons');
  wrap.innerHTML = '';
  const defs = [
    { arch: 'upper', phase: 'before', label: '上顎 現在' },
    { arch: 'upper', phase: 'after', label: '上顎 治療後' },
    { arch: 'lower', phase: 'before', label: '下顎 現在' },
    { arch: 'lower', phase: 'after', label: '下顎 治療後' },
  ];
  for (const d of defs) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = `${d.label} の STL`;
    btn.addEventListener('click', async () => {
      const model = state.models[d.arch];
      if (!model) {
        setStatus($('export-status'), 'err', `${d.label}のモデルがありません。写真を取り込んでください。`);
        return;
      }
      const { blob, triangles } = exportArchStl(model, d.phase);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `${state.caseId || 'case'}_${d.arch}_${d.phase}_${stamp}.stl`;
      const r = await downloadBlob(blob, name);
      if (r.ok) {
        setStatus($('export-status'), 'ok', `${name} を保存しました（三角形 ${triangles.toLocaleString()} 面）。`);
      } else {
        reportSaveFailure(r, 'STL');
      }
    });
    wrap.appendChild(btn);
  }
}

function bindExports() {
  $('btn-export-png').addEventListener('click', async () => {
    renderCompare();
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await downloadCanvas($('compare-canvas'), `oral_simulation_${state.plan.presetId}_${stamp}.png`);
    if (!r.ok) reportSaveFailure(r, '比較画像');
  });
  $('btn-export-csv').addEventListener('click', async () => {
    const csv = toothCsv(state.measurements);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const r = await downloadBlob(blob, `tooth_measurements_${new Date().toISOString().slice(0, 10)}.csv`);
    if (!r.ok) reportSaveFailure(r, '計測値CSV');
  });
  $('btn-export-json').addEventListener('click', async () => {
    const blob = new Blob([JSON.stringify(serializeCase(), null, 2)], { type: 'application/json' });
    const r = await downloadBlob(blob, `oral_simulation_${new Date().toISOString().slice(0, 10)}.json`);
    if (!r.ok) reportSaveFailure(r, '診断値JSON');
  });
  $('in-case-id').addEventListener('change', (e) => { state.caseId = e.target.value.trim(); });
  $('btn-publish-link').addEventListener('click', publishToCase);
}

/** 保存できなかった理由を利用者に伝える */
function reportSaveFailure(result, what) {
  const messages = {
    declined: `${what}の保存はキャンセルされました。`,
    rejected_extension:
      `この画面では${what}の形式を保存できません。`
      + '院内サーバーや GitHub Pages に設置した版であれば保存できます。',
    extension_not_enabled:
      `この画面では${what}の形式を保存できません。設置版をご利用ください。`,
    too_large: `${what}のファイルが大きすぎて保存できませんでした。`,
    rate_limited: '保存の確認が重なっています。少し待ってからもう一度お試しください。',
  };
  const msg = messages[result.code]
    ?? `${what}を保存できませんでした（${result.code}）。`;
  setStatus($('export-status'), result.code === 'declined' ? 'warn' : 'err', msg);
}

/** 症例データ（数値のみ）を組み立てる */
function serializeCase() {
  const corrections = { ...state.savedCorrections };
  for (const arch of ['upper', 'lower']) {
    if (!state.photos[arch]) continue;
    // 歯ごとの手直しも、境界と同じ写真の識別値に結び付けて保存する
    const saved = captureCorrection(state.detections[arch], state.handles[arch],
      state.fingerprints[arch], state.transforms[arch], state.photos[arch],
      state.toothAdjust[arch]);
    if (saved) corrections[arch] = saved;
    else delete corrections[arch];
  }
  if (state.captureMode === 'phone' && state.photos.frontal) {
    // スマートフォンモードは正面の写真に結び付ける（applyPhoto を参照）
    const saved = captureAdjustRecord(state.fingerprints.frontal, state.toothAdjust);
    if (saved) corrections.frontal = saved;
    else delete corrections.frontal;
  }
  return {
    // 版は 2 のまま。toothAdjust は足しただけの任意項目で、無い旧データは「手直しなし」として読める
    schemaVersion: 2,
    corrections,
    // この症例で使った手直しの値（診断値の記録用）。復元には使わない。
    // 復元は写真の照合を通した corrections 側からだけ行う（別の写真へ持ち越さないため）。
    toothAdjust: sanitizeToothAdjust(state.toothAdjust),
    captureMode: state.captureMode,
    savedAt: new Date().toISOString(),
    calib: state.calib,
    lastTooth: state.lastTooth,
    absent: state.absent,
    plan: state.plan,
    measurements: Object.fromEntries(
      ['upper', 'lower'].filter((a) => state.measurements[a]).map((a) => [a, {
        pxPerMm: state.measurements[a].pxPerMm,
        curve: state.measurements[a].curve.toJSON(),
        teeth: state.measurements[a].teeth.map((t) => ({
          fdi: t.fdi, mdMm: t.mdMm, blMm: t.blMm, heightMm: t.heightMm,
          rotationDeg: t.rotationDeg, x: t.x, z: t.z, sMm: t.sMm,
        })),
      }])),
    fit: state.fit ? {
      shape: state.fit.shape,
      quality: state.fit.quality,
      mean: state.fit.mean,
      views: Object.keys(state.fit.poses),
    } : null,
    metrics: state.setup ? {
      upper: state.setup.upper?.metrics ? plainMetrics(state.setup.upper.metrics) : null,
      lower: state.setup.lower?.metrics ? plainMetrics(state.setup.lower.metrics) : null,
      occlusion: state.setup.occlusion,
      bolton: state.setup.bolton,
      warnings: state.setup.warnings,
    } : null,
    link: state.setup?.link ?? null,
  };
}

function plainMetrics(m) {
  const { curveBefore, curveAfter, ...rest } = m;
  return { ...rest, curveBefore: curveBefore?.toJSON?.(), curveAfter: curveAfter?.toJSON?.() };
}

async function publishToCase() {
  const id = ($('in-case-id').value || state.caseId).trim();
  if (!id) {
    setStatus($('export-status'), 'err', '症例IDを入力してください（患者氏名ではなく院内の管理IDを推奨します）。');
    return;
  }
  state.caseId = id;
  try {
    await saveCaseModule(id, 'oral', serializeCase(), { name: id, link: state.setup?.link ?? {} });
    setStatus($('export-status'), 'ok',
      `症例「${id}」に保存しました。顔貌シミュレーションアプリで同じ症例IDを開くと、` +
      `上顎前歯 ${(state.setup?.link.u1retract ?? 0).toFixed(1)}mm・` +
      `下顎前歯 ${(state.setup?.link.l1retract ?? 0).toFixed(1)}mm の後退量が引き継がれます。`);
  } catch (err) {
    console.error(err);
    setStatus($('export-status'), 'err', `保存できませんでした: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 設定（標準歯冠幅径）
// ---------------------------------------------------------------------------
function loadNorms() {
  try {
    const saved = JSON.parse(localStorage.getItem(NORM_KEY));
    if (saved && typeof saved === 'object') return saved;
  } catch { /* 破損時は初期値 */ }
  return null;
}

function applyNormsToLibrary(n) {
  if (!n) return;
  for (const arch of ['upper', 'lower']) {
    for (const pos of Object.keys(STANDARD_TEETH[arch])) {
      const v = n?.[arch]?.[pos];
      if (Number.isFinite(v)) STANDARD_TEETH[arch][pos].md = v;
    }
  }
}

function currentNorms() {
  const out = { upper: {}, lower: {} };
  for (const arch of ['upper', 'lower']) {
    for (const pos of Object.keys(STANDARD_TEETH[arch])) {
      out[arch][pos] = STANDARD_TEETH[arch][pos].md;
    }
  }
  return out;
}

function bindSettingsDialog() {
  const dialog = $('settings-dialog');
  $('btn-settings').addEventListener('click', () => {
    buildNormTable();
    $('norm-csv-result').hidden = true;
    dialog.showModal();
  });
  $('btn-norm-save').addEventListener('click', () => {
    readNormTable();
    localStorage.setItem(NORM_KEY, JSON.stringify(currentNorms()));
    dialog.close();
    for (const arch of ['upper', 'lower']) if (state.detections[arch]) runDetection(arch);
    refreshEditor();
    maybeRunSimulation(true);
  });
  $('btn-norm-reset').addEventListener('click', () => {
    localStorage.removeItem(NORM_KEY);
    location.reload();
  });
  $('btn-norm-csv').addEventListener('click', () => $('norm-csv-input').click());
  $('norm-csv-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    importNormCsv(await file.text());
  });
}

function buildNormTable() {
  const positions = [1, 2, 3, 4, 5, 6, 7, 8];
  const head = `<tr><th>顎</th>${positions.map((p) => `<th>${p}</th>`).join('')}</tr>`;
  const rows = ['upper', 'lower'].map((arch) => `
    <tr><th>${arch === 'upper' ? '上顎' : '下顎'}</th>${positions.map((p) => `
      <td><input type="number" step="0.1" min="3" max="16"
           data-norm="${arch}.${p}" value="${STANDARD_TEETH[arch][p].md}"></td>`).join('')}
    </tr>`).join('');
  $('norm-table').innerHTML = `<table class="norm-grid"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function readNormTable() {
  document.querySelectorAll('[data-norm]').forEach((input) => {
    const [arch, pos] = input.dataset.norm.split('.');
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) STANDARD_TEETH[arch][pos].md = v;
  });
}

function importNormCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let applied = 0, skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const [key, val] = lines[i].split(',').map((c) => c.trim());
    const m = /^([上下])([1-8])$/.exec(key ?? '');
    const v = parseFloat(val);
    if (!m || !Number.isFinite(v)) { skipped++; continue; }
    STANDARD_TEETH[m[1] === '上' ? 'upper' : 'lower'][m[2]].md = v;
    applied++;
  }
  buildNormTable();
  const el = $('norm-csv-result');
  el.hidden = false;
  el.innerHTML = applied
    ? `<p class="status ok">${applied}件を反映しました（スキップ ${skipped}件）。「保存して閉じる」で確定します。</p>`
    : `<p class="status err">有効な行がありませんでした。形式をご確認ください。</p>`;
}

// ---------------------------------------------------------------------------
// 症例の保存・読み込み
// ---------------------------------------------------------------------------
function bindCasesDialog() {
  const dialog = $('cases-dialog');
  $('btn-cases').addEventListener('click', async () => {
    $('case-save-status').hidden = true;
    $('in-case-id-dialog').value = state.caseId;
    await renderCaseList();
    dialog.showModal();
  });
  $('btn-case-close').addEventListener('click', () => dialog.close());
  $('btn-case-save').addEventListener('click', async () => {
    const id = $('in-case-id-dialog').value.trim();
    if (!id) return;
    state.caseId = id;
    $('in-case-id').value = id;
    try {
      const data = serializeCase();
      await saveCaseModule(id, 'oral', data, { name: id, link: state.setup?.link ?? {} });
      const count = ['upper', 'lower'].filter((a) => data.corrections[a]).length;
      const nAdj = countAdjusted(data.toothAdjust);
      // 写真の照合を通して保存できた手直しの歯数（照合できない接続では 0 になる）
      const nAdjSaved = ['upper', 'lower']
        .reduce((n, a) => n + Object.keys(data.corrections[a]?.toothAdjust ?? {}).length, 0)
        + countAdjusted(data.corrections.frontal?.toothAdjust);
      const unavailable = ['upper', 'lower'].some(a => state.detections[a] && !state.fingerprints[a])
        || (nAdj > 0 && nAdjSaved < nAdj);
      const adjNote = nAdjSaved ? `歯の位置の手直し（${nAdjSaved}歯）も記録しました。` : '';
      setStatus($('case-save-status'), unavailable ? 'warn' : 'ok', unavailable
        ? '治療方針を保存しました。この接続では写真の照合ができないため、境界・歯の位置の手直しの保存・復元にはHTTPSまたはlocalhostで開いてください。'
        : `症例を保存しました。${count ? `${count}顎分の境界も記録しました。` : ''}${adjNote}`
          + `${count || adjNote ? '同じ写真を選ぶと復元できます。' : ''}写真は保存していません。`);
      await renderCaseList();
    } catch (err) {
      setStatus($('case-save-status'), 'err', `保存できませんでした: ${err.message}`);
    }
  });
}

async function renderCaseList() {
  const wrap = $('case-list');
  try {
    const cases = await listCases();
    if (!cases.length) {
      wrap.innerHTML = '<p class="hint">保存された症例はありません。</p>';
      return;
    }
    wrap.innerHTML = '';
    for (const c of cases) {
      const row = document.createElement('div');
      row.className = 'case-row';
      const mods = [c.hasOral ? '口腔内' : null, c.hasFace ? '顔貌' : null].filter(Boolean).join(' / ');
      row.innerHTML = `
        <span class="case-name"></span>
        <span class="case-meta">${mods} ・ ${new Date(c.updatedAt).toLocaleString('ja-JP')}</span>`;
      row.querySelector('.case-name').textContent = c.name;
      const load = document.createElement('button');
      load.className = 'btn btn-sm';
      load.textContent = '読み込む';
      load.addEventListener('click', () => loadCase(c.id));
      const del = document.createElement('button');
      del.className = 'btn btn-sm btn-ghost';
      del.textContent = '削除';
      del.addEventListener('click', async () => {
        if (!confirm(`症例「${c.name}」を削除しますか？`)) return;
        await deleteCase(c.id);
        await renderCaseList();
      });
      row.append(load, del);
      wrap.appendChild(row);
    }
  } catch (err) {
    wrap.innerHTML = `<p class="status err">${err.message}</p>`;
  }
}

/** 保存済み症例から治療方針と較正値を復元する（写真は端末に保存していない） */
async function loadCase(id) {
  const rec = await getCase(id);
  if (!rec?.oral) return;
  if (state.fitting) {
    setStatus($('photo-status'), 'warn', '写真への当てはめが終わってから症例を読み込んでください。');
    return;
  }
  // 別症例の写真・計測・3Dを、新しいIDへ付け替えない。
  applyCaptureMode(CAPTURE_MODES[rec.oral.captureMode] ? rec.oral.captureMode : 'clinical', { silent: true });
  state.caseId = id;
  $('in-case-id').value = id;
  state.plan = { ...defaultPlan(), ...rec.oral.plan };
  state.calib = { ...state.calib, ...rec.oral.calib };
  state.lastTooth = rec.oral.lastTooth ?? 7;
  state.absent = { ...(rec.oral.absent ?? {}) };
  state.savedCorrections = { ...(rec.oral.corrections ?? {}) };
  // 歯ごとの手直しは写真の照合が通ったときだけ戻す（applyPhoto）。ここでは件数だけ伝える。
  // 手直しの記録がない旧版の保存データは、手直しなしとして読む。
  const pendingAdjust = ['upper', 'lower']
    .reduce((n, a) => n + Object.keys(restoreToothAdjust(state.savedCorrections[a], a)).length, 0)
    + countAdjusted(sanitizeToothAdjust(state.savedCorrections.frontal?.toothAdjust));
  const unboundAdjust = countAdjusted(sanitizeToothAdjust(rec.oral.toothAdjust)) > pendingAdjust;
  $('in-central-md').value = state.calib.centralMd;
  $('in-central-height').value = state.calib.centralHeight;
  $('sel-last-tooth').value = String(state.lastTooth);
  buildPlanCards();
  buildAbsentChart();
  buildDentitionChart();
  buildSpaceParams();
  buildSurgeryParams();
  buildOcclusionParams();
  $('sel-arch-form').value = state.plan.archForm;
  $('cases-dialog').close();
  savePlan();
  setStatus($('photo-status'), 'ok',
    `症例「${id}」の治療方針を読み込みました。写真は保存されないため、必要に応じて取り込み直してください。`
    + (pendingAdjust ? `歯の位置の手直し（${pendingAdjust}歯）は、保存時と同じ写真を取り込むと復元されます。` : '')
    + (unboundAdjust ? '一部の手直しは写真と照合できない状態で保存されたため、復元できません。' : ''));
}

// ---------------------------------------------------------------------------
// 治療方針の一時保存（端末内）
// ---------------------------------------------------------------------------
function savePlan() {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify({ ...state.plan, _absent: state.absent }));
  } catch { /* 保存できない環境では無視 */ }
}

function restorePlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAN_KEY));
    if (!saved) return;
    const { _absent, ...plan } = saved;
    state.plan = { ...defaultPlan(), ...plan };
    state.absent = _absent && typeof _absent === 'object' ? { ..._absent } : {};
    buildPlanCards();
    buildSpaceParams();
    buildSurgeryParams();
    buildOcclusionParams();
    buildAbsentChart();
    buildDentitionChart();
    $('sel-arch-form').value = state.plan.archForm;
  } catch { /* 破損時は初期値のまま */ }
}

/**
 * スマートフォン撮影モードで、標準のアーチフォームから歯列を組み立てる。
 * 咬合面観がないため実測はできないが、これを出発点に
 * STEP3 で写真へ当てはめて患者ごとの形に近づける。
 */
async function ensureTemplateModel(opts = {}) {
  if (!opts.force && state.measurements.upper && state.measurements.lower) return;
  const heightScale = state.calib.centralHeight / STANDARD_TEETH.upper[1].height;
  const form = opts.archForm ?? state.archForm;
  for (const arch of ['upper', 'lower']) {
    state.measurements[arch] = buildTemplateMeasurement(arch, {
      centralMd: state.calib.centralMd,
      positions: positionsBySide(arch),
      heightScale,
      archForm: form,
    });
    state.models[arch] = null;
  }
  state.archForm = form;
  buildDentitionChart();
  runSimulation(true);
  await nextFrame();
}

// ---------------------------------------------------------------------------
// STEP3: 多視点フィッティング
// ---------------------------------------------------------------------------
function bindFitControls() {
  $('btn-fit').addEventListener('click', () => runFitting());
}

/**
 * 左右反転を自動で直す。
 *
 * インカメラで撮った写真が鏡像になるかは端末・設定によって変わり、
 * 画像自体には手がかりがない。ただし斜めから撮った写真なら、どちら側の歯列が
 * 手前に写っているかを当てはめで判定できる。斜めの写真で反転が分かれば、
 * 同じ撮影でできた正面の写真も同じように反転しているとみなして直す。
 *
 * @returns {Promise<string[]>} 反転を直した写真のスロットID
 */
async function autoCorrectMirror(views) {
  const unknown = views.filter((v) => state.mirrorCertain[v.slotId] !== true);
  if (!unknown.length) return [];

  setStatus($('fit-status'), 'busy', '写真の左右を確かめています…');
  await nextFrame();

  const fitModel = buildFitModel(state.models, state.setup.registration);
  const shape = defaultShape(state.plan);

  // 斜めの写真すべてで「そのまま」と「左右逆」を比べ、合計で判断する。
  // 同じカメラで撮った写真は反転の有無も揃うはずなので、
  // 1枚ずつ決めるより誤判定が起きにくい。
  let sumNormal = 0;
  let sumFlipped = 0;
  let usable = 0;
  for (const v of unknown) {
    const c = mirrorCosts(fitModel, v, shape);
    if (!c) continue;
    sumNormal += c.costNormal;
    sumFlipped += c.costFlipped;
    usable++;
  }
  if (!usable) {
    // 斜めの写真がないと左右は判定できない
    if (unknown.length) {
      setStatus($('fit-status'), 'warn',
        '正面の写真だけでは左右反転を判定できません。'
        + '左右が入れ替わって見える場合は「⇄ 左右反転」を押してください。');
      await nextFrame();
    }
    return [];
  }

  // はっきり差がついたときだけ直す（迷ったら現状のまま）
  const improvement = (sumNormal - sumFlipped) / Math.max(1e-6, sumNormal);
  if (improvement < 0.04) {
    for (const v of unknown) state.mirrorCertain[v.slotId] = true;
    return [];
  }

  const fixed = [];
  for (const v of unknown) {
    flipSlot(v.slotId);
    state.mirrorCertain[v.slotId] = true;
    fixed.push(v.slotId);
  }
  return fixed;
}

/** 指定した写真の左右を反転して表示を作り直す */
function flipSlot(slotId) {
  const tr = state.transforms[slotId] ?? { rotate: 0, flip: false };
  tr.flip = !tr.flip;
  state.transforms[slotId] = tr;
  const src = state.sources[slotId];
  if (!src) return;
  const canvas = toCanvas(src, MAX_PHOTO, { rotate: tr.rotate, flipX: tr.flip });
  state.photos[slotId] = canvas;
  drawThumb($(`thumb-${slotId}`), canvas);
}

/** フィッティングに使える写真があるかで STEP3 の有効・無効を切り替える */
function updateFitAvailability() {
  const hasModel = !!(state.models.upper || state.models.lower);
  const hasView = FIT_SLOTS.some((slot) => state.photos[slot.id]);
  setEnabled($('step-fit'), hasModel && hasView);
  if (!hasView) {
    $('fit-quality').textContent = state.captureMode === 'phone'
      ? '正面の写真を取り込むと実行できます。'
      : '正面観または側方観の写真を取り込むと実行できます。';
  } else if (!state.fit) {
    $('fit-quality').textContent = '「写真に合わせる」で3D形状を写真に合わせます。';
  }
}

/**
 * 3Dモデルを各写真の見え方に合わせ、写真からしか分からない
 * 高さ方向のパラメータ（歯冠長・オーバーバイト・スピー彎曲）を求める。
 */
async function runFitting() {
  if (state.fitting) return;
  if (!state.models.upper && !state.models.lower) {
    setStatus($('fit-status'), 'err', '先に咬合面観から歯列を検出してください。');
    return;
  }
  const views = [];
  for (const slot of FIT_SLOTS) {
    const photo = state.photos[slot.id];
    if (!photo) continue;
    const target = buildTargetMask(photo,
      (id) => buildToothMask(id, { largestOnly: false }), FIT_WIDTH);
    if (!target) continue;
    views.push({ key: slot.fit, slotId: slot.id, ...target });
  }
  if (!views.length) {
    setStatus($('fit-status'), 'err',
      '写真から歯の領域を取り出せませんでした。明るく、歯がはっきり写った写真をお使いください。');
    return;
  }

  state.fitting = true;
  $('btn-fit').disabled = true;
  setStatus($('fit-status'), 'busy', `${views.length}枚の写真に合わせています…`);
  await nextFrame();

  try {
    const isPhone = state.captureMode === 'phone';
    const onProgress = (key, q) => {
      const label = VIEW_INIT[key]?.label ?? key;
      setStatus($('fit-status'), 'busy', `${label}: 一致度 ${(q * 100).toFixed(0)}%`);
    };

    let archPass = null;
    if (isPhone) {
      // 咬合面観がないので歯列弓の形は実測できない。
      // 代表的な3つのアーチフォームで歯列を作り直し、写真にもっとも合う形を選ぶ。
      // （歯は常に弧長どおりに並ぶので、どの形でも隣接歯の接触は保たれる）
      const trials = [];
      for (const form of ['tapered', 'ovoid', 'square']) {
        setStatus($('fit-status'), 'busy',
          `歯列弓の形を試しています（${ARCH_TEMPLATES[form].label}）…`);
        await nextFrame();
        await ensureTemplateModel({ force: true, archForm: form });
        const trialModel = buildFitModel(state.models, state.setup.registration);
        const r = await fitViews(trialModel, views, defaultShape(state.plan),
          { rounds: 1, scanShift: false, yield: makeYielder() });
        trials.push({ form, mean: r.mean });
      }
      trials.sort((a, b) => b.mean - a.mean);
      archPass = { trials, chosen: trials[0].form };
      setStatus($('fit-status'), 'busy',
        `歯列弓の形は「${ARCH_TEMPLATES[trials[0].form].label}」がもっとも合いました。`);
      await nextFrame();
      await ensureTemplateModel({ force: true, archForm: trials[0].form });
      $('sel-arch-form').value = trials[0].form;
      state.plan.archForm = trials[0].form;
    }

    // 左右反転の自動補正（インカメラの写真などで左右が入れ替わっている場合）
    const mirrorFixed = await autoCorrectMirror(views);
    if (mirrorFixed.length) {
      // 反転を直した写真でマスクを作り直す
      for (const v of views) {
        if (!mirrorFixed.includes(v.slotId)) continue;
        const t = buildTargetMask(state.photos[v.slotId],
          (id) => buildToothMask(id, { largestOnly: false }), FIT_WIDTH);
        if (t) Object.assign(v, t);
      }
    }

    const fitModel = buildFitModel(state.models, state.setup.registration);
    state.__fitViews = views;
    const result = await fitViews(fitModel, views, defaultShape(state.plan),
      { onProgress, yield: makeYielder() });
    result.mirrorFixed = mirrorFixed;

    result.archPass = archPass;
    state.fit = {
      ...result, fitModel,
      views: views.map((v) => ({ key: v.key, slotId: v.slotId, W: v.W })),
      // 当てはめ直さずに一致度を測り直せるよう、目標マスクを持っておく
      // （128px の 2 値マスクなので数十 KB にしかならない）
      targets: views,
    };
    applyFitShape(result.shape, result.determined);
    await nextFrame();
    // 反映した値はモデルの形に入ったので、描画は新しいモデル＋中立の形態で行う。
    // こうしておくと、STEP4 でオーバージェットを動かしたときに
    // 重ね合わせがその場で追従する。
    const drawShape = neutralizeAppliedShape(result.shape, result.determined);
    const drawModel = state.setup
      ? buildFitModel(state.models, state.setup.registration) : fitModel;
    state.fit.fitModel = drawModel;
    state.fit.drawShape = drawShape;

    // 開咬・切端咬合: 正面観の元の解像度で、上下の前歯のあいだの暗い隙間を測る。
    // 歯ごとの高さより先に決める（あとにすると、古いオーバーバイトに対して求めた
    // 歯ごとのずれと開咬が二重に効く）。
    result.openBite = detectOpenBite(result.poses, drawShape, views);
    state.fit.openBite = result.openBite;

    // 1歯ずつの高さのずれ（八重歯・低位歯・挺出歯）を写真から求める。
    // 歯冠の長さは変えず、歯そのものを上下に動かす。
    const shifts = applyToothShifts(result.poses, drawShape, views);
    result.toothShifts = shifts;
    state.fit.toothShifts = shifts;


    // 開咬・歯ごとの高さを反映した最終モデルで重ね描きする。
    // drawModel は補正前なので、ここで使うと 3D と写真の重ね描きが食い違う。
    const finalModel = state.setup
      ? buildFitModel(state.models, state.setup.registration) : drawModel;
    state.fit.fitModel = finalModel;
    renderFitViews(views, finalModel, result, drawShape);
    await nextFrame();
    if (state.activeTab === 'tab-overlay') renderOverlay();
    const mirrorNote = result.mirrorFixed.length
      ? `　左右が反転していた写真（${result.mirrorFixed
        .map((id) => PHOTO_SLOTS.find((p) => p.id === id)?.title ?? id).join('・')}）を自動で直しました。`
      : '';
    // 咬合面観がない場合、歯の大きさ・形は実測ではなく標準値である。
    // これを黙っていると「一致度 65%」だけが見えて、標準的な歯列が
    // その患者のものだと受け取られてしまう。必ず明示する。
    const tmplArches = ['upper', 'lower']
      .filter((a) => state.measurements[a]?.fromTemplate)
      .map((a) => (a === 'upper' ? '上顎' : '下顎'));
    const tmplNote = tmplArches.length
      ? `　⚠ ${tmplArches.join('・')}は咬合面観がないため、`
        + '歯の幅径・咬合面の形・歯列弓は標準値です（この患者さんの実測ではありません）。'
        + '一致度は「標準的な歯列をどれだけ写真に合わせられたか」を表します。'
      : '';
    setStatus($('fit-status'), tmplArches.length || result.mean <= 0.55 ? 'warn' : 'ok',
      (result.mean > 0.55
        ? `フィッティングが完了しました（平均一致度 ${(result.mean * 100).toFixed(0)}%）。`
        : `一致度が低めです（平均 ${(result.mean * 100).toFixed(0)}%）。`
          + '写真の向き・明るさをご確認のうえ、結果の数値は手動でも調整できます。') + mirrorNote + tmplNote);
  } catch (err) {
    console.error(err);
    setStatus($('fit-status'), 'err', `フィッティングに失敗しました: ${err.message}`);
  } finally {
    state.fitting = false;
    $('btn-fit').disabled = false;
  }
}

/**
 * フィッティングで求めた形態パラメータを、計測値と治療方針の設定に反映する。
 *
 * シルエットから本当に決まったパラメータだけを反映する。
 * 決まらなかったものは入力値をそのまま残す（推定値で上書きしない）。
 */
function applyFitShape(shape, determined) {
  const ok = (key) => determined?.[key]?.determined !== false;

  if (ok('crownHeightScale')) {
    // 歯冠は標準形なので、写真から歯冠長を大きく変えると「細長い歯」「寸詰まりの歯」に
    // なる。シルエットの歯冠長には口唇の被りや歯肉の見え方も混ざるため、±12% に収める。
    const k = Math.max(0.88, Math.min(1.12, shape.crownHeightScale));
    const height = state.calib.centralHeight * k;
    state.calib.centralHeight = Math.max(6, Math.min(15, Number(height.toFixed(2))));
    $('in-central-height').value = state.calib.centralHeight.toFixed(1);
  }
  if (ok('overbiteDelta')) {
    const ob = state.plan.occlusion.overbite + shape.overbiteDelta;
    state.plan.occlusion.overbite = Math.max(-6, Math.min(10, Math.round(ob * 2) / 2));
  }
  if (ok('speeDelta')) {
    const spee = state.plan.occlusion.speeBefore + shape.speeDelta;
    state.plan.occlusion.speeBefore = Math.max(0, Math.min(6, Math.round(spee * 2) / 2));
  }
  if (ok('archShiftZ')) {
    // 下顎歯列が前方にずれているぶん、オーバージェットは小さくなる
    const oj = state.plan.occlusion.overjet - shape.archShiftZ;
    state.plan.occlusion.overjet = Math.max(-6, Math.min(14, Math.round(oj * 2) / 2));
  }

  buildOcclusionParams();
  if (state.captureMode === 'phone') {
    ensureTemplateModel({ force: true });
  } else {
    for (const arch of ['upper', 'lower']) {
      if (state.detections[arch]) remeasure(arch, true);
    }
    maybeRunSimulation(true);
  }
  savePlan();
}

/**
 * 歯ごとの高さのずれを写真から求め、治療前の配置に反映する。
 *
 * 結果は state.fit.shiftByFdi に持ち、計測をやり直しても（境界の修正など）
 * runSimulation のたびに計測値へ入れ直す。どの写真を差し替えても state.fit ごと消える
 * （咬合面観は applyPhoto の検出の前、正面観・側方観は取り込みの直後）。
 *
 * 反映して測り直す操作を 2 回繰り返し、最後に写真との一致度が
 * 本当に上がったかを確かめる。上がらなければ反映をやめる
 * （写真が示さないずれを作らないため）。
 *
 * @returns {{applied: number, gain?: number, rejected?: boolean, detail: Array, deferredArches?: Array<string>}}
 */
function applyToothShifts(poses, shape, views) {
  if (!state.setup || !state.fit) return { applied: 0, detail: [] };
  // 標準歯列からの当てはめでは、形態/撮影姿勢の違いまで高さで埋めてしまう。
  // 咬合面観で歯並びを測れた顎に限って自動補正し、他は手直しに委ねる。
  const deferredArches = ['upper', 'lower'].filter(a => state.measurements[a]?.fromTemplate);
  if (!['upper', 'lower'].some(a => state.measurements[a] && !deferredArches.includes(a)))
    return { applied: 0, detail: [], deferredArches };
  const prev = { ...(state.fit.shiftByFdi ?? {}) };
  const before = fitAgreement(poses, shape, views);
  const byFdi = { ...prev };

  for (let pass = 0; pass < 2; pass++) {
    if (!state.models.upper && !state.models.lower) runSimulation(true);
    const model = buildFitModel(state.models, state.setup.registration);
    if (!model.teeth.length) break;
    const res = estimateToothShifts(model, poses, shape, views);
    let changed = 0;
    for (const [idx, d] of res) {
      const t = model.teeth[idx];
      if (!t || deferredArches.includes(t.arch)) continue;
      const key = fdi(t.arch, t.side, t.pos);
      const cur = byFdi[key] ?? 0;
      // 1 回では 8 割だけ動かす（隣の歯の動きで一致度が変わるため、少しずつ詰める）
      const next = Math.max(-4.5, Math.min(4.5, cur + d.dy * 0.8));
      if (Math.abs(next - cur) > 0.1) changed++;
      byFdi[key] = Math.round(next * 10) / 10;
    }
    state.fit.shiftByFdi = byFdi;
    state.models.upper = null;
    state.models.lower = null;
    runSimulation(true);
    if (!changed) break;
  }

  const after = fitAgreement(poses, shape, views);
  const gain = after - before;
  if (!(gain > SHIFT_MIN_GAIN)) {
    state.fit.shiftByFdi = prev;
    state.models.upper = null;
    state.models.lower = null;
    runSimulation(true);
    return { applied: 0, rejected: true, gain, detail: [], deferredArches };
  }
  const detail = Object.entries(byFdi)
    .filter(([, dy]) => Math.abs(dy) >= 0.5)
    .map(([k, dy]) => ({ fdi: Number(k), dy }));
  return { applied: detail.length, gain, detail, deferredArches };
}

/** 歯の高さのずれを反映すると認める一致度の改善量（0.5 ポイント。推定は画素が粗く揺れやすいので厳しめ） */
const SHIFT_MIN_GAIN = 0.005;

/**
 * 正面観から開咬（上下の前歯のあいだの隙間）を測り、治療前のオーバーバイトに反映する。
 *
 * シルエットの当てはめではオーバーバイトが決まらないことが多い（作業解像度では
 * 上下の前歯の境目が 1 画素に満たない）。開咬・切端咬合では暗い隙間がはっきり
 * 写るので、元の解像度で測れる。隙間が前歯の列の 6 割以上で見つかったときだけ
 * 反映し、見つからなければ何も変えない（正のオーバーバイトはここでは測らない）。
 */
function detectOpenBite(poses, shape, views) {
  const v = views.find((x) => x.key === 'frontal');
  const photo = v ? state.photos[v.slotId] : null;
  if (!v || !poses.frontal || !photo || !state.setup) return null;
  const imageData = getImageData(photo);
  const { raw } = buildToothMask(imageData, { largestOnly: false });
  const { width, height, data } = imageData;
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const model = buildFitModel(state.models, state.setup.registration);
  const g = measureIncisalGap(model, poses.frontal, shape, v, { raw, luma, width, height });
  if (!g) return null;
  if (g.cols >= 12 && g.frac >= 0.6 && g.gapMm >= 0.5) {
    const ob = -Math.round(g.gapMm * 2) / 2;
    state.plan.occlusion.overbite = Math.max(-6, ob);
    buildOcclusionParams();
    savePlan();
    state.models.upper = null;
    state.models.lower = null;
    runSimulation(true);
    return { ...g, applied: true, overbite: ob };
  }
  return { ...g, applied: false };
}

/** 写真から求めた歯ごとの高さのずれを計測値へ入れる（runSimulation のたびに呼ぶ） */
function applyShiftsToMeasurements() {
  const map = state.fit?.shiftByFdi ?? {};
  for (const arch of ['upper', 'lower']) {
    for (const t of state.measurements[arch]?.teeth ?? []) {
      t.dyMm = Number(map[t.fdi]) || 0;
    }
  }
}

/**
 * いまのモデルが各写真のシルエットとどれだけ一致しているかの平均。
 * 当てはめをやり直さずに測れるので、反映の前後比較に使える。
 */
function fitAgreement(poses, shape, views) {
  if (!state.setup) return 0;
  const model = buildFitModel(state.models, state.setup.registration);
  if (!model.teeth.length) return 0;
  let sum = 0;
  let n = 0;
  for (const v of views) {
    const pose = poses[v.key];
    if (!pose) continue;
    sum += iou(rasterize(model, pose, shape, v.W, v.H), v.mask);
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * 計測値・治療方針へ反映した形態パラメータを 0（中立）に戻す。
 *
 * 反映した値はモデル自体の形に入るため、描画のときにもう一度掛けると
 * 二重に効いてしまう。表に出す数値は `result.shape` のまま使う。
 */
function neutralizeAppliedShape(shape, determined) {
  const out = { ...shape };
  const applied = (k) => determined?.[k]?.determined !== false;
  // 歯冠長はモデルへ ±12% までしか反映しない（applyFitShape）ので、
  // 反映しきれなかった残りの倍率を描画側に残す（姿勢はその倍率で合わせてある）
  if (applied('crownHeightScale')) {
    out.crownHeightScale = shape.crownHeightScale / Math.max(0.88, Math.min(1.12, shape.crownHeightScale));
  }
  if (applied('overbiteDelta')) out.overbiteDelta = 0;
  if (applied('speeDelta')) out.speeDelta = 0;
  if (applied('archShiftZ')) out.archShiftZ = 0;
  return out;
}

/**
 * 各視点の当てはまり具合を、写真の上に重ねて表示する。
 * @param {object} [drawShape] 描画に使う形態パラメータ（省略時は result.shape）
 */
function renderFitViews(views, fitModel, result, drawShape) {
  const wrap = $('fit-views');
  wrap.innerHTML = '';
  for (const v of views) {
    const pose = result.poses[v.key];
    const photo = state.photos[v.slotId];
    if (!pose || !photo) continue;
    const maxW = 420;
    const scale = Math.min(1, maxW / photo.width);
    const W = Math.round(photo.width * scale);
    const H = Math.round(photo.height * scale);

    const box = document.createElement('div');
    box.className = 'fit-view';
    const cnv = document.createElement('canvas');
    cnv.width = W;
    cnv.height = H;
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(photo, 0, 0, W, H);
    drawFitOverlay(ctx, fitModel, pose, drawShape ?? result.shape, W, H, v.W ?? FIT_WIDTH);

    const q = result.quality[v.key] ?? 0;
    const label = document.createElement('span');
    label.className = 'fit-label';
    label.textContent = VIEW_INIT[v.key]?.label ?? v.key;
    const score = document.createElement('span');
    score.className = 'fit-score ' + (q > 0.6 ? 'is-good' : q > 0.4 ? '' : 'is-poor');
    score.textContent = `　一致度 ${(q * 100).toFixed(0)}%`;
    label.appendChild(score);

    box.append(cnv, label);
    wrap.appendChild(box);
  }

  const shape = result.shape;
  const det = result.determined ?? {};
  const deferredHeights = result.toothShifts?.deferredArches ?? [];
  const heightNote = deferredHeights.length
    ? `${deferredHeights.map(a => a === 'upper' ? '上顎' : '下顎').join('・')}は咬合面写真がないため、歯ごとの高さを自動確定していません。咬合面写真を追加するか、3Dの下の「歯の位置を手直し（治療前）」で調整してください。`
    : '';
  // 上下顎の前後的な関係は、噛み合わせた状態の写真がないと測りようがない
  const hasOccluded = Object.keys(result.poses).some((k) => isOccludedView(k));
  const mark = (key, delta) => {
    if (det[key]?.determined === false) {
      return '<span class="fit-undet">写真からは決められませんでした（入力値のまま）</span>';
    }
    if (delta !== undefined && Math.abs(delta) < 0.25) {
      return `写真から計測（入力値と同等: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}mm）`;
    }
    return delta === undefined
      ? '写真から計測'
      : `写真から計測（${delta > 0 ? '+' : ''}${delta.toFixed(1)}mm）`;
  };

  $('fit-result').innerHTML = `
    <table class="data-table">
      <thead><tr><th>項目</th><th>値</th><th>由来</th></tr></thead>
      <tbody>
        <tr><td>上顎中切歯の歯冠長</td>
            <td class="num">${state.calib.centralHeight.toFixed(1)} mm</td>
            <td>${mark('crownHeightScale')}（×${shape.crownHeightScale.toFixed(2)}）</td></tr>
        <tr><td>オーバーバイト</td>
            <td class="num">${state.plan.occlusion.overbite.toFixed(1)} mm</td>
            <td>${mark('overbiteDelta', shape.overbiteDelta)}</td></tr>
        <tr><td>開咬（上下の前歯の隙間）</td>
            <td class="num">${result.openBite?.applied ? `${(-result.openBite.overbite).toFixed(1)} mm` : '-'}</td>
            <td>${result.openBite?.applied
              ? `正面観の前歯の ${Math.round(result.openBite.frac * 100)}% の列で隙間を測り、オーバーバイトを ${result.openBite.overbite.toFixed(1)}mm にしました`
              : '<span class="fit-undet">前歯のあいだに隙間は見つかりませんでした（オーバーバイトは STEP4 で調整できます）</span>'}</td></tr>
        <tr><td>スピー彎曲の深さ</td>
            <td class="num">${state.plan.occlusion.speeBefore.toFixed(1)} mm</td>
            <td>${mark('speeDelta', shape.speeDelta)}</td></tr>
        <tr><td>オーバージェット（上下顎の前後関係）</td>
            <td class="num">${state.plan.occlusion.overjet.toFixed(1)} mm</td>
            <td>${hasOccluded
              ? mark('archShiftZ', -shape.archShiftZ)
              : '<span class="fit-undet">咬合位（噛み合わせた状態）の写真がないため測れません</span>'}
              ${det.archShiftZ?.determined === false || !hasOccluded
                ? '<span class="fit-undet">／上の重ね合わせを見ながら STEP4 のオーバージェットで合わせられます</span>'
                : ''}</td></tr>
        <tr><td>1歯ずつの高さ（高位・低位の歯）</td>
            <td class="num">${result.toothShifts?.applied ? `${result.toothShifts.applied} 歯` : heightNote ? '未確定' : '0 歯'}</td>
            <td>${result.toothShifts?.applied
              ? `正面観・側方観から求めました（${result.toothShifts.detail
                .map((d) => `${toothLabel(d.fdi)} ${d.dy > 0 ? '上' : '下'}へ${Math.abs(d.dy).toFixed(1)}mm`)
                .join('、')}）`
              : heightNote ? '' : '<span class="fit-undet">写真から歯ごとの高さのずれは見つかりませんでした</span>'}
              ${heightNote ? `<span class="fit-undet">${heightNote}</span>` : ''}</td></tr>
        ${state.captureMode === 'phone' && result.archPass ? `
        <tr><td>歯列弓の形</td>
            <td class="num">${ARCH_TEMPLATES[result.archPass.chosen]?.label ?? '-'}</td>
            <td>3種類を試して一致度が最良のものを採用
              （${result.archPass.trials.map((t) =>
                `${ARCH_TEMPLATES[t.form].label.replace(/（.*/, '')} ${(t.mean * 100).toFixed(0)}%`).join(' / ')}）
              ※臼歯部は標準形態です</td></tr>` : ''}
        ${Object.entries(result.poses).map(([k, p]) => `
        <tr><td>${VIEW_INIT[k]?.label ?? k} の撮影角度</td>
            <td class="num">${(p.yaw * 180 / Math.PI).toFixed(0)}°</td>
            <td>開口量 ${(p.jawOpening ?? 0).toFixed(1)}°</td></tr>`).join('')}
      </tbody>
    </table>`;
  $('fit-quality').textContent = `平均一致度 ${(result.mean * 100).toFixed(0)}%`;
}

/**
 * フィッティングで分かった撮影方向を使い、歯冠の唇側・頬側の色を
 * 正面観・側方観の写真から取り直す。
 * 咬合面写真だけでは平均色で塗るしかなかった面に、本人の歯の色が入る。
 */
main();
