function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * 凭据解密失败（最典型原因：ENCRYPTION_KEY 被更换或丢失，与库中密文不再匹配）。
 *
 * 单独定义类型的目的是让上层（错误中间件、CF 客户端、批量流程）能把这类失败与普通
 * 运行时错误区分开，给用户返回可操作的提示，而不是裸的
 * `The operation failed for an operation-specific reason`。
 *
 * 与 backend 端 DecryptError 保持同构（同一 code / statusCode / 文案）。
 */
export class DecryptError extends Error {
  readonly code = 'DECRYPT_FAILED';
  readonly statusCode = 500;

  constructor(accountLabel?: string, cause?: unknown) {
    super(
      accountLabel
        ? `账号「${accountLabel}」的凭据解密失败：当前 ENCRYPTION_KEY 与库中密文不匹配（通常是更换或丢失了加密密钥）。请在「账号管理」中重新录入该账号的 API 凭证后重试。`
        : '凭据解密失败：当前 ENCRYPTION_KEY 与库中密文不匹配（通常是更换或丢失了加密密钥）。请在「账号管理」中重新录入该账号的 API 凭证后重试。',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'DecryptError';
  }
}

async function deriveKey(raw: string): Promise<CryptoKey> {
  const keyData = /^[0-9a-fA-F]{64}$/.test(raw)
    ? fromHex(raw)
    : new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// 统一线格式（与 backend 对齐）：ivHex:encHex，其中 enc = ciphertext + GCM tag（内联），IV 12 字节。
export async function encrypt(text: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return `${toHex(iv)}:${toHex(encrypted)}`;
}

export async function decrypt(encryptedText: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const parts = encryptedText.split(':');
  // 只有 2 段（当前格式 iv:enc）与 3 段（旧格式 iv:tag:enc）是合法线格式；
  // 线格式错误属于数据损坏，与「密钥不匹配」是两回事，保持原样抛出。
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error('[Encryption] invalid ciphertext format');
  }
  try {
    // 3 段 = 旧 backend 格式（16 字节 IV + 独立 tag）
    if (parts.length === 3) {
      const iv = fromHex(parts[0]);
      const tag = fromHex(parts[1]);
      const data = fromHex(parts[2]);
      const combined = new Uint8Array(data.length + tag.length);
      combined.set(data, 0);
      combined.set(tag, data.length);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, combined);
      return new TextDecoder().decode(decrypted);
    }
    const [ivHex, dataHex] = parts;
    const iv = fromHex(ivHex);
    const data = fromHex(dataHex);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    // GCM 认证失败（OperationError）= 密钥不匹配或密文被篡改
    throw new DecryptError(undefined, err);
  }
}
