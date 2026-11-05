const root = document.documentElement;
const motionButton = document.querySelector('.motion-toggle');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let userPaused = false;
function updateMotion() {
  const paused = userPaused || reducedMotion.matches;
  root.classList.toggle('motion-paused', paused);
  motionButton.setAttribute('aria-pressed', String(paused));
  motionButton.textContent = reducedMotion.matches ? '已减少动效' : paused ? '开启动效 ▷' : '暂停动效 Ⅱ';
  motionButton.disabled = reducedMotion.matches;
}
motionButton.addEventListener('click', () => { userPaused = !userPaused; updateMotion(); });
reducedMotion.addEventListener('change', updateMotion);
updateMotion();

const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
function closeMenu() {
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', '打开导航');
  navigation.classList.remove('open');
}
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
  navigation.classList.toggle('open', open);
});
navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigation.classList.contains('open')) { closeMenu(); menuButton.focus(); }
});
matchMedia('(min-width: 761px)').addEventListener('change', closeMenu);

const scenarios = {
  daily: { user: '今天下班，绕远路去公园走了一会儿。', reply: '把回家的路走慢一点，也挺好。\n今天的风怎么样？', note: '生活记录 · 一次公园散步', status: '这一刻，慢慢聊。' },
  remember: { user: '豆梨，记住，我不吃香菜。', reply: '好，要把「不吃香菜」记为你的饮食偏好吗？\n你确认后，我再记下来。', note: '记忆建议 · 等你确认', status: '了解你，也尊重你的决定。' },
  pause: { user: '先停一下，我还没说完。', reply: '好，我在听。', note: '打断当前回复 · 继续听你说', status: '对话的节奏，由你决定。' },
};
document.querySelectorAll('.scenario').forEach(button => button.addEventListener('click', () => {
  const item = scenarios[button.dataset.scenario];
  document.querySelectorAll('.scenario').forEach(other => {
    other.classList.toggle('active', other === button);
    other.setAttribute('aria-pressed', String(other === button));
  });
  document.querySelector('#demo-user').textContent = item.user;
  document.querySelector('#demo-reply').textContent = item.reply;
  document.querySelector('#demo-note span:last-child').textContent = item.note;
  document.querySelector('#demo-status').textContent = item.status;
}));

const sourceButton = document.querySelector('.source-toggle');
sourceButton.addEventListener('click', () => {
  const open = sourceButton.getAttribute('aria-expanded') !== 'true';
  sourceButton.setAttribute('aria-expanded', String(open));
  sourceButton.innerHTML = open ? '收起原话来源 <span aria-hidden="true">↙</span>' : '展开原话来源 <span aria-hidden="true">↗</span>';
  document.querySelector('#source-detail').hidden = !open;
});

document.querySelector('.copy-code').addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(document.querySelector('#install-code').textContent.trim());
    status.textContent = '已复制。在终端中逐行运行，完成后按指南配置模型。';
  } catch {
    status.textContent = '浏览器未允许复制，请手动选择上方命令复制。';
  }
});

// Content is visible without JavaScript; entrance motion never gates reading.
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.classList.add('in-view'); observer.unobserve(entry.target);
    }
  }, { threshold: .12 });
  document.querySelectorAll('.section-heading, .experience-layout, .memory-paper, .system-diagram, .start-layout').forEach(element => observer.observe(element));
}
