# 全项目关联状态同步专项质检报告

生成时间：2026-06-02

本报告只做静态质检与风险分级，不包含业务逻辑修改、数据库修改、Provider 调用或平台上传调用。

## 1. 背景

近期批量运营验收中发现过多个“同一 SKU 在不同区域显示不同状态”的问题，例如恢复计划中显示已阻止，但底部 SKU 列表仍显示运行中；删除当前 batch 后，扫描区和 SKU 列表可能继续显示旧的导入、运行或阻断状态。

这类问题通常不是单点状态字段错误，而是多个只读报告、队列状态、导入状态和前端缓存之间缺少统一展示优先级。本次专项质检目标是梳理状态来源、关系链和剩余风险，形成后续分批修复依据。

## 2. 质检范围

本次覆盖以下状态系统：

- A. 导入扫描状态：扫描区、SKU 文件夹、importedFolders。
- B. batch 状态：currentBatch、batchTask、batch status。
- C. SKU / task 状态：currentStep、queueStatus、status。
- D. 队列状态：recognize / generate / review 等动作队列。
- E. batchStability：稳定性报告。
- F. batchResumePlan：批量恢复计划。
- G. skuRetry：单 SKU 重试计划。
- H. review / autoFix：审核与自动修正状态。
- I. imagePlan / generate / sourceType：图片方案、生成结果、mock/real/fallback 标记。
- J. export / listing CSV：导出包、清单 CSV、manifest/summary。
- K. upload readiness / payload / sandbox：上传前检查、payload 预览、沙盒 dry-run。
- L. final acceptance：最终验收报告。
- M. 前端缓存与副作用：BatchPage state、useEffect、localStorage。

## 3. 状态源总览

| 状态源 | 主要文件 | 性质 | 质检结论 |
| --- | --- | --- | --- |
| 扫描结果 | `frontend/src/pages/BatchPage.jsx`、`frontend/src/utils/batchControlState.js` | 前端展示状态 | 删除/重置后已能以扫描候选重建 new 状态，但仍需要区分“其他 batch 已导入”。 |
| importedFolders | `backend/src/services/batchControlService.js` | 后端导入标记 | reset/delete 已清理目标 batch 关联导入标记，并保留本地图片文件夹。 |
| batchTask | `backend/src/services/batchControlService.js`、`frontend/src/pages/BatchPage.jsx` | 后端记录 + 前端当前 batch | 前端已按 clearClientState 清空当前 batch；后端 reset 返回 batchTask 的契约仍有后续误用风险。 |
| skuTasks | `frontend/src/utils/batchControlState.js` | 前端列表来源 | 有 active batch 时优先显示 batch SKU；无 active batch 时显示扫描候选。 |
| queueStatus | `frontend/src/utils/batchStatusDisplay.js` | 展示状态 | blocked 已优先覆盖 running；但 new 优先级对 batch 行过高，需收窄。 |
| batchStability | `backend/src/services/batchStabilityService.js` | 只读分析报告 | 不写数据库，适合作为恢复计划输入。 |
| batchResumePlan | `backend/src/services/batchResumePlanService.js` | 只读恢复计划 | blocked 可以覆盖队列展示，但前端异步请求仍需防止旧结果回写。 |
| skuRetry | `backend/src/services/skuRetryService.js`、`frontend/src/pages/BatchPage.jsx` | 单 SKU 重试辅助 | 删除/重置后前端已清空 skuRetry 相关 state。 |
| review / autoFix | review 相关 service 与页面 | 流程状态 | 未发现直接被删除/重置破坏，但再生成后 review 是否应提示过期需补测试。 |
| imagePlan / generate | imagePlan / generate 相关 service 与页面 | 图片生成状态 | sourceType 基本可区分 mock/real/fallback，legacy 命名仍需统一展示。 |
| export / listing CSV | `backend/src/services/exportPackageService.js`、`backend/src/services/listingExportService.js` | 导出快照 | 前端 reset/delete 会清空预览，后端 batch 删除后预览应失效；异步回写仍需防护。 |
| upload dry-run | `backend/src/services/uploadReadinessService.js`、`uploadPayloadService.js`、`uploadSandboxService.js` | 只读 dry-run | 保持 realUploadEnabled=false、canUploadNow=false，不调用平台 API。 |
| final acceptance | `backend/src/services/finalAcceptanceService.js` | 只读验收报告 | 不写数据库；多 batch / orphan task 场景建议后续增加显式过滤。 |
| localStorage | 前端配置区 | 本地 UI 配置 | 不应作为 authoritative batch 状态同步源。 |

