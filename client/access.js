// Only bounded, same-origin routes may survive a login round trip.
export function safeReturnTo(value, fallback = '/workspace') {
  if (typeof value !== 'string' || value.length > 1000 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('//')) return fallback;
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !['/', '/workspace', '/join', '/admin/access-policy'].includes(url.pathname)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}
export function authUrl(returnTo = '/workspace') {
  return `/auth/github?${new URLSearchParams({ returnTo: safeReturnTo(returnTo) })}`;
}
export const publicReasons = {
  disabled: '公开概览暂未开放', unverified: '仓库公开性尚未核验', private: '仓库当前不可公开访问',
  expired: '公开性核验已过期，数据暂不可用', no_snapshot: '还没有可展示的公开快照', ready: '公开快照可用',
};
