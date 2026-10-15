const panel = document.getElementById('release-video');

if (panel) {
  const storageKey = 'cvml-release-video-v1.1.7-open';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) panel.open = saved === 'true';
  } catch { /* The native disclosure also works when storage is unavailable. */ }

  panel.addEventListener('toggle', () => {
    if (!panel.open) panel.querySelector('video')?.pause();
    try { localStorage.setItem(storageKey, String(panel.open)); } catch {}
  });

  const reveal = () => { panel.open = true; };
  document.querySelectorAll('a[href="#release-video"]').forEach(link => {
    link.addEventListener('click', reveal);
  });
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#release-video') reveal();
  });
  if (window.location.hash === '#release-video') reveal();
}
