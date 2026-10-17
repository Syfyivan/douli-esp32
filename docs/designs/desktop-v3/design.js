// Review-only navigation and fictional content. No application APIs are called.
navItems.splice(0, navItems.length,
  ['chat','chat','对话记录'], ['assistant','spark','我的助手'],
  ['memory','memory','我的资料'], ['settings','settings','设置']
);
const originalSettings = pageContent.settings;
let showDevices = false;
try { showDevices = localStorage.getItem('douli-design-v3-devices') === 'true'; } catch {}
function navigation() {
  const items = navItems.slice();
  if (showDevices) items.splice(3, 0, ['devices','device','设备与家居']);
  return items;
}
function goButton(label,route,kind='',symbol='') {
  return '<button class="btn '+kind+'" data-go="'+route+'">'+(symbol?icon(symbol,15):'')+label+'</button>';
}
function goLink(label,route) {
  return '<button class="section-link" data-go="'+route+'">'+label+icon('chevron',13)+'</button>';
}
function layoutSidebar(page) {
  return '<aside class="sidebar"><div class="brand"><div class="brand-mark">d.</div><div><strong>豆梨</strong><small>你的日常陪伴</small></div></div><div class="nav-caption">我的空间</div><nav class="nav">'+
    navigation().map(([id,symbol,label])=>'<button data-go="'+id+'" data-nav="'+id+'" class="'+(page===id?'active':'')+'">'+icon(symbol)+label+'</button>').join('')+'</nav>'+
    '<div class="sidebar-note">在音箱上聊日常，<br>在这里回看和整理。</div><div class="sidebar-bottom"><div class="sidebar-status"><i class="dot"></i>本机服务已连接</div><div class="profile"><span class="profile-avatar">我</span><div><strong>我的个人空间</strong><small>资料保存在本机</small></div>'+icon('chevron',13)+'</div></div></aside>';
}
const profileSections = [['memory','偏好与记忆'],['memory/experiences','近期经历'],['memory/health','健康资料']];
function profileHeader(route) {
  return heading('关于我，慢慢整理','偏好、聊过的经历，还有健康资料，都收在这里。')+
    '<div class="profile-tabs">'+profileSections.map(([id,label])=>'<button data-go="'+id+'" class="'+(route===id?'selected':'')+'">'+label+'</button>').join('')+'</div>';
}
function settingsNavigation(active) {
  return '<aside class="settings-nav">'+[
    ['settings','spark','模型与服务'], ['voice','mic','声音与语音'], ['dictionary','book','个人词典'],
    ['caption','','资料与设备'], ['privacy','shield','隐私与数据'], ['sync','refresh','手机同步'],
    ['caption','','桌面应用'], ['settings/modules','sliders','功能显示'], ['desktop','laptop','桌面偏好'], ['logs','clock','运行记录']
  ].map(([id,symbol,label])=>id==='caption'?'<div class="section-caption">'+label+'</div>':
    '<button '+(id.startsWith('settings')?'data-go="'+id+'"':'data-preview="'+label+'"')+' class="'+(id===active?'selected':'')+'">'+icon(symbol,15)+label+'</button>').join('')+'</aside>';
}
const historyItems = [
  ['把今天慢慢说完','完成了一件惦记很久的事','今天 · 21:08','12 条消息','current'],
  ['关于周末的一点小计划','想找一个地方走走','昨天 · 19:42','18 条消息',''],
  ['最近想养成的小习惯','聊到这两天的晨跑','昨天 · 07:35','10 条消息',''],
  ['今天的晚饭吃什么','不放香菜，简单一点','10月14日 · 18:20','8 条消息',''],
  ['工作间隙，歇一会儿','关于休息和轻音乐','10月13日 · 15:16','14 条消息',''],
  ['整理一下最近的想法','先把想说的慢慢说完','10月12日 · 20:05','16 条消息',''],
];
pageContent.chat = () => '<div class="archive-layout"><aside class="archive-list">'+
  '<div class="archive-title"><h1>对话记录</h1><span>28 段</span></div>'+
  '<div class="searchbox">'+icon('search',15)+'<input aria-label="搜索对话" id="history-search" placeholder="搜索聊过的内容"></div>'+
  '<div class="archive-filters">'+btn('全部来源','small-btn','down')+btn('日期','small-btn','clock')+'</div>'+
  '<div class="archive-group">最近的对话</div><div class="archive-rows">'+historyItems.map(([title,sub,date,count,selected])=>'<button class="archive-row '+selected+'" data-history-title="'+title+'"><strong>'+title+'</strong><p>'+sub+'</p><small>'+icon('device',12)+'音箱<span>·</span>'+date+'</small><span class="row-count">'+count+'</span></button>').join('')+'</div>'+
  '<div class="archive-bottom">'+icon('lock',12)+'记录保存在本机，可搜索和导出</div></aside>'+
  '<section class="conversation archive-conversation"><div class="thread-heading"><div><h1>把今天慢慢说完</h1><p>'+icon('device',12)+'豆梨床头音箱<span>·</span>10月16日 21:08<span>·</span>12 条消息</p></div><div class="thread-actions">'+btn('导出','small-btn','download')+'<button class="iconbtn" data-preview="对话选项">'+icon('more')+'</button></div></div>'+
  '<div class="archive-context"><span class="context-icon">'+icon('book',17)+'</span><div><strong>这次聊到</strong><p>做完了拖延已久的事情，想给自己留一个轻松的晚上。</p></div>'+goLink('查看经历','memory/experiences')+'</div>'+
  '<div class="thread-scroll"><div class="date-divider">10月16日 · 21:08</div>'+
  '<div class="message"><div class="msg-avatar">d.</div><div class="message-body"><div class="msg-meta"><strong>豆梨</strong><span>21:08</span></div><div class="msg-text">我在。今天过得怎么样？<br>开心的、烦心的，或者只是一件小事，都可以聊聊。</div></div></div>'+
  '<div class="message user"><div class="bubble">今天终于把拖了很久的事情做完了。<br>挺开心的，但突然又有点不知道接下来做什么。<div class="voice-meta">'+icon('device',12)+'音箱语音转写</div></div></div>'+
  '<div class="message"><div class="msg-avatar">d.</div><div class="message-body"><div class="msg-meta"><strong>豆梨</strong><span>21:09</span></div><div class="msg-text">那种一直惦记着的事，终于能放下了。<br>先让自己享受一下这个轻松的晚上吧，不用马上给空出来的时间安排新任务。</div><div class="reply-callout">也许今晚只需要一首喜欢的歌，<br>或者散个步，把“终于做完了”的感觉多留一会儿。</div><div class="message-tools">'+icon('copy',14)+icon('more',14)+'</div></div></div>'+
  '<div class="archive-end">· · ·<span>本次对话节选</span></div></div>'+
  '<footer class="archive-footer"><span>'+icon('device',14)+'音箱对话会保存在这里</span><div class="flex gap8">'+btn('电脑语音','small-btn ghost','mic')+btn('继续文字对话','small-btn','chat')+'</div></footer></section></div>';

