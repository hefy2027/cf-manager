/**
 * Validate the shape accepted by the Cloudflare Cron Triggers API.
 *
 * Cloudflare uses five whitespace-separated fields, but each field also
 * supports extensions such as `LW`, `6L`, and three-letter names. Range
 * validation here would reject valid Cloudflare expressions, so the API
 * remains the authority for field semantics.
 */

export function isValidCronExpression(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every(Boolean);
}

/** Return trimmed expressions when every value is valid, otherwise null. */
export function normalizeCronExpressions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const crons = value.map((cron) => typeof cron === 'string' ? cron.trim() : '');
  return crons.every(isValidCronExpression) ? crons : null;
}
