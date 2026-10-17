// Standalone design review: fictional data, no API calls or application changes.
const paths = {
  chat:'<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  spark:'<path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z"/>',
  memory:'<path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3"/><path d="M9 3h6v4l-3-2-3 2Z"/><path d="M7 12h10M7 16h7"/>',
  health:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/><path d="M3 12h5l2-4 4 8 2-4h5"/>',
  device:'<rect x="6" y="3" width="12" height="18" rx="4"/><path d="M10 7h4"/><circle cx="12" cy="15" r="2"/>',
  settings:'<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  arrowup:'<path d="M7 17 17 7M7 7h10v10"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  checkcircle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  more:'<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  volume:'<path d="m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  moon:'<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
  edit:'<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/>',
  pin:'<path d="m16 3 5 5-4 2-2 5-3 1-4-4 1-3 5-2ZM9 15l-6 6"/>',
  laptop:'<rect x="4" y="3" width="16" height="13" rx="2"/><path d="m4 16-2 4h20l-2-4M9 20h6"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  wifi:'<path d="M2 8a17 17 0 0 1 20 0M5 12a12 12 0 0 1 14 0M8 16a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r=".8"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-.8L20 8M4 16l1.5 1.8a8 8 0 0 0 13-.8"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 12h8M8 16h5"/>',
  book:'<path d="M12 5c-4-3-8-2-10-1v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1ZM12 5v15"/>',
  x:'<path d="m6 6 12 12M6 18 18 6"/>',
  minimize:'<path d="M4 12h16"/>',
  maximize:'<rect x="5" y="5" width="14" height="14" rx="1"/>',
  sliders:'<path d="M4 7h8M16 7h4M4 17h4M12 17h8"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  send:'<path d="m22 2-7 20-4-9-9-4ZM11 13 22 2"/>',
  attach:'<path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.5 5.5L9 17a2 2 0 0 1-3-3l9-9"/>',
  leaf:'<path d="M20 3C7 2 2 9 6 15c6 7 15 1 14-12ZM4 21 16 8"/>',
  headphones:'<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="2" y="12" width="5" height="9" rx="2"/><rect x="17" y="12" width="5" height="9" rx="2"/>',
  network:'<rect x="8" y="2" width="8" height="6" rx="1"/><rect x="2" y="16" width="7" height="6" rx="1"/><rect x="15" y="16" width="7" height="6" rx="1"/><path d="M12 8v4M5.5 16v-4h13v4"/>'
};
function icon(name,size=18){return '<svg class="icon" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[name]||paths.spark)+'</svg>';}
function btn(text,kind='',symbol=''){return '<button class="btn '+kind+'" data-preview="'+text+'">'+(symbol?icon(symbol,15):'')+text+'</button>';}
function tag(text,kind='',symbol=''){return '<span class="tag '+kind+'">'+(symbol?icon(symbol,11):'')+text+'</span>';}
function mini(name,kind=''){return '<span class="mini-icon '+kind+'">'+icon(name)+'</span>';}
function toggle(on=true){return '<button class="toggle '+(on?'on':'')+'" aria-label="切换示例开关" aria-pressed="'+on+'"></button>';}
function input(text,extra=''){return '<div class="input">'+text+(extra?icon(extra,14):'')+'</div>';}
function field(label,body,full=false){return '<div class="'+(full?'field-full':'')+'"><span class="label">'+label+'</span>'+body+'</div>';}
function cardTitle(title,extra='',sub=''){return '<div class="card-title"><div><h2>'+title+'</h2>'+(sub?'<p>'+sub+'</p>':'')+'</div>'+extra+'</div>';}
function link(text){return '<button class="section-link" data-preview="'+text+'">'+text+icon('chevron',13)+'</button>';}
function heading(title,subtitle,action='',kicker=''){return '<div class="page-heading"><div>'+(kicker?'<div class="eyebrow">'+kicker+'</div>':'')+'<h1>'+title+'</h1><p>'+subtitle+'</p></div>'+action+'</div>';}
function tabs(labels,active=0){return '<div class="subnav">'+labels.map((x,i)=>'<button class="'+(i===active?'selected':'')+'" data-preview="'+x.replace(/<[^>]+>/g,'').replace(/"/g,'&quot;')+'">'+x+'</button>').join('')+'</div>';}
function waveform(){return '<div class="wave">'+[5,9,14,8,18,24,15,9,20,26,17,12,22,16,8,12,6].map(h=>'<i style="--h:'+h+'px"></i>').join('')+'</div>';}
const navItems=[['chat','chat','聊一会儿'],['assistant','spark','我的助手'],['memory','memory','偏好与记忆'],['health','health','我的健康'],['devices','device','设备与家居'],['settings','settings','设置']];
function sidebar(page){
  return '<aside class="sidebar"><div class="brand"><div class="brand-mark">d.</div><div><strong>豆梨</strong><small>你的日常陪伴</small></div></div><div class="nav-caption">我的空间</div><nav class="nav">'+navItems.map(([id,symbol,label])=>'<button data-page="'+id+'" class="'+(page===id?'active':'')+'">'+icon(symbol)+label+(id==='memory'&&page!=='memory'?'<span class="count">3</span>':'')+'</button>').join('')+'</nav>'+
  (page==='chat'?'<div class="history-list"><div class="history-title">最近的对话<button class="iconbtn" data-preview="搜索对话">'+icon('search',13)+'</button></div><div class="history-item current"><strong>把今天慢慢说完</strong><small>'+icon('device')+'音箱 · 今天 21:08</small></div><div class="history-item"><strong>关于周末的一点小计划</strong><small>'+icon('laptop')+'电脑 · 昨天</small></div><div class="history-item"><strong>最近想养成的小习惯</strong><small>'+icon('mic')+'电脑语音 · 10月14日</small></div><button class="new-chat" data-preview="新建对话">'+icon('plus',13)+'开始新的对话</button></div>':'<div class="sidebar-note">把日常留在这里。<br>想到什么，都可以慢慢说。</div>')+
  '<div class="sidebar-bottom"><div class="sidebar-status"><i class="dot"></i>本机服务已连接</div><div class="profile"><span class="profile-avatar">我</span><div><strong>我的个人空间</strong><small>资料保存在本机</small></div>'+icon('chevron',13)+'</div></div></aside>';
}
const pageContent={
chat:()=>[
  '<div class="chat-area"><section class="conversation"><div class="thread-heading"><div><h1>把今天慢慢说完</h1><p>'+icon('device',12)+'来自豆梨床头音箱<span>·</span>今天 21:08</p></div><div class="thread-actions">'+btn('自动选择','small-btn','spark')+'<button class="iconbtn" data-preview="对话选项">'+icon('more')+'</button></div></div>',
  '<div class="thread-scroll"><div class="date-divider">今天 · 21:08</div><div class="message"><div class="msg-avatar">d.</div><div class="message-body"><div class="msg-meta"><strong>豆梨</strong><span>21:08</span></div><div class="msg-text">我在。今天过得怎么样？<br>开心的、烦心的，或者只是一件小事，都可以聊聊。</div></div></div>',
  '<div class="message user"><div class="bubble">今天终于把拖了很久的事情做完了。<br>挺开心的，但突然又有点不知道接下来做什么。<div class="voice-meta">'+icon('mic',12)+'语音转文字 · 12 秒</div></div></div>',
  '<div class="message"><div class="msg-avatar">d.</div><div class="message-body"><div class="msg-meta"><strong>豆梨</strong><span>21:09</span></div><div class="msg-text">那种一直惦记着的事，终于能放下了。<br>先让自己享受一下这个轻松的晚上吧，不用马上给空出来的时间安排新任务。</div><div class="reply-callout">也许今晚只需要一首喜欢的歌，<br>或者散个步，把“终于做完了”的感觉多留一会儿。</div><div class="message-tools">'+icon('volume',14)+icon('copy',14)+icon('more',14)+'</div></div></div></div>',
  '<div class="composer"><div class="composer-placeholder">想说什么，写下来或直接开口…</div><div class="composer-bottom"><div class="composer-left">'+icon('attach')+icon('mic')+'</div><button class="send" data-preview="发送消息">发送'+icon('arrow',14)+'</button></div></div><div class="composer-foot"><span>Enter 发送 · Shift + Enter 换行</span><span class="flex gap6">'+icon('lock',10)+'本机保存</span></div></section>',
  '<aside class="voice-panel"><div class="voice-panel-heading"><span>陪伴，就在身边</span>'+icon('headphones',14)+'</div><div class="voice-hero"><div class="voice-orb">'+icon('mic',30)+'</div><h2>不用打字，聊一会儿</h2><p>准备好听你说了</p>'+waveform()+btn('开始电脑语音','white wide','mic')+'</div><div class="device-mini"><div class="flex">'+icon('device',17)+'<strong>豆梨床头音箱</strong><i class="dot"></i></div><p>等待唤醒 · 说「你好豆梨」</p></div><div class="linked-memory"><div class="between"><h3>豆梨记得</h3>'+icon('memory',13)+'</div><li>你喜欢先聊聊感受，再讨论办法。<small>已确认的交流偏好</small></li><li>忙完以后，想留一些时间给自己。<small>来自最近的对话</small></li>'+link('查看所有记忆')+'</div><div class="privacy-note">'+icon('shield',12)+'你可以随时删除对话和记忆</div></aside></div>'
].join(''),
assistant:()=>[
  '<div class="content">'+heading('让豆梨，按你喜欢的方式陪伴','名字、语气和相处的分寸，都可以由你决定。',btn('保存偏好','primary','check')),
  '<div class="assistant-grid"><div class="stack"><section class="card">'+cardTitle('认识你的助手',tag('随时可以调整','outline')),
  '<div class="persona-banner"><div class="persona-avatar">d.<span class="edit-dot">'+icon('edit',10)+'</span></div><div><h2>豆梨</h2><p>温柔一点，坦诚一点，也保留一点幽默。</p></div></div>',
  '<div class="form-grid">'+field('助手名字',input('豆梨'))+field('回应你的第一句话',input('我在，慢慢说。'))+
  field('你喜欢的说话方式','<div class="chips"><button class="chip selected">自然温柔</button><button class="chip">简洁直接</button><button class="chip">轻松有趣</button><button class="chip">'+icon('plus',12)+'自定义</button></div>',true)+
  field('性格与相处方式','<div class="input textarea">认真听我说话，温暖、坦诚、有分寸。<br>可以表达不同看法，不需要一味附和。</div>',true)+
  field('回复长度','<div class="segmented"><button class="selected">简短</button><button>适中</button><button>详细</button></div>')+
  field('幽默程度 · 30%','<div class="range" style="--value:30%"><span></span></div><div class="between tiny muted"><span>认真一点</span><span>活泼一点</span></div>')+
  field('不喜欢的表达习惯',input('不要每次都反问，也不用反复安慰。'),true)+'</div></section>',
  '<section class="card"><div class="between"><div class="flex">'+mini('mic')+'<div><h3>听到你，就回应</h3><p class="small muted">音箱收到唤醒后，使用你设定的开场白。</p></div></div>'+link('唤醒设置')+'</div><div class="wake-row between"><span class="small muted">当前音箱唤醒词</span><strong class="quote">“你好豆梨”</strong></div></section></div>',
  '<aside class="stack"><section class="card">'+cardTitle('听起来，会是这样',tag('语气预览','green'))+'<p class="side-note">调整左侧偏好，让每次对话更合拍。</p><div class="preview-conversation"><div class="preview-user">今天有点累，但也没发生什么特别的事。</div><div class="preview-answer"><div class="msg-avatar">d.</div>有时候，平平常常的一天也会把人累着。今晚先松一口气吧，不用急着打起精神。</div></div><div class="preview-controls"><span>自然温柔 · 简短回应</span><button class="iconbtn" data-preview="试听语气">'+icon('volume',17)+'</button></div></section>',
  '<section class="card night-card"><div class="between"><div class="flex">'+mini('moon')+'<h3>睡前，轻一点</h3></div>'+toggle()+'</div><p class="mt12">到了晚上，声音更轻，回复更短。</p><div class="night-times"><strong>22:00</strong><span>—</span><strong>07:00</strong></div><div class="between mt20 small muted"><span>夜间音量</span><span>45%</span></div><div class="range" style="--value:45%"><span></span></div></section><div class="checkline">'+icon('checkcircle',14)+'保存后，从下一轮对话开始生效</div></aside></div></div>'
].join(''),
memory:()=>[
  '<div class="content">'+heading('那些重要的小事，豆梨记得','记忆由你确认，也随时听你修正。',btn('添加记忆','primary','plus')),
  '<div class="memory-overview"><div class="stat-card featured"><div><div class="stat-number">24 <span class="small">条</span></div><p>已确认的记忆</p></div>'+mini('memory')+'</div><div class="stat-card warm"><div><div class="stat-number">03 <span class="small">条</span></div><p>等待你的确认</p></div>'+mini('clock','amber')+'</div><div class="stat-card"><div><div class="stat-number">08 <span class="small">段</span></div><p>最近一起聊过的经历</p></div>'+mini('book')+'</div></div>',
  '<div class="memory-layout"><div><div class="memory-tools"><div class="searchbox">'+icon('search',15)+'找一段记忆，也可以换一种说法…</div>'+btn('筛选','small-btn','sliders')+'</div><div class="filter-pills"><button class="selected">全部记忆</button><button>生活习惯</button><button>交流偏好</button><button>重要的事</button><button>历史版本</button></div><section class="card">',
  '<article class="memory-item"><div class="between"><div class="flex">'+mini('leaf')+'<h3>关于吃饭的小偏好</h3></div><div class="flex gap8">'+tag('已确认','green')+icon('pin',13)+'</div></div><p class="memory-text">不喜欢香菜，点餐时记得帮我留意。</p><div class="between"><span class="memory-source">'+icon('device',11)+'来自音箱对话 · 10月15日</span>'+link('查看原话')+'</div></article>',
  '<article class="memory-item"><div class="between"><div class="flex">'+mini('chat')+'<h3>我喜欢的交流方式</h3></div><div class="flex gap8">'+tag('已确认','green')+icon('pin',13)+'</div></div><p class="memory-text">先听我把话说完，不需要马上给建议。</p><div class="between"><span class="memory-source">'+icon('edit',11)+'由你手动设置 · 交流偏好</span>'+link('修改偏好')+'</div></article>',
  '<article class="memory-item"><div class="between"><div class="flex">'+mini('sun','amber')+'<h3>周末想做的事</h3></div>'+tag('已确认','green')+'</div><p class="memory-text">想多去户外走走，不把休息日安排得太满。</p><div class="between"><span class="memory-source">'+icon('laptop',11)+'来自电脑对话 · 10月14日</span>'+link('查看原话')+'</div></article>',
  '<article class="memory-item"><div class="between"><div class="flex">'+mini('headphones','lavender')+'<h3>工作时的小习惯</h3></div>'+tag('已确认','green')+'</div><p class="memory-text">专注做事时，喜欢听没有人声的轻音乐。</p><div class="between"><span class="memory-source">'+icon('mic',11)+'来自电脑语音 · 10月12日</span>'+link('查看原话')+'</div></article></section><div class="between mt16 tiny muted"><span>已整理 · 关键词与语义检索可用</span>'+link('整理记忆')+'</div></div>',
  '<aside class="stack"><section class="card amber">'+cardTitle('这几件事，想和你确认',tag('3','amber'))+'<div class="pending-item"><strong>你最近开始尝试晨跑</strong><p>“这两天早上出门跑了一小会儿。”<br>来自昨天的对话</p><div class="flex gap8">'+btn('确认记住','small-btn','check')+btn('暂不保存','small-btn ghost')+'</div></div><div class="pending-item"><strong>希望晚上少一些提醒</strong><p>这是一条推测，确认前不会用作你的偏好。</p><div class="flex gap8">'+btn('确认记住','small-btn','check')+btn('修改','small-btn ghost')+'</div></div></section>',
  '<section class="card">'+cardTitle('最近一起聊过',icon('clock',15))+'<div class="timeline"><div class="timeline-row"><small>今天 · 21:08</small><p>完成了一件惦记很久的事，<br>想给自己一个轻松的晚上。</p></div><div class="timeline-row"><small>昨天 · 19:42</small><p>聊到周末的小计划，<br>还有想慢慢养成的习惯。</p></div></div><div class="mt20">'+link('查看近期经历')+'</div></section></aside></div></div>'
].join(''),
health:()=>[
  '<div class="content">'+heading('把健康问题，放进完整的上下文','整理报告、记录变化，让每次提问都有据可查。',btn('上传报告','primary','plus'))+tabs(['健康问答','检查报告','健康档案','医学资料']),
  '<div class="health-layout"><div class="stack"><div class="health-intro"><div><h2>从一份报告，<br>或一个想问的问题开始。</h2><p>你确认过的资料，会让讨论更有上下文。</p></div><div class="health-mark">'+icon('health',35)+'</div></div>',
  '<section class="card">'+cardTitle('今天想了解什么？',tag('结合已确认资料','green'))+'<div class="health-question"><span class="small muted">例如：帮我整理这次体检中需要进一步了解的项目。</span><div class="prompt">补充症状、持续时间，或选择一份检查报告…</div><div class="report-chip">'+icon('file',12)+'年度体检报告 · 已核对'+icon('x',11)+'</div><div class="between"><button class="section-link" data-preview="选择报告">'+icon('attach',14)+'添加报告或资料</button>'+btn('开始提问','primary','arrow')+'</div></div>',
  '<div class="topic-grid"><div class="topic">'+icon('file',20)+'<div><strong>看懂检查报告</strong><small>先核对原件，再讨论项目</small></div></div><div class="topic">'+icon('book',20)+'<div><strong>核对用药信息</strong><small>完整药名、剂量与说明书</small></div></div><div class="topic">'+icon('chat',20)+'<div><strong>整理症状描述</strong><small>把变化说清楚</small></div></div><div class="topic">'+icon('clock',20)+'<div><strong>回顾健康记录</strong><small>按时间查看已确认资料</small></div></div>',
  '<div class="health-disclaimer">'+icon('shield',13)+'用于整理信息和辅助理解，不能代替医生诊断。</div></section><div class="between small muted"><span>过去的健康问答</span>'+link('查看全部')+'</div></div>',
  '<aside class="stack"><section class="card">'+cardTitle('最近的检查报告',link('全部'))+'<div class="report-row">'+mini('file')+'<div class="grow"><strong>年度体检报告</strong><p>10月12日 · PDF · 6 页</p>'+tag('已核对','green','check')+'</div></div><div class="report-row">'+mini('file','amber')+'<div class="grow"><strong>血常规检查</strong><p>10月08日 · 图片 · 1 页</p>'+tag('等待核对','amber','clock')+'</div></div></section>',
  '<section class="card">'+cardTitle('我的健康档案',link('管理'))+'<div class="health-record"><span>病史与健康背景</span><strong>2 条记录</strong></div><div class="health-record"><span>用药记录</span><strong>1 条记录</strong></div><div class="health-record"><span>过敏信息</span><strong>待补充</strong></div><p class="side-note mt16">只使用你明确确认的信息，<br>有变化时可以随时更新。</p></section>',
  '<div class="privacy-card">'+icon('lock',19)+'<div><strong>隐私，由你掌握</strong><p>档案和报告保存在本机。<br>你可以查看、管理和删除这些资料。</p></div></div></aside></div></div>'
].join(''),
devices:()=>[
  '<div class="content">'+heading('把陪伴，放到你身边','管理音箱和家居，让每个连接都有清楚的状态。',btn('添加设备','primary','plus'))+tabs(['我的设备 <span class="counter">1</span>','家居动作','传感器','自动化']),
  '<div class="devices-layout"><div><section class="device-feature"><div class="between"><span class="tag green"><i class="dot"></i>在线 · 等待唤醒</span><button class="iconbtn" data-preview="设备选项">'+icon('more',18)+'</button></div><h2 class="mt20">豆梨床头音箱</h2><p class="device-description">一句「你好豆梨」，就能开始聊。</p><div class="feature-meta"><div>所在位置<strong>卧室</strong></div><div>设备类型<strong>ESP32</strong></div><div>固件版本<strong>2.5.2</strong></div></div><div class="device-picture"><div class="speaker-shadow"></div><div class="speaker-top"></div><div class="speaker-body"><div class="speaker-led"></div><div class="speaker-grill"></div></div></div><div class="bottom-controls"><div class="volume-control">'+icon('volume',16)+'<div class="range" style="--value:65%"><span></span></div><span>65%</span></div>'+btn('设备设置','small-btn','sliders')+'</div></section>',
  '<div class="device-settings"><section class="card"><div class="between"><div class="flex">'+mini('mic')+'<h3>语音唤醒</h3></div>'+tag('已配置','green')+'</div><p class="mt12">当前唤醒词</p><strong class="small">你好豆梨</strong></section><section class="card"><div class="between"><div class="flex">'+mini('moon','lavender')+'<h3>夜间陪伴</h3></div>'+toggle()+'</div><p class="mt12">22:00 — 07:00</p><strong class="small">轻声回应，降低播放音量</strong></section></div>',
  '<section class="scene-section"><div class="between"><h2>日常里的小帮手</h2>'+link('管理家居动作')+'</div><div class="scenes"><div class="scene disabled">'+mini('moon','lavender')+'<div class="grow"><strong>睡前时刻</strong><small>连接家居后配置</small></div>'+icon('plus',15)+'</div><div class="scene disabled">'+mini('sun','amber')+'<div class="grow"><strong>早安，新的一天</strong><small>添加你想执行的动作</small></div>'+icon('plus',15)+'</div></div></section><div class="card mt20 between"><div class="flex">'+icon('clock',17)+'<div><h3>最近的设备活动</h3><p class="small muted">今天 21:09 · 语音对话已结束，回到待机</p></div></div>'+link('查看记录')+'</div></div>',
  '<aside class="stack"><section class="card">'+cardTitle('连接一位新伙伴',icon('plus',17))+'<p class="side-note">音箱和电脑连接同一 Wi-Fi，<br>然后完成下面三个步骤。</p><div class="pairing-steps"><div class="pairing-step"><span class="step-number">1</span><div><strong>在豆梨开启配对</strong><p>配对窗口会持续 5 分钟。</p></div></div><div class="pairing-step"><span class="step-number">2</span><div><strong>让设备连接本机服务</strong><p>使用设备设置中的服务地址。</p></div></div><div class="pairing-step"><span class="step-number">3</span><div><strong>确认这是你的设备</strong><p>核对设备信息后允许连接。</p></div></div></div>'+btn('开启配对','primary wide','plus')+'</section>',
  '<section class="card soft-card">'+cardTitle('连接状态',tag('正常','green'))+'<div class="connection-diagram"><div class="node">'+mini('laptop')+'电脑</div><span class="connector"></span><div class="node">'+mini('wifi')+'局域网</div><span class="connector"></span><div class="node">'+mini('device')+'音箱</div></div><div class="status-list"><div class="between"><span>本机服务</span><span class="flex gap6"><i class="dot"></i>运行中</span></div><div class="between"><span>已连接设备</span><span>1 台</span></div><div class="between"><span>待确认设备</span><span>0 台</span></div></div></section></aside></div></div>'
].join(''),
settings:()=>[
  '<div class="content">'+heading('把一切，调到刚刚好','先连好声音和模型，其余设置慢慢调整。','<div class="flex gap8">'+btn('撤销更改','ghost')+btn('保存更改','primary','check')+'</div>'),
  '<div class="settings-layout"><aside class="settings-nav"><button class="selected" data-preview="模型与服务">'+icon('spark',15)+'模型与服务</button><button data-preview="语音输入">'+icon('mic',15)+'语音输入</button><button data-preview="个人词典">'+icon('book',15)+'个人词典</button><div class="section-caption">资料与设备</div><button data-preview="隐私与数据">'+icon('shield',15)+'隐私与数据</button><button data-preview="手机同步">'+icon('refresh',15)+'手机同步</button><div class="section-caption">桌面应用</div><button data-preview="桌面偏好">'+icon('laptop',15)+'桌面偏好</button><button data-preview="运行记录">'+icon('clock',15)+'运行记录</button></aside>',
  '<div class="settings-main"><div class="connection-strip"><div class="connection-tile"><div class="tile-title">'+icon('chat',14)+'日常对话'+icon('more',13)+'</div><strong>日常陪伴模型</strong>'+tag('已连接','green','check')+'</div><div class="connection-tile"><div class="tile-title">'+icon('mic',14)+'语音识别'+icon('more',13)+'</div><strong>把声音变成文字</strong>'+tag('已连接','green','check')+'</div><div class="connection-tile"><div class="tile-title">'+icon('volume',14)+'语音合成'+icon('more',13)+'</div><strong>让豆梨开口说话</strong>'+tag('已连接','green','check')+'</div></div>',
  '<div class="model-layout"><section class="card model-form">'+cardTitle('模型连接',btn('添加配置','small-btn ghost','plus'))+'<div class="filter-pills"><button class="selected">日常模型</button><button>强模型</button><button>分类模型</button><button>更多</button></div><div class="form-grid">'+
  field('服务提供方',input('自定义兼容服务','down'),true)+field('服务地址',input('<span class="placeholder">https://api.example.com/v1</span>'),true)+
  field('API Key',input('••••••••••••••••••••','lock'),true)+field('模型',input('选择已配置的模型','down'))+field('思考模式','<div class="input"><span>关闭</span>'+toggle(false)+'</div>')+
  '</div><div class="form-actions"><div class="connection-state">'+icon('checkcircle',13)+'连接已验证</div>'+btn('测试连接','small-btn','refresh')+'</div></section>',
  '<aside class="routing-card"><div class="between"><h2>让豆梨自己选</h2>'+toggle()+'</div><p>日常聊天轻快回应，<br>需要认真思考时调用强模型。</p><div class="route-flow"><div class="route-item">'+icon('chat',14)+'你提出的问题</div><div class="route-arrow">'+icon('down',13)+'</div><div class="route-item">'+icon('spark',14)+'判断问题与上下文</div><div class="route-arrow">'+icon('down',13)+'</div><div class="route-end"><div class="route-item">日常模型</div><div class="route-item">强模型</div></div></div><div class="checkline">'+icon('shield',13)+'优先保证回答质量</div><div class="mt24">'+link('路由高级设置')+'</div></aside></div>',
  '<div class="settings-bottom"><section class="card"><div class="between"><div class="flex">'+mini('shield')+'<div><h3>隐私与数据</h3><p>对话在本机，录音默认不保存。</p></div></div>'+icon('chevron',15)+'</div></section><section class="card"><div class="between"><div class="flex">'+mini('phone')+'<div><h3>在手机上继续聊</h3><p>连接手机，同步你的对话与记忆。</p></div></div>'+icon('chevron',15)+'</div></section></div><div class="between tiny muted"><span>密钥在页面中隐藏显示，请妥善保管你的 API Key。</span><span>更改保存后生效</span></div></div></div></div>'
].join('')
};
function render(){
  const page=location.hash.slice(1) in pageContent?location.hash.slice(1):'chat';
  const label=navItems.find(x=>x[0]===page)[2];
  document.title='豆梨 · '+label+' · 设计稿';
  document.getElementById('design').innerHTML='<div class="desktop" data-page="'+page+'"><div class="titlebar"><strong>豆梨</strong><span class="titlebar-note">DESIGN 02 · 设计预览 · 所有内容均为示例数据</span><div class="window-actions"><span>'+icon('minimize',11)+'</span><span>'+icon('maximize',11)+'</span><span>'+icon('x',11)+'</span></div></div><div class="workspace">'+sidebar(page)+'<main class="main"><header class="topline"><div class="crumb">我的空间'+icon('chevron',11)+'<strong>'+label+'</strong></div><div class="top-tools"><span class="local">'+icon('lock',11)+'本机空间</span><button class="iconbtn" data-preview="搜索">'+icon('search',16)+'</button><button class="iconbtn" data-preview="更多选项">'+icon('more',17)+'</button></div></header>'+pageContent[page]()+'</main></div></div>';
  document.querySelectorAll('[data-page]').forEach(el=>{if(el.tagName==='BUTTON')el.onclick=()=>location.hash=el.dataset.page;});
  document.querySelectorAll('.toggle').forEach(el=>el.onclick=()=>{el.classList.toggle('on');el.setAttribute('aria-pressed',el.classList.contains('on'));});
  document.querySelectorAll('.chips .chip,.segmented button,.filter-pills button').forEach(el=>el.onclick=()=>{el.parentNode.querySelectorAll('.selected').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');});
  document.querySelectorAll('[data-preview]').forEach(el=>el.onclick=()=>toast('「'+el.dataset.preview+'」交互入口示意 · 当前为设计预览'));
}
let toastTimer;
function toast(value){const el=document.getElementById('preview-toast');el.textContent=value;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2400);}
addEventListener('hashchange',render);
addEventListener('keydown',event=>{if(/^[1-6]$/.test(event.key))location.hash=navItems[Number(event.key)-1][0];});
render();
