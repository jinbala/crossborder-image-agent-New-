const count = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
export const skuResultStatuses = Object.freeze({ completed: '已完成', partial: '部分完成', failed: '失败', skipped: '已跳过', pending: '待处理' });
export function skuResultRows(result) {
  return (Array.isArray(result?.skuResults) ? result.skuResults : []).map(group => {
    const items = Array.isArray(group.items) ? group.items : [];
    const success = count(group.successCount), failed = count(group.failedCount), skipped = count(group.duplicateSkippedCount);
    return { sku: group.sku || '', inputCount: count(group.inputCount), successCount: success, failedCount: failed, skippedCount: skipped,
      status: failed ? success ? 'partial' : 'failed' : success ? 'completed' : skipped ? 'skipped' : 'pending',
      roles: [...new Set(items.filter(item => item.status === 'success').map(item => item.role))],
      errorCodes: [...new Set(items.map(item => item.error?.code).filter(Boolean))],
      messages: [...new Set(items.map(item => item.error?.message).filter(Boolean))],
      sourcePaths: items.map(item => item.sourceRelativePath).filter(Boolean) };
  });
}
export function filteredSkuResults(result, { q = '', status = '' } = {}) {
  const query = String(q).trim().toLocaleLowerCase();
  return skuResultRows(result).filter(row => (!status || row.status === status) && (!query || [row.sku, ...row.roles, ...row.errorCodes, ...row.messages, ...row.sourcePaths].some(text => String(text).toLocaleLowerCase().includes(query))));
}
export function skuResultsPage(result, query = {}) {
  const rows = filteredSkuResults(result, query), pageSize = Math.max(1, Math.min(100, count(query.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)), page = Math.min(pages, Math.max(1, count(query.page) || 1));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, pages, page, pageSize };
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function skuResultsCsv(result, query = {}) {
  const header = ['sku', 'status', 'inputCount', 'outputCount', 'failedCount', 'skippedCount', 'roles', 'errorCodes', 'messages'];
  const rows = filteredSkuResults(result, query).map(row => [row.sku, row.status, row.inputCount, row.successCount, row.failedCount, row.skippedCount, row.roles.join(' | '), row.errorCodes.join(' | '), row.messages.join(' | ')]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
