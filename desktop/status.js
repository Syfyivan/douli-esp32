async function refresh() {
  const state = await window.douliDesktop.getStatus();
  document.querySelector("#title").textContent = state.error ? "暂时无法打开豆梨" : "正在打开你的豆梨";
  document.querySelector("#message").textContent = state.error || "准备本地服务，请稍候…";
  document.querySelector("#actions").hidden = !state.error;
}
document.querySelector("#retry").onclick = async () => {
  document.querySelector("#retry").disabled = true;
  try { await window.douliDesktop.retry(); } finally { document.querySelector("#retry").disabled = false; await refresh(); }
};
document.querySelector("#logs").onclick = () => window.douliDesktop.openLogs();
void refresh();
