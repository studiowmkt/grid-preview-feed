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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { id } = req.query;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!SA_JSON) {
    return res.redirect(302, `https://drive.google.com/thumbnail?id=${id}&sz=w640`);
  }

  const token = await getSAToken(SA_JSON);
  if (!token) {
    return res.redirect(302, `https://drive.google.com/thumbnail?id=${id}&sz=w640`);
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  try {
    // Try thumbnailLink from Drive API metadata
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?fields=thumbnailLink%2CmimeType`,
      { headers: authHeaders }
    );

    if (metaRes.ok) {
      const meta = await metaRes.json();

      if (meta.thumbnailLink) {
        const thumbUrl = meta.thumbnailLink.replace(/=s\d+/, '=s640');
        const thumbRes = await fetch(thumbUrl, { headers: authHeaders });
        if (thumbRes.ok) {
          const ct = thumbRes.headers.get('content-type') || 'image/jpeg';
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'public, max-age=3600');
          const buf = await thumbRes.arrayBuffer();
          return res.send(Buffer.from(buf));
        }
      }

      // Fallback: direct download for image files
      if (meta.mimeType && meta.mimeType.startsWith('image/')) {
        const imgRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
          { headers: authHeaders }
        );
        if (imgRes.ok) {
          res.setHeader('Content-Type', meta.mimeType);
          res.setHeader('Cache-Control', 'public, max-age=3600');
          const buf = await imgRes.arrayBuffer();
          return res.send(Buffer.from(buf));
        }
      }
    }
  } catch(e) {
    // fall through to redirect
  }

  return res.redirect(302, `https://drive.google.com/thumbnail?id=${id}&sz=w640`);
}