## 4. 关联状态关系图（文字）

1. 本地 SKU 图片文件夹进入扫描流程，形成 `scanResult.candidates`。
2. 用户导入扫描候选后，后端创建或关联 batch/task，并写入 importedFolders 标记。
3. BatchPage 有当前 batch 时，底部 SKU 列表以 `batchTask.skuTasks` 为主；没有当前 batch 时，以扫描候选补充显示 new/imported 等本地状态。
4. recognize / generate / review 队列更新 task 的 step、status、queueStatus、error、results。
5. batchStability 基于 batch/task 快照生成稳定性报告。
6. batchResumePlan 基于失败、阻断、重试风险生成恢复计划，其中 blocked 应覆盖 SKU 列表中的 running 展示。
7. skuRetry 基于单 SKU 当前状态生成只读重试计划。
8. imagePlan/generate 产出 mock、real 或 fallback 结果，并在 export manifest / summary 中记录 sourceType。
9. export/listing CSV 基于 task、imagePlan、generatedImages、review 结果生成导出预览或文件。
10. upload readiness / payload / sandbox 基于 batch/export/listing 快照生成 dry-run 报告，始终不真实上传。
11. final acceptance 汇总 task/batch/export/upload 等只读状态，形成最终验收报告。
12. 前端 BatchPage、GeneratePage、ExportPage 等页面通过 useEffect、页面 state、localStorage 组合展示状态，因此需要防止旧请求在 reset/delete 之后回写。

## 5. 已确认同步正常项

- 删除当前 batch 时，后端返回 `clearClientState=true` 与 `clearClientReports=true`，并包含需要清空的报告 key。
- reset/delete 会保留本地 SKU 图片文件夹，不删除原始图片。
- reset/delete 会清理目标 batch 的 importedFolders 标记，避免扫描区继续误认为该 SKU 已导入当前 batch。
- BatchPage 收到 clearClientState 后会清空当前 batch、analytics、review report、stability report、resume plan、logs、results、skuRetry、导出预览、listing 预览、upload readiness、payload、sandbox、安全报告等前端 state。
- 没有当前 batch 时，底部 SKU 列表可以从扫描候选重建，扫描候选默认可显示为 `new / 可重新导入`。
- batchResumePlan 中 blocked SKU 的展示优先级已高于 running，避免“已阻止但仍显示运行中”的主要误导。
- upload readiness、payload、sandbox 三条链路继续保持 dry-run，报告中明确 `realUploadEnabled=false`、`canUploadNow=false` 或等价安全字段。
- final acceptance 是只读报告层，不会把 pending/missing/noReview/fatal/high 自动标记为通过。
- 当前专项质检未发现 batch/generate/review 队列主流程被删除或替换。

## 6. 发现的问题列表

### STATUS-001：reset 后后端仍返回 batchTask，存在状态契约歧义

- 风险等级：MustFix / 高
- 涉及页面：BatchPage、可能的批量详情页。
- 涉及后端：`backend/src/services/batchControlService.js`
- 涉及前端：`frontend/src/pages/BatchPage.jsx`
- 复现方式：执行 reset 当前 batch；前端当前逻辑会按 clearClientState 清空，但如果其他调用方直接使用响应中的 batchTask，可能重新挂回旧 batch。
- 期望状态：reset/delete 后当前 batch 应被明确视为失效，调用方不应继续以返回 batchTask 作为当前态。
- 实际状态：reset 流程仍会返回 batchTask，并将 batch status 更新为 imported。
- 风险：后续新增页面、异步回写或第三方调用容易误用旧 batchTask，导致扫描区 new 与底部 SKU 列表旧状态再次冲突。
- 建议处理：将 reset/delete 响应契约明确为 invalidated，不返回可继续作为 currentBatch 的 batchTask，或新增 `batchInvalidated=true` 并在所有前端入口统一处理。
- 是否建议立即修：是。

