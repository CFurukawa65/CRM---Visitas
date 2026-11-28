/* sw.js — deixa o app abrir sem sinal (guarda os arquivos do app no aparelho).
 * A cada mudança no app, troque a VERSAO abaixo: é isso que faz o celular baixar os arquivos novos. */
const VERSAO = 'crm-copasul-1.3.0';
const ARQUIVOS = ['./', './index.html', './style.css', './logic.js', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // envio ao Apps Script nunca passa pelo cache
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const rede = fetch(req).then((resp) => {
        if (resp && resp.ok) { const copia = resp.clone(); caches.open(VERSAO).then((c) => c.put(req, copia)); }
        return resp;
      }).catch(() => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return hit || rede; // abre do cache na hora; atualiza em segundo plano
    })
  );
});
