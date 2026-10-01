/**
 * viewer3d.js
 * 口腔内3Dモデル（上下顎の歯列＋歯肉）のビューア。
 *
 * 座標系（mm）: +x 患者の左 / +y 上方 / +z 前方
 * 既定のカメラは +z 側（正面）にあり、モデル側を回転させて視点を変える。
 * スマートフォン・iPad ではドラッグ回転／ピンチズーム、
 * PC ではドラッグ回転／ホイールズームで操作する。
 * 歯をタップ（クリック）すると onPick(FDI 番号) が呼ばれる（歯ごとの手直し用）。
 */

import * as THREE from '../../vendor/three.module.min.js';
import { applyMorph, morphPhases } from './reconstruct3d.js';

/**
 * 指・マウスがこれ未満しか動かなければ「タップ」とみなす(px)。
 * 回転のドラッグと区別するため。指先の震えでも数 px は動くので 0 にはしない。
 */
const PICK_SLOP_PX = 6;
/** 選択中の歯の色（頂点色に掛ける）と、わずかな自己発光 */
const HIGHLIGHT_COLOR = 0x7cc4ff;
const HIGHLIGHT_EMISSIVE = 0x0b3a66;

/**
 * プリセット視点。
 * only を持つ視点では、手前に重なってしまう対顎を自動的に隠す
 * （口腔内写真の5枚法と同じ見え方にする）。
 */
const VIEWS = {
  front: { rx: 0, ry: 0, label: '正面' },
  upperOcclusal: { rx: -Math.PI / 2, ry: 0, label: '上顎 咬合面', only: 'upper' },
  lowerOcclusal: { rx: Math.PI / 2, ry: 0, label: '下顎 咬合面', only: 'lower' },
  right: { rx: 0, ry: Math.PI / 2, label: '右側方' },
  left: { rx: 0, ry: -Math.PI / 2, label: '左側方' },
  obliqueR: { rx: -0.35, ry: Math.PI / 4, label: '右斜め' },
  obliqueL: { rx: -0.35, ry: -Math.PI / 4, label: '左斜め' },
};

