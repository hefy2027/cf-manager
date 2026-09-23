import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
// 与 worker（Web Crypto）对齐：IV 固定 12 字节，GCM tag（16 字节）内联于密文末尾。
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * 凭据解密失败（最典型原因：ENCRYPTION_KEY 被更换或丢失，与库中密文不再匹配）。
 *
 * 单独定义类型的目的是让上层（错误中间件、CF 客户端、批量流程）能把这类失败与普通
 * 运行时错误区分开，给用户返回可操作的提示，而不是裸的
 * `Unsupported state or unable to authenticate data`。
 *
 * 与 worker 端 DecryptError 保持同构（同一 code / statusCode / 文案）。
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

function getKey(): Buffer {
  if (!config.encryptionKey) {
    console.warn('[Encryption] ENCRYPTION_KEY not set, using default key. This is insecure for production!');
  }
  // 支持两种格式：
  // 1. 64位 hex 字符串（如 openssl rand -hex 32 生成）
  // 2. 任意长度字符串（自动 SHA-256 哈希为 32 字节）
  const key = config.encryptionKey;
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }
  // 对非 hex 格式的密钥，使用 SHA-256 哈希
  return crypto.createHash('sha256').update(key).digest();
}

// 统一线格式（与 worker 对齐）：ivHex:encHex，其中 enc = ciphertext + GCM tag（内联），IV 12 字节。
export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 将 tag 内联到密文末尾，使其与 Web Crypto 输出完全一致
  const combined = Buffer.concat([encrypted, tag]);
  return iv.toString('hex') + ':' + combined.toString('hex');
}

export function decrypt(encryptedText: string): string {
  const key = getKey();
  const parts = encryptedText.split(':');
  // 只有 2 段（当前格式 iv:enc）与 3 段（旧格式 iv:tag:enc）是合法线格式；
  // 线格式错误属于数据损坏，与「密钥不匹配」是两回事，保持原样抛出。
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error('[Encryption] invalid ciphertext format');
  }
  try {
    // 3 段 = 旧格式（16 字节 IV + 独立 tag），用于平滑读取旧 backend 历史数据
    return parts.length === 3 ? decryptLegacy(parts, key) : decryptCurrent(parts, key);
  } catch (err) {
    // GCM 认证失败（Unsupported state / unable to authenticate data）= 密钥不匹配或密文被篡改
    throw new DecryptError(undefined, err);
  }
}

// 当前格式：IV 12 字节，GCM tag（16 字节）内联于密文末尾。
function decryptCurrent(parts: string[], key: Buffer): string {
  const iv = Buffer.from(parts[0], 'hex');
  const combined = Buffer.from(parts[1], 'hex');
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const encrypted = combined.subarray(0, combined.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// 旧 backend 格式解密（16 字节 IV + 独立 tag），用于平滑读取历史数据，无需一次性迁移。
function decryptLegacy(parts: string[], key: Buffer): string {
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
