import { expect, test } from "bun:test";
import { ReadReceipts } from "../terngram/ui/read-receipts";

test("pending reads merge exact requested IDs without moving backward or sending duplicates", async () => {
  const first = Promise.withResolvers<void>();
  const requests: [number, number][] = [];
  const acknowledgements: [number, number][] = [];
  const queue = new ReadReceipts(async (chat, max) => {
    requests.push([chat, max]);
    if (max === 10) await first.promise;
  }, (chat, max) => acknowledgements.push([chat, max]), error => { throw error; });
  const sent = queue.read(1, 10);
  void queue.read(1, 12);
  void queue.read(1, 11);
  void queue.read(1, 12);
  expect(requests).toEqual([[1, 10]]);
  first.resolve(); await sent;
  expect(requests).toEqual([[1, 10], [1, 12]]);
  expect(acknowledgements).toEqual([[1, 10], [1, 12]]);
  await queue.read(1, 9);
  expect(requests).toEqual([[1, 10], [1, 12]]);
});

test("failed acknowledgements never advance confirmed state and a later action can retry", async () => {
  const error = new Error("offline");
  const acknowledged: number[] = [];
  const errors: unknown[] = [];
  let fail = true;
  const queue = new ReadReceipts(async () => { if (fail) throw error; }, (_chat, max) => acknowledged.push(max), error => errors.push(error));
  await queue.read(1, 10);
  expect(acknowledged).toEqual([]);
  expect(errors).toEqual([error]);
  fail = false;
  await queue.read(1, 10);
  expect(acknowledged).toEqual([10]);
});

test("account reset prevents late confirmation and queued reads leaking into a new session", async () => {
  const old = Promise.withResolvers<void>();
  const requests: number[] = [];
  const acknowledged: number[] = [];
  const queue = new ReadReceipts(async (_chat, max) => { requests.push(max); if (max === 10) await old.promise; }, (_chat, max) => acknowledged.push(max), error => { throw error; });
  const pending = queue.read(1, 10);
  void queue.read(1, 20);
  queue.clear();
  await queue.read(1, 5);
  old.resolve(); await pending;
  expect(requests).toEqual([10, 5]);
  expect(acknowledged).toEqual([5]);
});
