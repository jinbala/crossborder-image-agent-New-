import { getVisionRecognitionConfig } from './visionRecognitionConfig.js';

export function buildVisionPrompt({ task, image } = {}) {
  const target = task?.targets?.[0] || {};
  const recognitionConfig = getVisionRecognitionConfig();
  const context = {
    taskId: task?.id || null,
    platform: task?.platform || target.platformId || null,
    site: task?.site || target.site || null,
    language: task?.language || target.language || null,
    category: task?.category || target.category || null,
    imageFileName: image?.displayName || image?.originalName || image?.fileName || image?.storedName || null,
    imageCount: task?.sourceImages?.length || 1,
    images: (task?.sourceImages || []).slice(0, 15).map((item, index) => ({
      imageIndex: index,
      imageName: item.displayName || item.originalName || item.fileName || item.storedName || `image-${index + 1}`
    })),
    visibleTextLimits: {
      perImage: recognitionConfig.visibleTextLimitPerImage,
      total: recognitionConfig.visibleTextTotalLimit
    },
    recognitionMode: {
      mode: recognitionConfig.mode,
      imageMaxWidth: recognitionConfig.imageMaxWidth,
      imageQuality: recognitionConfig.imageQuality,
      maxImages: recognitionConfig.maxImages
    }
  };

  return `You are a professional cross-border e-commerce product image recognition expert.

Analyze the provided product images carefully and extract only information that is visible or strongly supported by the images.
The user may provide up to 15 images for the same product or SKU. Treat them as one product evidence set.
First synthesize the core product information across all images, then record visibleText by image.
Recognition mode is "${context.recognitionMode.mode}". In fast mode, prioritize core product fields and compliance risk text over complete OCR.

Return strict JSON only. Do not use Markdown. Do not include explanations outside JSON.

Context:
${JSON.stringify(context, null, 2)}

Important rules:
1. Do not guess uncertain information.
2. Use null or empty arrays for unknown fields.
3. Do not invent capacity, size, material, certification, medical claims, waterproof rating, compatibility, warranty, or performance data.
4. Separate visible information from inferred information.
5. Summarize useful visible text by image. Do not output every repeated OCR fragment.
6. Detect whether there is Chinese text.
7. Detect watermark, price, discount, promotion text, platform logo, seller logo, certification marks, medical claims, brand logo, and sensitive marketplace elements.
8. If a field is uncertain, lower its confidence score.
9. Output confidence values from 0 to 1.
10. This image may be used for Amazon, Temu, Noon, Rakuten, or Ozon product listing images, so accuracy and compliance risk detection are critical.
11. Context must not cause you to invent product parameters.
12. sellingPoints must be concise ecommerce-relevant facts from visible text or strongly supported visual evidence. Do not paste all OCR text into sellingPoints and do not create marketing copy.
13. capacity, sizes, dimensions, weight, material, interfaceType, compatibleDevices, warranty, certifications, packageIncluded, and visibleSpecs must be extracted only when visible or strongly supported.
14. If Chinese text, price, promotion/discount text, certification marks, medical claims, or watermark are present, include a matching risk item with evidence.
15. If the image is too unclear or a field cannot be identified, leave the field empty and add a short note.
16. When multiple images are provided, combine evidence carefully: main image may show appearance, spec image may show parameters, package image may show included items, and detail image may show material or accessories.
17. Do not mix unrelated content across images into fake product parameters.
18. If images contain conflicting information, keep fields conservative and explain the conflict in notes.
19. For visibleText, include imageIndex and imageName when possible.
20. For external hard drives, portable SSDs, USB storage, and electronics, pay special attention to productName, category, brand, model, capacity, interfaceType, compatibleDevices, dimensions, weight, material, packageIncluded, visibleSpecs, sellingPoints, and warranty.
21. Do not treat certification marks as valid certifications unless they are clearly visible; if visible, include both certifications and a risk item for manual verification.
22. If text is very dense, keep visibleText structured by image and use notes to summarize what needs manual confirmation.
23. visibleText should contain at most ${context.visibleTextLimits.perImage} key text items per image and at most ${context.visibleTextLimits.total} items in total.
24. Prioritize visibleText that helps confirm product data: product name, capacity, interface, dimensions, material, package included, compatible devices, selling point phrases, and risk text such as Chinese, price, promotion, certification, or watermark.
25. Keep duplicate text only once. Ignore repeated footer text, decorative UI labels, and low-value icon labels.
26. If OCR content is long and summarized, add this exact note: "OCR text summarized due to long content".
27. Do not reduce or omit capacity, interfaceType, compatibleDevices, packageIncluded, dimensions, material, visibleSpecs, or risks just because visibleText is summarized.
28. In fast mode, do not perform complete OCR; extract only key product information and risk text.
29. Do not put common market specs, common capacities, common certifications, common materials, or guessed model/brand data into productInfoRaw.
30. The following fields require strict evidence: capacity, dimensions, material, interfaceType, compatibleDevices, packageIncluded, certifications, warranty, model, and brand.
31. If capacity, dimensions, certifications, warranty, brand, or model are not clearly visible in image text, return null or an empty array for that productInfoRaw field.
32. If material, interfaceType, compatibleDevices, or packageIncluded are based on visual evidence rather than text, include fieldEvidence with source "visual", imageIndex, reason, and confidence.
33. If information is only possible or inferred, put it in inferredCandidates or notes; do not put it into productInfoRaw.
34. For every key field you do fill, include fieldEvidence when possible. For visible text evidence include imageIndex, imageName, text, value, and confidence.
35. For productInfoRaw.colors, output only product body colors or clearly confirmed color variants/options.
36. Do not treat text color, title color, icon color, logo color, connector ring color, button trim, small decorative accent, packaging color, background color, or lighting color as product colors.
37. If a color is only an accent/detail, such as an orange USB-C port ring on a black portable SSD, put it in notes or inferredCandidates instead of productInfoRaw.colors.
38. When colors are filled, include fieldEvidence.colors and explain whether the evidence shows product body colors, confirmed variants, or only an accent/detail.

Required JSON schema:
{
  "productInfoRaw": {
    "productName": null,
    "category": null,
    "brand": null,
    "model": null,
    "colors": [],
    "sizes": [],
    "capacity": [],
    "material": null,
    "interfaceType": null,
    "compatibleDevices": [],
    "dimensions": [],
    "certifications": [],
    "warranty": null,
    "weight": null,
    "packageIncluded": [],
    "sellingPoints": [],
    "useScenarios": [],
    "targetUsers": [],
    "visibleSpecs": []
  },
  "visibleText": [
    {
      "text": "",
      "language": "",
      "locationHint": "",
      "imageIndex": 0,
      "imageName": "",
      "confidence": 0
    }
  ],
  "risks": [
    {
      "type": "",
      "level": "low",
      "message": "",
      "evidence": []
    }
  ],
  "confidence": {
    "productName": 0,
    "category": 0,
    "brand": 0,
    "model": 0,
    "colors": 0,
    "sizes": 0,
    "capacity": 0,
    "material": 0,
    "interfaceType": 0,
    "compatibleDevices": 0,
    "dimensions": 0,
    "packageIncluded": 0,
    "sellingPoints": 0,
    "visibleText": 0
  },
  "fieldEvidence": {
    "productName": [],
    "category": [],
    "brand": [],
    "model": [],
    "colors": [],
    "capacity": [],
    "interfaceType": [],
    "compatibleDevices": [],
    "dimensions": [],
    "material": [],
    "packageIncluded": [],
    "certifications": [],
    "warranty": [],
    "sellingPoints": [],
    "visibleSpecs": []
  },
  "inferredCandidates": [
    {
      "field": "",
      "value": "",
      "reason": "",
      "evidence": []
    }
  ],
  "notes": []
}`;
}
