interface SharedEventStream {
  source: EventSource;
  subscribers: number;
}

const streams = new Map<string, SharedEventStream>();

export function subscribeEventStream(
  url: string,
  listeners: ReadonlyArray<{ type: string; handler: EventListener }>,
): () => void {
  let stream = streams.get(url);
  if (!stream) {
    stream = { source: new EventSource(url), subscribers: 0 };
    streams.set(url, stream);
  }
  const current = stream;
  current.subscribers += 1;
  for (const { type, handler } of listeners) current.source.addEventListener(type, handler);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const { type, handler } of listeners) current.source.removeEventListener(type, handler);
    current.subscribers -= 1;
    if (current.subscribers > 0) return;
    current.source.close();
    if (streams.get(url) === current) streams.delete(url);
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const stream of streams.values()) stream.source.close();
    streams.clear();
  });
}
