# Crossborder Image Agent 用户手册

本文面向运营人员和前端使用者，说明小程序当前能做什么、怎么操作，以及哪些结果只是预览或 dry-run。

## 1. 当前能力边界

Crossborder Image Agent 是本地商品图工作台和批量运营辅助工具。当前支持：

- 单 SKU 商品图上传、识别、人工确认、规则选择、图片方案、生成、审核和导出。
- 批量 SKU 扫描导入、批量识别、批量生成、批量审核、批量报告和导出。
- mock 预览模式，用来检查流程、模板、规则和导出结构。
- real-test 真实测试模式，用来小批量调用真实识别、真实生图、真实审核 Provider。
- ZIP、CSV、JSON 导出。
- 上传前 dry-run 检查、Payload 预览和沙盒模拟。

重要边界：

- mock 图片不是最终平台上架图。
- real-test 只表示真实识别、真实生图、真实审核，不表示真实上传平台。
- 上传相关功能仍是 dry-run，不会登录平台，不会调用真实平台 API，不会提交商品、图片、价格或库存。
- 页面和导出结果不会显示真实 API Key、token 或 secret。

## 2. 启动和关闭

启动小程序：

1. 双击根目录下的 `启动小程序.bat`。
2. 后端窗口和前端窗口会启动并保持运行。
3. 浏览器访问 `http://localhost:5173`。
4. 后端健康检查地址为 `http://localhost:4000/api/health`。

关闭小程序：

1. 双击根目录下的 `关闭小程序.bat`。
2. 等待关闭完成提示。

后端窗口负责 `localhost:4000`，前端窗口负责 `localhost:5173`。使用过程中不要手动关闭这两个窗口，除非准备停止小程序。

## 3. mock 模式和 real-test 模式

mock 模式适合日常安全预览：

- 不调用真实生图 Provider。
- 生成的是 mock preview。
- 用来检查模板、布局、规则、CSV、ZIP 和报告结构。
- 不会产生真实 Provider 调用费用。

real-test 模式适合小批量真实 API 验证：

- 识别阶段调用真实 Vision Provider。
- 生图阶段调用真实 Image Provider。
- 审核阶段调用真实 Review Provider。
- 上传阶段仍保持 dry-run。
- 可能产生真实 Provider 调用费用，请先确认配置和测试范围。

建议先用 1 个 SKU 验证，再扩展到 2 个 SKU 小批量。不要直接大批量执行 real-test。

## 4. 批量任务中选择 real-test

在 BatchPage 批量任务页面：

1. 创建或打开一个 batch。
2. 在工作流模板中选择 `真实 API 小批量测试`，模板 ID 为 `real_api_small_batch_test`。
3. 页面会显示当前 batch 的四类模式：
   - recognition mode
   - image generation mode
   - review mode
   - upload mode
4. 如果看到：
   - recognition mode: real
   - image generation mode: real-test
   - review mode: real
   - upload mode: dry-run
   表示当前 batch 是真实测试模式，但上传仍然不会真实执行。
5. 批量队列模式也可以选择 `real-test：真实识别 / 真实生图 / 真实审核，上传仍为 dry-run`。

如果只想安全预览，请继续使用 mock 模式或 mock 模板。

## 5. Provider 配置状态

BatchPage 会显示 Vision / Image / Review Provider 和 Model 的配置状态。

你可以看到：

- 当前 provider 名称。
- 当前 model 名称。
- 需要的配置变量名。
- 是否 configured。
- 缺失哪些变量名。

页面只显示变量名，例如 `OPENAI_API_KEY`、`GEMINI_API_KEY`、`NVIDIA_API_KEY`、`IMAGE2_API_KEY`，不会显示真实值。

如果 Provider 未配置，real-test 可能失败或回退到安全 mock / fallback 结果。请不要在页面、截图、文档或聊天中粘贴真实密钥。

## 6. 单 SKU 推荐流程

