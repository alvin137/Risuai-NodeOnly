import path from "path";
import { existsSync, readFileSync } from "node:fs";
import type { Hono } from "hono";
import fs from "node:fs/promises";
import { flushPendingDb } from "../../utils/asset.util";
import { checkpointWal } from "../../utils/db";
import os from "node:os";
import { stopTunnel } from "./tunnel";
import { stream } from "hono/streaming";

const UPDATE_CHECK_DISABLED = process.env.RISU_UPDATE_CHECK === 'false';
const UPDATE_CHECK_URL = process.env.RISU_UPDATE_URL || 'https://risu-update-worker.nodridan.workers.dev/check';

const currentVersion = (() => {
    try {
        const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch { return '0.0.0'; }
})();

// ── Deployment type & self-update helpers ─────────────────────────────────────
const GITHUB_REPO = 'mrbart3885/Risuai-NodeOnly';

const deploymentType = (() => {
    // Only portable builds have the .portable marker (created by CI release workflow).
    // Self-update is gated on this — all other types are inferred for analytics only.
    if (existsSync(path.join(process.cwd(), '.portable'))) return 'portable';
    if (existsSync(path.join(process.cwd(), '.git'))) return 'git';
    if (existsSync('/.dockerenv')) return 'docker';
    try {
        const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
        if (cgroup.includes('docker') || cgroup.includes('containerd')) return 'docker';
    } catch {}
    return 'unknown';
})();

function getSelfUpdateAssetInfo(version: string) {
    const platformMap: Record<string, string> = { win32: 'win', linux: 'linux', darwin: 'macos' };
    const platformName = platformMap[process.platform];
    if (!platformName) return null;
    const arch = process.arch; // x64, arm64
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const filename = `RisuAI-NodeOnly-v${version}-${platformName}-${arch}.${ext}`;
    const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${filename}`;
    return { platformName, arch, ext, filename, url };
}

async function fetchLatestRelease() {
    if (UPDATE_CHECK_DISABLED) return null;
    try {
        const params = new URLSearchParams({
            v: currentVersion,
            d: deploymentType,
            os: `${process.platform}-${process.arch}`,
        });
        const url = `${UPDATE_CHECK_URL}?${params}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.hasUpdate) {
            console.log(`[Update] New version available: v${data.latestVersion} (current: v${currentVersion}, ${data.severity})`);
        }
        return data;
    } catch (e) {
        console.error('[Update] Failed to check for updates:', e.message);
        return null;
    }
}

// Helper: restore files from backup directory into app root (mirrors updater.cjs restoreBackupIntoRoot)
async function restoreBackup(backupDir: string, rootDir: string) {
    try { await fs.access(backupDir); } catch { return; }
    for (const entry of await fs.readdir(backupDir)) {
        const src = path.join(backupDir, entry);
        const dest = path.join(rootDir, entry);
        try {
            await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
            await fs.rename(src, dest);
        } catch { /* best effort */ }
    }
}

