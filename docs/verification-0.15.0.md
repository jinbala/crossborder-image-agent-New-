# 0.15.0 本机验收记录

日期：2026-10-20。Windows 0.15.0 / 扩展 0.5.3。本次推进 IMAGE-003/004 与 Web 4.3 交互恢复、双语及核心图片流程。基线与完整未关闭项：[实施进度](./implementation-progress.md)。

## 功能修复与安全边界

- 抠图页原先只接受任务数组，实际 `/tasks` 返回 `{tasks:[...]}`，造成已有图片列表被丢弃。现兼容两种响应并增加刷新；采用后有反馈及 PNG 下载链接，刷新后从任务记录恢复采用项。采用显示同时绑定任务及原图，运行中锁定选择器，迟到的其他任务结果不会显示到当前任务。原图和其他结果保持不变；rembg 就绪时不会再误称“仅 Sharp 可用”。
- 商品页初始读取失败且 task=null 时，原实现会继续访问 sourceImages。现显示原错误、重试和返回任务中心，不进行商品写入。
- 单图服务原先先执行抠图，再在图片生成阶段检查 confirmReal。现严格要求布尔 true，且在任何任务读取、抠图、模型调用、模拟回退写入前拒绝未批准请求；注入测试 Provider 也不能跳过审批。缺少确认的单图 HTTP 请求返回 403。
- 图片计划及生成页的小样本入口先只读读取配置来源，再展示图片/商品外发和费用提示，取消不发送创建请求。来源仅返回 HTTP(S) origin，剥离用户信息、路径与查询参数；Image2 预处理费用也在提示中。并不验证服务商实际单价，失败可能收费。
- backend 测试及桌面 smoke 子进程显式使用 mock，并清空继承的真实 Provider 凭据；不会因开发环境存在密钥而使验收发起真实调用。正常客户端配置不受此测试模式影响。

## 双语范围

MattingPage、ProductInfoPage、ImagePlanPage、TextLayoutEditor 的本批静态/显式确认文案接入语言层，新增 266 项，词典共 1,377 项。商品标题、SKU、原图文件名、OCR、证据、规则、Prompt、方案及文字元素内容、图片尺寸/枚举不改写。详细报告/Provider 原始消息可能仍是原语言。

原静态 JSX 审计剩余 790 处（9 个文件）；所选页面审计缺口 0，并非完整双语验收。生成页只补安全确认，其余旧 UI 仍未迁移。

## 验证范围与证据

源码早期检查点：desktop/.smoke-data/source-0.15.0-image-workflow/smoke-report.json，100/100，version=0.15.0，packaged=false；尚不含最终采用项刷新恢复。新增图片检查覆盖任务包读取、Sharp 结果、取消采用不写入、PNG 下载及原图散列保持、商品网络失败后重读、切换语言保留草稿、保存原文标题/SKU、计划标题保存且类型/尺寸不变、取消真实生成后零创建 POST。最终报告增加采用项刷新恢复，不能用早期检查点替代。

上传、Sharp、结果采用、mock 识别、商品保存、图片计划创建/修改使用实际本地 API。平台规则选择通过本地 API 设置固定测试目标，并非该未迁移页面的完整 UI 验收。任务、图片和数据库均在独立 smoke 目录。名为“服装样本”的测试文件实际是几何色块，只验证中文文件名与处理链路，不代表服装抠图质量。

已查看最终源码目录 workspace/matting-workflow-english.png，采用反馈、下载入口和中文原文件名显示正确。后端严格审批/零调用、HTTP 拒绝、来源脱敏和原有图片专项单独回归。

增加采用项重载恢复后，首次完整窗口验收在抠图页初始化失败：任务和图片标识都尚未加载，两个 undefined 被误当成匹配，随后读取空对象。新增单元用例先复现失败，再对缺少任务 ID/图片 ID 的状态提前返回 null。desktop/.smoke-data/source-0.15.0-image-workflow-final/smoke-report.json 是失败记录，不计入通过证据。修正后已重新构建，最终源码报告为 desktop/.smoke-data/source-0.15.0-image-workflow-verified/smoke-report.json，101/101，version=0.15.0，packaged=false，包含采用项重载恢复。

## 最终回归与构建

| 项目 | 最终结果 |
| --- | --- |
| 后端完整回归 | 576/576，独立临时工作空间、mock Provider、无真实模型调用 |
| 前端完整回归 | 197/197，含图片工作流与加载空状态回归 |
| 桌面单元 | 8/8 |
| 源码最终 Electron | 101/101，version=0.15.0，packaged=false |
| 最终便携 EXE | 101/101，version=0.15.0，packaged=true |
| 包资源 | 5,959 项；禁入、缺失、源码散列不一致均为 0；50 项前端构建文件，SQLite/Sharp 存在 |
| 生产构建 | 通过；主入口 398.96KB / gzip 131.88KB |

最终便携版报告：desktop/.smoke-data/portable-0.15.0-image-workflow-verified/smoke-report.json。运行实际 portable EXE，使用独立根目录，并在启动测试时移除继承的 ELECTRON_RUN_AS_NODE。原有 90 项与新增图片工作流 11 项全部通过；采用项重载后仍能下载 PNG，取消真实生成没有创建请求。最终 EXE 的 workspace/matting-workflow-english.png 已查看，采用反馈与原文件名显示正常。

| 制品 | 大小（字节） | SHA-256 |
| --- | --- | --- |
| desktop/release/Crossborder-Workbench-Portable-0.15.0.exe | 119298572 | E8BC4B8C500B7F995DD69BC119B51363B8FA240B914133B3D996EB45A7CCE745 |
| desktop/release/Crossborder-Workbench-Setup-0.15.0.exe | 119528606 | B27CE1FE98ECF333C093E41FB99C6CA46EB780799EB0A9519048154EA122B1E9 |

最终验收结果在构建后填写，以仓库文档为准；包内文档保留构建检查点。安装版已构建但未在干净机器安装/卸载；无 Windows 代码签名，不代表通过 SmartScreen。

## Temu 实站反馈与下一步

用户澄清“本地会话已失效”来自 Edge 地址栏直接打开本地服务，不是扩展点击连接后的错误。这与桌面会话保护相符，不能据此判断扩展配对失败或成功。实际服务地址以当前客户端为准，不固定为 60011。需在扩展“客户端连接”中输入当前地址及新配对码，再发送原来手动清单里的 1 个商品；客户端出现对应任务且图片可预览后才能记录回传通过。不要卸载扩展、清理手动清单，或发送配对码/Cookie。

## 未关闭

完整双语、真实服装质量、Temu 实站图片回传/深采/人工验证码恢复、本地 AI 权重许可、真实付费 Provider、官方平台模板导入、干净 Windows 安装卸载、代码签名、官方沙箱和公网部署仍需后续条件。没有关闭用户 Edge/旧客户端，没有下载模型、调用付费服务、绕过验证码、发布商品、线上改价或推送 Git。
