import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  attachScatterTexture, hasScatterTexture, styleScatterTexture,
  setScatterTextureEnabled, scatterTextureUniforms,
  SCATTER_TEXTURE_GLSL, SCATTER_TEXTURE_VERT_BODY, SCATTER_TEXTURE_FRAG_BODY,
} from '../src/geometry/ScatterTexture.js';
import { attachSnow } from '../src/season/SnowAttach.js';
import { attachSeasonalTint } from '../src/season/TintAttach.js';
import { attachWindSway } from '../src/weather/WindSway.js';
import { attachAtmosphere } from '../src/sky/Atmosphere.js';
import { SEASON_COLOR_SLOT } from '../src/season/SeasonGLSL.js';

/** Run a patched material's hook over three's real chunk sources. */
function compile(mat: THREE.Material, lib = THREE.ShaderLib.lambert) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  };
  mat.onBeforeCompile(shader as never, null as never);
  return shader;
}

describe('attachScatterTexture', () => {
  it('multiplies diffuseColor, so hue survives and strength 0 is a true no-op', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
    attachScatterTexture(mat);
    expect(hasScatterTexture(mat)).toBe(true);
    const shader = compile(mat);

    // Multiplicative: an additive term would wash a dark trunk and a bright
    // canopy by the same absolute amount and grey both.
    expect(shader.fragmentShader)
      .toContain('diffuseColor.rgb *= 1.0 + (stN - 0.5) * uScatterTexStrength * stFade;');
    // Into diffuseColor before lighting, so mottling is lit and shadowed with
    // the model rather than painted over the top of it.
    expect(shader.fragmentShader.indexOf('uScatterTexStrength * stFade'))
      .toBeLessThan(shader.fragmentShader.indexOf('#include <dithering_fragment>'));
  });

  it('samples the raw position attribute, so wind sway cannot drag the pattern', () => {
    // `transformed` is what the sway bends. Sampling it would make the mottling
    // swim across the canopy every time the plant leaned.
    const mat = new THREE.MeshLambertMaterial();
    attachScatterTexture(mat);
    const shader = compile(mat);

    expect(shader.vertexShader).toContain('vec3 stBase = position + modelMatrix[3].xyz;');
    expect(SCATTER_TEXTURE_VERT_BODY).not.toContain('transformed');
    // Instance origin decorrelates one plant from the next.
    expect(shader.vertexShader).toContain('stBase += instanceMatrix[3].xyz;');
    expect(shader.vertexShader).toContain('#ifdef USE_INSTANCING');
  });

  it('is unaffected by a sway patch attached alongside it', () => {
    const swayed = new THREE.MeshLambertMaterial();
    attachWindSway(swayed);
    attachScatterTexture(swayed);
    const a = compile(swayed);

    const plain = new THREE.MeshLambertMaterial();
    attachScatterTexture(plain);
    const b = compile(plain);

    // Same noise coordinate either way — the two patches do not interact.
    expect(a.vertexShader).toContain('vec3 stBase = position + modelMatrix[3].xyz;');
    expect(b.vertexShader).toContain('vec3 stBase = position + modelMatrix[3].xyz;');
    // …and the sway still bends the vertex.
    expect(a.vertexShader).toContain('transformed += offset;');
  });

  it('takes fwidth before the branch, and fades a sub-pixel pattern out', () => {
    // fwidth is undefined under non-uniform control flow, and an unfaded
    // sub-pixel pattern crawls as the camera moves rather than averaging out.
    const frag = SCATTER_TEXTURE_FRAG_BODY;
    expect(frag.indexOf('fwidth(')).toBeLessThan(frag.indexOf('if (uScatterTexEnabled'));
    expect(frag).toContain('1.0 - smoothstep(0.5, 1.5, stPx)');
  });

  it('lands before the season slot, so the tint recolours it and snow buries it', () => {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Attached in an awkward order on purpose: the slot discipline is what
    // makes the result independent of it.
    attachSnow(mat);
    attachScatterTexture(mat);
    attachSeasonalTint(mat, { summer: 0x6f9c3a });
    const shader = compile(mat);

    const texAt   = shader.fragmentShader.indexOf('uScatterTexStrength * stFade');
    const slotAt  = shader.fragmentShader.indexOf(SEASON_COLOR_SLOT);
    const tintAt  = shader.fragmentShader.indexOf('seasonalFoliage(diffuseColor.rgb');
    const snowAt  = shader.fragmentShader.indexOf('mix(diffuseColor.rgb, uSnowColor');
    for (const [name, at] of [['tex', texAt], ['slot', slotAt], ['tint', tintAt], ['snow', snowAt]] as const) {
      expect(at, name).toBeGreaterThan(-1);
    }
    expect(texAt).toBeLessThan(slotAt);
    expect(tintAt).toBeLessThan(slotAt);
    expect(snowAt).toBeGreaterThan(slotAt);
  });

  it('composes with snow, tint, sway and haze on one material', () => {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    attachScatterTexture(mat);
    attachSeasonalTint(mat, { summer: 0x6f9c3a });
    attachSnow(mat);
    attachWindSway(mat);
    attachAtmosphere(mat);
    const shader = compile(mat);

    expect(shader.uniforms.uScatterTexStrength).toBeDefined();
    expect(shader.uniforms.uFoliageSummer).toBeDefined();
    expect(shader.uniforms.uSnowColor).toBeDefined();
    expect(shader.uniforms.uSwayAmplitude).toBeDefined();
    expect(shader.uniforms.uAtmoEnabled).toBeDefined();

    const key = mat.customProgramCacheKey();
    for (const part of [
      'hex-world-scatter-texture', 'hex-world-foliage', 'hex-world-snow',
      'hex-world-wind-sway', 'hex-world-atmosphere',
    ]) {
      expect(key, part).toContain(part);
    }
  });

  it('declares and binds every uniform the bodies read', () => {
    const used = new Set(
      (SCATTER_TEXTURE_VERT_BODY + SCATTER_TEXTURE_FRAG_BODY).match(/\buScatterTex[A-Za-z]+\b/g) ?? [],
    );
    expect(used.size).toBeGreaterThan(1);
    const bound = scatterTextureUniforms();
    for (const name of used) {
      expect(SCATTER_TEXTURE_GLSL, `${name} declared`).toMatch(new RegExp(`uniform\\s+\\w+\\s+${name};`));
      expect(bound[name], `${name} bound`).toBeDefined();
    }
  });

  it('keeps an existing onBeforeCompile working and does not share its program', () => {
    let priorRan = false;
    const mat = new THREE.MeshLambertMaterial();
    mat.onBeforeCompile = () => { priorRan = true; };
    attachScatterTexture(mat);
    compile(mat);
    expect(priorRan).toBe(true);

    const other = new THREE.MeshLambertMaterial();
    attachScatterTexture(other);
    expect(mat.customProgramCacheKey()).not.toBe(other.customProgramCacheKey());
  });

  it('is idempotent — a second call restyles instead of rebinding', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachScatterTexture(mat, { strength: 0.2 });
    const u = mat.userData.hexWorldScatterTexture as Record<string, THREE.IUniform>;
    attachScatterTexture(mat, { strength: 0.05, scale: 12 });
    expect(mat.userData.hexWorldScatterTexture).toBe(u);
    expect(u.uScatterTexStrength.value).toBeCloseTo(0.05);
    expect(u.uScatterTexScale.value).toBe(12);
  });

  it('the enable gate round-trips without losing the styled strength', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachScatterTexture(mat, { strength: 0.22 });
    const u = mat.userData.hexWorldScatterTexture as Record<string, THREE.IUniform>;

    setScatterTextureEnabled(mat, false);
    expect(u.uScatterTexEnabled.value).toBe(0);
    expect(u.uScatterTexStrength.value).toBeCloseTo(0.22); // remembered, not zeroed
    setScatterTextureEnabled(mat, true);
    expect(u.uScatterTexEnabled.value).toBe(1);
    expect(u.uScatterTexStrength.value).toBeCloseTo(0.22);
  });

  it('styling a material that never got the patch is a no-op, not a throw', () => {
    const plain = new THREE.MeshLambertMaterial();
    expect(hasScatterTexture(plain)).toBe(false);
    expect(() => styleScatterTexture(plain, { strength: 0.5 })).not.toThrow();
    expect(() => setScatterTextureEnabled(plain, false)).not.toThrow();
  });
});
