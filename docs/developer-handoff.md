# Crossborder Image Agent 开发者交接手册

本文面向 Codex、新的 ChatGPT 对话和后续开发者，用于快速理解项目边界、核心模块、Provider 行为、导出结构和测试入口。

## 1. 项目定位

项目路径：

```text
D:\Code\Codex\crossborder-image-agent
```

当前定位是本地商品图工作台和稳定批量运营工具。系统已经支持 mock 预览和 real-test 小批量真实 API 测试，但不是完整真实平台自动上架 Agent。

当前真实 API 允许范围：

- 真实识别。
- 真实生图。
- 真实审核。

当前仍禁止：

- 真实平台上传。
- 调用真实平台上传 API。
- 登录平台。
- 提交商品、图片、价格或库存。
- 在页面、日志、导出或文档中输出真实 API Key、token、secret。

## 2. 当前模式边界

### mock 模式

mock 是默认安全路径之一，用于流程预览、模板验收、规则审计、CSV/ZIP 结构验证和人工验收。

mock 结果不得写成最终平台上架图。

### real-test 模式

real-test 用于小批量真实 API 实用性测试：

- recognition mode: `real`
- image generation mode: `real-test`
- review mode: `real`
- upload mode: `dry-run`

real-test 可以调用真实 Vision / Image / Review Provider，可能产生费用。它不允许触发真实平台上传。

### dry-run 上传

上传相关系统继续保持 dry-run。安全字段应保持：

- `realUploadEnabled=false`
- `readyForRealUpload=false`
- `canUploadNow=false`
- `uploaded=false`
- `realNetworkCalled=false`
- `externalApiCalled=false`

不得为了让 UI 显示成功而把这些字段改成真实上传语义。

## 3. 关键前端页面

重点页面：

- `frontend/src/pages/BatchPage.jsx`
- `frontend/src/pages/GeneratePage.jsx`
- `frontend/src/pages/ImagePlanPage.jsx`
- `frontend/src/pages/ReviewPage.jsx`
- `frontend/src/pages/ExportPage.jsx` 或现有导出入口
- `frontend/src/pages/FinalAcceptancePage.jsx`
- `frontend/src/pages/SettingsPage.jsx`

本轮 real-test 相关更新重点在 BatchPage：

- 显示 batch 的 recognition / image generation / review / upload 四类模式。
- 显示 Vision / Image / Review Provider 和 Model 的 configured 状态。
- 队列模式允许选择 `real-test`。
- 页面只显示配置变量名，不显示变量值。

## 4. 关键后端 routes

重点 routes：

- `backend/src/routes/settings.js`
- `backend/src/routes/tasks.js`
- `backend/src/routes/batches.js`
- `backend/src/routes/generate.js`
- `backend/src/routes/final-acceptance.js`
- upload readiness / payload / sandbox 相关 routes，以实际文件名为准。

本轮新增或完善：

- `GET /api/settings/providers/status`

该 API 只返回 Provider 配置状态，不能返回真实密钥。

响应语义包括：

- provider
- model
- requiredVariables
- configured
- missingVariables
- upload dry-run 状态

## 5. 关键 services

重点 services：

- `backend/src/services/providerStatusService.js`
- `backend/src/services/workflowTemplateService.js`
- `backend/src/services/batchQueueService.js`
- `backend/src/services/exportManifestService.js`
- `backend/src/services/exportPackageService.js`
- `backend/src/services/imagePlanService.js`
- `backend/src/services/generationRequestService.js`
- `backend/src/services/templateAuditService.js`
- `backend/src/services/ruleAuditService.js`
- `backend/src/services/uploadReadinessService.js`

本轮新增：

- `providerStatusService.js`

该服务读取 Provider 配置状态，但只能暴露变量名和 configured / missing 状态，不能暴露变量值。

## 6. Provider 边界

Provider 入口：

- `backend/src/providers/index.js`
- Vision Provider 目录以实际项目结构为准。
- Image Provider 目录以实际项目结构为准。
- Review Provider 目录以实际项目结构为准。

Provider 选择规则：

- `getProviders('mock')` 必须强制返回 mock Vision / Image / Review Provider。
- `getProviders('real-test')` 使用当前真实配置选择 Vision / Image / Review Provider。
- 无参调用应保持旧流程兼容，继续尊重当前环境配置。

配置自检支持的变量名包括但不限于：

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `NVIDIA_API_KEY`
- `IMAGE2_API_KEY`
- `QWEN_API_KEY`
- `BACKGROUND_API_KEY`

只能显示变量名，不得显示变量值。

Image2 当前仍是实验能力，主要用于 Matting 或小样本测试。不要把 Image2 写成默认正式生成 Provider。

## 7. 工作流模板

系统模板中新增：

- `real_api_small_batch_test`

模板语义：

- recognition mode: `real`
- image generation mode: `real-test`
- review mode: `real`
- upload mode: `dry-run`
- concurrency: `1`
- max image auto fix / retry: `2`

