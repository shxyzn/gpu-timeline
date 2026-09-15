// Only encrypted credentials are persisted, locally to this browser/origin.
// This is a convenience lock, not a separate web identity/authorization system.
const iterations = 600000;
const encode = bytes => btoa(String.fromCharCode(...bytes));
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function derive(password, salt, usage) {
  if (!crypto.subtle) throw new Error('관리자 로그인은 HTTPS 또는 localhost에서 사용할 수 있습니다.');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations, hash: 'SHA-256'}, material,
    {name: 'AES-GCM', length: 256}, false, [usage]);
}
export async function sealToken(token, password, context) {
  if (password.length < 4) throw new Error('비밀번호를 4자 이상 입력해 주세요.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, 'encrypt');
  const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context)},
    key, new TextEncoder().encode(token));
  return {version: 1, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted))};
}
export async function openToken(vault, password, context) {
  if (!crypto.subtle) throw new Error('관리자 로그인은 HTTPS 또는 localhost에서 사용할 수 있습니다.');
  try {
    if (vault.version !== 1) throw new Error('version');
    const key = await derive(password, decode(vault.salt), 'decrypt');
    const bytes = await crypto.subtle.decrypt({name: 'AES-GCM', iv: decode(vault.iv), additionalData: new TextEncoder().encode(context)},
      key, decode(vault.ciphertext));
    return new TextDecoder().decode(bytes);
  } catch { throw new Error('비밀번호가 맞지 않거나 이 브라우저의 연결 정보가 손상되었습니다.'); }
}
