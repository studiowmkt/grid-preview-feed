export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';

  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN não configurado' });

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';

    const filterConditions = [
      { or: [
        { property: 'Formato', select: { equals: 'FOTO' } },
        { property: 'Formato', select: { equals: 'CARD' } },
        { property: 'Formato', select: { equals: 'CARROSSEL' } },
        { property: 'Formato', select: { equals: 'VÍDEO' } }
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
      sorts: [{ property: 'DATA DE ENTREGA CLIENTE', direction: 'ascending' }],
      page_size: 60
    };

    const response = await fetch('https://api.notion.com/v1/databases/' + DATABASE_ID + '/query', {
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
      return res.status(response.status).json({ error: 'Erro ao consultar Notion', details: errorText });
    }

    const data = await response.json();

    const posts = data.results.map(page => {
      const props = page.properties;

      let imageUrl = '';
      const previewFeed = props['PREVIEW FEED'];
      if (previewFeed?.files?.length > 0) {
        const file = previewFeed.files[0];
        imageUrl = file.type === 'file' ? file.file.url : file.external.url;
      }

      const nomeP = props['Nome'];
      const nome = nomeP?.title?.length > 0 ? nomeP.title.map(t => t.plain_text).join('') : '';
      const formato = props['Formato']?.select?.name || '';
      const dataEntrega = props['DATA DE ENTREGA CLIENTE']?.date?.start || '';
      const pilar = props['PILAR']?.select?.name || '';
      const linhaProd = props['LINHA DE PRODUÇÃO']?.status?.name || '';

      return {
        id: page.id,
        nome,
        formato,
        data_entrega: dataEntrega,
        pilar,
        linha_producao: linhaProd,
        image_url: imageUrl,
        notion_url: page.url
      };
    }).filter(p => p.image_url);

    return res.status(200).json({ posts, total: data.results.length, updated_at: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', message: error.message });
  }
}
