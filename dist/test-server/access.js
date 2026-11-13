// This is a preview entry screen on GitHub Pages, separate from dashboard administration.
const sessionKey = 'cvml-gpu-timeline.test-preview.v1';
const codeDigest = '0927a0c81213ef0edd8c33cb3046bf366f80bfe674a15d3ecad347edd5a686ce';
const form = document.getElementById('preview-access');
const previewURL = new URL('./preview.html', import.meta.url);
const entryURL = new URL('./', import.meta.url);
const anchors = new Set(['now','timeline','resources','servers','parcel','more','release-video','api-usage-board']);

if (form) {
  const field = document.getElementById('preview-code');
  const username = document.getElementById('preview-name');
  const error = document.getElementById('preview-error');
  const submit = form.querySelector('button');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const input = field.value;
      const name = username.value.trim();
      if (!name) { username.focus(); return; }
      const bytes = new TextEncoder().encode(input);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== codeDigest) {
        field.value = '';
        field.setAttribute('aria-invalid', 'true');
        error.textContent = '비밀번호가 맞지 않아요.';
        field.focus();
        return;
      }
      sessionStorage.setItem(sessionKey, 'entered');
      sessionStorage.setItem('cvml.test.username', name);
      try { const history = JSON.parse(localStorage.getItem('cvml.test.login-log') || '[]'); history.push({name, at:new Date().toISOString()}); localStorage.setItem('cvml.test.login-log', JSON.stringify(history.slice(-100))); } catch {}
      field.value = '';
      const anchor = new URLSearchParams(location.search).get('panel');
      if (anchors.has(anchor)) previewURL.hash = anchor;
      location.assign(previewURL.href);
    } catch {
      error.textContent = '테스트 화면을 열 수 없어요. 브라우저 설정을 확인해 주세요.';
    } finally {
      submit.disabled = false;
    }
  });
  field.addEventListener('input', () => {
    field.removeAttribute('aria-invalid');
    error.textContent = '';
  });
  field.disabled = false;
  submit.disabled = false;
} else {
  let entered = false;
  try { entered = sessionStorage.getItem(sessionKey) === 'entered'; } catch {}
  if (!entered) {
    const anchor = location.hash.slice(1);
    if (anchors.has(anchor)) entryURL.searchParams.set('panel', anchor);
    location.replace(entryURL.href);
  } else {
    document.querySelector('main').hidden = false;
    await Promise.all([
      import('./kimi-tribute.js?v=2.1-kimi'),
      import('../promo.js?patch=closed-panels'),
      import('../usage.js'),
      import('./app.js?patch=snapshot3-1'),
      import('./research.js?v=3.0-snapshot2a'),
    ]);
  }
}