### STATUS-002：无当前 batch 时底部 SKU 列表可能混入“其他 batch 已导入”扫描候选

- 风险等级：MustFix / 高
- 涉及页面：BatchPage。
- 涉及后端：import scan / importedFolders 数据。
- 涉及前端：`frontend/src/utils/batchControlState.js`、`frontend/src/pages/BatchPage.jsx`
- 复现方式：删除或离开当前 batch 后重新扫描；扫描候选中如存在属于其他 batch 的 imported 文件夹，底部 SKU 列表会继续展示 imported 状态。
- 期望状态：底部 SKU 列表应清楚区分“当前 batch SKU”和“扫描候选”，并说明 imported 属于其他 batch 或不可重复导入。
- 实际状态：无 active batch 时，扫描候选被映射到底部 SKU 列表，容易被理解成当前 batch 状态。
- 风险：运营误以为删除当前 batch 后仍有旧 imported 状态残留。
- 建议处理：增加 source label 或拆分底部列表：扫描候选显示为“扫描发现”，若属于其他 batch 则显示“已导入到其他 batch”，不要混同为当前 batch SKU。
- 是否建议立即修：是。

### STATUS-003：new 状态优先级对 batch 行过高，可能隐藏真实队列状态

- 风险等级：MustFix / 高
- 涉及页面：BatchPage 底部 SKU 列表。
- 涉及后端：无。
- 涉及前端：`frontend/src/utils/batchStatusDisplay.js`
- 复现方式：构造或遇到混合状态行：`status=new` 且 `queueStatus=running/failed/blocked`。
- 期望状态：new 只应用于扫描候选或无 taskId 的本地候选；真实 batch task 应按 blocked/failed/cancelled/completed/running/pending 优先级展示。
- 实际状态：当前 helper 在 blocked 之后优先判断 new，有可能让 batch 行显示 new。
- 风险：真实队列状态被弱化，影响排查。
- 建议处理：仅当 `sourceType=scan` 或 `taskId` 为空时才允许 new 覆盖队列状态。
- 是否建议立即修：是。

### STATUS-004：旧的隐藏 SKU 列表 helper 与当前展示策略不一致

- 风险等级：ShouldFix / 中
- 涉及页面：BatchPage。
- 涉及后端：无。
- 涉及前端：`frontend/src/utils/batchControlState.js`、对应测试。
- 复现方式：查看 `shouldHideSkuListAfterBatchControl(null)` 的语义与当前删除后显示扫描候选的实际 UI。
- 期望状态：工具函数和测试命名应反映当前策略：删除当前 batch 后不是“隐藏列表”，而是“清空 batch 行并可显示扫描候选”。
- 实际状态：helper 名称和旧测试容易误导后续维护。
- 风险：后续修复时误以为删除后应完全隐藏 SKU 区域。
- 建议处理：重命名或废弃该 helper，补充新的展示策略测试。
- 是否建议立即修：否，可随 STATUS-002 一起整理。

### STATUS-005：BatchPage 轮询请求可能在清空 state 后回写旧 batch

- 风险等级：ShouldFix / 中高
- 涉及页面：BatchPage。
- 涉及后端：无。
- 涉及前端：`frontend/src/pages/BatchPage.jsx`
- 复现方式：队列运行时执行 delete/reset；如果轮询请求已发出但尚未返回，清空 state 后旧响应仍可能 setBatchTask。
- 期望状态：reset/delete 后，旧请求响应应被忽略。
- 实际状态：interval cleanup 能减少概率，但对已在途 promise 没有统一 generation guard。
- 风险：偶发旧状态回弹，表现为删除后又显示 running/blocked/imported。
- 建议处理：为 batch 详情轮询、scan refresh、preview 请求增加 request generation 或 active batch id 校验。
- 是否建议立即修：是，建议第一批修复。

### STATUS-006：导入扫描后 scanResult 与 batchTask 的短暂组合状态仍可能让用户困惑

