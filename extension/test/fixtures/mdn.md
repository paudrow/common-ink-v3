# <article> HTML article contents element - HTML | MDN

[<article> HTML article contents element - HTML | MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article) · 2026-10-18

The **`<article>`** [HTML](https://developer.mozilla.org/en-US/docs/Web/HTML) element represents a self-contained composition in a document, page, application, or site, which is intended to be independently distributable or reusable (e.g., in syndication). Examples include: a forum post, a magazine or newspaper article, or a blog entry, a product card, a user-submitted comment, an interactive widget or gadget, or any other independent item of content.

## [Try it](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#try_it)

```
<article class="forecast">
  <h1>Weather forecast for Seattle</h1>
  <article class="day-forecast">
    <h2>03 March 2018</h2>
    <p>Rain.</p>
  </article>
  <article class="day-forecast">
    <h2>04 March 2018</h2>
    <p>Periods of rain.</p>
  </article>
  <article class="day-forecast">
    <h2>05 March 2018</h2>
    <p>Heavy rain.</p>
  </article>
</article>
```

```
.forecast {
  margin: 0;
  padding: 0.3rem;
  background-color: #eeeeee;
}

.forecast > h1,
.day-forecast {
  margin: 0.5rem;
  padding: 0.3rem;
  font-size: 1.2rem;
}

.day-forecast {
  background: right/contain content-box border-box no-repeat
    url("/shared-assets/images/examples/rain.svg") white;
}

.day-forecast > h2,
.day-forecast > p {
  margin: 0.2rem;
  font-size: 1rem;
}
```

## [Attributes](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#attributes)

This element only includes the [global attributes](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes).

## [Usage notes](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#usage_notes)

A given document can have multiple articles in it; for example, on a blog that shows the text of each article one after another as the reader scrolls, each post would be contained in an `<article>` element, possibly with one or more `<section>`s within.

- Each `<article>` should be identified, typically by including a heading ([`<h1>` - `<h6>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements) element) as a child of the `<article>` element.
- When an `<article>` element is nested, the inner element represents an article related to the outer element. For example, the comments of a blog post can be `<article>` elements nested in the `<article>` representing the blog post.
- Author information of an `<article>` element can be provided through the [`<address>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/address) element, but it doesn't apply to nested `<article>` elements.
- The publication date and time of an `<article>` element can be described using the [`datetime`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/time#datetime) attribute of a [`<time>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/time) element.

## [Examples](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#examples)

html

```
<article class="film_review">
  <h2>Jurassic Park</h2>
  <section class="main_review">
    <h3>Review</h3>
    <p>Dinos were great!</p>
  </section>
  <section class="user_reviews">
    <h3>User reviews</h3>
    <article class="user_review">
      <h4>Too scary!</h4>
      <p>Way too scary for me.</p>
      <footer>
        <p>
          Posted on
          <time datetime="2015-05-16 19:00">May 16</time>
          by Lisa.
        </p>
      </footer>
    </article>
    <article class="user_review">
      <h4>Love the dinos!</h4>
      <p>I agree, dinos are my favorite.</p>
      <footer>
        <p>
          Posted on
          <time datetime="2015-05-17 19:00">May 17</time>
          by Tom.
        </p>
      </footer>
    </article>
  </section>
  <footer>
    <p>
      Posted on
      <time datetime="2015-05-15 19:00">May 15</time>
      by Staff.
    </p>
  </footer>
</article>
```

### [Result](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#result)

## [Technical summary](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#technical_summary)

| [Content categories](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories) | [Flow content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#flow_content), [sectioning content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#sectioning_content), [palpable content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#palpable_content) |
| --- | --- |
| Permitted content | [Flow content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#flow_content). |
| Tag omission | None, both the starting and ending tag are mandatory. |
| Permitted parents | Any element that accepts [flow content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#flow_content). Note that an `<article>` element must not be a descendant of an [`<address>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/address) element. |
| Implicit ARIA role | `article` |
| Permitted ARIA roles | [`application`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/application_role), [`document`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/document_role), [`feed`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/feed_role), [`main`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/main_role), [`none`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/none_role), [`presentation`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/presentation_role), [`region`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/region_role) |
| DOM interface | [`HTMLElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement) |

## [Specifications](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#specifications)

| Specification |
| --- |
| [HTML # the-article-element](https://html.spec.whatwg.org/multipage/sections.html#the-article-element) |

## [Browser compatibility](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#browser_compatibility)

## [See also](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article#see_also)

- Other section-related elements: [`<body>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/body), [`<nav>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/nav), [`<section>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/section), [`<aside>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/aside), [h1](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements), [h2](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements), [h3](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements), [h4](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements), [h5](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements), [h6](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements), [`<hgroup>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/hgroup), [`<header>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/header), [`<footer>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/footer), [`<address>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/address)
- [Using HTML sections and outlines](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements)
