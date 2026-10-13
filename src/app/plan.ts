import { centroid, type Parcel, type Project, type Ring } from '../engine';

const W = 340;
const H = 280;
const PAD = 30;

/** Plan masse schématique (nord en haut) ; les arêtes sont cliquables via data-edge. */
export function planSvg(p: Project, parcel: Parcel): string {
  const xs = p.parcelRing.map((v) => v[0]);
  const ys = p.parcelRing.map((v) => v[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  const s = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * s) / 2;
  const offY = (H - spanY * s) / 2;
  const X = (x: number) => offX + (x - minX) * s;
  const Y = (y: number) => H - offY - (y - minY) * s;
  const pts = (ring: Ring) => ring.map((v) => `${X(v[0]).toFixed(1)},${Y(v[1]).toFixed(1)}`).join(' ');

  const out: string[] = [];
  out.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Plan masse du projet">`);
  out.push(`<polygon points="${pts(p.parcelRing)}" fill="var(--plan-parcel)" stroke="var(--plan-parcel-line)" stroke-width="2" stroke-linejoin="round"/>`);
  for (const poly of p.envelope) {
    out.push(`<polygon points="${pts(poly[0])}" fill="var(--plan-env)" stroke="var(--plan-env-line)" stroke-width="1.4" stroke-dasharray="4 3"/>`);
  }
  if (p.footprint) out.push(`<polygon points="${pts(p.footprint)}" fill="var(--plan-fp)" stroke="var(--plan-fp-line)" stroke-width="2" stroke-linejoin="round"/>`);
  if (p.atticFootprint) out.push(`<polygon points="${pts(p.atticFootprint)}" fill="var(--plan-attic)" stroke="var(--plan-fp-line)" stroke-width="1.2" opacity="0.9"/>`);

  // arêtes du terrain : voie en rouge, zone de clic large, pastille numérotée
  const cen = centroid(p.parcelRing);
  p.edges.forEach((e, i) => {
    const street = parcel.streetEdges.includes(i);
    const [ax, ay, bx, by] = [X(e.a[0]), Y(e.a[1]), X(e.b[0]), Y(e.b[1])];
    if (street) out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#e63946" stroke-width="4.5" stroke-linecap="round"/>`);
    out.push(`<line class="edge-hit" data-edge="${i}" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="transparent" stroke-width="16" stroke-linecap="round"><title>Côté ${i + 1} — cliquer pour ${street ? 'retirer de' : 'ajouter à'} la voie</title></line>`);
    // pastille légèrement à l'extérieur
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = mx - X(cen[0]);
    const dy = my - Y(cen[1]);
    const l = Math.hypot(dx, dy) || 1;
    const cx = mx + (dx / l) * 13;
    const cy = my + (dy / l) * 13;
    out.push(`<g pointer-events="none"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8.5" fill="${street ? '#e63946' : '#ffffff'}" stroke="${street ? '#9d0208' : '#6b7280'}" stroke-width="1"/><text x="${cx.toFixed(1)}" y="${(cy + 3.6).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${street ? '#fff' : '#374151'}">${i + 1}</text></g>`);
  });

  // nord
  out.push(`<g transform="translate(${W - 22},24)" pointer-events="none"><path d="M0,-13 L5,5 L0,1 L-5,5 Z" fill="var(--plan-text)"/><text y="19" text-anchor="middle" font-size="10" font-weight="700" fill="var(--plan-text)">N</text></g>`);
  // échelle 5 m (ou 10 m)
  const bar = spanX > 40 ? 10 : 5;
  out.push(`<g transform="translate(14,${H - 12})" pointer-events="none"><line x2="${(bar * s).toFixed(1)}" stroke="var(--plan-text)" stroke-width="2"/><line y1="-4" y2="4" stroke="var(--plan-text)" stroke-width="2"/><line x1="${(bar * s).toFixed(1)}" x2="${(bar * s).toFixed(1)}" y1="-4" y2="4" stroke="var(--plan-text)" stroke-width="2"/><text x="${(bar * s + 6).toFixed(1)}" y="3.5" font-size="10" fill="var(--plan-text)">${bar} m</text></g>`);
  out.push('</svg>');
  return out.join('');
}
