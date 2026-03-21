export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID  = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';
  const GOOGLE_KEY   = process.env.GOOGLE_API_KEY || '';
  const debug        = req.query.debug === '1';

  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN nao configurado' });

  // ── helpers ──────────────────────────────────────────────────────────────

  function driveFileId(url) {
    if (!url) return null;
    const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
  }

  function driveFolderId(url) {
    if (!url) return null;
    const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function isValidPreviewUrl(url) {
    return !!(url && url.startsWith('http'));
  }

  // Resolve pasta → ID do arquivo mais recente
  // Estratégia 1: Google Drive API (se GOOGLE_API_KEY estiver configurada no Vercel)
  // Estratégia 2: parse do HTML da página embed do Drive (sem chave)
  async function resolveFolderToFileId(folderId) {
    // Estratégia 1 — Drive API v3 (mais confiável)
    if (GOOGLE_KEY) {
      try {
        const q   = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const url = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime+desc&pageSize=1&fields=files(id,name)&key=${GOOGLE_KEY}`;
        const r   = await fetch(url);
        if (r.ok) {
          const d = await r.json();
          if (d.files?.length > 0) return { id: d.files[0].id, via: 'api' };
        }
      } catch (_) { /* continua para estratégia 2 */ }
    }

    // Estratégia 2 — parse do HTML embed (sem chave de API)
    try {
      const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
      });
      if (r.ok) {
        const html = await r.text();
        const m = html.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
        if (m) return { id: m[1], via: 'html' };
      }
    } catch (_) { /* */ }

    return null;
  }

  // ── main ─────────────────────────────────────────────────────────────────

  // Busca info do cliente pelo ID de página (CLIENTES STUDIO W)
  async function fetchClientInfo(pageId, debugMode = false) {
    const info = { nome: '', foto_url: '', arroba: '' };
    let _dbg = {};
    try {
      const cr = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
      });
      _dbg.http_status = cr.status;
      if (!cr.ok) {
        const errBody = await cr.json().catch(() => ({}));
        _dbg.notion_error = errBody;
        if (debugMode) info._fetch_debug = _dbg;
        return info;
      }
      const cd = await cr.json();
      const p  = cd.properties;
      _dbg.properties_keys = Object.keys(p || {});
      info.nome = p['Nome']?.title?.[0]?.plain_text || '';
      const fotoFiles = p['FOTO DE PERFIL']?.files;
      if (fotoFiles?.length > 0) {
        const f = fotoFiles[0];
        info.foto_url = f.type === 'file' ? f.file.url : (f.external?.url || '');
      }
      const handleArr = p['HANDLE']?.rich_text;
      if (handleArr?.length > 0) info.arroba = handleArr.map(t => t.plain_text).join('');
      if (debugMode) info._fetch_debug = _dbg;
    } catch (e) {
      _dbg.exception = e.message;
      if (debugMode) info._fetch_debug = _dbg;
    }
    return info;
  }

  try {
    const clientPageId = req.query.client_page_id || process.env.CLIENT_PAGE_ID || '';
    let clientInfo = { nome: '', foto_url: '', arroba: '' };

    // Busca info do cliente se ID explícito fornecido
    if (clientPageId) {
      clientInfo = await fetchClientInfo(clientPageId, debug);
    }

    // Filtros
    const statusFilter = {
      or: [
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'APROVADO' } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'AGENDADO' } },
        { property: 'LINHA DE PRODUÇÃO', status: { equals: 'ENTREGUE' } }
      ]
    };
    const previewFilter = { property: 'PREVIEW FEED', url: { is_not_empty: true } };

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

    const results = data.results;

    // Resolver pastas em paralelo (sem bloquear a fila)
    const folderResolved = await Promise.all(
      results.map(page => {
        const rawUrl  = page.properties['PREVIEW FEED']?.url || '';
        const folderId = driveFolderId(rawUrl);
        return folderId ? resolveFolderToFileId(folderId) : Promise.resolve(null);
      })
    );

    const rawPosts = results.map((page, idx) => {
      const p        = page.properties;
      const rawUrl   = p['PREVIEW FEED']?.url || '';
      const status   = p['LINHA DE PRODUÇÃO']?.status?.name || '';
      const folderId = driveFolderId(rawUrl);
      const hasValid = isValidPreviewUrl(rawUrl);

      let image_url = '';
      let embed_url = '';
      let folder_ok = null;

      if (hasValid) {
        if (folderId) {
          // Link de pasta → usa arquivo resolvido
          const resolved = folderResolved[idx];
          if (resolved) {
            image_url = `https://drive.google.com/thumbnail?id=${resolved.id}&sz=w640`;
            embed_url = `https://drive.google.com/file/d/${resolved.id}/preview`;
            folder_ok = resolved.via;
          }
        } else {
          const fileId = driveFileId(rawUrl);
          if (fileId) {
            image_url = `https://drive.google.com/thumbnail?id=${fileId}&sz=w640`;
            embed_url = `https://drive.google.com/file/d/${fileId}/preview`;
          } else {
            image_url = rawUrl;
          }
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

      if (debug) {
        post._debug = {
          preview_feed_raw:  rawUrl,
          is_folder:         !!folderId,
          folder_resolved:   folder_ok,
          status_ok:         ['APROVADO', 'AGENDADO', 'ENTREGUE'].includes(status),
          image_url_result:  image_url || '(vazio — não aparecerá no grid)',
          tip: folderId && !folder_ok
            ? 'Pasta não resolvida: verifique se ela está com acesso "Qualquer pessoa com o link" e se GOOGLE_API_KEY está configurada no Vercel'
            : null
        };
      }

      return post;
    });

    const posts = debug ? rawPosts : rawPosts.filter(p => p.image_url);

    // Auto-detect cliente: se não veio client_page_id mas posts existem,
    // pega o cliente da relação do primeiro post automaticamente
    let autoDetectedId = null;
    if (!clientPageId && posts.length > 0) {
      autoDetectedId = results[0]?.properties['CLIENTES SW']?.relation?.[0]?.id;
      if (autoDetectedId) clientInfo = await fetchClientInfo(autoDetectedId, debug);
    }

    return res.status(200).json({
      posts,
      client:     clientInfo,
      total:      results.length,
      shown:      posts.length,
      updated_at: new Date().toISOString(),
      ...(debug ? {
        _debug_mode: true,
        _google_key: GOOGLE_KEY ? 'configurada ✓' : 'NÃO configurada (usando fallback HTML)',
        _client_page_id_used: clientPageId || autoDetectedId || '(nenhum)',
        _hint: 'Use ?debug=1 para diagnóstico. Use ?debug=1&client_page_id=ID para filtrar por cliente.'
      } : {})
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', message: error.message });
  }
}
