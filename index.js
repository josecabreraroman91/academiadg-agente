/* ============================================================
   AGENTE DE ACADEMIA DG — ETAPA 2

   Por cada mensaje que llega:
     1. Busca de qué alumno es ese teléfono, en el padrón
     2. Le pide a Claude que lo clasifique
     3. UBICA LA CLASE en la copia del día
     4. ESCRIBE EL RENGLÓN EN LA LIBRETA

   SIGUE SIN CONTESTARLE A NINGÚN ALUMNO. Esa parte es la Etapa 3.

   ⚠️ A PARTIR DE ACÁ HAY CONSECUENCIAS REALES.
   El calendario lee la libreta y la aplica SOLO, sin esperar aprobación:
   un "cancela" saca al alumno de la grilla y lo marca ausente. Es el
   comportamiento que ya existe hoy; no lo cambia este servidor.

   ⚠️ NO DEJAR PRENDIDO EL FLUJO DE KAPSO AL MISMO TIEMPO.
   Los dos escriben en la misma libreta y cada mensaje quedaría anotado
   dos veces. El interruptor está arriba a la izquierda en Flujos de trabajo.

   Solo se anota si se sabe DE QUIÉN es el mensaje. Sin alumno no hay
   renglón: un renglón sin nombre no lo puede aplicar nadie.
   ============================================================ */

/* La versión se muestra en la pantalla y en la dirección de salud. Sirve para
   saber de un vistazo qué está corriendo de verdad, sin tener que adivinar:
   Railway a veces vuelve a levantar una versión vieja y no se nota. */
const VERSION = 'etapa-2.3';

import express from 'express';
import crypto from 'crypto';

const app = express();
const PUERTO   = process.env.PORT || 3000;
const SECRETO  = process.env.WEBHOOK_SECRET || '';
const CLAVE_IA = process.env.ANTHROPIC_API_KEY || '';

/* La clave de Firebase es la misma que usan todas las apps y no es un secreto:
   está a la vista en el código de las páginas. Lo que protege los datos son las
   reglas, no esta clave. */
const FB_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCwHaVLIoFrXb2NFl9Od6j8LuLvklxpzRc';
const FB_URL     = 'https://academia-dg-default-rtdb.firebaseio.com';
const AGENTE_EMAIL    = process.env.AGENTE_EMAIL    || 'agente@academiadg.local';
const AGENTE_PASSWORD = process.env.AGENTE_PASSWORD || '';

const CUANTOS_GUARDA = 100;
const registro = [];
const arranque = new Date();
const totales = { recibidos:0, firmaMal:0, clasificados:0, sinAlumno:0, anotados:0, errores:0 };

/* ---------- QUÉ DÍA ES EN ASUNCIÓN ----------
   Este servidor vive en hora universal, que va adelante de Paraguay. Pidiéndole
   la fecha con toISOString(), a partir de las 21:00 de acá el servidor ya creía
   que era el día siguiente: toda cancelación de esa franja quedaba anotada con
   la fecha corrida un día. Y en los 37 chats medidos, uno de cada diez mensajes
   de alumnos llega entre las 21:00 y las 6:00 — justo cuando avisan que mañana
   no vienen.

   No se resta un número fijo de horas a propósito. Se le pregunta a Node cuál
   es la fecha en Asunción; si Paraguay vuelve a cambiar de huso horario, esto
   sigue estando bien sin que nadie toque nada. */
const ZONA_ACADEMIA = 'America/Asuncion';

function hoyAsuncion(cuando){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_ACADEMIA, year:'numeric', month:'2-digit', day:'2-digit'
  }).format(cuando || new Date());              // queda como 2026-08-03
}

function horaAsuncion(cuando){
  return new Intl.DateTimeFormat('es-PY', {
    timeZone: ZONA_ACADEMIA, hour:'2-digit', minute:'2-digit', hour12:false
  }).format(cuando || new Date());              // queda como 11:04
}

/* Suma (o resta) días a una fecha 2026-08-03 sin pasar por husos horarios.
   Hacerlo con new Date(iso) volvía a meter la hora universal por la ventana. */
