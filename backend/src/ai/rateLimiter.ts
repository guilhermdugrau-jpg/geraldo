/** Limitador por janela deslizante (1 minuto) — evita tempestade de IA. */
export class SlidingRateLimiter {
  private stamps: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  tryConsume(now: number): boolean {
    const oneMinuteAgo = now - 60000;
    this.stamps = this.stamps.filter((stamp) => stamp > oneMinuteAgo);
    if (this.stamps.length >= this.maxPerMinute) return false;
    this.stamps.push(now);
    return true;
  }

  get size(): number {
    return this.stamps.length;
  }
}
