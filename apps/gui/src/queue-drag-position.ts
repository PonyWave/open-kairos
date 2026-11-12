export function queueDragTargetIndex(
  centers: readonly number[],
  centerY: number,
  currentIndex: number,
): number {
  if (!centers.length) return 0;
  let index = Math.max(0, Math.min(currentIndex, centers.length - 1));
  const hysteresis = 2;
  while (index < centers.length - 1) {
    const current = centers[index],
      next = centers[index + 1];
    if (current === undefined || next === undefined || centerY <= (current + next) / 2 + hysteresis)
      break;
    index++;
  }
  while (index > 0) {
    const current = centers[index],
      previous = centers[index - 1];
    if (
      current === undefined ||
      previous === undefined ||
      centerY >= (current + previous) / 2 - hysteresis
    )
      break;
    index--;
  }
  return index;
}
