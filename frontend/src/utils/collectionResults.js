const count=value=>Number.isFinite(Number(value))&&Number(value)>0?Math.floor(Number(value)):0;

export const collectionStatuses = Object.freeze({
  queued: '等待执行', running: '执行中', paused: '已保存断点',
  completed: '已完成', completed_with_errors: '完成但有失败',
  pending: '待处理', failed: '失败', skipped: '已跳过', cancelled: '已取消'
});
export const collectionStatusLabel = status => Object.hasOwn(collectionStatuses, status) ? collectionStatuses[status] : String(status ?? '');

export function collectionItemsFiltered(job, { q = '', status = '' } = {}) {
  const query = String(q).trim().toLocaleLowerCase();
  return (Array.isArray(job?.items) ? job.items : []).filter(item =>
    (!status || item.status === status) && (!query ||
      [item.sku, item.title, item.id, item.productUrl, item.error?.message, item.pageWarning?.message]
        .some(value => String(value ?? '').toLocaleLowerCase().includes(query))));
}

// The manifest remains the source of truth; render only this bounded slice.
// CSV intentionally includes every filtered item, not just the visible page.
export function collectionItemsPage(job, query = {}) {
  const items = collectionItemsFiltered(job, query);
  const size = Math.max(1, Math.min(100, count(query.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(pages, Math.max(1, count(query.page) || 1));
  return { items: items.slice((page - 1) * size, page * size), total: items.length, pages, page, pageSize: size };
}

function csvCell(value) {
  let text = String(value ?? '');
  // Quoting alone does not prevent spreadsheet formula execution. Keep the
  // original manifest intact and prefix only dangerous CSV display cells.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function collectionItemsCsv(job, query = {}) {
  const header = ['itemId', 'sku', 'title', 'sales', 'status', 'downloadedImages', 'sourceImages', 'attempts', 'errorCode', 'message', 'productUrl'];
  const rows = collectionItemsFiltered(job, query).map(item => [
    item.id, item.sku, item.title, item.sales, item.status,
    (item.images || []).filter(image => image.status === 'success').length,
    item.imageUrls?.length || 0, item.attempts || 0,
    item.error?.code || item.pageWarning?.code || '', item.error?.message || item.pageWarning?.message || '', item.productUrl
  ]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const collectionRunShouldStop = job => job?.status === 'cancelled' || ['pause', 'cancel'].includes(job?.stopRequested);

// Preview only files owned by this collection job. Never use remote image URLs
// from scraped pages as preview requests or expose local filesystem paths.
export function collectionPreviewUrl(jobId,url){
  if(typeof jobId!=='string'||!/^[A-Za-z0-9_-]+$/.test(jobId)||typeof url!=='string')return '';
  const prefix=`/outputs/workbench/${jobId}/images/`;
  if(!url.startsWith(prefix)||/[\\?#]/.test(url)||/%(?:2f|5c)/i.test(url))return '';
  try{const decoded=decodeURIComponent(url);if(decoded.split('/').some(part=>part==='.'||part==='..')||/[\\?#]/.test(decoded))return '';}catch{return '';}
  return /\.(?:png|jpe?g|webp|avif|gif|tiff?)$/i.test(url)?url:'';
}

export function collectionResultGuide(job){
  const summary=job?.summary||{},downloaded=count(summary.downloadedCount),pending=count(summary.pendingCount),failed=count(summary.failedCount)+count(summary.warningCount);
  if(job?.status==='cancelled')return {kind:'cancelled',title:'任务已取消，已有图片和断点保留',description:'不会自动继续下载。可下载已有 ZIP 或导出商品明细；如需恢复，请明确点击处理按钮并确认。'};
  if(pending)return {kind:'pending',title:'下一步：等待回传或补齐下载',description:'先等扩展发送结束再刷新；仍有待处理商品时，可点“连续处理全部”。不要重新建立相同任务。'};
  if(failed)return {kind:'partial',title:'下一步：检查失败或缺失图片',description:'先核对商品明细中的失败原因；可重试失败项，已下载的图片仍可导出。不要把部分完成当作全部成功。'};
  if(downloaded)return {kind:'ready',title:'图片已收到，下一步整理 SKU 图包',description:'下载当前 ZIP 并解压，保留每个 SKU 的子文件夹；再进入“SKU 图包处理”选择解压后的文件夹。采集完成不会自动抠图、压缩或改名。'};
  return {kind:'empty',title:'本任务还没有可用图片',description:'请先检查是否被销量规则跳过或图片回传失败；配对成功不等于图片已下载。'};
}

export function collectionPreviewPage(job,page=1,pageSize=12){
  const size=Math.max(1,Math.min(24,count(pageSize)||12)),images=[];
  for(const item of Array.isArray(job?.items)?job.items:[])for(const image of Array.isArray(item.images)?item.images:[]){
    const url=collectionPreviewUrl(job.id,image.url);if(image.status==='success'&&url)images.push({url,sku:item.sku||'',title:item.title||'',file:image.file||'',sha256:image.sha256||''});
  }
  const pages=Math.max(1,Math.ceil(images.length/size)),current=Math.min(pages,Math.max(1,count(page)||1));
  return {images:images.slice((current-1)*size,current*size),page:current,pages,total:images.length};
}
