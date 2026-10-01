/**
 * stl.js
 * 3D モデルをバイナリ STL として書き出す。
 *
 * 口腔内スキャナが出力する STL と同じ形式なので、模型のCAD/CAM、
 * 3Dプリント（セットアップ模型・アライナーのモデル）、
 * 他の矯正用ソフトウェアへの取り込みに利用できる。
 * 単位は mm（STL に単位の定義はないが、矯正用ソフトの慣例に合わせる）。
 */

import * as THREE from '../../vendor/three.module.min.js';

/**
 * Object3D 以下のメッシュを走査して三角形を集める。
 * @param {THREE.Object3D} root
 * @param {(mesh: THREE.Mesh) => boolean} [filter]
 * @returns {{positions: Float32Array, count: number}}
 */
function collectTriangles(root, filter) {
  root.updateMatrixWorld(true);
  const tris = [];
  const v = new THREE.Vector3();
  root.traverse((obj) => {
    if (!obj.isMesh || obj.visible === false) return;
    if (filter && !filter(obj)) return;
    const geom = obj.geometry;
    const pos = geom.getAttribute('position');
    if (!pos) return;
    const index = geom.getIndex();
    const n = index ? index.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      for (let k = 0; k < 3; k++) {
        const idx = index ? index.getX(i + k) : i + k;
        v.fromBufferAttribute(pos, idx).applyMatrix4(obj.matrixWorld);
        tris.push(v.x, v.y, v.z);
      }
    }
  });
  return { positions: new Float32Array(tris), count: tris.length / 9 };
}

/**
 * バイナリ STL の Blob を作る。
 * @param {THREE.Object3D} root
 * @param {{filter?: Function, header?: string}} [opts]
 */
export function exportStl(root, opts = {}) {
  const { positions, count } = collectTriangles(root, opts.filter);
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 80バイトのヘッダ（ASCII）
  const header = (opts.header ?? 'Ozaki Ortho oral simulator STL (mm)').slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, count, true);

  let off = 84;
  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    ax.set(positions[i], positions[i + 1], positions[i + 2]);
    bx.set(positions[i + 3], positions[i + 4], positions[i + 5]);
    cx.set(positions[i + 6], positions[i + 7], positions[i + 8]);
    ab.subVectors(bx, ax);
    ac.subVectors(cx, ax);
    nrm.crossVectors(ab, ac);
    if (nrm.lengthSq() > 1e-12) nrm.normalize(); else nrm.set(0, 0, 1);

    view.setFloat32(off, nrm.x, true); off += 4;
    view.setFloat32(off, nrm.y, true); off += 4;
    view.setFloat32(off, nrm.z, true); off += 4;
    for (const p of [ax, bx, cx]) {
      view.setFloat32(off, p.x, true); off += 4;
      view.setFloat32(off, p.y, true); off += 4;
      view.setFloat32(off, p.z, true); off += 4;
    }
    view.setUint16(off, 0, true); off += 2;
  }
  return { blob: new Blob([buffer], { type: 'model/stl' }), triangles: count };
}

/**
 * 歯列モデルの Before / After を STL 化する。
 * @param {object} model buildArchModel の結果
 * @param {'before'|'after'} phase
 * @param {{includeGingiva?: boolean, includeExtracted?: boolean}} [opts]
 */
export function exportArchStl(model, phase, opts = {}) {
  const includeGingiva = opts.includeGingiva !== false;
  const saved = [];
  // 指定した姿勢に一時的に設定してから書き出す
  for (const tooth of model.teeth) {
    saved.push({
      mesh: tooth.mesh,
      position: tooth.mesh.position.clone(),
      quaternion: tooth.mesh.quaternion.clone(),
      visible: tooth.mesh.visible,
    });
    const target = phase === 'after' ? tooth.after : tooth.before;
    tooth.mesh.position.copy(target.position);
    tooth.mesh.quaternion.copy(target.quaternion);
    tooth.mesh.visible = !(phase === 'after' && tooth.extracted)
      && !(opts.includeExtracted === false && tooth.extracted);
  }
  const gm = model.gingiva?.mesh;
  const gVisible = gm?.visible;
  if (gm) gm.visible = includeGingiva;

  const result = exportStl(model.group, {
    header: `Ozaki Ortho oral simulator ${phase} (mm)`,
  });

  for (const s of saved) {
    s.mesh.position.copy(s.position);
    s.mesh.quaternion.copy(s.quaternion);
    s.mesh.visible = s.visible;
  }
  if (gm) gm.visible = gVisible;
  return result;
}
