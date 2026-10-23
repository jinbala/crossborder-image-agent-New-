import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import { lazyRouter } from '../src/utils/lazyRouter.js';

test('concurrent first requests share the import but retain separate actor contexts', { timeout: 3000 }, async () => {
  const actors = new AsyncLocalStorage(); let loads = 0, requests = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const app = express();
  app.use((req, _res, next) => { requests++; actors.run(req.get('x-actor'), next); });
  app.use('/lazy', lazyRouter(async () => {
    loads++; await ready;
    return { default: (req, res) => setImmediate(() => res.json({ actor: actors.getStore(), path: req.path })) };
  }));
  const first = request(app).get('/lazy/a').set('x-actor', 'member-a').then(value => value);
  const second = request(app).get('/lazy/b').set('x-actor', 'member-b').then(value => value);
  try {
    while (requests < 2) await new Promise(resolve => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(loads, 1); assert.deepEqual(a.body, { actor: 'member-a', path: '/a' });
    assert.deepEqual(b.body, { actor: 'member-b', path: '/b' });
    await request(app).get('/lazy/c').set('x-actor', 'member-c').expect(200, { actor: 'member-c', path: '/c' });
    assert.equal(loads, 1);
  } finally { release(); }
});

test('failed imports and invalid exports forward errors and permit a later retry', async () => {
  let loads = 0;
  const app = express();
  app.use('/lazy', lazyRouter(async () => {
    loads++;
    if (loads === 1) throw Object.assign(new Error('import failed'), { statusCode: 503 });
    if (loads === 2) return { default: null };
    return { default: (_req, res) => res.json({ ok: true }) };
  }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  await request(app).get('/lazy').expect(503, { error: 'import failed' });
  await request(app).get('/lazy').expect(500, { error: 'Lazy route module must export a router' });
  await request(app).get('/lazy').expect(200, { ok: true }); assert.equal(loads, 3);
});

test('guards run before lazy imports; fallthrough, nested routes and errors keep Express semantics', async () => {
  let loads = 0;
  const app = express();
  app.use((req, res, next) => req.get('x-approved') === 'yes' ? next() : res.sendStatus(403));
  app.use('/lazy', lazyRouter(async () => {
    loads++; const router = express.Router();
    router.get('/nested/:id', (req, res) => res.json({ id: req.params.id, base: req.baseUrl }));
    router.get('/throw', () => { throw Object.assign(new Error('route failed'), { statusCode: 409 }); });
    return { default: router };
  }));
  app.use((_req, res) => res.status(404).json({ missing: true }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  await request(app).get('/lazy/nested/a').expect(403); assert.equal(loads, 0);
  await request(app).get('/lazy/nested/a').set('x-approved', 'yes').expect(200, { id: 'a', base: '/lazy' });
  await request(app).get('/lazy/missing').set('x-approved', 'yes').expect(404, { missing: true });
  await request(app).get('/lazy/throw').set('x-approved', 'yes').expect(409, { error: 'route failed' });
  assert.equal(loads, 1);
});

test('a fresh health/recovery process does not initialize Sharp or OpenAI business dependencies', { timeout: 20000 }, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import request from 'supertest';
    const heavy = [];
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (/[/](?:sharp|openai)[/]/.test(result.url)) heavy.push(result.url);
      return result;
    } });
    const { default: app } = await import('./src/app.js');
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/desktop/runtime?page=1&pageSize=50').expect(200);
    assert.deepEqual(heavy, []);
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
});
