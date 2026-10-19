import { describe, expect, it } from "vitest";
import { PART_BYTES } from "../../src/core/parts.ts";
import { fetchImage, imageBox, placeId, planImage } from "../src/clip/images.ts";
import type { ClipImage } from "../src/clip/types.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("planImage", () => {
  it("names a PNG so the server sniff agrees", () => {
    expect(planImage(png)).toEqual({ action: "upload", name: "clip.png", bytes: png });
  });

  it("misses bytes that are not an image", () => {
    expect(planImage(Uint8Array.from([1, 2, 3, 4]))).toEqual({ action: "miss", reason: "not-image" });
  });

  it("misses a file longer than one request can carry", () => {
    const bytes = new Uint8Array(PART_BYTES + 1);
    bytes.set(png);
    expect(planImage(bytes)).toEqual({ action: "miss", reason: "too-big" });
  });

  it("misses a fetch that returned nothing", () => {
    expect(planImage(null)).toEqual({ action: "miss", reason: "unfetched" });
  });
});

describe("placeId and imageBox", () => {
  const remote: ClipImage = { key: "i1", alt: "Chamber", width: 1200, height: 800, source: { kind: "remote", url: "https://example.com/vote.png" } };

  it("keys a remote image by its URL", () => {
    expect(placeId(remote)).toBe("https://example.com/vote.png");
  });

  it("prefers the upload's size, then the page's, then nothing", () => {
    expect(imageBox({ width: 10, height: 12 }, remote)).toEqual({ width: 10, height: 12 });
    expect(imageBox({ width: null, height: null }, remote)).toEqual({ width: 1200, height: 800 });
    expect(imageBox({ width: null, height: null }, { width: null, height: null })).toBeNull();
  });
});

describe("fetchImage", () => {
  const served = () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(png, { status: 200 });
    }) as typeof fetch;
    return { asked, fetchImpl };
  };

  it("fetches an image on a public host", async () => {
    const { asked, fetchImpl } = served();
    expect(await fetchImage("https://example.com/vote.png", fetchImpl)).toEqual(png);
    expect(asked).toEqual(["https://example.com/vote.png"]);
  });

  it("never asks a host on this computer or its network", async () => {
    const { asked, fetchImpl } = served();
    const hosts = [
      "http://localhost:8080/a.png",
      "http://app.localhost/a.png",
      "http://printer.local/a.png",
      "http://127.0.0.1/a.png",
      "http://2130706433/a.png",
      "http://0.0.0.0/a.png",
      "http://10.1.2.3/a.png",
      "http://172.20.0.1/a.png",
      "http://192.168.1.1/a.png",
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.1.1/a.png",
      "http://[::1]/a.png",
      "http://[::]/a.png",
      "http://[::ffff:127.0.0.1]/a.png",
      "http://[::ffff:192.168.0.1]/a.png",
      "http://[fd12:3456::1]/a.png",
      "http://[fe80::1]/a.png",
    ];
    for (const url of hosts) expect(await fetchImage(url, fetchImpl), url).toBeNull();
    expect(asked).toEqual([]);
    expect(await fetchImage("http://172.32.0.1/a.png", fetchImpl)).toEqual(png);
    expect(await fetchImage("http://[2606:4700::1111]/a.png", fetchImpl)).toEqual(png);
    expect(asked).toEqual(["http://172.32.0.1/a.png", "http://[2606:4700::1111]/a.png"]);
  });

  it("drops a redirect that landed on a private host", async () => {
    const fetchImpl = (async () => {
      const response = new Response(png, { status: 200 });
      Object.defineProperty(response, "url", { value: "http://192.168.1.1/admin.png" });
      return response;
    }) as typeof fetch;
    expect(await fetchImage("https://example.com/moved.png", fetchImpl)).toBeNull();
  });

  it("stops reading a body that runs past the cap, without a length to say so", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(endless, { status: 200 })) as typeof fetch;
    expect(await fetchImage("https://example.com/huge.png", fetchImpl)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(PART_BYTES / chunk.byteLength + 2);
  });
});