pageContent.memory = () => '<div class="content profile-content">'+profileHeader('memory')+
  '<div class="profile-description"><div><h2>已经了解的你 <span class="inline-count">24 条</span></h2><p>以后聊天时，可以用到你确认过的个人事实和偏好。</p></div>'+btn('添加记忆','primary','plus')+'</div>'+
  '<div class="personal-layout"><div><div class="searchbox memory-query">'+icon('search',15)+'搜索一条偏好、一个人，或一件重要的事…</div><div class="filter-pills mt16"><button class="selected">全部记忆</button><button>生活偏好</button><button>交流习惯</button><button>个人信息</button><button>历史版本</button></div>'+
  '<section class="card saved-memory-list">'+[
    ['leaf','关于吃饭的小偏好','不喜欢香菜，点餐时记得帮我留意。','来自音箱对话 · 10月15日','查看原话'],
    ['chat','我喜欢的交流方式','先听我把话说完，不需要马上给建议。','由你手动设置 · 交流偏好','修改偏好'],
    ['headphones','工作时的小习惯','专注做事时，喜欢听没有人声的轻音乐。','来自音箱对话 · 10月12日','查看原话'],
    ['sun','我的休息偏好','周末喜欢留一些空闲，不把行程安排得太满。','来自音箱对话 · 10月11日','查看原话']
  ].map(([symbol,title,value,source,action])=>'<article class="memory-item"><div class="between"><div class="flex">'+mini(symbol)+'<h3>'+title+'</h3></div>'+tag('已确认','green')+'</div><p class="memory-text">'+value+'</p><div class="between"><span class="memory-source">'+icon('device',11)+source+'</span>'+link(action)+'</div></article>').join('')+'</section>'+
  '<div class="profile-foot">'+icon('checkcircle',13)+'手动保存或明确确认后，才作为个人资料使用。</div></div>'+
  '<aside class="stack"><section class="card review-card"><div class="between"><h2>待你确认</h2>'+tag('2 条','amber')+'</div><p class="review-intro">从你的原话里整理出来的候选内容。<br>你确认后，才会加入个人资料。</p>'+
  '<div class="pending-item"><strong>晚上十点后，希望轻声回应</strong><p class="source-quote">“晚上十点以后，你说话轻一点。”</p><small>来自音箱对话 · 昨天</small><div class="flex gap8 mt12">'+btn('确认记住','small-btn','check')+btn('不保存','small-btn ghost')+'</div></div>'+
  '<div class="pending-item"><div class="between"><strong>现在住在杭州</strong>'+tag('与旧资料不同','amber')+'</div><p class="source-quote">“我现在搬到杭州住了。”</p><small>原来记录：住在上海</small><div class="flex gap8 mt12">'+btn('确认更新','small-btn','check')+btn('不保存','small-btn ghost')+'</div></div></section>'+
  '<section class="profile-help"><span class="mini-icon">'+icon('clock',19)+'</span><h3>一次发生的事，去经历里看</h3><p>“昨天完成了一个项目”属于经历。<br>按日期回顾，也能找到当时的原话。</p>'+goLink('查看近期经历','memory/experiences')+'</section></aside></div></div>';

