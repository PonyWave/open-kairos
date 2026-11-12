export class BlobUrlLease {
  private current: string | null = null;

  replace(blob: Blob): string {
    this.revoke();
    this.current = URL.createObjectURL(blob);
    return this.current;
  }

  revoke(): void {
    if (this.current === null) return;
    URL.revokeObjectURL(this.current);
    this.current = null;
  }
}
