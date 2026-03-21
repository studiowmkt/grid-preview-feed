export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID  = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN nÃ£o configurado' });

  function driveFileId(url) {
    if (!url || !url.includes('drive.google.com')) return null;
    const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';

    // ââ fetch client info ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    let clientInfo = { nome: '', foto_url: '', arroba: '' };
    if (clientPageId) {
      try {
        const cr = await fetch(`https://api.notion.com/v1/pages/${clientPageId}`, {
          headers: {
            'Authorization': `Bearer ${NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28'
          }
        });
        if (cr.ok) {
          const cd = await cr.json();
          const p  = cd.properties;

          // nome (title)
          clientInfo.nome = p['Nome']?.title?.[0]?.plain_text || '';

          // foto de perfil (files property)
          const fotoFiles = p['foto de perfil']?.files;
          if (fotoFiles?.length > 0) {
            const f = fotoFiles[0];
            clientInfo.foto_url = f.type === 'file' ? f.file.url : (f.external?.url || '');
          }

          // HANDLE (rich_text property)
          const handleArr = p['HANDLE']?.rich_text;
          if (handleArr?.length > 0) clientInfo.arroba = handleArr.map(t => t.plain_text).join('');
        }
      } catch (_) { /* non-fatal */ }
    }

    // ââ filter posts by client relation âââââââââââââââââââââââââââââââââââââââ
    const filter = clientPageId
      ? { property: 'Clientes Studio W', relation: { contains: clientPageId } }
      : undefined;

    const sorts = [{ property: 'Data de Entrega', direction: 'descending' }];

    // Try with PREVIEW URL property first; fall back if it doesn't exist yet
    let data;
    try {
      const body = {
        sorts,
        filter: filter
          ? {
              and: [
                filter,
                {
                  or: [
                    { property: 'PREVIEW URL',  url:   { is_not_empty: true } },
                    { property: 'PREVIEW FEED', files: { is_not_empty: true } }
                  ]
                },
                {
                  or: [
                    { property: 'Linha de ProduÃ§Ã£o', select: { equals: 'APROVADO'  } },
                    { property: 'Linha de ProduÃ§Ã£o', select: { equals: 'AGENDADO'  } },
                    { property: 'Linha de ProduÃ§Ã£o', select: { equals: 'ENTREGUE'  } }
                  ]
                }
              ]
            }
          : {
              or: [
                { property: 'PREVIEW URL',  url:   { is_not_empty: true } },
                { property: 'PREVIEW FEED', files: { is_not_empty: true } }
              ]
            },
        page_size: 100
      };

      const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      data = await r.json();
      if (data.object === 'error') throw new Error(data.message);
    } catch (e) {
      // Fallback: files-only filter (PREVIEW URL property may not exist yet)
      const body = {
        sorts,
        filter: filter
          ? {
              and: [
                filter,
                { property: 'PREVIEW FEED', files: { is_not_empty: true } },
                {
                  or: [
                    { property: 'Linha de ProduÃ§Ã£o', select: { equals: 'APROVADO'  } },
                    { property: 'Linha de ProduÃ§Ã£o', select: { equals: 'AGENDADO'  } },
                    { property: 'Linha de ProduÃ§Ã£o', select: { equals: 'ENTREGUE'  } }
                  ]
                }
              ]
            }
          : { property: 'PREVIEW FEED', files: { is_not_empty: true } },
        page_size: 100
      };

      const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      data = await r.json();
      if (data.object === 'error') throw new Error(data.message);
    }

    // ââ map results âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const posts = data.results.map(page => {
      const p = page.properties;

      // 1. Try PREVIEW URL (Google Drive or any direct URL)
      let image_url = '';
      let embed_url  = '';
      const previewUrl = p['PREVIEW URL']?.url || '';
      if (previewUrl) {
        const driveId = driveFileId(previewUrl);
        if (driveId) {
          // Detect if it's a video based on the original URL (best effort)
          const isVideo = /\.(mp4|mov|webm)/i.test(previewUrl);
          if (isVideo) {
            image_url = `https://drive.google.com/thumbnail?id=${driveId}&sz=w480`;
            embed_url = `https://drive.google.com/file/d/${driveId}/preview`;
          } else {
            image_url = `https://drive.google.com/uc?export=view&id=${driveId}`;
          }
        } else {
          image_url = previewUrl;
        }
      }

      // 2. Collect ALL files from PREVIEW FEED (for carousel support)
      const allFiles   = p['PREVIEW FEED']?.files || [];
      const fileImages = allFiles
        .map(f => f.type === 'file' ? f.file.url : (f.external?.url || ''))
        .filter(Boolean);

      // If no image_url from PREVIEW URL, use first file
      if (!image_url && fileImages.length > 0) {
        image_url = fileImages[0];
      }

      // Build images[] for carousel: Drive/URL image first, then all files
      let images = [];
      if (image_url && !fileImages.includes(image_url)) {
        images = [image_url, ...fileImages];
      } else if (fileImages.length > 0) {
        images = fileImages;
      } else if (image_url) {
        images = [image_url];
      }

      return {
        id:             page.id,
        notion_url:     page.url,
        nome:           p['Nome do Post']?.title?.[0]?.plain_text || p['Name']?.title?.[0]?.plain_text || '',
        data_entrega:   p['Data de Entrega']?.date?.start || '',
        linha_producao: p['Linha de ProduÃ§Ã£o']?.select?.name || '',
        formato:        p['Formato']?.select?.name || '',
        pilar:          p['Pilar']?.select?.name || '',
        image_url,
        embed_url,
        images
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
