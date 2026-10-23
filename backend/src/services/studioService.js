import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import archiver from 'archiver';
import { paths } from './dbPaths.js';
import { indexTask } from './taskCenterService.js';
import { fail } from './accountService.js';
import { writeWorkbenchManifest } from './workbenchSnapshotService.js';

export function creativeBrief(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages.slice(-30).map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content || '').trim().slice(0, 4000) })) : [];
  const text = messages.filter((item) => item.role === 'user').map((item) => item.content).join('\n');
  if (!text) throw fail('请先填写商品与创作要求');
  const mode = /POD|印花|印刷|图案/i.test(text) ? 'pod' : /白底|增强|清晰|锐化/.test(text) ? 'enhance' : 'scene';
  return { engine: 'local-structured-planner', paidGeneration: false, messages,
    response: '已按你的描述整理创作计划（本地规则规划，不冒充大模型对话）。可继续补充要求，或确认计划后在下方制作。图片不会自动发送外部服务。',
    plan: { version: 1, mode, title: text.split('\n').at(-1).slice(0, 80), requirements: text, subject: '保持商品外形、颜色和印花准确，不虚构卖点',
      parameters: { width: mode === 'pod' ? 2400 : 1600, height: mode === 'pod' ? 3000 : 1600, background: '#ffffff', format: mode === 'pod' ? 'png' : 'jpeg', quality: 90, sharpen: mode === 'enhance', normalize: false, placement: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 } },
      approval: '本地合成不收费；真实 AI 生图请进入现有图片任务并单独确认 Provider 和费用。' } };
}

export function studioOptions(raw = {}) {
  const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));
  const placement = raw.placement || {};
  const x = bounded(placement.x, 0.2, 0, 0.95), y = bounded(placement.y, 0.2, 0, 0.95);
  return { mode: ['scene', 'pod', 'enhance'].includes(raw.mode) ? raw.mode : 'scene', name: String(raw.name || '创作图包').slice(0, 100),
    width: Math.round(bounded(raw.width, 1600, 320, 6000)), height: Math.round(bounded(raw.height, 1600, 320, 6000)),
    background: /^#[0-9a-f]{6}$/i.test(raw.background) ? raw.background : '#ffffff',
    format: ['png', 'jpeg', 'webp'].includes(raw.format) ? raw.format : 'jpeg', quality: Math.round(bounded(raw.quality, 90, 40, 100)),
    sharpen: raw.sharpen === true, normalize: raw.normalize === true,
    placement: { x, y, width: bounded(placement.width, 0.6, 0.05, 1 - x), height: bounded(placement.height, 0.6, 0.05, 1 - y) },
    brief: String(raw.brief || '').slice(0, 12000), templateId: String(raw.templateId || '').slice(0, 100), templateVersion: Number(raw.templateVersion) || null };
}

export async function renderStudio(files, backgroundFile, raw = {}) {
  if (!files?.length || files.length > 100) throw fail('请选择 1–100 张印花或商品图片');
  if (raw.confirm !== true) throw fail('请确认图片处理参数；所有输出会写入新目录');
  const options = studioOptions(raw);
  const id = `studio-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const directory = path.join(paths.outputDir, 'workbench', id);
  await fs.mkdir(path.join(directory, 'images'), { recursive: true });
  const url = (file) => `/${path.relative(paths.rootDir, file).split(path.sep).join('/')}`;
  const items = [];
  let backdrop;
  if (backgroundFile) {
    const meta = await sharp(backgroundFile.path, { limitInputPixels: 40_000_000 }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw fail('场景底图只支持 JPG、PNG、WebP');
    backdrop = await sharp(backgroundFile.path, { limitInputPixels: 40_000_000 }).rotate().resize(options.width, options.height, { fit: 'cover' }).png().toBuffer();
  }
  for (let index = 0; index < files.length; index++) {
    try {
      const file = files[index];
      const input = await fs.readFile(file.path);
      const metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw fail('不支持的图片格式');
      let image = sharp(input, { limitInputPixels: 40_000_000 }).rotate();
      if (options.normalize) image = image.normalize();
      if (options.sharpen) image = image.sharpen({ sigma: 1 });
      if (options.mode === 'enhance') image = image.resize(options.width, options.height, { fit: 'contain', background: options.background });
      else {
        const box = options.placement;
        const overlay = await image.resize(Math.round(options.width * box.width), Math.round(options.height * box.height), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        image = (backdrop ? sharp(backdrop) : sharp({ create: { width: options.width, height: options.height, channels: 4, background: options.mode === 'pod' && options.format === 'png' ? { r: 255, g: 255, b: 255, alpha: 0 } : options.background } })).composite([{ input: overlay, left: Math.floor(options.width * box.x), top: Math.floor(options.height * box.y) }]);
      }
      if (options.format === 'jpeg') image = image.flatten({ background: options.background }).jpeg({ quality: options.quality });
      else if (options.format === 'webp') image = image.webp({ quality: options.quality });
      else image = image.png({ compressionLevel: 9 });
      const fileName = `${String(index + 1).padStart(3, '0')}.${options.format === 'jpeg' ? 'jpg' : options.format}`;
      const output = path.join(directory, 'images', fileName);
      await image.toFile(output);
      items.push({ index, status: 'success', sourceName: path.basename(file.originalname), sourceSha256: createHash('sha256').update(input).digest('hex'), fileName, url: url(output), sha256: createHash('sha256').update(await fs.readFile(output)).digest('hex') });
    } catch (error) { items.push({ index, status: 'failed', sourceName: path.basename(files[index].originalname), reason: error.message }); }
  }
  const successCount = items.filter((item) => item.status === 'success').length;
  const now = new Date().toISOString();
  const manifest = { id, type: 'studio', name: options.name, status: successCount === files.length ? 'completed' : successCount ? 'partial' : 'failed', createdAt: now, updatedAt: now, engine: 'sharp-local-compositor', options,
    summary: { inputCount: files.length, outputCount: successCount, successCount, failedCount: files.length - successCount, pendingCount: 0, skippedCount: 0, unprocessedCount: 0 }, items, downloadUrl: url(path.join(directory, `${id}.zip`)) };
  await writeWorkbenchManifest(manifest);
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(path.join(directory, `${id}.zip`));
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve); output.on('error', reject); archive.on('error', reject); archive.pipe(output);
    archive.directory(path.join(directory, 'images'), 'images'); archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' }); archive.finalize();
  });
  indexTask(manifest);
  return manifest;
}
