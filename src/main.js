import { App } from './core/App.js';

/**
 * Entry point.
 *
 * The app is exposed on `window.game` deliberately: the screenshot harness and
 * the critic agents drive the game from the page (place the player, arm a
 * spell, freeze the clock, capture the frame) rather than by faking input
 * events, and that needs a handle.
 */
const canvas = document.getElementById('scene');
const app = new App(canvas);

window.game = app;

app.load().catch((error) => {
  console.error('[main] failed to start', error);
  const label = document.getElementById('loadingLabel');
  if (label) {
    label.textContent = `Failed: ${error?.message ?? error}`;
    label.style.color = '#ff6a5c';
  }
  // Re-thrown on the next tick so the harness sees a real page error rather
  // than a silently dead canvas.
  setTimeout(() => {
    window.__gameError = String(error?.stack ?? error);
  }, 0);
});