该模板用于小批量真实 API 测试，不用于真实平台上传。

## 8. 批量队列行为

批量队列不做大重构，仍使用现有 action：

- recognize
- prepare
- generate
- review

区别在于根据 batch / template / mode 决定使用 mock 还是 real-test Provider。

实现边界：

- real-test recognize 调用真实 Vision Provider。
- real-test generate 调用真实 Image Provider。
- real-test review 调用真实 Review Provider。
- upload 仍然 dry-run。
- 每张图自动修正 / retry 上限保持 2。
- 不改变 batch / generate / review 主流程结构。

## 9. Batch 控制状态同步

相关文件：

- `backend/src/services/batchControlService.js`
- `backend/src/routes/batches.js`
- `frontend/src/pages/BatchPage.jsx`
- `frontend/src/utils/batchControlState.js`

cancel / reset / delete 的语义：

- `cancelBatch(batchId)`：标记 batch cancelled，取消队列继续推进，不删除本地原始 SKU 图片文件夹。
- `resetBatchImportState(batchId)`：清理该 batch 关联 SKU 的 importedFolders 标记，返回 `status=reset`、`originalFoldersPreserved=true`、`clearClientState=true`、`clearClientReports=true`、`batchInvalidated=true`、`currentBatch=null`。前端收到后必须清空当前 batch、SKU 列表、batchStabilityReport、batchResumePlan、batchReviewReport、导出预览和上传 dry-run 预览。不要再把旧 `batchTask` 作为 current batch 使用。
- `deleteBatch(batchId)`：删除小程序内 batch / task 记录，清理该 batch 的 importedFolders 标记，不删除本地原始 SKU 图片文件夹，返回 `status=deleted`、`batchInvalidated=true`、`currentBatch=null` 和 `originalFoldersPreserved=true`。

BatchPage 状态来源规则：

- 扫描导入目录区域只展示 importedFolders / scan result 的本地扫描状态。
- 批量任务列表展示当前仍有效的 batch；导入 selected SKU 成功后，即使 `listBatches` 尚未刷新，也必须使用当前 `batchTask` 作为兜底行，避免用户误以为 batch 未创建。
- 底部 SKU 列表只展示当前 batch 的 skuTasks。
- reset/delete 成功后，不得继续渲染旧 batch 的 blocked / running / imported SKU。
- 如果没有当前有效 batch，但已有 scanResult，底部 SKU 列表由 `buildSkuRowsForBatchPage` 使用 scan candidates 生成展示行；扫描状态为 new 的 SKU 应显示 `new / 可重新导入`，操作列显示“待导入”。
- SKU 行必须带清晰来源：`currentBatchTask` 表示当前 batch 内 SKU，`scanCandidate` 表示扫描发现 / 待导入，`importedElsewhere` 表示已导入到其他 batch。
- Batch list 行由 `buildBatchListRowsForBatchPage` 合并 `batches` 与当前 `batchTask`，同 id 时以当前 `batchTask` 为准；SKU 数量只能来自当前 batch 的 `skuTasks` 或 summary，不得把未勾选 scan candidates 算入当前 batch。
- `getSkuDisplayQueueStatus` 中 `new` 只允许扫描候选或无 taskId 的本地候选使用；首次导入且尚未开始识别的 current batch task 必须显示 pending / 待识别，不得被旧 `batchResumePlan.resumeGroups.blocked` 覆盖。真正 failed / retry / resume 场景仍必须优先显示 blocked / failed / cancelled / completed / running 等真实队列状态。
- batchResumePlan 和 batchStabilityReport 只对当前有效 batch 生效，reset/delete 后必须清空。
- “重置导入状态”按钮的可见性由 `shouldShowResetImportStatusAction` 控制：有当前 batch 时走后端 reset-import；没有当前 batch 但扫描区有候选 SKU 时只刷新 scan candidates 和 batch list，避免删除 batch 后按钮消失，也避免无 batchId 时调用 reset-import。
- `batchResumePlanService` 对首次待识别 SKU 使用 `resumeGroups.waiting` 和 `summary.waitingSku` 表示等待开始识别。paid API risk 只能进入 warning / paidApiRiskCount，不能把首次执行风险当成 blocked。recognition retry、失败 SKU、人工处理 SKU 仍保持 blocked / manualRequired 的保守保护。

本轮修复的根因是 reset-import 成功后旧 batchTask、旧轮询响应或旧预览响应可能重新回写 BatchPage state，导致扫描区域已显示 SKU 为 new，但底部 SKU 列表或报告区仍渲染旧 blocked / running / imported 状态。修复后，前端通过 `batchControlStateTransition` 统一决定是否清空当前 batch 和相关报告，并通过 `buildSkuRowsForBatchPage` 在无有效 batch 时将扫描结果同步到底部 SKU 列表。

BatchPage 异步请求防旧响应机制：