- 风险等级：ShouldFix / 中
- 涉及页面：BatchPage。
- 涉及后端：import scan / batch import API。
- 涉及前端：`frontend/src/pages/BatchPage.jsx`
- 复现方式：导入选中扫描文件夹后，前端同时设置 batchTask 并刷新 scanResult。
- 期望状态：导入成功后，当前 batch SKU 和扫描候选应有明确分区；跳过或失败项应显示在扫描结果提示中。
- 实际状态：当前 active batch 优先显示可避免大部分问题，但异常返回或部分导入时仍可能产生混合解释。
- 风险：运营不清楚某个 SKU 是已进入当前 batch、被跳过，还是仍可导入。
- 建议处理：导入结果增加“已导入 / 已跳过 / 可重试”分组显示。
- 是否建议立即修：否。

### STATUS-007：导出、listing、上传 dry-run 预览存在旧异步结果回写风险

- 风险等级：ShouldFix / 中
- 涉及页面：BatchPage、ExportPage、相关上传配置区域。
- 涉及后端：export / listing / upload preview API。
- 涉及前端：BatchPage 预览 state。
- 复现方式：发起导出预览或 upload dry-run 后立即 delete/reset 当前 batch；旧请求返回后可能重新设置预览 state。
- 期望状态：当前 batch 清空或 id 变化后，旧预览结果应被丢弃。
- 实际状态：前端已有 clearClientReports，但缺少对每个异步 action 的统一 batch id 校验。
- 风险：页面可能短暂展示已删除 batch 的导出或上传 dry-run 报告。
- 建议处理：所有预览请求完成后校验响应 batchId 与当前 active batchId 一致。
- 是否建议立即修：是，建议第一批修复。

### STATUS-008：final acceptance 默认取任务列表，未来多 batch / orphan task 场景需更明确

- 风险等级：Optional / 中低
- 涉及页面：最终验收页。
- 涉及后端：`backend/src/services/finalAcceptanceService.js`
- 涉及前端：最终验收页面。
- 复现方式：存在 orphan task 或用户只想验收指定 batch 时，默认报告可能纳入非目标任务。
- 期望状态：最终验收可显式选择 batch 范围或 SKU 范围。
- 实际状态：当前作为只读总体验收报告可接受。
- 风险：多批次验收时报告口径不够清楚。
- 建议处理：后续增加显式 batchIds / skuIds 过滤，不在本轮状态同步修复中处理。
- 是否建议立即修：否。

### STATUS-009：再生成图片后 review 是否过期缺少专门一致性测试

- 风险等级：ShouldFix / 中
- 涉及页面：GeneratePage、ReviewPage、BatchPage。
- 涉及后端：generate/review 相关 service。
- 涉及前端：生成与审核展示。
- 复现方式：同一 SKU 先生成并审核，再重新生成图片，查看旧 review 是否仍被当作当前图片审核结果。
- 期望状态：生成结果变化后，旧审核结果应提示可能过期，或 review 绑定明确的 generated image id / version。
- 实际状态：本次静态质检未确认存在实际 bug，但缺少专门测试覆盖。
- 风险：导出或上传 dry-run 可能误用旧审核结论。
- 建议处理：补一致性测试，必要时增加只读提示，不改变主流程。
- 是否建议立即修：否，建议第二批修复。

### STATUS-010：sourceType 命名存在 legacy 值，需统一展示口径

- 风险等级：Optional / 低
- 涉及页面：GeneratePage、ExportPage、ImagePlanPage。
- 涉及后端：`backend/src/services/exportPackageService.js` 等。
- 涉及前端：sourceType 展示 helper。
- 复现方式：检查导出 manifest / summary 中 mock、real、fallbackMock、realSample 等标记。
- 期望状态：运营页面统一展示 mock preview / real generated / fallback mock。
- 实际状态：大方向已区分，legacy 命名可能存在于旧导出包或兼容代码。
- 风险：人工验收时解释成本增加。
- 建议处理：增加展示层映射，不改历史数据。
- 是否建议立即修：否。

### STATUS-011：终端静态查看中文存在编码显示噪声

