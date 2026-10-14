import { describe, expect, it } from "vitest";
import { heightIn } from "../../src/web/plugins/html/config.ts";
import { postIn } from "../../src/web/plugins/media/social.ts";
import { playerFor, posterFor, titleFor, videoIn } from "../../src/web/plugins/media/youtube.ts";
import { FRAME_ORIGINS } from "../../src/worker/frames.ts";

describe("a YouTube video's address", () => {
  it("is read in each way YouTube writes it", () => {
    for (const written of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "  https://youtu.be/dQw4w9WgXcQ  ",
    ]) {
      expect(videoIn(written), written).toEqual({ id: "dQw4w9WgXcQ", start: 0, short: false });
    }
    expect(videoIn("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toEqual({ id: "dQw4w9WgXcQ", start: 0, short: true });
  });

  it("carries where to start", () => {
    expect(videoIn("https://youtu.be/dQw4w9WgXcQ?t=90")).toEqual({ id: "dQw4w9WgXcQ", start: 90, short: false });
    expect(videoIn("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")).toEqual({ id: "dQw4w9WgXcQ", start: 90, short: false });
    expect(videoIn("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s")).toEqual({ id: "dQw4w9WgXcQ", start: 3723, short: false });
    expect(videoIn("https://youtu.be/dQw4w9WgXcQ?t=soon")).toEqual({ id: "dQw4w9WgXcQ", start: 0, short: false });
  });

  it("is nothing for anything else", () => {
    for (const written of [
      "",
      "video address",
      "dQw4w9WgXcQ",
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

  it("has its picture and its title asked for by its id alone, from YouTube's own hosts and not its player", () => {
    const video = videoIn("https://youtu.be/dQw4w9WgXcQ?t=90")!;
    expect(posterFor(video)).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(titleFor(video)).toBe("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ");
  });
});

describe("a social post's address", () => {
  it("is read for the sites whose posts can be shown, and asked for in the app's theme", () => {
    const x = postIn("https://x.com/jack/status/20")!;
    expect([x.site, x.key, x.height, x.origin]).toEqual(["X", "X:20", 360, "https://platform.twitter.com"]);
    expect(x.frame("light")).toBe("https://platform.twitter.com/embed/Tweet.html?dnt=true&id=20&theme=light");
    expect(x.frame("dark")).toBe("https://platform.twitter.com/embed/Tweet.html?dnt=true&id=20&theme=dark");
    expect(postIn("https://twitter.com/jack/status/20?s=20")?.key).toBe("X:20");
    expect(postIn("https://mobile.twitter.com/jack/status/20/")?.site).toBe("X");
    const sky = postIn("https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l")!;
    expect([sky.site, sky.origin]).toEqual(["Bluesky", "https://embed.bsky.app"]);
    expect(sky.frame("dark")).toBe("https://embed.bsky.app/embed/did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l?id=ink&colorMode=dark");
  });

  it("is as tall as its frame says, when what the frame says is a height within limits", () => {
    const x = postIn("https://x.com/jack/status/20")!;
    const resize = (height: unknown) => ({ "twttr.embed": { method: "twttr.private.resize", params: [{ height }] } });
    expect(x.tall(resize(412.5))).toBe(413);
    expect(x.tall(JSON.stringify(resize(500)))).toBe(500);
    for (const said of [resize(10), resize(99999), resize("500"), { "twttr.embed": { method: "twttr.private.rendered", params: [{ height: 500 }] } }, { height: 500 }, "not json", null, 500]) expect(x.tall(said), JSON.stringify(said)).toBeNull();
    const sky = postIn("https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l")!;
    expect(sky.tall({ id: "ink", height: 288 })).toBe(288);
    expect(sky.tall({ id: "ink" })).toBeNull();
  });

  it("is nothing for anything else", () => {
    for (const written of ["", "post address", "http://x.com/jack/status/20", "https://x.com/jack", "https://x.com/jack/status/20/photo/1", "https://x.com/jack/status/20 height=300", "https://x.com/jack/status/abc", "https://x.com.evil.example/jack/status/20", "https://bsky.app/profile/a/b/post/3l6oveex3ii2l", "https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l", "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/..%2F..", "https://mastodon.social/@Gargron/1"]) {
      expect(postIn(written), written).toBeNull();
    }
  });

  it("only ever frames a site the app allows in a frame", () => {
    for (const written of ["https://youtu.be/dQw4w9WgXcQ"]) expect(FRAME_ORIGINS).toContain(new URL(playerFor(videoIn(written)!)).origin);
    for (const written of ["https://x.com/jack/status/20", "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l"]) {
      const post = postIn(written)!;
      expect(FRAME_ORIGINS).toContain(new URL(post.frame("dark")).origin);
      expect(FRAME_ORIGINS).toContain(post.origin);
    }
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