function sumarDias(iso, n){
  const p = String(iso||'').split('-').map(Number);
  if(p.length !== 3 || !p[0]) return iso;
  const d = new Date(Date.UTC(p[0], p[1]-1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}

function anotar(evento){
  registro.unshift({ ...evento, cuando:new Date().toISOString() });
  if(registro.length > CUANTOS_GUARDA) registro.pop();
}

app.use(express.json({ limit:'1mb', verify:(req,res,buf)=>{ req.cuerpoCrudo = buf; } }));

/* ---------- La firma del aviso ---------- */
function firmaValida(cuerpoCrudo, firmaRecibida){
  if(!SECRETO) return true;
  if(!firmaRecibida) return false;
  try{
    const calculada = crypto.createHmac('sha256', SECRETO).update(cuerpoCrudo).digest('hex');
    const a = Buffer.from(calculada,'utf8');
    const b = Buffer.from(String(firmaRecibida).replace(/^sha256=/,''),'utf8');
    if(a.length !== b.length) return false;
    return crypto.timingSafeEqual(a,b);
  }catch(e){ return false; }
}

/* ============================================================
   FIREBASE — entrar con la cuenta del agente

   Es la misma cuenta que ya usan las funciones de Kapso. No es una cuenta de
   Google: es un usuario creado dentro de Firebase, con un solo permiso.
   La credencial dura una hora; se guarda y se renueva cinco minutos antes.
   ============================================================ */
let _cred = null;
async function credencial(){
  if(_cred && _cred.vence > Date.now()) return _cred.token;
  if(!AGENTE_PASSWORD) throw new Error('Falta la contraseña del agente (AGENTE_PASSWORD)');
  const r = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+FB_API_KEY,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email:AGENTE_EMAIL, password:AGENTE_PASSWORD, returnSecureToken:true }) });
  const d = await r.json();
  if(!r.ok || !d.idToken){
    const cual = (d && d.error && d.error.message) || r.status;
    /* PASSWORD_LOGIN_DISABLED significa que en Firebase falta habilitar el
       ingreso por correo y contraseña. Un programa no puede apretar el botón
       de Google. */
    throw new Error('No pude entrar a Firebase: '+cual);
  }
  _cred = { token:d.idToken, vence: Date.now() + (Number(d.expiresIn||3600)-300)*1000 };
  return _cred.token;
}
async function leerFirebase(ruta){
  const tk = await credencial();
  const r = await fetch(FB_URL+'/'+ruta+'.json?auth='+encodeURIComponent(tk));
  if(!r.ok) throw new Error('Firebase respondió '+r.status+' en '+ruta);
  return await r.json();
}

/* Agrega un renglón nuevo. Nunca pisa nada: la libreta no se corrige ni se
   borra, y eso lo garantizan las reglas de Firebase, no este código. */
async function agregarEnFirebase(ruta, dato){
  const tk = await credencial();
  const r = await fetch(FB_URL+'/'+ruta+'.json?auth='+encodeURIComponent(tk),
    { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(dato) });
  const d = await r.json().catch(()=>null);
  if(!r.ok){
    const cual = (d && d.error) || r.status;
    throw new Error('No pude escribir en '+ruta+': '+cual);
  }
  return d && d.name;
}

/* ============================================================
   EL PADRÓN — de quién es este teléfono

   Se guarda diez minutos en memoria: 900 alumnos no se bajan en cada mensaje.
   ============================================================ */
let _padron = null, _padronTs = 0;

function partirCSV(txt){
  const filas=[]; let fila=[], cur='', comillas=false;
  for(let i=0;i<txt.length;i++){
    const c=txt[i];
    if(comillas){ if(c==='"'){ if(txt[i+1]==='"'){ cur+='"'; i++; } else comillas=false; } else cur+=c; }
    else if(c==='"') comillas=true;
    else if(c===',') { fila.push(cur); cur=''; }
    else if(c==='\n'){ fila.push(cur); filas.push(fila); fila=[]; cur=''; }
    else if(c!=='\r') cur+=c;
  }
  if(cur!=='' || fila.length){ fila.push(cur); filas.push(fila); }
  return filas;
}

/* Los teléfonos se comparan por sus últimos 8 dígitos. Es lo que aguanta que
   uno esté cargado como 0981..., otro como 595981... y otro con un 595 de más
   adelante, que es un problema conocido de 7 alumnos del padrón. */
