import React, { useEffect, useState } from "react";
import { RefreshCw, Link, Copy } from "lucide-react";

export function SyncPanel({ api, Section, Button, Field }) {
  const [state,setState]=useState(null),[invitation,setInvitation]=useState(""),[join,setJoin]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const load=()=>api("/sync/state").then(setState);
  useEffect(()=>{load().catch(e=>setError(e.message));const timer=setInterval(()=>load().catch(()=>{}),5000);return()=>clearInterval(timer);},[]);
  const run=async action=>{if(busy)return;setBusy(true);setError("");try{await action();await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <Section title="手机与电脑同步" subtitle="两端连接同一个局域网。配对后同步聊天、记忆、健康档案与报告原件、模型设置和 ESP32 配对信息。传输内容加密。">
    {error&&<p className="health-error" role="alert">{error}</p>}
    {state?.enabled&&<>
      <p>当前设备：{state.name} · {state.ready ? "可提供服务" : "等待模型配置或首次同步"}</p>
      <p>ESP32 自动连接地址：<code>{`http://${state.hostname}:${state.port}/xiaozhi/ota/`}</code></p>
      <p className="small muted">将 ESP32 的服务地址设置为上面的地址。两端都在线时新连接优先选择电脑；当前连接正常时继续使用，断线后选择仍在线的一端。手机 App 的服务需要保持运行。</p>
      <p className="small muted">自动发现：{state.discovery?"已启动":"尚未启动"}。局域网需要允许组播；跨网络时不会自动同步。</p>
      {state.peers.length?state.peers.map(peer=><div className="health-list-row" key={peer.id}><div><strong>{peer.name}</strong><small>{peer.address} · {peer.online?"在线":"暂未连接"} · 上次同步：{peer.lastSync?new Date(peer.lastSync).toLocaleString("zh-CN"):"尚未完成"}</small>{peer.error&&<small className="health-error">{peer.error}</small>}</div></div>):<p>还没有连接另一台设备。</p>}
      {state.errors.map((e,i)=><p className="small" key={i}>{e}</p>)}
      <div className="form-actions"><Button icon={RefreshCw} disabled={busy} onClick={()=>run(()=>api("/sync/run","POST"))}>立即同步</Button><Button disabled={busy} onClick={()=>run(async()=>{if(!window.confirm("停止这台设备的同步？本机资料会保留。"))return;await api("/sync","DELETE");setInvitation("");})}>断开同步</Button></div>
    </>}
    <details><summary>连接另一台手机或电脑</summary>
      <p>先在已有资料的设备生成配对信息，再在另一台设备粘贴。配对信息十分钟内有效、只能使用一次，请只交给自己的设备。</p>
      <Button icon={Link} disabled={busy} onClick={()=>run(async()=>{const result=await api("/sync/invite","POST");setInvitation(result.invitation);})}>生成配对信息</Button>
      {invitation&&<><Field label="一次性配对信息"><textarea readOnly rows={3} value={invitation} /></Field><Button icon={Copy} onClick={()=>run(()=>navigator.clipboard.writeText(invitation))}>复制配对信息</Button></>}
      <form onSubmit={e=>{e.preventDefault();run(async()=>{await api("/sync/join","POST",{invitation:join});setJoin("");});}}>
        <Field label="粘贴另一台设备生成的配对信息"><textarea rows={3} value={join} onChange={e=>setJoin(e.target.value)} required autoComplete="off" /></Field>
        <Button primary disabled={busy||!join.trim()}>配对并同步</Button>
      </form>
    </details>
  </Section>;
}
