export const config = {
  matcher: '/iucbc/:path*',
};

export default function middleware(request) {
  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const separatorIndex = decoded.indexOf(':');
      const pass = decoded.slice(separatorIndex + 1);
      if (pass === process.env.DASH_PASS) {
        return;
      }
    }
  }

  return new Response('Autenticación requerida', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="IUCBC Dashboard"' },
  });
}
