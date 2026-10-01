/**
 * shared/js/case-store.js
 * 症例（患者ごとのシミュレーションデータ）の端末内保存。
 *
 * 顔貌シミュレーション（face）と口腔内シミュレーション（oral）の両方が
 * 同じ症例レコードを読み書きできるようにするための共通ストア。
 * 将来この2つを統合ソフトにまとめる際、この層がそのままデータの受け渡しになる。
 *
 * レコード構造:
 *   {
 *     id: string,            // 症例ID（患者ID等。端末内でユニーク）
 *     name: string,          // 表示名（イニシャル等。実名の入力は推奨しない）
 *     updatedAt: number,     // 更新時刻(ms)
 *     face: { ... } | null,  // 顔貌シミュレータの状態（治療ID・パラメータ・写真）
 *     oral: { ... } | null,  // 口腔内シミュレータの状態（計測値・プラン・写真）
 *     link: {                // モジュール間で受け渡す共通の臨床数値
 *       u1retract, l1retract,   // 前歯後退量(mm) 口腔内 → 顔貌
 *       mxAdvance, mxImpaction, mdSetback,  // 手術移動量(mm)
 *       source, updatedAt
 *     } | null
 *   }
 *
 * すべて端末内（IndexedDB）に保存され、外部サーバーへは送信しない。
 */

const DB_NAME = 'ozaki-sim-cases';
const DB_VERSION = 1;
const STORE = 'cases';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('この端末では症例の保存機能を利用できません。'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** 症例一覧（更新が新しい順） */
export async function listCases() {
  const all = await tx('readonly', (store) => store.getAll());
  const rows = Array.isArray(all) ? all : [];
  return rows
    .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt, hasFace: !!r.face, hasOral: !!r.oral }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 症例を1件取得（無ければ null） */
export async function getCase(id) {
  const rec = await tx('readonly', (store) => store.get(id));
  return rec ?? null;
}

/**
 * モジュール単位で症例を保存する。既存レコードがあればマージする。
 * @param {string} id
 * @param {'face'|'oral'} module
 * @param {object} data
 * @param {{name?: string, link?: object}} [meta]
 */
export async function saveCaseModule(id, module, data, meta = {}) {
  const existing = (await getCase(id)) ?? { id, name: id, face: null, oral: null, link: null };
  const rec = {
    ...existing,
    id,
    name: meta.name ?? existing.name ?? id,
    [module]: data,
    updatedAt: Date.now(),
  };
  if (meta.link) {
    rec.link = { ...(existing.link ?? {}), ...meta.link, source: module, updatedAt: Date.now() };
  }
  await tx('readwrite', (store) => store.put(rec));
  return rec;
}

/** 症例を削除する */
export async function deleteCase(id) {
  await tx('readwrite', (store) => store.delete(id));
}
