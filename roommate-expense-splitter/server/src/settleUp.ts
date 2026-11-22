export type Balance = { userId: number; name: string; cents: number };
export type Payment = { fromUserId: number; from: string; toUserId: number; to: string; cents: number };

/** Find the exact minimum number of payments. Net positive = should receive; negative = owes.
 * Exact settlement is NP-hard, so the API caps groups at 16 members. All values are integer cents.
 */
export function settleUp(input: Balance[]): Payment[] {
  if (input.length > 16) throw new Error("Settle-up supports groups of at most 16 members");
  if (input.some(item => !Number.isSafeInteger(item.cents))) throw new Error("Balances must be safe integer cents");
  if (input.reduce((total, item) => total + item.cents, 0) !== 0) throw new Error("Balances must sum to zero");

  const remaining = input.map(item => item.cents);
  const path: Payment[] = [];
  const memo = new Map<string, number>();
  let best: Payment[] | null = null;

  function search(start: number): number {
    while (start < remaining.length && remaining[start] === 0) start++;
    if (start === remaining.length) {
      if (best === null || path.length < best.length) best = [...path];
      return 0;
    }
    if (best && path.length >= best.length) return Number.POSITIVE_INFINITY;
    const key = remaining.filter(value => value !== 0).sort((a, b) => a - b).join(",");
    const seenAt = memo.get(key);
    if (seenAt !== undefined && seenAt <= path.length) return Number.POSITIVE_INFINITY;
    memo.set(key, path.length);

    let minimum = Number.POSITIVE_INFINITY;
    const tried = new Set<number>();
    for (let j = start + 1; j < remaining.length; j++) {
      const a = remaining[start], b = remaining[j];
      if (!b || Math.sign(a) === Math.sign(b) || tried.has(b)) continue;
      tried.add(b);
      const cents = Math.min(Math.abs(a), Math.abs(b));
      const debtor = a < 0 ? start : j;
      const creditor = a > 0 ? start : j;
      remaining[start] = a + (a < 0 ? cents : -cents);
      remaining[j] = b + (b < 0 ? cents : -cents);
      path.push({ fromUserId: input[debtor].userId, from: input[debtor].name,
        toUserId: input[creditor].userId, to: input[creditor].name, cents });
      minimum = Math.min(minimum, 1 + search(start));
      path.pop(); remaining[start] = a; remaining[j] = b;
      if (a + b === 0) break;
    }
    return minimum;
  }
  search(0);
  return best ?? [];
}
