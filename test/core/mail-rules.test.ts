import { describe, expect, it } from "vitest";
import { addressNamed, ruleLike, skips, termsOf, type Ruled } from "../../src/core/mailRules.ts";
import { MailRuleCriteria, type MailRuleFields } from "../../src/core/protocol.ts";

const rule = (fields: Partial<MailRuleFields>): MailRuleFields => MailRuleCriteria.parse(fields);

const message = (m: Partial<Ruled> = {}): Ruled => ({
  from: { name: "Shop", address: "deals@news.shop.example" },
  to: [{ name: "Ada", address: "ada@example.com" }],
  cc: [],
  subject: "Big sale this weekend",
  text: "Everything is half price. Unsubscribe any time.",
  listId: "Shop News <news.shop.example>",
  attachments: 0,
  ...m,
});

describe("a skip rule", () => {
  it("asks at least one thing: an empty one is refused, and would match nothing", () => {
    expect(MailRuleCriteria.safeParse({}).success).toBe(false);
    expect(MailRuleCriteria.safeParse({ from: "  ", subject: "" }).success).toBe(false);
    expect(MailRuleCriteria.safeParse({ hasAttachment: true }).success).toBe(true);
    expect(skips({ from: "", to: "", subject: "", hasWords: "", doesntHave: "", list: "", hasAttachment: false }, message())).toBe(false);
  });

  it("matches from by address or domain, any of several, and a domain inside the one named", () => {
    for (const from of ["deals@news.shop.example", "DEALS@news.shop.example", "@shop.example", "shop.example", "news.shop.example", "other.example, shop.example", "other.example OR shop.example"]) expect(skips(rule({ from }), message()), from).toBe(true);
    for (const from of ["sales@news.shop.example", "hop.example", "shop.example.org", "other.example"]) expect(skips(rule({ from }), message()), from).toBe(false);
    expect(addressNamed("a@or.example", "or.example")).toBe(true);
  });

  it("matches to by any recipient, To or Cc", () => {
    expect(skips(rule({ to: "ada@example.com" }), message())).toBe(true);
    expect(skips(rule({ to: "team.example" }), message({ cc: [{ name: "", address: "all@team.example" }] }))).toBe(true);
    expect(skips(rule({ to: "grace@example.com" }), message())).toBe(false);
  });

  it("matches subject, has the words and doesn't have by whole words and quoted phrases, ignoring case", () => {
    expect(skips(rule({ subject: "SALE" }), message())).toBe(true);
    expect(skips(rule({ subject: "sale weekend" }), message())).toBe(true);
    expect(skips(rule({ subject: "half" }), message())).toBe(false);
    expect(skips(rule({ subject: "sal" }), message({ subject: "Wholesale" }))).toBe(false);
    expect(skips(rule({ hasWords: "unsubscribe" }), message())).toBe(true);
    expect(skips(rule({ hasWords: '"half price"' }), message())).toBe(true);
    expect(skips(rule({ hasWords: '"price half"' }), message())).toBe(false);
    expect(skips(rule({ hasWords: "sale unsubscribe" }), message())).toBe(true);
    expect(skips(rule({ hasWords: "sale invoice" }), message())).toBe(false);
    expect(skips(rule({ doesntHave: "invoice" }), message())).toBe(true);
    expect(skips(rule({ doesntHave: "invoice price" }), message())).toBe(false);
    expect(termsOf('one "two  three" four')).toEqual(["one", "two three", "four"]);
  });

  it("matches a mailing list by its List-Id, and never mail that came through none", () => {
    expect(skips(rule({ list: "news.shop.example" }), message())).toBe(true);
    expect(skips(rule({ list: "<news.shop.example>" }), message())).toBe(true);
    expect(skips(rule({ list: "other.example" }), message())).toBe(false);
    expect(skips(rule({ list: "news.shop.example" }), message({ listId: null }))).toBe(false);
  });

  it("matches has attachment only for a message with files", () => {
    expect(skips(rule({ hasAttachment: true }), message({ attachments: 2 }))).toBe(true);
    expect(skips(rule({ hasAttachment: true }), message())).toBe(false);
  });

  it("matches only when everything it asks is so, combined in one rule", () => {
    const both = rule({ from: "shop.example", hasWords: "sale", doesntHave: "receipt", hasAttachment: false });
    expect(skips(both, message())).toBe(true);
    expect(skips(both, message({ text: "Your receipt" }))).toBe(false);
    expect(skips(both, message({ subject: "Your receipt", text: "Thanks" }))).toBe(false);
    expect(skips(both, message({ from: { name: "", address: "friend@else.example" } }))).toBe(false);
    expect(skips(rule({ from: "shop.example", hasAttachment: true }), message())).toBe(false);
  });

  it("is read against a forward's original message, its sender and headers, and not the member who forwarded it", () => {
    // What receive() reads a rule against for a forward: the message forwarded, as its sender wrote it.
    const forwarded = message({ from: { name: "Boss", address: "boss@corp.example" }, to: [{ name: "Ada", address: "ada@work.example" }], listId: null });
    expect(skips(rule({ from: "corp.example" }), forwarded)).toBe(true);
    expect(skips(rule({ from: "ada@example.com" }), forwarded)).toBe(false);
  });

  it("is started from a message by its mailing list where it has one, and else by its sender", () => {
    expect(ruleLike(message())).toMatchObject({ from: "", list: "news.shop.example" });
    expect(ruleLike(message({ listId: null }))).toMatchObject({ from: "deals@news.shop.example", list: "" });
    expect(ruleLike(message({ listId: "bare.list.example" }))).toMatchObject({ list: "bare.list.example" });
  });
});
