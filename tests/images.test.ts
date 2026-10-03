import { expect, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ImageLoader } from "../terngram/ui/image-loader";

const image = (key: string): NativeNode => ({ k: "image", key, p: { alt: key } });
function setup(concurrency: number) {
  const events = new EventEmitter();
  const errors: unknown[] = [];
  let loaded = 0;
  const loader = new ImageLoader(concurrency, () => { loaded++; events.emit("loaded"); }, error => errors.push(error));
  return { loader, errors, next: () => once(events, "loaded"), loaded: () => loaded };
}

test("image requests are deduplicated, bounded and prioritize newer queued media", async () => {
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<NativeNode | null>>>();
  const started: string[] = [];
  const { loader, next } = setup(2);
  const request = (key: string) => loader.request(key, () => {
    started.push(key);
    const result = Promise.withResolvers<NativeNode | null>();
    pending.set(key, result);
    return result.promise;
  });
  request("a"); request("b"); request("a"); request("c"); request("d");
  expect(started).toEqual(["a", "b"]);
  let done = next(); pending.get("a")!.resolve(image("a")); await done;
  expect(started).toEqual(["a", "b", "d"]);
  done = next(); pending.get("d")!.resolve(null); await done;
  expect(started).toEqual(["a", "b", "d", "c"]);
  done = next(); pending.get("b")!.resolve(image("b")); await done;
  done = next(); pending.get("c")!.resolve(image("c")); await done;
  request("d");
  expect(loader.get("d")).toBeNull();
  expect(started).toEqual(["a", "b", "d", "c"]);
});

test("clearing account state discards queued media and cannot publish previous-account results", async () => {
  const old = Promise.withResolvers<NativeNode | null>();
  const { loader, next } = setup(1);
  let queuedStarted = false;
  loader.request("same-id", () => old.promise);
  loader.request("old-queued", async () => { queuedStarted = true; return image("old-queued"); });
  loader.clear();
  const done = next();
  loader.request("same-id", async () => image("new-account"));
  old.resolve(image("old-account")); await done;
  expect(queuedStarted).toBe(false);
  expect(loader.get("same-id")?.key).toBe("new-account");
  expect(loader.get("old-queued")).toBeUndefined();
});

test("failed downloads report their error and can be requested again", async () => {
  const { loader, next, errors } = setup(1);
  const error = new Error("offline");
  let done = next(); loader.request("photo", async () => { throw error; }); await done;
  expect(errors).toEqual([error]);
  done = next(); loader.request("photo", async () => image("recovered")); await done;
  expect(loader.get("photo")?.key).toBe("recovered");
});

test("invalidation discards cached images and unavailable results so either can be refreshed", async () => {
  const { loader, next } = setup(1);
  let done = next(); loader.request("photo", async () => image("original")); await done;
  loader.invalidate("photo");
  expect(loader.get("photo")).toBeUndefined();
  done = next(); loader.request("photo", async () => null); await done;
  expect(loader.get("photo")).toBeNull();
  loader.invalidate("photo");
  done = next(); loader.request("photo", async () => image("edited")); await done;
  expect(loader.get("photo")?.key).toBe("edited");
});

test("invalidated queued downloads never start and do not block their replacement", async () => {
  const blocking = Promise.withResolvers<NativeNode | null>();
  const replacement = Promise.withResolvers<NativeNode | null>();
  const { loader, next } = setup(1);
  let staleStarted = false;
  let replacementStarted = false;
  loader.request("blocking", () => blocking.promise);
  loader.request("photo", async () => { staleStarted = true; return image("stale"); });
  loader.invalidate("photo");
  loader.request("photo", () => { replacementStarted = true; return replacement.promise; });
  let done = next(); blocking.resolve(image("blocking")); await done;
  expect(staleStarted).toBe(false);
  expect(replacementStarted).toBe(true);
  done = next(); replacement.resolve(image("edited")); await done;
  expect(staleStarted).toBe(false);
  expect(loader.get("photo")?.key).toBe("edited");
});

