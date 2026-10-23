// Keep optional business dependencies off the health/static/recovery startup
// path. Mount AFTER access guards, just like an ordinary Express router.
export function lazyRouter(load) {
  let pending;
  function resolveRouter() {
    if (!pending) {
      pending = Promise.resolve().then(load).then(module => {
        const router = module.default;
        if (typeof router !== 'function') throw new TypeError('Lazy route module must export a router');
        return router;
      }).catch(error => { pending = undefined; throw error; });
    }
    return pending;
  }
  return (req, res, next) => {
    // Invoke from each request's own promise continuation, not from the first
    // request's cached import: AsyncLocalStorage identity must remain scoped.
    resolveRouter().then(router => router(req, res, next)).catch(next);
  };
}
