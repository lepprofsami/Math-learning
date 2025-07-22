const CACHE_NAME = 'math-learning-cache-v1';
const urlsToCache = [
  '/',
  '/login',
  '/register',
  '/css/style.css',
  '/images/icons/icon-192x192.png',
  '/images/icons/icon-512x512.png'
  // Ajoutez ici toutes les autres ressources statiques que vous voulez mettre en cache
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache ouvert');
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  // *** NOUVELLE LIGNE AJOUTÉE ICI ***
  // Ignorer les requêtes Socket.IO pour éviter les interférences
  if (event.request.url.includes('/socket.io/')) {
    return fetch(event.request); // Laisse le réseau gérer la requête Socket.IO directement
  }
  // *** FIN DE LA NOUVELLE LIGNE ***

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        // If not in cache, fetch from network
        return fetch(event.request);
      })
  );
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            // Supprimer les vieux caches
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