pageContent.experiences = () => '<div class="content profile-content">'+profileHeader('memory/experiences')+
  '<div class="profile-description"><div><h2>最近的生活片段</h2><p>从对话原话整理的时间线，记录发生过的事、近况和计划。</p></div>'+btn('按日期查看','','clock')+'</div>'+
  '<div class="personal-layout"><div><div class="searchbox memory-query">'+icon('search',15)+'找一段聊过的经历…</div><div class="experience-stream">'+[
    ['今天','10月16日','终于完成了一件惦记很久的事','已发生','今天做完了拖延已久的事情，想给自己一个轻松的晚上。','今天终于把拖了很久的事情做完了。','21:08 · 豆梨床头音箱'],
    ['昨天','10月15日','这两天，尝试出门晨跑','近况','提到最近两天早上出门跑步。','这两天早上出门跑了一小会儿。','07:35 · 豆梨床头音箱'],
    ['前天','10月14日','周末想去户外走走','计划','想找个天气好的日子，到公园散步。','周末要是天气好，我想去公园走走。','19:42 · 豆梨床头音箱']
  ].map(([day,date,title,status,body,quote,source])=>'<article class="experience-entry"><div class="experience-date"><strong>'+day+'</strong><span>'+date+'</span><i></i></div><div class="card"><div class="between"><h3>'+title+'</h3>'+tag(status,status==='计划'?'lavender':'green')+'</div><p class="experience-body">'+body+'</p><p class="experience-quote">“'+quote+'”</p><div class="between"><small>'+icon('device',11)+source+'</small>'+goLink('回到对话','chat')+'</div></div></article>').join('')+'</div></div>'+
  '<aside class="stack"><section class="card"><div class="between"><h2>10 月</h2><span class="small muted">2026</span></div><div class="week-strip">'+[10,11,12,13,14,15,16].map(n=>'<span class="'+(n===16?'today':'')+'">'+n+'<i class="'+(n>=12?'has-record':'')+'"></i></span>').join('')+'</div><div class="between small muted"><span>本月整理了</span><strong>8 段经历</strong></div></section>'+
  '<section class="profile-help">'+mini('book')+'<h3>摘要背后，都有当时的原话</h3><p>点“回到对话”可以核对上下文。经历摘要可以自动整理，不能单凭一次经历认定长期偏好。</p><p class="mt16">例如：昨天晨跑过，<br>不等于你一直喜欢跑步。</p></section></aside></div></div>';

