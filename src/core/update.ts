/** 检查更新的纯逻辑：版本比较、Release 解析、安装包挑选、校验文件解析、失败文案。 */

export const RELEASE_API = 'https://api.github.com/repos/fenton-xue/claude-cache-keepalive/releases/latest';

/** 形如 v0.3.0 或 0.3.0（允许带 -beta 等后缀，只看前三段数字）；解析不了返回 null */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 逐段比较 a 与 b：a 更高为正，相等为 0，a 更低为负；任一方解析不了按相等处理 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseInfo {
  /** 去掉 v 的版本号 */
  version: string;
  assets: ReleaseAsset[];
}

/** 整理 GitHub 的 releases/latest 响应；缺字段返回 null */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tag_name !== 'string' || parseVersion(r.tag_name) === null) return null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(r.assets)) {
    for (const a of r.assets) {
      const o = a as Record<string, unknown>;
      if (typeof o?.name === 'string' && typeof o.browser_download_url === 'string') assets.push({ name: o.name, url: o.browser_download_url });
    }
  }
  return { version: r.tag_name.trim().replace(/^v/, ''), assets };
}

/** 当前架构的安装包和它的 .sha256；任何一个找不到返回 null */
export function pickAssets(rel: ReleaseInfo, arch: string): { dmg: ReleaseAsset; sha: ReleaseAsset } | null {
  const name = `Keepwarm-${rel.version}-${arch}.dmg`;
  const dmg = rel.assets.find((a) => a.name === name);
  const sha = rel.assets.find((a) => a.name === `${name}.sha256`);
  return dmg && sha ? { dmg, sha } : null;
}

/** `shasum -a 256` 的输出："<64 位十六进制>  <文件名>"；取第一段 */
export function parseSha256(text: string): string | null {
  const m = /^\s*([0-9a-fA-F]{64})\b/.exec(text);
  return m ? (m[1] as string).toLowerCase() : null;
}

export class UpdateHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** 把检查、下载阶段的异常翻译成界面文案（需求 14.5） */
export function describeUpdateError(e: unknown): string {
  if (e instanceof UpdateHttpError) {
    if (e.status === 403 || e.status === 429) return '检查更新过于频繁，请稍后再试';
    if (e.status === 404) return '还没有发布任何版本';
    return `GitHub 返回了 HTTP ${e.status}`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/net::ERR_|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|timed? ?out|network/i.test(msg)) return '无法连接到 GitHub，请检查网络或代理后重试';
  return msg;
}

/** 下载进度文案，如 "12.3 / 45.0 MB"；不知道总大小时只显示已下载 */
export function formatProgress(received: number, total: number | undefined): string {
  const mb = (n: number) => (n / 1048576).toFixed(1);
  return total ? `${mb(received)} / ${mb(total)} MB` : `${mb(received)} MB`;
}
