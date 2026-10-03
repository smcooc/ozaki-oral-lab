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

// インストール案内はホーム画面起動時に隠れるため、更新確認は独立して置く。
const updatePanel = document.createElement('div');
updatePanel.id = 'app-update-check';
updatePanel.className = 'install-panel';
const checkButton = document.createElement('button');
checkButton.id = 'check-app-update';
checkButton.type = 'button';
checkButton.className = 'btn';
checkButton.textContent = '更新を確認';
const updateStatus = document.createElement('p');
updateStatus.id = 'update-check-status';
updateStatus.className = 'hint';
updateStatus.setAttribute('role', 'status');
updateStatus.setAttribute('aria-live', 'polite');
updateStatus.textContent = '修正版があるか確認できます。確認だけでは写真は消えません。';
checkButton.setAttribute('aria-describedby', updateStatus.id);
updatePanel.append(checkButton, updateStatus);
help.after(updatePanel);

if ('serviceWorker' in navigator && window.isSecureContext) {
  let applying = false;
  let registrationPromise;
  const watched = new WeakSet();
  const notice = document.getElementById('app-update');
  const showAvailable = reg => {
    const available = !!reg.waiting && !!navigator.serviceWorker.controller;
    if (available) {
      notice.hidden = false;
      updateStatus.textContent = '新しい版があります。症例を保存してから「保存後に更新する」を押してください。';
    }
    return available;
  };
  const getRegistration = () => {
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(reg => {
        if (!watched.has(reg)) {
          watched.add(reg);
          reg.addEventListener('updatefound', () => {
            reg.installing?.addEventListener('statechange', () => showAvailable(reg));
          });
          reg.installing?.addEventListener('statechange', () => showAvailable(reg));
        }
        showAvailable(reg);
        return reg;
      }).catch(error => {
        registrationPromise = null; // 一時的な通信失敗後も、ボタンで再試行できる。
        throw error;
      });
    }
    return registrationPromise;
  };
  const waitForInstall = worker => new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', changed);
      if (error) reject(error); else resolve();
    };
    const changed = () => {
      if (worker.state === 'installed' || worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('update install failed'));
    };
    const timer = setTimeout(() => finish(new Error('update install timeout')), 30000);
    worker.addEventListener('statechange', changed);
    changed();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applying) location.reload(); // 編集中の写真を自動更新で失わない
  });
  getRegistration().catch(() => {
    updateStatus.textContent = '更新をまだ確認できていません。通信できる状態で「更新を確認」を押してください。';
  });
  checkButton.addEventListener('click', async () => {
    if (checkButton.disabled) return;
    if (navigator.onLine === false) {
      updateStatus.textContent = 'オフラインです。インターネットにつないでから、もう一度「更新を確認」を押してください。';
      return;
    }
    checkButton.disabled = true;
    updatePanel.setAttribute('aria-busy', 'true');
    updateStatus.textContent = '新しい版があるか確認しています…';
    try {
      const reg = await getRegistration();
      // 既に取得できた更新は、通信が途切れても案内できる。
      if (showAvailable(reg)) return;
      await reg.update();
      if (reg.installing) await waitForInstall(reg.installing);
      if (!showAvailable(reg)) updateStatus.textContent = '現在公開されている最新版です。そのままお使いください。';
    } catch {
      updateStatus.textContent = '更新を確認できませんでした。通信状態を確認して、もう一度押してください。写真はそのまま残っています。';
    } finally {
      checkButton.disabled = false;
      updatePanel.removeAttribute('aria-busy');
    }
  });
  document.getElementById('update-app').addEventListener('click', async () => {
    let reg;
    try { reg = await getRegistration(); } catch { return; }
    if (!reg.waiting) return;
    if (!confirm('症例を保存しましたか？ 更新すると写真の選び直しが必要です。')) return;
    applying = true;
    reg.waiting.postMessage({ type: 'APPLY_UPDATE' });
  });
} else {
  checkButton.disabled = true;
  updateStatus.textContent = 'このブラウザでは更新確認を利用できません。最新版を使うには、インターネットにつないでアプリを開き直してください。';
}
