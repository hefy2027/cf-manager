const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OBFUSCATE_FRONTEND = process.env.OBFUSCATE_FRONTEND === 'true';
const OBFUSCATE_WORKER = process.env.OBFUSCATE_WORKER !== 'false';

let JavaScriptObfuscator;
if (OBFUSCATE_FRONTEND || OBFUSCATE_WORKER) {
  JavaScriptObfuscator = require('javascript-obfuscator');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(srcPath, destPath) : fs.copyFileSync(srcPath, destPath);
  }
}

function clean(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

// ---- Version info (from CHANGELOG.md + git) ----
function getAppVersion() {
  try {
    const cl = fs.readFileSync(path.resolve(__dirname, '../CHANGELOG.md'), 'utf-8');
    const m = cl.match(/^##\s+\[(\d+\.\d+\.\d+)\]/m);
    if (m) return m[1];
  } catch {}
  return '0.0.0';
}
function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {}
  return '';
}
const APP_VERSION = getAppVersion();
const APP_COMMIT = getGitCommit();

const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

function obfuscateFile(filePath, options) {
  const code = fs.readFileSync(filePath, 'utf-8');
  const result = JavaScriptObfuscator.obfuscate(code, options);
  fs.writeFileSync(filePath, result.getObfuscatedCode());
}

function obfuscateDir(dir, options) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += obfuscateDir(fullPath, options);
    } else if (entry.name.endsWith('.js')) {
      obfuscateFile(fullPath, options);
      count++;
    }
  }
  return count;
}

const frontendDir = path.resolve(__dirname, '../frontend');
const publicDir = path.resolve(__dirname, 'public');
const distDir = path.resolve(frontendDir, 'dist');

const totalSteps = 7 + (OBFUSCATE_FRONTEND ? 1 : 0) + (OBFUSCATE_WORKER ? 1 : 0);
let step = 0;

console.log(`[${++step}/${totalSteps}] Generating version info (CHANGELOG.md + git)...`);
execSync('node ../scripts/gen-version.js', { cwd: __dirname, stdio: 'inherit' });

console.log(`\nObfuscation: frontend=${OBFUSCATE_FRONTEND ? 'ON' : 'OFF'}, worker=${OBFUSCATE_WORKER ? 'ON' : 'OFF'}`);
console.log(`  Set OBFUSCATE_FRONTEND=true to enable frontend obfuscation`);
console.log(`  Set OBFUSCATE_WORKER=false to disable worker obfuscation\n`);

console.log(`[${++step}/${totalSteps}] Installing frontend dependencies...`);
execSync('npm install', { cwd: frontendDir, stdio: 'inherit' });

console.log(`[${++step}/${totalSteps}] Building frontend (base=/admin/)...`);
execSync('npm run build', {
  cwd: frontendDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE_URL: '/admin/' },
});

console.log(`[${++step}/${totalSteps}] Copying frontend assets to public/...`);
clean(publicDir);
copyDir(distDir, publicDir);

if (OBFUSCATE_FRONTEND) {
  console.log(`[${++step}/${totalSteps}] Obfuscating frontend JavaScript...`);
  const assetsDir = path.join(publicDir, 'assets');
  const frontendCount = obfuscateDir(assetsDir, obfuscatorOptions);
  console.log(`  Obfuscated ${frontendCount} frontend files`);
}

console.log(`[${++step}/${totalSteps}] Syncing shared pricing data...`);
execSync('node ../scripts/sync-pricing.js', { cwd: __dirname, stdio: 'inherit' });

console.log(`[${++step}/${totalSteps}] Bundling worker backend...`);
execSync('npx esbuild src/index.ts --bundle --outfile=public/_worker.js --format=esm --target=es2022 --minify', {
  cwd: __dirname,
  stdio: 'inherit',
});

if (OBFUSCATE_WORKER) {
  console.log(`[${++step}/${totalSteps}] Obfuscating worker backend...`);
  obfuscateFile(path.join(publicDir, '_worker.js'), {
    ...obfuscatorOptions,
    sourceType: 'module',
  });
  console.log('  Worker obfuscated');
}

console.log(`[${++step}/${totalSteps}] Creating ZIP package...`);
const AdmZip = require('adm-zip');
const zip = new AdmZip();
zip.addLocalFolder(publicDir);
const zipPath = path.join(__dirname, 'cf-manager.zip');
zip.writeZip(zipPath);

const workerSize = (fs.statSync(path.join(publicDir, '_worker.js')).size / 1024).toFixed(1);
const zipSize = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
const fileCount = fs.readdirSync(publicDir, { recursive: true }).length;

console.log(`\nBuild complete!`);
console.log(`  Version: v${APP_VERSION}${APP_COMMIT ? ' (' + APP_COMMIT + ')' : ''}`);
console.log(`  Output:  worker/public/`);
console.log(`  Files:   ${fileCount}`);
console.log(`  Worker:  ${workerSize} KB`);
console.log(`  ZIP:     worker/cf-manager.zip (${zipSize} MB)`);
console.log(`\nDashboard upload: worker/cf-manager.zip`);
console.log(`CLI deploy:       cd worker && npm run deploy`);
console.log(`\nAccess: https://your-domain.com/admin/`);
