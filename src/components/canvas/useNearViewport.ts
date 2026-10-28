import { useEffect, useState, type RefObject } from 'react';

export function useNearViewport(ref: RefObject<Element>, enabled: boolean, rootMargin = '320px'): boolean {
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || nearViewport) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return undefined;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setNearViewport(true);
      observer.disconnect();
    }, { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, nearViewport, ref, rootMargin]);

  return nearViewport;
}
