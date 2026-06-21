const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

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

const frontendObfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

const workerObfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: true,
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

console.log('[1/6] Installing frontend dependencies...');
execSync('npm install', { cwd: frontendDir, stdio: 'inherit' });

console.log('[2/6] Building frontend (base=/admin/)...');
execSync('npm run build', {
  cwd: frontendDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE_URL: '/admin/' },
});

console.log('[3/6] Copying frontend assets to public/...');
clean(publicDir);
copyDir(distDir, publicDir);

console.log('[4/6] Obfuscating frontend JavaScript...');
const assetsDir = path.join(publicDir, 'assets');
const frontendCount = obfuscateDir(assetsDir, frontendObfuscatorOptions);
console.log(`  Obfuscated ${frontendCount} frontend files`);

console.log('[5/6] Bundling & obfuscating worker backend...');
execSync('npx esbuild src/index.ts --bundle --outfile=public/_worker.js --format=esm --target=es2022 --minify', {
  cwd: __dirname,
  stdio: 'inherit',
});
obfuscateFile(path.join(publicDir, '_worker.js'), {
  ...workerObfuscatorOptions,
  sourceType: 'module',
});
console.log('  Worker obfuscated');

console.log('[6/6] Creating ZIP package...');
const AdmZip = require('adm-zip');
const zip = new AdmZip();
zip.addLocalFolder(publicDir);
const zipPath = path.join(__dirname, 'cf-manager.zip');
zip.writeZip(zipPath);

const workerSize = (fs.statSync(path.join(publicDir, '_worker.js')).size / 1024).toFixed(1);
const zipSize = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
const fileCount = fs.readdirSync(publicDir, { recursive: true }).length;

console.log(`\nBuild complete!`);
console.log(`  Output:  worker/public/`);
console.log(`  Files:   ${fileCount}`);
console.log(`  Worker:  ${workerSize} KB`);
console.log(`  ZIP:     worker/cf-manager.zip (${zipSize} MB)`);
console.log(`\nDashboard upload: worker/cf-manager.zip`);
console.log(`CLI deploy:       cd worker && npm run deploy`);
console.log(`\nAccess: https://your-domain.com/admin/`);
