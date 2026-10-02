/**
 * shared/js/camera.js
 * 写真の撮影。撮影の手段は環境によって2通りある。
 *
 * 1. getUserMedia によるアプリ内カメラ
 *    プレビューを見ながら撮れる。前後カメラの切替もできる。
 *    ただし HTTPS（または localhost）が必要で、
 *    iframe に埋め込まれている場合は許可されないことがある。
 *
 * 2. 端末標準のカメラアプリ（input[capture]）
 *    対応する端末では標準カメラが開く（ブラウザにより写真選択になる）。
 *    ピント・露出・前後切替は端末のカメラアプリ側で行う。
 *
 * 2 はクリック操作の中で直接呼ぶ。1 の許可待ちの後に呼ぶと
 * ユーザー操作として認識されず、ブラウザにブロックされることがある。
 */

import { toCanvas, loadImageFile } from './imaging.js';

export class CameraCapture {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {{facing?: 'user'|'environment'}} [opts]
   */
  constructor(videoEl, opts = {}) {
    this.video = videoEl;
    this.facing = opts.facing ?? 'environment';
    this.stream = null;
    this.generation = 0;
  }

  get isActive() { return this.stream !== null; }

  /** カメラを起動する。失敗時は例外を投げる。 */
  async start() {
    this.stop();
    const generation = this.generation;
    if (!streamSupported()) {
      const err = new Error('この環境ではアプリ内カメラを利用できません。');
      err.name = 'NotSupportedError';
      throw err;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: this.facing,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    // インカメラはプレビューが鏡像のほうが自然なので、表示だけ左右反転する
    this.video.style.transform = this.facing === 'user' ? 'scaleX(-1)' : '';
    try {
      await this.video.play();
    } catch (err) {
      if (generation !== this.generation) return false;
      this.stop();
      throw err;
    }
    return generation === this.generation;
  }

  /** 前後カメラを切り替えて再起動する */
  async toggleFacing() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    await this.start();
  }

  /**
   * 現在のフレームを canvas として取得する。
   *
   * インカメラの映像が鏡像で届くかどうかは端末・ブラウザによって異なるため、
   * ここでは「インカメラなら鏡像だろう」という一般的な想定で戻しておき、
   * 確定はしない（mirrorCertain: false）。実際の左右は、複数方向の写真を
   * 当てはめるときに画像の内容から判定して自動で直す。
   *
   * @param {number} maxSize
   * @returns {{canvas: HTMLCanvasElement, facing: string, mirrorCertain: boolean}|null}
   */
  grab(maxSize = 1600) {
    if (!this.video.videoWidth) return null;
    const front = this.facing === 'user';
    return {
      canvas: toCanvas(this.video, maxSize, { flipX: front }),
      facing: this.facing,
      mirrorCertain: !front,   // 外カメラは鏡像にならないので確定
    };
  }

  stop() {
    this.generation++;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }
}

/** アプリ内カメラ（getUserMedia）が使える環境か */
export function streamSupported() {
  return !!(globalThis.navigator?.mediaDevices?.getUserMedia)
    && (globalThis.isSecureContext ?? true);
}

/** 旧名（互換のため残す） */
export const cameraAvailable = streamSupported;

/** iPad のデスクトップ表示も含め、タッチ端末では標準カメラを優先する。 */
export function preferDeviceCamera() {
  const nav = globalThis.navigator;
  return /Android|iPhone|iPad|iPod/i.test(nav?.userAgent ?? '')
    || (/Mac/i.test(nav?.platform ?? '') && nav?.maxTouchPoints > 1);
}

const pendingCaptures = new WeakMap();
export function cancelDeviceCamera(input) {
  if (input) pendingCaptures.get(input)?.();
}

/**
 * 端末標準のカメラアプリで1枚撮る。
 * 撮影専用の input を使い、ユーザーのクリックから同期的に呼ぶ。
 * capture は端末へのヒント。カメラの対応は端末・ブラウザによる。
 *
 * @param {HTMLInputElement} input 撮影に使う file input（再利用する）
 * @param {'user'|'environment'} facing 最初に開くカメラ（端末側で切替可）
 * @param {number} maxSize
 * @returns {Promise<{canvas, facing, mirrorCertain}|null>} キャンセル時は null
 */
export function captureWithDeviceCamera(input, facing = 'user', maxSize = 1600) {
  cancelDeviceCamera(input);
  return new Promise((resolve, reject) => {
    input.setAttribute('capture', facing);
    input.value = '';

    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      input.removeAttribute('capture');
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      pendingCaptures.delete(input);
      input.value = '';
      if (error) reject(error);
      else resolve(value);
    };
    const onCancel = () => finish(null);

    const onChange = async () => {
      const file = input.files?.[0];
      if (!file) { finish(null); return; }
      try {
        const img = await loadImageFile(file);
        finish({
          canvas: toCanvas(img, maxSize),
          facing,
          // 端末のカメラアプリが鏡像で保存するかは機種・設定によるため確定しない
          mirrorCertain: false,
        });
      } catch (err) {
        finish(null, err);
      }
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    pendingCaptures.set(input, onCancel);
    // focus は写真が届く前にも発火するため、キャンセル判定には使わない。
    try { input.click(); } catch (err) { finish(null, err); }
  });
}
