type ViewportListener = (visible: boolean) => void;

const pools = new Map<string, {
  observer: IntersectionObserver;
  targets: Map<Element, Set<ViewportListener>>;
}>();

export function observeViewport(
  element: Element,
  callback: ViewportListener,
  rootMargin = '0px',
): () => void {
  let pool = pools.get(rootMargin);
  if (!pool) {
    const targets = new Map<Element, Set<ViewportListener>>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const listeners = targets.get(entry.target);
        if (listeners) {
          const pending = [...listeners];
          for (const listener of pending) listener(entry.isIntersecting);
        }
      }
    }, { rootMargin });
    pool = { observer, targets };
    pools.set(rootMargin, pool);
  }

  const { observer, targets } = pool;
  const existing = targets.get(element);
  const listeners = existing ?? new Set<ViewportListener>();
  let active = true;
  const listener: ViewportListener = visible => {
    if (active) callback(visible);
  };
  listeners.add(listener);
  if (!existing) {
    targets.set(element, listeners);
    observer.observe(element);
  }

  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size) return;
    targets.delete(element);
    observer.unobserve(element);
    if (targets.size) return;
    observer.disconnect();
    pools.delete(rootMargin);
  };
}
