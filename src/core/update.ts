// Release update helpers. Core-only so tests can cover version logic.

export interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface ReleaseInfo {
  tag_name?: string;
  name?: string;
  assets?: ReleaseAsset[];
}

function numericParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

export function compareVersions(a: string, b: string): number {
  const aa = numericParts(a);
  const bb = numericParts(b);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewerRelease(currentVersion: string, releaseTag: string | undefined): boolean {
  if (!releaseTag) return false;
  return compareVersions(releaseTag, currentVersion) > 0;
}

export function pickVsixAsset(release: ReleaseInfo, extensionName = "master-hand-vscode"): ReleaseAsset | null {
  const assets = release.assets ?? [];
  return assets.find((asset) => {
    const name = String(asset.name ?? "").toLowerCase();
    return name.endsWith(".vsix") && name.includes(extensionName);
  }) ?? assets.find((asset) => String(asset.name ?? "").toLowerCase().endsWith(".vsix")) ?? null;
}
