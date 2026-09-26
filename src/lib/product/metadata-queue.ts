export function createMetadataQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return function enqueue<T>(key: string, write: () => Promise<T>): Promise<T> {
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    pending.set(key, next);
    const cleanup = () => { if (pending.get(key) === next) pending.delete(key); };
    void next.then(cleanup, cleanup);
    return next;
  };
}