function colaTel(t){
  const d = String(t==null?'':t).replace(/\D/g,'');
  return d.length >= 8 ? d.slice(-8) : '';
}

async function padron(){
  if(_padron && Date.now()-_padronTs < 10*60*1000) return _padron;
  const paq = await leerFirebase('alumnos_v1');
  if(!paq || !paq.csv) throw new Error('No encontré la copia del padrón');
  const filas = partirCSV(paq.csv);

  /* Los encabezados no están en la fila 1: ahí va el título. Se buscan por
     nombre, nunca por número de columna, porque además hay columnas ocultas. */
  let hr=-1, iNom=-1, iTel=-1, iId=-1, iTipo=-1;
  for(let r=0;r<Math.min(filas.length,12);r++){
    const h = filas[r].map(x=>String(x||'').toLowerCase().trim());
    let n=-1,t=-1,d=-1,p=-1;
    h.forEach((x,i)=>{
      if(n<0 && (x==='alumnos'||x==='alumno'||x.includes('nombre'))) n=i;
      if(t<0 && (x.includes('telefono')||x.includes('teléfono')||x.includes('celular'))) t=i;
      if(d<0 && (x==='id'||x.includes('id alumno'))) d=i;
      if(p<0 && x.includes('tipo')) p=i;
    });
    if(n>=0 && t>=0){ hr=r; iNom=n; iTel=t; iId=d; iTipo=p; break; }
  }
  if(hr<0) throw new Error('No encontré las columnas del padrón');

  const porTel = {};
  let conTel=0;
  for(let i=hr+1;i<filas.length;i++){
    const nombre=(filas[i][iNom]||'').trim();
    if(!nombre) continue;
    const tel=(filas[i][iTel]||'').trim();
    const k=colaTel(tel);
    if(!k) continue;
    conTel++;
    if(!porTel[k]) porTel[k]=[];
    porTel[k].push({
      nombre,
      tel,
      id:   iId>=0   ? (filas[i][iId]||'').trim()   : '',
      tipo: iTipo>=0 ? (filas[i][iTipo]||'').trim() : ''
    });
  }
  _padron = { porTel, conTel, actualizado: paq.actualizado||'' };
  _padronTs = Date.now();
  return _padron;
}

/* Puede haber varios alumnos con el mismo número: son 71 números compartidos
   entre 156 alumnos, uno de cada cinco. Cuando pasa, se devuelven todos y una
   persona decide; el agente NO adivina. */
async function quienEs(telefono, nombreContacto){
  const p = await padron();
  const cands = p.porTel[colaTel(telefono)] || [];
  if(cands.length === 0) return { encontrado:false, candidatos:[] };
  if(cands.length === 1) return { encontrado:true, alumno:cands[0], candidatos:cands };

  /* Kapso manda el nombre con el que la academia tiene guardado el contacto.
     Si coincide con uno de los candidatos, resuelve el número compartido sin
     tener que preguntarle nada al alumno. */
  const limpio = s => String(s==null?'':s).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
                        .toLowerCase().replace(/\s+/g,' ').trim();
  if(nombreContacto){
    const porNombre = cands.find(c => limpio(c.nombre) === limpio(nombreContacto));
    if(porNombre) return { encontrado:true, alumno:porNombre, candidatos:cands, porNombreDelContacto:true };
  }
  return { encontrado:false, varios:true, candidatos:cands };
}

/* ============================================================
   CLASIFICAR CON CLAUDE

   Las mismas cinco categorías y las mismas reglas que ya usa el agente de
   Kapso. Se le pide la respuesta con una herramienta en vez de pedirle texto:
   así no puede contestar algo que después no se pueda leer.
   ============================================================ */
