import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from './config';
import { initDb } from './db';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { v1ErrorHandler } from './middleware/v1ErrorHandler';
import { responseWrapper } from './middleware/responseWrapper';
import accountsRouter from './routes/accounts';
import dnsRouter from './routes/dns';
import workersRouter from './routes/workers';
import browserRenderRouter from './routes/browserRender';
import settingsRouter from './routes/settings';
import storageRouter from './routes/storage';
import tasksRouter from './routes/tasks';
import openaiRouter from './routes/openai';
import externalBrowserRenderRouter from './routes/externalBrowserRender';
import aiRouter from './routes/ai';
import { getQuotaSummary, syncUsageFromCloudflare } from './services/quotaTracker';
import { invalidateAiCache } from './services/accountRouter';
import { getRecentLogs, queryLogs, getDistinctActions } from './models/auditLog';
import { initScheduler } from './services/taskScheduler';
import { initBrowserRateLimiter } from './services/browserRateLimiter';
import { v1RequestLogger } from './middleware/v1Logger';
import { apiRequestLogger } from './middleware/apiLogger';
import { requestIdMiddleware } from './middleware/requestId';
import { appLogger } from './services/logger';

const app = express();

app.use(cors({
  origin: true, // Allow all origins (or specify your frontend URL)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Account-ID'],
  credentials: false,
}));
app.use(express.json({ limit: '100mb' }));

// Health check — before auth so Docker healthcheck works without API_SECRET
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(authMiddleware);

// External APIs — no responseWrapper, keep original format
// Mount BEFORE /api middleware to avoid responseWrapper
app.use('/v1', requestIdMiddleware);
app.use('/v1', v1RequestLogger);
app.use('/v1', openaiRouter);
app.use('/v1', v1ErrorHandler); // OpenAI-format error handler (before global errorHandler)
app.use('/v1/browser', externalBrowserRenderRouter);

// Internal APIs — with responseWrapper
app.use('/api', apiRequestLogger);
app.use('/api', responseWrapper);

app.use('/api/accounts', accountsRouter);
app.use('/api/dns', dnsRouter);
app.use('/api/workers', workersRouter);
app.use('/api/browser-render', browserRenderRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/storage', storageRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/ai', aiRouter);
app.use('/api/v1', requestIdMiddleware);
app.use('/api/v1', v1RequestLogger);
app.use('/api/v1', openaiRouter);
app.use('/api/v1', v1ErrorHandler); // OpenAI-format error handler (before global errorHandler)

app.get('/api/quota', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await syncUsageFromCloudflare();
    invalidateAiCache();
    res.json(getQuotaSummary());
  } catch (err) { next(err); }
});

app.get('/api/audit-log', (req, res, next) => {
  try {
    const { action, startDate, endDate } = req.query as any;
    if (action || startDate || endDate) {
      res.json(queryLogs({ action, startDate, endDate, limit: 500 }));
    } else {
      res.json(getRecentLogs(100));
    }
  } catch (err) { next(err); }
});

app.get('/api/audit-log/actions', (_req, res, next) => {
  try {
    res.json(getDistinctActions());
  } catch (err) { next(err); }
});

app.use(errorHandler);

async function start() {
  initDb();
  initScheduler();
  initBrowserRateLimiter();
  app.listen(config.port, () => {
    appLogger.info(`Server running on port ${config.port}`);
  });
}

process.on('uncaughtException', (err) => {
  appLogger.error(`[UNCAUGHT] ${err}`);
});
process.on('unhandledRejection', (err) => {
  appLogger.error(`[UNHANDLED_REJECTION] ${err}`);
});

start().catch((err) => appLogger.error(`[STARTUP] ${err}`));
