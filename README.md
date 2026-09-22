# Typeless Toolkit for macOS

[![test](https://github.com/bigbobro/typeless-toolkit-mac/actions/workflows/test.yml/badge.svg)](https://github.com/bigbobro/typeless-toolkit-mac/actions/workflows/test.yml)

当前版本：[v2.9.0](https://github.com/bigbobro/typeless-toolkit-mac/releases/tag/macos-v2.9.0)。运行中的工具版本显示在管理器页面标题旁。

给 **macOS 上的 Typeless** 用的本机管理器：把多个账号收在一个页面里，切号、对齐词库、处理设备限制、去掉升级/会员弹窗。数据只留在本机，打开浏览器操作，不用注册云端、也不用 `npm install`。

**只做 Mac。** 路径探测、Keychain、codesign、稳定数据目录都按 macOS 桌面端设计；不维护其他平台。

本仓库已从早期 fork 网络脱离，[独立维护](https://github.com/bigbobro/typeless-toolkit-mac)。功能、界面、数据位置和发版以这里为准；版本记录见 [CHANGELOG.md](./CHANGELOG.md)。历史上受益于 [Jia131313/typeless-toolkit](https://github.com/Jia131313/typeless-toolkit) 与 [estarpro1022/typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device)，致谢见文末——**日常使用不必关心上游**。

---

## 管理器能帮你什么

日常入口只有一个本地页面（`http://127.0.0.1:7788`）。CLI 是备用，可以当不存在。

- **多账号在同一页**：保存登录凭证和本机快照；刷新列表时校验登录凭证，失效卡片直接提供重新登录和移除入口，网络异常显示状态未确认。
- **切号不折腾设备**：点「切换到此号」即还原该号快照并重启 Typeless。设备 ID 重置只留给「被设备限制挡住」的时候，不是切号步骤。
- **按词数提醒或轮动**：后台定时检查当前账号本周用量，接近自设阈值时弹出 macOS 确认框，也可选择达到阈值后直接切换。默认关闭，需在「轮动设置」启用。
- **加新号有向导**：注册引导会按「回到登录页 → 在 Typeless 注册登录 → 抓回管理器」走；本周额度用满时顶部也会提示可以新开一号。
- **词库只增不删**：「全部同步」把各号个人词并进本地主词库，再把缺的导回去，最后对齐到并集；支持单词增删和批量加词。**注意「删」只对单个账号的云端生效**，主词库会在下次同步时把它灌回来，见「词库怎么对齐」。
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

升级时先在运行旧管理器的终端按 `Ctrl+C`，再更新源码（Git 安装用 `git pull --ff-only`，ZIP 安装用新版源码替换旧源码），重新运行 `./启动管理器.command`。刷新页面后，确认标题旁的版本号已更新。

仅关闭网页不会退出管理器；旧进程仍在运行时，启动脚本会复用它。同一台 Mac、同一个 macOS 用户升级时，已保存的账号、快照和主词库仍使用原数据目录。

顶部 **「管理连接未开启」不等于账号掉线**。读取额度、词库和个人统计需要保持 Typeless 的管理连接：工具会调用本机官方客户端生成请求校验信息。点「连接 Typeless」后页面会等到连上并重新读取账号统计（若 Typeless 已普通启动，会自动重启一次以打开调试口）。日常刷新不会自行重启应用；连接不可用时会显示操作指引。

单独拉起带调试口的 Typeless 可用：`启动Typeless(带调试端口).command`。

**调试口默认是 9222，容易被别的工具抢**（浏览器自动化框架、Chrome 远程调试等都爱用这个端口）。端口被占时 Electron 只会静默绑不上，Typeless 看着正常但连不上管理连接。工具现在会直接报「管理端口已被其它程序占用」，不再反复重启 Typeless。解法二选一：退出占用端口的程序，或在 `config.local.json` 里把 `cdp_port` 换成没人用的端口（如 9333）。想确认谁占着：

```bash
lsof -nP -iTCP:9222 -sTCP:LISTEN
```

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

账号卡片「切换到此号」→ 验证登录凭证 → 还原快照 → 重启并确认目标账号已登录 → **自动同步该号词库**。
已保存账号之间切换**不要**先重置设备。

快照存在、凭证标示未到期，也不代表服务器仍接受这份登录凭证。失效账号会显示「登录已失效」，不能直接切换。点「重新登录」按引导登录原账号，再读取并保存，会更新原记录的凭证和快照，不会产生重复卡片；也可以直接用「添加当前账号」更新同一个账号。

不再使用的账号可点「移除」让卡片从列表消失；操作不注销 Typeless 账号，不删除云端词库，本地旧快照和备份仍保留。移除后的提示提供重新添加入口。

切号确认登录成功后再同步词库，两件事分别报结果；同步失败不影响已经完成的切换。重新登录更新原记录时不重复导入词库。

详情页的「更新登录」与「重新登录」共用同一条流程，一起更新凭证和快照，并校验当前账号及刷新凭证的有效性。读取结果过期或期间切换了账号，会回到读取步骤。保存后若词库导入失败，账号仍会显示；在详情页点「从主词库导入」重试。

切换失败会恢复切换前的登录文件、重启并验证原账号。若原登录也未恢复，会保留切换前备份并显示路径，同时引导重新登录，不会报告切换成功。账号列表刷新失败时保留已显示的卡片，标明信息可能过时，并提供重试。

### 按词数轮动

在页面的 **「轮动设置」** 中启用后台检查，选择阈值、检查间隔和处理方式。用量采用 Typeless 接口返回的**当前账号本周累计词数**，不是从启用轮动或上次切号开始重新计数。

| 设置 | 默认值与行为 |
| --- | --- |
| 启用后台轮动检查 | 默认关闭 |
| 轮动阈值 | 2,000 词，可自行调整 |
| 提前提醒量 | 100 词，即默认达到 1,900 词时提醒；仅提醒模式使用 |
| 检查间隔 | 每 15 分钟一次，可选 10、15、30 分钟 |
| 提醒确认 | 默认模式，弹出 macOS 原生确认框，选择「切换账号」或「稍后」 |
| 自动切换 | 检查发现达到阈值时直接切换，不再询问 |

启用或重新保存设置后会检查一次，之后按所选间隔检查。页面和确认框都会明确显示间隔；两次检查之间用量可能已越过提醒线或阈值，不能保证恰好在第 1,900 或 2,000 词触发。

提醒是独立于网页的系统确认框，**不是通知中心里带按钮的横幅**。90 秒未操作会保持当前账号，下一轮检查仍达到条件时会再次提醒。主动选择「稍后」后，同一账号在用量重置前不再提醒；检测到周用量下降时视为额度重置，允许再次提醒。重新保存设置或修复账号后也会允许重新评估。切换成功后使用 macOS 系统通知告知结果，其显示受系统通知设置影响；通知发送失败不会改变切号结果，页面会保留最近结果与通知错误，后续检查会重试通知，不重放已完成的切换。

**切号会重启 Typeless，可能中断正在进行的语音输入。** 提醒模式下，请先结束输入并等文字输出完成，再确认切换；自动模式不会等待这一步。候选账号按页面保存顺序循环查找，跳过快照缺失、登录不可用、已达到轮动阈值或官方额度上限的账号，不重置设备。切号成功后同步词库，词库同步失败会单独说明，不影响切号结果。

后台检查只需管理器进程持续运行，**关闭网页不影响检查和提醒，关闭启动终端或按 `Ctrl+C` 会停止后端**。读取用量仍需 Typeless 管理连接；普通监测不会自行启动或重启 Typeless。断网或读取失败会显示原因并在下个周期重试；实际切换失败会走登录回滚并暂停轮动，检查原因后重新保存设置可恢复。

临时网络或认证错误先按周期重试，连续两轮仍失败才弹出恢复引导；缺少账号、登录失效等明确需要处理的问题会直接提示。引导提供「打开管理器」和「稍后」：主动选择后，同一问题不再每轮重复弹出；90 秒未操作或提示未能送达时，下轮会重试提醒。页面轮动区持续显示当前问题、候选账号不可用的原因及下一步入口：添加当前账号、更新指定账号登录、连接 Typeless、查看账号或修改轮动设置。更新登录前需先在 Typeless 登录相应账号；未暂停时，完成恢复后的下一次检查会重新评估。暂停状态只重试待处理的提醒，不继续查询用量或切号，仍需重新保存设置才能恢复。系统提示中的管理器入口可定位到 `#rotation` 轮动区。

工具不能从所有登录或切号失败中可靠识别设备限制，**不会把未知异常当成设备限制，也不会自动重置设备**。若 Typeless 自身明确提示设备限制，可使用现有「解除设备限制」入口，仍需用户确认。

后端只维护一个不重叠的检查计时器，平时只查询当前账号用量，需要切换时才按顺序检查候选。网页不另设轮动轮询；状态在打开页面、刷新或重新聚焦时更新。当前没有开机自启或 LaunchAgent，也无需额外依赖。

### 词库怎么对齐

词库操作需要先连接 Typeless。工具用已保存的刷新凭证换取同账号访问令牌，再通过本机官方运行时生成请求校验头；多账号同步无需逐个切换桌面端登录。访问令牌只短暂缓存在内存中，签名密钥不提取、不保存。官方客户端更新若改变内部接口，工具会明确报错；读取失败不会被显示为空词库或零用量。

同步两步，都是只增：

1. 各账号导出 → 合并进 `Typeless词库主清单.csv`
2. 主词库缺的词再导回各账号

「全部同步」先读取所有账号并汇总主词库，再给各个读取成功的账号补齐同一份并集，一次操作即可对齐。读取或导入失败的账号会单独列出，其他账号继续处理；完成后显示成功 / 失败数量。

> [!WARNING]
> **删词只删单个账号的云端，不删主词库。** 因为同步只增不删，只要还有**任何一个**账号持有这个词，下次同步就会把它并回主词库、再发回所有账号。要永久删掉一个词，得在**所有持有它的账号**里都删一遍，**再**到「✎ 主词库编辑」删掉那一行。
> 触发面比想象宽：切号后会自动同步该账号，你不点任何按钮词也会回来。

工具栏的 **↓ 导出词库** 会下载已保存的主词库，文件名为 `Typeless词库.csv`：单列、无表头，一行一个词，采用 UTF-8 编码并带 BOM，支持中文及包含逗号、引号的词条。导出只读取本地数据，无需连接 Typeless；如需包含各账号最新词条，先执行「全部同步」。主词库编辑中的修改需先保存再导出。

**✎ 主词库编辑** 直接改 `Typeless词库主清单.csv` 的内容（保存即写盘）；**↻ 全部刷新** 重新拉一遍所有账号的额度与状态。

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

轮动设置和提醒记录单独保存在 `rotation.json`，不包含在上述本地备份或导出备份包中，导入账号备份也不会覆盖它们。换机器后需重新配置轮动。

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
| `rotation.json` | 轮动设置、暂停状态、最近结果与去重记录；不含凭证，不纳入账号 / 词库备份包 |
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

想知道工具实际探测到了哪个 `app.asar`、哪个数据目录，点工具栏的 **◇ 诊断** —— 它是只读的，会把路径、端口、账号数、数据目录一次列出来。

---

## 设备限制

只有 Typeless 报设备限制时才用「解除设备限制」。它会：退出应用 → 清 Keychain 设备标识 → 删 `device.cache` / `user-data.json` 等相关状态 → 清 Cookies / Local Storage → 重启 Typeless。

**会登出当前账号。** 先确认该号已在管理器保存，或你能重新登录。

若提示「设备清理未完成」，可能已有部分步骤执行，工具会显示失败原因并重新启动 Typeless。按错误提示处理后重试，并在 Typeless 重新登录；切回已保存账号需要完整快照和仍有效的登录凭证。

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
| `manager.js` | 管理器后端 |
| `manager.html` / `manager.css` / `manager-ui.js` | 管理器页面（结构 / 样式 / 脚本） |
| `lib/common.js` | 账号、快照、API、同步、版本漂移；装配 paths / private-fs / cdp / runtime-backup / paywall-patch 并统一对外转发 |
| `lib/paths.js` | 路径探测与配置加载（启动时一次算好） |
| `lib/cdp.js` | CDP 管理连接（端口探测、目标校验、读取主进程身份和刷新凭证） |
| `lib/typeless-api.js` | 访问令牌刷新、按账号隔离缓存、调用官方运行时生成请求校验头 |
| `lib/account-rotation.js` | 轮动设置、单计时器调度、用量阈值判断与提醒去重 |
| `lib/rotation-issues.js` | 轮动异常分类与对应恢复入口；未知错误不推断设备限制 |
| `lib/rotation-notifier.js` | macOS 原生确认框与结果通知，提示超时和取消时释放子进程 |
| `lib/runtime-backup.js` | 运行数据备份 / 恢复事务 |
| `lib/paywall-patch.js` | 去弹窗补丁（asar 解析、等长替换、重签名） |
| `lib/private-fs.js` | 私有目录与原子写入 |
| `lib/runtime-data.js` | 稳定目录、迁移、权限 |
| `lib/local-api-security.js` | 会话与请求校验（由 `manager.js` 直接使用） |
| `lib/patch-transaction.js` | 补丁事务与回滚（由 `lib/paywall-patch.js` 使用） |
| `typeless-dict-sync.js`、`*.command` | 备用 CLI / 双击入口 |
| `test/` | 零依赖测试（脱机可跑） |
| `.github/workflows/` | CI：macOS + Node 22 跑 `npm test` |
| `package.json` | 版本号与测试入口，**不声明任何依赖** |
| `CHANGELOG.md` | 版本说明 |
| `config.json` | 默认配置（本机覆盖写 `config.local.json`，见「配置」） |
| `accounts.example.json` | `accounts.json` 的字段样例（真实文件不进 git） |
| `LICENSE` | MIT |
| `.gitignore` | 运行数据一律不进 git |

```bash
npm test
```

---

## 致谢

- [Jia131313/typeless-toolkit](https://github.com/Jia131313/typeless-toolkit) — 早期代码基础。本仓库已独立演进与发版，**不再跟踪或合并上游**。  
- [estarpro1022/typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device) — macOS 设备标识相关路径整理。  
- [LINUX DO](https://linux.do/) — 反馈与支持。

---

## 免责声明

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
