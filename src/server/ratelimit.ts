const hits = new Map<string, number[]>();

export function clientIp(forwardedFor: string | undefined, realIp: string | undefined): string {
  const raw = forwardedFor?.split(',')[0]?.trim() || realIp?.trim();
  return raw || 'local';
}

/** Sliding window. Returns false when the caller should be rejected. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [name, stamps] of hits) {
      if (stamps.every((at) => now - at >= windowMs)) hits.delete(name);
    }
  }
  return true;
}

export function publicLimit(kind: 'read' | 'write'): number {
  const fromEnv = Number(process.env.RATE_LIMIT_MAX || 0);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return kind === 'read' ? 300 : 120;
}
