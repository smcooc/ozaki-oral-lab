/**
 * shared/js/sync.js
 * 統合ハブ（ルートの index.html）と各シミュレータの間で、
 * 症例IDと Before⇄After のスライダー位置を同期するための小さな仕組み。
 *
 * ハブは顔貌・口腔内の2つを <iframe> で並べて表示し、
 * どちらかのスライダーを動かすと、もう一方も同じ値で動く。
 * 単独で開いたときは何も起きない（親がいなければ送信も受信もしない）。
 */

const CHANNEL = 'ozaki-sim';

/** ハブの中（iframe）で動いているか */
export function isEmbedded() {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

/**
 * ハブ（親フレーム）へメッセージを送る。
 * @param {string} type 'morph' | 'ready' | 'case'
 * @param {object} payload
 */
export function postToHub(type, payload = {}) {
  if (!isEmbedded()) return;
  try {
    window.parent.postMessage({ channel: CHANNEL, type, ...payload }, window.location.origin);
  } catch { /* 送信できない環境では何もしない */ }
}

/**
 * ハブ（または他フレーム）からのメッセージを受け取る。
 * @param {(type: string, payload: object) => void} handler
 */
export function onHubMessage(handler) {
  window.addEventListener('message', (ev) => {
    if (ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.channel !== CHANNEL || typeof d.type !== 'string') return;
    handler(d.type, d);
  });
}

/** ハブ側: 配下の iframe すべてへ送る */
export function broadcast(frames, type, payload = {}) {
  for (const frame of frames) {
    try {
      frame.contentWindow?.postMessage(
        { channel: CHANNEL, type, ...payload }, window.location.origin);
    } catch { /* 読み込み前などは無視 */ }
  }
}

/** URL の ?case=... から症例IDを取り出す */
export function caseIdFromUrl() {
  try {
    return new URL(window.location.href).searchParams.get('case') ?? '';
  } catch {
    return '';
  }
}
