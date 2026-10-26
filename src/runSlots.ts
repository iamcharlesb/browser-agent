export interface RunResource { botName?: string; interactionMode?: string }
export interface RunSlot { id: string; bot: string; browser: boolean }

/** A bot owns its memory serially; the shared browser has one owner across all bots. */
export class RunSlots {
  private readonly slots = new Map<string, RunSlot>();
  constructor(readonly limit: number) {}
  resource(input: RunResource): Omit<RunSlot, "id"> {
    return { bot: (input.botName || "default").trim().toLowerCase(), browser: input.interactionMode !== "chat" };
  }
  canStart(input: RunResource): boolean {
    const target = this.resource(input);
    return this.slots.size < this.limit && !this.list().some(slot => slot.bot === target.bot || (slot.browser && target.browser));
  }
  acquire(id: string, input: RunResource): void {
    const existing = this.slots.get(id);
    const resource = this.resource(input);
    if (existing) {
      if (existing.bot !== resource.bot || existing.browser !== resource.browser) throw new Error("Run reservation does not match its owner.");
      return;
    }
    if (!this.canStart(input)) throw new Error("A run is already in progress for this bot, the shared browser, or the configured execution capacity. Queue this request.");
    this.slots.set(id, { id, ...this.resource(input) });
  }
  release(id: string): void { this.slots.delete(id); }
  list(): RunSlot[] { return [...this.slots.values()]; }
  get size(): number { return this.slots.size; }
  get browserRunId(): string | undefined { return this.list().find(slot => slot.browser)?.id; }
}
