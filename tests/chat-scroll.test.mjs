import test from "node:test";
import assert from "node:assert/strict";
import { ChatScroll } from "../web/chat-scroll.mjs";

function viewport(height = 1200, view = 400) {
  let top = height - view;
  return {
    scrollHeight: height, clientHeight: view,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
  };
}

test("incoming chunks keep following the bottom, including a large first chunk", () => {
  const scroll = new ChatScroll(), pane = viewport();
  scroll.observe(pane);
  pane.scrollHeight += 900;
  assert.equal(scroll.update(pane), false);
  assert.equal(pane.scrollTop, 1700);
});

test("reading older messages survives streaming, completion and viewport resize", () => {
  const scroll = new ChatScroll(), pane = viewport();
  pane.scrollTop = 200;
  assert.equal(scroll.observe(pane), true);
  for (const height of [1300, 1700, 1900]) {
    pane.scrollHeight = height;
    assert.equal(scroll.update(pane), true);
    assert.equal(pane.scrollTop, 200);
  }
  pane.clientHeight = 300;
  assert.equal(scroll.update(pane), true);
  assert.equal(pane.scrollTop, 200);
});

test("explicit resume or scrolling back to the bottom follows subsequent chunks", () => {
  for (const explicit of [true, false]) {
    const scroll = new ChatScroll(), pane = viewport();
    pane.scrollTop = 100;
    scroll.observe(pane);
    if (explicit) scroll.reset();
    else { pane.scrollTop = 799.5; scroll.observe(pane); }
    pane.scrollHeight += 100;
    assert.equal(scroll.update(pane), false);
    assert.equal(pane.scrollTop, 900);
  }
});

test("opening an archive preserves its top; a new conversation resets reading intent", () => {
  const scroll = new ChatScroll(), pane = viewport();
  scroll.reset(false);
  pane.scrollTop = 0;
  scroll.update(pane);
  assert.equal(pane.scrollTop, 0);
  scroll.reset();
  scroll.update(pane);
  assert.equal(pane.scrollTop, 800);
  assert.equal(scroll.update(null), false);
});
