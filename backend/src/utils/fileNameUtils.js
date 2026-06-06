import path from 'node:path';

const mojibakePattern = /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ�]|(?:涓|鍥|璇|鏂|浠|寮|绗|灏|瀹|棰|鍟|鐗)/;
const cjkPattern = /[\u3400-\u9fff]/;

function basenameOnly(value) {
  return path.basename(String(value || '').replaceAll('\\', '/')).trim();
}

function scoreFileName(value) {
  if (!value) return -100;
  let score = 0;
  if (cjkPattern.test(value)) score += 30;
  if (/[a-zA-Z0-9]/.test(value)) score += 10;
  if (/\.[a-z0-9]{2,5}$/i.test(value)) score += 5;
  if (mojibakePattern.test(value)) score -= 40;
  if (value.includes('\u0000')) score -= 100;
  if (value.length > 160) score -= 20;
  return score;
}

export function decodeOriginalFileName(originalName) {
  const raw = basenameOnly(originalName);
  if (!raw) return '';

  const candidates = [raw];
  let current = raw;
  for (let i = 0; i < 3; i += 1) {
    try {
      current = Buffer.from(current, 'latin1').toString('utf8');
      candidates.push(current);
    } catch {
      break;
    }
  }

  const best = [...new Set(candidates.map((item) => basenameOnly(item)).filter(Boolean))]
    .map((value) => ({ value, score: scoreFileName(value) }))
    .sort((a, b) => b.score - a.score)[0]?.value || raw;

  return best;
}

export function getDisplayFileName(originalName, imageIndex = 0) {
  const decoded = decodeOriginalFileName(originalName);
  if (!decoded || mojibakePattern.test(decoded) || decoded.includes('�')) {
    return `图片 ${imageIndex + 1}`;
  }
  return decoded;
}

export function sanitizeStorageFileName(originalName, id) {
  const decoded = decodeOriginalFileName(originalName);
  const ext = path.extname(decoded).toLowerCase();
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.png';
  return `${id}${safeExt}`;
}