- 风险等级：Optional / 低
- 涉及页面：多个中文页面。
- 涉及后端：无。
- 涉及前端：中文 UI 文案文件。
- 复现方式：PowerShell 读取部分 JSX/JS 文件时出现中文显示异常。
- 期望状态：源码为 UTF-8，浏览器显示正常。
- 实际状态：本次状态同步质检未发现新的页面乱码证据，但终端输出不适合作为唯一判断。
- 风险：后续人工排查容易误判。
- 建议处理：如有用户可见乱码，再按乱码专项扫描处理；本轮不修。
- 是否建议立即修：否。

### STATUS-012：不要把 localStorage 平台配置纳入 batch 状态同步

- 风险等级：DoNotFix / 安全边界
- 涉及页面：BatchPage / 上传配置区域。
- 涉及后端：无。
- 涉及前端：localStorage 配置。
- 复现方式：切换 batch 后 localStorage 中仍保留 dry-run 配置。
- 期望状态：localStorage 只作为本地 UI 输入缓存，不作为 batch 的真实状态。
- 实际状态：符合安全边界。
- 风险：若强行同步到 batch，可能造成凭据、dry-run 配置和业务状态混淆。
- 建议处理：不修。仅在 UI 上标注“本地临时配置”。
- 是否建议立即修：否，明确不要修成后端状态。

### STATUS-013：不要让 final acceptance 自动删除或隐藏旧数据

- 风险等级：DoNotFix / 产品边界
- 涉及页面：最终验收页。
- 涉及后端：`backend/src/services/finalAcceptanceService.js`
- 涉及前端：最终验收页面。
- 复现方式：删除某个 batch 后，最终验收仍可能基于当前只读数据集合生成报告。
- 期望状态：最终验收保持人工验收记录和只读汇总，不执行清理动作。
- 实际状态：符合只读验收定位。
- 风险：若自动删除/隐藏，可能破坏审计追溯。
- 建议处理：不修成自动清理；未来仅增加显式筛选。
- 是否建议立即修：否。

### STATUS-014：不要把上传 dry-run 状态同步成可真实上传

- 风险等级：DoNotFix / 安全边界
- 涉及页面：BatchPage、上传配置页、上传 dry-run 区域。
- 涉及后端：`uploadReadinessService.js`、`uploadPayloadService.js`、`uploadSandboxService.js`
- 涉及前端：上传展示区域。
- 复现方式：upload readiness 报告中即使基础检查通过，仍显示 realUploadEnabled=false / canUploadNow=false。
- 期望状态：平台上传继续保持 dry-run，不新增真实上传按钮。
- 实际状态：符合当前阶段边界。
- 风险：若为了“状态一致”改成 readyForRealUpload=true，会越过产品安全边界。
- 建议处理：不修。
- 是否建议立即修：否。

## 7. 风险分级汇总

| 分级 | 数量 | 问题编号 |
| --- | ---: | --- |
| MustFix | 3 | STATUS-001、STATUS-002、STATUS-003 |
| ShouldFix | 5 | STATUS-004、STATUS-005、STATUS-006、STATUS-007、STATUS-009 |
| Optional | 3 | STATUS-008、STATUS-010、STATUS-011 |
| DoNotFix | 3 | STATUS-012、STATUS-013、STATUS-014 |
| 合计 | 14 | STATUS-001 至 STATUS-014 |

## 8. MustFix

1. STATUS-001：明确 reset/delete 后 batchTask 的失效契约，避免其他调用方重新挂回旧 batch。
2. STATUS-002：区分当前 batch SKU 与扫描候选，尤其是“已导入到其他 batch”的扫描状态。
3. STATUS-003：收窄 new 状态优先级，只允许扫描候选使用 new 覆盖展示。

## 9. ShouldFix

1. STATUS-004：清理旧 helper 命名和测试语义。
2. STATUS-005：为 BatchPage 轮询增加 request generation / active batch id 防护。
3. STATUS-006：导入扫描结果增加已导入、已跳过、可重试分组。
4. STATUS-007：导出、listing、upload preview 增加 batch id 回写校验。
5. STATUS-009：补“重新生成后审核是否过期”的一致性测试。

## 10. Optional

