# Matting Provider Test Report

## 测试概览

- 测试时间：等待执行 `backend/scripts/testMattingProviders.js`
- 测试图片数量：0
- 测试 Provider：sharp, external

## Provider 对比

| Provider | 成功数 | 失败数 | 平均耗时 | 平均置信度 | good | medium | poor | 备注 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| sharp | 0 | 0 | 0ms | 0 | 0 | 0 | 0 | 默认本地粗抠图 |
| external | 0 | 0 | 0ms | 0 | 0 | 0 | 0 | 等待第三方 API 配置 |

## 图片结果

| 图片 | Provider | 背景类型 | 边缘质量 | 置信度 | warnings | 输出文件 |
|---|---|---|---|---:|---|---|

## 结论

- 白底图推荐：sharp 可作为低成本默认方案。
- 复杂背景推荐：建议配置 external 后对比。
- 手持图推荐：建议 external 或人工复核。
- 是否建议启用 external：等待真实 API 和样图验证后决定。
