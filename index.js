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
const VERSION = 'etapa-4.1';

/* MIENTRAS DURE LA PRUEBA: una cancelación NO saca al alumno de la grilla.
   Se anota como pedido, el calendario pinta la celda de celeste y una persona
   mira qué pasó. Para que las cancelaciones vuelvan a aplicarse solas, poner
   esto en false y volver a desplegar. Nada más. */
const CANCELA_EN_CELESTE = true;

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

/* Envío por Meta (plantillas), vía Kapso. La llave es un SECRETO: va en Railway
   como variable, NUNCA escrita a la vista en el código. El ID del número es el
   mismo que usa la coexistencia. */
const KAPSO_API_KEY   = process.env.KAPSO_API_KEY || '';
const KAPSO_PHONE_ID  = process.env.KAPSO_PHONE_ID || '120737524342892';
const KAPSO_URL       = 'https://api.kapso.ai/meta/whatsapp/v24.0/'+KAPSO_PHONE_ID+'/messages';
const TOPE_ENVIO_DIA  = 250;   // tope de Meta sin verificación de empresa

const CUANTOS_GUARDA = 100;
const registro = [];
const arranque = new Date();
const totales = { recibidos:0, firmaMal:0, clasificados:0, sinAlumno:0, anotados:0, deOtro:0, cancelCeleste:0, resueltosCompartido:0, errores:0 };

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

/* ---------- Permiso de conexión (CORS) ----------
   El calendario corre en orbepy.com y le habla a este servidor (que está en
   Railway). Sin este permiso, el navegador bloquea la conexión por seguridad y
   sale "Failed to fetch". Se permite a orbepy.com y a la apertura directa del
   archivo (origin nulo). Las peticiones OPTIONS (el "permiso previo" que manda
   el navegador antes del POST) se contestan al toque. */
