import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, DecryptError } from '../services/encryption';
import { getAuthHeaders } from '../services/cfApi';
import type { Account } from '../db/models';

// 测试在 Node 20+ 运行（CI 使用 Node 22），全局 Web Crypto 已内置，与 Cloudflare Workers 运行时一致。
// 仅依赖全局 Web Crypto，不引入 node:crypto，避免 @types/node 与 @cloudflare/workers-types 的全局类型冲突。
const gCrypto = crypto;
const KEY = 'feiyu';

async function deriveAesKey(raw: string): Promise<CryptoKey> {
  const data = /^[0-9a-fA-F]{64}$/.test(raw)
    ? hexToBytes(raw)
    : new Uint8Array(await gCrypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return gCrypto.subtle.importKey('raw', data, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return out;
}
function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('encryption (worker) — P0-3 统一线格式', () => {
  it('明文可加密后还原', async () => {
    const plain = 'sk-example-abc123';
    const token = await encrypt(plain, KEY);
    expect(await decrypt(token, KEY)).toBe(plain);
  });

  it('输出为统一的 2 段格式 iv:enc（与 backend 兼容）', async () => {
    const token = await encrypt('hello-world', KEY);
    expect(token.split(':')).toHaveLength(2);
  });

  it('可解密旧 3 段格式 iv:tag:enc（backend 历史数据）', async () => {
    const key = await deriveAesKey(KEY);
    const iv = gCrypto.getRandomValues(new Uint8Array(16));
    const encTag = new Uint8Array(
      await gCrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('legacy-secret')),
    );
    const tag = encTag.subarray(encTag.length - 16);
    const enc = encTag.subarray(0, encTag.length - 16);
    const legacy = `${toHex(iv)}:${toHex(tag)}:${toHex(enc)}`;
    expect(await decrypt(legacy, KEY)).toBe('legacy-secret');
  });

  it('可解密 backend 产出的 2 段 token（跨端迁移互操作）', async () => {
    // 用全局 Web Crypto 构造与 backend（node crypto，12B IV + tag 内联）完全一致的 token
    const key = await deriveAesKey(KEY);
    const iv = gCrypto.getRandomValues(new Uint8Array(12));
    const encTag = new Uint8Array(
      await gCrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('cross-secret')),
    );
    const token = `${toHex(iv)}:${toHex(encTag)}`;
    expect(await decrypt(token, KEY)).toBe('cross-secret');
  });

  it('线格式非法时仍抛普通 Error（不是密钥问题）', async () => {
    await expect(decrypt('not-a-ciphertext', KEY)).rejects.toThrow(/invalid ciphertext format/);
  });

  it('密钥不匹配时抛 DecryptError（可识别 + 可操作提示）', async () => {
    const token = await encrypt('sk-secret', KEY);
    let caught: unknown;
    try { await decrypt(token, 'a-different-key'); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(DecryptError);
    const decryptErr = caught as DecryptError;
    expect(decryptErr.code).toBe('DECRYPT_FAILED');
    expect(decryptErr.statusCode).toBe(500);
    expect(decryptErr.message).toContain('ENCRYPTION_KEY');
    expect(decryptErr.message).toContain('账号管理');
  });

  it('CF 客户端解密失败时抛出带账号标识的 DecryptError', async () => {
    const token = await encrypt('sk-secret', KEY);
    const account = {
      id: 9, name: 'acct-nine', auth_type: 'token',
      api_token: token, api_key: null, email: null,
    } as unknown as Account;
    let caught: unknown;
    try { await getAuthHeaders(account, 'a-different-key'); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(DecryptError);
    const decryptErr = caught as DecryptError;
    expect(decryptErr.message).toContain('acct-nine');
    expect(decryptErr.message).toContain('ID 9');
  });
});
