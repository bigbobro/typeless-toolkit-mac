# Typeless Toolkit for macOS

Typeless 桌面端的 macOS 本地管理工具。主入口是一个本地网页管理器,用于多账号保存、登录态切换、个人词库同步、设备 ID 重置,以及去升级/会员弹窗补丁。

这是一个纯 Node.js 项目,不需要 `npm install`。默认只面向 macOS 版 Typeless。

## 先说流程

日常使用只需要打开管理器。CLI 是备用入口,不是必需流程。

新用户首次使用:

1. 启动管理器。
2. 在管理器里点「连接 Typeless」,建立识别当前登录账号所需的管理连接。如果 Typeless 已经普通启动,这里会自动重启一次。
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

顶部的「管理连接未开启」不表示 Typeless 账号掉线。账号卡片可以使用已保存 token 独立刷新;只有识别或抓取桌面端当前登录账号时才需要管理连接。点击「连接 Typeless」后,页面会等待连接成功并自动更新顶部状态。

管理器每次启动都会生成一次性的本机会话密钥。除公开的 `/api/health` 外,所有 `/api/*` 请求都必须来自当前管理器页面并携带这个密钥;服务不开放 CORS。常规账号和抓取接口不会把 token 返回浏览器;只有用户主动确认「导出备份包」时,浏览器才会接收并保存包含 token 的备份文件。启动脚本通过 `/api/health` 的产品标识确认端口上运行的确实是本管理器。

## 功能状态

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 多账号管理 | 管理器 | 保存账号 token 和登录态快照 |
| 登录态切换 | 管理器 | 从本地快照恢复账号状态 |
| 个人词库同步 | 管理器 | 推荐使用「全部同步」 |
| 单词增删 | 管理器 | 对单个账号操作 |
| 设备 ID 重置 | 管理器 | 只在设备限制时使用 |
| 去升级/会员弹窗 | 管理器 | 修改 Typeless.app 本地文件 |
| Typeless 管理连接 | 管理器 / `.command` | 通过本地 CDP 识别和抓取当前登录账号 |
| 词库同步 CLI | `.command` / JS | 可选备用,日常不需要 |

## 快速开始

要求:

- macOS
- Node.js 22+
- 已安装 Typeless.app
- 系统自带 `curl`, `security`, `codesign`, `PlistBuddy`

推荐使用 `git clone`,它通常会保留 `.command` 的可执行权限。如果是从 GitHub `Download ZIP` 下载,确认来源可信后,首次运行前可在项目目录执行:

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

## 从旧版本升级

`macos-v2.3.0` 第一次把账号和备份迁移到稳定数据目录。老用户任选一条路径:

1. **原目录迁移**:先退出旧管理器,再把新版本文件夹里的内容覆盖/合并到旧项目根目录,然后运行一次新版。不要把整个新版本文件夹嵌套成 `旧目录/新版本目录/manager.js`。
2. **备份导入**:`macos-v1.5.1` 及之后的旧版本可以先导出备份包,把新版解压到全新目录后点「导入恢复」。更早版本没有导出功能,请使用原目录迁移。

迁移、导入或新建数据完成后,同一台 Mac、同一个 macOS 用户账户下的后续 release 可以解压到任意目录,都会继续读取同一套稳定数据。换机器或换系统用户时仍需使用「导出备份包」和「导入恢复」。

## 账号和数据保存在哪里

本项目只在本机保存运行数据。默认稳定目录是:

```text
~/Library/Application Support/Typeless Toolkit/
```

- `accounts.json`: 保存账号信息和 token。明文文件,权限固定为仅当前用户可读写,不要上传。
- `profiles/`: 保存每个账号的 Typeless 登录态快照。不要上传。
- `Typeless词库主清单.csv`: 本地主词库,由同步功能自动创建或更新。不要上传。
- `config.local.json`: 你的本机配置覆盖文件。不要上传。
- `runtime-backups/`: 运行数据的固定本地备份目录。不要上传。
- `patch-backups/`: 每次实际修改 Typeless.app 前创建的版本化事务备份。

稳定目录及其子目录使用 `0700`,敏感文件使用 `0600`。仓库里的同名旧路径仍保留在 `.gitignore`,防止旧版本数据被误提交。

从旧版本首次启动时,管理器会把项目目录中的 `accounts.json`、`profiles/`、`runtime-backups/`、主词库、`config.local.json` 和版本状态安全复制到稳定目录。迁移会先检查冲突,通过临时目录复制并校验 SHA-256,最后写入完成标记,并自动创建一份 `post-migration` 本地备份;旧源数据不会自动删除。以后更新项目可以直接替换源码目录,账号和备份仍留在 Application Support。

如果稳定目录和旧目录已经存在内容不同的同名数据,管理器会停止启动并提示冲突,不会猜测、合并或覆盖。需要便携/测试目录时仍可显式设置 `TYPELESS_DATA_DIR`；设置后不会执行自动迁移。

如果第一次误从空的新目录启动,但稳定目录里仍没有账号/主词库/运行备份,之后从真正的旧目录启动时仍会补做自动迁移。一旦稳定目录已经有数据或已经导入过备份,它就是唯一基准,不会再用另一个旧目录覆盖。

