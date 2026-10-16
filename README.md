# Keepwarm

给 Claude Code **桌面版**会话保活 5 分钟提示缓存的 macOS 小工具。勾选若干要保活的会话，会话空闲达到设定间隔时，自动向它发一条很短的消息（默认 `1`），让缓存持续刷新。

- 发送通道：[cc-peer](https://github.com/ExaDev/cc-peer)（非官方包，固定 1.6.8），消息直接进入当前对话，不新建会话。
- 只支持 macOS（Apple 芯片）和桌面版会话。详细需求见 [需求文档.md](需求文档.md)，验证记录见 [verify/](verify/)。第一次升级到带"检查更新"的版本需要手动安装 dmg，之后可在应用内更新。

## 安装

到 [Releases](https://github.com/fenton-xue/claude-cache-keepalive/releases) 下载最新的 `Keepwarm-<版本>-arm64.dmg`，打开后把 Keepwarm 拖进「应用程序」。

应用没有经过 Apple 公证（需要付费开发者账号），首次打开请在 Finder 里右键 → 打开；如果提示"已损坏"，执行：

```bash
xattr -dr com.apple.quarantine /Applications/Keepwarm.app
```

## 使用

1. 点列头行右侧的"添加工作区"，选择项目目录。新工作区是空的。
2. 悬停工作区标题，点"+"（空工作区里有常驻的"添加会话"按钮），在弹窗里选择要监控的会话：列出该工作区（含子目录、worktree）里未归档的全部会话，包括没在运行的，按更新时间倒序。会话行最右端悬停出现的叉号用来移除，只是不再监控，桌面版里的会话不受影响。
3. 勾选要保活的会话。会话空闲达到"空闲间隔"（默认 4:30，范围 1:00 到 4:50）时自动发送。发送内容点输入框末尾的铅笔编辑，对号保存、叉号取消。
4. 缓存已超过 5 分钟的会话需要点"确认并发送"，避免对已变冷的长上下文无意中重新计费。
5. 连续成功发送达到 `floor(7200 / 间隔秒数)` 次后自动停止；发送失败、达到上限都会弹 macOS 通知（菜单"工具 → 发送测试通知"可以检查通知权限）。
6. 勾选状态在重启后保留：`Cmd+Q` 后重新打开、更新重启后都会自动恢复监控（缓存已过期的进入"已过期"等确认，已失败、已达上限的不恢复）。关闭窗口不退出，监控继续。
7. 菜单栏"Keepwarm → 检查更新…"：对比 GitHub 最新 Release，有新版本时可下载、安装，安装成功自动重启。没有写权限时会在 Finder 里打开 dmg，手动拖进"应用程序"。开发模式（`npm start`）只能检查，不能安装。

运行期间会在 `~/.claude/sessions` 和 `/tmp/cc-socks` 临时注册一个名为 `Keepwarm` 的发送者，退出时清理；除此之外只读访问 `~/.claude` 和桌面版的会话存储（`~/Library/Application Support/Claude*/claude-code-sessions`）。更新时会在系统临时目录和当前 `.app` 所在目录写入安装包和暂存文件。

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

- `src/core/`：与 Electron 无关的核心逻辑（监控状态机、工作区归属、会话列表模型、更新的版本比较与 Release 解析），读文件、发送、时钟都通过接口注入。
- `src/main/`：Electron 主进程（文件系统读取，含桌面版会话存储 `fsSessionStore.ts`；cc-peer 发送器；启动清理；设置存储；通知；检查更新的状态机 `updater.ts` 和下载安装 `updateIo.ts`）。cc-peer 只在 `ccPeerSender.ts` 里使用。
- `src/renderer/`：界面。`scripts/preview/` 是用假数据在浏览器里预览界面的开发工具。

## 发版

```bash
npm version patch -m "v%s"    # 或 minor / major：改版本号、提交并打标签
git push --follow-tags
```

推送 `v*` 标签后，GitHub Actions（`.github/workflows/release.yml`）会测试、打包、生成 dmg 并发布到 Releases。
