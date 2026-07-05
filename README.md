# Typeless Toolkit for macOS

Typeless 桌面端的 macOS 本地管理工具。主入口是一个本地网页管理器,用于多账号保存、登录态切换、个人词库同步、设备 ID 重置,以及去升级/会员弹窗补丁。

这是一个纯 Node.js 项目,不需要 `npm install`。默认只面向 macOS 版 Typeless。

## 先说流程

日常使用只需要打开管理器。CLI 是备用入口,不是必需流程。

第一次使用:

1. 启动管理器。
2. 在管理器里点「启动 Typeless」,让 Typeless 以调试端口运行。
3. 在 Typeless 里登录一个账号。
4. 回到管理器,点「添加当前账号」。
5. 点「全部同步」,把这个账号的个人词库合并进本地主词库。

以后新增账号:

1. 管理器不用关,保持开着即可。
2. 在 Typeless 里退出/切换到新账号。
3. 如果 Typeless 因设备限制不让继续登录或注册,再使用管理器里的「解除设备限制」。
4. 登录成功后,回到管理器点「添加当前账号」。
5. 点「全部同步」,让新账号和已有账号的词库对齐。

以后切换账号:

1. 打开管理器。
2. 在账号卡片里点「切换到此号」。
3. 管理器会还原该账号的登录态快照,并重启 Typeless。

切换已保存账号不需要重置设备。设备 ID 重置只在新增账号、注册账号或重新登录时遇到 Typeless 设备限制才使用;它会清掉当前 Typeless 登录状态,不是日常切号步骤。

管理器本质上是运行在本机的服务: `http://127.0.0.1:7788`。使用期间保持终端窗口开着即可;用完后可以在终端按 `Ctrl+C` 退出。

## 功能状态

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 多账号管理 | 管理器 | 保存账号 token 和登录态快照 |
| 登录态切换 | 管理器 | 从本地快照恢复账号状态 |
| 个人词库同步 | 管理器 | 推荐使用「全部同步」 |
| 单词增删 | 管理器 | 对单个账号操作 |
| 设备 ID 重置 | 管理器 | 只在设备限制时使用 |
| 去升级/会员弹窗 | 管理器 | 修改 Typeless.app 本地文件 |
| CDP 调试端口启动 | 管理器 / `.command` | 用于抓取当前登录账号 token |
| 词库同步 CLI | `.command` / JS | 可选备用,日常不需要 |

## 快速开始

要求:

- macOS
- Node.js 18+
- 已安装 Typeless.app
- 系统自带 `curl`, `security`, `codesign`, `PlistBuddy`

推荐使用 `git clone`,它通常会保留 `.command` 的可执行权限。如果是从 GitHub `Download ZIP` 下载,首次运行前建议在项目目录执行:

```bash
chmod +x *.command
xattr -dr com.apple.quarantine . 2>/dev/null || true
```

启动管理器:

```bash
./启动管理器.command
```

如果管理器已经在运行,再次执行这个脚本只会打开已有页面。

或者手动启动:

```bash
node manager.js
open http://127.0.0.1:7788
```

## 账号和数据保存在哪里

本项目只在本机保存运行数据:

- `accounts.json`: 保存账号信息和 token。明文文件,不要上传。
- `profiles/`: 保存每个账号的 Typeless 登录态快照。不要上传。
- `Typeless词库主清单.csv`: 本地主词库,由同步功能自动创建或更新。不要上传。
- `config.local.json`: 你的本机配置覆盖文件。不要上传。

这些文件已写入 `.gitignore`。

## 词库同步怎么理解

管理器里的同步是只增不删:

1. 先从账号导出个人词库,合并进本地主词库。
2. 再把本地主词库里该账号缺少的词导入账号。

所以「全部同步」的结果是:所有已保存账号都会逐步对齐到同一份词库并集。它不会删除任何账号里的词。

## 还要不要用 CLI

通常不用。

`同步词库.command` 和 `typeless-dict-sync.js` 只是备用入口,适合只想对当前登录账号做一次同步,或者以后做自动化脚本。管理器已经覆盖日常操作:添加账号、切换账号、全部同步、单账号同步、单词增删。

CLI 用法:

```bash
./同步词库.command
```

或者:

```bash
node typeless-dict-sync.js
```

## 配置

默认配置通常不用改:

```json
{
  "typeless_app": "",
  "user_data_dir": "",
  "device_cache_path": "",
  "asar_path": "",
  "cdp_port": 9222,
  "manager_port": 7788,
  "api_base": "https://api.typeless.com",
  "master_csv": "Typeless词库主清单.csv",
  "paywall": {
    "file_path": [],
    "replacements": [],
    "auto_detect_file": true,
    "auto_detect_replacements": true
  }
}
```

自动探测路径:

