// Bounded, per-process limiter. Use an upstream shared limiter for multi-instance deployment.
export function rateLimit({ limit, windowMs, name }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now(), key = req.socket.remoteAddress || 'unknown';
    if (buckets.size > 5000) for (const [id, row] of buckets) if (row.until <= now) buckets.delete(id);
    if (buckets.size >= 10000 && !buckets.has(key)) return res.status(429).json({ error: '请求繁忙，请稍后重试' });
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + windowMs }; buckets.set(key, bucket); }
    bucket.count += 1;
    if (bucket.count > limit) { res.setHeader('Retry-After', String(Math.ceil((bucket.until - now) / 1000))); return res.status(429).json({ error: `${name}请求过于频繁，请稍后重试` }); }
    next();
  };
}
