# 0.13.0 本机验收记录

日期：2026-10-20。Windows 0.13.0 / 扩展 0.5.3。基线与未关闭项：[实施进度](./implementation-progress.md)。本版接入普通 Web/表格采集创建恢复，不代表 Temu 实站、官方平台或全部需求已验收。

## 本版实现

- 普通采集页面从直接建任务改为“保存服务端草稿 → 幂等提交 → 展示任务 ID → 确认清除草稿”。成员私有输入保存在工作空间 SQLite，不依赖浏览器 localStorage，不需要重新选择原表格，也不因客户端动态端口变化丢失请求。
- 每个成员一个待确认槽位；首次商品/规则固定，多页签同时提交复用该槽位。确认或明确放弃会推进代际，旧页面不能补建新任务，迟到的旧确认不能清除新草稿。放弃需确认，不删除已有任务、图片及持久创建回执。
- 成员身份、CSRF、角色与所有权继续校验；任务转移后旧草稿不泄露新所有者的进度，损坏记录仍能明确放弃。备份包含草稿；恢复后未提交的旧创建世代停止，已保留回执可以回放。
- 中文表格名使用现有文件名解码工具，避免 multipart Latin-1 误读。兼容直接 multipart 调用方提供请求键；没有键的旧调用方仍是兼容语义，不冒称受新页面流程保护。

## 验证

| 项目 | 最终结果 |
| --- | --- |
| 后端完整回归 | 573/573，独立临时工作空间 |
| 新增草稿专项 | 10/10，含真实 HTTP 断线和子进程退出 |
| 成员隔离专项 | 16/16，含新增真实 Web 会话/CSRF/草稿越权检查 |
| 前端完整回归 | 186/186，含 4 项新增草稿编排/API 测试 |
| 桌面单元 | 8/8 |
| 最终源码 Electron | 79/79，version=0.13.0，packaged=false |
| 最终便携 EXE | 79/79，version=0.13.0，packaged=true |
| 包资源 | 5,956 项；禁入、缺失和源码散列不一致均为 0；49 项前端构建文件，SQLite/Sharp 存在 |
| 生产构建 | 通过；主入口 360.12KB / gzip 118.39KB |

专项已验证 HTTP 草稿响应和建任务响应分别在提交后断开、真实子进程中断、成员隔离和权限、表格无需重传、损坏记录、备份恢复和迟到确认。

真实 Electron 窗口增加动态端口变化后加载草稿、模拟建任务回复丢失、刷新后点击继续找回同一任务、通过 UI 上传表格并按销量过滤。源码与最终 EXE 证据分开记录，不以前版通过数量替代。

源码最终报告：desktop/.smoke-data/source-0.13.0-drafts-final/smoke-report.json；已查看该目录 workspace/collection-draft-preview.png，恢复提示、原规则摘要和禁用表单布局正常。早期检查点 source-0.13.0-drafts 也通过，但不替代包含最终中文文件名修复的报告。

最终便携版报告：desktop/.smoke-data/portable-0.13.0-drafts/smoke-report.json。运行实际 portable EXE，使用独立测试根目录，并去掉仅测试子进程继承环境中的 ELECTRON_RUN_AS_NODE 标志；没有重启用户当前客户端或改动真实业务空间。

| 制品 | 大小（字节） | SHA-256 |
| --- | --- | --- |
| desktop/release/Crossborder-Workbench-Portable-0.13.0.exe | 119282042 | A530E244735AC24DB402D960FC0341417F2B1F49EE0DE463F53CACB922DA6136 |
| desktop/release/Crossborder-Workbench-Setup-0.13.0.exe | 119512006 | 0977346E1DED06588564FF21409B695068E0B31C9D6D5A8777E84C14FA3285D5 |

最终记录在构建后填写，以仓库文件为准；包内文档保留构建检查点。安装版已生成，未在干净机器安装/卸载，未配置 Windows 代码签名。不得把本机便携 EXE 通过等同于干净机或 SmartScreen 验收。

## 开发接口与状态

所有接口前缀为 `/api/workbench`，仅当前管理员或运营成员自己的草稿可用；管理员不会借此接口隐式读取其他成员草稿。Web 写请求仍须会话及 CSRF。没有在扩展授权范围中开放草稿接口。

| 接口 | 语义 |
| --- | --- |
| GET /collection-drafts | 返回当前成员、槽位 generation 和待确认草稿摘要，不返回完整商品输入 |
| POST /collection-drafts/rows | JSON：rows/options/expectedActorId/generation；先存草稿，不创建图片任务；活跃槽位返回第一次输入 |
| POST /collection-drafts/sheet | multipart：sheet/options/expectedActorId/generation；解析并保存记录，不要求恢复时重传表格 |
| POST /collection-drafts/:id/submit | JSON：expectedActorId；使用草稿 ID 作为持久请求键创建或找回当前任务，201 首次、200 复用 |
| POST /collection-drafts/:id/ack | JSON：expectedActorId/jobId；仅确认对应任务后清除草稿并推进代际，迟到旧确认不能清除新草稿 |
| POST /collection-drafts/:id/discard | JSON：expectedActorId/confirm=true；明确放弃，推进代际，但保留既有任务和回执 |

每成员一个槽位只限制“尚未确认取得 ID 的创建请求”，不限制已有或运行中任务数量。前端不会在超时后自动创建新一轮，也不会回退旧无键入口。直接 multipart `/collection-jobs` 调用方可提供 clientRequestId/creationEpoch，但必须自行持久化身份和首次输入；新版页面优先使用草稿流程。

创建回执的 prepared/ready 与草稿是两个独立生命周期：确认或放弃只清除草稿；长期回执仍用于防重复。正常重启/换端口不丢草稿；恢复到不包含这些记录的旧备份、数据库丢失或人为删表并非自动恢复保证，需要先检查任务中心和备份。

## 边界

一份待确认草稿不是所有文档的无限期备份。正常请求结束删除临时表格；意外进程退出可能留下临时文件，业务草稿与备份按工作空间策略保留。确认清除草稿不回溯删除旧备份。当前是单工作空间/单服务模型，不宣称多机 SaaS 分布式事务。

完整双语、真实服装图质量、Temu 实站图片回传与人工验证码恢复、模型权重许可、最新官方模板平台导入、干净 Windows 安装/卸载、签名和公网部署仍未关闭。未关闭用户 Edge/旧客户端，未下载权重、绕过验证码、发布商品、线上改价或推送 Git。
