export function mockPreviewReviewNotice(summary = {}) {
  if (!summary.mockPreviewCount) return '';
  return '当前图片为 mock 预览图，仅用于流程测试，不代表真实平台上传结果。mock 预览图可能触发占位图、文字布局或主体保真相关提示，这不等同于真实图片违规。';
}

function toTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export function getReviewStaleNotice(task = {}) {
  if (task.review?.hasStaleResults || (task.reviewResults || []).some((item) => item?.stale)) {
    return '图片重新生成后，旧审核结果可能已过期，请重新审核。';
  }
  const reviewedAt = toTime(task.review?.reviewedAt || task.normalizedReviewReport?.meta?.generatedAt);
  if (!reviewedAt) return '';
  const latestImageAt = Math.max(0, ...(task.generatedImages || []).map((image) => toTime(
    image.updatedAt || image.generatedAt || image.createdAt || image.completedAt
  )));
  if (latestImageAt > reviewedAt) {
    return '图片重新生成后，旧审核结果可能已过期，请重新审核。';
  }
  return '';
}

function issueValue(issue = {}) {
  if (typeof issue === 'string') return issue;
  return `${issue.type || ''} ${issue.category || ''} ${issue.message || ''}`.toLowerCase();
}

export function isMockPreviewIssue(issue = {}) {
  const value = issueValue(issue);
  return /mock|preview|placeholder|占位/.test(value) &&
    !/chinese|price|promotion|watermark|main_image|platform|capacity|certification|warranty/.test(value);
}

export function splitMockPreviewIssues(issues = []) {
  return issues.reduce((result, issue) => {
    if (isMockPreviewIssue(issue)) result.mockPreviewIssues.push(issue);
    else result.complianceIssues.push(issue);
    return result;
  }, { mockPreviewIssues: [], complianceIssues: [] });
}
