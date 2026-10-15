# Keepwarm

给 Claude Code **桌面版**会话保活 5 分钟提示缓存的 macOS 小工具。勾选若干正在运行的会话，会话空闲达到设定间隔时，自动向它发一条很短的消息（默认 `1`），让缓存持续刷新。

- 发送通道：[cc-peer](https://github.com/ExaDev/cc-peer)（非官方包，固定 1.6.8），消息直接进入当前对话，不新建会话。
- 只支持 macOS（Apple 芯片）和桌面版会话。详细需求见 [需求文档.md](需求文档.md)，验证记录见 [verify/](verify/)。

## 安装

到 [Releases](https://github.com/fenton-xue/claude-cache-keepalive/releases) 下载最新的 `Keepwarm-<版本>-arm64.dmg`，打开后把 Keepwarm 拖进「应用程序」。

应用没有经过 Apple 公证（需要付费开发者账号），首次打开请在 Finder 里右键 → 打开；如果提示"已损坏"，执行：

```bash
xattr -dr com.apple.quarantine /Applications/Keepwarm.app
```

## 使用

1. 点"添加目录"，选择项目目录。目录（含子目录、worktree）里正在运行的桌面版会话会出现在列表里。
2. 勾选要保活的会话。会话空闲达到"空闲间隔"（默认 4:30，范围 1:00 到 4:50）时自动发送。
3. 缓存已超过 5 分钟的会话需要点"确认并发送"，避免对已变冷的长上下文无意中重新计费。
4. 连续成功发送达到 `floor(7200 / 间隔秒数)` 次后自动停止；发送失败、达到上限都会弹 macOS 通知（菜单"工具 → 发送测试通知"可以检查通知权限）。
5. 关闭窗口不退出，监控继续；`Cmd+Q` 退出并停止全部监控。

运行期间会在 `~/.claude/sessions` 和 `/tmp/cc-socks` 临时注册一个名为 `Keepwarm` 的发送者，退出时清理；除此之外只读访问 `~/.claude`。

## 开发

需要 Node 24。

```bash
npm ci
npm test            # 单元测试（vitest）
npm run typecheck
npm start           # 构建并启动（开发模式下 macOS 不允许弹通知，需要打包后验证）
npm run package     # 生成 release/Keepwarm-darwin-arm64/Keepwarm.app（ad-hoc 签名）
npm run dmg         # 生成 release/Keepwarm-<版本>-arm64.dmg
```

目录结构：

- `src/core/`：与 Electron 无关的核心逻辑（监控状态机、目录归属、会话列表模型），读文件、发送、时钟都通过接口注入。
- `src/main/`：Electron 主进程（文件系统读取、cc-peer 发送器、启动清理、设置存储、通知）。cc-peer 只在 `ccPeerSender.ts` 里使用。
- `src/renderer/`：界面。`scripts/preview/` 是用假数据在浏览器里预览界面的开发工具。

## 发版

```bash
npm version patch -m "v%s"    # 或 minor / major：改版本号、提交并打标签
git push --follow-tags
```

推送 `v*` 标签后，GitHub Actions（`.github/workflows/release.yml`）会测试、打包、生成 dmg 并发布到 Releases。
