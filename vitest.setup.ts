import "@testing-library/jest-dom/vitest";

// jsdom has no layout, so a transcript's scroll geometry is all zeroes and
// `scrollIntoView` does not exist at all. The pane calls both on every render
// that adds a message; without these the first assertion in every component
// test is drowned by an unrelated TypeError.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
