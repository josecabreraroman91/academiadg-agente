/* ============================================================
   BANCO DEL PADRON DEL AGENTE — correr despues de tocar padron()
   o padronPorNombre().

   Intercepta fetch y le sirve al agente los datos REALES del respaldo:
   padron_v1 del backup del 26/08 y alumnos_v1 del respaldo de Drive.
   No toca la red ni produccion.

   Uso:  node prueba-padron.js
   ============================================================ */
import fs from 'fs';

const BACKUP = 'C:/Users/j0sec/Downloads/BACKUP-ANTES-2026-08-26.json';
const RESP   = 'G:/Mi unidad/BACKUPS ADG/FIREBASE/2026-08-26';

const bk        = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
const PADRON_V1 = bk.padron_v1;
const ALUMNOS_V1= JSON.parse(fs.readFileSync(RESP + '/alumnos_v1.json', 'utf8'));
const DIA       = JSON.parse(fs.readFileSync(RESP + '/dia.json', 'utf8'));

/* --- que le contesta Firebase al agente --- */
let sinMaestro = false;          // para probar la red de la planilla
const real = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('identitytoolkit'))
    return { ok:true, status:200, json: async () => ({ idToken:'token-de-prueba', expiresIn:'3600' }) };
  const m = u.match(/\/([^/?]+)\.json/);
  const ruta = m ? decodeURIComponent(m[1]) : '';
  const cuerpo =
      ruta === 'padron_v1'  ? (sinMaestro ? null : PADRON_V1)
    : ruta === 'alumnos_v1' ? ALUMNOS_V1
    : null;
  return { ok:true, status:200, json: async () => cuerpo };
};

process.env.SIN_SERVIDOR    = '1';
process.env.AGENTE_PASSWORD = process.env.AGENTE_PASSWORD || 'de-prueba';

const { padronPorNombre, quienEs, armarFilasDelDia } = await import('./index.js');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, extra) => { if (c) { pass++; console.log('  OK   ' + n + (extra ? '  · ' + extra : '')); }
                              else { fail++; fails.push(n + (extra ? ' — ' + extra : '')); console.log('  FALLA ' + n + (extra ? '  · ' + extra : '')); } };
