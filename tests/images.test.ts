import { expect, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ImageLoader } from "../terngram/ui/image-loader";
import { TerngramApp } from "../terngram/ui/app";
import { type ChatMessage, type Photo, TelegramRequestError } from "../terngram/ui/telegram";
import { PhotoViewer } from "../terngram/ui/photo-viewer";

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

const fixturePhoto: Photo = { data: "aW1hZ2U=", mime: "image/png", width: 1, height: 1 };
const photoMessage = (media_id: string): ChatMessage => ({
  id: 1, chat_id: 42, sender: "Fixture", text: "", time: "", outgoing: false,
  reply_to: null, edited: false, photo: true, media_id, forwarded: null, read: false,
  grouped_id: null, sender_id: null, markdown: "", entities: [],
});
type PhotoApp = {
  generation: number;
  telegram: { call: (method: string, args: unknown[]) => Promise<Photo | null> };
  previews: ImageLoader;
  photoNodes: Map<string, NativeNode>;
  queuePreviews: (id: number) => void;
  invalidatePhoto: (message: ChatMessage) => void;
  viewPhoto: (message: ChatMessage) => Promise<void>;
};
function photoApp(call: PhotoApp["telegram"]["call"]) {
  let messages = [photoMessage("old")];
  const errors: unknown[] = [];
  const thread = { getMessage: (id: number) => messages.find(item => item.id === id), get groups() { return [messages]; } };
  const app = Object.assign(Object.create(TerngramApp.prototype), {
    generation: 1, telegram: { call }, selectedId: 42, quitting: false,
    cooldowns: { remaining: () => 0 }, threads: new Map([[42, thread]]),
    thread: () => thread, albumMembers: () => messages, redraw: () => {},
    fail: (error: unknown) => errors.push(error), photoNodes: new Map(),
    photoLoading: new Map(), photoIntent: 0, resolvedAlbums: new Set(), palette: {},
    previews: new ImageLoader(2, () => {}, error => errors.push(error)),
  }) as PhotoApp;
  return { app, errors, replace: (next: ChatMessage[]) => { messages = next; } };
}
const flushImages = () => new Promise<void>(resolve => setImmediate(resolve));


test("expected preview invalidation preserves an already queued replacement and evicts old full bytes", async () => {
  const stale = Promise.withResolvers<Photo | null>();
  const replacement = Promise.withResolvers<Photo | null>();
  let calls = 0;
  const s = photoApp(async () => ++calls === 1 ? stale.promise : replacement.promise);
  s.app.photoNodes.set("42:1:old", image("old"));
  s.app.queuePreviews(42);
  s.replace([photoMessage("new")]);
  s.app.invalidatePhoto(photoMessage("old"));
  s.app.queuePreviews(42);
  stale.reject(new TelegramRequestError("photo", "Changed", 0, "MEDIA_CHANGED"));
  await flushImages();
  expect(calls).toBe(2);
  expect(s.errors).toEqual([]);
  expect(s.app.photoNodes.has("42:1:old")).toBe(false);
  replacement.resolve(fixturePhoto);
  await flushImages();
  expect(s.app.previews.get("42:1:old")).toBeUndefined();
  expect(s.app.previews.get("42:1:new")?.k).toBe("image");
});

test("removed preview becomes absent, while genuine failures remain visible and are not retried", async () => {
  for (const code of ["MEDIA_CHANGED", "MEDIA_RESTRICTED"]) {
    const pending = Promise.withResolvers<Photo | null>();
    let calls = 0;
    const s = photoApp(async () => { calls++; return pending.promise; });
    s.app.queuePreviews(42);
    if (code === "MEDIA_CHANGED") s.replace([{ ...photoMessage("old"), photo: false, media_id: null }]);
    const error = new TelegramRequestError("photo", "Fixture error", 0, code);
    pending.reject(error);
    await flushImages();
    expect(calls).toBe(1);
    expect(s.errors).toEqual(code === "MEDIA_CHANGED" ? [] : [error]);
    expect(s.app.previews.get("42:1:old")).toBeUndefined();
  }
});

test("old account invalidation cannot evict a newer account's same-key caches", async () => {
  const pending = Promise.withResolvers<Photo | null>();
  const s = photoApp(async () => pending.promise);
  s.app.queuePreviews(42);
  s.app.generation++;
  s.app.previews.clear();
  s.app.photoNodes.set("42:1:old", image("new-account-full"));
  s.app.previews.request("42:1:old", async () => image("new-account-preview"));
  await flushImages();
  pending.reject(new TelegramRequestError("photo", "Changed", 0, "MEDIA_CHANGED"));
  await flushImages();
  expect(s.app.photoNodes.get("42:1:old")?.key).toBe("new-account-full");
  expect(s.app.previews.get("42:1:old")?.key).toBe("new-account-preview");
  expect(s.errors).toEqual([]);
});

