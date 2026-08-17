import { Vector3 } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Arena } from '../world/Arena.js';

import { AssetLoader } from '../loaders/AssetLoader.js';

import { Collider } from '../fps/Collider.js';
import { PlayerController } from '../fps/PlayerController.js';
import { FPSCamera } from '../fps/FPSCamera.js';
import { InputManager } from '../fps/InputManager.js';
import { ViewmodelLighting } from '../fps/ViewmodelLighting.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { FissureSystem } from '../effects/GroundFissures.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { WeaponSystem } from '../weapons/WeaponSystem.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { MonsterManager } from '../monsters/MonsterManager.js';
import { FPSAbilityManager } from '../abilities/FPSAbilityManager.js';

import { PostProcessing } from '../postprocessing/PostProcessing.js';
import { HUD, LoadingScreen } from '../ui/HUD.js';

import { settings, ELEMENTS, WEAPONS } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

/**
 * Application root: owns every subsystem and the frame loop.
 *
 * Wiring is one-directional. App builds the systems, hands each one a context
 * object of the shared services it is allowed to touch, and then does nothing
 * but order the per-frame updates. No subsystem reaches back into App, which is
 * what makes it safe for separate agents to own separate subsystems.
 *
 * Update order matters and is not arbitrary:
 *   input → player → camera → weapons → combat → monsters → abilities → VFX → render
 * The camera has to be current before the weapons run, because a shot is fired
 * from the camera's *post-bob* transform; doing it the other way puts every
 * bullet a bob-amplitude away from the crosshair.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;
    this.ready = false;

    /* ---- core ---- */
    this.renderer = new Renderer(canvas);
    this.fps = new FPSCamera(window.innerWidth / window.innerHeight);
    this.camera = this.fps.camera;

    this.environment = new Environment(this.renderer, this.camera);
    this.scene = this.environment.scene;

    /* ---- world ---- */
    this.collider = new Collider();
    this.arena = new Arena(this.collider);
    this.scene.add(this.arena.group);

    /* ---- player ---- */
    this.player = new PlayerController(this.collider);
    this.input = new InputManager(canvas);

    /* ---- shared VFX services ---- */
    this.particles = new ParticleEngine(this.scene);
    this.lights = new LightPool(this.scene);
    this.decals = new DecalSystem(this.scene);
    this.fissures = new FissureSystem(this.scene);
    this.bursts = new BurstSystem(this.scene);
    this.shake = new CameraShake(this.fps);
    this.flash = new ScreenFlash();

    /* ---- gameplay ---- */
    this.combat = new CombatSystem({
      scene: this.scene,
      camera: this.camera,
      collider: this.collider,
      particles: this.particles,
      decals: this.decals,
      lights: this.lights,
      bursts: this.bursts
    });

    this.monsters = new MonsterManager({
      scene: this.scene,
      collider: this.collider,
      particles: this.particles,
      decals: this.decals,
      combat: this.combat,
      player: this.player
    });
    this.combat.monsters = this.monsters;

    this.weapons = new WeaponSystem({
      scene: this.scene,
      camera: this.camera,
      viewCamera: this.fps.viewCamera,
      player: this.player,
      combat: this.combat,
      particles: this.particles,
      lights: this.lights,
      shake: this.shake
    });

    // The viewmodel camera sees only LAYER.VIEWMODEL, and three collects lights
    // per camera by layer — so without this the gun receives no light at all,
    // including from muzzle flashes and spells going off beside it.
    this.viewmodelLighting = new ViewmodelLighting(this.scene, this.lights, this.environment);

    this.abilities = new FPSAbilityManager({
      scene: this.scene,
      camera: this.camera,
      environment: this.environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      fissures: this.fissures,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash,
      player: this.player,
      combat: this.combat,
      collider: this.collider
    });

    /* ---- post ---- */
    this.post = new PostProcessing(this.renderer, this.scene, this.camera, this.fps.viewCamera);

    /* ---- UI ---- */
    this.loading = new LoadingScreen();
    this.hud = new HUD(document.getElementById('hud'));

    /* ---- player state ---- */
    this.health = settings.player.maxHealth;
    this.armor = 0;
    this.mana = settings.player.maxMana;
    this._manaDelay = 0;
    this.cooldowns = new Map(ELEMENTS.map((element) => [element, 0]));

    /**
     * Handles the screenshot harness needs. Exposed rather than reached for
     * through module internals so the harness keeps working when files move.
     */
    this.settings = settings;
    this.frameUniforms = frame;

    this._bindEvents();
    this._focusPoint = new Vector3();
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.renderer.onResize((width, height, pixelRatio) => {
      this.fps.setAspect(width / height);
      this.post.setSize(width, height, pixelRatio);
    });

    this.input.on('lock', (locked) => this.hud.setLocked(locked));
    this.input.on('reload', () => this.weapons.reload());
    this.input.on('weapon', (slot) => this.weapons.select(WEAPONS[slot]));
    this.input.on('scroll', (dir) => this.weapons.cycle(dir));
    this.input.on('ability', (slot) => this.castAbility(ELEMENTS[slot]));
    this.input.on('aim', (down) => this.weapons.setAiming(down));
    this.input.on('togglePause', () => {
      this.paused = !this.paused;
      this.hud.showToast(this.paused ? 'Paused' : 'Resumed');
    });
    this.input.on('toggleHelp', () => this.hud.toggleHelp());
    this.input.on('toggleStats', () => this.hud.toggleStats());

    this.player.on('land', (impact) => {
      if (impact > 0.4) this.shake.add(impact * 0.35, 2.4, 26);
    });
    this.player.on('step', (ratio) => this.weapons.onStep?.(ratio));

    this.combat.on?.('playerDamage', (amount) => this.damagePlayer(amount));
  }

  /** Spend mana and throw the spell down the crosshair. */
  castAbility(element) {
    if (!element) return;
    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('Not ready');
      return;
    }
    const cast = this.abilities.cast(element);
    if (!cast) return;
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown));
    this._manaDelay = settings.player.manaRegenDelay;
  }

  damagePlayer(amount) {
    if (amount <= 0) return;
    const absorbed = Math.min(this.armor, amount * 0.5);
    this.armor -= absorbed;
    this.health = Math.max(0, this.health - (amount - absorbed));
    this.hud.pulseDamage();
    this.shake.add(0.16, 3.2, 30);
  }

  /* ------------------------------------------------------------------ */

  async load() {
    const assets = new AssetLoader();

    this.loading.setProgress(0.05, 'Loading environment…');
    const hdr = await assets.loadHDR(HDR_URL);
    await this.environment.loadEnvironment(hdr);
    frame.uEnvMap.value = this.environment.equirect;

    this.loading.setProgress(0.3, 'Building arena…');
    await this.arena.load(assets);

    this.loading.setProgress(0.55, 'Forging weapons…');
    await this.weapons.load(assets);

    this.loading.setProgress(0.75, 'Growing monsters…');
    await this.monsters.load(assets);

    this.loading.setProgress(0.9, 'Compiling shaders…');
    await this.renderer.gl.compileAsync(this.scene, this.camera);

    this.loading.setProgress(1, 'Ready');
    this.loading.hide();

    this.ready = true;
    this.start();
  }

  /**
   * Begin the render loop.
   *
   * Guarded, because this is *not* safe to call twice. Each call used to spawn
   * an independent requestAnimationFrame chain while `this._raf` only ever
   * remembered the most recent one — so a second `start()` left the first chain
   * running forever, unreferenced and uncancellable, and every later `stop()`
   * could only kill the newest. The screenshot harness pauses and resumes once
   * per shot, so the loops accumulated across a session: by the time the
   * performance probe ran it was measuring roughly twenty renders per animation
   * frame, which made every fps figure meaningless.
   */
  start() {
    if (this._raf) return;
    this.time.reset();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (!this._raf) return;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /* ------------------------------------------------------------------ */

  frame() {
    const gl = this.renderer.gl;
    gl.info.reset();

    const raw = this.time.tick();
    const dt = this.paused ? 0 : raw * settings.global.timeScale;
    this.elapsed += dt;

    /* ---- shared uniforms ---- */
    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uShaderIntensity.value = settings.global.shaderIntensity;
    frame.uGlobalGlow.value = settings.global.glow;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    this.renderer.syncSettings();

    /* ---- input → player ---- */
    const mouse = this.input.consumeMouse();
    this.player.zoomScale = this.weapons.aimProgress > 0.5 ? settings.player.zoomSensitivity : 1;
    this.player.recoilRecovery = this.weapons.config?.recoilRecovery ?? 7;
    if (!this.paused) this.player.look(mouse.dx, mouse.dy);
    this.player.update(dt, this.input);

    /* ---- fov: sprint widens it, ADS narrows it ---- */
    const p = settings.player;
    let fovTarget = p.fov;
    if (this.player.sprinting) fovTarget = p.fovSprint;
    fovTarget = this.weapons.modifyFov(fovTarget);
    this.fps.requestFov(fovTarget);

    /* ---- camera must be current before anything fires from it ---- */
    this.shake.update(raw);
    this.fps.update(this.player, dt);

    /* ---- world ---- */
    this.environment.setFocus(this.player.position.x, this.player.position.z);
    this.environment.update();

    /* ---- gameplay ---- */
    this.weapons.update(dt, this.input, this.player);
    this.combat.update(dt);
    this.monsters.update(dt);
    this.abilities.update(dt);

    for (const [element, remaining] of this.cooldowns) {
      if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - raw));
    }

    /* ---- mana ---- */
    this._manaDelay = Math.max(0, this._manaDelay - dt);
    if (this._manaDelay <= 0) {
      this.mana = Math.min(p.maxMana, this.mana + p.manaRegen * dt);
    }

    /* ---- VFX ---- */
    this.viewmodelLighting.update(this.weapons.root, raw);

    this.particles.flush();
    this.decals.update(dt);
    this.fissures.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);
    this.flash.update(raw);

    /* ---- render ---- */
    gl.shadowMap.needsUpdate = true;
    this.post.sync(this.elapsed, this.flash);
    this.post.render();

    /* ---- readouts ---- */
    this.hud.update(raw, {
      health: this.health,
      armor: this.armor,
      mana: this.mana,
      weapon: this.weapons.current,
      ammo: this.weapons.ammo,
      reserve: this.weapons.reserve,
      reloading: this.weapons.isReloading,
      spread: this.weapons.currentSpreadAngle,
      aiming: this.weapons.aimProgress,
      cooldowns: this.cooldowns,
      hitmarker: this.combat.hitmarker,
      hitmarkerKill: this.combat.hitmarkerKill,
      monsters: this.monsters.aliveCount,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      particles: this.particles.countLive(this.elapsed)
    });
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    this.input.dispose();
    this.viewmodelLighting.dispose();
    this.weapons.dispose();
    this.monsters.dispose();
    this.abilities.dispose();
    this.combat.dispose();
    this.particles.dispose();
    this.decals.dispose();
    this.fissures.dispose();
    this.bursts.dispose();
    this.lights.dispose();
    this.arena.dispose();
    this.post.dispose();
    this.environment.dispose();
    this.renderer.dispose();
  }
}
