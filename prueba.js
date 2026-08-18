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
const { clasificar, claveNombre, colapsarHorasSeguidas, decidirPedido, sumarDias, VERSION,
        diaDeFecha, diasEntreISO, ubicarEnSemana, _cacheCalendarioPrueba,
        leerEstadoEntrega, claveEntrega, resumenEntregas } = await import('./index.js');

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

/* Arreglo 3 — fechas y fallback a la grilla SEMANA */
ok('diaDeFecha 2026-08-18 = MARTES', diaDeFecha('2026-08-18') === 'MARTES');
ok('diaDeFecha 2026-08-23 = DOMINGO', diaDeFecha('2026-08-23') === 'DOMINGO');
ok('diasEntreISO lunes→martes = 1', diasEntreISO('2026-08-17','2026-08-18') === 1);
ok('diasEntreISO cruza mes', diasEntreISO('2026-08-31','2026-09-02') === 2);

/* Cargo un calendario de prueba (sin tocar Firebase) y verifico la ubicación en SEMANA */
_cacheCalendarioPrueba({
  lunes: '2026-08-17',
  sedesPorDia: { MARTES: [ {key:'lomas', profes:['JM','VA']}, {key:'elite', profes:['RS','ChG']} ] },
  semana: {
    'MARTES|lomas|0|9|1': { nombre:'Eleonora Scavone' },
    'MARTES|elite|0|2|0': { nombre:'Veronica Valdiglesias' },
    'LUNES|lomas|1|0|0':  { nombre:'Otro Alumno' },
  },
  semanaProxima: { 'MARTES|lomas|1|3|0': { nombre:'Prox Semana' } },
});
const uEle = await ubicarEnSemana('Eleonora Scavone', '2026-08-18');
ok('SEMANA ubica a Eleonora (lomas, hora 9, profe JM)',
   uEle.length===1 && uEle[0].sede==='lomas' && uEle[0].horaIdx===9 && uEle[0].profe==='JM',
   JSON.stringify(uEle));
const uVer = await ubicarEnSemana('Veronica Valdiglesias', '2026-08-18');
ok('SEMANA ubica a Veronica (elite, hora 2, profe RS)',
   uVer.length===1 && uVer[0].sede==='elite' && uVer[0].horaIdx===2 && uVer[0].profe==='RS',
   JSON.stringify(uVer));
ok('SEMANA no ubica a quien no está', (await ubicarEnSemana('Nadie X', '2026-08-18')).length===0);
ok('SEMANA no ubica en DOMINGO', (await ubicarEnSemana('Eleonora Scavone', '2026-08-23')).length===0);
const uProx = await ubicarEnSemana('Prox Semana', '2026-08-25');   // martes de la semana que viene
ok('SEMANA usa semanaProxima (7-12 días)', uProx.length===1 && uProx[0].sede==='lomas', JSON.stringify(uProx));
ok('SEMANA no ubica fuera de las 2 semanas cargadas', (await ubicarEnSemana('Eleonora Scavone', '2026-09-30')).length===0);

/* ---------- Reporte de entregas por Meta (etapa-5.0) ---------- */
const evFalla = leerEstadoEntrega('whatsapp.message.failed', { message:{
  id:'wamid.HBgLABC=', to:'595981111111',
  kapso:{ status:'failed', statuses:[{ status:'failed',
    errors:[{ code:131047, message:'More than 24 hours have passed since the recipient last replied' }] }] } } });
ok('estado failed → esEstado + fallo', evFalla.esEstado && evFalla.estado==='fallo', JSON.stringify(evFalla));
ok('estado failed → motivo con el código 131047', /131047/.test(evFalla.motivo||''), evFalla.motivo);
ok('estado failed → id y tel', evFalla.id==='wamid.HBgLABC=' && evFalla.tel==='595981111111');

const evEntreg = leerEstadoEntrega('whatsapp.message.delivered', { message:{ id:'wamid.X', to:'595', kapso:{ status:'delivered' } } });
ok('estado delivered → entregado', evEntreg.esEstado && evEntreg.estado==='entregado');

ok('un mensaje entrante NO es estado', leerEstadoEntrega('whatsapp.message.received', { message:{ text:{ body:'hola' } } }).esEstado === false);

ok('claveEntrega cambia el punto y el igual', claveEntrega('wamid.HBgL=') === 'wamid_HBgL_');

const rep = resumenEntregas({
  a:{ nombre:'Ana',  tel:'1', fecha:'2026-08-18', estado:'entregado' },
  b:{ nombre:'Beto', tel:'2', fecha:'2026-08-18', estado:'fallo', motivo:'sin WhatsApp' },
  c:{ nombre:'Cami', tel:'3', fecha:'2026-08-18', estado:'aceptado' },
  d:{ nombre:'Zoe',  tel:'4', fecha:'2026-08-17', estado:'fallo' },   // otro día: se filtra
}, '2026-08-18');
ok('resumen: 1 llegó, 1 no llegó, 1 sin confirmar',
   rep.llegaron===1 && rep.noLlego.length===1 && rep.sinConfirmar.length===1, JSON.stringify(rep));
ok('resumen filtra por fecha (total 3)', rep.total===3, 'total '+rep.total);
ok('resumen: el que no llegó trae nombre y motivo',
   rep.noLlego[0].nombre==='Beto' && rep.noLlego[0].motivo==='sin WhatsApp');

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
