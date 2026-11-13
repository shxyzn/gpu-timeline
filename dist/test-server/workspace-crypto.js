// Shared-password gate and at-rest encryption for workspace documents (test server only).
// The password never leaves the browser and is not stored: it only unwraps the document key.
// Protection is exactly as strong as the shared password; a short numeric code only keeps
// casual readers and crawlers out.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const GATE_CONTEXT = 'cvml-workspace/gate/v1';
export const MIN_ITERATIONS = 100000;

export function toBase64(bytes) {
  let text = '';
  // Chunked: spreading a large array into String.fromCharCode overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('base64');
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error('이 브라우저에서는 로그인할 수 없어요. HTTPS 주소로 접속해 주세요.');
  return globalThis.crypto.subtle;
}
const normalize = password => String(password ?? '').normalize('NFC');

async function passwordKey(password, salt, iterations, usage) {
  const material = await subtle().importKey('raw', encoder.encode(normalize(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({name: 'PBKDF2', salt, iterations, hash: 'SHA-256'}, material,
    {name: 'AES-GCM', length: 256}, false, [usage]);
}

export function validGate(gate) {
  try {
    return !!gate && gate.version === 1 && gate.kdf === 'PBKDF2-SHA256' && typeof gate.key_id === 'string' && /^[a-z0-9-]{1,20}$/.test(gate.key_id) &&
      Number.isSafeInteger(gate.iterations) && gate.iterations >= MIN_ITERATIONS && gate.iterations <= 5000000 &&
      fromBase64(gate.salt).length >= 16 && fromBase64(gate.iv).length === 12 && fromBase64(gate.wrapped).length === 48;
  } catch { return false; }
}

// Wrap a random 256-bit document key under the shared password. Run by a maintainer when the
// password changes; only the result is published.
export async function sealGate(password, keyBytes, {iterations = 600000, keyID = 'k1'} = {}) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) throw new Error('key');
  if (!normalize(password)) throw new Error('password');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt, iterations, 'encrypt');
  const wrapped = await subtle().encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(GATE_CONTEXT + '/' + keyID)}, key, keyBytes);
  return {version: 1, kdf: 'PBKDF2-SHA256', iterations, key_id: keyID, salt: toBase64(salt), iv: toBase64(iv), wrapped: toBase64(new Uint8Array(wrapped))};
}

// Returns the raw document key, or null when the password is wrong. Throws only when the
// gate itself is unusable, so the page can tell "wrong password" from "broken page".
export async function openGate(gate, password) {
  if (!validGate(gate)) throw new Error('로그인 설정을 읽을 수 없어요. 페이지를 새로고침해 주세요.');
  if (!normalize(password)) return null;
  const key = await passwordKey(password, fromBase64(gate.salt), gate.iterations, 'decrypt');
  try {
    const raw = await subtle().decrypt({name: 'AES-GCM', iv: fromBase64(gate.iv), additionalData: encoder.encode(GATE_CONTEXT + '/' + gate.key_id)}, key, fromBase64(gate.wrapped));
    return new Uint8Array(raw);
  } catch { return null; }
}

export function importDocumentKey(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('key');
  return subtle().importKey('raw', raw, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
}

export const isEnvelope = value => !!value && typeof value === 'object' && value.format === 'cvml-sealed' && value.version === 1 &&
  value.cipher === 'A256GCM' && typeof value.key_id === 'string' && typeof value.iv === 'string' && typeof value.data === 'string';

// A fresh random nonce per write: the same key must never encrypt two documents with one IV.
export async function sealJSON(key, keyID, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(context + '/' + keyID)}, key, encoder.encode(JSON.stringify(value)));
  return {format: 'cvml-sealed', version: 1, cipher: 'A256GCM', key_id: keyID, iv: toBase64(iv), data: toBase64(new Uint8Array(data))};
}

export class SealedDocumentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export async function openJSON(key, keyID, envelope, context) {
  if (!isEnvelope(envelope)) throw new SealedDocumentError('format', '저장된 문서 형식을 읽을 수 없어요.');
  if (envelope.key_id !== keyID) throw new SealedDocumentError('key', '로그인 정보가 바뀌었어요. 로그아웃한 뒤 다시 로그인해 주세요.');
  let bytes;
  try {
    bytes = await subtle().decrypt({name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode(context + '/' + keyID)}, key, fromBase64(envelope.data));
  } catch { throw new SealedDocumentError('open', '문서를 열 수 없어요. 로그아웃한 뒤 다시 로그인해 주세요.'); }
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { throw new SealedDocumentError('format', '저장된 문서 내용을 읽을 수 없어요.'); }
}
