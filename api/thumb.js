function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function getSAToken(saJson) {
  let sa;
  try { sa = JSON.parse(saJson); } catch(e) { return null; }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const b64url = obj => btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const sigInput = b64url(header) + '.' + b64url(payload);

  const pemBody = sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const derBuf = Buffer.from(pemBody, 'base64');
  const keyData = bufToArrayBuffer(derBuf);

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8', keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
  } catch(e) { return null; }

  const enc = new TextEncoder();
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, enc.encode(sigInput));
  const sig = Buffer.from(sigBuf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = sigInput + '.' + sig;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!tokenRes.ok) return null;
  const tokenData = await tokenRes.json();
  return tokenData.access_token || null;
}

function placeholderSvg(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect width="640" height="640" fill="#1a1a1a"/>
  <text x="320" y="300" font-family="sans-serif" font-size="48" fill="#555" text-anchor="middle">${label}</text>
  <text x="320" y="360" font-family="sans-serif" font-size="28" fill="#444" text-anchor="middle">preview</text>
</svg>`;
  return Buffer.from(svg);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { id } = req.query;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!SA_JSON) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.send(placeholderSvg('no SA'));
  }

  const token = await getSAToken(SA_JSON);
  if (!token) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.send(placeholderSvg('auth error'));
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  try {
    // Step 1: get mimeType
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?fields=mimeType%2Cname`,
      { headers: authHeaders }
    );

    if (!metaRes.ok) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.send(placeholderSvg('not found'));
    }

    const meta = await metaRes.json();
    const mime = meta.mimeType || '';

    // Step 2: for images, download directly via alt=media
    if (mime.startsWith('image/')) {
      const imgRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
        { headers: authHeaders }
      );
      if (imgRes.ok) {
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const buf = await imgRes.arrayBuffer();
        return res.send(Buffer.from(buf));
      }
    }

    // Step 3: for video, try to get a thumbnail via thumbnailLink fetch with SA token
    if (mime.startsWith('video/')) {
      const thumbMetaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?fields=thumbnailLink`,
        { headers: authHeaders }
      );
      if (thumbMetaRes.ok) {
        const thumbMeta = await thumbMetaRes.json();
        if (thumbMeta.thumbnailLink) {
          const thumbUrl = thumbMeta.thumbnailLink.replace(/=[swh]\d+/, '=w640');
          const tRes = await fetch(thumbUrl, { headers: authHeaders });
          if (tRes.ok) {
            const ct = tRes.headers.get('content-type') || 'image/jpeg';
            res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            const buf = await tRes.arrayBuffer();
            return res.send(Buffer.from(buf));
          }
        }
      }
      // Video fallback placeholder
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(placeholderSvg('VIDEO'));
    }

  } catch(e) {
    // fall through to placeholder
  }

  // Generic placeholder for unknown types
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.send(placeholderSvg('preview'));
}
