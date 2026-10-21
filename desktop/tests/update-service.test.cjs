const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { payload, verifyManifest, createUpdater, newer } = require('../src/update-service.cjs');
test('signed update stages verified installer and rejects unsigned, changed or cross-origin packages', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-update-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const data = Buffer.from('test installer; never executed');
  const feedUrl = 'https://updates.example/latest.json';
  const manifest = { version: '0.7.0', releasedAt: new Date().toISOString(), notes: 'Test update', url: 'https://updates.example/setup.exe', sha256: createHash('sha256').update(data).digest('hex'), size: data.length, kind: 'installer' };
  manifest.signature = sign(null, Buffer.from(payload(manifest)), privateKey).toString('base64');
  try {
    assert.throws(() => verifyManifest({ ...manifest, notes: 'tampered' }, publicKey, feedUrl));
    assert.throws(() => verifyManifest({ ...manifest, url: 'https://evil.example/setup.exe' }, publicKey, feedUrl));
    assert.equal(newer('0.10.0', '0.9.0'), true);
    const updater = createUpdater({ directory, config: { feedUrl, publicKey }, currentVersion: '0.6.0', fetchImpl: async (url) => String(url).endsWith('.json') ? Response.json(manifest) : new Response(data) });
    await updater.check(); await updater.stage();
    const installer = await updater.verifiedInstaller('0.7.0'); assert.equal((await fs.readFile(installer)).toString(), data.toString());
    await assert.rejects(updater.readyToInstall('0.7.0'), /回退包/);
    const rollback = { ...manifest, version: '0.6.0' };
    rollback.signature = sign(null, Buffer.from(payload(rollback)), privateKey).toString('base64');
    const rollbackManifest = path.join(directory, 'rollback-import.json'), rollbackInstaller = path.join(directory, 'rollback-import.exe');
    await fs.writeFile(rollbackManifest, JSON.stringify(rollback)); await fs.writeFile(rollbackInstaller, data);
    await updater.importPackage(rollbackManifest, rollbackInstaller);
    assert.equal(await updater.readyToInstall('0.7.0'), installer);
    await fs.writeFile(installer, 'modified'); await assert.rejects(updater.verifiedInstaller('0.7.0'), /已改变/);
    assert.equal((await updater.info()).staged.length, 2);
    const bad = createUpdater({ directory, config: { feedUrl, publicKey }, currentVersion: '0.6.0', fetchImpl: async (url) => String(url).endsWith('.json') ? Response.json(manifest) : new Response(Buffer.from('bad')) });
    await bad.check(); await assert.rejects(bad.stage(), /校验失败/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