const norm = s => String(s||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();

console.log('\n== 1. El tipo y el ID salen del MAESTRO ==');
const pad = await padronPorNombre();
const fichaHan = pad[norm('Gabriel Han')];
ok('Gabriel Han sale con el tipo del maestro (G)', fichaHan && fichaHan.tipo === 'G',
   fichaHan ? 'tipo:' + fichaHan.tipo + ' id:' + fichaHan.id : 'sin ficha');
ok('y con su ID real', fichaHan && fichaHan.id === 'A0772', fichaHan ? fichaHan.id : '-');

console.log('\n== 2. LOS PARES A PROPOSITO (el bug de Gs 1.330.000) ==');
const pares = Object.values(PADRON_V1.alumnos)
  .filter(a => a && a.nombre && /\b(individual|grupal|dual)\b/i.test(a.nombre));
let paresOk = 0, paresMal = [];
pares.forEach(a => {
  const f = pad[norm(a.nombre)];
  if (f && f.id === (a.id || '')) paresOk++;
  else paresMal.push(a.nombre + ' (esperaba ' + a.id + ', dio ' + (f ? f.id : 'nada') + ')');
});
ok('cada par encuentra SU PROPIA ficha, no la del hermano', paresMal.length === 0,
   paresOk + '/' + pares.length + (paresMal.length ? ' · fallan: ' + paresMal.slice(0,3).join(' | ') : ''));

const lg = pad[norm('Rodrigo Lee GRUPAL')], li = pad[norm('Rodrigo Lee INDIVIDUAL')];
ok('Rodrigo Lee GRUPAL y INDIVIDUAL tienen IDs distintos',
   lg && li && lg.id && li.id && lg.id !== li.id,
   (lg ? lg.id + '/' + (lg.tipo||'-') : '?') + ' vs ' + (li ? li.id + '/' + (li.tipo||'-') : '?'));

console.log('\n== 3. Los 14 que solo estan en la planilla siguen apareciendo ==');
const enMaestro = new Set(Object.values(PADRON_V1.alumnos).filter(a=>a&&a.nombre).map(a=>norm(a.nombre)));
const huerfanos = ['Marilina Raymondy','Araceli Aranda','Manuel Marco','Niklas Harkensee','Emma Damus'];
let hOk = 0; const hMal = [];
huerfanos.forEach(n => { if (enMaestro.has(norm(n))) return;      // por si ya lo subieron
                         if (pad[norm(n)]) hOk++; else hMal.push(n); });
ok('la planilla los rellena', hMal.length === 0, hOk + ' encontrados' + (hMal.length ? ' · faltan: ' + hMal.join(', ') : ''));

console.log('\n== 4. WhatsApp sigue reconociendo por telefono ==');
/* OJO: que un numero devuelva varios candidatos NO es un fallo. Es el diseño:
   hay numeros compartidos (hermanos, madre e hijo) y el agente NO adivina —
   los devuelve todos y una persona decide. El fallo de verdad seria que el
   numero no caiga en NADIE. */
const conTel = Object.values(PADRON_V1.alumnos).filter(a => a && a.tel && String(a.tel).replace(/\D/g,'').length >= 8);
let directo = 0, mismaPers = 0, compartido = 0; const perdidos = [];
for (const a of conTel) {
  const r = await quienEs(String(a.tel), '');
  if (!r.candidatos.length) { perdidos.push(a.nombre); continue; }
  if (r.encontrado && r.mismaPersona) mismaPers++;
  else if (r.encontrado) directo++;
  else compartido++;
}
ok('ningun numero del padron queda sin dueño', perdidos.length === 0,
   'directos ' + directo + ' · misma persona ' + mismaPers + ' · compartidos ' + compartido +
   (perdidos.length ? ' · PERDIDOS: ' + perdidos.slice(0,3).join(', ') : ''));
const han = Object.values(PADRON_V1.alumnos).find(a => a && /gabriel han/i.test(a.nombre||''));
const rHan = await quienEs(String(han.tel), '');
ok('el numero de Gabriel Han cae en Gabriel Han', rHan.encontrado && /gabriel han/i.test(rHan.alumno.nombre),
   rHan.encontrado ? rHan.alumno.nombre + ' (' + rHan.candidatos.length + ' candidato/s)' : 'no lo encontro');

console.log('\n== 5. La plata: el cierre del dia con datos reales ==');
const fechas = Object.keys(DIA).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort();
let filasTot = 0, sinTipo = 0, sinId = 0;
for (const f of fechas) {
  const r = await armarFilasDelDia(f, DIA[f], pad);
  filasTot += r.filas.length;
  r.filas.forEach(fila => { if (!fila[5]) sinTipo++; if (!fila[9]) sinId++; });
}
ok('el cierre arma filas para los ' + fechas.length + ' dias', filasTot > 0, filasTot + ' filas');
console.log('       filas sin tipo: ' + sinTipo + '   filas sin ID: ' + sinId);

console.log('\n== 6. Si el maestro no contesta, la planilla es la red ==');
sinMaestro = true;
const { padronPorNombre: pp2 } = await import('./index.js?red=1');
const padRed = await pp2();
ok('sin padron_v1 el agente igual arma el padron', Object.keys(padRed).length > 500,
   Object.keys(padRed).length + ' claves');
ok('y ahi el tipo sale de la planilla', !!padRed[norm('Gabriel Han')],
   padRed[norm('Gabriel Han')] ? 'tipo:' + padRed[norm('Gabriel Han')].tipo : 'sin ficha');
sinMaestro = false;

console.log('\n' + (fail ? 'FALLARON ' + fail : 'TODO OK') + ' · ' + pass + ' pasaron');
if (fails.length) { console.log(''); fails.forEach(f => console.log('  - ' + f)); }
global.fetch = real;
process.exit(fail ? 1 : 0);
