import { Account } from '../models/account';
import { getCfClient } from './cfFactory';
import { decrypt } from './encryptionService';
import { proxyFetch } from './proxyService';
import crypto from 'crypto';

export interface WorkerScript {
  id: string;
  name?: string;
  created_on: string;
  modified_on: string;
  etag: string;
  handlers: string[];
}

export interface PagesProject {
  id: string;
  name: string;
  domains: string[];
  production_branch: string;
  created_on: string;
  modified_on: string;
  deployment_count: number;
  source?: { type: string };
}

export async function listWorkers(account: Account): Promise<WorkerScript[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const scripts: WorkerScript[] = [];
  for await (const script of cf.workers.scripts.list({ account_id: accountId })) {
    scripts.push(script as any);
  }
  return scripts;
}

export async function listPages(account: Account): Promise<PagesProject[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const projects: PagesProject[] = [];
  for await (const project of cf.pages.projects.list({ account_id: accountId })) {
    projects.push(project as any);
  }
  return projects;
}

export async function deployWorker(account: Account, name: string, scriptContent: string): Promise<WorkerScript> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const result = await cf.workers.scripts.update(name, {
    account_id: accountId!,
    metadata: { main_module: 'worker.js' } as any,
    'worker.js': new Blob([scriptContent], { type: 'application/javascript+module' })
  } as any);
  return result as any;
}

// Deploy worker from URL: fetch JS from remote URL then upload
export async function deployWorkerFromUrl(account: Account, name: string, url: string): Promise<WorkerScript> {
  const resp = await proxyFetch(url);
  if (!resp.ok) {
    const err = new Error(`Failed to fetch JS from URL: ${resp.status} ${resp.statusText}`);
    (err as any).statusCode = resp.status;
    throw err;
  }
  const scriptContent = await resp.text();
  return deployWorker(account, name, scriptContent);
}

export async function deleteWorker(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.workers.scripts.delete(name, { account_id: accountId! } as any);
}

export async function deletePagesProject(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.pages.projects.delete(name, { account_id: accountId! } as any);
}

export async function getWorkerLogs(account: Account, name: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const result = await cf.workers.scripts.tail.get(name, { account_id: accountId! } as any);
  return result;
}

// ============ Worker Settings ============

// --- Secrets ---
export async function listSecrets(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const secrets: any[] = [];
  for await (const s of cf.workers.scripts.secrets.list(scriptName, { account_id: accountId! })) {
    secrets.push(s);
  }
  return secrets;
}

export async function updateSecret(account: Account, scriptName: string, name: string, type: string, text?: string, keyBase64?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, name, type };
  if (type === 'secret_text') params.text = text;
  if (type === 'secret_key') params.key_base64 = keyBase64;
  return await cf.workers.scripts.secrets.update(scriptName, params);
}

export async function deleteSecret(account: Account, scriptName: string, secretName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.secrets.delete(scriptName, secretName, { account_id: accountId! });
}

// --- Cron Schedules ---
export async function getSchedules(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.get(scriptName, { account_id: accountId! });
}

export async function updateSchedules(account: Account, scriptName: string, crons: string[]): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.update(scriptName, {
    account_id: accountId!,
    body: crons.map(c => ({ cron: c })),
  });
}

// --- Custom Domains ---
export async function listDomains(account: Account, serviceName?: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  const params: any = { account_id: accountId! };
  if (serviceName) params.service = serviceName;
  for await (const d of cf.workers.domains.list(params)) {
    domains.push(d);
  }
  return domains;
}

export async function createDomain(account: Account, hostname: string, service: string, environment?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, hostname, service };
  if (environment) params.environment = environment;
  return await cf.workers.domains.update(params);
}

export async function deleteDomain(account: Account, domainId: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.domains.delete(domainId, { account_id: accountId! });
}

// --- Subdomain (workers.dev) ---
export async function getSubdomain(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.subdomain.get(scriptName, { account_id: accountId! });
}

export async function setSubdomain(account: Account, scriptName: string, enabled: boolean): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.subdomain.create(scriptName, { account_id: accountId!, enabled });
}

// --- Script Settings ---
export async function getScriptSettings(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.get(scriptName, { account_id: accountId! });
}

export async function updateScriptSettings(account: Account, scriptName: string, settings: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.edit(scriptName, { account_id: accountId!, ...settings });
}

