export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID  = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';
  const debug        = req.query.debug === '1';

  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN nao configurado' });

  function driveFileId(url) {
    if (!url) return null;
    const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
  }

  function isValidPreviewUrl(url) {
    if (!url || !url.startsWith('http')) return false;
    if (url.includes('drive.google.com/drive/folders/')) return false;
    return true;
  }

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';
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
          const p = cd.properties;

          // Nome do cliente
          clientInfo.nome = p['Nome']?.title?.[0]?.plain_text || '';

          // FOTO DE PERFIL — campo tipo "file" (atenção: nome em MAJÚSCULAS)
          const fotoFiles = p['FOTO DE PERFIL']?.files;
          if (fotoFiles?.length > 0) {
            const f = fotoFiles[0];
            clientInfo.foto_url = f.type === 'file' ? f.file.url : (f.external?.url || '');
          }

          // HANDLE — campo tipo "rich_text"
          const handleArr = p['HANDLE']?.rich_text;
          if (handleArr?.length > 0) {
            clientInfo.arroba = handleArr.map(t => t.plain_text).join('');
          }
        }
      } catch (_) { /* non-fatal */ }
    }

    // Filtro de status: APROVADO, AGENDADO, ENTREGUE
    const statusFilter = {
      or: [
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'APROVADO'  } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'AGENDADO'  } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'ENTREGUE'  } }
      ]
    };

    const previewFilter = { property: 'PREVIEW FEED', url: { is_not_empty: true } };

    // Em modo debug, não aplica filtros — retorna tudo (até 20 posts)
    let filter;
    if (debug) {
      filter = clientPageId
        ? { property: 'CLIENTES SW', relation: { contains: clientPageId } }
        : undefined;
    } else {
      filter = clientPageId
        ? { and: [{ property: 'CLIENTES SW', relation: { contains: clientPageId } }, previewFilter, statusFilter] }
        : { and: [previewFilter, statusFilter] };
    }

    const body = {
      sorts: [{ property: 'DATA DE ENTREGA CLIENTE', direction: 'descending' }],
      page_size: debug ? 20 : 100
    };
    if (filter) body.filter = filter;

    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    if (data.object === 'error') throw new Error(data.message);

    const rawPosts = data.results.map(page => {
      const p    = page.properties;
      const rawUrl     = p['PREVIEW FEED']?.url || '';
      const status     = p['LINHA DE PRODUÇÃO']?.status?.name || '';
      const hasValidUrl = isValidPreviewUrl(rawUrl);

      let image_url = '';
      let embed_url = '';

      if (hasValidUrl) {
        const driveId = driveFileId(rawUrl);
        if (driveId) {
          image_url = `https://drive.google.com/thumbnail?id=${driveId}&sz=w640`;
          embed_url = `https://drive.google.com/file/d/${driveId}/preview`;
        } else {
          image_url = rawUrl;
        }
      }

      const post = {
        id:             page.id,
        notion_url:     page.url,
        nome:           p['Nome']?.title?.[0]?.plain_text || '',
        data_entrega:   p['DATA DE ENTREGA CLIENTE']?.date?.start || '',
        linha_producao: status,
        formato:        p['Formato']?.select?.name || '',
        pilar:          p['PILAR']?.select?.name   || '',
        image_url,
        embed_url,
        images: image_url ? [image_url] : []
      };

      // Em modo debug inclui info extra para diagnóstico
      if (debug) {
        post._debug = {
          preview_feed_raw:  rawUrl,
          preview_feed_ok:   hasValidUrl,
          status_ok:         ['APROVADO','AGENDADO','ENTREGUE'].includes(status),
          image_url_resolved: image_url || '(vazio — não aparecerá no grid)'
        };
      }

      return post;
    });

    // No modo normal, filtra apenas posts com imagem renderizável
    const posts = debug ? rawPosts : rawPosts.filter(p => p.image_url);

    return res.status(200).json({
      posts,
      client:     clientInfo,
      total:      data.results.length,
      shown:      posts.length,
      updated_at: new Date().toISOString(),
      ...(debug ? { _debug_mode: true, _hint: 'Adicione ?debug=1 para ver todos os posts e o motivo de cada um aparecer ou não no grid.' } : {})
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', message: error.message });
  }
}
