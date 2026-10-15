// 打包成 release/Keepwarm-darwin-arm64/Keepwarm.app（ad-hoc 签名）：npm run package
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';

const paths = await packager({
  dir: '.',
  name: 'Keepwarm',
  platform: 'darwin',
  arch: process.arch === 'x64' ? 'x64' : 'arm64',
  out: 'release',
  overwrite: true,
  appBundleId: 'com.fenton.keepwarm',
  appCategoryType: 'public.app-category.developer-tools',
  prune: true,
  // 主进程已把依赖打进 dist，运行时只需要 dist 和 package.json
  ignore: [/^\/(?!dist($|\/)|package\.json$).+/],
});
// 图标：直接替换默认的 electron.icns（Info.plist 里引用的就是这个文件名）
// 改过 Info.plist 之后原签名失效，Apple 芯片上必须重新签名；这里用 ad-hoc 签名（不需要开发者证书）
for (const dir of paths) {
  copyFileSync('build/icon.icns', `${dir}/Keepwarm.app/Contents/Resources/electron.icns`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', `${dir}/Keepwarm.app`], { stdio: 'inherit' });
}
console.log(paths.join('\n'));
