// Who is signed in to the test-server workspace on this browser, and the key that opens its
// sealed documents. A session lives in this tab, or for 30 days when the visitor asked to stay
// signed in. Changing the shared password (a new gate) ends every stored session.
const SESSION = 'cvml.workspace.session.v1';
const LAST_NAME = 'cvml.workspace.name';
const LEGACY = ['cvml-gpu-timeline.test-preview.v1', 'cvml.test.username', 'cvml.test.login-log'];
const REMEMBER_DAYS = 30;

// Reading the storage property itself can throw when a browser blocks site data.
const storage = name => { try { return globalThis[name] || null; } catch { return null; } };
const stores = () => ['sessionStorage', 'localStorage'].map(storage).filter(Boolean);
export const cleanName = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

function parse(text, gate, now) {
  try {
    const s = JSON.parse(text);
    if (!s || s.gate !== gate.salt || s.key_id !== gate.key_id || typeof s.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(s.key)) return null;
    if (cleanName(s.name) !== s.name || !s.name) return null;
    if (!Number.isFinite(s.expires) || s.expires <= now) return null;
    return s;
  } catch { return null; }
}

export function currentSession(gate, now = Date.now()) {
  for (const name of ['sessionStorage', 'localStorage']) {
    let session = null;
    try { session = parse(storage(name)?.getItem(SESSION), gate, now); } catch { /* unreadable storage */ }
    if (session) return {name: session.name, key: session.key, key_id: session.key_id, remembered: name === 'localStorage'};
  }
  return null;
}

export function startSession(gate, {name, key, remember = false}, now = Date.now()) {
  const session = {name: cleanName(name), key, key_id: gate.key_id, gate: gate.salt,
    expires: now + (remember ? REMEMBER_DAYS : 1) * 86400000};
  if (!session.name) throw new Error('이름을 입력해 주세요.');
  endSession();
  let stored = false;
  for (const name of remember ? ['localStorage', 'sessionStorage'] : ['sessionStorage']) {
    if (stored) break;
    try { storage(name).setItem(SESSION, JSON.stringify(session)); stored = true; } catch { /* try the next store */ }
  }
  if (!stored) throw new Error('브라우저 저장 공간을 사용할 수 없어요. 사생활 보호 모드를 끄거나 다른 브라우저를 이용해 주세요.');
  try { storage('localStorage').setItem(LAST_NAME, session.name); } catch { /* convenience only */ }
}

export function endSession() {
  for (const store of stores()) {
    for (const key of [SESSION, ...LEGACY]) { try { store.removeItem(key); } catch { /* nothing to clear */ } }
  }
}

export function lastName() {
  try { return cleanName(storage('localStorage').getItem(LAST_NAME)); } catch { return ''; }
}