export class OralViewer3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // 抜歯する歯を歯肉の線で切り取る（reconstruct3d.applyMorph が歯ごとに平面を置く）
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 4000);
    this.pivot = new THREE.Group();
    this.root = new THREE.Group();
    this.pivot.add(this.root);
    this.scene.add(this.pivot);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.4, 1, 1.2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe9f5, 0.75);
    fill.position.set(-0.8, -0.4, 0.6);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(0, -1, -1);
    this.scene.add(rim);
    // 正面やや下からの弱い光。上顎前歯の唇側面は前下方を向くので、上からの
    // 主光源だけでは暗く沈み、ほかの歯より灰色に見えていた。
    const front = new THREE.DirectionalLight(0xfff8f0, 0.45);
    front.position.set(0, -0.25, 1);
    this.scene.add(front);

    this.models = { upper: null, lower: null };
    this.registration = null;
    this.morphT = 1;
    this.showGhost = false;
    this.ghostGroup = new THREE.Group();
    this.root.add(this.ghostGroup);

    this.targetRotY = 0;
    this.targetRotX = -0.25;
    this.cameraDist = 260;
    this.baseDist = 260;
    this.panX = 0;
    this.panY = 0;

    /** 歯がタップされたときに呼ばれる (fdi: number|null) => void */
    this.onPick = null;
    /** 強調表示している歯（FDI 番号）。模型を作り直しても引き継ぐ */
    this.highlightFdi = null;
    this._raycaster = new THREE.Raycaster();

    this._needsRender = true;
    this._bindInput();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this._animate();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.modelSize) this.fitToView();
    this._needsRender = true;
  }

  /**
   * モデルを設定する。
   * @param {{upper?: object, lower?: object}} models buildArchModel の結果
   * @param {object} registration setup.computeSetup の registration
   * @param {{keepView?: boolean}} [opts]
   *   keepView: 視点・拡大率・中心を変えない。歯を 1 本ずつ手直ししているときに
   *   作り直すたび拡大が初期倍率に戻ると、直している歯を見失うため。
   */
  setModels(models, registration, opts = {}) {
    const keepView = !!opts.keepView && !!this.modelSize;
    this.clear();
    this.models = { upper: models.upper ?? null, lower: models.lower ?? null };
    this.registration = registration;
    for (const arch of ['upper', 'lower']) {
      const m = this.models[arch];
      if (m) this.root.add(m.group);
    }
    this._buildGhost();
    if (keepView) this.setMorph(this.morphT);
    else this._frameCamera();
    this._applyHighlight();
    this._needsRender = true;
  }

  /**
   * 歯を強調表示する（null で解除）。
   * 頂点色に淡い青を掛けて色を変える。白い歯冠に自己発光を足すだけだと
   * 明るい面では白飛びして、どの歯を選んだのか見分けにくいため。
   */
  setHighlight(fdi) {
    this.highlightFdi = fdi ?? null;
    this._applyHighlight();
  }

  _applyHighlight() {
    for (const arch of ['upper', 'lower']) {
      for (const tooth of this.models[arch]?.teeth ?? []) {
        const mat = tooth.mesh.material;
        const on = tooth.fdi === this.highlightFdi;
        mat.color?.setHex(on ? HIGHLIGHT_COLOR : 0xffffff);
        mat.emissive?.setHex(on ? HIGHLIGHT_EMISSIVE : 0x000000);
      }
    }
    this._needsRender = true;
  }

  /** 表示中の歯のメッシュ（隠している顎・抜去して消えた歯は除く） */
  _visibleToothMeshes() {
    const out = [];
    for (const arch of ['upper', 'lower']) {
      const m = this.models[arch];
      if (!m || !m.group.visible) continue;
      for (const t of m.teeth) if (t.mesh.visible) out.push(t.mesh);
    }
    return out;
  }

  /**
   * 画面上の点（clientX, clientY）に見えている歯の FDI 番号を返す。なければ null。
   * いま画面に描かれている姿勢（回転のアニメーション途中を含む）で判定する。
   */
  pickTooth(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    this._raycaster.setFromCamera(ndc, this.camera);
    // 歯肉は対象にしない。歯肉の上をタップしても、その奥の歯を選べるほうが使いやすい
    const hits = this._raycaster.intersectObjects(this._visibleToothMeshes(), false);
    for (const h of hits) {
      const m = /^tooth-(\d+)$/.exec(h.object.name);
      if (m) return Number(m[1]);
    }
    return null;
  }

  /**
   * 歯冠の中心が画面上のどこに見えるか（client 座標）。見えている歯でなければ null。
   * 検証スクリプトが「歯の位置をタップする」操作を再現するのに使う。
   */
  toothScreenPoint(fdi) {
    const mesh = this._visibleToothMeshes().find((o) => o.name === `tooth-${fdi}`);
    if (!mesh) return null;
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const c = mesh.geometry.boundingBox.getCenter(new THREE.Vector3())
      .applyMatrix4(mesh.matrixWorld)
      .project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((c.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - c.y) / 2) * rect.height,
    };
  }

  /** Before の姿勢を半透明で重ねるゴーストを作る */
  _buildGhost() {
    this.ghostGroup.clear();
    for (const arch of ['upper', 'lower']) {
      const m = this.models[arch];
      if (!m) continue;
      const g = new THREE.Group();
      g.name = `ghost-${arch}`;
      for (const tooth of m.teeth) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0x6fd4e8, transparent: true, opacity: 0.22,
          roughness: 0.6, depthWrite: false, side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(tooth.mesh.geometry, mat);
        mesh.position.copy(tooth.before.position);
        mesh.quaternion.copy(tooth.before.quaternion);
        g.add(mesh);
      }
      g.visible = this.showGhost;
      this.ghostGroup.add(g);
      const reg = this.registration?.[arch];
      if (reg) { g.position.set(0, reg.y ?? 0, reg.z ?? 0); }
    }
  }

  _frameCamera() {
    // Before と After の両方の姿勢、かつ上下顎の位置合わせ（レジストレーション）を
    // 適用したうえで外接直方体を求める。そうしないと排列後に歯列が枠から外れる。
    const box = new THREE.Box3();
    let any = false;
    // 外接直方体は root のローカル座標で測る。
    // ピボットの回転や前回の中心合わせが入ったまま世界座標で測ると、
    // その中心をローカル座標の位置として入れることになり、
    // 側方観・斜めの視点で歯列が画面の外へずれてしまう。
    const savedRotX = this.pivot.rotation.x;
    const savedRotY = this.pivot.rotation.y;
    const savedRotZ = this.pivot.rotation.z;
    this.pivot.rotation.set(0, 0, 0);
    this.root.position.set(0, 0, 0);
    for (const t of [0, 1]) {
      this.setMorph(t);
      this.root.updateMatrixWorld(true);
      for (const arch of ['upper', 'lower']) {
        const m = this.models[arch];
        if (!m) continue;
        // 見えていないもの（治療後の位置で歯肉の中に沈んで消えた抜歯予定の歯）は
        // 枠に含めない。含めると治療後の表示で歯列が小さく片寄って写る。
        for (const child of m.group.children) {
          if (child.visible) box.expandByObject(child);
        }
        any = true;
      }
    }
    this.setMorph(this.morphT);
    this.pivot.rotation.set(savedRotX, savedRotY, savedRotZ);
    if (!any) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    this.root.position.set(-center.x, -center.y, -center.z);
    this.modelSize = size.clone();
    this.fitToView();
  }

  /**
   * いまの視点で歯列が画面いっぱいに収まるようカメラ距離を決める。
   * 咬合面観では前後径、正面観では左右径が効くため、視点ごとに計算する。
   */
  fitToView() {
    const size = this.modelSize;
    if (!size) return;
    // 目標の回転でモデルの外接直方体を回したときの見かけの幅・高さ
    const e = new THREE.Euler(this.targetRotX, this.targetRotY, 0, 'XYZ');
    const m = new THREE.Matrix4().makeRotationFromEuler(e);
    const half = size.clone().multiplyScalar(0.5);
    const el = m.elements;
    const w = Math.abs(el[0]) * half.x + Math.abs(el[4]) * half.y + Math.abs(el[8]) * half.z;
    const h = Math.abs(el[1]) * half.x + Math.abs(el[5]) * half.y + Math.abs(el[9]) * half.z;
    const aspect = this.camera.aspect || 1;
    const extent = Math.max(2 * h, (2 * w) / aspect, 25);
    this.baseDist = (extent * 1.2) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.cameraDist = this.baseDist;
    this.camera.position.set(0, 0, this.cameraDist);
    this.camera.lookAt(0, 0, 0);
    this._needsRender = true;
  }

  /** 表示の切替 */
  setVisibility({ upper, lower, gingiva, ghost }) {
    if (upper !== undefined && this.models.upper) this.models.upper.group.visible = upper;
    if (lower !== undefined && this.models.lower) this.models.lower.group.visible = lower;
    if (gingiva !== undefined) {
      for (const arch of ['upper', 'lower']) {
        const g = this.models[arch]?.gingiva;
        if (g) g.mesh.visible = gingiva;
      }
    }
    if (ghost !== undefined) {
      this.showGhost = ghost;
      this.ghostGroup.children.forEach((g) => {
        const arch = g.name.replace('ghost-', '');
        g.visible = ghost && (this.models[arch]?.group.visible ?? false);
      });
    }
    this._needsRender = true;
  }

  /** Before(0) ⇄ After(1) のモーフ */
  setMorph(t) {
    this.morphT = t;
    for (const arch of ['upper', 'lower']) {
      const m = this.models[arch];
      if (!m) continue;
      const reg = this.registration?.[arch];
      if (reg) {
        // 歯の移動と同じ進み方（morphPhases.move）で動かす。
        // 抜歯する歯を切り取る平面は世界座標で置くので、歯列の位置を先に決める
        const k = morphPhases(t).move;
        m.group.position.set(
          0,
          lerp(reg.y ?? 0, reg.yAfter ?? 0, k),
          lerp(reg.z ?? 0, reg.zAfter ?? 0, k));
      }
      applyMorph(m, t);
    }
    this._needsRender = true;
  }

  /**
   * プリセット視点に切り替える。
   * @param {string} name
   * @param {{applyVisibility?: boolean}} [opts]
   *   applyVisibility が false のときは対顎の表示状態を変更しない
   * @returns {'upper'|'lower'|null} この視点で単独表示すべき顎
   */
  setView(name, opts = {}) {
    const v = VIEWS[name];
    if (!v) return null;
    this.targetRotX = v.rx;
    this.targetRotY = v.ry;
    this.panX = 0;
    this.panY = 0;
    this.fitToView();
    if (opts.applyVisibility !== false) {
      // 咬合面観では対顎を隠し、それ以外の視点では上下とも表示に戻す
      this.setVisibility({
        upper: v.only ? v.only === 'upper' : true,
        lower: v.only ? v.only === 'lower' : true,
      });
    }
    return v.only ?? null;
  }

  resetZoom() {
    this.cameraDist = this.baseDist;
    this.panX = 0;
    this.panY = 0;
    this._needsRender = true;
  }

  clear() {
    for (const arch of ['upper', 'lower']) {
      const m = this.models[arch];
      if (!m) continue;
      this.root.remove(m.group);
      m.group.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          o.material.dispose();
        }
      });
    }
    this.ghostGroup.clear();
    this.models = { upper: null, lower: null };
    this._needsRender = true;
  }

  /**
   * 描画された画像の 1mm あたりの画素数。
   * 写真に重ねるとき、3D表示の倍率を写真側の倍率に合わせるのに使う。
   */
  pixelsPerMm() {
    const h = this.renderer.domElement.height;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    return (h / 2) / (Math.tan(halfFov) * this.cameraDist);
  }

  /** 回転・ズームのアニメーションを打ち切り、目標の状態を即座に反映する */
  settle() {
    this.pivot.rotation.x = this.targetRotX;
    this.pivot.rotation.y = this.targetRotY;
    this.camera.position.set(this.panX, this.panY, this.cameraDist);
    this.camera.lookAt(this.panX, this.panY, 0);
    this._needsRender = true;
  }

  /**
   * 現在の表示を canvas として取り出す（比較画像・重ね合わせ用）。
   * アニメーションの途中の姿勢が写らないよう、先に目標の状態へ確定させる。
   */
  snapshot() {
    this.settle();
    // 選択中の歯の色は操作のための目印なので、比較画像・写真への重ね合わせには写さない
    const highlighted = this.highlightFdi;
    if (highlighted != null) this.setHighlight(null);
    this.renderer.render(this.scene, this.camera);
    if (highlighted != null) this.setHighlight(highlighted);
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#16212b';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    return out;
  }

  _bindInput() {
    const el = this.renderer.domElement;
    const pointers = new Map();
    let lastPinch = 0;
    let lastMid = null;
    // タップ判定中の指（マウス）。動いた・2 本目の指が触れた時点で取り消す。
    // 回転のドラッグはこれまでどおり pointermove で行い、指を離したときに
    // ほとんど動いていなければ「歯を選ぶタップ」として扱う。
    let tap = null;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const primary = e.pointerType !== 'mouse' || e.button === 0;
      tap = pointers.size === 1 && primary
        ? { id: e.pointerId, x: e.clientX, y: e.clientY }
        : null;
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      if (tap && tap.id === e.pointerId
          && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= PICK_SLOP_PX) {
        tap = null;
      }
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        this.targetRotY += (e.clientX - prev.x) * 0.009;
        this.targetRotX += (e.clientY - prev.y) * 0.009;
        this.targetRotX = Math.max(-1.75, Math.min(1.75, this.targetRotX));
        this._needsRender = true;
      } else if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        if (lastPinch > 0) {
          this.cameraDist *= lastPinch / dist;
          this._clampZoom();
        }
        if (lastMid) {
          const k = this.cameraDist * 0.0016;
          this.panX -= (mid.x - lastMid.x) * k;
          this.panY += (mid.y - lastMid.y) * k;
          this._needsRender = true;
        }
        lastPinch = dist;
        lastMid = mid;
      }
    });
    const release = (e) => {
      const isTap = e.type === 'pointerup' && tap && tap.id === e.pointerId
        && pointers.size === 1
        && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < PICK_SLOP_PX;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { lastPinch = 0; lastMid = null; }
      if (pointers.size === 0) tap = null;
      if (isTap && this.onPick) this.onPick(this.pickTooth(e.clientX, e.clientY));
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cameraDist *= e.deltaY > 0 ? 1.08 : 0.93;
      this._clampZoom();
    }, { passive: false });
    el.addEventListener('dblclick', () => this.resetZoom());
  }

  _clampZoom() {
    this.cameraDist = Math.max(this.baseDist * 0.25, Math.min(this.baseDist * 4, this.cameraDist));
    this._needsRender = true;
  }

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    const ry = this.pivot.rotation.y;
    const rx = this.pivot.rotation.x;
    const nry = ry + (this.targetRotY - ry) * 0.22;
    const nrx = rx + (this.targetRotX - rx) * 0.22;
    const cz = this.camera.position.z;
    const ncz = cz + (this.cameraDist - cz) * 0.25;
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const ncx = cx + (this.panX - cx) * 0.25;
    const ncy = cy + (this.panY - cy) * 0.25;
    if (
      Math.abs(nry - ry) > 1e-5 || Math.abs(nrx - rx) > 1e-5 ||
      Math.abs(ncz - cz) > 1e-3 || Math.abs(ncx - cx) > 1e-3 ||
      Math.abs(ncy - cy) > 1e-3 || this._needsRender
    ) {
      this.pivot.rotation.y = nry;
      this.pivot.rotation.x = nrx;
      this.camera.position.set(ncx, ncy, ncz);
      this.camera.lookAt(ncx, ncy, 0);
      this.renderer.render(this.scene, this.camera);
      this._needsRender = false;
    }
  }
}

const lerp = (a, b, t) => a + (b - a) * t;

export { VIEWS };
