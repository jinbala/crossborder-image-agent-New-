# Vision Recognition Test Report

## 1. 测试概览

- 测试时间：2026-05-28T18:59:22.302Z
- 测试 SKU 数量：1
- 测试图片数量：9
- 测试 Provider：gemini
- 结果 JSON：`backend/test-results/vision-batch-20260528185922.json`
- 图片压缩：enabled
- 识别模式：balanced
- 图片最大宽度：1280
- JPEG 质量：75
- VISION_BATCH_SIZE：4
- VISION_RETRY_COUNT：1
- 说明：字段完整性不等于准确率，所有结论都需要人工复核。

## 2. Provider 总体对比

| Provider | 成功数 | 失败数 | 跳过数 | 平均耗时 | 平均字段完整度 | JSON 稳定性 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gemini | 1 | 0 | 0 | 89566 ms | 100/100 | 1/1 | 需人工复核准确率 |

## 3. SKU 识别摘要

### sku001-hard-drive

| Provider | 状态 | 耗时 | 字段完整度 | 批次 | 部分成功 | 压缩前后 | 商品名称 | 类目 | 容量 | 接口 | 兼容设备 | 风险数 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini | success | 89566 ms | 100/100 | 3 batches / failed 0 | - | 18410KB -> 1428KB | Portable External Hard Drive | External Hard Drive | 500GB, 1TB, 2TB, 4TB, 5TB | Type-C | Phone, Laptop, Tablet, TV, Game Console, Smartphone, Smart TV, Devices with Type-C interface and OTG support, Phones, Laptops, TVs, Game Consoles, Windows, macOS, Android, iOS | 2 | 字段 material 存在多批识别冲突：Plastic / Durable Shell, Anti-Scratch Surface, Specific capacity (e.g., TB/GB) is not visible, only illustrative storage examples and a mention of 'Multiple Capacities'., No specific dimensions or weight values are visible, only descriptive terms like 'Slim and lightweight' and 'Compact size'., visibleText truncated: original 21, kept 10, OCR text summarized due to long content, visibleText truncated: original 68, kept 39, OCR text summarized due to long content |

## 4. 速度优化对比

| SKU | Provider | Mode | 原图总大小 | 发送大小 | 压缩率 | 发送图片数 | 耗时 | 字段完整度 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sku001-hard-drive | gemini | balanced | 17.98 MB | 1.39 MB | 92% | 9/9 | 89566 ms | 100/100 |

## 5. 字段证据检查

### sku001-hard-drive / gemini

| 字段 | 值 | 是否有证据 | 证据类型 | 风险 | 说明 |
| --- | --- | --- | --- | --- | --- |
| capacity | 500GB, 1TB, 2TB, 4TB, 5TB | yes | inferred, visible_text | low | has evidence |
| certifications |  | no |  | none | - |
| warranty |  | no |  | none | - |
| material | Plastic | yes | visual, inferred | low | has evidence |
| compatibleDevices | Phone, Laptop, Tablet, TV, Game Console, Smartphone, Smart TV, Devices with Type-C interface and OTG support, Phones, Laptops, TVs, Game Consoles, Windows, macOS, Android, iOS | yes | inferred, visible_text | low | has evidence |
| interfaceType | Type-C | yes | inferred, visible_text | low | has evidence |
| dimensions | 124mm, 77.5mm, 13mm | yes | inferred, visible_text | low | has evidence |
| packageIncluded | 1 x Portable External Hard Drive, 1 x Type-C Cable, 1 x User Manual | yes | inferred, visible_text | low | has evidence |
| model |  | no |  | none | - |
| brand |  | no |  | none | - |

## 6. 字段完整性详情

### sku001-hard-drive / gemini

