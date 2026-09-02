export type FailurePoint = string;

export class InjectedFailure extends Error {
  readonly point: FailurePoint;

  constructor(point: FailurePoint, message = `Injected failure at ${point}`) {
    super(message);
    this.name = 'InjectedFailure';
    this.point = point;
  }
}

interface FailureRule {
  remaining: number | undefined;
}

/** Deterministic, one-shot or persistent failures for adapter-boundary tests. */
export class FailureInjector {
  private readonly rules = new Map<FailurePoint, FailureRule>();
  private readonly observed = new Map<FailurePoint, number>();

  failNext(point: FailurePoint): this {
    this.rules.set(point, { remaining: 1 });
    return this;
  }

  failTimes(point: FailurePoint, count: number): this {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError('Failure count must be a positive integer');
    }
    this.rules.set(point, { remaining: count });
    return this;
  }

  failAlways(point: FailurePoint): this {
    this.rules.set(point, { remaining: undefined });
    return this;
  }

  clear(point?: FailurePoint): this {
    if (point === undefined) {
      this.rules.clear();
    } else {
      this.rules.delete(point);
    }
    return this;
  }

  calls(point?: FailurePoint): number {
    if (point !== undefined) {
      return this.observed.get(point) ?? 0;
    }
    let total = 0;
    for (const count of this.observed.values()) {
      total += count;
    }
    return total;
  }

  check(point: FailurePoint): void {
    this.observed.set(point, this.calls(point) + 1);
    const rule = this.rules.get(point) ?? this.rules.get('*');
    if (rule === undefined) {
      return;
    }
    if (rule.remaining !== undefined) {
      rule.remaining -= 1;
      if (rule.remaining < 1) {
        this.rules.delete(point);
        if (this.rules.get('*') === rule) {
          this.rules.delete('*');
        }
      }
    }
    throw new InjectedFailure(point);
  }

  async run<T>(point: FailurePoint, operation: () => T | Promise<T>): Promise<T> {
    this.check(point);
    return operation();
  }
}

export function createFailureInjector(): FailureInjector {
  return new FailureInjector();
}
