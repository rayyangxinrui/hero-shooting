import { settings, ELEMENTS, ELEMENT_META } from '../config/settings.js';

/**
 * The HUD.
 *
 * DOM rather than canvas: text at native resolution, no font atlas, and the
 * crosshair stays pixel-sharp at any DPI — which matters, because a soft
 * crosshair is the fastest way to make a shooter feel imprecise.
 *
 * Three rules run through the whole file:
 *
 *  1. **The crosshair tells the truth.** Its gap is the weapon's real spread
 *     angle projected onto the screen at the live fov. It is also snapped to
 *     whole pixels, because a bar at x.5 is drawn across two columns at half
 *     intensity and reads as blurry no matter how bright it is.
 *  2. **Everything is outlined.** A 1 px black ring on the crosshair, an
 *     outline on the ammo. Without it the HUD disappears against a bright wall,
 *     which is the single most common failure of a hobby shooter HUD.
 *  3. **Restraint.** Anything not telling the player something urgent is dim,
 *     small, or absent. The frame is the game; the HUD is a margin note.
 */

/* --- crosshair geometry, in CSS pixels at 1080p --- */
const CH = {
  thickness: 2,
  length: 7,
  lengthAds: 0,
  gapMin: 3,
  gapMax: 96,
  dot: 0
};

/** Tiny inline glyphs, one per ability. Valorant's bar reads by shape. */
const ABILITY_ICONS = {
  thunder: '<path d="M13.6 2 5 13.2h5.2L9.4 22 18 10.4h-5.2z"/>',
  ice:
    '<path d="M12 1.6v20.8M3 6.8l18 10.4M21 6.8 3 17.2"/>' +
    '<path d="M12 5.6 9.6 3.2M12 5.6l2.4-2.4M12 18.4l-2.4 2.4M12 18.4l2.4 2.4"/>',
  meteor:
    '<path d="M20.5 3.5 13 11"/><circle cx="9.6" cy="14.4" r="4.2"/>' +
    '<path d="M17.4 3.2 12.6 8M21 7l-4.8 4.8"/>',
  beam: '<path d="M3.2 12h17.6"/><path d="M7 8.4 3.2 12 7 15.6M14 6.6 20.8 12 14 17.4"/>',
  snare:
    '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="3.4"/>' +
    '<path d="M12 3.4v5.2M12 15.4v5.2M3.4 12h5.2M15.4 12h5.2"/>',
  glacier: '<path d="M3 20.4 7.4 9l3.1 5.4L12 4.2l1.5 10.2L16.6 9l4.4 11.4z"/>'
};

