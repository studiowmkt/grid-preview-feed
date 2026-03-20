export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN nao configurado' });
  }

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';

    const filterConditions = [
      { or: [
        { property: 'Formato', select: { equals: 'FOTO' } },
        { property: 'Formato', select: { equals: 'CARD' } },
        { property: 'Formato', select: { equals: 'CARROSSEL' } },
        { property: 'Formato', select: { equals: 'VíDEO' } }
      ]},
      { or: [
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'APROVADO' } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'AGENDADO' } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'ENTREGUE' } }
      ]},
      { property: 'PREVIEW FEED', files: { is_not_empty: true } }
    ];

    if (clientPageId) {
      filterConditions.push({ property: 'CLIENTES SW', relation: { contains: clientPageId } });
    }

    const queryBody = {
      filter: { and: filterConditions },
      sorts: [{ property: 'DATA DE PUBLICACAO', direction: 'descending' }],
      page_size: 30
    };

    const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(queryBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: 'Notion API error', details: errorText });
    }

    const data = await response.json();

    const posts = data.results.map(page => {
      const props = page.properties;
      const previewFiles = props['PREVIEW FEED']?.files || [];
      const imageUrl = previewFiles.length > 0
        ? (previewFiles[0].type === 'external' ? previewFiles[0].external?.url : previewFiles[0].file?.url)
        : null;

      const titleProp = props['Nome'] || props['Name'] || props['TITULO'] || props['TÍTULO'];
      const title = titleProp?.title?.[0]?.plain_text || 'Sem titulo';

      return {
        id: page.id,
        title,
        imageUrl,
        format: props['Formato']?.select?.name || '',
        status: props['LINHA DE PRODUÇÃO']?.status?.name || ''
      };
    }).filter(p => p.imageUrl);

    const clientFiles = clientPageId ? [] : [];

    return res.status(200).json({
      posts,
      total: posts.length,
      updated_at: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