- 页面维护 request generation、active batch id 和 batchInvalidated 标记。
- batch detail 轮询、batchReviewReport、batchStability、batchResumePlan、export package preview/result、listing CSV preview/result、upload readiness、payload、sandbox 等请求返回后，必须校验请求发起时的 batchId 是否仍等于当前 active batch id，且 generation 未失效。
- reset/delete 成功后必须 increment generation，并将 batchInvalidated 置为 true；旧响应直接丢弃，不再 set state。

## 10. 导出结构

导出 manifest / summary 必须明确区分图片来源：

- `sourceType=mock`
- `sourceType=mockPreview`
- `sourceType=real`
- `sourceType=realGenerated`
- `sourceType=generated`
- `sourceType=fallbackMock`
- `sourceType=fallback_mock`
- `sourceType=realSample`

展示层统一映射：

- `mock` / `mockPreview` => `mock preview`
- `real` / `realGenerated` / `generated` => `real generated`
- `fallbackMock` / `fallback_mock` => `fallback mock`
- `realSample` => `real sample`

不要修改历史存储值；只在展示和人工验收 JSON/摘要中使用统一口径。

相关服务：

- `backend/src/services/exportManifestService.js`
- `backend/src/services/exportPackageService.js`

语义：

- `mock` 表示 mock preview。
- `real` 表示真实生成成功。
- `fallbackMock` 表示真实生成失败或不安全时回退到 mock。

real-test 导出不能把 fallbackMock 写成 real。

## 11. 上传系统边界

上传相关系统仍为 dry-run：

- upload readiness preview。
- payload preview。
- sandbox simulation。
- credential safety。
- JSON 导出。

禁止新增真实上传按钮。禁止调用 Temu / 妙手 / Amazon / Noon / Ozon / Rakuten 真实上传 API。

如果后续要做真实上传，必须单独设计：

- credential vault。
- 平台 sandbox。
- 权限控制。
- 审计日志。
- 平台错误回写。
- 人工确认开关。

## 12. 安全要求

禁止在任何页面、日志、导出、测试快照或文档中写入：

- 真实 API Key。
- 真实 token。
- 真实 secret。
- `.env` 内容。
- 平台账号密码。
- 本机敏感绝对路径。
- `app.sqlite` 内容。

允许写变量名，例如 `OPENAI_API_KEY`。不允许写变量值。

## 13. 测试覆盖

本轮 real-test 相关测试覆盖：

- Provider 自检脱敏。
- `real_api_small_batch_test` 模板存在。
- real-test 模式选择真实 Provider。
- mock 模式仍选择 mock Provider。
- 导出 sourceType 正确标记 real / mock / fallbackMock。
- 上传仍保持 dry-run。
- 前端 BatchPage 显示 real-test 模式和 Provider 配置状态。
- 前端 Generate / Export 相关工具能区分 mock preview / real generated / fallback mock。

Batch 控制状态同步测试覆盖：

- resetBatchImportState 清理 importedFolders，并返回前端应清理旧状态的提示。
- deleteBatch 只删除目标 batch / task 记录和 importedFolders，不删除本地图片文件夹。
- reset/delete 成功后 BatchPage 清空当前 batch、SKU 列表、稳定性报告、恢复计划和导出 / dry-run 预览。
- delete/reset 后重新扫描，底部 SKU 列表跟随 scan candidates 显示 new，不残留旧 blocked / running / imported。
- blocked SKU 状态显示 helper 仍保持 blocked 优先级，但不会在 reset/delete 后继续渲染旧 batch。

测试命令：

```bat
cd /d D:\Code\Codex\crossborder-image-agent\backend
npm.cmd test
```

```bat
cd /d D:\Code\Codex\crossborder-image-agent\frontend
npm.cmd run build
node --test tests/*.test.js
```

如果只改文档，可不跑完整 npm 测试，但必须确认文档存在、内容可读、没有真实密钥。

## 14. 已知限制

- real-test 仍建议只用于 1 到 2 个 SKU 的小批量验证。
- Nvidia / Image2 的真实生图能力受当前 Provider 实现限制。
- 平台上传仍未接真实 API。
- 没有 credential vault，不能保存真实平台 token。
- mock 和 fallbackMock 不能作为最终真实上架图。
- dry-run 不能作为真实上传成功结果。
- 已发出的单个真实 Provider 请求通常不能强制中断；cancel 只阻止后续队列继续推进。

## 15. 新对话接手建议

新的 Codex 或 ChatGPT 对话接手时，建议先读：

1. `docs/developer-handoff.md`
2. `docs/user-manual.md`
3. `README.md`
4. `backend/src/routes/settings.js`
5. `backend/src/services/providerStatusService.js`
6. `backend/src/services/workflowTemplateService.js`
7. `backend/src/services/batchQueueService.js`
8. `frontend/src/pages/BatchPage.jsx`

不要一上来重构 batch / generate / review 主流程。先判断问题属于文档、前端展示、只读报告、Provider 配置、导出脱敏还是队列行为，再做最小修改。