1. 上传商品图片。
2. 执行识别。
3. 在商品确认页人工确认关键字段。
4. 查看识别质量复查，重点检查高风险字段、缺证据字段、冲突字段和 AI 推测字段。
5. 选择平台和类目规则。
6. 生成图片方案。
7. 在 mock 模式下生成 mock preview，或在 real-test 模式下生成真实测试图片。
8. 执行审核。
9. 处理 fatal / high 风险。
10. 导出 ZIP、CSV 或 JSON。

高风险字段包括容量、尺寸、接口、认证、保修、材质、型号、品牌、包装清单、兼容设备等。没有证据或没有人工确认时，不建议进入图片文案或关键 CSV 字段。

## 7. 批量任务推荐流程

1. 在 BatchPage 扫描导入目录。
2. 选择 SKU 并创建 batch。
3. 选择 mock 模板或 `真实 API 小批量测试`模板。
4. 查看当前模式和 Provider 配置状态。
5. 启动当前 batch。
6. 依次执行识别、生成、审核。
7. 查看批量任务列表、SKU 列表、稳定性报告和恢复计划。
8. 对失败 SKU 使用单 SKU 重试或人工处理。
9. 导出 ZIP、CSV、JSON。
10. 执行上传前 dry-run 检查。

如果恢复计划中某个 SKU 已阻止，SKU 列表应显示已阻止，而不是运行中。请优先处理恢复计划中的阻断原因。

导入选中的 SKU 后，“批量任务列表”会立即显示当前 batch，并标出 SKU 数量、待确认、失败、已完成、模板和状态。只有被勾选导入的 SKU 会进入当前 batch，未勾选的扫描候选会继续保留为 new / 可导入。

## 8. 取消、删除和重置导入状态

BatchPage 的高级操作里有三个容易混淆的按钮：

- 取消当前 batch：停止当前 batch 继续推进队列，batch 可以显示为已取消。
- 删除当前 batch 记录：删除小程序内的 batch / task 记录，不删除本地 SKU 图片文件夹。
- 重置导入状态：清理当前 batch 关联 SKU 的 imported 标记，让这些本地 SKU 文件夹可以重新扫描为 new。

重置导入状态后，页面会提示“导入状态已重置，请重新扫描目录并重新导入 SKU”。此时需要重新点击“扫描导入目录”。

重置或删除成功后，底部 SKU 列表、批量稳定性报告、恢复计划、审核摘要、导出预览、上传前检查和沙盒预览中的旧 batch 信息会被清空。这样可以避免扫描区域已经显示 SKU 为 new，但底部 SKU 列表还残留旧 blocked / running 状态。

重新扫描目录后，如果没有当前有效 batch，底部 SKU 列表会跟随扫描结果显示 SKU 文件夹状态。可重新导入的 SKU 会显示为 `new`，操作列显示“待导入”。

如果扫描结果中的 SKU 已经属于其他 batch，页面会把它标记为“已导入到其他 batch”，不会把它混同为当前 batch 的 SKU。此类 SKU 不能直接作为当前 batch 继续操作，需要先处理对应 batch，或在确认安全后重新扫描、重新导入。

底部 SKU 列表的队列展示优先级为：首次导入且尚未开始识别的 current batch SKU 优先显示 pending / 待识别；真正的恢复 / 重试 blocked 才会显示 blocked / 已阻止，其次是 failed / cancelled / completed / running，再显示扫描候选的 new。`new` 只代表扫描候选或本地待导入 SKU，不会覆盖当前 batch 中真实的 running / failed / blocked 队列状态。

首次导入 real-test SKU 时，真实识别可能产生 API 成本只是启动前提醒，不是阻断原因。此时 SKU 应显示“等待开始批量识别”，批量恢复计划不应把它放进 blocked SKU。只有识别已失败、正在做 retry / resume，或后端明确返回 blocked 状态时，才显示“已阻止”。