- productName: Portable External Hard Drive
- category: External Hard Drive
- brand: -
- model: -
- capacity: 500GB, 1TB, 2TB, 4TB, 5TB
- interfaceType: Type-C
- compatibleDevices: Phone, Laptop, Tablet, TV, Game Console, Smartphone, Smart TV, Devices with Type-C interface and OTG support, Phones, Laptops, TVs, Game Consoles, Windows, macOS, Android, iOS
- dimensions: 124mm, 77.5mm, 13mm
- material: Plastic
- packageIncluded: 1 x Portable External Hard Drive, 1 x Type-C Cable, 1 x User Manual
- sellingPoints: Type-C Connection (Plug and play), Photo & Video Backup, Pocket Size (Lightweight and easy to carry), Creator Storage (Store projects, assets & files), Multi-Device Compatible, Compact Storage, One Drive Many Devices, Free up space on your devices, Keep photos, videos and files safe and organized, Plug & Play, No software needed, Type-C Connection, LED Indicator Light, Large Capacity Storage, Shock Resistant, Drop Protection, Durable Shell, Wide Temperature Range, Anti-Scratch Surface, Secure Connection, Compact & Portable, Reliable Storage, Data Protection, Easy Backup, Wide Compatibility, Organize & Store, Compact Size, Large Capacity
- visibleSpecs: 124mm x 77.5mm x 13mm, Type-C Connection, No Software Required, Plug & Play Ready, LED Indicator Light, Shock Resistant, Drop Protection, Durable Shell, Wide Temperature Range, Anti-Scratch Surface, Secure Type-C interface, Compact & Portable, Product Type: Portable External Hard Drive, Interface: Type-C, Color: Black, Capacities: 500GB / 1TB / 2TB / 4TB / 5TB, Compatibility: Windows / macOS / Android / iOS, Use For: Photos, Videos, Music, Documents, File Backup, Dimensions: 124mm x 77.5mm x 13mm
- visibleText count: 39
- visibleText original count: 68
- visibleText kept count: 39
- visibleText truncated: yes
- visibleText samples: 124mm, 77.5mm, 13mm, Expand Phone Storage, 77.5mm, 13mm, 124mm, 500GB / 1TB / 2TB, 4TB / 5TB, Note: 1GB = 1,000,000,000 bytes. Actual usable capacity may be less. Storage capacity may vary based on file size, format, and system.
- risks count: 2
- notes: 字段 material 存在多批识别冲突：Plastic / Durable Shell, Anti-Scratch Surface, Specific capacity (e.g., TB/GB) is not visible, only illustrative storage examples and a mention of 'Multiple Capacities'., No specific dimensions or weight values are visible, only descriptive terms like 'Slim and lightweight' and 'Compact size'., visibleText truncated: original 21, kept 10, OCR text summarized due to long content, visibleText truncated: original 68, kept 39, OCR text summarized due to long content
- field completeness: 100/100
- batch: 3 batches / failed 0
- batch size: 4
- retry count: 1
- partial success: no
- preprocess: 18410KB -> 1428KB
- failed batches: 
- modeDebug.mode: balanced
- modeDebug.maxWidth: 1280
- modeDebug.quality: 75
- modeDebug.requestTimeoutMs: 300000
- modeDebug.visibleTextLimitPerImage: 10
- modeDebug.visibleTextTotalLimit: 80
- modeDebug.maxImagesSent: 9
- modeDebug.imageCountSent: 9
- modeDebug.totalProcessedImageBytes: 1462418
- modeDebug.batchCount: 3
- modeDebug.retryCount: 1
- modeDebug.retryTriggered: no
- modeDebug.providerDurationMs: 89566
- modeDebug.slowestBatchDurationMs: 41737
- modeDebug.latencyOutlier: no
- status/error: success

## 7. 常见问题

- JSON 解析失败：0
- normalize 失败：0
- 超时：0
- 缺少 API Key：0
- OCR 过长：1
- 字段漏识别：0

## 8. 移动硬盘重点检查

- 是否识别为 portable external hard drive / external SSD：需人工复核 category/productName。
- 是否识别容量，例如 1TB / 2TB / 4TB：查看 capacity 和 visibleSpecs。
- 是否识别接口，例如 USB 3.0、Type-C、USB-C：查看 interfaceType 和 visibleSpecs。
- 是否识别兼容设备，例如 PC、Mac、laptop、desktop、phone：查看 compatibleDevices。
- 是否识别包装清单，例如 hard drive、USB cable、manual、box：查看 packageIncluded。
- 是否识别材质或外观：查看 material / colors / visibleSpecs。
- 是否识别图片上的英文文字：查看 visibleText count 和具体 JSON。
- 是否检测中文图片文字：查看 visibleText language 和 risks。
- 是否检测水印、价格、促销、认证等风险：查看 risks。
- 是否胡编不存在的认证、容量、功能：必须人工核对原图。

## 9. 初步结论

- 最稳定 provider：gemini
- 字段最完整 provider：gemini
- OCR 最好 provider：需人工复核 visibleText 质量
- 风险识别最好 provider：需人工复核 risks 质量
- 速度最快 provider：gemini
- 建议下一步：先用 3-5 个 SKU 对比 Gemini / Qwen / OpenAI；如果字段完整性和准确率稳定，再进入真实审核 Provider。

## 10. 前端手动测试步骤

1. 配置 `.env`：`AI_PROVIDER=mock`，`VISION_PROVIDER=gemini`。
2. 启动小程序。
3. 新建任务。
4. 上传 1-15 张商品图片。
5. 点击上传并识别。
6. 进入商品确认页。
7. 检查商品核心字段。
8. 检查图片文字识别结果是否按图片分组。
9. 检查风险项是否分级展示。
10. 手动修改商品信息。
11. 点击保存并继续。
