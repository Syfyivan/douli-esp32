// Simli accepts one complete offer, not trickled candidate messages. Once each
// offered media section has a UDP relay fallback, a quiet gathering window lets
// us use the candidates already collected without waiting for redundant servers.
function hasRelayFallback(sdp = "") {
  const media = sdp.split(/(?=^m=)/m).filter(section => /^m=(?:audio|video) (?!0(?: |$))/.test(section));
  return media.length > 0 && media.every(section =>
    /^a=candidate:\S+ \d+ udp \d+ \S+ \d+ typ relay(?:\s|$)/im.test(section));
}

export function waitForAvatarIce(pc, signal) {
  return new Promise((resolve, reject) => {
    let quietTimer, limitTimer, finished = false;
    const finish = (reason, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(quietTimer); clearTimeout(limitTimer);
      pc.onicecandidate = pc.onicegatheringstatechange = null;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(reason);
    };
    const abort = () => finish(null, signal.reason || new Error("通话已取消"));
    const inspect = () => {
      if (pc.iceGatheringState === "complete") return finish("complete");
      clearTimeout(quietTimer);
      if (hasRelayFallback(pc.localDescription?.sdp)) quietTimer = setTimeout(() => finish("settled"), 250);
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    pc.onicecandidate = pc.onicegatheringstatechange = inspect;
    // Retain the existing full wait when public/relay candidates are missing.
    limitTimer = setTimeout(() => finish("timeout"), 8000);
    inspect();
  });
}
