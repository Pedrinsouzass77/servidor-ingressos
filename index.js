const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── Configuração ──────────────────────────────────────────────
const PAGBANK_TOKEN   = process.env.PAGBANK_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const FRONTEND_URL    = process.env.FRONTEND_URL;
const PAGBANK_BASE    = 'https://sandbox.api.pagseguro.com';

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Gerar código único de 4 dígitos ──────────────────────────
async function gerarCodigo() {
  let codigo, existe;
  do {
    codigo = String(Math.floor(1000 + Math.random() * 9000));
    const { data } = await db.from('ingressos').select('id').eq('codigo', codigo).maybeSingle();
    existe = !!data;
  } while (existe);
  return codigo;
}

// ── POST /api/criar-pedido ────────────────────────────────────
app.post('/api/criar-pedido', async (req, res) => {
  const { nome, telefone, ticket_type, ticket_name, qty, amount, payment_method } = req.body;
  if (!nome || !amount) return res.status(400).json({ error: 'Dados incompletos' });

  try {
    const pedidoId = crypto.randomUUID();

    // Salva pedido no Supabase
    await db.from('pedidos').insert({
      id: pedidoId, nome, telefone,
      ticket_type, ticket_name, qty, amount,
      payment_method, status: 'PENDING'
    });

    // Cria cobrança no PagBank
    const { data: pagbank } = await axios.post(
      `${PAGBANK_BASE}/checkouts`,
      {
        reference_id: pedidoId,
        customer: {
          name: nome,
          tax_id: '12345678909',
          phones: [{
            country: '55',
            area: telefone.replace(/\D/g,'').substring(0,2),
            number: telefone.replace(/\D/g,'').substring(2),
            type: 'MOBILE'
          }]
        },
        items: [{ name: `${ticket_name} × ${qty}`, quantity: 1, unit_amount: amount }],
        notification_urls: [`${process.env.BACKEND_URL}/api/webhook`],
        redirect_url: `${FRONTEND_URL}/ingresso.html?pedido_id=${pedidoId}`,
        expiration_date: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      },
      { headers: { Authorization: `Bearer ${PAGBANK_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const paymentUrl = pagbank.links?.find(l => l.rel === 'PAY')?.href;
    if (!paymentUrl) throw new Error('URL de pagamento não retornada');

    res.json({ payment_url: paymentUrl, pedido_id: pedidoId });

  } catch (err) {
    console.error('[criar-pedido]', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao criar pedido', detail: err.response?.data || err.message });
  }
});

// ── POST /api/webhook ─────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const body   = req.body.toString('utf8');
    const evento = JSON.parse(body);
    const status = evento.charges?.[0]?.status;
    const pedidoId = evento.reference_id;
    if (!pedidoId) return res.sendStatus(200);

    if (status === 'PAID') {
      const { data: existe } = await db.from('ingressos').select('id').eq('pedido_id', pedidoId).maybeSingle();
      if (!existe) {
        const { data: pedido } = await db.from('pedidos').select('*').eq('id', pedidoId).single();
        if (pedido) {
          for (let i = 0; i < pedido.qty; i++) {
            const codigo = await gerarCodigo();
            await db.from('ingressos').insert({
              pedido_id: pedidoId,
              nome: pedido.nome,
              telefone: pedido.telefone,
              ticket_type: pedido.ticket_type,
              ticket_name: pedido.ticket_name,
              codigo, usado: false
            });
          }
          await db.from('pedidos').update({ status: 'PAID' }).eq('id', pedidoId);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook]', err.message);
    res.sendStatus(200);
  }
});

// ── GET /api/ingresso/:pedidoId ───────────────────────────────
app.get('/api/ingresso/:pedidoId', async (req, res) => {
  const { data, error } = await db.from('ingressos').select('*').eq('pedido_id', req.params.pedidoId).limit(1).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Ingresso não encontrado' });
  res.json(data);
});

// ── POST /api/validar-ingresso ────────────────────────────────
app.post('/api/validar-ingresso', async (req, res) => {
  const { codigo } = req.body;
  if (!codigo || codigo.length !== 4) return res.status(400).json({ valido: false, motivo: 'Código inválido' });

  const { data: ing } = await db.from('ingressos').select('*').eq('codigo', codigo).maybeSingle();
  if (!ing) return res.json({ valido: false, motivo: 'Código não encontrado' });
  if (ing.usado) return res.json({ valido: false, motivo: 'ja_usado', nome: ing.nome, usado_em: ing.usado_em });

  await db.from('ingressos').update({ usado: true, usado_em: new Date().toISOString() }).eq('codigo', codigo);
  res.json({ valido: true, nome: ing.nome, ticket_name: ing.ticket_name, codigo: ing.codigo });
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Servidor de ingressos rodando!' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
