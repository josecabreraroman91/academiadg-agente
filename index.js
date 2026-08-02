/* ============================================================
   AGENTE DE ACADEMIA DG — ETAPA 1

   El servidor ahora ENTIENDE, pero sigue SIN CONTESTAR.

   Por cada mensaje que llega:
     1. Busca de qué alumno es ese teléfono, en el padrón
     2. Le pide a Claude que lo clasifique
     3. Anota en la pantalla qué HABRÍA hecho

   Lo que NO hace, y es a propósito:
     · No le contesta a ningún alumno
     · No escribe nada en Firebase
     · No toca el calendario ni la libreta

   La idea es dejarlo unos días al lado del agente de Kapso y comparar.
   Si coinciden, el cerebro nuevo está listo para tomar la posta.
   ============================================================ */

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
const totales = { recibidos:0, firmaMal:0, clasificados:0, sinAlumno:0, errores:0 };

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
          const hoy = new Date().toISOString().slice(0,10);
          fila.clasi = await clasificar(msg.texto, hoy);
          totales.clasificados++;
          if(fila.clasi.tipo === 'confirma'){
            fila.habriaContestado = RESPUESTAS[Math.floor(Math.random()*RESPUESTAS.length)];
          }
        }catch(e){ fila.errorClasi = e.message; totales.errores++; }
      } else {
        fila.clasi = { tipo:'nada', porque:'no es un mensaje de texto ('+(msg.tipo||'?')+')' };
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
  res.json({ estado:'vivo', desde:arranque.toISOString(), ...totales, guardados:registro.length,
             claveIA: !!CLAVE_IA, claveAgente: !!AGENTE_PASSWORD });
});

/* ---------- Probar sin esperar un WhatsApp ---------- */
app.get('/probar', async (req,res) => {
  const texto = req.query.texto || 'mañana no puedo, tengo examen';
  try{
    const hoy = new Date().toISOString().slice(0,10);
    res.json({ texto, resultado: await clasificar(texto, hoy) });
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
'<h1>🎾 Agente Academia DG — Etapa 1</h1>'+
'<div class="sub">Entiende los mensajes pero <b>no contesta ninguno</b>. Nada se escribe en el calendario ni en la libreta.</div>'+
'<div class="caja">'+
'  <span class="num"><b>'+totales.recibidos+'</b>mensajes</span>'+
'  <span class="num"><b>'+totales.clasificados+'</b>clasificados</span>'+
'  <span class="num"><b>'+totales.sinAlumno+'</b>sin alumno</span>'+
'  <span class="num"><b>'+totales.errores+'</b>errores</span>'+
'  <span class="num"><b>'+totales.firmaMal+'</b>firma inválida</span>'+
'</div>'+
(filas || '<div class="vacio">Todavía no llegó ningún mensaje.<br>Escribile al número de prueba de Kapso y recargá.</div>')+
'<script>setTimeout(function(){location.reload()}, 20000)</script>'+
'</body></html>');
});

app.listen(PUERTO, () => {
  console.log('🎾 Agente Academia DG · Etapa 1 — puerto '+PUERTO);
  if(!SECRETO)         console.log('   ⚠ Sin WEBHOOK_SECRET: no se verifica la firma.');
  if(!CLAVE_IA)        console.log('   ⚠ Sin ANTHROPIC_API_KEY: no va a clasificar.');
  if(!AGENTE_PASSWORD) console.log('   ⚠ Sin AGENTE_PASSWORD: no va a poder leer el padrón.');
});

export default app;
