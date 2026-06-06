# 小程序验收协作记录

更新时间：2026-06-02

## 协作目标

让小程序发挥百分之百的作用：ChatGPT 负责和用户一起逐项体验、记录现象、判断业务可接受性；Codex 负责读取代码、复现问题、修复缺陷、运行验证，并把修复结果反馈给 ChatGPT 和用户。

## 当前自动化基线

已通过：

- 后端：`npm.cmd test`
- 前端：`npm.cmd run build`
- 前端工具测试：`node --test tests/*.test.js`
- 运行态接口烟测：`GET /api/health`
- Provider 状态脱敏烟测：`GET /api/settings/providers/status`
- 最终验收模板烟测：`GET /api/final-acceptance/template`
- 前端首页可访问烟测：`GET http://127.0.0.1:5173/`
- mockOnly 运行态压测：`POST /api/stress-test/run`

最近一次结果：

- 后端测试：443 pass，0 fail
- 前端测试：170 pass，0 fail
- 前端构建：成功，有 Vite chunk size 警告
- mockOnly 压测：status=completed，successSku=1，failedSku=0，realProviderCalls=0

## 验收边界

允许验收：

- mock 单品工作流
- 批量导入与批量队列
- real-test 小批量识别、生图、审核
- 导出 ZIP、CSV、报告
- 上传 readiness、payload、sandbox dry-run
- Provider 配置状态展示，但只展示变量名和 configured/missing 状态

禁止误判为已完成真实能力：

- 不允许真实平台上传
- 不允许把 dry-run 写成真实上传成功
- 不允许把 mock 或 fallback mock 当作最终真实上架图
- 不允许在页面、日志、导出、文档中输出 API key、token、secret、`.env` 值

## 每轮验收记录格式

把下面内容从 ChatGPT 传给 Codex：

```text
【验收项】
例如：批量导入后点击重置导入状态

【操作步骤】
1. 打开页面：
2. 点击/输入：
3. 观察到：

【实际结果】
页面显示、接口返回、错误提示、截图说明。

【期望结果】
用户认为应该发生什么。

【严重程度】
阻断 / 高 / 中 / 低

【可复现性】
必现 / 偶现 / 仅一次

【补充信息】
浏览器、时间、是否 real-test、是否涉及付费 API、是否有导出文件。
```

## Codex 修复反馈格式

Codex 每次修复后回传：

```text
【修复状态】
已修复 / 未复现 / 需要更多信息 / 暂不建议修改

【根因】
简短说明问题发生在哪里。

【修改文件】
列出文件和关键变更。

【验证】
列出实际跑过的命令或接口，以及结果。

【交给 ChatGPT 复验】
说明用户下一步要怎么重新操作确认。
```

## 首轮建议验收清单

1. 启动与状态页：确认前端、后端、健康检查、Provider 状态脱敏。
2. 单品 mock 流程：上传、识别、确认商品信息、选平台、生成图片方案、生成 mock 图、审核、导出。
3. 批量导入：扫描 SKU 文件夹、导入、空 SKU/无效图处理、列表状态。
4. 批量队列：recognize、prepare、generate、review、暂停、恢复、取消、重试。
5. reset/delete：确认不会删除本地原始 SKU 图片，页面不会残留旧 batch 状态。
6. 导出：ZIP、结构化 export package、listing CSV、final acceptance JSON/CSV。
7. 上传 dry-run：readiness、payload、sandbox simulation 均不得出现真实上传成功语义。
8. 安全检查：页面、下载 JSON、日志不出现密钥值、`.env` 值、本机敏感绝对路径。
9. real-test 小样本：仅在用户明确确认会产生 API 成本后执行，且上传仍为 dry-run。