pageContent.health = () => '<div class="content profile-content">'+profileHeader('memory/health')+
  '<div class="profile-description"><div><h2>我的健康资料</h2><p>检查报告、病史与用药记录，作为个人资料统一管理。</p></div>'+btn('上传报告','primary','plus')+'</div>'+
  '<div class="health-collection"><section class="card report-library"><div class="card-title"><h2>检查报告 <span class="inline-count">2 份</span></h2>'+btn('按时间排序','small-btn ghost','down')+'</div><div class="document-table"><div class="document-head"><span>报告名称</span><span>检查日期</span><span>状态</span><span></span></div>'+
  '<div class="document-row"><div class="flex">'+mini('file')+'<div><strong>年度体检报告</strong><small>PDF · 6 页</small></div></div><span>2026.10.12</span>'+tag('已核对','green','check')+btn('查看','small-btn')+'</div>'+
  '<div class="document-row"><div class="flex">'+mini('file','amber')+'<div><strong>血常规检查</strong><small>图片 · 1 页</small></div></div><span>2026.10.08</span>'+tag('等待核对','amber','clock')+btn('核对','small-btn')+'</div></div>'+
  '<div class="document-upload" data-preview="上传检查报告">'+icon('plus',21)+'<strong>添加一份检查报告</strong><span>PDF 或图片 · 保存原件，方便日后查找</span></div></section>'+
  '<aside class="card health-profile-card"><div class="card-title"><h2>健康档案</h2>'+btn('添加','small-btn ghost','plus')+'</div>'+
  [['病史与健康背景','2 条记录','health'],['用药记录','1 条记录','book'],['过敏信息','待补充','shield']].map(([label,value,symbol])=>'<button class="health-folder" data-preview="'+label+'">'+mini(symbol)+'<span><strong>'+label+'</strong><small>'+value+'</small></span>'+icon('chevron',15)+'</button>').join('')+
  '<p class="side-note mt20">资料有变化时，可以随时补充和更正。</p></aside></div>'+
  '<div class="health-lower"><section class="card health-changes"><div class="card-title"><h2>最近更新</h2>'+link('全部记录')+'</div><div class="change-line"><span class="change-date">10月12日</span><i class="dot"></i><div><strong>年度体检报告已核对</strong><p>保留原始报告与核对后的记录</p></div>'+tag('检查报告','outline')+'</div><div class="change-line"><span class="change-date">10月08日</span><i class="dot"></i><div><strong>添加了血常规检查</strong><p>等待你核对识别的内容</p></div>'+tag('检查报告','outline')+'</div></section>'+
  '<div class="profile-help health-storage">'+mini('lock')+'<h3>健康资料，也是关于你的资料</h3><p>在这里整理、查看和更新。<br>档案与报告仍单独分类，保留原件和来源。</p><p class="mt16">保存在本机，随时可以删除。</p></div></div></div>';

pageContent.settings = () => originalSettings()
  .replace(/<aside class="settings-nav">[\s\S]*?<\/aside>/, settingsNavigation('settings'))
  .replace('先连好声音和模型，其余设置慢慢调整。','管理豆梨的模型、声音，以及电脑端的显示方式。');
pageContent.modules = () => '<div class="content">'+heading('把一切，调到刚刚好','管理豆梨的模型、声音，以及电脑端的显示方式。')+
  '<div class="settings-layout">'+settingsNavigation('settings/modules')+'<div class="module-layout"><div class="stack"><section class="card module-card">'+cardTitle('侧栏显示',tag('按需开启','outline'))+
  '<p class="side-note mb24">把常用入口留在侧栏，其余功能需要时再打开。</p><div class="module-setting"><div class="flex">'+mini('device')+'<div><h3>设备与家居</h3><p>开启后，在侧栏显示设备与家居入口。</p></div></div><button id="devices-toggle" class="toggle '+(showDevices?'on':'')+'" aria-label="在侧栏显示设备与家居" aria-pressed="'+showDevices+'"></button></div>'+
  '<div class="module-explanation">'+icon('device',16)+'<p>隐藏入口只影响界面显示，<br>已连接的音箱仍然可以正常对话。</p></div></section>'+
  '<section class="card">'+cardTitle('打开电脑端时')+'<div class="between"><div><h3>默认首页</h3><p class="side-note mt8">先回到最近聊过的内容。</p></div>'+btn('对话记录','','down')+'</div></section>'+
  '<section class="card"><div class="between"><div class="flex">'+mini('device')+'<div><h3>豆梨床头音箱</h3><p class="side-note mt8"><i class="dot"></i> 已连接 · 等待唤醒</p></div></div>'+btn('连接设置','small-btn','sliders')+'</div></section>'+
  '<div class="profile-foot">'+icon('checkcircle',13)+'显示设置即时生效。</div></div>'+
  '<aside class="nav-preview"><span class="eyebrow">侧栏预览</span><div class="nav-preview-brand"><span class="brand-mark">d.</span><strong>豆梨</strong></div>'+navigation().map(([id,symbol,label])=>'<div class="nav-preview-item '+(id==='settings'?'selected':'')+'">'+icon(symbol,17)+label+'</div>').join('')+'<p>'+ (showDevices?'设备与家居已显示':'当前保留 4 个常用入口')+'</p></aside></div></div></div>';

