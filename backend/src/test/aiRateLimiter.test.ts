import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SlidingRateLimiter } from '../ai/rateLimiter.ts';

describe('rate limiter deslizante', () => {
  it('respeita o teto dentro da janela', () => {
    const limiter = new SlidingRateLimiter(3);
    const base = 1_000_000;
    assert.equal(limiter.tryConsume(base), true);
    assert.equal(limiter.tryConsume(base + 1), true);
    assert.equal(limiter.tryConsume(base + 2), true);
    assert.equal(limiter.tryConsume(base + 3), false);
    assert.equal(limiter.size, 3);
  });

  it('libera quando os carimbos saem da janela de 60s', () => {
    const limiter = new SlidingRateLimiter(2);
    const base = 2_000_000;
    limiter.tryConsume(base);
    limiter.tryConsume(base + 10);
    assert.equal(limiter.tryConsume(base + 20), false);
    assert.equal(limiter.tryConsume(base + 60001), true);
  });
});
