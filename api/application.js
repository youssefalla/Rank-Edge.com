// Vercel serverless function: receives the /application form and emails it via Resend.
// Env vars (Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY  (required)
//   RESEND_FROM     (optional, e.g. "RankEdge <candidature@rank-edge.com>" once the domain is verified)
//   RESEND_TO       (optional, defaults to youssefalla674@gmail.com)
//   GOOGLE_SHEET_WEBHOOK_URL + GOOGLE_SHEET_SECRET  (optional: also add each lead as a row in Google Sheets)

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  // Honeypot: bots fill hidden fields — pretend success, send nothing
  if (body._gotcha) return res.status(200).json({ ok: true });

  var data = {
    nom: String(body.nom || '').trim().slice(0, 100),
    prenom: String(body.prenom || '').trim().slice(0, 100),
    deuxiemePrenom: String(body.deuxieme_prenom || '').trim().slice(0, 100),
    naissance: String(body.date_naissance || '').trim().slice(0, 20),
    nationalite: String(body.nationalite || '').trim().slice(0, 60),
    ville: String(body.ville || '').trim().slice(0, 100),
    adresse: String(body.adresse_residence || '').trim().slice(0, 600),
    email: String(body.email || '').trim().slice(0, 200),
    whatsapp: String(body.whatsapp || '').trim().slice(0, 40)
  };

  if (!data.nom || !data.prenom || !data.naissance || !data.nationalite || !data.ville || !data.adresse || !data.whatsapp ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return res.status(400).json({ error: 'Champs manquants ou invalides' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  }

  // Google Sheets row runs in parallel with the email
  var sheetDone = saveToSheet(data);

  var waLink = 'https://wa.me/' + data.whatsapp.replace(/\D/g, '');
  var rows = [
    ['Nom', esc(data.nom)],
    ['Prénom', esc(data.prenom)],
    ['Deuxième prénom', esc(data.deuxiemePrenom || '—')],
    ['Date de naissance', esc(data.naissance)],
    ['Nationalité', esc(data.nationalite)],
    ['Ville de résidence', esc(data.ville)],
    ['Adresse de résidence', esc(data.adresse).replace(/\n/g, '<br>')],
    ['E-mail', '<a href="mailto:' + esc(data.email) + '">' + esc(data.email) + '</a>'],
    ['WhatsApp', '<a href="' + esc(waLink) + '">' + esc(data.whatsapp) + '</a>']
  ];

  var html =
    '<div style="font-family:Arial,sans-serif;max-width:560px">' +
    '<h2 style="margin:0 0 16px">Nouvelle candidature — RankEdge</h2>' +
    '<table cellpadding="10" style="border-collapse:collapse;width:100%">' +
    rows.map(function (r) {
      return '<tr><td style="border:1px solid #ddd;background:#f6f6f6;font-weight:bold;width:40%">' + r[0] +
        '</td><td style="border:1px solid #ddd">' + r[1] + '</td></tr>';
    }).join('') +
    '</table></div>';

  var text = [
    'Nom : ' + data.nom,
    'Prénom : ' + data.prenom,
    'Deuxième prénom : ' + (data.deuxiemePrenom || '—'),
    'Date de naissance : ' + data.naissance,
    'Nationalité : ' + data.nationalite,
    'Ville de résidence : ' + data.ville,
    'Adresse de résidence : ' + data.adresse,
    'E-mail : ' + data.email,
    'WhatsApp : ' + data.whatsapp
  ].join('\n');

  var emailOk = false;
  try {
    var r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'RankEdge <onboarding@resend.dev>',
        to: [process.env.RESEND_TO || 'youssefalla674@gmail.com'],
        reply_to: data.email,
        subject: 'Nouvelle candidature — ' + [data.prenom, data.deuxiemePrenom, data.nom].filter(Boolean).join(' '),
        html: html,
        text: text
      })
    });
    if (r.ok) emailOk = true;
    else console.error('Resend error', r.status, await r.text());
  } catch (err) {
    console.error('Resend request failed', err);
  }

  var sheetOk = await sheetDone;
  // The lead is kept if it reached either the inbox or the sheet
  if (emailOk || sheetOk) return res.status(200).json({ ok: true });
  return res.status(502).json({ error: 'Email failed' });
};

async function saveToSheet(data) {
  var url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!url) return false;
  try {
    // Apps Script answers with a redirect; fetch follows it by default
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      // `row` is keyed by the sheet's column headers; the script adds any missing column itself
      body: JSON.stringify(Object.assign({ secret: process.env.GOOGLE_SHEET_SECRET }, data, {
        row: {
          'Nom': data.nom,
          'Prénom': data.prenom,
          'Deuxième prénom': data.deuxiemePrenom,
          'Date de naissance': data.naissance,
          'Nationalité': data.nationalite,
          'Ville de résidence': data.ville,
          'Adresse de résidence': data.adresse,
          'E-mail': data.email,
          'WhatsApp': data.whatsapp
        }
      })),
      signal: AbortSignal.timeout(8000)
    });
    var body = await r.text();
    if (!r.ok || body.indexOf('"ok":true') === -1) {
      console.error('Google Sheet error', r.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Google Sheet request failed', err);
    return false;
  }
}
