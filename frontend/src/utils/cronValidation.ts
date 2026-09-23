/** Cloudflare Cron Triggers use five whitespace-separated fields. */
export function isValidCronExpression(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every(Boolean);
}

export function normalizeCronExpression(value: string): string {
  return value.trim().split(/\s+/).join(' ');
}
