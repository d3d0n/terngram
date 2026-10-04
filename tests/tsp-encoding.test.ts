import { expect, test } from "bun:test";
import { encodeTspJson, encodeTspMessage, splitTspMessage, TspReader } from "@oh-my-pi/pi-tui/native/encode";

for (const body of ["a".repeat(58), "Ж🙂".repeat(300)]) {
  test(`APC payload includes header bytes at the ${body.length < 100 ? "ASCII chunk boundary" : "Unicode chunk boundary"}`, () => {
    const limit = 64;
    const value = { ev: "edit", sf: "fixture", id: "input", from: 0, to: 0, len: 0, cursor: body.length, text: body };
    const encoded = encodeTspJson("e", value, undefined, limit);
    const reader = new TspReader();
    let decoded;
    for (const match of encoded.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)) {
      // APC payload is the content between ESC _ and ST, including tsp/verb/params.
      expect(Buffer.byteLength(match[0].slice(2, -2), "utf8")).toBeLessThanOrEqual(limit);
      decoded = reader.feed(match[0]) ?? decoded;
    }
    expect(decoded).toMatchObject({ verb: "e", event: { ev: "edit", text: body, len: 0, cursor: body.length } });
  });
}

test("a body fitting the old JSON-only boundary is chunked when its APC header would overflow", () => {
  const limit = 64;
  const encoded = encodeTspMessage("b", "A".repeat(limit), undefined, limit);
  let restored = "";
  for (const match of encoded.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)) {
    expect(Buffer.byteLength(match[0].slice(2, -2), "utf8")).toBeLessThanOrEqual(limit);
    restored += splitTspMessage(match[0])!.body;
  }
  expect(restored).toBe("A".repeat(limit));
});

test("blob identities and MIME parameters are included in each chunk's payload budget", () => {
  const limit = 256;
  const params = { id: "a".repeat(64), mime: "image/png" };
  const body = "QUJD".repeat(1000);
  const encoded = encodeTspMessage("b", body, params, limit);
  let restored = "";
  for (const match of encoded.matchAll(/\x1b_tsp;[\s\S]*?\x1b\\/g)) {
    expect(Buffer.byteLength(match[0].slice(2, -2), "utf8")).toBeLessThanOrEqual(limit);
    const part = splitTspMessage(match[0])!;
    expect(part.params.id).toBe(params.id);
    expect(part.params.mime).toBe(params.mime);
    restored += part.body;
  }
  expect(restored).toBe(body);
});
