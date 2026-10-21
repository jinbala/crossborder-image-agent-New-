import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { payload, verifyManifest } = require('../src/update-service.cjs');
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
if (args.includes('--help') || !args.includes('--installer') || !args.includes('--key') || !args.includes('--url') || !args.includes('--version') || !args.includes('--notes') || !args.includes('--out')) {
  console.log('node scripts/sign-update.mjs --installer setup.exe --key PRIVATE_KEY_FILE --url https://updates.example/setup.exe --version 0.7.0 --notes changelog.txt --out latest.json');
  console.log('Private keys must remain outside source, runtime and release directories. Only signed JSON manifests and installers are published.');
  process.exit(args.includes('--help') ? 0 : 1);
}
const keyPath = path.resolve(option('--key'));
const desktopRoot = path.resolve(import.meta.dirname, '..');
if (keyPath.startsWith(`${desktopRoot}${path.sep}`)) throw new Error('发布私钥不得存放在 desktop 源码、运行或打包目录中');
const privateKey = createPrivateKey(await fs.readFile(keyPath));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('仅支持 Ed25519 发布者签名');
const bytes = await fs.readFile(path.resolve(option('--installer')));
const manifest = { version: option('--version'), releasedAt: new Date().toISOString(), notes: await fs.readFile(option('--notes'), 'utf8'), url: option('--url'), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, kind: 'installer' };
manifest.signature = sign(null, Buffer.from(payload(manifest)), privateKey).toString('base64');
verifyManifest(manifest, createPublicKey(privateKey), manifest.url);
await fs.writeFile(path.resolve(option('--out')), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`签名清单已生成：${manifest.version}，${manifest.size} bytes。未上传或发布任何文件。`);