export class HUD {
  constructor(root) {
    this.root = root;
    this.visible = true;
    this._statsOn = false;
    this._toastTimer = 0;
    this._damagePulse = 0;
    this._fpsAccumulator = 0;
    this._fpsFrames = 0;
    this._fps = 0;

    /* Cached last-written values: the HUD runs every frame, and writing a DOM
       string that has not changed still costs a style recalc. */
    this._cache = {};
    this._reloadStart = 0;
    this._reloadDuration = 0;
    this._reloadWasOn = false;
    this._lastMag = 0;

    root.innerHTML = `
      <svg class="hud-defs" aria-hidden="true"><defs>
        ${ELEMENTS.map(
          (id) =>
            `<symbol id="ab-${id}" viewBox="0 0 24 24">${ABILITY_ICONS[id] ?? ''}</symbol>`
        ).join('')}
      </defs></svg>

      <div class="hud-crosshair" id="crosshair">
        <span class="ch ch-t"></span>
        <span class="ch ch-b"></span>
        <span class="ch ch-l"></span>
        <span class="ch ch-r"></span>
        <span class="ch-dot" id="chDot"></span>
      </div>

      <div class="hud-hitmarker" id="hitmarker">
        <span></span><span></span><span></span><span></span>
      </div>
      <div class="hud-damage" id="damageVignette"></div>

      <div class="hud-bottom-left">
        <div class="hud-vital hud-vital-hp">
          <svg class="hud-vital-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20.4S3.6 15 3.6 9.3A4.5 4.5 0 0 1 12 6.9a4.5 4.5 0 0 1 8.4 2.4c0 5.7-8.4 11.1-8.4 11.1z"/>
          </svg>
          <span class="hud-vital-value" id="healthValue">100</span>
          <div class="hud-bar"><i id="healthBar"></i></div>
        </div>
        <div class="hud-vital hud-vital-mp">
          <svg class="hud-vital-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.4 19.2 12 12 21.6 4.8 12z"/>
          </svg>
          <span class="hud-vital-value" id="manaValue">100</span>
          <div class="hud-bar hud-bar-mana"><i id="manaBar"></i></div>
        </div>
      </div>

      <div class="hud-bottom-right">
        <div class="hud-weapon" id="weaponName">VK-74</div>
        <div class="hud-ammo">
          <span class="hud-ammo-mag" id="ammoMag">30</span>
          <span class="hud-ammo-stack">
            <span class="hud-ammo-sep"></span>
            <span class="hud-ammo-reserve" id="ammoReserve">90</span>
          </span>
        </div>
        <div class="hud-reload" id="reloadIndicator">
          <i id="reloadBar"></i>
        </div>
      </div>

      <div class="hud-abilities" id="abilityBar"></div>

      <div class="hud-top-right" id="stats"></div>
      <div class="hud-toast" id="toast"></div>

      <div class="hud-lock" id="lockPrompt">
        <div class="hud-lock-inner">
          <div class="hud-lock-rule"></div>
          <h1>HERO SHOOTING</h1>
          <p class="hud-lock-cta">Click to play</p>
          <div class="hud-lock-keys">
            <span><b>WASD</b> move</span><span><b>SHIFT</b> sprint</span>
            <span><b>CTRL</b> crouch</span><span><b>SPACE</b> jump</span>
            <span><b>LMB</b> fire</span><span><b>RMB</b> aim</span>
            <span><b>R</b> reload</span><span><b>1-3</b> weapon</span>
            <span><b>Q E R F V X</b> abilities</span><span><b>F2</b> stats</span>
          </div>
        </div>
      </div>
    `;

    this.crosshair = root.querySelector('#crosshair');
    this.bars = {
      t: root.querySelector('.ch-t'),
      b: root.querySelector('.ch-b'),
      l: root.querySelector('.ch-l'),
      r: root.querySelector('.ch-r')
    };
    this.chDot = root.querySelector('#chDot');
    this.hitmarker = root.querySelector('#hitmarker');
    this.damageVignette = root.querySelector('#damageVignette');
    this.healthBar = root.querySelector('#healthBar');
    this.healthValue = root.querySelector('#healthValue');
    this.manaBar = root.querySelector('#manaBar');
    this.manaValue = root.querySelector('#manaValue');
    this.weaponName = root.querySelector('#weaponName');
    this.ammoMag = root.querySelector('#ammoMag');
    this.ammoReserve = root.querySelector('#ammoReserve');
    this.reloadIndicator = root.querySelector('#reloadIndicator');
    this.reloadBar = root.querySelector('#reloadBar');
    this.abilityBar = root.querySelector('#abilityBar');
    this.stats = root.querySelector('#stats');
    this.toast = root.querySelector('#toast');
    this.lockPrompt = root.querySelector('#lockPrompt');

    this._buildAbilityBar();

    // The crosshair is positioned from JS so it always lands on a whole pixel.
    // `left: 50%` of an odd viewport width is a half pixel, and a half-pixel
    // crosshair is drawn across two columns at half intensity — the exact thing
    // that makes a home-made shooter feel imprecise.
    this._centre = () => {
      const x = Math.round(window.innerWidth * 0.5);
      const y = Math.round(window.innerHeight * 0.5);
      this.crosshair.style.left = `${x}px`;
      this.crosshair.style.top = `${y}px`;
      this.hitmarker.style.left = `${x}px`;
      this.hitmarker.style.top = `${y}px`;
    };
    this._centre();
    window.addEventListener('resize', this._centre);
  }

  _buildAbilityBar() {
    this.abilitySlots = new Map();
    for (const element of ELEMENTS) {
      const meta = ELEMENT_META[element] ?? { label: element, key: '?', accent: '#8ab' };
      const slot = document.createElement('div');
      slot.className = 'hud-ability';
      slot.style.setProperty('--accent', meta.accent);
      slot.innerHTML = `
        <div class="hud-ability-tile">
          <svg class="hud-ability-icon" viewBox="0 0 24 24" aria-hidden="true">
            <use href="#ab-${element}"></use>
          </svg>
          <i class="hud-ability-cd"></i>
          <span class="hud-ability-timer"></span>
        </div>
        <span class="hud-ability-key">${meta.key}</span>
      `;
      this.abilityBar.appendChild(slot);
      this.abilitySlots.set(element, {
        root: slot,
        cd: slot.querySelector('.hud-ability-cd'),
        timer: slot.querySelector('.hud-ability-timer'),
        lastTimer: '',
        ready: null
      });
    }
  }

