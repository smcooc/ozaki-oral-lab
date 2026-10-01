/**
 * shared/js/ui.js
 * 顔貌／口腔内シミュレータ共通の小さなUI部品。
 */

export const $ = (id) => document.getElementById(id);

/** 数値スライダー行を生成する */
export function makeSlider(def, onChange) {
  const row = document.createElement('div');
  row.className = 'param-row';
  const label = document.createElement('label');
  const valEl = document.createElement('span');
  valEl.className = 'param-val';
  // step の刻みに合わせて小数桁を決める（0.5 刻みなら小数1桁）
  const decimals = (String(def.step).split('.')[1] ?? '').length;
  const fmt = (v) =>
    `${def.format ? def.format(v) : Number(v).toFixed(decimals)}${def.unit ?? ''}`;
  valEl.textContent = fmt(def.value);
  label.append(document.createTextNode(def.label), valEl);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = def.min;
  input.max = def.max;
  input.step = def.step;
  input.value = def.value;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    valEl.textContent = fmt(v);
    onChange(v);
  });

  row.append(label, input);
  row.setValue = (v) => {
    input.value = v;
    valEl.textContent = fmt(v);
  };
  return row;
}

/** ステータス表示 */
export function setStatus(el, kind, text) {
  if (!el) return;
  el.hidden = false;
  el.className = `status ${kind}`;
  el.textContent = text;
}

/** カードの有効・無効を切り替える */
export function setEnabled(el, on) {
  if (el) el.classList.toggle('is-disabled', !on);
}

/** タブ切り替えを配線する。onChange(tabId) が呼ばれる。 */
export function bindTabs(root, onChange) {
  const tabs = Array.from(root.querySelectorAll('.tab'));
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      root.querySelectorAll('.tab-body').forEach((b) => {
        b.hidden = b.id !== tab.dataset.tab;
      });
      onChange(tab.dataset.tab);
    });
  });
}

/** 次のフレームまで待つ（重い処理の前にUIを更新させる） */
export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

/**
 * 長い計算の途中で画面を固まらせないための「息継ぎ」関数を作る。
 *
 * 毎回 requestAnimationFrame を待つと呼び出し回数だけ待たされるので、
 * 前回から `everyMs` 以上たったときだけ制御を返す。
 * また、タブが裏に回っているときは requestAnimationFrame が止まる（または
 * 大きく間引かれる）ので、そのときは待たずに計算を続ける。
 *
 * @param {number} [everyMs] 息継ぎの間隔(ms)
 */
export function makeYielder(everyMs = 120) {
  let last = performance.now();
  return async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = performance.now();
    if (now - last < everyMs) return;
    await nextFrame();
    last = performance.now();
  };
}

/** mm 表記（符号付き） */
export function mm(v, digits = 1) {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}
