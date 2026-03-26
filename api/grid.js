export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID || '1880d359-56f6-81c5-83f6-f889201c49e9';
  const GOOGLE_KEY  = process.env.GOOGLE_API_KEY || '';

  // Debug mode: requer token secreto definido como GRID_DEBUG_TOKEN no Vercel
  // Fallback para '1' apenas se GRID_DEBUG_TOKEN nÃÂ£o estiver configurado (retrocompatibilidade)
  const DEBUG_TOKEN = process.env.GRID_DEBUG_TOKEN || '';
  const debug = DEBUG_TOKEN
    ? (req.query.debug === DEBUG_TOKEN)
    : (req.query.debug === '1');

  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN nao configurado' });

  // Ã¢ÂÂÃ¢ÂÂ helpers Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ

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

  // Converte Buffer do Node.js para ArrayBuffer correto (sem o pool offset)
  // Buffer.from().buffer retorna o pool inteiro Ã¢ÂÂ ÃÂ© preciso fatiar o trecho correto
  function bufToArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  // Autentica via Google Service Account (para pastas privadas)
  async function getServiceAccountToken(saJson) {
    try {
      const sa  = JSON.parse(saJson);
      const now = Math.floor(Date.now() / 1000);
      const toB64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

      const header  = toB64({ alg: 'RS256', typ: 'JWT' });
      const payload = toB64({
        iss:   sa.client_email,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        aud:   'https://oauth2.googleapis.com/token',
        exp:   now + 3600,
        iat:   now,
      });

      const unsigned = header + '.' + payload;

      // Limpa o PEM e extrai bytes da chave privada
      const pemBody  = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
      const keyBuf   = Buffer.from(pemBody, 'base64');
      // FIX: usa bufToArrayBuffer para evitar o bug do Node.js Buffer pool
      const cryptoKey = await globalThis.crypto.subtle.importKey(
        'pkcs8',
        bufToArrayBuffer(keyBuf),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );

      // FIX: mesma correÃÂ§ÃÂ£o para os dados a assinar
      const unsignedBuf = Buffer.from(unsigned);
      const sigBuf = await globalThis.crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        cryptoKey,
        bufToArrayBuffer(unsignedBuf)
      );

      const jwt = unsigned + '.' + Buffer.from(sigBuf).toString('base64url');

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion:  jwt,
        }),
      });

      if (!res.ok) return null;
      const { access_token } = await res.json();
      return access_token;
    } catch (_) {
      return null;
    }
  }

  // Resolve pasta Ã¢ÂÂ ID do arquivo mais recente
  // EstratÃÂ©gia 1: Service Account (pastas privadas Ã¢ÂÂ email da SA adicionado como membro)
  // EstratÃÂ©gia 2: API Key simples (pastas pÃÂºblicas)
  // EstratÃÂ©gia 3: parse do HTML embed do Drive (fallback sem chave)
  async function resolveFolderToFileId(folderId) {
    const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

    // EstratÃÂ©gia 1 Ã¢ÂÂ Service Account
    if (SA_JSON) {
      const token = await getServiceAccountToken(SA_JSON);
      if (token) {
        try {
          const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
          const r = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime+desc&pageSize=20&fields=files(id,name,mimeType)`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (r.ok) {
            const d = await r.json();
            if (d.files?.length > 0) const best_sa = d.files.find(f=>f.mimeType&&f.mimeType.startsWith('image/')) || d.files[0]; return { id: best_sa.id, via: 'sa' };
          }
        } catch (_) { /* continua */ }
      }
    }

    // EstratÃÂ©gia 2 Ã¢ÂÂ API Key (sÃÂ³ para pastas pÃÂºblicas)
    if (GOOGLE_KEY) {
      try {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime+desc&pageSize=20&fields=files(id,name,mimeType)&key=${GOOGLE_KEY}`
        );
        if (r.ok) {
          const d = await r.json();
          if (d.files?.length > 0) const best_api = d.files.find(f=>f.mimeType&&f.mimeType.startsWith('image/')) || d.files[0]; return { id: best_api.id, via: 'api' };
        }
      } catch (_) { /* continua */ }
    }

    // EstratÃÂ©gia 3 Ã¢ÂÂ parse do HTML embed (sem chave, sÃÂ³ para pastas pÃÂºblicas)
    try {
      const r = await fetch(
        `https://drive.google.com/embeddedfolderview?id=${folderId}#list`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        }
      );
      if (r.ok) {
        const html = await r.text();
        const m    = html.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
        if (m) return { id: m[1], via: 'html' };
      }
    } catch (_) { /* */ }

    return null;
  }

  // Ã¢ÂÂÃ¢ÂÂ main Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ

  // Busca info do cliente pelo ID de pÃÂ¡gina (CLIENTES STUDIO W)
  async function fetchClientInfo(pageId, debugMode = false) {
    const info = { nome: '', foto_url: '', arroba: '' };
    let _dbg = {};
    try {
      const cr = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        headers: {
          Authorization:    `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        },
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

    if (clientPageId) {
      clientInfo = await fetchClientInfo(clientPageId, debug);
    }

    const statusFilter = {
      or: [
        { property: 'LINHA DE PRODUÃÂÃÂO', status: { equals: 'APROVADO'  } },
        { property: 'LINHA DE PRODUÃÂÃÂO', status: { equals: 'AGENDADO'  } },
        { property: 'LINHA DE PRODUÃÂÃÂO', status: { equals: 'ENTREGUE'  } },
      ],
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
      sorts:     [{ property: 'ENTREGA CLIENTE', direction: 'descending' }],
      page_size: debug ? 20 : 100,
    };
    if (filter) body.filter = filter;

    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method:  'POST',
      headers: {
        Authorization:    `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();
    if (data.object === 'error') throw new Error(data.message);

    const results = data.results;

    // Resolve pastas em paralelo
    const folderResolved = await Promise.all(
      results.map(page => {
        const rawUrl   = page.properties['PREVIEW FEED']?.url || '';
        const folderId = driveFolderId(rawUrl);
        return folderId ? resolveFolderToFileId(folderId) : Promise.resolve(null);
      })
    );

    const rawPosts = results.map((page, idx) => {
      const p      = page.properties;
      const rawUrl = p['PREVIEW FEED']?.url || '';
      const status = p['LINHA DE PRODUÃÂÃÂO']?.status?.name || '';
      const folderId = driveFolderId(rawUrl);
      const hasValid = isValidPreviewUrl(rawUrl);

      let image_url  = '';
      let embed_url  = '';
      let folder_ok  = null;

      if (hasValid) {
        if (folderId) {
          const resolved = folderResolved[idx];
          if (resolved) {
            image_url = `/api/thumb?id=${resolved.id}`;
            embed_url = `https://drive.google.com/file/d/${resolved.id}/preview`;
            folder_ok = resolved.via;
          }
        } else {
          const fileId = driveFileId(rawUrl);
          if (fileId) {
            image_url = `/api/thumb?id=${fileId}`;
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
        data_entrega:   p['ENTREGA CLIENTE']?.date?.start || '',
        linha_producao: status,
        formato:        p['Formato']?.select?.name || '',
        pilar:          p['PILAR']?.select?.name || '',
        image_url,
        embed_url,
        folder_url: (folderId && !image_url) ? rawUrl : '',
        images:     image_url ? [image_url] : [],
      };

      if (debug) {
        post._debug = {
          preview_feed_raw:  rawUrl,
          is_folder:         !!folderId,
          folder_resolved:   folder_ok,
          status_ok:         ['APROVADO', 'AGENDADO', 'ENTREGUE'].includes(status),
          image_url_result:  image_url || '(vazio Ã¢ÂÂ nÃÂ£o aparecerÃÂ¡ no grid)',
          tip: folderId && !folder_ok
            ? 'Pasta nÃÂ£o resolvida: verifique se ela estÃÂ¡ compartilhada com a Service Account'
            : null,
        };
      }

      return post;
    });

    const posts = debug ? rawPosts : rawPosts.filter(p => p.image_url || p.folder_url);

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
        _debug_mode:          true,
        _google_key:          process.env.GOOGLE_SERVICE_ACCOUNT_JSON
          ? 'service-account Ã¢ÂÂ'
          : (GOOGLE_KEY ? 'api-key Ã¢ÂÂ' : 'NÃÂO configurada (usando fallback HTML)'),
        _client_page_id_used: clientPageId || autoDetectedId || '(nenhum)',
        _hint: 'Use ?debug=TOKEN para diagnÃÂ³stico interno.',
      } : {}),
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', message: error.message });
  }
}
