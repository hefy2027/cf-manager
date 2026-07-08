import { Hono } from 'hono';
import type { Env } from '../types';
import { getSetting, setSetting } from '../db/models';
import { VERSION, GIT_COMMIT } from '../version';

const app = new Hono<{ Bindings: Env }>();

app.get('/', async (c) => {
  return c.json({
    encryption_key_configured: !!c.env.ENCRYPTION_KEY,
    api_secret_configured: !!c.env.API_SECRET,
    demo_account_ids: c.env.DEMO_ACCOUNT_IDS || '',
    db_path: 'D1 (Cloudflare)',
    platform: 'cloudflare-workers',
    version: VERSION,
    git_commit: GIT_COMMIT,
  });
});

app.post('/cache/clear', async (c) => {
  return c.json({ message: 'Worker is stateless — no persistent cache to clear' });
});

export default app;
