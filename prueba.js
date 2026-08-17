/* ============================================================
   SUITE DE PRUEBAS DEL AGENTE — correr ANTES de cada deploy.

   Dos partes:
   1. LÓGICA (offline, sin clave): colapsar horas seguidas, claveNombre,
      decidir pedido, fechas. Gratis, sin tocar nada.
   2. CLASIFICADOR (contra Claude Haiku): necesita ANTHROPIC_API_KEY.
      Se pone en un archivo .env al lado (ANTHROPIC_API_KEY=sk-...).
      Cuesta centavos (una llamada barata por caso).

   Uso:  node prueba.js
   El .env NO se sube al repo (está en .gitignore).
   ============================================================ */
import fs from 'fs';

/* Cargar .env local sin dependencias: solo para la clave de pruebas. */
try{
  const env = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
  env.split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if(m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g,'');
  });
}catch(e){ /* sin .env: se saltean las pruebas del clasificador */ }

process.env.SIN_SERVIDOR = '1';   // importar sin levantar el puerto
const { clasificar, claveNombre, colapsarHorasSeguidas, decidirPedido, sumarDias, VERSION } = await import('./index.js');

let pass=0, fail=0; const fails=[];
const ok = (name, cond, extra) => { if(cond) pass++; else { fail++; fails.push(name + (extra?' — '+extra:'')); } };

console.log('Suite de pruebas · agente '+VERSION+'\n');

/* ---------- 1. LÓGICA (offline, sin clave) ---------- */
console.log('== Lógica (offline) ==');

ok('claveNombre saca GRUPAL', claveNombre('Camilo Contreras GRUPAL') === 'camilo contreras');
ok('claveNombre saca la sede', claveNombre('Pedro Gomez LOMAS') === 'pedro gomez');
ok('claveNombre saca INDIVIDUAL', claveNombre('Ana Ruiz individual') === 'ana ruiz');

const col = colapsarHorasSeguidas([
  { tel:'0981', nombre:'Rodri', sede:'lomas', hora:'15:00' },
  { tel:'0981', nombre:'Rodri', sede:'lomas', hora:'16:00' },
  { tel:'0982', nombre:'Ana',   sede:'elite', hora:'10:00' },
]);
ok('colapsar: 15+16 del mismo = 1, Ana aparte → 2 mensajes', col.length === 2, 'dio '+col.length);

const col2 = colapsarHorasSeguidas([
  { tel:'0981', nombre:'Leo', sede:'lomas', hora:'10:00' },
  { tel:'0981', nombre:'Leo', sede:'lomas', hora:'16:00' },
]);
ok('colapsar: 10 y 16 separadas → 2 mensajes', col2.length === 2, 'dio '+col2.length);

ok('pedido mismo día → celeste',
  decidirPedido({ ok:true, fecha:'2026-08-18', clases:[{sede:'lomas'}] }, '2026-08-18').accion === 'celeste');
ok('pedido a otro día → resolver',
  decidirPedido({ ok:true, fecha:'2026-08-18', clases:[{sede:'lomas'}] }, '2026-08-20').accion === 'resolver');
ok('pedido sin ubicar la clase → celeste',
  decidirPedido({ ok:false }, '2026-08-20').accion === 'celeste');
ok('pedido sin fecha destino → celeste',
  decidirPedido({ ok:true, fecha:'2026-08-18', clases:[{sede:'lomas'}] }, '').accion === 'celeste');

ok('sumarDias +1', sumarDias('2026-08-17',1) === '2026-08-18');
ok('sumarDias cruza el mes', sumarDias('2026-08-31',1) === '2026-09-01');

/* ---------- 2. CLASIFICADOR (necesita ANTHROPIC_API_KEY) ---------- */
const CASOS = [
  // Deben ser CONFIRMA (casos reales que fallaban + guardas)
  ['Hola si','confirma'], ['buenas! super','confirma'], ['Súper!','confirma'],
  ['Full','confirma'], ['Estoy','confirma'], ['Presente','confirma'],
  ['Holaaa confirmado!!','confirma'], ['Holi nos vemos','confirma'],
  ['Sii le metemos','confirma'], ['dale','confirma'], ['ok 👍','confirma'],
  ['confirmo mi clase, apenas pueda paso la transferencia','confirma'],
  // Deben ser CANCELA
  ['No no','cancela'], ['Holaa no','cancela'], ['mañana no puedo','cancela'], ['hoy no llego','cancela'],
  // Deben ser PEDIDO
  ['puedo cambiar al jueves?','pedido'], ['me uno el próximo miércoles','pedido'],
  // Deben seguir siendo NADA (REGRESIÓN: no deben volverse confirma/cancela)
  ['hola','nada'], ['gracias','nada'], ['si puedo mañana','nada'],
  ['si hay lugar','nada'], ['a qué hora?','nada'], ['buenas','nada'],
];

if(!process.env.ANTHROPIC_API_KEY){
  console.log('\n== Clasificador: SALTEADO (poné ANTHROPIC_API_KEY en un archivo .env) ==');
} else {
  console.log('\n== Clasificador (contra Claude Haiku) ==');
  const hoy = '2026-08-17';
  for(const [texto, esperado] of CASOS){
    let r;
    try{ r = await clasificar(texto, hoy); }
    catch(e){ ok('"'+texto+'"', false, 'ERROR '+e.message); continue; }
    const bien = r.tipo === esperado;
    ok('"'+texto+'" → '+esperado, bien, bien ? '' : 'dio '+r.tipo);
  }
}

console.log('\n'+(fail?'❌':'✅')+' '+pass+' OK · '+fail+' fallaron');
if(fails.length) console.log('Fallaron:\n - '+fails.join('\n - '));
process.exit(fail ? 1 : 0);
