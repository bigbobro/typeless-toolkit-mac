# Typeless Toolkit for macOS

给 **macOS 上的 Typeless** 用的本机管理器：把多个账号收在一个页面里，切号、对齐词库、处理设备限制、去掉升级/会员弹窗。数据只留在本机，打开浏览器操作，不用注册云端、也不用 `npm install`。

**只做 Mac。** 路径探测、Keychain、codesign、稳定数据目录都按 macOS 桌面端设计；不维护其他平台。

本仓库已从早期 fork 网络脱离，[独立维护](https://github.com/bigbobro/typeless-toolkit-mac)。功能、界面、数据位置和发版以这里为准；版本记录见 [CHANGELOG.md](./CHANGELOG.md)。历史上受益于 [Jia131313/typeless-toolkit](https://github.com/Jia131313/typeless-toolkit) 与 [estarpro1022/typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device)，致谢见文末——**日常使用不必关心上游**。

---

## 管理器能帮你什么

日常入口只有一个本地页面（`http://127.0.0.1:7788`）。CLI 是备用，可以当不存在。

- **多账号在同一页**：保存登录 token 和本机快照；卡片上能看到额度、token 大约还剩几天、快照是多久前存的。
- **切号不折腾设备**：点「切换到此号」即还原该号快照并重启 Typeless。设备 ID 重置只留给「被设备限制挡住」的时候，不是切号步骤。
- **加新号有向导**：注册引导会按「回到登录页 → 在 Typeless 注册登录 → 抓回管理器」走；本周额度用满时顶部也会提示可以新开一号。
- **词库只增不删**：「全部同步」把各号个人词并进本地主词库，再把缺的导回去，最后对齐到并集；支持单词增删和批量加词。
- **数据跟着系统用户，不跟着源码夹**：账号、词库、备份在  
  `~/Library/Application Support/Typeless Toolkit/`。  
  换 release 文件夹、重装源码，只要还是同一台 Mac、同一个 macOS 用户，数据还在。
- **本机接口有边界**：每次启动发一次性会话密钥；token 默认不进浏览器，只有你主动导出备份包才会带上凭证。
- **Typeless 自己更新了会说一声**：版本漂移横幅提醒抓 token、去弹窗等与 App 内部实现绑在一起的能力可能要复核；补丁失败会按当次事务回滚，不会拿旧版本备份硬盖。

---

## 环境

- macOS + Node.js **22+**
- 已安装 Typeless.app
- 系统自带：`curl`、`security`、`codesign`、`PlistBuddy`

推荐 `git clone`（保留 `.command` 可执行权限）。若用 GitHub Download ZIP，确认来源可信后在项目目录执行：

```bash
chmod +x *.command
xattr -dr com.apple.quarantine . 2>/dev/null || true
```

---

## 启动

```bash
./启动管理器.command
```

已在运行时再执行，只会打开已有页面。手动等价：

```bash
node manager.js
open http://127.0.0.1:7788
```

用完在终端 `Ctrl+C`。

顶部 **「管理连接未开启」不等于账号掉线**。账号卡片可凭已存 token 刷新用量；只有识别/抓取「当前桌面端登录的是谁」才需要管理连接。点「连接 Typeless」后页面会等到连上（若 Typeless 已普通启动，会自动重启一次以打开调试口）。

单独拉起带调试口的 Typeless 可用：`启动Typeless(带调试端口).command`。

---

## 用法

### 第一次

1. 启动管理器 →「连接 Typeless」
2. 在 Typeless 登录
3. 管理器「添加当前账号」
4. 「全部同步」——个人词并入本地主词库

### 再加一个账号

管理器保持开着。在 Typeless 退出并登录新号，或走页面上的 **注册新账号引导**（添加账号弹窗里也有入口）。若被设备限制拦住，先「解除设备限制」，再添加、再全部同步。

### 切号

账号卡片「切换到此号」→ 还原快照 → 重启 Typeless。  
已保存账号之间切换**不要**先重置设备。

### 词库怎么对齐

同步两步，都是只增：

1. 各账号导出 → 合并进 `Typeless词库主清单.csv`
2. 主词库缺的词再导回各账号

「全部同步」时页面会按账号逐步显示进度，而不是只给一条总结果。

可选 CLI（只动当前登录号、或你要写脚本时）：

```bash
./同步词库.command
# 或
node typeless-dict-sync.js
```

### 备份与搬家

管理器顶部有备份状态：

| 操作 | 用途 |
| --- | --- |
| 立即备份 | 写到稳定目录内 `runtime-backups/`，防本机误操作（仍是同一块盘） |
| 导出备份包 | 可带走的 JSON，换机器 / 换系统用户 / 离线保管 |
| 导入恢复 | 从备份包恢复；恢复前会先备份当前数据 |

备份包含 token 与 profile，**只在可信环境保存，不要外传**。

---

## 数据目录

稳定根目录（`macos-v2.3.0` 起默认）：

```text
~/Library/Application Support/Typeless Toolkit/
```

| 路径 | 内容 |
| --- | --- |
| `accounts.json` | 账号与 token（明文，`0600`，勿上传） |
| `profiles/` | 各账号登录态快照 |
| `Typeless词库主清单.csv` | 本地主词库 |
| `config.local.json` | 本机配置覆盖（不进 git） |
| `runtime-backups/` | 运行数据本地备份 |
| `patch-backups/` | 修改 Typeless.app 前的版本化事务备份 |

目录 `0700`，敏感文件 `0600`。仓库里旧路径名仍在 `.gitignore`。

- 同一 Mac、同一 macOS 用户：源码放哪都行，读的是这一套数据。  
- 换机器或换系统用户：导出备份包 → 新环境导入。  
- 便携/测试：设 `TYPELESS_DATA_DIR`（设置后不做自动迁移）。

从更早版本升上来时，第一次启动会把项目目录里的账号、profiles、主词库、备份、`config.local.json` 等迁进稳定目录（有冲突就停，不瞎合并）。两种做法：

1. 退出旧管理器，用新版覆盖旧项目根（不要嵌套成「旧目录/新目录/manager.js」），再跑一次  
2. `macos-v1.5.1+` 先导出备份包，新目录解压后「导入恢复」

---

## 配置

一般不用改。自动查找：

- Typeless.app：`/Applications` 或 `~/Applications`
- 用户数据：`~/Library/Application Support/Typeless`
- device cache：`~/Library/Application Support/now.typeless.desktop/device.cache`
- `app.asar`：应用包内 `Contents/Resources/app.asar`

路径不对时，在**稳定数据目录**写 `config.local.json`，不要改仓库里的 `config.json`：

```json
{
  "typeless_app": "/Applications/Typeless.app"
}
```

常用键：`typeless_app`、`cdp_port`（默认 9222）、`manager_port`（默认 7788）、`api_base`、`paywall`（自动探测失败再手工填）。

---

## 设备限制

只有 Typeless 报设备限制时才用「解除设备限制」。它会：退出应用 → 清 Keychain 设备标识 → 删 `device.cache` / `user-data.json` 等相关状态 → 清 Cookies / Local Storage → 重启 Typeless。

**会登出当前账号。** 先确认该号已在管理器保存，或你能重新登录。

Keychain 与路径整理参考 [typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device)：

- service：`now.typeless.desktop.deviceIdentifier`
- account：`now.typeless.desktop.security.auth_key`
- cache：`~/Library/Application Support/now.typeless.desktop/device.cache`

---

## 去升级 / 会员弹窗

「解除弹窗提示」会改 Typeless.app 内文件：先在 `patch-backups/` 做绑定当前版本与 SHA-256 的事务备份 → 等长替换 paywall 相关分支 → 更新 asar 与 Info.plist 完整性 → ad-hoc codesign 并校验 → 重启。

- Typeless **自动更新**可能冲掉补丁，需要再打一次；页面上的版本漂移提示就是为这类情况准备的  
- 任一步失败按**本次** before-image 回滚  
- 自动识别失败时停止、不猜测写入；可在 `config.local.json` 的 `paywall` 里指定 `file_path` / `replacements`（两侧 UTF-8 字节长度必须相同，原文在文件中唯一）

界面提示需人工恢复时（路径按你的安装位置改）：

```bash
DATA="$HOME/Library/Application Support/Typeless Toolkit"
BACKUP=$(ls -td "$DATA"/patch-backups/* | head -1)
cp "$BACKUP/app.asar" /Applications/Typeless.app/Contents/Resources/app.asar
cp "$BACKUP/Info.plist" /Applications/Typeless.app/Contents/Info.plist
codesign --force --deep --sign - /Applications/Typeless.app
codesign --verify --deep --strict /Applications/Typeless.app
```

---

## 本机服务边界

- 只监听回环地址，不开放 CORS  
- 除公开 `/api/health` 外，`/api/*` 须来自当前管理器页并携带本次启动的会话密钥  
- 常规账号/抓取接口不把 token 回给浏览器；导出备份包才是明确的出站凭证路径  
- 启动脚本用 `/api/health` 的产品标识确认端口上跑的是本管理器  

---

## 仓库里有什么

| 路径 | 作用 |
| --- | --- |
| `manager.js` / `manager.html` | 管理器后端与页面 |
| `lib/common.js` | 路径、CDP、API、同步、补丁等 |
| `lib/runtime-data.js` | 稳定目录、迁移、权限 |
| `lib/local-api-security.js` | 会话与请求校验 |
| `lib/patch-transaction.js` | 补丁事务与回滚 |
| `typeless-dict-sync.js`、`*.command` | 备用 CLI / 双击入口 |
| `test/` | 零依赖测试 |
| `CHANGELOG.md` | 版本说明 |

```bash
node --test test/*.test.js
```

---

## 致谢

- [Jia131313/typeless-toolkit](https://github.com/Jia131313/typeless-toolkit) — 早期代码基础。本仓库已独立演进与发版，**不再跟踪或合并上游**。  
- [estarpro1022/typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device) — macOS 设备标识相关路径整理。  
- [LINUX DO](https://linux.do/) — 反馈与支持。

---

## 免责声明

**本工具仅供 24 小时内的学习与技术交流，请于下载/使用后 24 小时内自行删除。**

> [!IMPORTANT]
> **请支持 Typeless 官方付费与订阅。** 本工具只面向个人本机数据管理与技术原理学习，请勿用于规避或损害官方正当付费机制。

- 旨在理解 Electron asar 完整性、CDP、多账号登录态等；仅供个人学习研究  
- **不得用于规避付费、违反服务条款，或任何商业用途**（盈利、贩卖、商业分发等）  
- Typeless 及相关商标、著作权归原权利人；本项目与官方无关联、赞助或背书  
- 使用后果（账号、数据、应用损坏、法律责任等）由使用者自行承担  
- 使用前请阅读 Typeless 服务条款；当地法律或条款禁止则请勿使用  
- 继续使用即视为已阅读并同意本声明  

---

## License

MIT