app.use(function(req, res, next){
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if(req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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

/* Guarda (mezcla) datos en Firebase sin pisar lo que ya hay. Se usa para ir
   sumando cada día a la lista de a quiénes les mandamos la confirmación. */
async function guardarEnFirebase(ruta, dato){
  const tk = await credencial();
  const r = await fetch(FB_URL+'/'+ruta+'.json?auth='+encodeURIComponent(tk),
    { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(dato) });
  if(!r.ok){
    const d = await r.json().catch(()=>null);
    throw new Error('No pude guardar en '+ruta+': '+((d&&d.error)||r.status));
  }
  return true;
}

/* ---------- A quiénes les mandamos confirmación (para no gastar de más) ----------
   El agente SOLO clasifica las respuestas de los números a los que les mandamos
   la confirmación. Todo lo demás (Diego cobrando, hablando con alumnos nuevos,
   organizando horarios o macaneando) ni se manda a Claude: no gasta ni un token.

   La lista vive en Firebase, en agente_v1/enviados/<fecha>, así que SOBREVIVE a
   un reinicio del servidor. En memoria guardamos una copia por 60 segundos para
   no leer Firebase en cada mensaje. */
let _enviados = { hasta:0, set:null };

/* Cómo salió la última vez que se intentó guardar la lista de enviados. Se
   muestra en /salud para que un fallo NUNCA vuelva a pasar desapercibido. */
let ULTIMO_GUARDADO = null;

function soloDigitos8(tel){ return String(tel||'').replace(/\D/g,'').slice(-8); }

function fechaMenosUn(diaISO){
  const d = new Date(String(diaISO)+'T12:00:00Z');   // mediodía: no cruza husos
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0,10);
}

/* Devuelve un Set con los últimos 8 dígitos de los números de hoy y de ayer
   (ayer cubre las respuestas que llegan pasada la medianoche). Si Firebase no
   se pudo leer, devuelve null: en ese caso preferimos clasificar igual, porque
   perder una confirmación es peor que gastar un token de más. */
async function listaEnviados(hoy){
  if(_enviados.set && Date.now() < _enviados.hasta) return _enviados.set;
  const set = new Set();
  let ok = false;
  for(const f of [fechaMenosUn(hoy), hoy]){
    try{
      const obj = await leerFirebase('agente_v1/enviados/'+f);
      ok = true;
      if(obj) Object.keys(obj).forEach(k => set.add(k));
    }catch(e){}
  }
  if(!ok) return null;
  _enviados = { hasta: Date.now() + 60000, set };
  return set;
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

  /* (1) NO TODO NÚMERO CON VARIOS CANDIDATOS ES UN NÚMERO COMPARTIDO.
     Un mismo alumno puede tener DOS FICHAS en el padrón: "Rodrigo Trinidad
     INDIVIDUAL" y "Rodrigo Trinidad DUAL", o "Alex Ebner GRUPAL" y "Alex Ebner
     INDIVIDUAL". Ahí no hay ninguna duda de quién escribió: es la misma
     persona. Se frenaba igual, y el 9/8 se perdieron confirmaciones por eso.
     claveNombre() ya saca grupal/individual/dual/ind y la sede: si todos los
     candidatos quedan con la misma clave, es uno solo. */
  const clave0 = claveNombre(cands[0].nombre);
  if(cands.every(c => claveNombre(c.nombre) === clave0))
    return { encontrado:true, alumno:cands[0], candidatos:cands, mismaPersona:true };

  /* Kapso manda el nombre con el que la academia tiene guardado el contacto.
     Si coincide con uno de los candidatos, resuelve el número compartido sin
     tener que preguntarle nada al alumno. */
  const limpio = s => String(s==null?'':s).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
                        .toLowerCase().replace(/\s+/g,' ').trim();
  if(nombreContacto){
    const porNombre = cands.find(c => limpio(c.nombre) === limpio(nombreContacto));
    if(porNombre) return { encontrado:true, alumno:porNombre, candidatos:cands, porNombreDelContacto:true };

    /* (2) LA COINCIDENCIA EXACTA CASI NUNCA PASA. Los contactos están guardados
       como "Alex Singer Papá Eitan" o "Flor Crespi Mamá Manu": el nombre del
       alumno está adentro, pero el texto entero no coincide con nada. Así que
       se busca el NOMBRE DE PILA del alumno dentro del nombre del contacto.
       Solo resuelve si lo cumple UN candidato y nada más: si el contacto dice
       "Lali Mama Patrick y Paul" y los dos hermanos son alumnos, sigue sin
       saberse quién escribió, y ahí no se adivina. */
    const enPedazos = s => limpio(s).replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x => x.length >= 3);
    const delContacto = enPedazos(nombreContacto);
    const tieneSuNombre = c => {
      const suyas = enPedazos(claveNombre(c.nombre));
      if(!suyas.length) return false;
      const pila = suyas[0];
      /* "Manu" tiene que alcanzar para "Manuel", pero nunca al revés con dos
         letras: por eso el pedazo tiene que tener 4 o más para valer de arranque. */
      return delContacto.some(w => w === pila
        || (w.length >= 4 && pila.startsWith(w))
        || (pila.length >= 4 && w.startsWith(pila)));
    };
    const conNombre = cands.filter(tieneSuNombre);
    if(conNombre.length === 1)
      return { encontrado:true, alumno:conNombre[0], candidatos:cands, porNombreDelContacto:true };
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

confirma — dice que viene a su clase. Ejemplos: sí, si, dale, ok, oka, okey, listo, confirmado, confirmo, presente, ahí estoy, ahí estaré, firme, si firme, va, de una, tal cual, obvio, siii
cancela — avisa que NO viene a una clase puntual. Ejemplos: mañana no puedo, hoy no llego
pedido — quiere cambiar de día u horario, o pregunta si hay lugar. Ejemplos: puedo cambiar al jueves?, tenés lugar a las 16?
ausencia — se va por un período, no por una clase. Ejemplos: me lesioné, no entreno dos semanas; me voy de viaje, vuelvo el 10
nada — cualquier otra cosa: un saludo suelto, un agradecimiento, una consulta de precios, un reclamo, un audio, una foto, un sticker, o algo que no entendés con certeza.

REGLAS QUE NO SE ROMPEN
1. Ante la duda, nada. Siempre. Es preferible que una persona lo mire a que te equivoques con la clase de alguien.
2. UN PULGAR ARRIBA O UN VISTO SOLOS SON UNA CONFIRMACIÓN. Los emojis 👍 👍🏻 👍🏼 👍🏽 👌 ✅ ☑️ ✔️ 🙌 💪, solos y sin ninguna palabra al lado, son confirma. En esta academia la única pregunta que la gente contesta con un pulgar es "¿Entrenamos mañana?", así que un pulgar quiere decir que sí viene. Los demás emojis solos —❤️ 😂 🎾 🙏 y cualquier otro— siguen siendo nada.
3. Si no podés leer el mensaje —audio, imagen, sticker, documento— es nada.
4. Si el mensaje tiene enojo, queja o reclamo, es nada. Aunque además cancele. Eso lo contesta una persona.
5. Si menciona salud, lesión o un problema personal, es ausencia o nada, nunca cancela a secas.
6. Distinguí cancela de ausencia por el alcance: una clase es cancela, un período es ausencia.
7. Acá se escribe sin tildes y estirando las vocales. "firmeee", "siii", "daleee", "okaa", "listooo" son exactamente lo mismo que firme, si, dale, ok, listo. No los tomes por raros ni por dudosos: así habla la academia y así contestan los alumnos.
8. IGNORÁ LAS TILDES Y LA ORTOGRAFÍA POR COMPLETO. Los alumnos escriben rápido, desde el celular, casi nunca ponen tildes y muchas veces les faltan letras o les sobran. Leé cada palabra por lo que quiere decir, no por cómo está escrita. Nunca clasifiques algo como "nada" porque falte una tilde, porque una palabra esté mal escrita o porque el mensaje esté en minúsculas. Eso no es una duda: es la forma normal de escribir de esta gente.
9. EL "SI" SIN TILDE. Es la única palabra donde la tilde cambia lo que quiere decir: "sí" es una afirmación y "si" es una condición. Como nadie pone la tilde, no la uses para decidir. Usá esta prueba: sacale el "si" del principio al mensaje y mirá lo que queda.
   - Si lo que queda se sostiene solo como una afirmación de que viene, es confirma: "si voy" queda "voy" → confirma. "si entrenamos mañana" queda "entrenamos mañana" → confirma. "si estoy" queda "estoy" → confirma. "si confirmado" queda "confirmado" → confirma. "si llego" queda "llego" → confirma.
   - Si lo que queda queda colgado esperando un final, o es una condición, es nada: "si llueve no voy" → nada. "si hay lugar" → nada. "si es que puedo" → nada. "si no llueve" → nada.
   - Dos que parecen afirmación y NO lo son, tratalas siempre como nada: "si puedo mañana" y "si puedo". El alumno está poniendo una condición, no confirmando.
10. Una respuesta CORTA que solo expresa acuerdo, presencia o disposición a venir, y no trae ninguna otra información adentro, es confirma. Ejemplos: firme, firmeee, si firme, listo, ahí estoy, ahí estaré, tal cual, obvio, de una, va, dale ahí estoy. La mayoría de los mensajes que recibís son la respuesta a una pregunta que la academia ya hizo: "Entrenamos mañana a las 7:00?". Una respuesta corta y afirmativa a eso es una confirmación, aunque no diga la palabra "sí".
   Esta regla NO se aplica si el mensaje trae algo más adentro: una pregunta, una condición, una fecha o una hora distinta, una queja, o el nombre de otra persona. En esos casos vale lo que digan las reglas de arriba.

11. UN SALUDO, UN GRACIAS O UN EMOJI PEGADOS A UNA CONFIRMACIÓN NO LA ANULAN. Antes de decidir, limpiá el mensaje: sacá el saludo del principio ("hola", "holaa", "buen día", "buenas", "buenas tardes", "hola profe"), sacá el agradecimiento del final ("gracias", "muchas gracias", "gracias profe", "grax") y sacá los emojis. Después clasificá lo que queda. Ejemplos: "Hola ok" queda "ok" → confirma. "Ok 👍" queda "ok" → confirma. "Confirmado gracias" queda "confirmado" → confirma. "Gracias, ahí estoy" queda "ahí estoy" → confirma. "Holaaa si voy" queda "si voy" → confirma. "Buenas tardes, confirmado" queda "confirmado" → confirma. "Hola Sii" queda "Sii" → confirma. "Hola profe, si entrenamos mañana" queda "si entrenamos mañana" → confirma. El saludo, el gracias y el emoji solo mandan cuando son TODO el mensaje y no queda nada más después de sacarlos.

LO QUE SIGUE SIENDO NADA
- Un saludo que es TODO el mensaje, sin nada más al lado: "hola", "holaa", "buen día", "buenas". Si después del saludo hay una confirmación, mandá la confirmación (regla 11).
- Un agradecimiento que es TODO el mensaje: "gracias", "muchas gracias". Si el gracias viene pegado a una confirmación, mandá la confirmación (regla 11).
- Una pregunta de hora o de lugar: "a qué hora?", "dónde?", "a qué hora y en dónde", "los sábados hasta qué hora?".
- Una confirmación con una condición o una duda pegada: "si llueve no voy", "si hay lugar", "te aviso a la mañana", "creo que no llego", "te puedo avisar en un rato?", "si puedo mañana".
- Un emoji, un sticker, un audio, una foto o un documento que sean TODO el mensaje. Si el emoji acompaña a una palabra de confirmación, mandá la confirmación (regla 11). Y si el emoji solo es un pulgar arriba o un visto, mandá la regla 2: eso es confirma.

DE QUIÉN HABLA EL MENSAJE
Muchos teléfonos son de una madre o un padre que escribe por su hijo, y a veces
por más de un hijo. El teléfono te dice UN alumno, pero el mensaje puede estar
hablando de otro, o de dos a la vez. Si te equivocás de persona, sacás de la
clase justo al que sí venía.

Marcá sobreOtraPersona = true cuando el mensaje:
- nombra a alguien: "no vamos a poder ir con Enzo", "tenemos que suspender lo de Joaquín", "mi querido Eitan no va a poder", "hoy no va Uma"
- habla en plural: "no vamos", "no podemos", "no vamos a estar", "no llegamos"
- habla de un tercero sin nombrarlo: "no va a poder venir", "está con tos y no entrena", "ella no llega"
- mezcla dos personas: "yo no llego pero Maxi sí", "va Anita hoy, yo no llego"

Marcá sobreOtraPersona = false cuando el mensaje habla claramente en primera
persona y de una sola persona: "mañana no puedo", "no llego", "ahí estoy".

Ante la duda, true. Marcarlo de más solo hace que una persona lo mire; marcarlo
de menos le saca la clase a quien no correspondía.

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
      system: [
        { type:'text', text: REGLAS, cache_control:{ type:'ephemeral' } },
        { type:'text', text: 'HOY ES: ' + hoy }
      ],
      tools:[{
        name:'clasificacion',
        description:'Clasifica el mensaje de un alumno de la academia',
        input_schema:{
          type:'object',
          properties:{
            tipo:   { type:'string', enum:['confirma','cancela','pedido','ausencia','nada'] },
            sobreOtraPersona: { type:'boolean', description:'true si el mensaje habla de otra persona además de o en vez de quien escribe, o si habla en plural. Ante la duda, true.' },
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
/* ============================================================
   DECIDIR QUÉ HACER CON UN PEDIDO DE CAMBIO

   Regla acordada con José:
   - Si NO se ubica la clase actual del alumno  -> celeste (lo mira una persona).
   - Si el destino es vago (sin fecha)          -> celeste (para siempre o duda).
   - Si el destino es el MISMO día que su clase -> celeste (solo corre la hora ese día).
   - Si el destino es OTRO día                  -> el calendario busca lugar en SU sede.

   Devuelve {accion:'celeste', motivo} o {accion:'resolver', sede, fechaDestino}.
   ============================================================ */
function decidirPedido(claseActual, fechaPedida){
  if(!claseActual || !claseActual.ok || !claseActual.clases || !claseActual.clases.length)
    return { accion:'celeste', motivo:'No encontré su clase actual. Lo mira una persona.' };
  if(!fechaPedida)
    return { accion:'celeste', motivo:'No quedó claro a qué día se cambia. Lo mira una persona.' };
  if(fechaPedida === claseActual.fecha)
    return { accion:'celeste', motivo:'Pide correr la hora del mismo día. Lo mira una persona.' };
  return { accion:'resolver', sede: claseActual.clases[0].sede, fechaDestino: fechaPedida };
}

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
  /* Destino de un pedido puntual a otro día: lo lee el calendario para agendar. */
  if(datos.destinoResolver){ base.destinoResolver = true; base.destinoFecha = datos.destinoFecha; base.destinoSede = datos.destinoSede; }
  /* Por qué este renglón quedó celeste en vez de aplicarse. Lo lee una persona
     en la libreta, así no tiene que adivinar. */
  if(datos.nota)   base.nota   = datos.nota;

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
        const hoy = hoyAsuncion();
        /* ¿Vale la pena clasificar este mensaje?

           Se clasifica si pasa CUALQUIERA de estas dos puertas:
             1. El número está en las confirmaciones que mandamos hoy, O
             2. El número es de un alumno del padrón.

           Son dos puertas a propósito. Si una falla —como el 6/8, que el guardado
           de la lista venía siendo rechazado por Firebase y se perdió un día
           entero de respuestas en silencio— la otra sigue atajando lo que
           escriben los alumnos.

           Lo que SIGUE quedando afuera y sin costar un peso: los números que no
           son de ningún alumno (proveedores, gente nueva, equivocados). Ese era
           el grueso del gasto. */
        let esRespuesta = true;
        try{
          const lista = await listaEnviados(hoy);
          const esAlumno = !!(fila.quien && fila.quien.encontrado);
          if(lista === null){
            /* No pude leer la lista: no me arriesgo a perder una confirmación. */
            fila.porQuePasa = 'no pude leer la lista';
          } else if(lista.has(soloDigitos8(msg.tel))){
            fila.porQuePasa = 'le mandamos la confirmación hoy';
          } else if(esAlumno){
            fila.porQuePasa = 'es un alumno del padrón';
          } else {
            esRespuesta = false;
          }
        }catch(e){ fila.errorLista = e.message; }

        if(!esRespuesta){
          fila.clasi = { tipo:'nada', porque:'no es de ningún alumno y no le mandamos confirmación — fuera del proceso' };
          totales.fueraDeLista = (totales.fueraDeLista||0) + 1;
        } else {
          try{
            fila.clasi = await clasificar(msg.texto, hoy);
            totales.clasificados++;
            /* No se contesta un mensaje que habla de otra persona: sonaría a que
               le confirmamos la clase a quien no era. */
            if(fila.clasi.tipo === 'confirma' && !fila.clasi.sobreOtraPersona){
              fila.habriaContestado = RESPUESTAS[Math.floor(Math.random()*RESPUESTAS.length)];
            }
          }catch(e){ fila.errorClasi = e.message; totales.errores++; }
        }
      } else {
        fila.clasi = { tipo:'nada', porque:'no es un mensaje de texto ('+(msg.tipo||'?')+')' };
      }

      /* ---- ANOTAR EN LA LIBRETA ----
         Solo si hay alumno y el tipo amerita. Un "nada" no se anota: sería
         llenar la libreta de saludos. Sin alumno tampoco: un renglón sin
         nombre no lo puede aplicar nadie. */
      const t = fila.clasi && fila.clasi.tipo;
      const anotable = t && t !== 'nada';

      /* (3) ÚLTIMO DESEMPATE PARA UN NÚMERO COMPARTIDO DE VERDAD: la grilla.
         Si de los dos hermanos que comparten el teléfono uno solo tiene clase
         el día por el que se preguntó, el que contestó "dale" fue ese.

         SOLO PARA CONFIRMACIONES, y a propósito. Una confirmación pinta verde
         y no saca a nadie: si se marcara al hermano equivocado, el costo es un
         color mal puesto. Una cancelación saca de la grilla, y ahí equivocarse
         cuesta una clase mal cobrada. Marcar de menos cuesta un clic.

         Tampoco se desempata si el mensaje habla de otra persona: ahí ni
         siquiera se sabe de quién se está hablando. */
      if(t === 'confirma' && fila.quien && fila.quien.varios && !fila.clasi.sobreOtraPersona){
        try{
          const hoyD = hoyAsuncion();
          const fechaMira = fila.clasi.fecha || sumarDias(hoyD,1);
          const conClase = [];
          for(const c of fila.quien.candidatos){
            const u = await ubicarClase(c.nombre, fechaMira);
            if(u.ok) conClase.push(c);
          }
          if(conClase.length === 1){
            fila.quien = { encontrado:true, alumno:conClase[0],
                           candidatos:fila.quien.candidatos, porLaClase:true, fechaDesempate:fechaMira };
            totales.resueltosCompartido = (totales.resueltosCompartido||0) + 1;
            if(totales.sinAlumno > 0) totales.sinAlumno--;
          } else {
            fila.notaCompartido = conClase.length === 0
              ? 'ninguno de los candidatos tiene clase el '+fechaMira
              : 'más de uno tiene clase el '+fechaMira+' — no se adivina';
          }
        }catch(e){ fila.errorDesempate = e.message; }
      }

      if(anotable && fila.quien && fila.quien.encontrado){
        try{
          if(t === 'cancela'){
            fila.ubic = await ubicarClase(fila.quien.alumno.nombre, fila.clasi.fecha);
          } else if(t === 'confirma'){
            /* UNA CONFIRMACIÓN CASI NUNCA TRAE FECHA.
               El alumno contesta "dale" o "si firme" a la pregunta diaria, y esa
               pregunta es SIEMPRE por mañana. Antes no se buscaba la clase para
               nada: el renglón salía sin sede y el calendario no sabía dónde
               pintar el verde, así que la confirmación se perdía. Y son el 24%
               de todo lo que escriben los alumnos.

               Orden: si el alumno dijo una fecha, esa manda. Si no, se busca la
               clase de MAÑANA —que es por la que se preguntó— y recién si no
               tiene ninguna, la de HOY, que cubre el recordatorio de las 11:00. */
            const hoy = hoyAsuncion();
            if(fila.clasi.fecha){
              fila.ubic = await ubicarClase(fila.quien.alumno.nombre, fila.clasi.fecha);
            } else {
              fila.ubic = await ubicarClase(fila.quien.alumno.nombre, sumarDias(hoy,1));
              if(!fila.ubic.ok){
                const ubicHoy = await ubicarClase(fila.quien.alumno.nombre, hoy);
                if(ubicHoy.ok) fila.ubic = ubicHoy;
              }
            }
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
            /* Decidir el destino: mismo día -> celeste; otro día -> el calendario
               busca lugar. La decisión se guarda en la fila para anotarla abajo. */
            fila.decisionPedido = decidirPedido(fila.ubic, fila.clasi.fecha);
          }
          /* ---- QUÉ TIPO SE ESCRIBE EN LA LIBRETA ----
             Ojo: la clase YA se ubicó arriba usando el tipo REAL, porque cada
             tipo la busca distinto (una cancelación usa la fecha que dijo el
             alumno; un pedido busca la de hoy o la de mañana). Recién acá se
             decide con qué nombre se guarda el renglón, que es lo que define
             qué hace el calendario con él.

             Dos casos se desvían a CELESTE, que marca y no toca nada:

             1. El mensaje habla de otra persona. El teléfono devuelve UN alumno,
                pero muchos números son de una madre o un padre. Un "va Anita hoy,
                yo no llego" tiene dos personas adentro: cancelar la del teléfono
                puede sacar de la grilla justo a la que sí venía.

             2. TODAS las cancelaciones, mientras dure la prueba. En vez de sacar
                al alumno solo, se pinta la celda y una persona mira qué pasó.
                Cuando haya confianza, se pone CANCELA_EN_CELESTE en false y las
                cancelaciones vuelven a aplicarse solas.

             La ausencia NO se desvía: ya pinta celeste sin borrar a nadie, y
             convertirla la dejaría sin sede y el calendario no la aplicaría. */
          let tipoLibreta = t;
          let porQue = '';
          if(fila.clasi.sobreOtraPersona && (t === 'confirma' || t === 'cancela')){
            tipoLibreta = 'pedido';
            porQue = 'El mensaje habla de otra persona. Parecía '+t+', pero no se aplicó: decide una persona.';
            totales.deOtro++;
          } else if(t === 'cancela' && CANCELA_EN_CELESTE){
            tipoLibreta = 'pedido';
            porQue = 'Avisó que NO viene. No se sacó de la grilla a propósito: mirá el mensaje y sacalo vos si corresponde.';
            totales.cancelCeleste++;
          }
          if(tipoLibreta !== t) fila.tipoOriginal = t;
          fila.tipoLibreta = tipoLibreta;

          /* LA FECHA DEL RENGLÓN ES LA DE LA CLASE UBICADA, no la que pidió el
             alumno. En un pedido son distintas: escribe "cambio al jueves" pero
             su clase es el lunes. Si se guardara el jueves, el calendario iría a
             buscarlo ahí, no lo encontraría, y no aplicaría nada — en silencio.
             El día que pidió sigue estando a la vista en el texto del mensaje. */
          /* Si es un pedido puntual a OTRO día, se le pasa al calendario el
             destino (día y sede) para que busque lugar. Si es mismo día, no
             ubica, o es vago, la decisión ya dice 'celeste' y no se pasa destino:
             el calendario lo pinta como hasta ahora. */
          var _dp = (tipoLibreta==='pedido' && fila.decisionPedido && fila.decisionPedido.accion==='resolver') ? fila.decisionPedido : null;
          if(_dp && (!porQue)) porQue = 'Pidió cambiar a otro día. El calendario busca lugar en su sede.';
          if(!_dp && tipoLibreta==='pedido' && fila.decisionPedido && fila.decisionPedido.motivo && !porQue) porQue = fila.decisionPedido.motivo;
          fila.anotado = await anotarEnLibreta({
            tipo:   tipoLibreta,
            alumno: fila.quien.alumno.nombre,
            texto:  msg.texto,
            tel:    msg.tel,
            fecha:  (fila.ubic && fila.ubic.ok && fila.ubic.fecha) ? fila.ubic.fecha : fila.clasi.fecha,
            hasta:  fila.clasi.hasta,
            motivo: fila.clasi.motivo,
            nota:   porQue,
            clases: fila.ubic && fila.ubic.ok ? fila.ubic.clases : null,
            destinoResolver: _dp ? true : null,
            destinoFecha:    _dp ? _dp.fechaDestino : null,
            destinoSede:     _dp ? _dp.sede : null
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
             ultimoGuardadoDeLista: ULTIMO_GUARDADO,
             cancelacionesEnCeleste: CANCELA_EN_CELESTE,
             ...totales, guardados:registro.length,
             claveIA: !!CLAVE_IA, claveAgente: !!AGENTE_PASSWORD, claveKapso: !!KAPSO_API_KEY });
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
        (q.porNombreDelContacto?' <span class="pin">resuelto por el nombre del contacto</span>':'')+
        (q.mismaPersona?' <span class="pin">varias fichas de la misma persona</span>':'')+
        (q.porLaClase?' <span class="pin">resuelto por la clase del '+esc(q.fechaDesempate||'')+'</span>':'')
      : (q.varios
          ? '<span class="alerta">número compartido — '+q.candidatos.length+' candidatos:</span> '+esc(q.candidatos.map(x=>x.nombre).join(', '))+
            (r.notaCompartido?'<div class="por">'+esc(r.notaCompartido)+'</div>':'')
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

/* ============================================================
   ENVIAR UNA CONFIRMACIÓN POR PLANTILLA (Meta, vía Kapso)

   Manda la plantilla confirmacion_entrenamiento a UN alumno. Probado a mano
   contra Kapso el 4/8: la respuesta trae message_status:'accepted' y el mensaje
   llega. Devuelve {ok:true, id} o {ok:false, error}.
   ============================================================ */
/* Emprolija el teléfono al formato internacional que Meta necesita (595 + 9 dígitos).
   En el padrón los números están cargados de tres formas: 0981..., 595981... y
   algunos con un 595 de más. Meta ACEPTA los mal escritos (los cuenta como "bien")
   pero después NO los entrega. Por eso hay que dejarlos siempre como 595981078630. */
function telInternacional(t){
  const orig = String(t==null?'':t);
  const tieneMas = orig.trim().startsWith('+');   // ¿lo escribieron con +?
  let d = orig.replace(/\D/g,'');                  // solo dígitos
  if(!d) return '';

  // 1) Si vino con +, YA es internacional (Paraguay o cualquier país): se respeta tal cual.
  if(tieneMas) return d;

  // 2) Sin +: hay que interpretar.
  //    Local paraguayo: empieza con 0 (prefijo de tronco) -> 595 + resto sin el 0.
  if(d.startsWith('0')) return '595' + d.replace(/^0+/, '');
  //    Paraguayo ya con código 595 (limpia el 595 repetido o el 595+0 de tronco).
  while(d.startsWith('595595')) d = d.slice(3);
  if(d.startsWith('5950')) d = '595' + d.slice(4);
  if(d.startsWith('595')) return d;
  //    Celular paraguayo "pelado": 9 dígitos que arrancan con 9 -> le falta el 595.
  if(d.length === 9 && d.startsWith('9')) return '595' + d;
  //    Cualquier otra cosa SIN +: se asume internacional ya en formato de país
  //    (54..., 55..., 34...) y se manda tal cual, sin ponerle 595.
  return d;
}
/* Un teléfono sirve si tiene un largo razonable de número internacional
   (entre 8 y 15 dígitos, que es el máximo que permite el estándar). Si no,
   está roto en el padrón: se marca como fallido y NO se manda a ciegas, para
   que aparezca en "los que fallaron" con nombre y se pueda corregir. */
function telPlausible(d){ return d.length >= 8 && d.length <= 15; }

async function enviarConfirmacion(destino, nombre, hora, sede, plantilla){
  if(!KAPSO_API_KEY) return { ok:false, error:'Falta KAPSO_API_KEY' };
  const tel = telInternacional(destino);
  if(!telPlausible(tel))
    return { ok:false, error:'teléfono raro en el padrón: "'+String(destino||'')+'" → '+(tel||'(vacío)') };
  /* Dos plantillas aprobadas en Meta:
     · semana → confirmacion_entrenamiento: nombre + hora + sede
     · sabado → confirmacion_sin_horario:  solo el nombre */
  let template;
  if(plantilla === 'sabado'){
    template = { name:'confirmacion_sin_horario', language:{ code:'es' },
      components:[{ type:'body', parameters:[
        { type:'text', text:String(nombre||'') }
      ]}] };
  }else{
    template = { name:'confirmacion_entrenamiento', language:{ code:'es' },
      components:[{ type:'body', parameters:[
        { type:'text', text:String(nombre||'') },
        { type:'text', text:String(hora||'') },
        { type:'text', text:String(sede||'') }
      ]}] };
  }
  const cuerpo = {
    messaging_product:'whatsapp', recipient_type:'individual', to:tel,
    type:'template', template
  };
  try{
    const r = await fetch(KAPSO_URL, { method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-API-Key':KAPSO_API_KEY },
      body: JSON.stringify(cuerpo) });
    const d = await r.json().catch(()=>({}));
    if(!r.ok){ return { ok:false, error:(d && d.error && (d.error.message||d.error)) || ('HTTP '+r.status) }; }
    const id = d && d.messages && d.messages[0] && d.messages[0].id;
    const estado = d && d.messages && d.messages[0] && d.messages[0].message_status;
    /* Kapso puede contestar 200 y aun así no haber creado el mensaje. Sin el
       identificador, "enviado" es una suposición nuestra, no un hecho. Por eso
       se devuelve TODO lo que contestó: es la única forma de saber en qué
       eslabón se corta, en vez de seguir adivinando. */
    if(!id){
      return { ok:false, sinId:true,
               error:'Kapso contestó OK pero no devolvió identificador de mensaje',
               respuesta: JSON.stringify(d).slice(0,400) };
    }
    return { ok:true, id: id, estado: estado || null,
             respuesta: JSON.stringify(d).slice(0,400) };
  }catch(e){ return { ok:false, error:e.message }; }
}

/* ============================================================
   RUTA QUE LLAMA EL CALENDARIO PARA ENVIAR LAS CONFIRMACIONES

   El calendario junta a los alumnos de mañana (nombre, hora, sede, tel) y se
   los pasa acá. El servidor manda una por una y devuelve el resumen.

   Protegida con la contraseña del agente, igual que las demás.
   Frena si son más de 250 (tope de Meta) — salvo que se pase forzar=1.
   ============================================================ */
app.post('/enviar-confirmaciones', async (req,res) => {
  try{
    const clave = (req.body && req.body.clave) || req.query.clave || '';
    if(!AGENTE_PASSWORD || clave !== AGENTE_PASSWORD)
      return res.status(401).json({ ok:false, error:'clave incorrecta' });

    const plantilla = (req.body && req.body.plantilla) || req.query.plantilla || 'semana';
    const lista = (req.body && req.body.alumnos) || [];
    if(!Array.isArray(lista) || !lista.length)
      return res.status(400).json({ ok:false, error:'no vino ningún alumno' });

    const forzar = String((req.body && req.body.forzar) || req.query.forzar || '') === '1';
    if(lista.length > TOPE_ENVIO_DIA && !forzar)
      return res.status(409).json({ ok:false, tope:true, cuantos:lista.length,
        error:'Son '+lista.length+' mensajes, más que el tope de '+TOPE_ENVIO_DIA+' de Meta. Confirmá para mandar igual.' });

    const resultados = [];
    let bien = 0, mal = 0;
    const paraGuardar = {};   // últimos 8 dígitos de cada número al que le mandamos
    for(const a of lista){
      const r = await enviarConfirmacion(a.tel, a.nombre, a.hora, a.sede, plantilla);
      if(r.ok){ bien++; } else { mal++; }
      const u8 = soloDigitos8(a.tel);
      if(u8) paraGuardar[u8] = true;
      resultados.push({ nombre:a.nombre, tel:a.tel, ok:r.ok, error:r.error||null,
                        id:r.id||null, estado:r.estado||null, respuesta:r.respuesta||null });
      await new Promise(ok=>setTimeout(ok, 120));  // respiro entre mensajes
    }

    /* Guardamos a quiénes les mandamos, para procesar SOLO sus respuestas. Si
       esto falla (por ejemplo un permiso de Firebase), los mensajes ya se
       enviaron igual: no rompemos el envío por esto. */
    let guardadoLista = false;
    try{
      await guardarEnFirebase('agente_v1/enviados/'+hoyAsuncion(), paraGuardar);
      _enviados = { hasta:0, set:null };   // que el webhook relea la lista nueva
      guardadoLista = true;
      ULTIMO_GUARDADO = { ok:true, cuando:new Date().toISOString(), cuantos:Object.keys(paraGuardar).length };
    }catch(e){
      resultados.push({ avisoLista:'no se pudo guardar la lista: '+e.message });
      ULTIMO_GUARDADO = { ok:false, cuando:new Date().toISOString(), error:e.message };
    }

    res.json({ ok:true, total:lista.length, bien, mal, guardadoLista, resultados });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.listen(PUERTO, () => {
  console.log('🎾 Agente Academia DG · '+VERSION+' — puerto '+PUERTO);
  if(!SECRETO)         console.log('   ⚠ Sin WEBHOOK_SECRET: no se verifica la firma.');
  if(!CLAVE_IA)        console.log('   ⚠ Sin ANTHROPIC_API_KEY: no va a clasificar.');
  if(!AGENTE_PASSWORD) console.log('   ⚠ Sin AGENTE_PASSWORD: no va a poder leer el padrón.');
});

export default app;