- Typeless.app: `/Applications/Typeless.app`, `~/Applications/Typeless.app`
- 用户数据: `~/Library/Application Support/Typeless`
- device cache: `~/Library/Application Support/now.typeless.desktop/device.cache`
- app.asar: `Typeless.app/Contents/Resources/app.asar`

如果你的 Typeless 不在默认路径,不要直接改仓库配置也可以。新建 `config.local.json`:

```json
{
  "typeless_app": "/Applications/Typeless.app"
}
```

`config.local.json` 会覆盖 `config.json`,并且不会提交到 git。

## 设备 ID 重置

只有遇到 Typeless 设备限制时才需要这个功能。

管理器里的「解除设备限制」会:

1. 退出 Typeless。
2. 删除 Keychain 中的设备标识。
3. 删除 `device.cache`。
4. 删除 `user-data.json`。
5. 清理 `app-storage.json` 的 `userData` / `quotaUsage`。
6. 删除 Cookies 和 Local Storage。
7. 重新启动 Typeless。

这个操作会登出当前账号。使用前先确认账号已经在管理器里保存过,或者你能重新登录。

macOS 设备 ID 位置参考了 `estarpro1022/typeless-reset-device` 的整理:

- Keychain service: `now.typeless.desktop.deviceIdentifier`
- Keychain account: `now.typeless.desktop.security.auth_key`
- cache: `~/Library/Application Support/now.typeless.desktop/device.cache`

## 去弹窗补丁

管理器里的「解除弹窗提示」会修改 Typeless.app 内部文件:

1. 退出 Typeless。
2. 备份 `app.asar` 和 `Info.plist`。
3. 在 renderer bundle 中自动查找 `type === 'paywall'` 分支。
4. 做等长替换。
5. 更新 asar per-file SHA256。
6. 更新 `Info.plist` 中的 `ElectronAsarIntegrity.Resources/app.asar.hash`。
7. 对 `Typeless.app` 执行 ad-hoc codesign。
8. 重启 Typeless。

Typeless 自动更新后可能会重写应用文件,需要重新打补丁。

恢复方式:

```bash
cp /Applications/Typeless.app/Contents/Resources/app.asar.bak /Applications/Typeless.app/Contents/Resources/app.asar
cp /Applications/Typeless.app/Contents/Info.plist.bak /Applications/Typeless.app/Contents/Info.plist
codesign --force --deep --sign - /Applications/Typeless.app
```

如果 Typeless 安装在别处,把路径换成你的 `typeless_app`。

## 文件说明

- `manager.js`: 本地 HTTP 后端。
- `manager.html`: 管理器页面。
- `lib/common.js`: Typeless 路径探测、CDP、API、账号快照、同步、补丁逻辑。
- `typeless-dict-sync.js`: 可选的词库同步 CLI。
- `启动管理器.command`: 启动管理器并打开浏览器。
- `启动Typeless(带调试端口).command`: 以 CDP 调试端口启动 Typeless。
- `同步词库.command`: 运行可选词库同步 CLI。

## Credits

这个项目来自对原工具集的 fork 和 macOS 重构:

- 原工具集: [Jia131313/typeless-toolkit](https://github.com/Jia131313/typeless-toolkit)
- macOS 设备 ID reset 参考: [estarpro1022/typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device)

特别感谢 `typeless-reset-device` 对 Keychain service/account、`device.cache`、Typeless 本地数据目录的整理。

## 致谢 / Thanks

感谢 [LINUX DO 论坛社区](https://linux.do/) 的关注、反馈与支持。

## 免责声明

**本工具集内容仅供 24 小时内的学习与技术交流，请于下载/使用后 24 小时内自行删除。**

> [!IMPORTANT]
> **强烈建议并呼吁大家支持 Typeless 官方的付费充值与订阅服务**。优秀的软件离不开开发团队的持续维护与付出，本工具集仅供个人本地数据同步管理和技术原理研究，切勿规避或损害官方的正当付费机制。

- 本项目旨在帮助理解 Electron 应用的 asar 完整性机制、CDP 远程调试、多账号登录态管理等技术原理，仅供个人学习与研究。
- **不得用于规避 Typeless 的付费机制、违反其服务条款，或任何商业用途。** 不得将本项目用于盈利、贩卖、分发或任何形式的商业传播。
- Typeless 软件及相关商标、著作权的全部权利归其原始权利人所有，本项目与 Typeless 官方无任何关联、赞助或认可关系。
- 使用本工具集产生的一切后果（包括但不限于账号封禁、数据丢失、应用损坏、法律责任）由使用者自行承担，作者不承担任何责任。
- 使用前请先阅读 Typeless 的服务条款；若你的所在地法律或 Typeless 条款禁止此类操作，请勿使用。
- 继续使用即视为你已阅读并同意上述声明。

## License

MIT
