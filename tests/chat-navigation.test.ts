import { expect, test } from "bun:test";
import { ChatNavigation } from "../terngram/ui/chat-navigation";

const available = () => true;

test("back and forward use visit history and a new visit replaces the forward branch", () => {
  const history = new ChatNavigation();
  expect(history.move(-1, available)).toBeNull();
  for (const id of [1, 2, 3]) history.visit(id);
  expect(history.move(-1, available)).toBe(2);
  expect(history.move(-1, available)).toBe(1);
  expect(history.move(-1, available)).toBeNull();
  expect(history.move(1, available)).toBe(2);
  history.visit(4);
  expect(history.canMove(1, available)).toBe(false);
  expect(history.move(-1, available)).toBe(2);
  expect(history.move(1, available)).toBe(4);
});

test("recent chats are unique and capped at five, including back/forward visits", () => {
  const history = new ChatNavigation();
  for (let id = 1; id <= 7; id++) history.visit(id);
  expect(history.recent()).toEqual([7, 6, 5, 4, 3]);
  expect(history.move(-1, available)).toBe(6);
  history.visit(6);
  expect(history.recent()).toEqual([6, 7, 5, 4, 3]);
  expect(history.canMove(1, available)).toBe(true);
  expect(history.move(1, available)).toBe(7);
  expect(history.recent()).toEqual([7, 6, 5, 4, 3]);
});

test("unavailable chats are skipped and account clearing removes all navigation state", () => {
  const history = new ChatNavigation();
  for (const id of [1, 2, 3]) history.visit(id);
  expect(history.move(-1, id => id !== 2)).toBe(1);
  expect(history.move(1, id => id !== 2)).toBe(3);
  history.tap(-1, 100);
  history.clear();
  expect(history.recent()).toEqual([]);
  expect(history.canMove(-1, available)).toBe(false);
  expect(history.tap(-1, 110)).toBe(false);
});

test("double arrow needs the same direction inside the interval with no intervening input", () => {
  const history = new ChatNavigation();
  expect(history.tap(-1, 100)).toBe(false);
  expect(history.tap(-1, 450)).toBe(true);
  expect(history.tap(-1, 451)).toBe(false);
  expect(history.tap(-1, 802)).toBe(false);
  expect(history.tap(1, 803)).toBe(false);
  expect(history.tap(null, 804)).toBe(false);
  expect(history.tap(1, 805)).toBe(false);
  expect(history.tap(1, 806)).toBe(true);
});
