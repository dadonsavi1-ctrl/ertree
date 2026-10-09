const express = require('express');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Your proxy domain (Render gives you this)
const PROXY_DOMAIN = 'xk9m2p7q.onrender.com'; // ← CHANGE THIS

// Target domains
const MAIN = 'https://audiomack.com';
const API = 'https://api.audiomack.com';
const CDN = 'https://i.audiomack.com';

// All domain replacements
const REPLACEMENTS = [
  ['https://api.audiomack.com', `https://${PROXY_DOMAIN}/api`],
  ['https://i.audiomack.com', `https://${PROXY_DOMAIN}/cdn`],
  ['https://audiomack.com', `https://${PROXY_DOMAIN}`],
  ['http://api.audiomack.com', `https://${PROXY_DOMAIN}/api`],
  ['http://i.audiomack.com', `https://${PROXY_DOMAIN}/cdn`],
  ['http://audiomack.com', `https://${PROXY_DOMAIN}`],
  ['api.audiomack.com', `${PROXY_DOMAIN}/api`],
  ['i.audiomack.com', `${PROXY_DOMAIN}/cdn`],
  ['audiomack.com', PROXY_DOMAIN],
];

function rewriteBody(text) {
  for (const [from, to] of REPLACEMENTS) {
    text = text.split(from).join(to);
  }
  return text;
}

// Rewrite CloudFront audio URLs in JSON responses
function rewriteCloudFront(text) {
  // Audiomack audio URLs look like: https://d1xxxx.cloudfront.net/...
  // Replace with our /cf/ proxy path
  text = text.replace(
    /https?:\/\/[a-z0-9]+\.cloudfront\.net\//g,
    `https://${PROXY_DOMAIN}/cf/`
  );
  // Also handle if they're relative or use other CDN patterns
  text = text.replace(
    /https?:\/\/cdn[a-z0-9\-]*\.audiomack\.com\//g,
    `https://${PROXY_DOMAIN}/cdn/`
  );
  return text;
}

function shouldRewrite(contentType) {
  return contentType && (
    contentType.includes('html') ||
    contentType.includes('javascript') ||
    contentType.includes('json') ||
    contentType.includes('css') ||
    contentType.includes('text')
  );
}

// --- /cf/ route: proxy CloudFront audio streams ---
app.use('/cf', createProxyMiddleware({
  target: 'https://d1audiomack.cloudfront.net', // ← find the actual CloudFront dist from network tab
  changeOrigin: true,
  secure: true,
  pathRewrite: () => '',
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader('Host', 'd1audiomack.cloudfront.net');
  },
  onProxyRes: (proxyRes) => {
    delete proxyRes.headers['content-security-policy'];
    proxyRes.headers['access-control-allow-origin'] = '*';
  }
}));

// --- /api route: proxy api.audiomack.com ---
app.use('/api', createProxyMiddleware({
  target: API,
  changeOrigin: true,
  secure: true,
  pathRewrite: (path) => path.replace(/^\/api/, ''),
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader('Host', 'api.audiomack.com');
    proxyReq.setHeader('Origin', MAIN);
    proxyReq.setHeader('Referer', MAIN + '/');
  },
  onProxyRes: (proxyRes, req, res) => {
    // Strip CSP, rewrite CORS
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['content-security-policy-report-only'];
    proxyRes.headers['access-control-allow-origin'] = '*';
    proxyRes.headers['access-control-allow-credentials'] = 'true';
    proxyRes.headers['access-control-allow-headers'] = '*';

    // If JSON response, buffer and rewrite
    const ct = proxyRes.headers['content-type'] || '';
    if (ct.includes('json')) {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf-8');
        body = rewriteCloudFront(body);
        body = rewriteBody(body);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(body);
      });
    } else {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  }
}));

// --- /cdn route: proxy i.audiomack.com (artwork) ---
app.use('/cdn', createProxyMiddleware({
  target: CDN,
  changeOrigin: true,
  secure: true,
  pathRewrite: (path) => path.replace(/^\/cdn/, ''),
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader('Host', 'i.audiomack.com');
  },
  onProxyRes: (proxyRes) => {
    delete proxyRes.headers['content-security-policy'];
    proxyRes.headers['access-control-allow-origin'] = '*';
  }
}));

// --- Main site: proxy audiomack.com ---
app.use('/', createProxyMiddleware({
  target: MAIN,
  changeOrigin: true,
  secure: true,
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader('Host', 'audiomack.com');
    proxyReq.setHeader('Origin', MAIN);
    proxyReq.setHeader('Referer', MAIN + '/');
  },
  onProxyRes: (proxyRes, req, res) => {
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['content-security-policy-report-only'];
    delete proxyRes.headers['x-frame-options'];
    proxyRes.headers['access-control-allow-origin'] = '*';

    const ct = proxyRes.headers['content-type'] || '';
    if (shouldRewrite(ct)) {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf-8');
        body = rewriteBody(body);
        body = rewriteCloudFront(body);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(body);
      });
    } else {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  }
}));

http.createServer(app).listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});   
