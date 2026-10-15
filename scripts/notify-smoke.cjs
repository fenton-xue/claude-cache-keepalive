// 只弹一条与应用同样样式的通知，用来确认 macOS 通知权限：npx electron scripts/notify-smoke.cjs
const { app, Notification } = require('electron');
app.setName('Keepwarm');
app.whenReady().then(() => {
  console.log('supported:', Notification.isSupported());
  const n = new Notification({ title: '缓存保活：发送失败', body: '「测试A」已挂起（held）：这是一条通知测试，不是真实失败。' });
  n.on('show', () => console.log('shown'));
  n.on('failed', (_e, err) => console.log('failed', err));
  n.show();
  setTimeout(() => app.quit(), 6000);
});
