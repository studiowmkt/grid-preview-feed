export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID  = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';

  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN nao configurado' });

  function driveFileId(url) {
    if (!url || !url.includes('drive.google.com')) return null;
    const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';

    // fetch client info (CLIENTES STUDIO W database)
    let clientInfo = { nome: '', foto_url: '', arroba: '' };
    if (clientPageId) {
      try {
        const cr = await fetch(`https://api.notion.com/v1/pages/${clientPageId}`, {
          headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
        });
        if (cr.ok) {
          const cd = await cr.json();
          const p  = cd.properties;
          clientInfo.nome = p['Nome']?.title?.[0]?.plain_text || '';
          const fotoFiles = p['foto de perfil']?.files;
          if (fotoFiles?.length > 0) {
            const f = fotoFiles[0];
            clientInfo.foto_url = f.type === 'file' ? f.file.url : (f.external?.url || '');
          }
          const handleArr = p['HANDLE']?.rich_text;
          if (handleArr?.length > 0) clientInfo.arroba = handleArr.map(t => t.plain_text).join('');
        }
      } catch (_) { /* non-fatal */ }
    }

    // LINHA DE PRODUCAO is status type; CLIENTES SW is relation name; DATA DE ENTREGA CLIENTE is date
    const statusFilter = {
      or: [
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'APROVADO' } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'AGENDADO' } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'ENTREGUE' } }
      ]
    };

    // PREVIEW FEED is a URL field (single URL per post)
    const previewFilter = { property: 'PREVIEW FEED', url: { is_not_empty: true } };

    const filter = clientPageId
      ? { and: [
            { property: 'CLIENTES SW', relation: { contains: clientPageId } },
            previewFilter,
            statusFilter
          ] }
      : { and: [ previewFilter, statusFilter ] };

    const body = {
      sorts:     [{ property: 'DATA DE ENTREGA CLIENTE', direction: 'descending' }],
      filter,
      page_size: 100
    };

    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    if (data.object === 'error') throw new Error(data.message);

    const posts = data.results.map(page => {
      const p = page.properties;

      // PREVIEW FEED is URL type
      const rawUrl = p['PREVIEW FEED']?.url || '';
      let image_url = '';
      let embed_url = '';

      if (rawUrl) {
        const driveId = driveFileId(rawUrl);
        if (driveId) {
          const isVideo = /\.(mp4|mov|webm)/i.test(rawUrl);
          if (isVideo) {
            image_url = `https://drive.google.com/thumbnail?id=${driveId}&sz=w480`;
            embed_url = `https://drive.google.com/file/d/${driveId}/preview`;
          } else {
            image_url = `https://drive.google.com/uc?export=view&id=${driveId}`;
          }
        } else {
          image_url = rawUrl;
        }
      }

      return {
        id:             page.id,
        notion_url:     page.url,
        nome:           p['Nome']?.title?.[0]?.plain_text || '',
        data_entrega:   p['DATA DE ENTREGA CLIENTE']?.date?.start || '',
        linha_producao: p['LINHA DE PRODUÇÃO']?.status?.name || '',
        formato:        p['Formato']?.select?.name || '',
        pilar:          p['PILAR']?.select?.name || '',
        image_url,
        embed_url,
        images: image_url ? [image_url] : []
      };
    }).filter(p => p.image_url);

    return res.status(200).json({
      posts,
      client:     clientInfo,
      total:      data.results.length,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', message: error.message });
  }
}
