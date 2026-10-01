// 写真・症例には触れず、インストールとアプリ本体の更新だけを扱う。
const button = document.getElementById('install-app');
const help = document.getElementById('install-help');
let prompt;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (standalone()) help.hidden = true;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  prompt = e;
  button.hidden = false;
});
button.addEventListener('click', async () => {
  if (!prompt) return;
  const request = prompt;
  prompt = null;
  button.hidden = true;
  try { await request.prompt(); await request.userChoice; } catch { help.open = true; }
});
window.addEventListener('appinstalled', () => { help.hidden = true; prompt = null; });

if ('serviceWorker' in navigator && window.isSecureContext) {
  let applying = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applying) location.reload(); // 編集中の写真を自動更新で失わない
  });
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(reg => {
    const notice = document.getElementById('app-update');
    const show = () => { if (reg.waiting && navigator.serviceWorker.controller) notice.hidden = false; };
    show();
    reg.addEventListener('updatefound', () => {
      reg.installing?.addEventListener('statechange', show);
    });
    document.getElementById('update-app').addEventListener('click', () => {
      if (!reg.waiting) return;
      if (!confirm('症例を保存しましたか？ 更新すると写真の選び直しが必要です。')) return;
      applying = true;
      reg.waiting.postMessage({ type: 'APPLY_UPDATE' });
    });
  }).catch(() => { /* キャッシュ不可でも通常のオンラインアプリとして動かす */ });
}
