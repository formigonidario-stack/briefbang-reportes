export const config = {
  matcher: ['/iucbc/:path*', '/mercado-colon/:path*'],
};

// Cada reporte tiene su propia contraseña (variable de entorno en Vercel).
const REPORTS = {
  iucbc: { envVar: 'DASH_PASS', realm: 'IUCBC Dashboard' },
  'mercado-colon': { envVar: 'MERCADO_COLON_PASS', realm: 'Mercado Colon Dashboard' },
};

export default function middleware(request) {
  const slug = new URL(request.url).pathname.split('/')[1];
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
