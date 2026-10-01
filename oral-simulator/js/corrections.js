// 写真は保存せず、画像の識別値と境界座標だけを症例に含める。
// SHA-256は照合用であり、写真の匿名化・暗号化を意味しない。
// 2: 弧長を「弧長等間隔で取り直して平滑化した中心線」に沿って測るよう変更
//    （segmentation.smoothByArc）。境界の弧長座標が変わるため、版1の補正は適用しない。
//
// 歯ごとの手直し（toothAdjust: { fdi: {labial, distal, rotate, extrude} }）も
// 境界と同じく「同じ写真のときだけ」戻す。写真の読み違いを直したものなので、
// 別の写真（別の患者・撮り直し）に持ち越すと、正しく写った歯を壊してしまう。
// 手直しは記録に足すだけの任意項目で、座標系も変わらないため版は上げない
// （手直しのない旧記録もそのまま使える）。
import { sanitizeArchAdjust, sanitizeToothAdjust, countAdjusted } from './tooth-adjust.js';

export const CORRECTION_VERSION = 2;

export async function imageFingerprint(canvas) {
  if (!globalThis.crypto?.subtle) return null;
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const hash = await crypto.subtle.digest('SHA-256', pixels);
  return `${canvas.width}x${canvas.height}:` + [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} [toothAdjust] その顎の歯ごとの手直し（{ fdi: adjust }）。あれば記録に含める
 */
export function captureCorrection(detection, handles, fingerprint, transform, image, toothAdjust = null) {
  if (!detection || !handles || !fingerprint || !image) return null;
  const record = {
    version: CORRECTION_VERSION, fingerprint,
    width: image.width, height: image.height,
    transform: { rotate: transform.rotate, flip: transform.flip },
    handles: structuredClone(handles),
    sides: Object.fromEntries(['R', 'L'].map(side => [side, {
      positions: [...detection.sides[side].positions], bounds: [...detection.sides[side].bounds],
    }])),
  };
  const adjust = sanitizeArchAdjust(toothAdjust, detection.arch);
  if (Object.keys(adjust).length) record.toothAdjust = adjust;
  return record;
}

export function matchesCorrection(record, fingerprint, positions) {
  if (!record || record.version !== CORRECTION_VERSION || !fingerprint
      || record.fingerprint !== fingerprint) return false;
  if (![0, 90, 180, 270].includes(record.transform?.rotate)
      || typeof record.transform?.flip !== 'boolean') return false;
  return ['R', 'L'].every(s => JSON.stringify(record.sides?.[s]?.positions) === JSON.stringify(positions[s]));
}

// 不正・古い座標は部分適用しない。検出した帯の範囲と単調性も確認する。
export function validCorrection(record, image, detection = null) {
  if (!record || !image) return false;
  if (record.width !== image.width || record.height !== image.height) return false;
  if (!['mid', 'right', 'left'].every(key => {
    const h = record.handles?.[key];
    return h && Number.isFinite(h.x) && Number.isFinite(h.y)
      && h.x >= 0 && h.y >= 0 && h.x < image.width && h.y < image.height;
  })) return false;
  if (!detection) return true;
  return ['R', 'L'].every(side => {
    const b = record.sides?.[side]?.bounds;
    const sign = side === 'R' ? -1 : 1;
    const limit = Math.max(...detection.unrolled.samples.map(s => s.s * sign));
    return Array.isArray(b) && b.length === detection.sides[side].positions.length + 1
      && b.every((v, i) => Number.isFinite(v) && v >= 0 && v <= limit + 1
        && (i === 0 || v >= b[i - 1] + 1));
  }) && record.sides.R.bounds[0] === record.sides.L.bounds[0];
}

/**
 * 照合済みの補正記録から、その顎の歯ごとの手直しを取り出す。
 * 値は検証し、範囲外は上限で切る（壊れた記録で歯列が壊れないように）。
 * 記録に手直しがない（旧版の保存データ）ときは空を返す。
 */
export function restoreToothAdjust(record, arch) {
  return sanitizeArchAdjust(record?.toothAdjust, arch);
}

// ---------------------------------------------------------------------------
// スマートフォン撮影モード用
//
// 咬合面観がないモードでは歯列は標準形から組み立てるため、境界の補正は無い。
// 歯ごとの手直しは、必須の写真である正面の写真に結び付けて保存する。
// ---------------------------------------------------------------------------

/** 正面の写真に結び付けた手直しの記録。手直しが無ければ null */
export function captureAdjustRecord(fingerprint, toothAdjust) {
  if (!fingerprint) return null;
  const adjust = sanitizeToothAdjust(toothAdjust);
  if (!countAdjusted(adjust)) return null;
  return { version: CORRECTION_VERSION, kind: 'toothAdjust', fingerprint, toothAdjust: adjust };
}

export function matchesAdjustRecord(record, fingerprint) {
  return !!record && record.kind === 'toothAdjust' && record.version === CORRECTION_VERSION
    && !!fingerprint && record.fingerprint === fingerprint;
}
