export const narrowViewportQuery = '(max-width: 820px)';

export function subscribeNarrowViewport(onChange: () => void): () => void {
  const query = window.matchMedia(narrowViewportQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function getNarrowViewportSnapshot(): boolean {
  return window.matchMedia(narrowViewportQuery).matches;
}

export function getNarrowViewportServerSnapshot(): boolean {
  return false;
}
