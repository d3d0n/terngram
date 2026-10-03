import { expect, test } from "bun:test";
import { RequestCooldowns } from "../terngram/ui/request-cooldowns";

test("FloodWait blocks the method until the server deadline, not an arbitrary retry interval", () => {
  let now = 1000;
  const cooldowns = new RequestCooldowns(() => now);
  cooldowns.block("history", 1, 23, "method");
  expect(cooldowns.remaining("history", 2)).toBe(23);
  expect(cooldowns.remaining("dialogs")).toBe(0);
  now = 23999;
  expect(cooldowns.remaining("history", 1)).toBe(1);
  now = 24000;
  expect(cooldowns.remaining("history", 1)).toBe(0);
});

test("SlowMode is scoped to the target peer and a later shorter deadline cannot shorten a wait", () => {
  let now = 0;
  const cooldowns = new RequestCooldowns(() => now);
  cooldowns.block("send", -1, 60, "peer");
  expect(cooldowns.remaining("send", -1)).toBe(60);
  expect(cooldowns.remaining("send", -2)).toBe(0);
  now = 1000;
  cooldowns.block("send", -1, 5, "peer");
  expect(cooldowns.remaining("send", -1)).toBe(59);
  cooldowns.block("send", -2, 80, "method");
  expect(cooldowns.remaining("send", -1)).toBe(80);
  expect(cooldowns.remaining("send", -2)).toBe(80);
});

test("account reset clears an unexpired server deadline", () => {
  const cooldowns = new RequestCooldowns(() => 0);
  cooldowns.block("avatar", 42, 20, "method");
  expect(cooldowns.remaining("avatar", 43)).toBe(20);
  cooldowns.clear();
  expect(cooldowns.remaining("avatar", 43)).toBe(0);
});