test("stale in-flight success cannot publish or clear a replacement request marker", async () => {
  const stale = Promise.withResolvers<NativeNode | null>();
  const replacement = Promise.withResolvers<NativeNode | null>();
  const { loader, next, loaded } = setup(2);
  let duplicateStarted = false;
  loader.request("photo", () => stale.promise);
  loader.invalidate("photo");
  loader.request("photo", () => replacement.promise);
  stale.resolve(image("stale"));
  await Promise.allSettled([stale.promise]);
  expect(loader.get("photo")).toBeUndefined();
  expect(loaded()).toBe(0);
  loader.request("photo", async () => { duplicateStarted = true; return image("duplicate"); });
  expect(duplicateStarted).toBe(false);
  const done = next(); replacement.resolve(image("edited")); await done;
  expect(loader.get("photo")?.key).toBe("edited");
  expect(loaded()).toBe(1);
});

test("stale in-flight success cannot overwrite a completed replacement", async () => {
  const stale = Promise.withResolvers<NativeNode | null>();
  const { loader, next, loaded } = setup(2);
  loader.request("photo", () => stale.promise);
  loader.invalidate("photo");
  const done = next(); loader.request("photo", async () => image("edited")); await done;
  stale.resolve(image("stale"));
  await Promise.allSettled([stale.promise]);
  expect(loader.get("photo")?.key).toBe("edited");
  expect(loaded()).toBe(1);
});

test("stale in-flight failure cannot report an error or clear a replacement request marker", async () => {
  const stale = Promise.withResolvers<NativeNode | null>();
  const replacement = Promise.withResolvers<NativeNode | null>();
  const { loader, errors, next, loaded } = setup(2);
  let duplicateStarted = false;
  loader.request("photo", () => stale.promise);
  loader.invalidate("photo");
  loader.request("photo", () => replacement.promise);
  stale.reject(new Error("stale download failed"));
  await Promise.allSettled([stale.promise]);
  expect(errors).toEqual([]);
  expect(loaded()).toBe(0);
  loader.request("photo", async () => { duplicateStarted = true; return image("duplicate"); });
  expect(duplicateStarted).toBe(false);
  const done = next(); replacement.resolve(image("edited")); await done;
  expect(loader.get("photo")?.key).toBe("edited");
  expect(loaded()).toBe(1);
});

test("clearing accounts ignores previous-account failure without disturbing a same-key request", async () => {
  const stale = Promise.withResolvers<NativeNode | null>();
  const replacement = Promise.withResolvers<NativeNode | null>();
  const { loader, errors, next, loaded } = setup(2);
  let duplicateStarted = false;
  loader.request("photo", () => stale.promise);
  loader.clear();
  loader.request("photo", () => replacement.promise);
  stale.reject(new Error("previous account"));
  await Promise.allSettled([stale.promise]);
  expect(errors).toEqual([]);
  expect(loaded()).toBe(0);
  loader.request("photo", async () => { duplicateStarted = true; return image("duplicate"); });
  expect(duplicateStarted).toBe(false);
  const done = next(); replacement.resolve(image("new-account")); await done;
  expect(loader.get("photo")?.key).toBe("new-account");
});

test("leaving a chat drops queued decoration without discarding active or completed cache entries", async () => {
  const { loader, next } = setup(1);
  const active = Promise.withResolvers<NativeNode | null>();
  const started: string[] = [];
  loader.request("active", () => { started.push("active"); return active.promise; });
  loader.request("old-queued", async () => { started.push("old-queued"); return image("old"); });
  loader.cancelQueued();
  loader.request("new-chat", async () => { started.push("new-chat"); return image("new"); });
  const first = next();
  active.resolve(image("active")); await first;
  if (loader.get("new-chat") === undefined) await next();
  expect(started).toEqual(["active", "new-chat"]);
  expect(loader.get("active")?.key).toBe("active");
  expect(loader.get("new-chat")?.key).toBe("new");
  expect(loader.get("old-queued")).toBeUndefined();
});
