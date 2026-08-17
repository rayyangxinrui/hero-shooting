/**
 * Keyboard + pointer-lock mouse input.
 *
 * State is polled (`input.forward`), events are emitted (`fire`, `reload`).
 * That split is deliberate: movement wants "is it held this frame", weapons
 * want "was it pressed on this exact frame", and conflating the two is how you
 * end up with a semi-auto pistol that fires twice on one click.
 */
export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.locked = false;

    this.keys = new Set();
    this.forward = 0;
    this.strafe = 0;
    this.jump = false;
    this.crouch = false;
    this.sprint = false;
    this.walk = false;
    this.firing = false;
    this.aiming = false;

    this.mouseDX = 0;
    this.mouseDY = 0;

    this._events = new Map();
    this._pressedThisFrame = new Set();

    this._bind();
  }

  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(handler);
    return this;
  }

  _emit(event, ...args) {
    const list = this._events.get(event);
    if (list) for (const handler of list) handler(...args);
  }

  _bind() {
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('wheel', this._onWheel, { passive: true });
    this.canvas.addEventListener('click', this._onCanvasClick);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('contextmenu', this._onContextMenu);
  }

  _onContextMenu = (event) => {
    if (this.locked) event.preventDefault();
  };

  _onCanvasClick = () => {
    if (!this.locked) this.canvas.requestPointerLock?.();
  };

  _onLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    this._emit('lock', this.locked);
    if (!this.locked) {
      this.keys.clear();
      this.firing = false;
      this.aiming = false;
      this._syncAxes();
    }
  };

  _onMouseMove = (event) => {
    if (!this.locked) return;
    this.mouseDX += event.movementX || 0;
    this.mouseDY += event.movementY || 0;
  };

  _onMouseDown = (event) => {
    if (!this.locked) return;
    event.preventDefault();
    if (event.button === 0) {
      this.firing = true;
      this._emit('fire:start');
    } else if (event.button === 2) {
      this.aiming = true;
      this._emit('aim', true);
    } else if (event.button === 1) {
      this._emit('cast');
    }
  };

  _onMouseUp = (event) => {
    if (event.button === 0) {
      this.firing = false;
      this._emit('fire:stop');
    } else if (event.button === 2) {
      this.aiming = false;
      this._emit('aim', false);
    }
  };

  _onWheel = (event) => {
    if (!this.locked) return;
    this._emit('scroll', Math.sign(event.deltaY));
  };

  _onBlur = () => {
    this.keys.clear();
    this.firing = false;
    this.aiming = false;
    this._syncAxes();
  };

  _onKeyDown = (event) => {
    if (event.repeat) return;
    const code = event.code;
    this.keys.add(code);
    this._syncAxes();

    switch (code) {
      case 'KeyR':
        this._emit('reload');
        break;
      case 'Digit1':
        this._emit('weapon', 0);
        break;
      case 'Digit2':
        this._emit('weapon', 1);
        break;
      case 'Digit3':
        this._emit('weapon', 2);
        break;
      case 'KeyQ':
        this._emit('ability', 0);
        break;
      case 'KeyE':
        this._emit('ability', 1);
        break;
      case 'KeyF':
        this._emit('ability', 2);
        break;
      case 'KeyC':
        this._emit('ability', 3);
        break;
      case 'KeyV':
        this._emit('ability', 4);
        break;
      case 'KeyX':
        this._emit('ability', 5);
        break;
      case 'KeyH':
        this._emit('toggleHelp');
        break;
      case 'F1':
        event.preventDefault();
        this._emit('toggleEditor');
        break;
      case 'F2':
        event.preventDefault();
        this._emit('toggleStats');
        break;
      case 'KeyP':
        this._emit('togglePause');
        break;
      default:
        break;
    }
  };

  _onKeyUp = (event) => {
    this.keys.delete(event.code);
    this._syncAxes();
  };

  _syncAxes() {
    const k = this.keys;
    this.forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    this.strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    this.jump = k.has('Space');
    this.crouch = k.has('ControlLeft') || k.has('ControlRight');
    this.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    this.walk = k.has('AltLeft') || k.has('AltRight');
  }

  /** Consume the accumulated mouse delta. Call once per frame. */
  consumeMouse() {
    const dx = this.mouseDX;
    const dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  dispose() {
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('contextmenu', this._onContextMenu);
    this.canvas.removeEventListener('click', this._onCanvasClick);
    window.removeEventListener('blur', this._onBlur);
  }
}
