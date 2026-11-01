'use strict';
// "הכסף שלי" — Service Worker: מציג התראות פוש גם כשהאתר סגור. לא שומר שום דבר במטמון.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'הכסף שלי', {
    body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag, lang: 'he', dir: 'rtl'
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if ('focus' in w) return w.focus();
    return self.clients.openWindow('./');
  })());
});