test("gallery continues using authoritative replacement members after expected invalidation", async () => {
  const pending = Promise.withResolvers<Photo | null>();
  let fullCalls = 0;
  const s = photoApp(async (_method, args) => {
    if (args[2] === true) return null;
    return ++fullCalls === 1 ? pending.promise : fixturePhoto;
  });
  const opening = s.app.viewPhoto(photoMessage("old"));
  s.replace([photoMessage("new")]);
  pending.reject(new TelegramRequestError("photo", "Changed", 0, "MEDIA_CHANGED"));
  await opening;
  expect(fullCalls).toBe(2);
  expect(s.app.photoNodes.has("42:1:old")).toBe(false);
  expect(s.app.photoNodes.get("42:1:new")?.k).toBe("image");
  expect(s.errors).toEqual([]);
});

test("gallery drops removed members without retrying, placeholders, or errors", async () => {
  const pending = Promise.withResolvers<Photo | null>();
  let calls = 0;
  const s = photoApp(async () => { calls++; return pending.promise; });
  const opening = s.app.viewPhoto(photoMessage("old"));
  s.replace([]);
  pending.reject(new TelegramRequestError("photo", "Changed", 0, "MEDIA_CHANGED"));
  await opening;
  expect(calls).toBe(1);
  expect(s.app.photoNodes.size).toBe(0);
  expect(s.errors).toEqual([]);
});

test("gallery genuine failures surface once without retrying", async () => {
  const error = new TelegramRequestError("photo", "Restricted", 0, "MEDIA_RESTRICTED");
  let calls = 0;
  const s = photoApp(async () => { calls++; throw error; });
  await s.app.viewPhoto(photoMessage("old"));
  expect(calls).toBe(1);
  expect(s.errors).toEqual([error]);
  expect(s.app.photoNodes.size).toBe(0);
});

test("late expected preview cancellation cannot evict a newer same-key entry", async () => {
  const stale = Promise.withResolvers<Photo | null>();
  const fresh = Promise.withResolvers<Photo | null>();
  let calls = 0;
  const s = photoApp(async () => ++calls === 1 ? stale.promise : fresh.promise);
  s.app.queuePreviews(42);
  s.app.invalidatePhoto(photoMessage("old"));
  s.app.queuePreviews(42);
  fresh.resolve(fixturePhoto);
  await flushImages();
  s.app.photoNodes.set("42:1:old", image("fresh-full"));
  stale.reject(new TelegramRequestError("photo", "Changed", 0, "MEDIA_CHANGED"));
  await flushImages();
  expect(calls).toBe(2);
  expect(s.app.previews.get("42:1:old")?.k).toBe("image");
  expect(s.app.photoNodes.get("42:1:old")?.key).toBe("fresh-full");
  expect(s.errors).toEqual([]);
});

test("media cache invalidation immediately removes the viewer's stale node reference", () => {
  const s = photoApp(async () => fixturePhoto);
  const oldImage = image("old");
  const viewer = new PhotoViewer([oldImage], [""], () => {});
  Object.assign(s.app, { photoViewer: viewer, photoGroup: photoMessage("old") });
  s.app.photoNodes.set("42:1:old", oldImage);
  s.replace([photoMessage("new")]);
  s.app.invalidatePhoto(photoMessage("old"));
  expect(viewer.describe().c?.filter(child => "k" in child && child.k === "image")).toEqual([]);
});

test("same-key preview cancellation reloads the visible gallery after evicting its full image", async () => {
  const pending = Promise.withResolvers<Photo | null>();
  let previews = 0, full = 0;
  const s = photoApp(async (_method, args) => {
    if (args[2] === true) return ++previews === 1 ? pending.promise : fixturePhoto;
    full++;
    return fixturePhoto;
  });
  const oldImage = image("old");
  const viewer = new PhotoViewer([oldImage], [""], () => {});
  Object.assign(s.app, { photoViewer: viewer, photoGroup: photoMessage("old"), photoIntent: 1, photoDisplayedIntent: 1 });
  s.app.photoNodes.set("42:1:old", oldImage);
  s.app.queuePreviews(42);
  pending.reject(new TelegramRequestError("photo", "Changed", 0, "MEDIA_CHANGED"));
  await flushImages();
  expect(full).toBe(1);
  const refreshed = s.app.photoNodes.get("42:1:old");
  if (refreshed?.k !== "image") throw new Error("Current gallery image did not reload");
  expect(refreshed).not.toBe(oldImage);
  expect(viewer.describe().c?.filter(child => "k" in child && child.k === "image")).toEqual([refreshed]);
  expect(s.errors).toEqual([]);
});
