export interface ConversationScrollTarget {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export const conversationWheelGestureIdleMs = 220;

interface WheelMotion {
  direction: 'up' | 'down';
  previous: number;
  trough: number;
  decays: number;
  renewedSamples: number;
}

export class ConversationScrollController {
  private enabled = false;
  private following = true;
  private lastTop = 0;
  private lastMaximum = 0;
  private downwardIntent = false;
  private draggingScrollbar = false;
  private gestureActive = false;
  private wheelEnd: ReturnType<typeof setTimeout> | null = null;
  private lastWheelAt: number | null = null;
  private wheelMotion: WheelMotion | null = null;

  constructor(
    private readonly target: ConversationScrollTarget,
    private readonly onFollowingChange?: (following: boolean) => void,
    private readonly onLoadEarlier: () => boolean = () => false,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.endGesture();
  }

  pause(): void {
    this.following = false;
    this.downwardIntent = false;
    this.lastTop = this.target.scrollTop;
    this.onFollowingChange?.(false);
  }

  follow(): void {
    this.following = true;
    this.downwardIntent = false;
    this.onFollowingChange?.(true);
    this.layout();
  }

  intent(direction: 'up' | 'down'): void {
    if (!this.enabled) return;
    const startsGesture = !this.gestureActive;
    this.gestureActive = true;
    if (direction === 'up') {
      this.pause();
      if (startsGesture && this.target.scrollTop <= 1) this.onLoadEarlier();
      return;
    }
    this.downwardIntent = true;
    if (this.atBottom()) this.follow();
  }

  wheelIntent(direction: 'up' | 'down', magnitude = 0): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (this.lastWheelAt !== null && now - this.lastWheelAt >= conversationWheelGestureIdleMs)
      this.endGesture();
    if (magnitude > 0) {
      if (this.wheelMotion?.direction !== direction) this.wheelMotion = null;
      if (this.wheelAccelerated(magnitude)) this.endGesture();
      this.wheelMotion ??= {
        direction,
        previous: magnitude,
        trough: magnitude,
        decays: 0,
        renewedSamples: 0,
      };
    }
    this.lastWheelAt = now;
    this.intent(direction);
    if (this.wheelEnd !== null) clearTimeout(this.wheelEnd);
    this.wheelEnd = setTimeout(() => this.endGesture(), conversationWheelGestureIdleMs);
  }

  endGesture(): void {
    if (this.wheelEnd !== null) clearTimeout(this.wheelEnd);
    this.wheelEnd = null;
    this.lastWheelAt = null;
    this.wheelMotion = null;
    this.gestureActive = false;
  }

  scrollbarDragging(dragging: boolean): void {
    if (dragging) this.endGesture();
    this.draggingScrollbar = dragging;
  }

  scrolled(): void {
    const top = this.target.scrollTop;
    const maximum = this.maximum();
    const clampedByShrink = maximum < this.lastMaximum && this.atBottom();
    if (this.enabled && top < this.lastTop - 0.5 && !clampedByShrink) this.pause();
    if (
      this.enabled &&
      !this.following &&
      top > this.lastTop &&
      this.atBottom() &&
      (this.downwardIntent || this.draggingScrollbar)
    )
      this.follow();
    this.lastTop = this.target.scrollTop;
    this.lastMaximum = maximum;
  }

  layout(): void {
    if (!this.enabled || this.target.clientHeight <= 0) return;
    if (this.following && Math.abs(this.target.scrollTop - this.maximum()) > 0.5)
      this.target.scrollTop = this.maximum();
    this.lastTop = this.target.scrollTop;
    this.lastMaximum = this.maximum();
  }

  private wheelAccelerated(magnitude: number): boolean {
    const motion = this.wheelMotion;
    if (!motion) return false;
    if (motion.decays < 2) {
      if (magnitude < motion.previous) {
        motion.decays += 1;
        motion.trough = magnitude;
      } else if (magnitude > motion.previous) {
        motion.decays = 0;
        motion.trough = magnitude;
      }
    } else {
      motion.trough = Math.min(motion.trough, magnitude);
      const rise = magnitude - motion.trough;
      const renewed = rise >= 3 && magnitude >= motion.trough * 1.4;
      motion.renewedSamples = renewed ? motion.renewedSamples + 1 : 0;
      // 连续回升或一次明显回升才识别为新动作，过滤惯性尾部的小幅波动。
      if ((rise >= 8 && magnitude >= motion.trough * 1.8) || motion.renewedSamples >= 2)
        return true;
    }
    motion.previous = magnitude;
    return false;
  }

  private atBottom(): boolean {
    return this.maximum() - this.target.scrollTop <= 1;
  }
  private maximum(): number {
    return Math.max(0, this.target.scrollHeight - this.target.clientHeight);
  }
}