export function registerUpdateApi(api: Hono) {
// ── Update check endpoint ────────────────────────────────────────────────────
api.get('/update-check', async (c) => {
    if (UPDATE_CHECK_DISABLED) {
        return c.json({ currentVersion, hasUpdate: false, severity: 'none', disabled: true, deploymentType, canSelfUpdate: false });
    }
    const result = await fetchLatestRelease();
    const response = result || { currentVersion, hasUpdate: false, severity: 'none' };
    response.deploymentType = deploymentType;
    response.canSelfUpdate = deploymentType === 'portable'
        && !!response.hasUpdate
        && !response.manualOnly
        && !!getSelfUpdateAssetInfo(response.latestVersion);
    return c.json(response);
});

// ── Self-update endpoint (portable only) ─────────────────────────────────────
let selfUpdateInProgress = false;

api.post('/self-update', async (c) => {
  if (deploymentType !== 'portable') {
    return c.json({ error: 'Self-update is only available for portable deployments' }, 400);
  }
  if (selfUpdateInProgress) {
    return c.json({ error: 'Update already in progress' }, 409);
  }
  selfUpdateInProgress = true;

  c.header('content-type', 'application/x-ndjson');
  c.header('cache-control', 'no-cache');
  c.header('x-accel-buffering', 'no');

  return stream(c, async (s) => {
    let clientDisconnected = false;
    s.onAbort(() => {
      clientDisconnected = true;
      console.log('[Update] Client disconnected (update continues if past download stage).');
    });

    const send = (step: string, progress: number | null, message: string) => {
      try { s.write(JSON.stringify({ step, progress, message }) + '\n'); } catch {}
    };

    let tmpDir: string | null = null;
    try {
      // 1. Check update
      send('checking', 0, 'Checking for updates...');
      const updateInfo = await fetchLatestRelease();
      if (!updateInfo?.hasUpdate) {
        send('done', 100, 'Already up to date.');
        selfUpdateInProgress = false;
        return;
      }

      const targetVersion = updateInfo.latestVersion;
      const assetInfo = getSelfUpdateAssetInfo(targetVersion);
      if (!assetInfo) {
        throw new Error(`No release asset for ${process.platform}-${process.arch}`);
      }

      // 2. Download
      tmpDir = path.join(os.tmpdir(), `risu-update-${Date.now()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      const archivePath = path.join(tmpDir, assetInfo.filename);

      send('downloading', 0, 'Starting download...');
      const dlRes = await fetch(assetInfo.url, { redirect: 'follow' });
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status} ${dlRes.statusText}`);

      const totalSize = parseInt(dlRes.headers.get('content-length') ?? '0', 10) || 0;
      let downloaded = 0;
      let lastPct = -1;

      // 스트리밍 다운로드 with progress
      const body = dlRes.body;
      if (!body) throw new Error('Download response has no body');
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        if (clientDisconnected) throw new Error('Client disconnected');
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.length;
        if (totalSize > 0) {
          const pct = Math.round((downloaded / totalSize) * 100);
          if (pct >= lastPct + 5) {
            lastPct = pct;
            const dlMB = (downloaded / 1048576).toFixed(0);
            const totalMB = (totalSize / 1048576).toFixed(0);
            send('downloading', pct, `Downloading... ${pct}% (${dlMB}/${totalMB} MB)`);
          }
        }
      }

      // 다운로드한 데이터를 파일로 저장
      const blob = new Blob(chunks);
      await Bun.write(archivePath, blob);
      send('downloading', 100, 'Download complete.');

      // 3. Extract
      send('extracting', null, 'Extracting...');
      const extractDir = path.join(tmpDir, 'extracted');
      await fs.mkdir(extractDir, { recursive: true });

      const isWin = process.platform === 'win32';
      if (isWin) {
        try {
          Bun.spawnSync(['tar', '-xf', archivePath, '-C', extractDir], { timeout: 300000 });
        } catch {
          Bun.spawnSync([
            'powershell', '-NoProfile', '-Command',
            `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${extractDir}'`
          ], { timeout: 300000 });
        }
      } else {
        Bun.spawnSync(['tar', '-xzf', archivePath, '-C', extractDir], { timeout: 300000 });
      }

      // Resolve possibly nested root directory
      const entries = await fs.readdir(extractDir);
      let sourceDir = extractDir;
      if (entries.length === 1) {
        const candidate = path.join(extractDir, entries[0]);
        if ((await fs.stat(candidate)).isDirectory()) sourceDir = candidate;
      }

      // 4. Validate extracted package
      const REQUIRED_ENTRIES = ['dist', 'server', 'package.json'];
      const REQUIRED_DIST_FILES = ['index.html'];
      for (const entry of REQUIRED_ENTRIES) {
        try { await fs.access(path.join(sourceDir, entry)); }
        catch { throw new Error(`Downloaded package is missing required entry: ${entry}`); }
      }
      for (const file of REQUIRED_DIST_FILES) {
        try { await fs.access(path.join(sourceDir, 'dist', file)); }
        catch { throw new Error(`Downloaded package is missing dist/${file}`); }
      }
      if (isWin) {
        try { await fs.access(path.join(sourceDir, 'bin')); }
        catch { throw new Error('Downloaded Windows package is missing bin/'); }
      }

      // 5. Replace files
      stopTunnel();
      send('replacing', null, 'Replacing files...');
      const appDir = process.cwd();
      const updateTmp = path.join(appDir, '.update-tmp');

      // Restore from previous interrupted update
      const prevBackup = path.join(updateTmp, 'backup');
      try {
        await fs.access(prevBackup);
        console.log('[Update] Restoring files from previous interrupted update...');
        await restoreBackup(prevBackup, appDir);
      } catch { /* no leftover */ }
      await fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(updateTmp, { recursive: true });

      // Carry over SSL certificates
      const sslSrc = path.join(appDir, 'server', 'node', 'ssl', 'certificate');
      try {
        await fs.access(sslSrc);
        const sslDst = path.join(sourceDir, 'server', 'node', 'ssl', 'certificate');
        await fs.mkdir(path.dirname(sslDst), { recursive: true });
        await fs.cp(sslSrc, sslDst, { recursive: true });
      } catch { /* no user certs */ }

      // Keep set
      const keep = new Set(['save', 'backups', '.installed-version', '.update-tmp', 'scripts', '.env', '.npmrc', '.portable']);
      if (isWin) keep.add('bin');

      // Phase 1: move old files to backup
      const backupDir = path.join(updateTmp, 'backup');
      await fs.mkdir(backupDir, { recursive: true });

      const oldEntries = await fs.readdir(appDir);
      for (const e of oldEntries) {
        if (keep.has(e)) continue;
        try {
          await fs.rename(path.join(appDir, e), path.join(backupDir, e));
        } catch (backupErr) {
          console.error(`[Update] Failed to back up ${e}: ${(backupErr as Error).message}`);
          console.log('[Update] Restoring files already moved to backup...');
          await restoreBackup(backupDir, appDir);
          throw new Error(isWin
            ? 'Update failed: some files are in use. Close RisuAI first, then try again.'
            : 'Update failed: some files are in use. Stop the server first, then try again.');
        }
      }

      // Phase 2: move new files
      const skipMove = new Set(['save', 'scripts']);
      if (isWin) skipMove.add('bin');
      const moved: string[] = [];
      try {
        const newEntries = await fs.readdir(sourceDir);
        for (const e of newEntries) {
          if (skipMove.has(e)) continue;
          const dest = path.join(appDir, e);
          await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
          await fs.rename(path.join(sourceDir, e), dest);
          moved.push(e);
        }
        for (const entry of REQUIRED_ENTRIES) {
          if (!moved.includes(entry) && !existsSync(path.join(appDir, entry))) {
            throw new Error(`Required entry was not installed: ${entry}`);
          }
        }
        for (const file of REQUIRED_DIST_FILES) {
          if (!existsSync(path.join(appDir, 'dist', file))) {
            throw new Error(`Required file was not installed: dist/${file}`);
          }
        }
      } catch (moveErr) {
        console.error(`[Update] Move failed: ${(moveErr as Error).message}`);
        console.log('[Update] Restoring from backup...');
        await restoreBackup(backupDir, appDir);
        throw new Error('Update failed, previous version restored. Please try again.');
      }

      // Phase 3: update scripts/
      const newScripts = path.join(sourceDir, 'scripts');
      try {
        await fs.access(newScripts);
        await fs.mkdir(path.join(appDir, 'scripts'), { recursive: true });
        for (const f of await fs.readdir(newScripts)) {
          await fs.copyFile(path.join(newScripts, f), path.join(appDir, 'scripts', f));
        }
      } catch { /* no scripts in release */ }

      // Phase 4: Windows bin/ staging
      if (isWin) {
        const newBin = path.join(sourceDir, 'bin');
        const stagedBin = path.join(updateTmp, 'new-bin');
        await fs.rm(stagedBin, { recursive: true, force: true }).catch(() => {});
        await fs.cp(newBin, stagedBin, { recursive: true });
        await fs.writeFile(path.join(updateTmp, 'latest-version'), `v${targetVersion}`);
      } else {
        await fs.writeFile(path.join(appDir, '.installed-version'), `v${targetVersion}`);
      }

      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      tmpDir = null;
      if (!isWin) {
        fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
      }

      send('restarting', 100, 'Update complete. Restarting...');

      // 6. Flush DB and restart
      setTimeout(async () => {
        try {
          console.log(`[Update] Self-update to v${targetVersion} complete. Restarting...`);
          try { await flushPendingDb(); } catch {}
          try { checkpointWal('TRUNCATE'); } catch {}

          const port = process.env.PORT || 6001;

          if (isWin) {
            const batScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.bat`);
            const utmp = path.join(appDir, '.update-tmp');
            const binDir = path.join(appDir, 'bin');
            const binBackup = path.join(utmp, 'old-bin');
            const batLines = [
              '@echo off',
              'timeout /t 3 /nobreak >nul',
              `if exist "${path.join(utmp, 'new-bin')}\\" (`,
              `  if exist "${binDir}\\" (`,
              `    xcopy /E /I /Y "${binDir}\\*" "${binBackup}\\" >nul`,
              `  )`,
              `  xcopy /E /I /Y "${path.join(utmp, 'new-bin')}\\*" "${binDir}\\" >nul`,
              `  if errorlevel 1 (`,
              `    echo [Update] bin/ copy failed, restoring backup...`,
              `    if exist "${binBackup}\\" (`,
              `      xcopy /E /I /Y "${binBackup}\\*" "${binDir}\\" >nul`,
              `    )`,
              `    echo [Update] bin/ restored. Staged files kept for retry.`,
              `    goto start`,
              `  )`,
              `)`,
              `if exist "${path.join(utmp, 'latest-version')}" (`,
              `  copy /Y "${path.join(utmp, 'latest-version')}" "${path.join(appDir, '.installed-version')}" >nul`,
              `)`,
              `rmdir /s /q "${utmp}" 2>nul`,
              ':start',
              `cd /d "${appDir}"`,
              `start "" "${path.join(appDir, 'bin', 'bun.exe')}" "${path.join(appDir, 'server', 'node', 'server.ts')}"`,
              'exit /b 0',
            ];
            await Bun.write(batScript, batLines.join('\r\n'));
            Bun.spawn(['cmd.exe', '/c', batScript], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
          } else {
            const restartScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.ts`);
            const scriptContent = `
import { spawn } from "bun";
const net = require('net');
setTimeout(() => {
  const s = net.createServer();
  s.once('error', () => process.exit(0));
  s.once('listening', () => {
    s.close();
    Bun.spawn([${JSON.stringify(Bun.argv[0])}, 'server/node/server.ts'], {
      cwd: ${JSON.stringify(appDir)},
      detached: true,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    setTimeout(() => process.exit(0), 500);
  });
  s.listen(${Number(port)});
}, 3000);`;
            await Bun.write(restartScript, scriptContent);
            Bun.spawn([Bun.argv[0], restartScript], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
          }
          process.exit(0);
        } catch (restartErr) {
          console.error('[Update] Restart failed:', restartErr);
          selfUpdateInProgress = false;
        }
      }, 500);

    } catch (e) {
      console.error('[Update] Self-update failed:', e);
      send('error', null, `Update failed: ${(e as Error).message}`);
      selfUpdateInProgress = false;
      if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
}