import path from "path";
import { existsSync, readFileSync } from "node:fs";

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