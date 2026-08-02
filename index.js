/* ============================================================
   AGENTE DE ACADEMIA DG — ETAPA 0

   Este servidor SOLO ESCUCHA Y ANOTA. No contesta nada, no toca
   Firebase, no toca el calendario, no le habla a ningún alumno.

   Sirve para dos cosas:
     1. Confirmar que los mensajes de Kapso llegan de verdad.
     2. Ver el formato REAL de esos mensajes, que es lo que hace falta
        para escribir el cerebro en la etapa siguiente.

   Mientras esto corre, el agente que ya funciona en Kapso sigue
   funcionando igual, sin enterarse de que esto existe.

   Para mirar lo que llegó, se abre la dirección del servidor en el
   navegador: hay una pantalla con los últimos mensajes.
   ============================================================ */

import express from 'express';
import crypto from 'crypto';

const app = express();
const PUERTO = process.env.PORT || 3000;
const SECRETO = process.env.WEBHOOK_SECRET || '';
const CUANTOS_GUARDA = 100;

/* Los mensajes se guardan en la memoria del servidor, no en un archivo
   ni en una base. Si el servidor se reinicia, se pierden — y está bien:
   esto es para mirar, no para conservar. */
const registro = [];
let arranque = new Date();
let totales = { recibidos: 0, firmaMal: 0, otros: 0 };

function anotar(evento) {
  registro.unshift({ ...evento, cuando: new Date().toISOString() });
  if (registro.length > CUANTOS_GUARDA) registro.pop();
}

/* Guardamos el cuerpo CRUDO del pedido, tal cual llegó.
   La firma se calcula sobre esos bytes exactos. Si se usara el JSON ya
   interpretado y vuelto a armar, la firma nunca coincide: es el error
   clásico de este tipo de integración. */
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.cuerpoCrudo = buf; }
}));

function firmaValida(cuerpoCrudo, firmaRecibida) {
  if (!SECRETO) return true;              // sin secreto configurado, no se verifica
  if (!firmaRecibida) return false;
  try {
    const calculada = crypto.createHmac('sha256', SECRETO).update(cuerpoCrudo).digest('hex');
    const a = Buffer.from(calculada, 'utf8');
    const b = Buffer.from(String(firmaRecibida).replace(/^sha256=/, ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);   // comparación segura, no un === común
  } catch (e) {
    return false;
  }
}

/* ---------- El webhook: acá llega el aviso de Kapso ---------- */
app.post('/webhooks/whatsapp', (req, res) => {
  /* PRIMERO se contesta "recibido". Kapso espera respuesta en menos de
     10 segundos y si no la tiene reintenta tres veces. Todo lo que hay
     que pensar se piensa DESPUÉS de contestar. */
  res.status(200).send('OK');

  try {
    const evento = req.headers['x-webhook-event'] || '(sin evento)';
    const idem = req.headers['x-idempotency-key'] || '';

    if (!firmaValida(req.cuerpoCrudo, req.headers['x-webhook-signature'])) {
      totales.firmaMal++;
      anotar({ tipo: 'FIRMA INVÁLIDA', evento, nota: 'el aviso no venía firmado como corresponde' });
      console.warn('⚠ Firma inválida. Se ignora.');
      return;
    }

    totales.recibidos++;
    if (evento !== 'whatsapp.message.received') totales.otros++;

    /* Se anota TODO el cuerpo tal cual vino. En esta etapa no se
       interpreta nada: justamente lo que queremos ver es qué manda
       Kapso de verdad, no lo que suponemos que manda. */
    anotar({
      tipo: 'MENSAJE',
      evento,
      idempotencia: idem,
      cuerpo: req.body
    });

    console.log('📩 ' + evento + '  ' + JSON.stringify(req.body).slice(0, 300));
  } catch (err) {
    /* Esto es lo que Kapso no te da: el error entero, con línea y todo. */
    console.error('Error procesando el aviso:', err);
    anotar({ tipo: 'ERROR', nota: String(err && err.message) });
  }
});

/* ---------- Para que Railway sepa que está vivo ---------- */
app.get('/salud', (req, res) => {
  res.json({
    estado: 'vivo',
    desde: arranque.toISOString(),
    ...totales,
    guardados: registro.length
  });
});

/* ---------- La pantalla para mirar, sin leer registros ---------- */
app.get('/', (req, res) => {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const filas = registro.map(r => `
    <div class="f ${r.tipo === 'MENSAJE' ? 'ok' : 'mal'}">
      <div class="c">${esc(new Date(r.cuando).toLocaleString('es-PY'))} · <b>${esc(r.tipo)}</b> · ${esc(r.evento || '')}</div>
      ${r.nota ? `<div class="n">${esc(r.nota)}</div>` : ''}
      ${r.cuerpo ? `<pre>${esc(JSON.stringify(r.cuerpo, null, 2))}</pre>` : ''}
    </div>`).join('');

  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agente Academia DG · Etapa 0</title>
<style>
 body{background:#0d1117;color:#e6edf3;font:14px system-ui,-apple-system,sans-serif;margin:0;padding:18px}
 h1{font-size:17px;margin:0 0 4px} .sub{color:#8b949e;font-size:13px;margin-bottom:16px}
 .caja{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 14px;margin-bottom:14px}
 .num{display:inline-block;margin-right:22px} .num b{font-size:20px;display:block}
 .f{background:#161b22;border:1px solid #30363d;border-left:3px solid #2ea043;border-radius:8px;padding:10px 12px;margin-bottom:9px}
 .f.mal{border-left-color:#d29922}
 .c{color:#8b949e;font-size:12.5px} .n{color:#d29922;font-size:13px;margin-top:4px}
 pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:9px;overflow:auto;
     font-size:12px;margin:8px 0 0;max-height:340px;white-space:pre-wrap;word-break:break-all}
 .vacio{color:#8b949e;text-align:center;padding:36px 0}
</style></head><body>
<h1>🎾 Agente Academia DG — Etapa 0</h1>
<div class="sub">Este servidor solo escucha y anota. No contesta ningún mensaje ni toca el calendario.</div>
<div class="caja">
  <span class="num"><b>${totales.recibidos}</b>mensajes</span>
  <span class="num"><b>${totales.firmaMal}</b>firma inválida</span>
  <span class="num"><b>${registro.length}</b>guardados</span>
  <span class="num" style="color:#8b949e"><b style="font-size:13px;color:#e6edf3">${esc(arranque.toLocaleString('es-PY'))}</b>encendido desde</span>
</div>
${filas || '<div class="vacio">Todavía no llegó ningún mensaje.<br>Escribile al número de prueba de Kapso y recargá esta página.</div>'}
<script>setTimeout(()=>location.reload(), 15000)</script>
</body></html>`);
});

app.listen(PUERTO, () => {
  console.log('🎾 Agente Academia DG · Etapa 0 — escuchando en el puerto ' + PUERTO);
  console.log('   Webhook:  POST /webhooks/whatsapp');
  console.log('   Pantalla: GET  /');
  if (!SECRETO) console.log('   ⚠ Sin WEBHOOK_SECRET: no se verifica la firma.');
});

export default app;
