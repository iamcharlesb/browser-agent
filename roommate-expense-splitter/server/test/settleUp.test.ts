import test from "node:test";
import assert from "node:assert/strict";
import { Balance, settleUp } from "../src/settleUp";

const balances = (values: number[]): Balance[] => values.map((cents, index) => ({ userId: index + 1, name: `P${index + 1}`, cents }));

test("one debtor pays one creditor", () => {
  assert.deepEqual(settleUp(balances([-1200, 1200])), [{ fromUserId: 1, from: "P1", toUserId: 2, to: "P2", cents: 1200 }]);
});
test("uses the minimum number of transfers for a multi-person balance", () => {
  const payments = settleUp(balances([-700, -300, 500, 500]));
  assert.equal(payments.length, 3);
  const net = [0, 0, 0, 0];
  for (const p of payments) { net[p.fromUserId - 1] -= p.cents; net[p.toUserId - 1] += p.cents; }
  assert.deepEqual(net, [-700, -300, 500, 500]);
});
test("settles two exact opposite-balance pairs in two transfers", () => {
  const payments = settleUp(balances([-8, -7, 8, 7]));
  assert.equal(payments.length, 2);
});
test("returns no payments when every balance is settled", () => assert.deepEqual(settleUp(balances([0, 0])), []));
test("rejects nonzero totals and more than 16 members", () => {
  assert.throws(() => settleUp(balances([1, 0])), /sum to zero/);
  assert.throws(() => settleUp(balances([...Array(17)].map((_, i) => i === 0 ? 0 : 0))), /16 members/);
});
