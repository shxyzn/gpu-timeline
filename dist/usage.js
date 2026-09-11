const guide = document.getElementById('usage');
const feedback = document.getElementById('usage-feedback');
const resets = new WeakMap();

guide?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy-target]');
  if (!button || !guide.contains(button)) return;
  const target = document.getElementById(button.dataset.copyTarget);
  if (!target) return;
  clearTimeout(resets.get(button));
  try {
    await navigator.clipboard.writeText(target.textContent.trim());
    button.textContent = '복사됨';
    button.classList.add('is-copied');
    feedback.textContent = button.dataset.copyTarget === 'usage-agent-prompt'
      ? '요청문을 복사했어요. 서버에 연결된 Agent에게 붙여넣으세요.'
      : '명령을 복사했어요. GPU 서버의 SSH 터미널에 붙여넣으세요.';
    feedback.classList.remove('is-error');
  } catch {
    button.textContent = '복사 실패';
    button.classList.remove('is-copied');
    feedback.textContent = '클립보드에 접근할 수 없어요. 내용을 직접 선택해서 복사해 주세요.';
    feedback.classList.add('is-error');
  }
  resets.set(button, setTimeout(() => {
    button.textContent = button.dataset.copyLabel || '복사';
    button.classList.remove('is-copied');
  }, 2200));
});
