// ===================== AAA Defense - Custom Icon Set =====================
// Original geometric glyphs (not copied third-party art), inspired by the bold
// monochrome silhouette language of open-license game icon libraries
// (e.g. game-icons.net, CC BY) but hand-built here so the game ships license-clean.
// Each icon is defined once and rendered two ways: as inline DOM SVG, and as
// native canvas draw calls (drawGlyph) for crisp in-field rendering with no image loads.

const ICON_DOM = {
  slash: '<line x1="5" y1="19" x2="19" y2="5"/><line x1="19" y1="5" x2="14" y2="5"/><line x1="19" y1="5" x2="19" y2="10"/>',
  multislash: '<line x1="4" y1="18" x2="14" y2="6"/><line x1="8" y1="19" x2="18" y2="7"/><line x1="12" y1="20" x2="20" y2="11"/>',
  arcane: '<circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="4" r="1.4"/><circle cx="19" cy="15" r="1.4"/><circle cx="5" cy="15" r="1.4"/>',
  frost: '<line x1="12" y1="3" x2="12" y2="21"/><line x1="4.5" y1="7.5" x2="19.5" y2="16.5"/><line x1="19.5" y1="7.5" x2="4.5" y2="16.5"/>',
  arrow: '<line x1="3" y1="21" x2="17" y2="7"/><polyline points="10,7 17,7 17,14"/>',
  debuff: '<circle cx="12" cy="12" r="8.5"/><polyline points="8,10 12,15 16,10" fill="none"/>',
  buff: '<circle cx="12" cy="12" r="8.5"/><polyline points="8,14 12,9 16,14" fill="none"/>',
  wave: '<path d="M2 9c2 0 2-3 4-3s2 3 4 3 2-3 4-3 2 3 4 3 2-3 4-3" fill="none"/><path d="M2 15c2 0 2-3 4-3s2 3 4 3 2-3 4-3 2 3 4 3 2-3 4-3" fill="none"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><line x1="12" y1="12" x2="12" y2="7"/><line x1="12" y1="12" x2="15.5" y2="14"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/>',
  gem: '<polygon points="12,3 20,9 16,21 8,21 4,9" fill-rule="evenodd"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="8" y1="21" x2="12" y2="9"/><line x1="16" y1="21" x2="12" y2="9"/>',
  swarm: '<polygon points="12,3 20,8 20,16 12,21 4,16 4,8"/><circle cx="9" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="11" r="1.1" fill="currentColor" stroke="none"/>',
  fastfwd: '<polygon points="3,5 11,12 3,19" fill="currentColor" stroke="none"/><polygon points="12,5 20,12 12,19" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z" fill-rule="evenodd"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none"/>',
  tag: '<path d="M3 11 L11 3 L20 3 L20 12 L12 20 Z" fill-rule="evenodd"/><circle cx="15.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3 6 h6 l2 2.5 h10 v11 h-18 Z" fill-rule="evenodd"/>',
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>',
  bag: '<path d="M6 8 L8 4 h8 l2 4 Z" fill-rule="evenodd"/><path d="M4 8 h16 l-1.4 12 h-13.2 Z" fill-rule="evenodd"/>',
  home: '<path d="M4 11 L12 4 L20 11" fill="none"/><path d="M6 10 v10 h12 v-10" fill="none"/><rect x="10" y="14" width="4" height="6"/>',
  ticket: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="14" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="16" r="1" fill="currentColor" stroke="none"/><line x1="14" y1="6" x2="14" y2="18" stroke-dasharray="0.1 3"/>',
  x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11 V8 a4 4 0 0 1 8 0 v3" fill="none"/><circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none"/>',
  bolt: '<polygon points="13,2 4,14 11,14 9,22 20,9 12,9" fill-rule="evenodd"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
};

function svgIcon(name, size = 18, color = 'currentColor') {
  const inner = ICON_DOM[name] || ICON_DOM.sparkle;
  // glyphs are drawn inward (scaled + centered) so nothing touches the edge of its box,
  // which previously made icons crowd/overlap adjacent grade letters and labels
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:${color}"><g transform="translate(12 12) scale(0.8) translate(-12 -12)">${inner}</g></svg>`;
}

// Native canvas renderer for the 7 unit-type glyphs (used on placed field units)
function drawGlyph(ctx, name, cx, cy, r, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.4, r * 0.16);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const s = r / 13.5; // scale factor from a ~22px design box, shrunk a bit for breathing room
  ctx.scale(s, s);
  ctx.beginPath();
  switch (name) {
    case 'slash':
      ctx.moveTo(-7, 9); ctx.lineTo(7, -7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(7, -7); ctx.lineTo(2, -7); ctx.moveTo(7, -7); ctx.lineTo(7, -2); ctx.stroke();
      break;
    case 'multislash':
      [[-8, 7, 2, -5], [-4, 8, 6, -4], [0, 9, 9, 0]].forEach(([x1, y1, x2, y2]) => {
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      });
      ctx.stroke();
      break;
    case 'arcane':
      ctx.arc(0, 0, 4.6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -8, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(7, 3, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-7, 3, 1.5, 0, Math.PI * 2); ctx.fill();
      break;
    case 'frost':
      [0, 60, 120].forEach(deg => {
        const a = (deg * Math.PI) / 180;
        ctx.moveTo(-Math.cos(a) * 9, -Math.sin(a) * 9);
        ctx.lineTo(Math.cos(a) * 9, Math.sin(a) * 9);
      });
      ctx.stroke();
      break;
    case 'arrow':
      ctx.moveTo(-9, 9); ctx.lineTo(7, -7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(7, -7); ctx.lineTo(7, 0); ctx.stroke();
      break;
    case 'debuff':
      ctx.arc(0, 0, 8.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-4, -1); ctx.lineTo(0, 4); ctx.lineTo(4, -1); ctx.stroke();
      break;
    case 'buff':
      ctx.arc(0, 0, 8.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-4, 2); ctx.lineTo(0, -3); ctx.lineTo(4, 2); ctx.stroke();
      break;
    default:
      ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
