import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktop);
const trust = await fs.readFile(path.join(desktop, 'src', 'update-trust.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
if (trust) {
  if (Object.keys(trust).some((key) => !['feedUrl', 'publicKey'].includes(key)) || /PRIVATE KEY/.test(trust.publicKey || '') || createPublicKey(trust.publicKey).asymmetricKeyType !== 'ed25519') throw new Error('更新配置仅允许 HTTPS feedUrl 与 Ed25519 公钥；禁止私钥或其他凭据');
  const url = new URL(trust.feedUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('更新源必须为无凭据的 HTTPS 地址');
}
if (!process.env.npm_execpath) throw new Error('请通过 npm run stage 执行构建');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
  cwd: path.join(root, 'frontend'), stdio: 'inherit'
});
if (result.status !== 0) throw new Error('前端构建失败，停止打包');
const runtime = path.join(desktop, 'runtime');
// Delete only generated staging children, never a workspace or user-data directory.
for (const relative of ['backend', 'frontend', 'browser-extension', 'docs']) {
  const target = path.resolve(runtime, relative);
  if (!target.startsWith(`${runtime}${path.sep}`)) throw new Error('Invalid staging target');
  await fs.rm(target, { recursive: true, force: true });
}
await fs.mkdir(path.join(runtime, 'backend'), { recursive: true });
await fs.cp(path.join(root, 'backend', 'src'), path.join(runtime, 'backend', 'src'), { recursive: true });
await fs.copyFile(path.join(root, 'backend', 'package.json'), path.join(runtime, 'backend', 'package.json'));
await fs.cp(path.join(root, 'frontend', 'dist'), path.join(runtime, 'frontend'), { recursive: true });
// sopService imports this pure shared guide; include its exact source dependency.
await fs.mkdir(path.join(runtime, 'frontend', 'src', 'utils'), { recursive: true });
await fs.copyFile(path.join(root, 'frontend', 'src', 'utils', 'batchWorkflowGuide.js'), path.join(runtime, 'frontend', 'src', 'utils', 'batchWorkflowGuide.js'));
await fs.copyFile(path.join(root, 'frontend', 'src', 'utils', 'exportTargets.js'), path.join(runtime, 'frontend', 'src', 'utils', 'exportTargets.js'));
await fs.copyFile(path.join(root, 'frontend', 'package.json'), path.join(runtime, 'frontend', 'package.json'));
await fs.cp(path.join(root, 'browser-extension'), path.join(runtime, 'browser-extension'), { recursive: true });
await fs.mkdir(path.join(runtime, 'docs'), { recursive: true });
for (const name of ['user-manual.md', 'xingya-web-client-development-requirements.md', 'implementation-progress.md']) {
  await fs.copyFile(path.join(root, 'docs', name), path.join(runtime, 'docs', name));
}
console.log('客户端运行资源准备完成（未复制凭据、账号、图片或运行数据）');
