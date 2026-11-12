export const config = {
  matcher: ['/iucbc/:path*', '/mercado-colon/:path*', '/api/mercado-colon'],
};

// Cada reporte tiene su propia contraseña (variable de entorno en Vercel).
const REPORTS = {
  iucbc: { envVar: 'DASH_PASS', realm: 'IUCBC Dashboard' },
  'mercado-colon': { envVar: 'MERCADO_COLON_PASS', realm: 'Mercado Colon Dashboard' },
};

export default function middleware(request) {
  // /api/<reporte> usa la misma contraseña que /<reporte>.
  const parts = new URL(request.url).pathname.split('/');
  const slug = parts[1] === 'api' ? parts[2] : parts[1];
  const report = REPORTS[slug];
  if (!report) return;

  const expected = process.env[report.envVar];
  const authHeader = request.headers.get('authorization');

  if (expected && authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const separatorIndex = decoded.indexOf(':');
      const pass = decoded.slice(separatorIndex + 1);
      if (pass === expected) {
        return;
      }
    }
  }

  return new Response('Autenticación requerida', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${report.realm}"` },
  });
}
