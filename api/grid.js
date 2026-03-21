export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID  = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN nao configurado' });

  function driveFileId(url) {
    if (!url) return null;
    // file/d/FILEID pattern
    const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    // ?id=FILEID or &id=FILEID pattern
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
  }

  function isValidPreviewUrl(url) {
    // Must be a real HTTP(S) URL — reject plain filenames, folder URLs, etc.
    if (!url || !url.startsWith('http')) return false;
    // Reject Drive folder URLs (no per-file thumbnail available)
    if (url.includes('drive.google.com/drive/folders/')) return false;
    return true;
  }

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';

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

    const statusFilter = {
      or: [
        { property: 'LINHA DE PRODU\u00c7\u00c3O', status: { equals: 'APROVADO' } },
        { property: 'LINHA DE PRODU\u00c7\u00c3O', status: { equals: 'AGENDADO' } },
        { property: 'LINHA DE PRODU\u00c7\u00c3O', status: { equals: 'ENTREGUE' } }
      ]
    };
    const previewFilter = { property: 'PREVIEW FEED', url: { is_not_empty: true } };

    const filter = clientPageId
      ? { and: [{ property: 'CLIENTES SW', relation: { contains: clientPageId } }, previewFilter, statusFilter] }
      : { and: [previewFilter, statusFilter] };

    const body = {
      sorts: [{ property: 'DATA DE ENTREGA CLIENTE', direction: 'descending' }],
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
      const rawUrl = p['PREVIEW FEED']?.url || '';
      let image_url = '';
      let embed_url = '';

      if (isValidPreviewUrl(rawUrl)) {
        const driveId = driveFileId(rawUrl);
        if (driveId) {
          // Use thumbnail API — works for images and videos, no CORS issues
          image_url = `https://drive.google.com/thumbnail?id=${driveId}&sz=w640`;
          embed_url = `https://drive.google.com/file/d/${driveId}/preview`;
        } else {
          image_url = rawUrl;
        }
      }

      return {
        id:             page.id,
        notion_url:     page.url,
        nome:           p['Nome']?.title?.[0]?.plain_text || '',
        data_entrega:   p['DATA DE ENTREGA CLIENTE']?.date?.start || '',
        linha_producao: p['LINHA DE PRODU\u00c7\u00c3O']?.status?.name || '',
        formato:        p['Formato']?.select?.name || '',
        pilar:          p['PILAR']?.select?.name || '',
        image_url,
        embed_url,
        images: image_url ? [image_url] : []
      };
    }).filter(p => p.image_url); // only posts with a valid renderable URL

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
