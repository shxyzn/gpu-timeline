const panel = document.getElementById('release-video');

if (panel) {
  // Start each visit folded, including browsers with an older saved open state.
  panel.open = false;

  panel.addEventListener('toggle', () => {
    if (!panel.open) panel.querySelector('video')?.pause();
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
