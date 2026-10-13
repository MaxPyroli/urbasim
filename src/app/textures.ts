export type FacadeKind = 'logement' | 'bureaux' | 'commerce' | 'parking' | 'attique' | 'mitoyen';

const SIZE = 256;
const cache = new Map<string, HTMLCanvasElement>();

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  return [c, c.getContext('2d')!];
}

function noise(ctx: CanvasRenderingContext2D, alpha: number): void {
  // grain léger pour casser l'aplat
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? 0 : 255},${Math.random() < 0.5 ? 0 : 255},${Math.random() < 0.5 ? 0 : 255},${alpha})`;
    ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 2, 2);
  }
}

function window_(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frame: string, glass: [string, string]): void {
  ctx.fillStyle = frame;
  ctx.fillRect(x - 5, y - 5, w + 10, h + 10);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, glass[0]);
  g.addColorStop(1, glass[1]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = frame;
  ctx.fillRect(x + w / 2 - 2, y, 4, h); // meneau
  ctx.fillRect(x, y + h * 0.62, w, 4); // traverse
}

/**
 * Une travée = une largeur de façade × une hauteur d'étage, répétée par le matériau.
 * Les textures sont générées au chargement : aucune image externe.
 */
export function facadeTexture(kind: FacadeKind): HTMLCanvasElement {
  const hit = cache.get(kind);
  if (hit) return hit;
  const [c, ctx] = canvas();
  const glass: [string, string] = ['#7fa6c4', '#3f6685'];

  if (kind === 'mitoyen') {
    ctx.fillStyle = '#cfc7b6';
    ctx.fillRect(0, 0, SIZE, SIZE);
    noise(ctx, 0.04);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, SIZE - 6, SIZE, 6);
  } else if (kind === 'attique') {
    ctx.fillStyle = '#8f9aa3';
    ctx.fillRect(0, 0, SIZE, SIZE);
    noise(ctx, 0.05);
    window_(ctx, 52, 36, 152, 170, '#4f5b63', ['#a9c8dc', '#5c8099']);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, SIZE - 8, SIZE, 8);
  } else if (kind === 'commerce') {
    ctx.fillStyle = '#d9d2c1';
    ctx.fillRect(0, 0, SIZE, SIZE);
    noise(ctx, 0.04);
    // vitrine pleine hauteur
    ctx.fillStyle = '#2e3a44';
    ctx.fillRect(14, 30, SIZE - 28, SIZE - 30);
    const g = ctx.createLinearGradient(0, 30, 0, SIZE);
    g.addColorStop(0, '#9cc2dc');
    g.addColorStop(1, '#4b7692');
    ctx.fillStyle = g;
    ctx.fillRect(22, 40, SIZE - 44, SIZE - 52);
    ctx.fillStyle = '#2e3a44';
    ctx.fillRect(SIZE / 2 - 3, 40, 6, SIZE - 52);
    ctx.fillStyle = '#e07a5f'; // bandeau enseigne
    ctx.fillRect(14, 8, SIZE - 28, 18);
  } else if (kind === 'parking') {
    ctx.fillStyle = '#b9b2a2';
    ctx.fillRect(0, 0, SIZE, SIZE);
    noise(ctx, 0.05);
    ctx.fillStyle = '#2b2f33';
    ctx.fillRect(30, 70, SIZE - 60, SIZE - 70);
    ctx.fillStyle = '#4a5157';
    for (let i = 0; i < 7; i++) ctx.fillRect(34, 78 + i * 24, SIZE - 68, 10);
  } else {
    // logement / bureaux
    const office = kind === 'bureaux';
    ctx.fillStyle = office ? '#cdd3d6' : '#ebe3d0';
    ctx.fillRect(0, 0, SIZE, SIZE);
    noise(ctx, 0.04);
    if (office) {
      // bandeau vitré continu
      ctx.fillStyle = '#39454d';
      ctx.fillRect(0, 44, SIZE, 150);
      const g = ctx.createLinearGradient(0, 44, 0, 194);
      g.addColorStop(0, '#9cc2dc');
      g.addColorStop(1, '#4b7692');
      ctx.fillStyle = g;
      ctx.fillRect(0, 52, SIZE, 134);
      ctx.fillStyle = '#39454d';
      ctx.fillRect(SIZE / 2 - 3, 52, 6, 134);
    } else {
      // porte-fenêtre + allège
      window_(ctx, 66, 40, 124, 168, '#f4f1ea', glass);
      ctx.fillStyle = '#6b6f73'; // garde-corps
      ctx.fillRect(56, 168, 144, 6);
      for (let x = 60; x < 200; x += 14) ctx.fillRect(x, 168, 3, 40);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(40, 212, 176, 6);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.16)'; // nez de dalle
    ctx.fillRect(0, SIZE - 8, SIZE, 8);
  }
  cache.set(kind, c);
  return c;
}
