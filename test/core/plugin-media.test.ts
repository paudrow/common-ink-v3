import { describe, expect, it } from "vitest";
import { heightIn } from "../../src/web/plugins/html/config.ts";
import { linkIn } from "../../src/web/plugins/media/link.ts";
import { postIn } from "../../src/web/plugins/media/social.ts";
import { playerFor, videoIn } from "../../src/web/plugins/media/youtube.ts";
import { FRAME_ORIGINS } from "../../src/worker/frames.ts";

describe("a YouTube video's address", () => {
  it("is read in each way YouTube writes it", () => {
    for (const written of [
      "dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "  https://youtu.be/dQw4w9WgXcQ  ",
    ]) {
      expect(videoIn(written), written).toEqual({ id: "dQw4w9WgXcQ", start: 0 });
    }
  });

  it("carries where to start", () => {
    expect(videoIn("https://youtu.be/dQw4w9WgXcQ?t=90")).toEqual({ id: "dQw4w9WgXcQ", start: 90 });
    expect(videoIn("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")).toEqual({ id: "dQw4w9WgXcQ", start: 90 });
    expect(videoIn("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s")).toEqual({ id: "dQw4w9WgXcQ", start: 3723 });
    expect(videoIn("https://youtu.be/dQw4w9WgXcQ?t=soon")).toEqual({ id: "dQw4w9WgXcQ", start: 0 });
  });

  it("is nothing for anything else", () => {
    for (const written of [
      "",
      "video address",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://evil.example/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://user:pass@youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/short",
      "https://youtu.be/dQw4w9WgXcQ%22%3E",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ\"><script>",
      "https://www.youtube.com/playlist?list=PL123",
      "javascript:alert(1)",
    ]) {
      expect(videoIn(written), written).toBeNull();
    }
  });

  it("plays on the host that sets no cookies before it plays, with nothing of the note in the address but the id and the start", () => {
    expect(playerFor({ id: "dQw4w9WgXcQ", start: 0 })).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
    expect(playerFor({ id: "dQw4w9WgXcQ", start: 90 })).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=90");
  });
});

describe("a social post's address", () => {
  it("is read for the sites whose posts can be shown", () => {
    expect(postIn("https://x.com/jack/status/20")).toEqual({ site: "X", frame: "https://platform.twitter.com/embed/Tweet.html?dnt=true&id=20", height: 360 });
    expect(postIn("https://twitter.com/jack/status/20?s=20")?.frame).toBe("https://platform.twitter.com/embed/Tweet.html?dnt=true&id=20");
    expect(postIn("https://mobile.twitter.com/jack/status/20/")?.site).toBe("X");
    expect(postIn("https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l")).toEqual({ site: "Bluesky", frame: "https://embed.bsky.app/embed/did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l", height: 360 });
  });

  it("takes a height, within limits", () => {
    expect(postIn("https://x.com/jack/status/20 height=300")?.height).toBe(300);
    expect(postIn("https://x.com/jack/status/20 height=9999")?.height).toBe(1600);
    expect(postIn("https://x.com/jack/status/20 height=10")?.height).toBe(120);
  });

  it("is nothing for anything else", () => {
    for (const written of ["", "post address", "http://x.com/jack/status/20", "https://x.com/jack", "https://x.com/jack/status/20/photo/1", "https://x.com/jack/status/abc", "https://x.com.evil.example/jack/status/20", "https://bsky.app/profile/a/b/post/3l6oveex3ii2l", "https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l", "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/..%2F..", "https://mastodon.social/@Gargron/1"]) {
      expect(postIn(written), written).toBeNull();
    }
  });

  it("only ever frames a site the app allows in a frame", () => {
    for (const written of ["https://youtu.be/dQw4w9WgXcQ"]) expect(FRAME_ORIGINS).toContain(new URL(playerFor(videoIn(written)!)).origin);
    for (const written of ["https://x.com/jack/status/20", "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l"]) expect(FRAME_ORIGINS).toContain(new URL(postIn(written)!.frame).origin);
  });
});

describe("a link", () => {
  it("is an https address and what the member calls it", () => {
    expect(linkIn("https://example.com/docs The docs")).toEqual({ href: "https://example.com/docs", title: "The docs", site: "example.com" });
    expect(linkIn("https://www.example.com/")).toEqual({ href: "https://www.example.com/", title: "example.com", site: "example.com" });
    expect(linkIn("https://example.com/a/b?c=d")?.title).toBe("example.com/a/b");
  });

  it("is nothing for an address that isn't https", () => {
    for (const written of ["", "address and a title", "javascript:alert(1) Click", "data:text/html,<script>alert(1)</script>", "http://example.com", "//example.com", "https://user:pass@example.com", "example.com"]) expect(linkIn(written), written).toBeNull();
  });
});

describe("an HTML embed's height", () => {
  it("is what its config says, within limits, or the usual", () => {
    expect(heightIn("")).toBe(320);
    expect(heightIn("height=480")).toBe(480);
    expect(heightIn("height=5")).toBe(40);
    expect(heightIn("height=99999")).toBe(2000);
    expect(heightIn("height=tall")).toBe(320);
    expect(heightIn("lineheight=480")).toBe(320);
  });
});