const REGLAS = `Sos el asistente de Academia DG, una academia de pádel en Asunción con tres sedes: Lomas, Elite y Segurola.
Tu trabajo es LEER el mensaje de un alumno y decidir de qué se trata. No inventes datos. No resuelvas nada.

confirma — dice que viene a su clase. Ejemplos: sí, dale, confirmado, presente, ahí estoy, siii, ok
cancela — avisa que NO viene a una clase puntual. Ejemplos: mañana no puedo, hoy no llego
pedido — quiere cambiar de día u horario, o pregunta si hay lugar. Ejemplos: puedo cambiar al jueves?, tenés lugar a las 16?
ausencia — se va por un período, no por una clase. Ejemplos: me lesioné, no entreno dos semanas; me voy de viaje, vuelvo el 10
nada — cualquier otra cosa: un saludo suelto, un agradecimiento, una consulta de precios, un reclamo, un audio, una foto, un sticker, o algo que no entendés con certeza.

REGLAS QUE NO SE ROMPEN
1. Ante la duda, nada. Siempre. Es preferible que una persona lo mire a que te equivoques con la clase de alguien.
2. Un emoji suelto NO es una confirmación, salvo que sea respuesta directa a una pregunta tuya. Un pulgar arriba sin contexto es nada.
3. Si no podés leer el mensaje —audio, imagen, sticker, documento— es nada.
4. Si el mensaje tiene enojo, queja o reclamo, es nada. Aunque además cancele. Eso lo contesta una persona.
5. Si menciona salud, lesión o un problema personal, es ausencia o nada, nunca cancela a secas.
6. Distinguí cancela de ausencia por el alcance: una clase es cancela, un período es ausencia.

LA FECHA
Se te dice abajo qué día es hoy. Convertí lo que dice el alumno en una fecha concreta:
- "hoy" = esa fecha · "mañana" = esa fecha más un día
- "el jueves" = el próximo jueves a partir de hoy
- "la semana que viene", "en unos días" son vagos: dejá la fecha vacía
Nunca uses una fecha de tu memoria. Si es vago, vacío.`;

async function clasificar(texto, hoy){
  if(!CLAVE_IA) throw new Error('Falta la clave de Claude (ANTHROPIC_API_KEY)');
  const r = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key':CLAVE_IA, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model:'claude-haiku-4-5-20251001',
      max_tokens:300,
      temperature:0,
      system: REGLAS + '\n\nHOY ES: ' + hoy,
      tools:[{
        name:'clasificacion',
        description:'Clasifica el mensaje de un alumno de la academia',
        input_schema:{
          type:'object',
          properties:{
            tipo:   { type:'string', enum:['confirma','cancela','pedido','ausencia','nada'] },
            fecha:  { type:'string', description:'AAAA-MM-DD de la clase, solo si es inequívoco. Si no, vacío.' },
            hasta:  { type:'string', description:'Para ausencias, hasta cuándo. Solo si el alumno lo dijo.' },
            motivo: { type:'string', enum:['lesion','viaje','otro',''] },
            porque: { type:'string', description:'En una línea, por qué elegiste ese tipo.' }
          },
          required:['tipo']
        }
      }],
      tool_choice:{ type:'tool', name:'clasificacion' },
      messages:[{ role:'user', content: texto }]
    })
  });
  const d = await r.json();
  if(!r.ok){
    const cual = (d && d.error && d.error.message) || r.status;
    throw new Error('Claude: '+cual);
  }
  const uso = (d.content||[]).find(b => b.type === 'tool_use');
  if(!uso) throw new Error('Claude no devolvió una clasificación');
  return { ...uso.input, gasto: d.usage || null };
}

/* ============================================================
   UBICAR LA CLASE

   Con el alumno y la fecha, busca en la copia del día (dia/{fecha}) en las
   cuatro sedes y averigua dónde tiene clase: sede, hora, profe.

   LA REGLA DE LAS HORAS SEGUIDAS
   · Dos horas seguidas con el mismo profe y la misma sede (14:00 y 15:00) son
     UNA SOLA sesión. Se cancela el bloque entero.
   · Horas separadas (10:00 y 16:00) son sesiones distintas. "Mañana no puedo"
     no dice cuál, así que NO SE ADIVINA: el renglón queda sin dirección para
     que lo mire una persona.
   ============================================================ */
const SEDES = ['lomas','elite','segurola','adefinir'];
const HORAS = ['6:00','7:00','8:00','9:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00'];

/* La misma limpieza que usa el calendario. Si limpiara distinto, encontraría
   clases que el calendario después no encuentra, y no aplicaría nada. */
function normNombre(s){
  return String(s==null?'':s).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u{1F300}-\u{1FFFF}]/gu,' ').replace(/\uFE0F/g,' ')
    .replace(/\s+/g,' ').trim();
}
function claveNombre(s){
  let t = normNombre(s), antes;
  do { antes=t; t=t.replace(/\s+(lomas|elite|segurola|a definir|dual|individual|ind|grupal|noche)\s*$/,'').trim(); }
  while(t!==antes);
  return t.replace(/\.+$/,'').trim();
}

