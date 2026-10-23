/** Live frames are disposable state; run/approval events remain durable ordered events. */
export class FrameSubscription {
  private pending: string | null = null;
  private waiter: ((frame: string | null) => void) | null = null;
  private closed = false;

  push(frame: string): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(frame);
    } else {
      this.pending = frame;
    }
  }

  next(): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.pending !== null) {
      const frame = this.pending;
      this.pending = null;
      return Promise.resolve(frame);
    }
    return new Promise(resolve => { this.waiter = resolve; });
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    this.waiter?.(null);
    this.waiter = null;
  }
}

/** Each viewer gets the newest frame, without stealing frames from other viewers. */
export class FrameStream {
  private viewers = new Set<FrameSubscription>();
  private closed = false;

  push(frame: string | null): void {
    if (frame === null) {
      this.closed = true;
      for (const viewer of this.viewers) viewer.close();
      this.viewers.clear();
      return;
    }
    if (!this.closed) for (const viewer of this.viewers) viewer.push(frame);
  }

  subscribe(): { frames: FrameSubscription; dispose: () => void } {
    const frames = new FrameSubscription();
    if (this.closed) frames.close();
    else this.viewers.add(frames);
    return {
      frames,
      dispose: () => { this.viewers.delete(frames); frames.close(); }
    };
  }
}
