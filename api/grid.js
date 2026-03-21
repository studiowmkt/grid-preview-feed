export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN nÃ£o configurado' });

  // Extract Google Drive file ID from share URL
  function driveFileId(url) {
    if (!url || !url.includes('drive.google.com')) return null;
    const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';

    // ââ Fetch client info from CLIENTES STUDIO W âââââââââââââââââ
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
          // Nome
          clientInfo.nome = p['Nome']?.title?.[0]?.plain_text || '';
          // Foto (propriedade "Foto" jÃ¡ existe em CLIENTES STUDIO W)
          const fotoFiles = p['Foto']?.files;
          if (fotoFiles?.length > 0) {
            const f = fotoFiles[0];
            clientInfo.foto_url = f.type === 'file' ? f.file.url : (f.external?.url || '');
          }
          // Arroba (propriedade texto que o usuÃ¡rio precisa adicionar em CLIENTES STUDIO W)
          const arrobaArr = p['Arroba']?.rich_text;
          if (arrobaArr?.length > 0) {
            clientInfo.arroba = arrobaArr.map(t => t.plain_text).join('');
          }
        }
      } catch (_) { /* non-fatal */ }
    }

    // ââ Build filter ââââââââââââââââââââââââââââââââââââââââââââââ
    const formatFilter = { or: [
      { property: 'Formato', select: { equals: 'FOTO' } },
      { property: 'Formato', select: { equals: 'CARD' } },
      { property: 'Formato', select: { equals: 'CARROSSEL' } },
      { property: 'Formato', select: { equals: 'VÃDEO' } }
    ]};

    const statusFilter = { or: [
      { property: 'LINHA DE PRODUÃÃO', status: { equals: 'APROVADO' } },
      { property: 'LINHA DE PRODUÃÃO', status: { equals: 'AGENDADO' } },
      { property: 'LINHA DE PRODUÃÃO', status: { equals: 'ENTREGUE' } }
    ]};

    // Media: aceita arquivo anexado (PREVIEW FEED) OU link externo (PREVIEW URL)
    const mediaFilterWithUrl = { or: [
      { property: 'PREVIEW FEED', files: { is_not_empty: true } },
      { property: 'PREVIEW URL', url: { is_not_empty: true } }
    ]};
    const mediaFilterFilesOnly = { property: 'PREVIEW FEED', files: { is_not_empty: true } };

    const baseConditions = [formatFilter, statusFilter];
    if (clientPageId) {
      baseConditions.push({ property: 'CLIENTES SW', relation: { contains: clientPageId } });
    }

    const queryBody = {
      sorts: [{ property: 'DATA DE ENTREGA CLIENTE', direction: 'ascending' }],
      page_size: 60
    };

    const notionUrl = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
    const notionHeaders = {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    };

    // Tenta com PREVIEW URL; se a propriedade nÃ£o existir ainda, cai no fallback sÃ³ com arquivos
    let response = await fetch(notionUrl, {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify({ ...queryBody, filter: { and: [...baseConditions, mediaFilterWithUrl] } })
    });

    let data;
    if (!response.ok) {
      const errText = await response.text();
      if (errText.includes('PREVIEW URL') || errText.includes('Could not find')) {
        // Propriedade ainda nÃ£o existe â tenta sem ela
        const fallback = await fetch(notionUrl, {
          method: 'POST',
          headers: notionHeaders,
          body: JSON.stringify({ ...queryBody, filter: { and: [...baseConditions, mediaFilterFilesOnly] } })
        });
        if (!fallback.ok) {
          const fe = await fallback.text();
          return res.status(fallback.status).json({ error: 'Erro ao consultar Notion', details: fe });
        }
        data = await fallback.json();
      } else {
        return res.status(response.status).json({ error: 'Erro ao consultar Notion', details: errText });
      }
    } else {
      data = await response.json();
    }

    // ââ Map posts âââââââââââââââââââââââââââââââââââââââââââââââââ
    const posts = data.results.map(page => {
      const props = page.properties;
      const formato = props['Formato']?.select?.name || '';

      let imageUrl = '';
      let embedUrl = ''; // apenas para vÃ­deo do Google Drive (iframe no modal)

      // 1. PREVIEW URL (Google Drive ou qualquer link externo)
      const previewUrlRaw = props['PREVIEW URL']?.url;
      if (previewUrlRaw) {
        const fid = driveFileId(previewUrlRaw);
        if (fid) {
          if (formato === 'VÃDEO') {
            // Thumbnail para o grid; URL de embed para o modal
            imageUrl = `https://drive.google.com/thumbnail?id=${fid}&sz=w480`;
            embedUrl = `https://drive.google.com/file/d/${fid}/preview`;
          } else {
            imageUrl = `https://drive.google.com/uc?export=view&id=${fid}`;
          }
        } else {
          imageUrl = previewUrlRaw; // URL externa nÃ£o-Drive
        }
      }

      // 2. Fallback: arquivo anexado em PREVIEW FEED
      if (!imageUrl) {
        const previewFeed = props['PREVIEW FEED'];
        if (previewFeed?.files?.length > 0) {
          const file = previewFeed.files[0];
          imageUrl = file.type === 'file' ? file.file.url : file.external.url;
        }
      }

      const nomeP = props['Nome'];
      const nome = nomeP?.title?.length > 0 ? nomeP.title.map(t => t.plain_text).join('') : '';
      const dataEntrega = props['DATA DE ENTREGA CLIENTE']?.date?.start || '';
      const pilar = props['PILAR']?.select?.name || '';
      const linhaProd = props['LINHA DE PRODUÃÃO']?.status?.name || '';

      return {
        id: page.id,
        nome,
        formato,
        data_entrega: dataEntrega,
        pilar,
        linha_producao: linhaProd,
        image_url: imageUrl,
        embed_url: embedUrl,
        notion_url: page.url
      };
    }).filter(p => p.image_url);

    return res.status(200).json({
      posts,
      client: clientInfo,
      total: data.results.length,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', message: error.message });
  }
}
