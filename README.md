# Typeless 工具集(公开版)

Typeless 桌面端的多账号管理 + 个人词库跨账号同步 + 去升级弹窗补丁工具集。
纯 Node.js + 单页前端,无外部依赖,Windows 平台。

## 这是什么

[Typeless](https://typeless.com/) 是一款语音听写桌面应用(Electron)。本工具集围绕它的几个
实际使用痛点提供本地辅助:

- **多账号管理**:一台机器上切换多个 Typeless 账号,各自保留登录态快照,一键切换。
- **词库跨账号同步**:把多个账号的个人词库(含系统自动学习的 auto 词)合并成一份主清单,
  再回灌到每个账号,换号不丢词。
- **解除设备限制**:重置设备 ID,准备注册新账号。
- **去升级/会员弹窗**:对 Electron 的 asar 两层完整性校验打等长字节补丁,关掉付费墙弹窗。

## 原理简述

- **个性化 = 词库可同步 + 风格不可导出**:Typeless 的「个性化」主要来自个人词库(手动加的词 +
  系统自动学习的词),这些都能通过官方 API 导出/导入;而说话风格模型不可导出,跨账号无法迁移。
- **多账号切换 = 登录态快照**:Typeless 把登录凭证存在 `%APPDATA%\Typeless.exe\` 下的几个
  JSON 文件里。把这些文件按账号 snapshot 存好,切换账号时还原对应快照并重启即可。
- **设备限制 = Credential Manager 设备 ID**:Typeless 用 Windows Credential Manager 的
  `Typeless.deviceIdentifier` 凭据 + `%APPDATA%\Typeless\Cache\device.cache` 绑定设备。
  删掉这两处(外加清登录态)即可重置成「新设备」。
- **去弹窗 = 两层 asar 完整性补丁**:Electron 有两道 asar 完整性校验——asar 头里每个文件的
  per-file SHA256,以及 exe 内嵌的整头 SHA256。改 asar 内容必须同时更新这两层,否则启动闪退。
  本工具用等长字节替换(`gn(x)` → `(0,x)`)把付费墙渲染函数调用变成无操作表达式。

## 安装要求

- **Node.js 18+**(用了原生 `WebSocket`、`fetch`)
- **Windows**(脚本用了 `taskkill`、`cmdkey`、`tasklist`)
- **curl**(Windows 10 1803+ 自带;用于调 Typeless API,自动走系统代理)
- **已安装 Typeless 桌面端**
- **无需管理员权限**:Typeless 装在用户目录(`%LOCALAPPDATA%`),app.asar/exe/设备凭据都在当前用户权限内,普通权限即可运行(改 exe 会让 Authenticode 签名失效,但本机仍可运行)

## 快速开始

1. **配置**(可选):打开 `config.json`,若 Typeless 不在默认安装路径,填 `typeless_exe`。
2. **启动管理器**:双击 `启动管理器.bat`(或 `node manager.js`),浏览器自动打开
   `http://127.0.0.1:7788`。
3. **添加账号**:在 Typeless 里登录第一个账号 → 管理器点「添加当前账号」(会自动抓 token)。
4. **同步词库**:点「全部同步」,各账号词库自动对齐到主 CSV。
5. **切换账号**:账号卡片点「切换到此号」(从快照还原 + 重启 Typeless)。
6. **解除弹窗**:点「解除弹窗提示」(首次自动备份 `.bak`,失败自动还原)。

也可以不用管理器,直接命令行跑词库同步:`同步词库.bat`(或 `node typeless-dict-sync.js`)。

## 功能列表

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 账号管理 | 管理器 | 添加/移除/切换账号,实时显示额度、词库数、个性化进度 |
| 词库同步 | 管理器 / CLI | 导出各账号词库到主 CSV,再把缺失词回灌(只增不删) |
| 主词库编辑 | 管理器 | 一行一个词,作为所有账号同步的基准 |
| 跨账号复制词库 | 管理器 | 把某账号词库整份导入另一账号 |
| 解除设备限制 | 管理器 | 重置设备 ID,准备注册新账号 |
| 去升级弹窗 | 管理器 | asar + exe 两层等长补丁,关掉付费墙 |
| 带调试端口启动 | bat | `--remote-debugging-port=9222` 启动 Typeless,供 CDP 抓 token |

## 配置说明

`config.json`(用户可改,默认值无隐私):

```json
{
  "typeless_exe": "",            // 留空=自动探测 %LOCALAPPDATA%\Programs\Typeless\Typeless.exe
  "cdp_port": 9222,              // CDP 调试端口
  "manager_port": 7788,          // 管理器 HTTP 端口
  "api_base": "https://api.typeless.com",
  "master_csv": "Typeless词库主清单.csv",
  "paywall": {
    "file_path": ["dist", "renderer", "static", "js", "2J71HyJ6.mjs"],
    "replacements": [
      ["gn(_0x1c3e62)", "(0,_0x1c3e62)"],
      ["gn(_0x2d6844)", "(0,_0x2d6844)"]
    ],
    "auto_detect_file": true
  }
}
```

- `typeless_exe` 留空时按优先级探测:config → 环境变量 `TYPELESS_EXE` → 默认安装路径 → 报错。
- `paywall.file_path` 是 v1.8.0 的值(示例);`auto_detect_file=true` 时若找不到会自动遍历
  asar 内 `.mjs` 文件找含 `paywall` 的那个。
- `paywall.replacements` 是 minified 变量名,**无法自动推测**,版本变了需手动定位(见下)。
- 本地私有覆盖可写在 `config.local.json`(已 `.gitignore`,不会进 git)。

## 各版本弹窗补丁适配

Typeless 更新后,`.mjs` 文件名和 minified 变量名(`gn`、`_0x1c3e62` 等)可能改变。
若管理器报「未找到标记 X」,说明你的版本与 config 默认值不同,需要:

1. 用 `npx asar extract` 或 7-Zip 解开 `app.asar`。
2. 在 `dist/renderer` 下 grep `paywall`,定位渲染层 `.mjs` 文件。
3. 用 DevTools(浏览器开 `http://127.0.0.1:9222`)在 `onImportantNotification` /
   `onSessionInterrupt` 的 `type==='paywall'` 分支找到弹窗显示函数名。
4. 把调用改成 `(0,原参数)`(等长 3 字符替换:`gn(` → `(0,`),填入 `config.json`。

详细步骤见 [Typeless去升级弹窗补丁指南.md](Typeless去升级弹窗补丁指南.md)。

## 常见问题

**Q: 抓 token 失败 / 「CDP 无响应」?**
A: Typeless 必须带 `--remote-debugging-port=9222` 启动。用本目录的
`启动Typeless(带调试端口).bat`,或管理器的「启动 Typeless」按钮(会自动带调试端口)。

**Q: 打补丁后 Typeless 闪退?**
A: 日志若出现 `FATAL:asar_util.cc ... Integrity check failed`,说明两层完整性校验没同步好。
  管理器会自动从 `.bak` 还原;手动补丁则 `copy /Y *.bak *` 还原后重试。

**Q: Typeless 自动更新后弹窗又回来了?**
A: 自动更新会重写 `app.asar` 和 `Typeless.exe`,补丁被还原,需重打。要根治可关 Typeless 自动更新。

**Q: token 会过期吗?**
A: Typeless 的 JWT 约 1 年有效。token 失效后管理器会显示「token失效」,重新点「添加当前账号」
  抓一次新 token 即可。

**Q: 支持Mac/Linux吗?**
A: 目前仅 Windows。kill/launch 用了 `taskkill`、设备重置用了 `cmdkey`,Mac 需改用 `killall`/
  `security`。

## 免责声明

**本工具集内容仅供 24 小时内的学习与技术交流,请于下载/使用后 24 小时内自行删除。**

- 本项目旨在帮助理解 Electron 应用的 asar 完整性机制、CDP 远程调试、多账号登录态管理等技术原理,仅供个人学习与研究。
- **不得用于规避 Typeless 的付费机制、违反其服务条款,或任何商业用途。** 不得将本项目用于盈利、贩卖、分发或任何形式的商业传播。
- Typeless 软件及相关商标、著作权的全部权利归其原始权利人所有,本项目与 Typeless 官方无任何关联、赞助或认可关系。
- 使用本工具集产生的一切后果(包括但不限于账号封禁、数据丢失、应用损坏、法律责任)由使用者自行承担,作者不承担任何责任。
- 使用前请先阅读 Typeless 的服务条款;若你的所在地法律或 Typeless 条款禁止此类操作,请勿使用。
- 继续使用即视为你已阅读并同意上述声明。

## 许可证

MIT,见 [LICENSE](LICENSE)。

## 参考项目

- [estarpro1022/typeless-reset-device](https://github.com/estarpro1022/typeless-reset-device) —— 本项目的「解除设备登录限制」功能参考了该项目重置 Typeless 设备 ID 的思路(清理设备标识凭据以重新注册新账号)。

## 致谢 / Thanks

感谢 [LINUX DO 论坛社区](https://linux.do/) 的关注、反馈与支持。
