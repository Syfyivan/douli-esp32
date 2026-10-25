// Remember the reader's intent before incoming content changes scrollHeight.
export class ChatScroll {
  following = true;

  reset(following = true) { this.following = following; }

  observe(pane) {
    this.following = this.distance(pane) <= 48;
    return !this.following;
  }

  update(pane) {
    if (!pane) return false;
    if (this.following) {
      // Move only this pane. Per-chunk smooth animations compete with reading
      // gestures and can scroll ancestors, even when reduced motion is enabled.
      pane.scrollTop = pane.scrollHeight;
      return false;
    }
    return this.distance(pane) > 48;
  }

  distance(pane) { return pane.scrollHeight - pane.clientHeight - pane.scrollTop; }
}