1. STATUS-008：final acceptance 后续增加显式 batch/SKU 过滤。
2. STATUS-010：sourceType legacy 值做展示层统一映射。
3. STATUS-011：如有实际用户可见乱码，再做前端乱码专项扫描。

## 11. DoNotFix 与原因

1. STATUS-012：localStorage 上传配置不应变成 batch authoritative 状态，避免凭据和业务状态混淆。
2. STATUS-013：final acceptance 不应自动清理或隐藏数据，避免破坏审计追溯。
3. STATUS-014：上传 dry-run 不应被同步成真实上传可用状态，当前阶段安全边界要求始终不真实上传。

## 12. 推荐修复顺序

第一批：

1. STATUS-003：改动最小，先避免 new 隐藏真实队列状态。
2. STATUS-005：防止轮询旧响应回写，是删除/reset 后旧状态回弹的关键防线。
3. STATUS-007：防止导出和上传预览旧响应回写。
4. STATUS-001：明确后端 reset/delete 响应契约，降低未来误用风险。
5. STATUS-002：统一扫描候选与当前 batch SKU 的展示边界。

第二批：

1. STATUS-004：整理 helper 命名和测试。
2. STATUS-006：优化导入结果分组展示。
3. STATUS-009：补生成/审核一致性测试。

第三批：

1. STATUS-008：final acceptance 过滤。
2. STATUS-010：sourceType 展示映射。
3. STATUS-011：按实际用户反馈做乱码专项。

## 13. 为什么不建议一次性全部修复

- 状态同步问题跨越导入、batch、队列、恢复计划、导出、上传 dry-run、最终验收多个区域，一次性修复容易引入新的展示回归。
- MustFix 中既有前端展示优先级，也有后端响应契约，应该先修最小闭环，再逐步扩大。
- ShouldFix 中包含异步请求竞态，修复后需要较多回归验证，不适合和 sourceType、final acceptance 等低风险问题混在一起。
- DoNotFix 项属于安全边界或产品边界，不能为了表面一致性改成自动同步。

## 14. 验证建议

第一批修复后建议验证：

1. 删除当前 batch 后，扫描区 SKU 显示 new，底部 SKU 列表不再显示旧 blocked/running/imported。
2. reset 当前 batch 后，刷新页面仍不恢复旧 batch 状态。
3. batchResumePlan 中 blocked SKU 在底部列表显示 blocked / 已阻止，不显示 running。
4. 队列运行中执行 delete/reset，等待旧轮询请求返回后页面不回弹旧状态。
5. 导出预览、listing 预览、upload readiness 请求发出后立即 delete/reset，旧响应不再回写页面。
6. 其他 batch 的 imported SKU 在扫描区显示为“已导入到其他 batch”，不混同为当前 batch 状态。
7. 上传区域仍显示 dry-run，未出现真实上传按钮。
8. mock / real-test 模式切换不受状态展示修复影响。

建议测试命令：

```bash
cd backend && npm test
cd frontend && npm run build
cd frontend && node --test tests/*.test.js
```

## 15. 文档同步建议

本轮只新增专项审计报告，不直接修改用户手册或开发者交接手册。后续进入修复阶段后建议：

1. 在用户手册中补充“删除当前 batch 后，本地图片保留，扫描区恢复 new，可重新导入”的说明。
2. 在开发者交接手册中补充“BatchPage 状态源优先级”和“reset/delete 后必须清空的报告 state 列表”。
3. 在开发者交接手册中记录 upload dry-run 的 DoNotFix 边界：不得因 readiness 通过而显示真实上传可用。

## 16. 本次质检边界与盲区

- 本次为静态代码质检，未运行浏览器端人工 E2E。
- 本次未读取 `.env`，未输出任何 API Key、token 或 secret。
- 本次未连接真实 Provider、Image2 或平台 API。
- 本次未检查或修改 SQLite 数据文件。
- 本次未删除本地图片、导出包或其他运行文件。
- 本次未修改业务代码、前端逻辑、后端逻辑、Provider 配置或数据库 schema。
- 对 review 是否随重新生成图片自动过期，本次只列为风险点，未判定为已发生 bug。