  setLocked(locked) {
    this.lockPrompt.classList.toggle('hidden', locked);
  }

  showToast(message) {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    this._toastTimer = 1.6;
  }

  pulseDamage() {
    this._damagePulse = settings.combat.hitFlashTime;
  }

  toggleHelp() {
    this.root.classList.toggle('help-open');
  }

  toggleStats() {
    this._statsOn = !this._statsOn;
    this.stats.classList.toggle('visible', this._statsOn);
  }

  /** Write a property only when it actually changed. */
  _set(node, prop, value) {
    const key = node.id + prop;
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    if (prop === 'text') node.textContent = value;
    else node.style[prop] = value;
  }

  /**
   * @param {number} dt
   * @param {object} state
   */
  update(dt, state) {
    const aiming = state.aiming ?? 0;

    /* ------------------------------------------------------------------ */
    /* Crosshair — the gap *is* the spread                                  */
    /* ------------------------------------------------------------------ */
    // Spread is a half-angle; the gap is that angle projected onto the screen
    // at the live fov. Anything else is a lie about where rounds will go.
    //
    // `settings.player.fov` is authored horizontally, so it maps directly onto
    // the screen's half-width — which is what makes this one line correct.
    const spreadAngle = state.spread ?? 0;
    const fovRad = (settings.player.fov * Math.PI) / 180;
    const halfScreen = window.innerWidth * 0.5;
    const pixels = (Math.tan(spreadAngle) / Math.tan(fovRad * 0.5)) * halfScreen;
    const gap = Math.round(
      Math.max(CH.gapMin, Math.min(CH.gapMax, CH.gapMin + pixels))
    );

    // Whole pixels, always. A bar at 7.4 px is a blurred bar.
    this._set(this.bars.t, 'transform', `translate(-50%,${-gap}px)`);
    this._set(this.bars.b, 'transform', `translate(-50%,${gap}px)`);
    this._set(this.bars.l, 'transform', `translate(${-gap}px,-50%)`);
    this._set(this.bars.r, 'transform', `translate(${gap}px,-50%)`);

    // Down the sights the crosshair is gone — the iron sights *are* the
    // crosshair. Every shipped shooter does this; leaving a reticle up over
    // the sight picture is the tell of a prototype.
    const chOpacity = aiming > 0.02 ? Math.max(0, 1 - aiming * 1.35) : 1;
    this._set(this.crosshair, 'opacity', chOpacity.toFixed(2));

    /* ------------------------------------------------------------------ */
    /* Hitmarker                                                           */
    /* ------------------------------------------------------------------ */
    // Punches in slightly oversized, snaps to size in ~45 ms, holds, then
    // fades. That snap is the whole sensation; a marker that only fades in
    // and out feels like a notification rather than like a hit.
    const hit = state.hitmarker ?? 0;
    if (hit > 0) {
      const total = settings.combat.hitmarkerTime;
      const age = Math.max(0, 1 - hit / total); // 0 at the hit, 1 at the end
      const scale = 1.34 - 0.34 * Math.min(1, age / 0.2);
      const fade = age < 0.5 ? 1 : 1 - (age - 0.5) / 0.5;
      this._set(this.hitmarker, 'opacity', fade.toFixed(2));
      this._set(
        this.hitmarker,
        'transform',
        `translate(-50%,-50%) scale(${scale.toFixed(3)})`
      );
      const kill = !!state.hitmarkerKill;
      if (this._cache.hmKill !== kill) {
        this._cache.hmKill = kill;
        this.hitmarker.classList.toggle('kill', kill);
      }
    } else {
      this._set(this.hitmarker, 'opacity', '0');
    }

    /* ------------------------------------------------------------------ */
    /* Vitals                                                              */
    /* ------------------------------------------------------------------ */
    const health = Math.round(state.health ?? 0);
    this._set(this.healthBar, 'width', `${(health / settings.player.maxHealth) * 100}%`);
    this._set(this.healthValue, 'text', String(health));
    const low = health < 35;
    if (this._cache.hpLow !== low) {
      this._cache.hpLow = low;
      this.healthBar.classList.toggle('low', low);
      this.healthValue.classList.toggle('low', low);
    }

    const mana = Math.round(state.mana ?? 0);
    this._set(this.manaBar, 'width', `${(mana / settings.player.maxMana) * 100}%`);
    this._set(this.manaValue, 'text', String(mana));

    /* ------------------------------------------------------------------ */
    /* Weapon + ammo                                                       */
    /* ------------------------------------------------------------------ */
    const weaponId = state.weapon?.id;
    const config = weaponId ? settings[weaponId] : null;
    let mag = 0;
    if (config) {
      this._set(this.weaponName, 'text', config.name);
      mag = state.ammo?.get?.(weaponId) ?? 0;
      this._set(this.ammoMag, 'text', String(mag));
      this._set(this.ammoReserve, 'text', String(state.reserve ?? 0));

      // Three states, because "how much is left" is the only urgent thing the
      // ammo counter ever has to say: fine, low (a third of the mag), empty.
      const level = mag === 0 ? 'empty' : mag <= Math.ceil(config.magazine / 3) ? 'low' : '';
      if (this._cache.ammoLevel !== level) {
        this._cache.ammoLevel = level;
        this.ammoMag.className = `hud-ammo-mag${level ? ' ' + level : ''}`;
      }
    }

    /* ---- reload: a real progress bar, timed from the weapon's own config ---- */
    const reloading = !!state.reloading;
    if (reloading && !this._reloadWasOn && config) {
      this._reloadStart = 0;
      this._reloadDuration = this._lastMag <= 0 ? config.reloadEmptyTime : config.reloadTime;
    }
    this._reloadWasOn = reloading;
    if (!reloading) this._lastMag = mag;

    if (reloading) {
      this._reloadStart += dt;
      const t = Math.min(1, this._reloadStart / Math.max(0.001, this._reloadDuration));
      this._set(this.reloadBar, 'transform', `scaleX(${t.toFixed(3)})`);
    }
    if (this._cache.reloading !== reloading) {
      this._cache.reloading = reloading;
      this.reloadIndicator.classList.toggle('visible', reloading);
    }

    /* ------------------------------------------------------------------ */
    /* Abilities                                                           */
    /* ------------------------------------------------------------------ */
    if (state.cooldowns) {
      for (const [element, remaining] of state.cooldowns) {
        const slot = this.abilitySlots.get(element);
        if (!slot) continue;
        const total = settings[element]?.cooldown ?? 1;
        const t = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
        this._set(slot.cd, 'transform', `scaleY(${t.toFixed(3)})`);

        const ready = remaining <= 0.001;
        if (slot.ready !== ready) {
          slot.ready = ready;
          slot.root.classList.toggle('ready', ready);
        }
        // Only the whole second matters, so only write when it changes.
        const label = ready ? '' : String(Math.ceil(remaining));
        if (slot.lastTimer !== label) {
          slot.lastTimer = label;
          slot.timer.textContent = label;
        }
      }
    }

    /* ------------------------------------------------------------------ */
    /* Damage vignette / toast / stats                                     */
    /* ------------------------------------------------------------------ */
    this._damagePulse = Math.max(0, this._damagePulse - dt);
    const pulse = this._damagePulse / settings.combat.hitFlashTime;
    this._set(this.damageVignette, 'opacity', (pulse * 0.8).toFixed(2));

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toast.classList.remove('visible');
    }

    this._fpsAccumulator += dt;
    this._fpsFrames++;
    if (this._fpsAccumulator >= 0.35) {
      this._fps = this._fpsFrames / this._fpsAccumulator;
      this._fpsAccumulator = 0;
      this._fpsFrames = 0;

      if (this._statsOn) {
        this.stats.innerHTML = `
          <div><b>${this._fps.toFixed(0)}</b> fps</div>
          <div>${state.calls ?? 0} draw calls</div>
          <div>${((state.triangles ?? 0) / 1000).toFixed(0)}k tris</div>
          <div>${state.particles ?? 0} particles</div>
          <div>${state.monsters ?? 0} monsters</div>
        `;
      }
    }
  }

  get fps() {
    return this._fps;
  }
}

/** The boot screen. */
export class LoadingScreen {
  constructor() {
    this.root = document.getElementById('loading');
    this.bar = document.getElementById('loadingBar');
    this.label = document.getElementById('loadingLabel');
  }

  setProgress(value, message) {
    if (this.bar) this.bar.style.width = `${Math.round(value * 100)}%`;
    if (this.label && message) this.label.textContent = message;
  }

  hide() {
    this.root?.classList.add('hidden');
  }
}
