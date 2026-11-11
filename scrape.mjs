// Lee los huecos libres de las dos páginas públicas de reserva de Google Calendar
// y los envía al webhook de n8n. No contiene secretos: el webhook y el token
// llegan por variables de entorno (secretos de GitHub).
import { chromium } from 'playwright';

const PAGES = process.env.PAGES_JSON
  ? JSON.parse(process.env.PAGES_JSON)
  : [
      { tipo: 'ginecologia', url: 'https://calendar.app.google/VNeySxyZ1qbv5AW59', duracion_min: 30 },
      { tipo: '4d', url: 'https://calendar.app.google/HnsMhcUomZ4fg3yM9', duracion_min: 60 },
    ];

const VIEWS = Number(process.env.VIEWS || 4); // semanas a leer (4 = 28 días)
const DRY_RUN = process.env.DRY_RUN === '1';
const { WEBHOOK_URL, WEBHOOK_TOKEN } = process.env;

if (!DRY_RUN && (!WEBHOOK_URL || !WEBHOOK_TOKEN)) {
  console.error('Faltan los secretos WEBHOOK_URL y/o WEBHOOK_TOKEN');
  process.exit(1);
}

function hoyMadrid() {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

// Se ejecuta dentro de la página: devuelve las cabeceras de día (7 números alineados)
// y los botones de hora con su posición horizontal.
function leerVista() {
  const R = (e) => e.getBoundingClientRect();
  const visibles = [...document.querySelectorAll('*')].filter((e) => {
    const r = R(e);
    return e.children.length === 0 && /^\d{1,2}$/.test(e.textContent.trim()) && r.width > 0 && r.height > 0;
  }).map((e) => ({ d: Number(e.textContent.trim()), x: Math.round(R(e).x + R(e).width / 2), y: Math.round(R(e).y) }));

  // Cabecera = grupo de exactamente 7 números en la misma fila y repartidos en horizontal
  const grupos = new Map();
  for (const n of visibles) {
    const k = Math.round(n.y / 8);
    grupos.set(k, [...(grupos.get(k) || []), n]);
  }
  let cabecera = null;
  for (const g of grupos.values()) {
    if (g.length === 7) {
      const xs = g.map((n) => n.x);
      if (Math.max(...xs) - Math.min(...xs) > 500) { cabecera = g.sort((a, b) => a.x - b.x); break; }
    }
  }
  const botones = [...document.querySelectorAll('button')]
    .filter((b) => /^\d{2}:\d{2}$/.test(b.textContent.trim()))
    .map((b) => ({ h: b.textContent.trim(), x: Math.round(R(b).x + R(b).width / 2) }));
  return { cabecera, botones };
}

function pulsarSiguiente() {
  const b = [...document.querySelectorAll('button')].find((el) => {
    const l = (el.getAttribute('aria-label') || '') + ' ' + el.textContent;
    return /siguiente|next/i.test(l) && !/mes|month/i.test(l);
  });
  if (!b) return false;
  b.click();
  return true;
}

async function leerPagina(browser, { tipo, url, duracion_min }) {
  const context = await browser.newContext({
    locale: 'es-ES', timezoneId: 'Europe/Madrid', viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.body.innerText.includes('Selecciona una hora') || document.body.innerText.includes('Select a time'), null, { timeout: 30000 });

    let { y, m } = hoyMadrid();
    let prev = 0;
    const huecos = [];
    for (let v = 0; v < VIEWS; v++) {
      const vista = await page.evaluate(leerVista);
      if (!vista.cabecera) throw new Error('No se encontró la cabecera de 7 días (la página ha cambiado o no ha cargado)');
      const dias = vista.cabecera.map((n) => {
        if (n.d < prev) { m += 1; if (m > 12) { m = 1; y += 1; } }
        prev = n.d;
        return { ...n, fecha: `${y}-${String(m).padStart(2, '0')}-${String(n.d).padStart(2, '0')}` };
      });
      for (const b of vista.botones) {
        const dia = dias.reduce((a, c) => (Math.abs(c.x - b.x) < Math.abs(a.x - b.x) ? c : a));
        if (Math.abs(dia.x - b.x) > 40) throw new Error(`Botón ${b.h} no encaja con ninguna columna`);
        huecos.push({ fecha: dia.fecha, hora: b.h });
      }
      if (v < VIEWS - 1) {
        const primero = vista.cabecera[0].d;
        const ok = await page.evaluate(pulsarSiguiente);
        if (!ok) throw new Error('No se encontró el botón "día siguiente"');
        // Espera a que cambie la primera fecha de la cabecera (máx. ~6 s)
        let cambiado = false;
        for (let i = 0; i < 15 && !cambiado; i++) {
          await page.waitForTimeout(400);
          const v2 = await page.evaluate(leerVista);
          cambiado = !!v2.cabecera && v2.cabecera[0].d !== primero;
        }
        if (!cambiado) throw new Error('La vista no avanzó de semana');
        await page.waitForTimeout(500);
      }
    }
    // Sin duplicados y ordenado
    const unicos = [...new Map(huecos.map((h) => [`${h.fecha} ${h.hora}`, h])).values()]
      .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
    return { tipo, duracion_min, ok: true, huecos: unicos };
  } catch (e) {
    return { tipo, duracion_min, ok: false, error: String(e.message || e), huecos: [] };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
const resultados = [];
for (const p of PAGES) resultados.push(await leerPagina(browser, p));
await browser.close();

const payload = { generado_en: new Date().toISOString(), zona: 'Europe/Madrid', paginas: resultados };
console.log(JSON.stringify(payload, null, 2));

if (!resultados.some((r) => r.ok)) {
  console.error('Ninguna página se leyó bien: no se envía nada');
  process.exit(1);
}
if (DRY_RUN) process.exit(0);

let enviado = false;
for (let intento = 1; intento <= 2 && !enviado; intento++) {
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': WEBHOOK_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    enviado = true;
    console.log('Enviado a n8n');
  } catch (e) {
    console.error(`Intento ${intento} fallido: ${e.message}`);
  }
}
if (!enviado) process.exit(1);
