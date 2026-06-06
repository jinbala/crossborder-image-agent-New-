# Vision Recognition Test Assets

这里用于临时放真实商品图，配合 `runVisionBatchTest.js` 做多 SKU 识别测试。不要提交敏感图片、侵权图片、大量商品图，也不要把 API Key 写进任何测试文件。

推荐目录结构：

```text
backend/test-assets/
  sku001-hard-drive/
    01-main.png
    02-size.png
    03-feature.png
    04-package.png
    05-detail.png

  sku002-hard-drive/
    01-main.png
    02-size.png
    03-feature.png
    04-package.png

  sku003-water-bottle/
    01-main.png
    02-size.png
    03-package.png
```

规则：

- 每个子文件夹代表一个 SKU 或一个商品。
- 每个 SKU 最少 1 张图片，最多 15 张图片。
- 支持 jpg、jpeg、png、webp。
- 单张图片不超过 10MB。
- 单个 SKU 总量不超过 100MB。
- 文件名按数字排序，例如 `01-main.png`、`02-size.png`。
- 不支持的文件格式会被跳过并写入测试结果。
- 超过大小限制的图片会被跳过并写入测试结果。

常用命令：

```bash
cd backend
node scripts/runVisionBatchTest.js --provider gemini --dir test-assets/sku001-hard-drive
node scripts/runVisionBatchTest.js --providers gemini,qwen,openai --dir test-assets/sku001-hard-drive
node scripts/runVisionBatchTest.js --provider gemini --dir test-assets --recursive
node scripts/runVisionBatchTest.js --providers gemini,qwen,openai --dir test-assets --recursive
node scripts/runVisionBatchTest.js --from-result test-results/vision-batch-xxxx.json
```
