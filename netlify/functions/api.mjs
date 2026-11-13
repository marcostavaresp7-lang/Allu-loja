import { getStore } from "@netlify/blobs";

const PRODUCTS = {"kit-grace": {"name": "Kit Presente Grace Royale", "price": 334.9}, "empire-presence": {"name": "Empire Woman Presence", "price": 294.9}, "empire-glam": {"name": "Empire Woman Glam", "price": 214.9}, "empire-woman": {"name": "Empire Woman", "price": 214.9}, "joli-coffee": {"name": "Joli Coffee & Red Berries", "price": 94.9}, "sens-confianca": {"name": "Sensações Confiança", "price": 54.9}, "sens-intuicao": {"name": "Sensações Intuição", "price": 54.9}, "kit-sens-hands": {"name": "Kit Presente Confiança + Hands Aloe Vera", "price": 87.8}, "kit-joli-ameixa": {"name": "Kit Presente Joli Ameixa & Jasmim + Confiança", "price": 134.8}, "kit-dazzle": {"name": "Kit Presente Dazzle + Confiança", "price": 194.8}};
const COMISSAO_POR_ITEM = 15;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "direto";

export default async (req) => {
  const url = new URL(req.url);
  const a = url.searchParams.get("a");
  const orders = getStore("orders");
  const TOKEN = process.env.MP_ACCESS_TOKEN;

  if (a === "pay" && req.method === "POST") {
    try {
      const { formData, items, ref, via, cliente } = await req.json();
      let total = 0, qtd = 0; const itens = [];
      for (const it of items || []) {
        const p = PRODUCTS[it.id];
        const q = Math.max(1, Math.min(20, parseInt(it.q) || 0));
        if (!p) return json({ error: "Produto inválido" }, 400);
        total += p.price * q; qtd += q;
        itens.push({ id: it.id, nome: p.name, q, preco: p.price });
      }
      if (!itens.length) return json({ error: "Sacola vazia" }, 400);
      total = Math.round(total * 100) / 100;
      const orderId = crypto.randomUUID();
      const payload = {
        transaction_amount: total,
        token: formData.token,
        description: "Allu Cosméticos",
        installments: formData.installments,
        payment_method_id: formData.payment_method_id,
        issuer_id: formData.issuer_id,
        payer: {
          email: (formData.payer && formData.payer.email) || cliente.email || cliente.e,
          identification: formData.payer && formData.payer.identification,
        },
        external_reference: orderId,
        notification_url: process.env.URL + "/.netlify/functions/api?a=webhook",
        metadata: { ref: slug(ref), orderId },
      };
      const r = await fetch("https://api.mercadopago.com/v1/payments", {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json", "X-Idempotency-Key": orderId },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok || !d.id) return json({ error: "Não foi possível processar o pagamento. Confira os dados." }, 400);
      await orders.setJSON(orderId, {
        id: orderId, ts: Date.now(), ref: slug(ref), via: String(via || "loja").slice(0, 40),
        cliente: { nome: cliente.n, whatsapp: cliente.w, email: cliente.e, endereco: cliente.a },
        itens, total, qtd, comissao: qtd * COMISSAO_POR_ITEM,
        status: d.status, mpId: d.id,
      });
      const td = d.point_of_interaction && d.point_of_interaction.transaction_data;
      return json({
        orderId, status: d.status, detail: d.status_detail,
        pix: td ? { qr: td.qr_code, qr_base64: td.qr_code_base64 } : null,
      });
    } catch (e) {
      return json({ error: "Erro ao processar o pedido." }, 500);
    }
  }

  if (a === "webhook") {
    try {
      let id = url.searchParams.get("data.id") || url.searchParams.get("id");
      if (!id && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        id = b && b.data && b.data.id;
      }
      if (id) {
        const r = await fetch("https://api.mercadopago.com/v1/payments/" + id, { headers: { Authorization: "Bearer " + TOKEN } });
        const d = await r.json();
        if (d.external_reference) {
          const o = await orders.get(d.external_reference, { type: "json" });
          if (o) { o.status = d.status; o.mpId = d.id; await orders.setJSON(o.id, o); }
        }
      }
    } catch (e) {}
    return new Response("ok", { status: 200 });
  }

  if (a === "admin") {
    if (!process.env.ADMIN_PASSWORD || req.headers.get("x-admin-password") !== process.env.ADMIN_PASSWORD) {
      return json({ error: "Senha incorreta" }, 401);
    }
    const { blobs } = await orders.list();
    const all = [];
    for (const b of blobs) { const o = await orders.get(b.key, { type: "json" }); if (o) all.push(o); }
    all.sort((x, y) => y.ts - x.ts);
    return json({ orders: all, comissaoPorItem: COMISSAO_POR_ITEM });
  }

  return json({ error: "Não encontrado" }, 404);
};
