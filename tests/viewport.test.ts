import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { observeViewport } from '../src/viewport';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed = new Set<Element>();
  unobserved: Element[] = [];
  disconnectCalls = 0;

  constructor(
    private callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
    this.unobserved.push(element);
  }

  disconnect(): void {
    this.observed.clear();
    this.disconnectCalls++;
  }

  emit(...entries: [Element, boolean][]): void {
    this.callback(
      entries.map(([target, isIntersecting]) =>
        ({ target, isIntersecting }) as IntersectionObserverEntry
      ),
      this as unknown as IntersectionObserver,
    );
  }
}

const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
let cleanups: (() => void)[] = [];

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: FakeIntersectionObserver,
  });
});

afterEach(() => {
  cleanups.forEach(cleanup => cleanup());
  cleanups = [];
  if (originalObserver) Object.defineProperty(globalThis, 'IntersectionObserver', originalObserver);
  else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
});

function subscribe(
  element: Element,
  callback: (visible: boolean) => void,
  rootMargin?: string,
): void {
  cleanups.push(observeViewport(element, callback, rootMargin));
}

describe('shared viewport observers', () => {
  test('creates observers lazily and shares each root margin across targets', () => {
    const first = {} as Element;
    const second = {} as Element;
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    subscribe(first, () => {});
    subscribe(second, () => {});
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const observer = FakeIntersectionObserver.instances[0]!;
    expect(observer.options?.rootMargin).toBe('0px');
    expect(observer.observed).toEqual(new Set([first, second]));
  });

  test('keeps visibility and preload margins independent and routes entries by target', () => {
    const first = {} as Element;
    const second = {} as Element;
    const visible: boolean[] = [];
    const nearby: boolean[] = [];
    const other: boolean[] = [];
    subscribe(first, value => visible.push(value));
    subscribe(first, value => nearby.push(value), '600px');
    subscribe(second, value => other.push(value));
    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    const [viewport, preload] = FakeIntersectionObserver.instances;
    expect(preload!.options?.rootMargin).toBe('600px');
    preload!.emit([first, true]);
    viewport!.emit([second, true], [first, false], [second, false]);
    expect(visible).toEqual([false]);
    expect(nearby).toEqual([true]);
    expect(other).toEqual([true, false]);
  });

  test('ignores queued entries for unsubscribed targets while remaining targets continue', () => {
    const first = {} as Element;
    const second = {} as Element;
    const removed: boolean[] = [];
    const active: boolean[] = [];
    subscribe(first, value => removed.push(value));
    subscribe(second, value => active.push(value));
    const observer = FakeIntersectionObserver.instances[0]!;
    cleanups[0]!();
    observer.emit([first, true], [second, true]);
    expect(removed).toEqual([]);
    expect(active).toEqual([true]);
    expect(observer.unobserved).toEqual([first]);
    expect(observer.disconnectCalls).toBe(0);
  });

  test('disconnects the final target once and starts a fresh observer after remount', () => {
    const element = {} as Element;
    const oldValues: boolean[] = [];
    const newValues: boolean[] = [];
    subscribe(element, value => oldValues.push(value));
    const oldObserver = FakeIntersectionObserver.instances[0]!;
    cleanups[0]!();
    cleanups[0]!();
    expect(oldObserver.unobserved).toEqual([element]);
    expect(oldObserver.disconnectCalls).toBe(1);
    subscribe(element, value => newValues.push(value));
    const newObserver = FakeIntersectionObserver.instances[1]!;
    oldObserver.emit([element, true]);
    newObserver.emit([element, false]);
    expect(oldValues).toEqual([]);
    expect(newValues).toEqual([false]);
  });

  test('keeps other margin pools alive when one pool becomes empty', () => {
    const element = {} as Element;
    const values: boolean[] = [];
    subscribe(element, () => {});
    subscribe(element, value => values.push(value), '600px');
    const [viewport, preload] = FakeIntersectionObserver.instances;
    cleanups[0]!();
    subscribe({} as Element, () => {}, '600px');
    preload!.emit([element, true]);
    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    expect(viewport!.disconnectCalls).toBe(1);
    expect(preload!.disconnectCalls).toBe(0);
    expect(values).toEqual([true]);
  });

  test('unsubscribes each listener independently even when callbacks are identical', () => {
    const element = {} as Element;
    const values: boolean[] = [];
    const callback = (value: boolean): void => {
      values.push(value);
    };
    subscribe(element, callback);
    subscribe(element, callback);
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.emit([element, true]);
    cleanups[0]!();
    observer.emit([element, false]);
    expect(values).toEqual([true, true, false]);
    expect(observer.unobserved).toEqual([]);
    cleanups[1]!();
    expect(observer.unobserved).toEqual([element]);
    expect(observer.disconnectCalls).toBe(1);
  });

  test('callbacks can replace another listener without dispatching the same entry to it', () => {
    const element = {} as Element;
    const removed: boolean[] = [];
    const added: boolean[] = [];
    let replaced = false;
    subscribe(element, () => {
      if (replaced) return;
      replaced = true;
      cleanups[1]!();
      subscribe(element, value => added.push(value));
    });
    subscribe(element, value => removed.push(value));
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.emit([element, true]);
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
    observer.emit([element, false]);
    expect(added).toEqual([false]);
  });
});
