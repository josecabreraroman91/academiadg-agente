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
        leerEstadoEntrega, claveEntrega, resumenEntregas,
        claveConfirmacion, filtrarYaEnviados,
        quienEs, _seedPruebaCompartido,
        fechaValida, sanearClasificacion, horasMencionadas, horaQueNoEsLaSuya, HORAS } = await import('./index.js');

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

/* ---------- Candado anti-duplicado del envío diario (etapa-5.1) ---------- */
ok('claveConfirmacion: misma persona/hora/sede → misma clave',
   claveConfirmacion('595981123456','Ana Ruiz','10:00','lomas') ===
   claveConfirmacion('0981 123-456','Ana Ruiz GRUPAL','10:00','LOMAS'),
   claveConfirmacion('0981 123-456','Ana Ruiz GRUPAL','10:00','LOMAS'));
ok('claveConfirmacion: distinta hora → distinta clave',
   claveConfirmacion('0981','Ana','10:00','lomas') !== claveConfirmacion('0981','Ana','11:00','lomas'));
ok('claveConfirmacion: mismo número, distinto nombre (hermanos) → distinta clave',
   claveConfirmacion('0981','Agos','10:00','elite') !== claveConfirmacion('0981','Benja','10:00','elite'));
ok('claveConfirmacion: sin caracteres que Firebase prohíbe',
   !/[.#$/\[\]]/.test(claveConfirmacion('0981','Ana. Ruiz','10:00','lo/mas')));

/* Simula el segundo disparo: 3 alumnos, 2 ya salieron hoy → solo 1 se manda */
const _ya = {};
_ya[claveConfirmacion('0981','Ana','10:00','lomas')] = '2026-08-19T18:00:00Z';
_ya[claveConfirmacion('0982','Beto','11:00','elite')] = '2026-08-19T18:00:00Z';
const filt = filtrarYaEnviados([
  { tel:'0981', nombre:'Ana',  hora:'10:00', sede:'lomas' },  // ya enviado → salta
  { tel:'0982', nombre:'Beto', hora:'11:00', sede:'elite' },  // ya enviado → salta
  { tel:'0983', nombre:'Caro', hora:'09:00', sede:'lomas' },  // nuevo → se manda
], _ya);
ok('candado: en el 2º disparo solo queda 1 por mandar', filt.aEnviar.length===1 && filt.aEnviar[0].nombre==='Caro',
   JSON.stringify(filt.aEnviar.map(x=>x.nombre)));
ok('candado: reporta 2 salteados', filt.saltados.length===2, 'saltó '+filt.saltados.length);
ok('candado: el que se manda lleva su _clave para marcarlo después', !!filt.aEnviar[0]._clave);

/* Primer disparo con lista vacía de enviados → se mandan todos */
const filt0 = filtrarYaEnviados([
  { tel:'0981', nombre:'Ana', hora:'10:00', sede:'lomas' },
  { tel:'0982', nombre:'Beto', hora:'11:00', sede:'elite' },
], {});
ok('candado: primer disparo manda a todos', filt0.aEnviar.length===2 && filt0.saltados.length===0);

/* Duplicado EXACTO dentro del mismo lote → el segundo se salta */
const filtDup = filtrarYaEnviados([
  { tel:'0981', nombre:'Ana', hora:'10:00', sede:'lomas' },
  { tel:'0981', nombre:'Ana', hora:'10:00', sede:'lomas' },
], {});
ok('candado: duplicado exacto en el mismo lote se manda una sola vez',
   filtDup.aEnviar.length===1 && filtDup.saltados.length===1);

/* Número compartido, dos hermanos distintos → NO se saltea al segundo */
const filtHnos = filtrarYaEnviados([
  { tel:'0981', nombre:'Agos',  hora:'10:00', sede:'elite' },
  { tel:'0981', nombre:'Benja', hora:'10:00', sede:'elite' },
], {});
ok('candado: número compartido manda a los dos hermanos', filtHnos.aEnviar.length===2);

/* ---------- Número de familia: no atribuir a un solo hermano por el contacto (etapa-5.2) ---------- */
const TEL = '595981954957';                 // colaTel = 81954957
const HERMANOS = { '81954957': [{nombre:'Ami Nakagoe'}, {nombre:'Noriyuki Nakagoe'}] };

/* Caso José: hoy le mandamos confirmación a LOS DOS. El contacto trae solo a Ami.
   Antes resolvía todo a Ami (y Noriyuki se perdía); ahora queda compartido. */
_seedPruebaCompartido({ porTel:HERMANOS, enviados:new Map([['81954957','Ami Nakagoe|Noriyuki Nakagoe']]) });
const qFam = await quienEs(TEL, 'Ami Nakagoe Mama de sus hijos');
ok('familia activa (a los 2 les mandamos hoy) → NO resuelve por contacto, queda compartido',
   qFam.varios===true && !qFam.encontrado && qFam.familiaActiva===true, JSON.stringify(qFam));

/* Si hoy le mandamos a UN solo hermano, sí se resuelve a ese (por la confirmación). */
_seedPruebaCompartido({ porTel:HERMANOS, enviados:new Map([['81954957','Ami Nakagoe']]) });
const qUno = await quienEs(TEL, 'Ami Nakagoe Mama de sus hijos');
ok('a un solo hermano le mandamos hoy → resuelve a ese (por la confirmación)',
   qUno.encontrado===true && qUno.alumno && qUno.alumno.nombre==='Ami Nakagoe' && !!qUno.porLaConfirmacion, JSON.stringify(qUno));

/* Sin envíos hoy → se conserva la resolución por el nombre del contacto (no rompimos eso). */
_seedPruebaCompartido({ porTel:HERMANOS, enviados:new Map() });
const qCont = await quienEs(TEL, 'Ami Nakagoe Mama');
ok('sin envíos hoy → sigue resolviendo por el nombre del contacto (no se rompió)',
   qCont.encontrado===true && qCont.alumno && qCont.alumno.nombre==='Ami Nakagoe' && !!qCont.porNombreDelContacto, JSON.stringify(qCont));

/* ---------- Sanear lo que devuelve la IA (casos del 24/08/2026) ---------- */
/* El renglón real que rompió todo: la fecha venía con basura de formato adentro. */
ok('fecha con basura de formato → vacía', fechaValida('2026-08-25</fecha></invoke>') === '');
ok('fecha buena pasa', fechaValida('2026-08-25') === '2026-08-25');
ok('fecha con espacios se limpia', fechaValida('  2026-08-25 ') === '2026-08-25');
ok('fecha que no existe (30 de febrero) → vacía', fechaValida('2026-02-30') === '');
ok('mes 13 → vacía', fechaValida('2026-13-01') === '');
ok('texto suelto → vacía', fechaValida('mañana') === '');
ok('nulo → vacía', fechaValida(null) === '');
ok('formato dd/mm → vacía', fechaValida('25/08/2026') === '');

const sc = sanearClasificacion({ tipo:'confirma', fecha:'2026-08-25</fecha></invoke>', hasta:'x', sobreOtraPersona:1 });
ok('sanear: limpia la fecha rota', sc.fecha === '', JSON.stringify(sc));
ok('sanear: limpia el hasta roto', sc.hasta === '');
ok('sanear: conserva el tipo válido', sc.tipo === 'confirma');
ok('sanear: sobreOtraPersona queda booleano', sc.sobreOtraPersona === true);
ok('sanear: tipo inventado → nada', sanearClasificacion({ tipo:'cualquiera' }).tipo === 'nada');
ok('sanear: sin tipo → nada', sanearClasificacion({}).tipo === 'nada');
ok('sanear: no rompe una clasificación buena',
   sanearClasificacion({tipo:'pedido', fecha:'2026-08-25'}).fecha === '2026-08-25');

/* ---------- Guarda de hora: el falso presente (caso Elio, 24/08) ---------- */
const jsonH = t => JSON.stringify(horasMencionadas(t));
ok('"Mañana 17 hs puedo !" → [17]', jsonH('Mañana 17 hs puedo !') === '[17]', jsonH('Mañana 17 hs puedo !'));
ok('"confirmo 17 Hrs en Lomas" → [17]', jsonH('Si, confirmo 17 Hrs en Lomas Padel') === '[17]');
ok('"nos vemos a las 8:00" → [8]', jsonH('nos vemos a las 8:00') === '[8]');
ok('"a las 5 de la tarde" → [17]', jsonH('puedo a las 5 de la tarde') === '[17]');
ok('"entrenar entre 4" → [] (son personas, no las 4)', jsonH('podemos entrenar entre 4?') === '[]', jsonH('podemos entrenar entre 4?'));
ok('"dale" → []', jsonH('dale') === '[]');
ok('"Si, nos vemos!" → []', jsonH('Si, nos vemos!') === '[]');

const claseA = (...hs) => ({ ok:true, clases: hs.map(h => ({ horaIdx: HORAS.indexOf(h+':00') })) });
ok('CASO ELIO: clase 15:00 + "Mañana 17 hs puedo" → es otra hora',
   !!horaQueNoEsLaSuya('Mañana 17 hs puedo !', claseA(15)));
ok('CASO ROSTI: clase 17:00 + "confirmo 17 hrs" → NO es otra hora (sigue confirma)',
   horaQueNoEsLaSuya('Si, confirmo 17 Hrs en Lomas Padel', claseA(17)) === null);
ok('CASO PETY: clase 8:00 + "nos vemos a las 8:00" → sigue confirma',
   horaQueNoEsLaSuya('Hola si señor nos vemos a las 8:00', claseA(8)) === null);
ok('bloque 15+16 + "16 hs" → sigue confirma',
   horaQueNoEsLaSuya('confirmo 16 hs', claseA(15,16)) === null);
ok('bloque 15+16 + "18 hs" → es otra hora',
   !!horaQueNoEsLaSuya('puedo 18 hs', claseA(15,16)));
ok('sin hora nombrada → no toca nada', horaQueNoEsLaSuya('dale', claseA(15)) === null);
ok('sin clase ubicada → no toca nada', horaQueNoEsLaSuya('puedo 17 hs', {ok:false}) === null);
ok('CASO SEBASTIAN: "entre 4" no degrada la confirmación',
   horaQueNoEsLaSuya('Sii le metemos, podemos entrenar entre 4?', claseA(16)) === null);

/* ---------- 2. CLASIFICADOR (necesita ANTHROPIC_API_KEY) ---------- */
const CASOS = [
  // Deben ser CONFIRMA (casos reales que fallaban + guardas)
  ['Hola si','confirma'], ['buenas! super','confirma'], ['Súper!','confirma'],
  ['Full','confirma'], ['Estoy','confirma'], ['Presente','confirma'],
  ['Holaaa confirmado!!','confirma'], ['Holi nos vemos','confirma'],
  ['Sii le metemos','confirma'], ['dale','confirma'], ['ok 👍','confirma'],
  ['confirmo mi clase, apenas pueda paso la transferencia','confirma'],
  // Casos reales del 24/08 (Joaquín, Veronica, Jorge): el clasificador ya los lee
  // bien — lo que fallaba era el padrón. Quedan acá para que no se rompan nunca.
  ['Buenas, si si','confirma'], ['Si','confirma'], ['Si, nos vemos!','confirma'],
  ['A fulll','confirma'],
  // Deben ser CANCELA
  ['No no','cancela'], ['Holaa no','cancela'], ['mañana no puedo','cancela'], ['hoy no llego','cancela'],
  // Deben ser PEDIDO
  ['puedo cambiar al jueves?','pedido'], ['me uno el próximo miércoles','pedido'],
  // Deben seguir siendo NADA (REGRESIÓN: no deben volverse confirma/cancela)
  ['hola','nada'], ['gracias','nada'], ['si puedo mañana','nada'],
  ['si hay lugar','nada'], ['a qué hora?','nada'], ['buenas','nada'],

  /* ---- MENSAJES REALES DEL 03/09/2026 ----
     Los 21 alumnos que quedaron en celeste el viernes 04/09. Se revisaron uno
     por uno en Kapso con José y se sabe qué quería decir cada uno. Estos casos
     estan aca para que no se rompa lo que ya funciona y para ver que falta. */
  ['ok gracias','confirma'],            // Danna Benitez: contesta asi hace un mes
  ['ok','confirma'],                    // idem
  ['Holii','nada'],                     // Magali: saludo suelto, no deberia ensuciar
  ['Confirmado','confirma'],            // Magali, el mensaje siguiente
  ['Exelente!! Gracias 🙏','confirma'], // Aracely: es el viernes que ella misma pidio
  ['Fíjate esto','nada'],               // Yanina: cambio de tema, hablaba de un pago
  ['Ya te completo','nada'],            // Cesar: ES DE PLATA. Hoy da confirma y no debe
  ['👍 si preswnte los dos','confirma'],// Ami: confirma por los dos hermanos
  ['Siiii','confirma'],                 // Andrea Mongelos
  ['Hola! Si!','confirma'],             // Elisa Kim
  ['A las 11 se puede ?','pedido'],     // Sol Godoy: pide otra hora
  ['Mañana no llego 🥲','cancela'],     // Gregory Segatel
  ['mañana no','cancela'],              // Mariana Salsamendi
  ['No llego profe!','cancela'],        // Ignacio Moreno
  ['Buenas mañana no','cancela'],       // Lucia Barrios
  ['No podré ir a las 14','cancela'],   // Flavia Santillan
  ['yo si, José no xq está de viaje','nada'],  // Andrea: reparte distinto, lo mira una persona
  ['Yo si José nooo','nada'],                  // idem
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
