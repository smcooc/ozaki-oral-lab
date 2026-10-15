// 写真を含めず、症例の数値・治療方針・写真に結び付いた補正を端末間で渡す。
// 受け取った値は検証してから適用する。ファイルを読んだだけでは保存しない。
export const CASE_FILE_LIMIT = 2 * 1024 * 1024;
export const CASE_FILE_FORMAT = 'ozaki-oral-case';
export const CASE_FILE_VERSION = 1;

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const ORAL_KEYS = ['schemaVersion', 'corrections', 'toothAdjust', 'captureMode', 'savedAt',
  'calib', 'lastTooth', 'absent', 'plan', 'measurements', 'fit', 'metrics', 'link'];
const PLAN_KEYS = ['presetId', 'extraction', 'anchorage', 'ipr', 'expansion', 'distalization', 'archForm', 'surgery', 'occlusion'];
const PRESETS = ['nonext', 'ext4', 'ext45', 'ext5', 'extUpper', 'extLower', 'extIncisor', 'surgeryBimax', 'surgeryMand', 'surgeryExt'];
const ADJUST_LIMITS = { labial: 8, distal: 8, rotate: 45, extrude: 6 };

function fail(message) { throw new Error(`症例ファイルを読み込めません。${message}`); }
function object(value, label, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}の形式が違います。`);
  if (Object.keys(value).some(k => !allowed.includes(k))
      || required.some(k => !Object.hasOwn(value, k))) fail(`${label}の項目が不足しているか、未対応の項目があります。`);
}
function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
      || (integer && !Number.isInteger(value))) fail(`${label}の数値が範囲外です。`);
}
function choice(value, label, choices) {
  if (!choices.includes(value)) fail(`${label}が未対応です。`);
}
function numericGroup(value, label, keys, min, max) {
  object(value, label, keys);
  for (const k of keys) number(value[k], `${label}.${k}`, min, max);
}
function validId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))
    fail('症例IDは空欄にせず、100文字以内で入力してください。');
}

// 計測値など、読込後に再計算する記録も検査し、過大な構造や画像の埋め込みを受け付けない。
function checkTree(root) {
  let count = 0;
  const visit = (v, depth) => {
    if (++count > 20000 || depth > 18) fail('データが複雑すぎます。');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Math.abs(v) > 1e9) fail('有限の数値ではない項目があります。');
      return;
    }
    if (typeof v === 'string') {
      if (v.length > 2000 || /^data:/i.test(v)) fail('長すぎる文字列または画像データが含まれています。');
      return;
    }
    if (!v || typeof v !== 'object') fail('未対応のデータが含まれています。');
    if (Array.isArray(v)) {
      if (v.length > 1000) fail('項目数が多すぎます。');
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) fail('未対応のオブジェクトです。');
    for (const [key, item] of Object.entries(v)) {
      if (FORBIDDEN.has(key) || key.length > 100) fail('安全に読み込めない項目名があります。');
      visit(item, depth + 1);
    }
  };
  visit(root, 0);
}

function checkAdjust(value, arch) {
  object(value, '歯の手直し', Object.keys(value ?? {}));
  for (const [fdi, adjustment] of Object.entries(value)) {
    if (!/^[1-4][1-8]$/.test(fdi) || (arch === 'upper' ? Number(fdi) >= 30 : Number(fdi) < 30))
      fail('歯の手直しの歯番号が違います。');
    object(adjustment, '歯の手直し', Object.keys(ADJUST_LIMITS));
    for (const [key, limit] of Object.entries(ADJUST_LIMITS)) number(adjustment[key], key, -limit, limit);
  }
}
function checkBothAdjust(value) {
  object(value, '上下顎の手直し', ['upper', 'lower']);
  for (const arch of ['upper', 'lower']) checkAdjust(value[arch], arch);
}

function checkCorrections(value) {
  object(value, '写真の補正', ['upper', 'lower', 'frontal'], []);
  for (const [slot, record] of Object.entries(value)) {
    const frontal = slot === 'frontal';
    const fields = frontal ? ['version', 'kind', 'fingerprint', 'toothAdjust']
      : ['version', 'fingerprint', 'width', 'height', 'transform', 'handles', 'sides', 'toothAdjust'];
    object(record, '写真の補正記録', fields, frontal ? fields : fields.filter(k => k !== 'toothAdjust'));
    if (record.version !== 2) fail('写真の補正の版に対応していません。');
    if (typeof record.fingerprint !== 'string' || !/^\d{1,5}x\d{1,5}:[a-f0-9]{64}$/.test(record.fingerprint))
      fail('写真の照合情報が違います。');
    if (frontal) {
      choice(record.kind, '正面写真の補正', ['toothAdjust']);
      checkBothAdjust(record.toothAdjust);
      continue;
    }
    number(record.width, '画像の幅', 1, 20000, true);
    number(record.height, '画像の高さ', 1, 20000, true);
    object(record.transform, '写真の向き', ['rotate', 'flip']);
    choice(record.transform.rotate, '写真の回転', [0, 90, 180, 270]);
    if (typeof record.transform.flip !== 'boolean') fail('写真の左右反転の値が違います。');
    object(record.handles, '基準点', ['mid', 'right', 'left']);
    for (const point of Object.values(record.handles)) {
      object(point, '基準点', ['x', 'y']);
      number(point.x, '基準点X', 0, record.width - Number.EPSILON);
      number(point.y, '基準点Y', 0, record.height - Number.EPSILON);
    }
    object(record.sides, '歯の区切り', ['R', 'L']);
    for (const side of Object.values(record.sides)) {
      object(side, '歯の区切り', ['positions', 'bounds']);
      if (!Array.isArray(side.positions) || side.positions.length > 8
          || !Array.isArray(side.bounds) || side.bounds.length !== side.positions.length + 1)
        fail('歯の区切りの件数が違います。');
      side.positions.forEach((p, i) => {
        number(p, '歯番号', 1, 8, true);
        if (i && p <= side.positions[i - 1]) fail('歯番号の順序が違います。');
      });
      side.bounds.forEach((p, i) => {
        number(p, '歯の境界', 0, 100000);
        if (i && p <= side.bounds[i - 1]) fail('歯の境界の順序が違います。');
      });
    }
    if (record.toothAdjust) checkAdjust(record.toothAdjust, slot);
  }
}

function checkOral(oral) {
  object(oral, '症例', ORAL_KEYS, ['schemaVersion', 'captureMode', 'calib', 'lastTooth', 'absent', 'plan', 'corrections']);
  if (oral.schemaVersion !== 2) fail('症例の保存形式に対応していません。');
  choice(oral.captureMode, '撮影方法', ['phone', 'clinical', 'clinical7']);
  number(oral.lastTooth, '最後方の歯', 5, 8, true);
  object(oral.calib, '較正', ['centralMd', 'centralHeight']);
  number(oral.calib.centralMd, '中切歯の幅', 1, 30);
  number(oral.calib.centralHeight, '中切歯の高さ', 1, 40);
  object(oral.absent, '欠損歯', Object.keys(oral.absent ?? {}));
  for (const [fdi, absent] of Object.entries(oral.absent)) {
    if (!/^[1-4][1-8]$/.test(fdi) || absent !== true) fail('欠損歯の形式が違います。');
  }
  const p = oral.plan;
  object(p, '治療方針', PLAN_KEYS);
  choice(p.presetId, '治療方針の種類', PRESETS);
  choice(p.archForm, '歯列弓の形', ['patient', 'ovoid', 'tapered', 'square']);
  object(p.extraction, '抜歯', ['1', '2', '3', '4']);
  for (const value of Object.values(p.extraction)) number(value, '抜歯位置', 0, 8, true);
  numericGroup(p.anchorage, '固定源', ['upper', 'lower'], 0, 1);
  numericGroup(p.ipr, 'IPR', ['upper', 'lower'], 0, 50);
  numericGroup(p.expansion, '拡大', ['upperCanine', 'upperMolar', 'lowerCanine', 'lowerMolar'], -50, 50);
  numericGroup(p.distalization, '遠心移動', ['upper', 'lower'], 0, 50);
  object(p.surgery, '外科', ['enabled', 'mxAdvance', 'mxImpaction', 'mdSetback', 'genioAdvance']);
  if (typeof p.surgery.enabled !== 'boolean') fail('外科の有効・無効が違います。');
  for (const key of ['mxAdvance', 'mxImpaction', 'mdSetback', 'genioAdvance']) number(p.surgery[key], key, -100, 100);
  numericGroup(p.occlusion, '咬合', ['overjet', 'overbite', 'speeBefore', 'speeAfter', 'overjetAfter', 'overbiteAfter'], -50, 50);
  checkCorrections(oral.corrections);
  if (oral.toothAdjust) checkBothAdjust(oral.toothAdjust);
}

export function validateCaseTransfer(record) {
  checkTree(record);
  object(record, 'ファイル', ['format', 'version', 'caseId', 'exportedAt', 'oral']);
  if (record.format !== CASE_FILE_FORMAT || record.version !== CASE_FILE_VERSION)
    fail('このアプリの症例ファイルではないか、未対応の版です。');
  validId(record.caseId);
  if (typeof record.exportedAt !== 'string' || !Number.isFinite(Date.parse(record.exportedAt))) fail('書き出し日時が違います。');
  checkOral(record.oral);
  return record;
}

export function encodeCaseTransfer(caseId, oral) {
  // serializeCase の未計測の optional 項目は従来のJSON書き出しと同じく省略する。
  const text = JSON.stringify({ format: CASE_FILE_FORMAT, version: CASE_FILE_VERSION,
    caseId: caseId.trim(), exportedAt: new Date().toISOString(), oral }, null, 2);
  decodeCaseTransfer(text);
  return text;
}

export function decodeCaseTransfer(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > CASE_FILE_LIMIT)
    fail('ファイルが2MBを超えています。');
  let record;
  try { record = JSON.parse(text); } catch { fail('JSON形式を確認してください。'); }
  return validateCaseTransfer(record);
}

export function caseTransferFilename(caseId) {
  const safe = caseId.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80);
  return `oral_case_${safe}_${new Date().toISOString().slice(0, 10)}.json`;
}
