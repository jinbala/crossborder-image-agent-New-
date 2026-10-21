const count=value=>Number.isFinite(Number(value))&&Number(value)>0?Math.floor(Number(value)):0;

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