let toastTimer;
function toast(value) {
  const el=document.getElementById('preview-toast');
  el.textContent=value;el.classList.add('visible');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2400);
}
function render() {
  let route = location.hash.slice(1) || 'chat';
  if (route === 'health') route = 'memory/health';
  const map = {
    chat:['chat','chat'], assistant:['assistant','assistant'], memory:['memory','memory'],
    'memory/experiences':['memory','experiences'], 'memory/health':['memory','health'],
    settings:['settings','settings'], 'settings/modules':['settings','modules'],
    devices:showDevices?['devices','devices']:['settings','modules']
  };
  const [page,view] = map[route] || map.chat;
  const label = navigation().find(x=>x[0]===page)?.[2] || '设置';
  document.title='豆梨 · '+label+' · 设计稿 03';
  document.getElementById('design').innerHTML='<div class="desktop revision-three" data-page="'+page+'" data-view="'+view+'"><div class="titlebar"><strong>豆梨</strong><span class="titlebar-note">DESIGN 03 · 设计预览 · 所有内容均为示例数据</span><div class="window-actions"><span>'+icon('minimize',11)+'</span><span>'+icon('maximize',11)+'</span><span>'+icon('x',11)+'</span></div></div><div class="workspace">'+layoutSidebar(page)+'<main class="main"><header class="topline"><div class="crumb">我的空间'+icon('chevron',11)+'<strong>'+label+'</strong></div><div class="top-tools"><span class="local">'+icon('lock',11)+'本机空间</span><button class="iconbtn" data-preview="全局搜索">'+icon('search',16)+'</button></div></header>'+pageContent[view]()+'</main></div></div>';
  document.querySelectorAll('[data-go]').forEach(el=>el.onclick=()=>location.hash=el.dataset.go);
  document.querySelectorAll('[data-preview]').forEach(el=>el.onclick=()=>toast('「'+el.dataset.preview+'」入口示意 · 当前为设计预览'));
  document.querySelectorAll('.toggle:not(#devices-toggle)').forEach(el=>el.onclick=()=>{el.classList.toggle('on');el.setAttribute('aria-pressed',el.classList.contains('on'));});
  document.querySelectorAll('.chips .chip,.segmented button,.filter-pills button').forEach(el=>el.onclick=()=>{el.parentNode.querySelectorAll('.selected').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');});
  const switcher=document.getElementById('devices-toggle');
  if(switcher) switcher.onclick=()=>{
    showDevices=!showDevices;
    try { localStorage.setItem('douli-design-v3-devices',String(showDevices)); } catch {}
    render();
  };
  const search=document.getElementById('history-search');
  if(search) search.oninput=()=>{
    document.querySelectorAll('.archive-row').forEach(el=>el.hidden=!el.textContent.includes(search.value));
  };
  document.querySelectorAll('[data-history-title]').forEach(el=>el.onclick=()=>toast('「'+el.dataset.historyTitle+'」历史记录示例'));
}
addEventListener('hashchange',render);
addEventListener('keydown',event=>{
  if(event.target.matches('input,textarea'))return;
  if(/^[1-5]$/.test(event.key)&&navigation()[Number(event.key)-1])location.hash=navigation()[Number(event.key)-1][0];
});
render();
