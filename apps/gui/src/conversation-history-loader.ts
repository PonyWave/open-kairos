export const conversationHistoryLoadingMinMs = 350;

export class ConversationHistoryLoader {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onLoadingChange: (loading: boolean) => void) {}

  start(load: () => void): boolean {
    if (this.timer !== null) return false;
    this.onLoadingChange(true);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        load();
      } finally {
        this.onLoadingChange(false);
      }
    }, conversationHistoryLoadingMinMs);
    return true;
  }

  cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.onLoadingChange(false);
  }
}
