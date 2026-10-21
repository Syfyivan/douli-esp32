// Snapshot per page: another tab switching profiles cannot redirect an in-flight
// request, audio URL or conversation into a different person's space.
let person = "";
try { person = localStorage.getItem("douli.person") || ""; } catch {}
export const selectedPerson = () => person;
export const personHeaders = () => ({ "X-Douli-Person": person });
export const personUrl = path => path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ person });
export function selectPerson(id) {
  // End Android's background call before changing the page's identity.
  window.douliNativeVoice?.send({ action: "command", command: { type: "end" } });
  localStorage.setItem("douli.person", id); location.reload();
}
