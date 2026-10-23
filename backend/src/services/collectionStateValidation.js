// Validate persisted executable collection input. Do not normalize corrupt progress
// into a new job or silently discard completed images while recovering a snapshot.
const fail = (message, code = 'COLLECTION_STATE_SCHEMA', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const webUrl = value => {
  try { const url = new URL(value); return typeof value === 'string' && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
};
export function validateCollectionState(state) {
  const options = state.options;
  if (!object(options) || !['normal', 'temu-deep'].includes(options.mode) || typeof options.name !== 'string' || !Array.isArray(options.replacementRules)) throw fail('采集选项损坏，未启动处理，请检查恢复点');
  for (const [key, min, max] of [['minSales', 0, 1e9], ['extraWaitMs', 0, 30000], ['timeoutMs', 3000, 60000], ['maxImagesPerProduct', 1, 100], ['maxAttempts', 1, 5]]) if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) throw fail('采集参数无效，未启动处理，请检查恢复点');
  if (typeof options.downloadOriginal !== 'boolean' || typeof options.randomFileNames !== 'boolean' || options.replacementRules.some(rule => !object(rule) || typeof rule.from !== 'string' || typeof rule.to !== 'string' || !['prefix', 'text'].includes(rule.mode))) throw fail('采集规则无效，未启动处理，请检查恢复点');
  if (!Array.isArray(state.items) || !state.items.length || state.items.length > 5000) throw fail('采集商品清单无效，未启动处理');
  const ids = new Set(), indices = new Set();
  for (const item of state.items) {
    if (!object(item) || typeof item.id !== 'string' || !/^item-\d{5}$/.test(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.index) || item.index < 1 || item.index > 5000 || indices.has(item.index) || typeof item.sku !== 'string' || typeof item.title !== 'string' || !['pending', 'running', 'completed', 'completed_with_errors', 'failed', 'skipped'].includes(item.status) || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !Array.isArray(item.imageUrls) || item.imageUrls.some(url => !webUrl(url)) || new Set(item.imageUrls).size !== item.imageUrls.length || !Array.isArray(item.images) || (item.productUrl && !webUrl(item.productUrl))) throw fail('采集商品进度无效或重复，未启动处理');
    ids.add(item.id); indices.add(item.index);
    if (!item.sku || /[<>:"/\\|?*\u0000-\u001f]/.test(item.sku) || /^\.{1,2}$/.test(item.sku)) throw fail('采集 SKU 路径无效，未写入图片', 'COLLECTION_STATE_PATH', 403);
    const seen = new Set();
    for (const image of item.images) {
      if (!object(image) || !['pending', 'success', 'failed'].includes(image.status) || !webUrl(image.sourceUrl) || !item.imageUrls.includes(image.sourceUrl) || seen.has(image.sourceUrl)) throw fail('采集图片进度无效，未丢弃原记录');
      seen.add(image.sourceUrl);
      if (image.status === 'success') {
        if (typeof image.file !== 'string' || !image.file || /[\\:\u0000-\u001f]/.test(image.file) || image.file.split('/').some(part => !part || part === '.' || part === '..') || image.url !== `/outputs/workbench/${state.id}/images/${image.file}`) throw fail('采集图片路径无效，未打开外部文件', 'COLLECTION_STATE_PATH', 403);
      }
    }
  }
  return state;
}