// --- Routes ---
export async function listRoutes(account: Account, zoneId: string): Promise<any[]> {
  const cf = getCfClient(account);
  const routes: any[] = [];
  for await (const r of cf.workers.routes.list({ zone_id: zoneId })) {
    routes.push(r);
  }
  return routes;
}

export async function createRoute(account: Account, zoneId: string, pattern: string, script?: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.create({ zone_id: zoneId, pattern, script });
}

export async function deleteRoute(account: Account, zoneId: string, routeId: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.delete(routeId, { zone_id: zoneId });
}

// --- Script Content ---
export async function getScriptContent(account: Account, scriptName: string): Promise<string> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.get(scriptName, { account_id: accountId! }) as any;
}

// --- Deployments ---
export async function listDeployments(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.deployments.list(scriptName, { account_id: accountId! });
}

// ============ Pages Settings ============

export async function getPagesProject(account: Account, projectName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.get(projectName, { account_id: accountId! });
}

export async function editPagesProject(account: Account, projectName: string, params: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.edit(projectName, { account_id: accountId!, ...params });
}

export async function listPagesDomains(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  for await (const d of cf.pages.projects.domains.list(projectName, { account_id: accountId! })) {
    domains.push(d);
  }
  return domains;
}

export async function addPagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Create the Pages domain association
  const result = await cf.pages.projects.domains.create(projectName, { account_id: accountId!, name: hostname });

  // 2. Automatically create CNAME DNS record if zone is in the same account
  try {
    const pagesSubdomain = `${projectName}.pages.dev`;

    // Find matching zone for this hostname
    const zones: any[] = [];
    for await (const zone of cf.zones.list({ per_page: 100 })) {
      zones.push(zone);
    }

    // Match: et8.example.com → zone example.com
    const matchingZone = zones.find((z: any) => hostname.endsWith('.' + z.name) || hostname === z.name);

    if (matchingZone) {
      // Check if CNAME already exists
      const existing: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        existing.push(r);
      }

      if (existing.length === 0) {
        await cf.dns.records.create({
          zone_id: matchingZone.id,
          type: 'CNAME',
          name: hostname,
          content: pagesSubdomain,
          proxied: true,
          ttl: 1, // auto
        } as any);
        console.log(`[Pages Domain] Created CNAME: ${hostname} → ${pagesSubdomain} (proxied)`);
      } else {
        console.log(`[Pages Domain] CNAME already exists for ${hostname}, skipping`);
      }
    } else {
      console.log(`[Pages Domain] No matching zone found for ${hostname}, DNS record not created`);
    }
  } catch (dnsErr) {
    console.error(`[Pages Domain] Failed to create DNS record:`, dnsErr);
    // Don't throw - domain association succeeded, DNS is best-effort
  }

  return result;
}

export async function removePagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Remove the Pages domain association
  const result = await cf.pages.projects.domains.delete(projectName, hostname, { account_id: accountId! });

  // 2. Clean up CNAME DNS record
  try {
    const zones: any[] = [];
    for await (const zone of cf.zones.list({ per_page: 100 })) {
      zones.push(zone);
    }
    const matchingZone = zones.find((z: any) => hostname.endsWith('.' + z.name) || hostname === z.name);
    if (matchingZone) {
      const records: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        records.push(r);
      }
      for (const r of records) {
        if (r.content === `${projectName}.pages.dev`) {
          await cf.dns.records.delete(r.id, { zone_id: matchingZone.id });
          console.log(`[Pages Domain] Deleted CNAME: ${hostname}`);
        }
      }
    }
  } catch (dnsErr) {
    console.error(`[Pages Domain] Failed to delete DNS record:`, dnsErr);
  }

  return result;
}

export async function listPagesDeployments(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const deps: any[] = [];
  for await (const d of cf.pages.projects.deployments.list(projectName, { account_id: accountId! })) {
    deps.push(d);
  }
  return deps;
}

// ============ Cloudflare Resources (for Pages bindings) ============
export async function listKvNamespaces(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const ns of cf.kv.namespaces.list({ account_id: account.account_id! })) {
    items.push(ns);
  }
  return items;
}

export async function listD1Databases(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const db of cf.d1.database.list({ account_id: account.account_id! })) {
    items.push(db);
  }
  return items;
}

