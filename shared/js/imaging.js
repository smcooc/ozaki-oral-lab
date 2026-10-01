/**
 * shared/js/imaging.js
 * 画像の読み込み・縮小・色空間変換など、顔貌／口腔内の両シミュレータで共通の画像処理。
 */

/** File / Blob から HTMLImageElement を読み込む */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/**
 * 画像・動画・キャンバスを最大辺 maxSize に収まるよう縮小した canvas を返す。
 * @param {CanvasImageSource} source
 * @param {number} maxSize 最大辺(px)
 * @param {{flipX?: boolean, rotate?: number}} [opts] rotate は 0/90/180/270
 */
export function toCanvas(source, maxSize, opts = {}) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const rot = ((opts.rotate ?? 0) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;

  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  if (opts.flipX) ctx.scale(-1, 1);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.restore();
  return canvas;
}

/** canvas から ImageData を取り出す */
export function getImageData(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
}

/** 輝度（ITU-R BT.601） */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Otsu法で 0-255 のスコア配列に対するしきい値を求める。
 * @param {Uint8ClampedArray|Uint8Array} scores
 * @returns {number} 0-255 のしきい値
 */
export function otsuThreshold(scores) {
  const hist = new Float64Array(256);
  for (let i = 0; i < scores.length; i++) hist[scores[i]]++;
  const total = scores.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

/** canvas を PNG として保存する */
export function downloadCanvas(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { resolve({ ok: false, code: 'bad_request' }); return; }
      resolve(await downloadBlob(blob, filename));
    }, 'image/png');
  });
}

// Artifact として配信されている場合、ページは自分でファイルを保存できず、
// ホスト側の保存機能（claude.use('downloads')）を通す必要がある。
// 通常の Web 配信（院内サーバー・GitHub Pages など）では window.claude が
// 存在しないので、従来どおりリンクで保存する。
let downloadsHost;
async function getDownloadHost() {
  if (downloadsHost !== undefined) return downloadsHost;
  downloadsHost = null;
  try {
    if (globalThis.claude?.use) downloadsHost = await globalThis.claude.use('downloads');
  } catch { downloadsHost = null; }
  return downloadsHost;
}

/**
 * Blob を保存する。
 * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
 *   ok=false のときは code に理由が入る（呼び出し側で利用者に伝える）
 */
export async function downloadBlob(blob, filename) {
  const host = await getDownloadHost();
  if (host) {
    try {
      await host.save({ filename, data: blob });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err?.code ?? 'unavailable', message: err?.message ?? '' };
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true };
}
