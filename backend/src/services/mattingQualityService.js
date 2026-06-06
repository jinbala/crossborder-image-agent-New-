import fs from 'node:fs/promises';
import sharp from 'sharp';

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function levelFromScore(score, hasOutput) {
  if (!hasOutput) return 'unknown';
  if (score >= 75) return 'good';
  if (score >= 45) return 'medium';
  return 'poor';
}

async function alphaRatios(filePath) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  let subject = 0;
  const pixels = info.width * info.height;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] <= 12) transparent += 1;
    if (data[i] > 24) subject += 1;
  }
  return {
    transparentRatio: pixels ? transparent / pixels : 0,
    subjectAreaRatio: pixels ? subject / pixels : 0
  };
}

export async function evaluateMattingQuality({ providerResult = {}, fallbackUsed = false } = {}) {
  const details = {
    hasOutput: false,
    outputFileSize: 0,
    transparentRatio: 0,
    edgeComplexity: 0,
    subjectAreaRatio: 0,
    providerError: providerResult.status === 'failed' || Boolean(providerResult.error),
    fallbackUsed: Boolean(fallbackUsed)
  };
  const warnings = [];
  let score = 100;

  if (details.providerError) {
    score -= 45;
    warnings.push('抠图 Provider 返回失败，请查看错误信息。');
  }
  if (details.fallbackUsed) {
    score -= 10;
    warnings.push('第三方抠图失败或不可用，已 fallback 到 sharp 本地抠图。');
  }

  const outputPath = providerResult.output?.subjectPngPath;
  if (!outputPath) {
    score -= 55;
    warnings.push('未生成可用的抠图结果。');
    const finalScore = clampScore(score);
    return {
      score: finalScore,
      level: levelFromScore(finalScore, false),
      warnings,
      details
    };
  }

  try {
    const stat = await fs.stat(outputPath);
    details.hasOutput = stat.size > 0;
    details.outputFileSize = stat.size;
    const ratios = await alphaRatios(outputPath);
    details.transparentRatio = Number(ratios.transparentRatio.toFixed(4));
    details.subjectAreaRatio = Number(ratios.subjectAreaRatio.toFixed(4));

    if (!details.hasOutput || stat.size < 256) {
      score -= 35;
      warnings.push('输出文件过小，可能没有成功抠出主体。');
    }
    if (details.transparentRatio < 0.02) {
      score -= 20;
      warnings.push('透明区域比例偏低，背景可能没有被充分移除。');
    }
    if (details.subjectAreaRatio < 0.03) {
      score -= 25;
      warnings.push('主体区域比例偏低，建议人工复查。');
    }
    if (details.subjectAreaRatio > 0.96) {
      score -= 15;
      warnings.push('主体区域几乎铺满整图，可能仍包含背景。');
    }
  } catch {
    score -= 45;
    warnings.push('无法读取抠图输出文件，质量评分为未知。');
  }

  for (const warning of providerResult.metadata?.warnings || []) {
    if (warning === 'complex_background_detected') warnings.push('原图背景较复杂，边缘质量可能不稳定。');
    if (warning === 'manual_review_recommended') warnings.push('建议人工检查抠图边缘。');
  }

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    level: levelFromScore(finalScore, details.hasOutput),
    warnings,
    details
  };
}
