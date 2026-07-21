class RateLimit {
  constructor() {
    this.buckets = new Map();
  }

  hit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  prune() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.start > 120000) this.buckets.delete(key);
    }
  }
}

module.exports = new RateLimit();