async function ubicarClase(nombreAlumno, fecha){
  if(!fecha) return { ok:false, motivo:'el mensaje no dijo de qué día' };
  const buscado = claveNombre(nombreAlumno);
  const encontradas = [];

  for(const sede of SEDES){
    let recs = null;
    try{ recs = await leerFirebase('dia/'+fecha+'/'+sede); }catch(e){ continue; }
    if(!recs) continue;
    for(const k of Object.keys(recs)){
      const r = recs[k];
      if(!r || !r.nombre) continue;
      if(claveNombre(r.nombre) !== buscado) continue;
      encontradas.push({ sede, diaKey:k, horaIdx:r.horaIdx, profe:r.profe||'', nombreEnGrilla:r.nombre });
    }
  }

  if(encontradas.length === 0) return { ok:false, motivo:'no estaba en el día '+fecha };
  if(encontradas.length === 1) return { ok:true, fecha:fecha, clases:encontradas, nota:'ubicada (1 hora)' };

  /* ¿Son horas seguidas en la misma sede? Entonces es una sola venida.
     NO se mira el profe: un alumno que entrena de 7 a 9 en Lomas con dos
     profes distintos vino UNA vez. Si dice "mañana no puedo", no viene a
     ninguna de las dos. */
  const orden = encontradas.slice().sort((a,b)=>a.horaIdx-b.horaIdx);
  const mismaSede = orden.every(c => c.sede===orden[0].sede);
  const seguidas  = orden.every((c,i) => i===0 || c.horaIdx === orden[i-1].horaIdx+1);
  if(mismaSede && seguidas)
    return { ok:true, fecha:fecha, clases:orden, nota:'ubicada (bloque de '+orden.length+' horas seguidas)' };

  return { ok:false, motivo:'varias clases separadas ese día — lo mira una persona', clases:orden };
}

/* ============================================================
   ESCRIBIR EN LA LIBRETA

   Un renglón por hora, para que el cobro cuadre. La libreta no se corrige ni
   se borra: lo único que cambia después es el semáforo, cuando el calendario
   la aplica.
   ============================================================ */
async function anotarEnLibreta(datos){
  const base = {
    tipo:   datos.tipo,
    alumno: datos.alumno,
    texto:  String(datos.texto||'').slice(0,1000),
    tel:    String(datos.tel||''),
    ts:     Date.now(),
    estado: 'pendiente'
  };
  if(datos.fecha)  base.fecha  = datos.fecha;
  if(datos.hasta)  base.hasta  = datos.hasta;
  if(datos.motivo) base.motivo = datos.motivo;

  /* Una ausencia larga no lleva sede ni hora: son todas sus clases. */
  const clases = (datos.tipo==='ausencia' || !datos.clases || !datos.clases.length) ? [null] : datos.clases;

  const puestos = [];
  for(const c of clases){
    const fila = { ...base };
    if(c){
      fila.sede    = c.sede;
      fila.horaIdx = c.horaIdx;
      fila.profe   = c.profe;
      fila.diaKey  = c.diaKey;
      /* El nombre va TAL CUAL está en la grilla: el calendario verifica que
         coincida antes de aplicar, y si no coincide no toca nada. */
      fila.alumno  = c.nombreEnGrilla || base.alumno;
    }
    puestos.push(await agregarEnFirebase('agente_v1/anotaciones', fila));
  }
  return puestos;
}

/* Lo único que el agente contesta, y solo a las confirmaciones. En esta etapa
   NO se manda: se muestra en pantalla para poder compararlo. */
const RESPUESTAS = ['Dale, ahí te espero 🎾','Buenísimo 💪🏻 nos vemos 🎾','Genial, te espero 🎾'];

/* ---------- Sacar los datos del aviso de Kapso ---------- */
function leerMensaje(cuerpo){
  const m = (cuerpo && cuerpo.message) || {};
  const c = (cuerpo && cuerpo.conversation) || {};
  return {
    texto:  (m.text && m.text.body) || (m.kapso && m.kapso.content) || '',
    tipo:   m.type || '',
    tel:    m.from || c.phone_number || '',
    nombre: c.contact_name || '',
    id:     m.id || '',
    medios: !!(m.kapso && m.kapso.has_media)
  };
}

