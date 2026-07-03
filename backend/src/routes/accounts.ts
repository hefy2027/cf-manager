import { Router, Request, Response, NextFunction } from 'express';
import { getAllAccounts, createAccount, deleteAccount, getAccountById, updateAccountStatus, updateAccountId, AccountInput } from '../models/account';
import { encrypt } from '../services/encryptionService';
import { getCfClient } from '../services/cfFactory';
import { getQuotaSummary } from '../services/quotaTracker';
import { createAuditLog } from '../models/auditLog';

const router = Router();

router.get('/', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = getAllAccounts().map(a => ({
      ...a,
      api_token: a.api_token ? '***encrypted***' : null,
      api_key: a.api_key ? '***encrypted***' : null,
    }));
    const quota = getQuotaSummary();
    res.json({ accounts, quota });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, auth_type, account_id, api_token, api_key, email } = req.body;
    if (!name || !auth_type) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } });
      return;
    }
    if (auth_type !== 'token' && auth_type !== 'global_key') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } });
      return;
    }
    if (auth_type === 'token' && !api_token) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_token is required for token auth' } });
      return;
    }
    if (auth_type === 'global_key' && (!api_key || !email)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_key and email are required for global_key auth' } });
      return;
    }

    const input: AccountInput = { name, auth_type, account_id };
    if (auth_type === 'token') {
      input.api_token = encrypt(api_token);
    } else {
      input.api_key = encrypt(api_key);
      input.email = email;
    }
    const id = createAccount(input);

    // 创建后自动获取并存储 Cloudflare Account ID
    if (!account_id) {
      try {
        const saved = getAccountById(id);
        if (saved) {
          const cf = getCfClient(saved);
          await cf.user.get(); // 验证凭证有效性
          const accts: any[] = [];
          for await (const acct of cf.accounts.list()) {
            accts.push(acct as any);
          }
          if (accts.length > 0) {
            updateAccountId(id, accts[0].id);
            console.log(`[Account] Auto-fetched account_id=${accts[0].id} for "${name}"`);
          }
          updateAccountStatus(id, true);
        }
      } catch (e) {
        console.warn(`[Account] Failed to auto-fetch account_id for "${name}":`, e);
      }
    }

    createAuditLog(id, 'create_account', name, `auth_type=${auth_type}`, 'success');
    res.status(201).json({ id, ...input, api_token: '***', api_key: '***' });
  } catch (err) { next(err); }
});

router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const account = getAccountById(id);
    createAuditLog(id, 'delete_account', account?.name || String(id), null, 'success');
    deleteAccount(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/:id/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = parseInt(req.params.id as string, 10);
    const account = getAccountById(accountId);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    const cf = getCfClient(account);
    const user = await cf.user.get();

    // 自动获取并存储 Cloudflare Account ID
    if (!account.account_id) {
      try {
        const accounts: any[] = [];
        for await (const acct of cf.accounts.list()) {
          accounts.push(acct as any);
        }
        if (accounts.length > 0) {
          updateAccountId(accountId, accounts[0].id);
        }
      } catch (e) {
        // 获取账号列表失败不是致命错误，继续返回测试结果
        console.warn('Failed to fetch account list:', e);
      }
    }

    // 测试成功，更新状态为活跃
    updateAccountStatus(accountId, true);
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

export default router;
