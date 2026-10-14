export class MetadataCache {
  private readonly values = new Map<string, { value: unknown; expires: number }>();
  constructor(private readonly ttl: number, private readonly now: () => number = Date.now) {}
  async get<T>(key: string, fetch: () => Promise<T>, validate: (v: T) => void): Promise<T> {
    const cached = this.values.get(key);
    if (this.ttl && cached && cached.expires > this.now()) return structuredClone(cached.value) as T;
    this.values.delete(key);
    const value = await fetch();
    validate(value); // Neither network errors nor incompatible API responses enter the cache.
    if (this.ttl) {
      for (const [k, entry] of this.values) if (entry.expires <= this.now()) this.values.delete(k);
      if (this.values.size >= 500) this.values.delete(this.values.keys().next().value!);
      this.values.set(key, { value: structuredClone(value), expires: this.now() + this.ttl });
    }
    return value;
  }
}
