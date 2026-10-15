// 把 release/Keepwarm-darwin-<arch>/Keepwarm.app 做成 release/Keepwarm-<版本>-<arch>.dmg：npm run dmg
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const app = `release/Keepwarm-darwin-${arch}/Keepwarm.app`;
if (!existsSync(app)) throw new Error(`找不到 ${app}，请先运行 npm run package`);

const out = `release/Keepwarm-${version}-${arch}.dmg`;
const stage = mkdtempSync(join(tmpdir(), 'keepwarm-dmg-'));
try {
  // ditto 保留签名、扩展属性和符号链接
  execFileSync('ditto', [app, join(stage, 'Keepwarm.app')], { stdio: 'inherit' });
  symlinkSync('/Applications', join(stage, 'Applications'));
  rmSync(out, { force: true });
  execFileSync('hdiutil', ['create', '-volname', 'Keepwarm', '-srcfolder', stage, '-format', 'UDZO', '-ov', out], { stdio: 'inherit' });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(out);
