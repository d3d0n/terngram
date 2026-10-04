import { expect, test } from "bun:test";
import { preview } from "../terngram/ui/nodes";
import { ForwardPicker } from "../terngram/ui/forward-picker";

for (const emoji of ["🙂", "🚀", "𐐀"]) {
  test(`compact preview does not produce a lone surrogate at the cutoff (${emoji})`, () => {
    const prefix = "x".repeat(119);
    expect(preview(prefix + emoji + "tail")).toBe(prefix);
    expect(preview("x".repeat(118) + emoji + "tail")).toBe("x".repeat(118) + emoji);
  });
}

test("forwarding destination previews also preserve UTF-16 pair boundaries", () => {
  const prefix = "x".repeat(159);
  const picker = new ForwardPicker([{
    id: 1, title: "Fixture", preview: prefix + "🙂tail", unread_count: 0,
    writable: true, kind: "user", last_message_id: 1,
  }], () => {}, () => {});
  const node = picker.describe();
  if (node.k !== "picker") throw new Error("Expected native picker");
  expect(node.p?.items?.[0]?.detail).toBe(prefix);
});
