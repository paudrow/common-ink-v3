import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { dateAt } from "../../src/web/plugins/dates/drawing.ts";
import { asksToPick, chipWords, fullWords, howFar, orderIn, saidFor, soon, written, type When } from "../../src/web/plugins/dates/when.ts";

/** Tuesday, October 20, 2026, at 9:41 in the morning where the member is. */
const NOW = { day: "2026-10-20", time: "09:41" };
/** A day and its time as words, which the link `written` writes holds. */
const words = ({ day, time }: When) => (time === null ? day : `${day} ${time}`);
const said = (typed: string, order: "month-day" | "day-month" = "month-day") => saidFor(typed, NOW, order).map((s) => [s.name, words(s)]);

describe("the days @ offers for what was typed", () => {
  it("for nothing typed, is today and tomorrow, with no time", () => {
    expect(soon(NOW).map((s) => [s.name, words(s)])).toEqual([
      ["Today", "2026-10-20"],
      ["Tomorrow", "2026-10-21"],
    ]);
  });

  it("names today, tomorrow and yesterday, by any start of their names", () => {
    expect(said("tod")).toEqual([["Today", "2026-10-20"]]);
    expect(said("TOMORROW")).toEqual([["Tomorrow", "2026-10-21"]]);
    expect(said("yest")).toEqual([["Yesterday", "2026-10-19"]]);
  });

  it("takes a weekday as the coming one, never today, and next with a weekday as that day of next week, which starts on Monday", () => {
    expect(said("fri")).toEqual([["Friday", "2026-10-23"]]);
    expect(said("tuesday")).toEqual([["Tuesday", "2026-10-27"]]);
    expect(said("next fri")).toEqual([["Next Friday", "2026-10-30"]]);
    expect(said("next monday")).toEqual([["Next Monday", "2026-10-26"]]);
    expect(saidFor("next fri", { day: "2026-10-24", time: "09:00" }, "month-day").map(words)).toEqual(["2026-10-30"]);
    expect(saidFor("next mon", { day: "2026-10-25", time: "09:00" }, "month-day").map(words)).toEqual(["2026-10-26"]);
  });

  it("offers every day a letter or two starts, soonest first, and the days after next only once next is typed whole", () => {
    expect(said("t")).toEqual([
      ["Today", "2026-10-20"],
      ["Tomorrow", "2026-10-21"],
      ["Thursday", "2026-10-22"],
      ["Tuesday", "2026-10-27"],
    ]);
    expect(said("ne")).toEqual([]);
    expect(said("next")).toEqual([
      ["Next Monday", "2026-10-26"],
      ["Next Tuesday", "2026-10-27"],
      ["Next Wednesday", "2026-10-28"],
      ["Next Thursday", "2026-10-29"],
      ["Next Friday", "2026-10-30"],
      ["Next Saturday", "2026-10-31"],
      ["Next Sunday", "2026-11-01"],
    ]);
  });

  it("reads a date by its month's name either side of the day, in the year that puts it nearest today unless one is given", () => {
    expect(said("oct 20")).toEqual([[null, "2026-10-20"]]);
    expect(said("20 oct")).toEqual([[null, "2026-10-20"]]);
    expect(said("october 21st")).toEqual([[null, "2026-10-21"]]);
    expect(said("sept 3")).toEqual([[null, "2026-09-03"]]);
    expect(said("jan 5")).toEqual([[null, "2027-01-05"]]);
    expect(said("apr 1")).toEqual([[null, "2027-04-01"]]);
    expect(said("mar 1")).toEqual([[null, "2027-03-01"]]);
    expect(said("may 1")).toEqual([[null, "2026-05-01"]]);
    expect(said("dec 25, 2025")).toEqual([[null, "2025-12-25"]]);
    expect(said("feb 29")).toEqual([[null, "2028-02-29"]]);
    expect(said("feb 30")).toEqual([]);
    expect(said("ma 3")).toEqual([]);
  });

  it("reads a date in numbers in the order the member's locale writes them, and an ISO date as it is", () => {
    expect(said("10/21")).toEqual([[null, "2026-10-21"]]);
    expect(said("21/10", "day-month")).toEqual([[null, "2026-10-21"]]);
    expect(said("21/10")).toEqual([]);
    expect(said("1/5/27")).toEqual([[null, "2027-01-05"]]);
    expect(said("2026-12-31")).toEqual([[null, "2026-12-31"]]);
    expect(said("2026-13-01")).toEqual([]);
  });

  it("reads a time before or after a day, with or without at, and a time alone as today's", () => {
    expect(said("3pm")).toEqual([["Today", "2026-10-20 15:00"]]);
    expect(said("15:30")).toEqual([["Today", "2026-10-20 15:30"]]);
    expect(said("tomorrow 3pm")).toEqual([["Tomorrow", "2026-10-21 15:00"]]);
    expect(said("tomorrow at 3:30 pm")).toEqual([["Tomorrow", "2026-10-21 15:30"]]);
    expect(said("9a fri")).toEqual([["Friday", "2026-10-23 09:00"]]);
    expect(said("12am tomorrow")).toEqual([["Tomorrow", "2026-10-21 00:00"]]);
    expect(said("oct 31 noon")).toEqual([[null, "2026-10-31 12:00"]]);
    expect(said("now")).toEqual([["Now", "2026-10-20 09:41"]]);
    expect(said("tomorrow at")).toEqual([["Tomorrow", "2026-10-21"]]);
  });

  it("is nothing for nothing typed, for a number alone, or for words that start no day", () => {
    expect(said("")).toEqual([]);
    expect(said("3")).toEqual([]);
    expect(said("13pm")).toEqual([]);
    expect(said("25:00")).toEqual([]);
    expect(said("sam")).toEqual([]);
    expect(said("ada lovelace")).toEqual([]);
    expect(said("tomorrow afternoon")).toEqual([]);
  });

  it("offers the date picker by name alone: pick, pick a date on the way, or date", () => {
    expect(["pick", "pick a", "Pick a date", "Date", "p", "pi", "dat", "", "dates", "picks"].map(asksToPick)).toEqual([true, true, true, true, false, false, false, false, false, false]);
  });
});

