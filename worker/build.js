const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

const frontendDir = path.resolve(__dirname, '../frontend');
const publicDir = path.resolve(__dirname, 'public');
const distDir = path.resolve(frontendDir, 'dist');

console.log('[1/4] Installing frontend dependencies...');
execSync('npm install', { cwd: frontendDir, stdio: 'inherit' });

console.log('[2/4] Building frontend (base=/admin/)...');
execSync('npm run build', {
  cwd: frontendDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE_URL: '/admin/' },
});

console.log('[3/4] Copying frontend assets to public/...');
clean(publicDir);
copyDir(distDir, publicDir);

console.log('[4/4] Bundling worker backend → public/_worker.js...');
execSync('npx esbuild src/index.ts --bundle --outfile=public/_worker.js --format=esm --target=es2022 --minify', {
  cwd: __dirname,
  stdio: 'inherit',
});

console.log('[5/5] Creating ZIP package...');
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