新用户没有迁移步骤:第一次添加账号后数据直接写入稳定目录。自动迁移、导入恢复或新建数据完成后,同一台 Mac、同一个 macOS 用户账户下的后续 release 都可以解压到任意目录并继续使用同一套数据。

管理器顶部会显示运行数据备份状态:

- 「已备份」表示稳定数据目录里的账号、profile 快照和主词库已经有本地备份。
- 「未备份」表示这些运行数据在最近一次备份后又有变化。
- 「立即备份」会备份到稳定数据目录内固定的 `runtime-backups/`,用于防止误操作;它仍在同一块磁盘上,不能替代异盘备份。
- 「导出备份包」会下载一个可迁移的 JSON 备份包,适合本人换目录、换机器或离线保管。
- 「导入恢复」可以从这个备份包恢复账号、profile 快照和主词库。恢复前会先自动备份当前数据。

备份包包含 Typeless 登录信息、账号 token 和 profile 快照。不要随意分享给他人,只在可信环境里保存和导入。

本地备份会先写入 staging,逐文件校验 SHA-256 并生成完整 manifest,最后才发布为可用备份。导入恢复同样先完整校验和 staging；如果进程在提交中被中断,下一次启动会先恢复中断前的账号、主词库和 profiles,再打开管理器。

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

如果你的 Typeless 不在默认路径,不要直接改仓库配置。在稳定数据目录中创建 `config.local.json`:

```json
{
  "typeless_app": "/Applications/Typeless.app"
}
```

`config.local.json` 会覆盖仓库内的 `config.json`,并且不会提交到 git。旧版本放在项目目录里的 `config.local.json` 会在首次启动时一起迁移。

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
2. 在稳定数据目录的 `patch-backups/` 中创建绑定当前 Typeless 版本和原始 SHA-256 的本次事务备份。
3. 在 renderer bundle 中自动查找 `type === 'paywall'` 分支。
4. 做等长替换。
5. 更新 asar per-file SHA256。
6. 更新 `Info.plist` 中的 `ElectronAsarIntegrity.Resources/app.asar.hash`。
7. 原子替换候选文件,对 `Typeless.app` 执行 ad-hoc codesign。
8. 验证 Info.plist 完整性、补丁标记和 `codesign --verify --deep --strict`。
9. 重启 Typeless。

Typeless 自动更新后可能会重写应用文件,需要重新打补丁。

任一步失败都会只使用本次事务的 before-image 恢复 `app.asar` 和 `Info.plist`,重新签名并校验。不会再使用可能属于旧 Typeless 版本的固定 `.bak`。如果界面明确提示“需要人工恢复”,可从最近一次事务目录恢复:

补丁在第一次写入应用文件前会持久化 `committing` 状态。如果进程在中途退出,下一次管理器启动会先校验 before-image、恢复文件并重新签名；如果 Typeless 已在 `prepared` 阶段后自行更新,管理器会保留外部更新并停止补丁,不会用旧备份覆盖。

### 自动识别失败时

Typeless 更新可能改变 renderer 文件路径或压缩后的函数名。管理器找不到唯一目标时会停止,不会猜测写入。需要手工适配时,在稳定数据目录的 `config.local.json` 中覆盖 `paywall`:

- `file_path`:目标文件在 `app.asar` 内的路径,按 `/` 拆成字符串数组。
- `replacements`:一个或多个 `[原字符串,替换字符串]`。两侧 UTF-8 字节长度必须相同,原字符串在目标文件中必须唯一。
- `auto_detect_file` / `auto_detect_replacements`:保留 `true` 可继续使用自动探测；确认手工值后可设为 `false`。

不要直接修改仓库里的 `config.json`,也不要在无法确认路径和等长替换时强行打补丁。

```bash
DATA="$HOME/Library/Application Support/Typeless Toolkit"
BACKUP=$(ls -td "$DATA"/patch-backups/* | head -1)
cp "$BACKUP/app.asar" /Applications/Typeless.app/Contents/Resources/app.asar
cp "$BACKUP/Info.plist" /Applications/Typeless.app/Contents/Info.plist
codesign --force --deep --sign - /Applications/Typeless.app
codesign --verify --deep --strict /Applications/Typeless.app
```

如果使用过 `TYPELESS_DATA_DIR`,把 `DATA` 改为该变量指向的实际目录。如果 Typeless 安装在别处,把应用路径换成你的 `typeless_app`。

## 文件说明

- `manager.js`: 本地 HTTP 后端。
- `manager.html`: 管理器页面。
- `lib/common.js`: Typeless 路径探测、CDP、API、账号快照、同步、补丁逻辑。
- `lib/runtime-data.js`: 稳定数据目录、首次迁移、冲突检测与权限收紧。
- `lib/local-api-security.js`: 本地会话、Host/Origin 校验、安全响应头和严格 JSON 请求。
- `lib/patch-transaction.js`: 版本化补丁 before-image、原子替换、验证与精确回滚。
- `typeless-dict-sync.js`: 可选的词库同步 CLI。
- `启动管理器.command`: 启动管理器并打开浏览器。
- `启动Typeless(带调试端口).command`: 启动或重启 Typeless,并验证本地管理连接已建立。
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
