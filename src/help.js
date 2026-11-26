export const help = {
  root: `olb — 查询 GitCode MR 的 OpenLiBing 静态检查报告

快速开始（在运行 olb 的机器上执行）：
  npm install -g @openlibing/openlibing-cli @gitcode-cli/cli
  openlibing-cli auth login
  gc auth login
  olb mr report 531

请先进入已配置 GitCode 远端的仓库。olb 通过 gc pr view 获取 MR 信息。

MR 命令：
  olb mr report <MR 编号> [--task-id 扫描ID] [--project-id 项目ID]
  olb mr shield <MR 编号> --task-id 扫描ID --lines 行号[,行号...] --reviewer 用户名 --reason 理由 --shield-type 类别ID [--project-id 项目ID]

先运行 report 查看最新扫描和失败问题，再用 shield 申请屏蔽。MR 命令复用上述两个 CLI 的登录状态，无需图形界面。

其他命令：
  olb login | export | import | check | open | status | logout
  这些命令管理 olb 自己的浏览器会话；MR 命令不使用该会话。

详细帮助：olb mr --help、olb mr report --help、olb mr shield --help、olb help browser`,

  mr: `olb mr — GitCode MR 静态检查

准备：
  openlibing-cli auth login    登录官方 OpenLiBing CLI
  gc auth login                登录 GitCode CLI

查询：
  olb mr report 531

在已配置 GitCode 远端的仓库执行。olb 使用 gc pr view 获取 MR 信息。

申请屏蔽：
  先从 report 的失败扫描中确认 taskId 和 issues 的 lineNumber。
  olb mr shield 531 --task-id '<taskId>' --lines 1785,1786 --reviewer Zhendong404 --reason '除零错误的静态检查一直不准' --shield-type 2

报告链接来自 GitCode 门禁日志或 MR 评论。无法从链接确定唯一项目 ID 时，用 --project-id 指定报告链接中的 projectId。
详细帮助：olb mr report --help、olb mr shield --help`,

  report: `用法：olb mr report <MR 编号> [--task-id 扫描ID] [--project-id 项目ID] [--timing]

示例：
  olb mr report 531
  olb mr report 531 --task-id MR_7b9e007721a04d6c8f9e9b5ff13dd979

请在已配置 GitCode 远端的仓库运行。olb 用当前仓库的 gc pr view 查询 MR。
加 --timing 会将各阶段耗时和占比写到标准错误输出，不影响报告 JSON。

输出 JSON：
  latest        最新扫描；result 为 pass 或 failed，且 checkStatus 为 Success 时结论才有效
  scanCount     此 MR 的扫描总数
  scans         最近最多 10 次扫描；--task-id 可查询指定扫描
  scans[].issues 失败扫描的问题明细；其中 lineNumber 是问题行号
  scans[].reportUrl 原始报告链接；未找到时为 null
  scans[].reportUrlSource 链接来源：gitcode-gate-log 或 gitcode-mr-comment

项目 ID 通常从 GitCode 门禁日志或 MR 评论中的报告链接取得。若无法确定唯一 ID，可加 --project-id，或设置 OPENLIBING_PROJECT_ID。读取门禁日志需要 unzip。
运行前需登录：openlibing-cli auth login 和 gc auth login。`,

  shield: `用法：olb mr shield <MR 编号> --task-id 扫描ID --lines 行号[,行号...] --reviewer 用户名 --reason 理由 --shield-type 类别ID [--project-id 项目ID]

先运行 olb mr report 531，从失败扫描取得 taskId，并核对 issues 中的 lineNumber 和状态。数字编号需要在已配置 GitCode 远端的仓库中使用。

示例：
  olb mr shield 531 --task-id MR_7b9e007721a04d6c8f9e9b5ff13dd979 --lines 1785,1786 --reviewer Zhendong404 --reason '除零错误的静态检查一直不准' --shield-type 2

--shield-type 是屏蔽类别 ID，必须显式指定：
  0 已审核通过未解决    1 无风险评估          2 工具误报
  3 开源第三方          4 其他                5 性能敏感
  6 兼容第三方          7 不支持的内核        8 规范例外场景

--lines 仅接受该扫描中尚未处理、且每个行号唯一对应一个问题的行号。
成功后 JSON 中的 submitted 为 true；approvalUrl 是发给审核人的链接。若返回 linkError，申请已经提交，请勿重复运行。
若无法从报告链接确定唯一项目 ID，可用 --project-id 指定。`,

  browser: `olb 浏览器会话命令（与 olb mr 使用的官方 CLI 登录状态不同）

  olb login [--url 页面地址] [--profile 目录]   在有图形桌面的机器登录
  olb export --file 文件 [--profile 目录]     在有图形桌面的机器导出会话
  olb import --file 文件 [--profile 目录]     在另一台机器导入会话
  olb check [--url 页面地址] [--profile 目录]  无界面访问页面并显示响应
  olb open [--url 页面地址] [--profile 目录]   复用会话打开页面
  olb status [--profile 目录]               查看本机会话目录
  olb logout [--profile 目录]               删除本机会话

跨机器使用：在图形机器执行 olb export --file ./session.json，安全复制文件后，在目标机器执行 olb import --file ./session.json。会话文件包含登录凭据。`,
};
