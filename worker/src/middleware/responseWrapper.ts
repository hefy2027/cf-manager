import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export const responseWrapper = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  await next();

  const res = c.res;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return;

  const status = res.status;
  let body: any;
  try {
    body = await res.clone().json();
  } catch {
    return;
  }

  let wrapped: any;

  if (body && typeof body === 'object' && body.success !== undefined) {
    if (body.data !== undefined || body.error !== undefined) {
      return;
    }
    const { success, ...rest } = body;
    wrapped = success
      ? { success: true, data: Object.keys(rest).length > 0 ? rest : undefined }
      : { success: false, error: Object.keys(rest).length > 0 ? rest : undefined };
  } else if (status >= 400) {
    wrapped = body?.error
      ? { success: false, error: body.error }
      : { success: false, error: body };
  } else {
    wrapped = { success: true, data: body };
  }

  c.res = new Response(JSON.stringify(wrapped), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
});