describe("a day written in a note", () => {
  it("is a link to the day, with its time where there is one", () => {
    expect([written({ day: "2026-10-21", time: null }), written({ day: "2026-10-21", time: "15:30" })]).toEqual(["[[2026-10-21]]", "[[2026-10-21 15:30]]"]);
  });
});

describe("how a day reads", () => {
  it("reads on its chip as a short date with its weekday, the year only where it isn't this year's", () => {
    expect(chipWords({ day: "2026-10-21", time: null }, "2026", "en-US")).toBe("Wed, Oct 21");
    expect(chipWords({ day: "2026-10-21", time: "15:00" }, "2026", "en-US")).toBe("Wed, Oct 21, 3:00 PM");
    expect(chipWords({ day: "2027-01-05", time: null }, "2026", "en-US")).toBe("Tue, Jan 5, 2027");
  });

  it("reads in full in the list, and says how far it is from today", () => {
    expect(fullWords({ day: "2026-10-21", time: null }, "en-US")).toBe("Wednesday, October 21, 2026");
    expect(fullWords({ day: "2026-10-21", time: "15:00" }, "en-US")).toBe("Wednesday, October 21, 2026 at 3:00 PM");
    expect(["2026-10-20", "2026-10-21", "2026-10-19", "2026-10-23", "2026-11-10", "2027-04-01", "2024-10-20"].map((day) => howFar(day, NOW.day, "en-US"))).toEqual([
      "Today",
      "Tomorrow",
      "Yesterday",
      "In 3 days",
      "In 3 weeks",
      "In 5 months",
      "2 years ago",
    ]);
  });

  it("knows which of the month and the day a locale writes first", () => {
    expect([orderIn("en-US"), orderIn("en-GB"), orderIn("de-DE")]).toEqual(["month-day", "day-month", "day-month"]);
  });
});

describe("the date at the cursor, which Alt+Shift+D changes and gd follows", () => {
  const at = (doc: string, pos: number) => dateAt(EditorState.create({ doc }), pos);

  it("is the date link the cursor is in or at the edge of, with its time and its own words", () => {
    expect(at("Due [[2026-10-21 15:00]] then", 4)).toMatchObject({ day: "2026-10-21", time: "15:00", from: 4, to: 24, display: null });
    expect(at("Due [[2026-10-21|the day]] then", 26)).toMatchObject({ day: "2026-10-21", time: null, display: "the day" });
    expect(at("Due [[2026-10-21]] then", 2)).toBeNull();
  });

  it("is none for a date written bare, or a link to anything else", () => {
    expect([at("Due 2026-10-21 then", 6), at("See [[abcdefabcdef]]", 6), at("`[[2026-10-21]]`", 4)]).toEqual([null, null, null]);
  });
});
