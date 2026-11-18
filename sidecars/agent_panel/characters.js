/**
 * Elemental pixel-sprite character engine for Google Antigravity models.
 * Loaded as a classic script so sidecar iframes never hit ES-module CORS rules.
 */
(function (root) {
  const ELEMENTS = {
    neon: {
      id: 'neon',
      num: '10',
      sym: 'Ne',
      name: 'Neon',
      shape: 'neon',
      flavor: 'Luminous noble plasma cell, twin glowing orbit',
    },
    hydrogen: {
      id: 'hydrogen',
      num: '1',
      sym: 'H',
      name: 'Hydrogen',
      shape: 'droplet',
      flavor: 'Light plasma core, orbiting 4-point Gemini spark',
    },
    argon: {
      id: 'argon',
      num: '18',
      sym: 'Ar',
      name: 'Argon',
      shape: 'capsule',
      flavor: 'Noble gas containment shell, dual valence orbit',
    },
    carbon: {
      id: 'carbon',
      num: '6',
      sym: 'C',
      name: 'Carbon',
      shape: 'crystal',
      flavor: 'Faceted crystalline lattice core',
    },
    flash: {
      id: 'flash',
      num: '⚡',
      sym: '3.8',
      name: 'Flash',
      shape: 'spark',
      flavor: 'High-speed electric spark',
    },
    guest: {
      id: 'guest',
      num: '✦',
      sym: 'CL',
      name: 'Claude',
      shape: 'capsule',
      flavor: 'Terracotta guest atom',
    },
  };

  function elementForModel(model) {
    const s = String(model || '').toLowerCase();
    if (s.includes('neon')) return ELEMENTS.neon;
    if (s.includes('argon') || s.includes('orchestrator')) return ELEMENTS.argon;
    if (s.includes('carbon')) return ELEMENTS.carbon;
    if (s.includes('flash')) return ELEMENTS.flash;
    if (s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('gpt')) {
      return ELEMENTS.guest;
    }
    return ELEMENTS.hydrogen;
  }

  function effortOfModel(model) {
    const m = String(model || '').match(/\((XHigh|High|Medium|Low)\)/i);
    if (!m) return null;
    const raw = m[1].toLowerCase();
    const map = {
      xhigh: { label: 'xhigh', tone: 'heavy' },
      high: { label: 'high', tone: 'careful' },
      medium: { label: 'medium', tone: 'medium' },
      low: { label: 'low', tone: 'light' },
    };
    return map[raw] || null;
  }

  function shortModelName(model) {
    return String(model || 'Hydrogen')
      .replace(/\s*\((XHigh|High|Medium|Low)\)/i, '')
      .replace(/^Gemini\s+/i, '')
      .trim();
  }

  const R = (x, y, w, h, fill, inner = '') =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}">${inner}</rect>`;
  const anim = (attr, values, dur, extra = '') =>
    `<animate attributeName="${attr}" values="${values}" dur="${dur}" repeatCount="indefinite" ${extra}/>`;
  const xform = (type, values, dur, extra = '') =>
    `<animateTransform attributeName="transform" type="${type}" values="${values}" dur="${dur}" repeatCount="indefinite" ${extra}/>`;

  function sparkGlyph(cx, cy, color) {
    return (
      R(cx, cy - 1.5, 1, 4, color) +
      R(cx - 1.5, cy, 4, 1, color) +
      R(cx, cy, 1, 1, '#FFFFFF')
    );
  }

  function bodyPixels(shape, B, S, H, F) {
    if (shape === 'neon') {
      return (
        R(10, 7, 8, 1, H) +
        R(8, 8, 12, 1.5, H) +
        R(7, 9.5, 14, 1.5, B) +
        R(6, 11, 16, 5.5, B) +
        R(7, 16.5, 14, 2, B) +
        R(9, 18.5, 10, 1.5, S) +
        R(7.5, 10, 1.5, 5, H) +
        R(19, 10, 1.5, 5, F) +
        R(10, 9, 5, 1, H) +
        R(17, 16, 3, 2, S)
      );
    }
    if (shape === 'droplet') {
      return (
        R(13, 6.5, 2, 1, H) +
        R(11, 7.5, 6, 1, H) +
        R(9, 8.5, 10, 2, B) +
        R(7, 10.5, 14, 6, B) +
        R(8, 16.5, 12, 2, B) +
        R(10, 18.5, 8, 1, S) +
        R(9, 10, 3, 2, H) +
        R(17, 11, 3, 4, F) +
        R(18, 15, 2, 2, S)
      );
    }
    if (shape === 'crystal') {
      return (
        R(12, 7, 4, 1, H) +
        R(10, 8, 8, 1, H) +
        R(8, 9, 12, 2, B) +
        R(6, 11, 16, 5, B) +
        R(8, 16, 12, 2, S) +
        R(10, 18, 8, 1, S) +
        R(12, 19, 4, 1, S) +
        R(11, 10, 3, 2, H) +
        R(16, 12, 4, 4, S)
      );
    }
    if (shape === 'spark') {
      return (
        R(9, 7, 2, 2, H) +
        R(17, 7, 2, 2, H) +
        R(8, 9, 12, 2, B) +
        R(7, 11, 14, 6, B) +
        R(8, 17, 12, 2, S) +
        R(10, 19, 8, 1, S) +
        R(9, 10, 4, 2, H)
      );
    }
    return (
      R(9, 8, 10, 1, H) +
      R(7, 9, 14, 2, B) +
      R(6, 11, 16, 6, B) +
      R(7, 17, 14, 2, S) +
      R(9, 19, 10, 1, S) +
      R(8, 10, 4, 1, H) +
      R(19, 12, 2, 4, S)
    );
  }

  function orbitalLayer(elId, live, SP, H) {
    if (!live) return '';
    if (elId === 'neon') {
      return `<g>${xform('rotate', '0 14 14;360 14 14', '2.4s')}${sparkGlyph(23.5, 12, SP)}${R(3.5, 14.5, 1.6, 1.6, H, anim('opacity', '0.4;1;0.4', '0.9s'))}</g>`;
    }
    if (elId === 'hydrogen') {
      return `<g>${xform('rotate', '0 14 14;360 14 14', '2.8s')}${sparkGlyph(23.5, 13.5, SP)}</g>`;
    }
    if (elId === 'argon') {
      return `<g>${xform('rotate', '0 14 14;360 14 14', '4.2s')}${R(3, 13, 1.6, 1.6, SP)}${R(23.4, 13, 1.6, 1.6, SP)}</g>`;
    }
    if (elId === 'flash') {
      return `<g>${R(4, 9, 1.5, 1.5, H, anim('opacity', '1;0.15;1', '0.45s'))}${R(22.5, 16, 1.5, 1.5, H, anim('opacity', '0.15;1;0.15', '0.45s'))}</g>`;
    }
    if (elId === 'carbon') {
      return `<g>${R(13, 4.5, 2, 1.5, H, anim('opacity', '0.4;1;0.4', '1.4s'))}</g>`;
    }
    return '';
  }

  function personaGear(persona, live, B, E, SP) {
    switch (persona) {
      case 'main':
        return {
          back:
            R(9, 3, 10, 1, '#E2E8F0') +
            R(7, 4, 14, 2, '#F8FAFC') +
            R(7, 6, 14, 1.4, '#1E293B') +
            R(13, 4.8, 2, 2, SP),
          front: R(8, 7.4, 12, 0.9, '#0F172A'),
          arms: R(4.5, 13, 2, 2, B) + R(21.5, 13, 2, 2, B),
        };
      case 'architect':
        return {
          back:
            R(10, 3.8, 8, 1.8, '#3B82F6') +
            R(8, 5.6, 12, 1.8, '#3B82F6') +
            R(6, 7.2, 16, 0.9, '#1D4ED8'),
          front:
            `<circle cx="10.8" cy="13" r="1.7" fill="none" stroke="${E}" stroke-width="0.6"/>` +
            `<circle cx="17.2" cy="13" r="1.7" fill="none" stroke="${E}" stroke-width="0.6"/>` +
            R(12.5, 12.7, 3, 0.5, E) +
            R(22, 9, 6, 8, '#1D4ED8') +
            R(21.5, 8.5, 7, 1, '#60A5FA') +
            R(21.5, 16.5, 7, 1, '#60A5FA') +
            R(23.5, 11, 3, 1, '#E0F2FE', live ? anim('width', '0;3;3', '1.4s') : '') +
            R(23.5, 13, 2, 1, '#E0F2FE', live ? anim('width', '0;2;2', '1.4s') : ''),
          arms: R(4.5, 13, 2, 2, B) + R(20.5, 12, 2, 2, B, live ? anim('y', '12;11;12', '0.7s') : ''),
        };
      case 'developer':
        return {
          back:
            R(7, 5.8, 14, 1.2, '#334155') +
            R(6, 6.8, 1.2, 4, '#334155') +
            R(20.8, 6.8, 1.2, 4, '#334155'),
          front:
            R(5, 10, 2, 3.5, '#E0A44A') +
            R(21, 10, 2, 3.5, '#E0A44A') +
            (live ? R(9, 13.8, 10, 2, '#9FE8FF', anim('opacity', '0.25;0.6;0.25', '0.5s')) : '') +
            R(9, 15.6, 10, 4.2, '#475569') +
            R(7, 19.8, 14, 1, '#64748B'),
          arms:
            R(8, 18.4, 2, 1.4, B, live ? anim('y', '18.4;17.4;18.4', '0.24s') : '') +
            R(18, 18.4, 2, 1.4, B, live ? anim('y', '17.4;18.4;17.4', '0.24s') : ''),
        };
      case 'reviewer':
        return {
          back: R(8, 6, 12, 2.2, '#94A3B8') + R(14, 7.8, 8, 1, '#64748B'),
          front:
            `<g>${live ? xform('translate', '0 0;2 0;0 0', '0.9s') : ''}` +
            `<circle cx="10.5" cy="13" r="2.6" fill="#CFE9FF" fill-opacity="0.5" stroke="#1E293B" stroke-width="0.7"/>` +
            R(12.2, 15, 1.1, 1.1, '#6B4F3A') +
            R(13.1, 16, 1.1, 1.1, '#6B4F3A') +
            `</g>`,
          arms: R(4.5, 13, 2, 2, B) + R(21.5, 13, 2, 2, B),
        };
      case 'scout':
        return {
          back:
            R(10, 3, 8, 1.2, '#A6804D') +
            R(9, 4.2, 10, 2.2, '#A6804D') +
            R(9, 5.5, 10, 0.8, '#5C4033') +
            R(4, 6.4, 20, 1.4, '#A6804D'),
          front:
            R(10, 16, 8, 1, '#D9553B') +
            R(12, 17, 4, 1, '#D9553B') +
            R(13.2, 16, 1.6, 1, '#E0A44A') +
            `<g transform="translate(0 ${live ? 0 : 4})">${live ? xform('translate', '0 0;0 -1;0 0', '0.7s') : ''}` +
            R(8, 11.5, 4, 2.8, '#334155') +
            R(16, 11.5, 4, 2.8, '#334155') +
            R(12, 12.4, 4, 1, '#334155') +
            R(9, 12.4, 1.2, 1, '#7DD3FC') +
            R(17, 12.4, 1.2, 1, '#7DD3FC') +
            `</g>`,
          arms: R(5, 14, 2, 2, B) + R(21, 14, 2, 2, B),
          flip: true,
        };
      case 'browser':
        return {
          back: R(8, 6, 12, 2, '#334155'),
          front:
            R(7.5, 11, 13, 4, '#0F172A') +
            R(8.5, 12, 11, 2, live ? '#38BDF8' : '#64748B', live ? anim('opacity', '0.75;1;0.75', '0.8s') : '') +
            `<g>${live ? xform('translate', '0 0;2 -1;0 0', '1.1s') : ''}${R(21, 11, 2, 2, '#F8FAFC')}${R(22, 13, 1.5, 1.5, '#F8FAFC')}</g>`,
          arms: R(4.5, 13, 2, 2, B) + R(21.5, 13, 2, 2, B),
          hidesEyes: true,
        };
      case 'shipper':
        return {
          back:
            `<g>${live ? xform('translate', '0 0;0 -1.2;0 0', '0.6s') : ''}` +
            R(8, 1, 12, 6, '#C68B4E') +
            R(13.2, 1, 1.6, 6, '#E9D3A6') +
            `</g>`,
          front: '',
          arms: R(5.5, 6.5, 2, 4.5, B) + R(20.5, 6.5, 2, 4.5, B),
          hop: true,
        };
      default:
        return {
          back: '',
          front: '',
          arms: R(4.5, 13, 2, 2, B) + R(21.5, 13, 2, 2, B),
        };
    }
  }

  const svgCache = new Map();

  function renderCharacterSvg(model, persona, mood = 'working') {
    const el = elementForModel(model);
    const key = `${el.id}|${persona}|${mood}`;
    const hit = svgCache.get(key);
    if (hit) return hit;

    const live = mood === 'working';
    const failed = mood === 'failed';
    const p = el.id;
    const B = failed ? '#C94A4A' : `var(--el-${p}-body)`;
    const S = failed ? '#8C2D2D' : `var(--el-${p}-shade)`;
    const H = failed ? '#F1948A' : `var(--el-${p}-hi)`;
    const F = failed ? '#D9534F' : `var(--el-${p}-facet)`;
    const SP = failed ? '#F1948A' : `var(--el-${p}-spark)`;
    const E = `var(--el-${p}-eye)`;

    const g = personaGear(persona, live, B, E, SP);

    const blink = (x) =>
      R(
        x,
        12,
        1.4,
        2.2,
        E,
        live
          ? anim('height', '2.2;2.2;0.3;2.2', '1.8s', 'keyTimes="0;0.82;0.91;1"') +
              anim('y', '12;12;13.2;12', '1.8s', 'keyTimes="0;0.82;0.91;1"')
          : '',
      );

    let eyes = '';
    if (g.hidesEyes && !failed) {
      eyes = '';
    } else if (mood === 'done') {
      eyes =
        R(9.5, 13, 1, 1, E) +
        R(10.5, 12, 1, 1, E) +
        R(11.5, 13, 1, 1, E) +
        R(15.5, 13, 1, 1, E) +
        R(16.5, 12, 1, 1, E) +
        R(17.5, 13, 1, 1, E);
    } else if (failed) {
      eyes =
        R(9.5, 11.5, 1, 1, E) +
        R(11.5, 11.5, 1, 1, E) +
        R(10.5, 12.5, 1, 1, E) +
        R(9.5, 13.5, 1, 1, E) +
        R(11.5, 13.5, 1, 1, E) +
        R(15.5, 11.5, 1, 1, E) +
        R(17.5, 11.5, 1, 1, E) +
        R(16.5, 12.5, 1, 1, E) +
        R(15.5, 13.5, 1, 1, E) +
        R(17.5, 13.5, 1, 1, E);
    } else if (mood === 'waiting') {
      eyes = R(9.5, 13, 3, 0.8, E) + R(15.5, 13, 3, 0.8, E);
    } else {
      eyes = blink(10) + blink(16.6);
    }

    const feet = live
      ? R(9.5, 20, 2, 1.4, S, anim('y', '20;20.8;20', '0.55s')) +
        R(16.5, 20, 2, 1.4, S, anim('y', '20.8;20;20.8', '0.55s'))
      : R(9.5, 20, 2, 1.4, S) + R(16.5, 20, 2, 1.4, S);

    const core = g.back + feet + bodyPixels(el.shape, B, S, H, F) + g.arms + eyes + g.front;
    const flipped =
      live && g.flip
        ? `<g transform="translate(14 0)"><g>${xform('scale', '1 1;-1 1', '3.6s', 'calcMode="discrete" keyTimes="0;0.5"')}<g transform="translate(-14 0)">${core}</g></g></g>`
        : core;
    const hover = live
      ? xform('translate', g.hop ? '0 0;0 -1.6;0 0' : '0 0;0 -0.9;0 0', g.hop ? '0.6s' : '1.4s')
      : '';
    const zzz =
      mood === 'waiting'
        ? `<text x="21" y="7" font-size="4" font-family="monospace" font-weight="bold" fill="currentColor" opacity="0.55">z</text><text x="24" y="4" font-size="3" font-family="monospace" font-weight="bold" fill="currentColor" opacity="0.55">z</text>`
        : '';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 24" class="avatar-svg">
      <ellipse cx="14" cy="22.4" rx="6" ry="0.8" fill="#000" fill-opacity="0.18"/>
      <g${mood === 'waiting' ? ' opacity="0.62"' : ''}>${hover}${orbitalLayer(el.id, live, SP, H)}${flipped}</g>
      ${zzz}
    </svg>`;

    svgCache.set(key, svg);
    return svg;
  }

  function dotsSvg(color = 'currentColor') {
    const dot = (cx, begin) =>
      `<circle cx="${cx}" cy="4" r="1.4" fill="${color}">` +
      `<animate attributeName="opacity" values="1;0.35;1;1" keyTimes="0;0.25;0.5;1" dur="0.8s" begin="${begin}" repeatCount="indefinite"/>` +
      `</circle>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8" class="dots-svg">${dot(3, '0s')}${dot(8, '0.13s')}${dot(13, '0.26s')}</svg>`;
  }

  root.AgentCharacters = {
    ELEMENTS,
    elementForModel,
    effortOfModel,
    shortModelName,
    renderCharacterSvg,
    dotsSvg,
  };
})(window);