export async function listR2Buckets(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const resp: any = await cf.r2.buckets.list({ account_id: account.account_id! });
  return resp?.buckets || [];
}

// Update Pages project bindings via deployment_configs
export async function updatePagesBindings(account: Account, projectName: string, deploymentConfigs: any): Promise<any> {
  return await editPagesProject(account, projectName, { deployment_configs: deploymentConfigs });
}

// REST auth headers for Pages deploy & GraphQL
function getAuthHeaders(account: Account): Record<string, string> {
  if (account.auth_type === 'token') {
    return { 'Authorization': `Bearer ${decrypt(account.api_token!)}` };
  } else {
    return { 'X-Auth-Email': account.email!, 'X-Auth-Key': decrypt(account.api_key!) };
  }
}

// ============ Workers Usage (GraphQL) ============
export interface WorkersUsage {
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeMs: number;
}

function getTodayMidnightUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function getWorkersUsageToday(account: Account): Promise<WorkersUsage> {
  const accountId = account.account_id;
  if (!accountId) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };

  const now = new Date();
  const todayDate = now.toISOString().substring(0, 10);
  const datetimeStart = getTodayMidnightUTC();
  const datetimeEnd = now.toISOString();

  const query = `
    query CfWorkersUsage($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $todayDate: Date!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          workers: workersInvocationsAdaptive(
            filter: {
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }
            limit: 10000
          ) {
            sum {
              requests
              errors
              subrequests
              cpuTimeUs
            }
          }
          pages: pagesFunctionsInvocationsAdaptiveGroups(
            filter: {
              date: $todayDate
            }
            limit: 1
          ) {
            sum {
              requests
              errors
            }
          }
        }
      }
    }
  `;

  const headers = getAuthHeaders(account);
  const resp = await proxyFetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        datetimeStart,
        datetimeEnd,
        todayDate: todayDate,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[GraphQL] Workers usage query failed: ${resp.status}`, text);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const json = await resp.json() as any;
  if (json.errors) {
    console.error('[GraphQL] Errors:', JSON.stringify(json.errors));
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const acct = json?.data?.viewer?.accounts?.[0];
  const workerRecords = acct?.workers || [];
  const pagesRecords = acct?.pages || [];

  let totalRequests = 0, totalErrors = 0, totalSubrequests = 0, totalCpuUs = 0;
  for (const rec of workerRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
    totalSubrequests += s.subrequests || 0;
    totalCpuUs += s.cpuTimeUs || 0;
  }
  for (const rec of pagesRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
  }

  return {
    requests: totalRequests,
    errors: totalErrors,
    subrequests: totalSubrequests,
    cpuTimeMs: Math.round(totalCpuUs / 1000),
  };
}

// Pages deployment: create project if needed, then upload files via SDK
export async function deployPages(
  account: Account,
  projectName: string,
  files: Array<{ path: string; buffer: Buffer }>,
  skipCreateProject = false
): Promise<any> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');

  for (const f of files) {
    f.path = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  const cf = getCfClient(account);

  // 1. Create project if not exists (skip if skipCreateProject is true)
  if (!skipCreateProject) {
    try {
      await cf.pages.projects.create({ account_id: accountId, name: projectName, production_branch: 'main' } as any);
    } catch (e: any) {
      if (e?.status !== 409) throw e;  // 409 = already exists, ignore
    }
  }

  // 2. Build manifest + deployment params
  const manifest: Record<string, string> = {};
  const params: Record<string, any> = {
    account_id: accountId,
    manifest: '',
    branch: 'main',
    commit_hash: 'direct-upload',
    commit_message: 'Deploy via CF Manager',
    commit_dirty: 'false' as const,
  };

  for (const f of files) {
    manifest[f.path] = crypto.createHash('sha256').update(f.buffer).digest('hex');
    params[f.path] = new File([new Uint8Array(f.buffer)], f.path, { type: 'application/octet-stream' });
  }
  params.manifest = JSON.stringify(manifest);

  console.log(`[Pages Deploy] ${files.length} files, manifest:`, Object.keys(manifest).slice(0, 5).join(', '), '...');

  // 3. Deploy via SDK (handles multipart form construction)
  return cf.pages.projects.deployments.create(projectName, params as any);
}
