import { expect, test } from "bun:test";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { PhotoViewer } from "../terngram/ui/photo-viewer";

const photos = ["a", "b", "c", "d"].map((key): Extract<NativeNode, { k: "image" }> => ({
  k: "image", key, p: { alt: key, max: { w: "80ch", h: "28lines" } },
}));

function setup(images = photos.slice(0, 3), captions: readonly string[] = ["Caption a", "Caption b", "Caption c"]) {
  let closed = 0;
  const viewer = new PhotoViewer(images, captions, () => closed++);
  const view = () => {
    const children = viewer.describe().c!.filter((child): child is NativeNode => "k" in child);
    const controls = children.flatMap(child => child.c ?? []).filter((child): child is NativeNode => "k" in child);
    const previous = controls.find(child => child.key === "previous-photo");
    const next = controls.find(child => child.key === "next-photo");
    const caption = children.find(child => child.key === "photo-caption");
    return {
      images: children.filter(child => child.k === "image"),
      caption: caption?.k === "text" ? caption.p?.text : undefined,
      previousDisabled: previous?.k === "item" ? previous.p?.disabled : undefined,
      nextDisabled: next?.k === "item" ? next.p?.disabled : undefined,
    };
  };
  const action = (act: string) => viewer.handleNativeEvent({ type: "action", key: `header/${act}`, act, mods: [] });
  return { viewer, view, action, closed: () => closed };
}

test("gallery shows one unchanged native image and its caption with bounded left/right navigation", () => {
  const s = setup();
  expect(s.view().images).toEqual([photos[0]!]);
  expect(s.view().images[0]).toBe(photos[0]);
  expect(s.view().caption).toBe("Caption a");
  expect([s.view().previousDisabled, s.view().nextDisabled]).toEqual([true, false]);
  s.viewer.handleInput("\x1b[D");
  expect(s.view().images).toEqual([photos[0]!]);
  s.viewer.handleInput("\x1b[C");
  expect(s.view().images).toEqual([photos[1]!]);
  expect(s.view().caption).toBe("Caption b");
  expect([s.view().previousDisabled, s.view().nextDisabled]).toEqual([false, false]);
  s.viewer.handleInput("\x1b[C");
  s.viewer.handleInput("\x1b[C");
  expect(s.view().images).toEqual([photos[2]!]);
  expect(s.view().caption).toBe("Caption c");
  expect([s.view().previousDisabled, s.view().nextDisabled]).toEqual([false, true]);
  s.viewer.handleInput("\x1b[D");
  expect(s.view().images).toEqual([photos[1]!]);
  expect(s.closed()).toBe(0);
});

test("previous/next buttons obey the same boundaries and Escape or Close closes", () => {
  const s = setup(photos.slice(0, 2));
  s.action("previous-photo");
  expect(s.view().images).toEqual([photos[0]!]);
  s.action("next-photo");
  s.action("next-photo");
  expect(s.view().images).toEqual([photos[1]!]);
  expect(s.view().nextDisabled).toBe(true);
  s.action("previous-photo");
  expect(s.view().images).toEqual([photos[0]!]);
  const event: NativeUiEvent = { type: "select", key: "header", item: "next-photo" };
  s.viewer.handleNativeEvent(event);
  s.action("unrelated");
  expect(s.view().images).toEqual([photos[0]!]);
  expect(s.closed()).toBe(0);
  s.action("close-photo");
  s.viewer.handleInput("\x1b");
  expect(s.closed()).toBe(2);
});

test("content refresh preserves the current image key across replacement and reordering", () => {
  const s = setup();
  s.action("next-photo");
  const edited: NativeNode = { k: "image", key: "b", p: { alt: "Edited b" } };
  s.viewer.setContent([photos[3]!, photos[0]!, photos[2]!, edited], ["Caption d", "Caption a", "Caption c", "Updated b"]);
  expect(s.view().images[0]).toBe(edited);
  expect(s.view().caption).toBe("Updated b");
  expect(s.view().nextDisabled).toBe(true);
  s.viewer.setContent([photos[0]!, photos[2]!], ["Changed a", "Changed c"]);
  expect(s.view().images[0]).toBe(photos[2]);
  expect(s.view().caption).toBe("Changed c");
  s.viewer.setContent([], []);
  expect(s.view().images).toEqual([]);
  expect(s.view().caption).toBeUndefined();
  expect([s.view().previousDisabled, s.view().nextDisabled]).toEqual([undefined, undefined]);
  s.action("next-photo");
  s.action("previous-photo");
  s.viewer.setContent([photos[3]!], ["Caption d"]);
  expect(s.view().images[0]).toBe(photos[3]);
  expect(s.view().caption).toBe("Caption d");
  expect([s.view().previousDisabled, s.view().nextDisabled]).toEqual([undefined, undefined]);
});


test("Home, End and function keys do not change the current image or close the gallery", () => {
  const s = setup();
  s.action("next-photo");
  for (const key of ["\x1b[H", "\x1b[F", "\x1b[1~", "\x1b[4~", "\x1bOP", "\x1b[15~", "\x1b[21~"]) s.viewer.handleInput(key);
  expect(s.view().images).toEqual([photos[1]!]);
  expect(s.closed()).toBe(0);
});

test("hidden viewer hints preserve the photo, caption and Escape behavior", () => {
  let closed = false;
  const viewer = new PhotoViewer([photos[0]!], ["Visible caption"], () => { closed = true; }, false);
  const flatten = (node: NativeNode): NativeNode[] => [node, ...(node.c ?? []).flatMap(child => "k" in child ? flatten(child) : [])];
  const nodes = flatten(viewer.describe());
  expect(nodes.some(node => node.k === "image" && node.key === "a")).toBe(true);
  expect(nodes.some(node => node.k === "text" && node.p?.text === "Visible caption")).toBe(true);
  expect(nodes.some(node => node.key === "close-photo" || node.key === "navigation")).toBe(false);
  viewer.handleInput("\x1b");
  expect(closed).toBe(true);
});

test("opening a particular album member selects it rather than always showing the first image", () => {
  const s = setup();
  s.viewer.selectImage("c");
  expect(s.view().images[0]).toBe(photos[2]);
  expect(s.view().caption).toBe("Caption c");
  s.viewer.selectImage("missing");
  expect(s.view().images[0]).toBe(photos[2]);
});
