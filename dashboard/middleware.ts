// middleware.ts — replaces HTTP Basic Auth with a cookie-based session.
//
// Why: iOS home-screen (standalone) web apps don't reliably keep Basic Auth
// credentials between launches, which is why you were being asked to sign
// in every time. A cookie set with a long Max-Age survives app relaunches
// properly, which Basic Auth's browser-level prompt does not.
//
// This REPLACES the entire previous middleware.ts. If anything below
// conflicts with logic you know was added later, paste me the current file
// and I'll merge it in rather than overwrite.

export const config = {
  matcher: '/((?!api/login|login.html).*)',
};

export default function middleware(request: Request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );

  const session = cookies['jarvis_session'];
  const secret = process.env.DASHBOARD_SESSION_SECRET;

  if (session && secret && session === secret) {
    return; // authenticated — let the request through
  }

  return Response.redirect(new URL('/login.html', request.url), 302);
}
