# openlibing-staticcheck

`olb mr` 查询 GitCode MR 的 OpenLiBing 静态检查报告及失败问题，也能申请屏蔽。先看命令帮助：

```sh
olb --help
olb mr --help
olb mr report --help
olb mr shield --help
```

查询 MR 只需在运行 `olb` 的机器上登录官方 OpenLiBing CLI 和 GitCode CLI：

```sh
openlibing-cli auth login
gc auth login
olb mr report 531
```

先进入已配置 GitCode 远端的仓库，传 MR 编号即可；`olb` 会调用 `gc pr view` 获取该 MR 的信息。

`olb login` 等浏览器会话命令是另一组功能，使用自己的会话文件。登录、验证码及授权均由站点页面处理；CLI 不接收账号密码。支持在有桌面的机器登录，再把会话导入无桌面的机器。

要求 Node.js 20+。发布到 npm 后可安装：

```sh
npm install -g openlibing-staticcheck
```

从本地源码安装：

```sh
npm install
npx playwright install chromium
npm link
```

使用：

```sh
olb login
# 在弹出的浏览器里完成登录，再回终端按 Enter
olb open
olb status
olb logout
```

跨机器登录：在**有图形桌面的机器**上安装本项目并运行：

```sh
olb export --file ./openlibing-session.json
# 在浏览器里完成登录，回到目标页面后按 Enter
```

通过 `scp` 等安全方式将 `openlibing-session.json` 复制到无桌面的目标机器，然后在目标机器运行：

```sh
olb import --file ./openlibing-session.json
olb check
```

会话文件包含站点 Cookie、localStorage、IndexedDB 和当前页面的 sessionStorage，等同登录凭据。不要提交到 Git 或通过公开渠道发送；复制完成后可删除导出文件。站点可能将会话绑定到设备或 IP，因此跨机器复用需要实际验证。`check` 输出 HTTP 状态、最终 URL 和页面标题；这些信息本身不足以证明已登录，如需确认页面内容，需要再按站点实际表现检查。

`login`、`export`、`open` 和 `check` 默认打开提问中的代码检查页面，也可以通过 `--url https://www.openlibing.com/...` 指定站内页面。`--profile 目录` 可指定独立的浏览器会话目录；默认是 `~/.config/openlibing-cli/browser`。`status` 只检查本机会话目录是否存在，不向站点验证登录状态。

如果本机已有 Chromium，可设置 `OLB_BROWSER_PATH=/path/to/chrome` 使用它，无须下载 Playwright 浏览器。`login`、`export` 和 `open` 需要图形桌面环境；`check` 使用无界面浏览器。
如果提示缺少浏览器系统库，请运行 `npx playwright install-deps chromium`。

如果打开页面出现站点防护拦截，请在浏览器中按站点提示处理；CLI 不尝试绕过站点防护。

## GitCode MR 静态检查

先全局安装官方 `@openlibing/openlibing-cli` 并运行 `openlibing-cli auth login`；同时安装 GitCode CLI `@gitcode-cli/cli` 并运行 `gc auth login`。`olb mr` 复用两者保存在本机的登录凭证，无需图形界面。当前这组命令属于本项目的 `olb`，尚未加入官方发布包。

命令会从 GitCode 门禁日志或 MR 评论中的原始报告链接读取 OpenLiBing 项目 ID，不根据组织名猜测。若没有报告链接，或存在多个项目 ID，需从已知的报告页面 URL 取得 ID，并通过 `--project-id` 或 `OPENLIBING_PROJECT_ID` 指定。

```sh
olb mr report 531
olb mr report 531 --task-id MR_7b9e007721a04d6c8f9e9b5ff13dd979
```

输出 JSON 包含 `latest`（最新扫描）、`scanCount`（匹配扫描数）和 `scans`（最近至多 10 次扫描）。报告链接优先通过已登录的 GitCode CLI `gc` 从该 MR 的 `CodeCheck` 门禁 Job 日志读取；日志不可用时从 MR 评论补充，并按扫描 ID 与 UUID 精确匹配。`reportUrlSource` 标明来源；若两处都没有对应链接，`reportUrl` 为 `null`，命令不会拼造链接。读取 Job 日志需要系统安装 `unzip`。失败扫描会附带 `issues` 全部问题明细及当前状态；指定 `--task-id` 可读取较早的某次扫描。只有扫描执行状态为 `Success` 时，其 `result`（`pass` 或 `failed`）才是有效检查结论。

要申请屏蔽，先从报告确认扫描 ID、问题行号与当前状态，再运行：

```sh
olb mr shield 531 --project-id 300033 --task-id '<扫描ID>' \
  --lines 1785,1786 --reviewer Zhendong404 --reason '除零错误的静态检查一直不准' --shield-type 2
```

`--shield-type` 是必填的屏蔽类别 ID；`2` 是“工具误报”，其他 ID 见 `olb mr shield --help`。`--reason` 是自由填写的说明文字。命令仅接受该扫描中尚未处理（状态 `0`）且每行唯一的问题。成功后输出 `submitted: true` 和审核链接 `approvalUrl`；若站点未返回链接，会输出 `linkError`，申请仍已提交，请勿重复运行。站点的审核和最终状态以审核页面为准。