/* ---------- El webhook ---------- */
app.post('/webhooks/whatsapp', (req,res) => {
  res.status(200).send('OK');            // primero avisar que llegó: Kapso corta a los 10 s

  (async () => {
    try{
      const evento = req.headers['x-webhook-event'] || '(sin evento)';
      if(!firmaValida(req.cuerpoCrudo, req.headers['x-webhook-signature'])){
        totales.firmaMal++;
        anotar({ tipo:'FIRMA INVÁLIDA', evento });
        return;
      }
      totales.recibidos++;
      const msg = leerMensaje(req.body);
      const fila = { tipo:'MENSAJE', evento, msg, cuerpo:req.body };

      /* Quién es. Que falle no puede frenar el resto. */
      try{
        fila.quien = await quienEs(msg.tel, msg.nombre);
        if(!fila.quien.encontrado) totales.sinAlumno++;
      }catch(e){ fila.errorQuien = e.message; }

      /* Qué dice. Si no hay texto, no hay nada que clasificar. */
      if(msg.texto){
        try{
          const hoy = hoyAsuncion();
          fila.clasi = await clasificar(msg.texto, hoy);
          totales.clasificados++;
          if(fila.clasi.tipo === 'confirma'){
            fila.habriaContestado = RESPUESTAS[Math.floor(Math.random()*RESPUESTAS.length)];
          }
        }catch(e){ fila.errorClasi = e.message; totales.errores++; }
      } else {
        fila.clasi = { tipo:'nada', porque:'no es un mensaje de texto ('+(msg.tipo||'?')+')' };
      }

      /* ---- ANOTAR EN LA LIBRETA ----
         Solo si hay alumno y el tipo amerita. Un "nada" no se anota: sería
         llenar la libreta de saludos. Sin alumno tampoco: un renglón sin
         nombre no lo puede aplicar nadie. */
      const t = fila.clasi && fila.clasi.tipo;
      const anotable = t && t !== 'nada';
      if(anotable && fila.quien && fila.quien.encontrado){
        try{
          if(t === 'cancela'){
            fila.ubic = await ubicarClase(fila.quien.alumno.nombre, fila.clasi.fecha);
          } else if(t === 'pedido'){
            /* En un pedido, la fecha que dijo el alumno es A DÓNDE QUIERE IR,
               no la clase que tiene. Así que se busca la clase que tiene HOY,
               y si no tiene, la de MAÑANA: esa es la que hay que marcar. */
            const hoy = hoyAsuncion();
            fila.ubic = await ubicarClase(fila.quien.alumno.nombre, hoy);
            if(!fila.ubic.ok){
              const ubicMan = await ubicarClase(fila.quien.alumno.nombre, sumarDias(hoy,1));
              if(ubicMan.ok) fila.ubic = ubicMan;
            }
          }
          /* LA FECHA DEL RENGLÓN ES LA DE LA CLASE UBICADA, no la que pidió el
             alumno. En un pedido son distintas: escribe "cambio al jueves" pero
             su clase es el lunes. Si se guardara el jueves, el calendario iría a
             buscarlo ahí, no lo encontraría, y no aplicaría nada — en silencio.
             El día que pidió sigue estando a la vista en el texto del mensaje. */
          fila.anotado = await anotarEnLibreta({
            tipo:   t,
            alumno: fila.quien.alumno.nombre,
            texto:  msg.texto,
            tel:    msg.tel,
            fecha:  (fila.ubic && fila.ubic.ok && fila.ubic.fecha) ? fila.ubic.fecha : fila.clasi.fecha,
            hasta:  fila.clasi.hasta,
            motivo: fila.clasi.motivo,
            clases: fila.ubic && fila.ubic.ok ? fila.ubic.clases : null
          });
          totales.anotados += fila.anotado.length;
        }catch(e){ fila.errorAnotar = e.message; totales.errores++; }
      } else if(anotable){
        fila.noAnotado = 'no se sabe de quién es el mensaje';
      }

      anotar(fila);
      console.log('📩', msg.tel, '·', (fila.quien && fila.quien.alumno && fila.quien.alumno.nombre) || 'sin alumno',
                  '·', (fila.clasi && fila.clasi.tipo) || 'sin clasificar', '·', msg.texto.slice(0,60));
    }catch(err){
      totales.errores++;
      console.error('Error procesando:', err);
      anotar({ tipo:'ERROR', nota:String(err && err.message) });
    }
  })();
});