注意：

- 这些操作不会删除本地原始 SKU 图片文件夹。
- 删除 batch 记录后，如果要重新导入同一个 SKU，请重新扫描目录，再创建新的 batch。
- 如果扫描导入目录显示某个 SKU 是 new，底部 SKU 列表也应同步为 new，不应再显示它属于旧 batch 的 blocked、running 或 imported 状态。
- 删除当前 batch 后，只要扫描区仍有 SKU 候选，“重置导入状态”按钮仍会保留。此时点击按钮只会刷新扫描区和批量任务列表，不会删除本地图片文件夹。

## 9. 生成结果和导出标记

导出 manifest / summary 会区分图片来源：

- `sourceType=mock`：mock preview。
- `sourceType=mockPreview`：同样显示为 mock preview。
- `sourceType=real`：real-test 中真实生成成功的图片。
- `sourceType=realGenerated` 或 `sourceType=generated`：显示为 real generated。
- `sourceType=fallbackMock`：真实生成失败或不安全时回退到 mock 的结果。
- `sourceType=fallback_mock`：显示为 fallback mock。
- `sourceType=realSample`：真实小样本测试图。

real-test 模式下，如果真实生成成功，ZIP 中应包含真实生成图片，并在 manifest 中标记 `sourceType=real`。如果回退到 mock，导出会如实标记 `fallbackMock`，不要把它当成真实生成成功。

CSV 导出继续保留 risk_notes。字段缺失时不会伪造成通过结果。

如果重新生成图片，旧审核结果可能已经过期。页面会在能判断时提示“图片重新生成后，旧审核结果可能已过期，请重新审核”。系统不会自动删除旧审核，也不会把 noReview 自动改为 passed。

## 10. 上传前检查和平台上传边界

上传相关区域仍然只做 dry-run：

- 上传前检查。
- Payload 预览。
- 沙盒模拟。
- 凭据安全检查。
- 脱敏 JSON 导出。

看到以下状态是正常安全结果：

- `realUploadEnabled=false`
- `readyForRealUpload=false`
- `canUploadNow=false`
- `uploaded=false`
- `realNetworkCalled=false`
- `externalApiCalled=false`

当前不会真实上传 Temu、妙手、Amazon、Noon、Ozon 或 Rakuten。后续如果接入真实上传，需要单独设计凭据保险箱、平台沙盒、权限控制和上传日志。

## 11. 常见问题

### mock 图片可以直接上架吗？

不可以。mock 图片只用于流程、版式、模板和规则验收。

### real-test 会真实上传平台吗？

不会。real-test 只调用真实识别、真实生图、真实审核 Provider。上传仍是 dry-run。

### real-test 会产生费用吗？

可能会。只要调用真实 Provider，就可能产生费用。建议先用 1 个 SKU 小样本测试。

### Provider 配置状态为什么只显示变量名？

这是安全设计。页面只能显示变量名和 configured 状态，不能显示真实 API Key、token 或 secret。

### ZIP 里出现 fallbackMock 是什么意思？

表示真实生成没有成功使用，系统回退到了 mock 结果。请不要把 fallbackMock 当成真实生成成功。

### 上传前检查通过后会自动上传吗？

不会。当前上传功能仍是 dry-run，不会调用真实平台 API。

### 重置导入状态后为什么底部 SKU 列表空了？

这是正常行为。重置导入状态表示旧 batch 不应继续作为当前操作对象，页面会清空旧 SKU 列表和旧恢复计划，等待你重新扫描目录并重新导入。

## 12. 日常使用建议

- 新流程先用 mock 模式检查。
- real-test 先用 1 个 SKU，再用 2 个 SKU。
- 真实 API 配置只在后端环境中维护，不要贴到页面或文档里。
- 导出前优先处理 fatal / high 风险。
- 不要把 mock、fallbackMock、dry-run 结果写成真实平台成功结果。