/* ---------- Salud ---------- */
app.get('/salud', (req,res) => {
  res.json({ estado:'vivo', version:VERSION, desde:arranque.toISOString(),
             /* Para comprobar de un vistazo que el servidor sabe qué día y qué
                hora es EN ASUNCIÓN, no en hora universal. */
             hoyEnAsuncion: hoyAsuncion(), horaEnAsuncion: horaAsuncion(),
             ...totales, guardados:registro.length,
             claveIA: !!CLAVE_IA, claveAgente: !!AGENTE_PASSWORD });
});

/* ---------- Probar sin esperar un WhatsApp ---------- */
app.get('/probar', async (req,res) => {
  const texto = req.query.texto || 'mañana no puedo, tengo examen';
  try{
    const hoy = hoyAsuncion();
    res.json({ texto, hoyEnAsuncion: hoy, resultado: await clasificar(texto, hoy) });
  }catch(e){ res.status(500).json({ texto, error:e.message }); }
});

/* ---------- La pantalla ---------- */
app.get('/', (req,res) => {
  const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const COLOR = { confirma:'#2ea043', cancela:'#d29922', pedido:'#58a6ff', ausencia:'#bc8cff', nada:'#8b949e' };

  const filas = registro.map(r => {
    if(r.tipo !== 'MENSAJE'){
      return '<div class="f mal"><div class="c">'+esc(new Date(r.cuando).toLocaleString('es-PY'))+' · <b>'+esc(r.tipo)+'</b></div>'+
             (r.nota?'<div class="n">'+esc(r.nota)+'</div>':'')+'</div>';
    }
    const q = r.quien || {};
    const c = r.clasi || {};
    const quienTxt = q.encontrado
      ? '<b>'+esc(q.alumno.nombre)+'</b>'+(q.alumno.tipo?' · '+esc(q.alumno.tipo):'')+
        (q.porNombreDelContacto?' <span class="pin">resuelto por el nombre del contacto</span>':'')
      : (q.varios
          ? '<span class="alerta">número compartido — '+q.candidatos.length+' candidatos:</span> '+esc(q.candidatos.map(x=>x.nombre).join(', '))
          : '<span class="alerta">no está en el padrón</span>');
    return '<div class="f" style="border-left-color:'+(COLOR[c.tipo]||'#30363d')+'">'+
      '<div class="c">'+esc(new Date(r.cuando).toLocaleString('es-PY'))+' · '+esc(r.msg.tel)+'</div>'+
      '<div class="txt">'+esc(r.msg.texto || '(sin texto · '+r.msg.tipo+')')+'</div>'+
      '<div class="linea"><span class="et">Quién es</span> '+quienTxt+(r.errorQuien?'<span class="alerta">'+esc(r.errorQuien)+'</span>':'')+'</div>'+
      '<div class="linea"><span class="et">Qué dice</span> <b style="color:'+(COLOR[c.tipo]||'#e6edf3')+'">'+esc(c.tipo||'—')+'</b>'+
        (c.fecha?' · fecha '+esc(c.fecha):'')+(c.hasta?' · hasta '+esc(c.hasta):'')+(c.motivo?' · '+esc(c.motivo):'')+
        (c.porque?'<div class="por">'+esc(c.porque)+'</div>':'')+
        (r.errorClasi?'<span class="alerta">'+esc(r.errorClasi)+'</span>':'')+'</div>'+
      (r.ubic?'<div class="linea"><span class="et">Qué clase</span> '+(r.ubic.ok
          ? esc(r.ubic.nota)+' · '+esc(r.ubic.clases.map(function(c){return HORAS[c.horaIdx]+' '+c.sede.toUpperCase()+' '+c.profe}).join(' + '))
          : '<span class="alerta">'+esc(r.ubic.motivo)+'</span>')+'</div>':'')+
      (r.anotado?'<div class="linea"><span class="et">En la libreta</span> <b style="color:#2ea043">✓ '+r.anotado.length+' renglón(es)</b> <span class="pin">'+esc(r.anotado.join(', ').slice(0,40))+'</span></div>':'')+
      (r.noAnotado?'<div class="linea"><span class="et">En la libreta</span> <span class="alerta">no se anotó — '+esc(r.noAnotado)+'</span></div>':'')+
      (r.errorAnotar?'<div class="linea"><span class="et">En la libreta</span> <span class="alerta">'+esc(r.errorAnotar)+'</span></div>':'')+
      (r.habriaContestado?'<div class="linea"><span class="et">Habría contestado</span> <i>'+esc(r.habriaContestado)+'</i> <span class="pin">no se envió</span></div>':'')+
      '<details><summary>ver lo que mandó Kapso</summary><pre>'+esc(JSON.stringify(r.cuerpo,null,2))+'</pre></details>'+
    '</div>';
  }).join('');

  res.send('<!doctype html><html lang="es"><head><meta charset="utf-8">'+
'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Agente Academia DG · Etapa 1</title>'+
'<style>'+
' body{background:#0d1117;color:#e6edf3;font:14px system-ui,-apple-system,sans-serif;margin:0;padding:18px}'+
' h1{font-size:17px;margin:0 0 4px} .sub{color:#8b949e;font-size:13px;margin-bottom:16px}'+
' .caja{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 14px;margin-bottom:14px}'+
' .num{display:inline-block;margin-right:22px} .num b{font-size:20px;display:block}'+
' .f{background:#161b22;border:1px solid #30363d;border-left:3px solid #30363d;border-radius:8px;padding:11px 13px;margin-bottom:10px}'+
' .f.mal{border-left-color:#d29922}'+
' .c{color:#8b949e;font-size:12px} .n{color:#d29922;font-size:13px;margin-top:4px}'+
' .txt{font-size:15px;margin:5px 0 9px}'+
' .linea{font-size:13px;margin-top:5px}'+
' .et{display:inline-block;min-width:120px;color:#8b949e;font-size:12px}'+
' .por{color:#8b949e;font-size:12px;margin:2px 0 0 120px;font-style:italic}'+
' .alerta{color:#d29922} .pin{background:#21262d;border-radius:20px;padding:1px 8px;font-size:11px;color:#8b949e}'+
' details{margin-top:7px} summary{cursor:pointer;color:#8b949e;font-size:12px}'+
' pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:9px;overflow:auto;'+
'     font-size:11.5px;margin:7px 0 0;max-height:280px;white-space:pre-wrap;word-break:break-all}'+
' .vacio{color:#8b949e;text-align:center;padding:36px 0}'+
'</style></head><body>'+
'<h1>🎾 Agente Academia DG <span style="font-size:12px;color:#8b949e;font-weight:400">'+VERSION+'</span></h1>'+
'<div class="sub">Entiende los mensajes y los <b>anota en la libreta</b>. Todavía <b>no contesta ninguno</b>.</div>'+
'<div class="caja">'+
'  <span class="num"><b>'+totales.recibidos+'</b>mensajes</span>'+
'  <span class="num"><b>'+totales.clasificados+'</b>clasificados</span>'+
'  <span class="num"><b>'+totales.sinAlumno+'</b>sin alumno</span>'+
'  <span class="num"><b>'+totales.anotados+'</b>en la libreta</span>'+
'  <span class="num"><b>'+totales.errores+'</b>errores</span>'+
'  <span class="num"><b>'+totales.firmaMal+'</b>firma inválida</span>'+
'</div>'+
(filas || '<div class="vacio">Todavía no llegó ningún mensaje.<br>Escribile al número de prueba de Kapso y recargá.</div>')+
'<script>setTimeout(function(){location.reload()}, 20000)</script>'+
'</body></html>');
});

app.listen(PUERTO, () => {
  console.log('🎾 Agente Academia DG · '+VERSION+' — puerto '+PUERTO);
  if(!SECRETO)         console.log('   ⚠ Sin WEBHOOK_SECRET: no se verifica la firma.');
  if(!CLAVE_IA)        console.log('   ⚠ Sin ANTHROPIC_API_KEY: no va a clasificar.');
  if(!AGENTE_PASSWORD) console.log('   ⚠ Sin AGENTE_PASSWORD: no va a poder leer el padrón.');
});

export default app;
